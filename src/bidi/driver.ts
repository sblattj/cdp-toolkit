/**
 * BiDi implementation of the browser-neutral Driver contract in ../driver.ts (ADR-001), for
 * Firefox. lifetime is "session": a BiDi socket cannot be resumed, so createFirefoxDriver(port)
 * memoizes ONE BidiConnection per port at module scope (the connections map below), page()
 * retains a holder, release() decrements it, and only BrowserDriver.dispose() ever closes the
 * socket. There is deliberately no reconnect-and-resume path: if the socket dies, every pending
 * and future call on it rejects with "disconnected" rather than silently starting a fresh
 * session underneath a caller who still thinks they hold the old one. (driver.ts's LifetimeModel
 * doc says a "session" driver "MUST re-establish itself transparently if the transport dies";
 * this driver does not, on purpose, per the verified BiDi behavior in bidi/client.ts's own
 * header. See the final report for why that doc comment and this implementation disagree.)
 *
 * Uid codec (scheme "bidi"): `bidi:<stamp>`, per THE UID CODEC block in ../driver.ts. A stamp is
 * page state (an attribute written by ../bidi/snapshot.ts's in-page walker, or by this file's
 * STAMP_ONE_SOURCE for a single located element), never protocol state, so it survives a fresh
 * session and a fresh CLI process. It does NOT survive navigation or a page re-render, per
 * uidStability "document-stamp".
 *
 * take_snapshot has no BiDi equivalent domain, so ../bidi/snapshot.ts's takeStampedSnapshot walks
 * the DOM in-page and returns a pre-formatted indented text tree (the same line grammar
 * ../tools/snapshot.ts and formatSnapshotLine use). This file's job is the adapter: run that
 * function through script.callFunction and PARSE its text back into SnapshotNode[], which is
 * genuinely new integration work, not a reimplementation of the walker itself.
 */
import type { TargetSelector } from "../types.ts";
import {
  UID_STAMP_ATTR, isDriverError, interpolatePoints,
  type BrowserCookie, type BrowserDriver, type Capability, type DeleteCookiesFilter, type HandledDialogInfo, type DriverError, type DriverErrorCode, type DriverEvent,
  type DragDestination, type DragOptions,
  type SetCookieParams,
  type DriverUid, type ElementLocator, type EmulationOptions, type InterceptRule, type KeyPress, type LifetimeModel,
  type MouseButtonOptions, type NavigateOptions, type NavigateResult, type PageDriver, type PageInfo,
  type ScreenshotOptions, type ScrollOptions, type SnapshotNode, type UidStability,
} from "../driver.ts";
import { assertLeaseOk } from "../leases.ts";
import { BEACON_FUNCTION_DECLARATION, BEACON_READ_EXPRESSION, BEACON_SOURCE, recordDispatch } from "../activity.ts";
import { BidiConnection, BidiError, connectBidiSession } from "./client.ts";
import { takeStampedSnapshot } from "./snapshot.ts";
import { selectRule, buildFulfillParams, effectiveAction } from "../tools/network_mock.ts";
import type {
  BrowsingContextId, BrowsingContextInfo, BrowsingContextLocator, BrowsingContextReadinessState,
  BrowsingContextCaptureScreenshotParameters, ScriptSharedReference, ScriptRemoteValue, ScriptLocalValue,
  ScriptNodeRemoteValue, ScriptExceptionDetails, InputSourceActions, InputPointerSourceAction, InputKeySourceAction,
  InputWheelSourceAction, NetworkCookie,
} from "./protocol.ts";

/* ---------------------------------- cookies ---------------------------------- */
/**
 * BiDi's cookie shape to the neutral one. Three differences to absorb:
 *  - the value is a network.BytesValue, either a plain string or base64, so a
 *    base64 one is decoded rather than handed back as opaque base64;
 *  - `expiry` is optional and simply absent for a session cookie, which becomes
 *    the neutral -1 that CDP reports directly;
 *  - `session` has no BiDi field at all, so it is derived from that same
 *    absence, which is exactly what a session cookie means.
 * `sameSite` already uses the lowercase vocabulary the neutral shape adopted.
 */
export function normalizeBidiCookie(c: NetworkCookie): BrowserCookie {
  const value = c.value.type === "base64" ? Buffer.from(c.value.value, "base64").toString("utf8") : c.value.value;
  const hasExpiry = typeof c.expiry === "number";
  return {
    name: c.name, value, domain: c.domain, path: c.path,
    expires: hasExpiry ? (c.expiry as number) : -1,
    size: typeof c.size === "number" ? c.size : Buffer.byteLength(`${c.name}${value}`, "utf8"),
    httpOnly: c.httpOnly === true, secure: c.secure === true,
    sameSite: c.sameSite ?? "default", session: !hasExpiry,
  };
}

/**
 * The host of a url, for the BiDi cookie calls that require a `domain` and have
 * no `url` parameter of their own.
 *
 * Exported so a test can pin the failure cases without a browser. Every branch
 * that cannot produce a host THROWS: an absent url, an unparseable one, and a
 * parseable one with an empty host (about:blank, data:, javascript:) all raise
 * a message naming the tool and what it needs. The alternative, sending the
 * call without a domain, is a request Firefox answers cleanly while writing or
 * deleting nothing recognizable, which is the exact wrong-but-plausible ack
 * this driver refuses to emit.
 */
export function hostFromUrl(url: string | undefined, toolName: string): string {
  if (url === undefined || url === "") {
    throw driverError("unsupported", `${toolName} on Firefox needs a 'domain': BiDi's storage cookie calls have no 'url' parameter, and no url was given to derive one from.`);
  }
  let host = "";
  try {
    host = new URL(url).hostname;
  } catch {
    throw driverError("unsupported", `${toolName} could not parse the url '${url}' to derive the 'domain' BiDi requires. Pass 'domain' explicitly.`);
  }
  if (host === "") {
    throw driverError("unsupported", `${toolName} cannot derive a 'domain' from '${url}': that url has no host. Pass 'domain' explicitly.`);
  }
  return host;
}

/* ------------------------------ error + uid codec ------------------------------ */
function driverError(code: DriverErrorCode, message: string, data?: unknown): DriverError {
  return Object.assign(new Error(message), { code, ...(data !== undefined ? { data } : {}) }) as DriverError;
}
function encodeUid(stamp: string): DriverUid {
  return `bidi:${stamp}`;
}
function decodeStamp(uid: DriverUid): string {
  if (!uid.startsWith("bidi:")) throw driverError("foreign-uid", `uid is not owned by the bidi driver: ${uid}`);
  const payload = uid.slice(5);
  if (!payload.length) throw driverError("foreign-uid", `malformed bidi uid payload: ${uid}`);
  return payload;
}
function cssEscape(s: string): string {
  return s.replace(/["\\]/g, (c) => `\\${c}`);
}
/** Maps a thrown BidiError (or anything else) onto the neutral DriverErrorCode vocabulary. */
function mapBidiError(e: unknown): DriverError {
  if (e instanceof BidiError) {
    const code = e.code;
    if (code === "no such node" || code === "no such element") return driverError("no-such-element", e.message);
    if (code === "no such frame") return driverError("no-such-target", e.message);
    if (code === "invalid session id") return driverError("disconnected", e.message);
    if (code === "unsupported operation") return driverError("unsupported", e.message);
    if (!code && /timed out/i.test(e.message)) return driverError("timeout", e.message);
    if (!code && /(disposed|not open|connection closed)/i.test(e.message)) return driverError("disconnected", e.message);
    return driverError("page-error", e.message);
  }
  return driverError("page-error", e instanceof Error ? e.message : String(e));
}

/* ---------------------------- script value (de)serialization ---------------------------- */
function serializeArg(v: unknown): ScriptLocalValue {
  if (v === undefined) return { type: "undefined" };
  if (v === null) return { type: "null" };
  if (typeof v === "string") return { type: "string", value: v };
  if (typeof v === "number") return { type: "number", value: Number.isNaN(v) ? "NaN" : v };
  if (typeof v === "boolean") return { type: "boolean", value: v };
  if (Array.isArray(v)) return { type: "array", value: v.map(serializeArg) };
  if (typeof v === "object") return { type: "object", value: Object.entries(v as Record<string, unknown>).map(([k, val]) => [k, serializeArg(val)]) };
  return { type: "string", value: String(v) };
}
/** Inverse of serializeArg for the subset of ScriptRemoteValue shapes our tools actually produce. */
function deserializeRemote(rv: ScriptRemoteValue): unknown {
  switch (rv.type) {
    case "undefined": return undefined;
    case "null": return null;
    case "string": return rv.value;
    case "boolean": return rv.value;
    case "bigint": return rv.value;
    case "number": return typeof rv.value === "number" ? rv.value : rv.value;
    case "array": return (rv.value ?? []).map(deserializeRemote);
    case "object": {
      const out: Record<string, unknown> = {};
      for (const [k, v] of rv.value ?? []) out[typeof k === "string" ? k : String(deserializeRemote(k))] = deserializeRemote(v);
      return out;
    }
    case "node": return { bidiSharedId: rv.sharedId };
    default: return undefined;
  }
}
function exceptionMessage(d: ScriptExceptionDetails): string {
  if (d.text) return d.text;
  const ex = deserializeRemote(d.exception);
  return typeof ex === "string" ? ex : "evaluation threw";
}

/* -------------------------------- snapshot line parsing -------------------------------- */
// Mirrors formatSnapshotLine's grammar in ./snapshot.ts: `<indent>[<uid>] <role>[ "<name>"][ [<extras>]]`.
const LINE_RE = /^((?: {2})*)\[([0-9a-f]+)\] ([a-zA-Z_][\w-]*)(?: ("(?:[^"\\]|\\.)*"))?(?: \[(.*)\])?$/;
function splitExtras(s: string): string[] {
  const out: string[] = [];
  let cur = "";
  let inQuotes = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]!;
    if (ch === '"' && s[i - 1] !== "\\") inQuotes = !inQuotes;
    if (ch === " " && !inQuotes) { if (cur) out.push(cur); cur = ""; } else cur += ch;
  }
  if (cur) out.push(cur);
  return out;
}
function parseSnapshotLine(line: string): SnapshotNode | undefined {
  const m = LINE_RE.exec(line);
  if (!m) return undefined;
  const indent = m[1] ?? "", stamp = m[2]!, role = m[3]!, nameLit = m[4], extrasRaw = m[5];
  const depth = indent.length / 2;
  let name: string | undefined;
  if (nameLit) {
    try { name = JSON.parse(nameLit) as string; } catch { name = nameLit; }
  }
  const extras: Record<string, string> = {};
  if (extrasRaw) {
    for (const tok of splitExtras(extrasRaw)) {
      const eq = tok.indexOf("=");
      if (eq === -1) { extras[tok] = "true"; continue; }
      const key = tok.slice(0, eq);
      let val = tok.slice(eq + 1);
      if (val.startsWith('"')) { try { val = JSON.parse(val) as string; } catch { /* keep raw */ } }
      extras[key] = val;
    }
  }
  return { uid: encodeUid(stamp), role, depth, ...(name !== undefined ? { name } : {}), ...(Object.keys(extras).length ? { extras } : {}) };
}
const INTERACTIVE_ROLES = new Set<string>([
  "button", "link", "textbox", "searchbox", "checkbox", "radio", "combobox",
  "listbox", "option", "slider", "spinbutton", "progressbar", "meter",
]);
// Stamps ONE already-located element (locate()'s mint path), reusing an existing stamp per the
// same rule ../bidi/snapshot.ts's nextStamp()/stampOf() apply during a full-tree walk. Payload is
// two padded random hex blocks (8+4), matching THE UID CODEC's documented exactly-12-lowercase-
// hex-char bidi payload grammar exactly and the same padding technique nextStamp() now uses.
const STAMP_ONE_SOURCE = `function(){var a=${JSON.stringify(UID_STAMP_ATTR)};var e=this.getAttribute(a);if(e)return e;var s=Math.floor(Math.random()*0x100000000).toString(16).padStart(8,"0")+Math.floor(Math.random()*0x10000).toString(16).padStart(4,"0");this.setAttribute(a,s);return s;}`;

/* ------------------------------- element locator resolution ------------------------------- */
async function locateNodes(conn: BidiConnection, contextId: BrowsingContextId, locator: BrowsingContextLocator): Promise<ScriptNodeRemoteValue[]> {
  try {
    const { nodes } = await conn.send("browsingContext.locateNodes", { context: contextId, locator, maxNodeCount: 1 });
    return nodes;
  } catch (e) {
    throw mapBidiError(e);
  }
}
function sharedRefOf(node: ScriptNodeRemoteValue, describe: string): ScriptSharedReference {
  if (!node.sharedId) throw driverError("page-error", `located node has no sharedId (${describe})`);
  return { sharedId: node.sharedId };
}
/** THE UID CODEC: "More than one match MUST take the first node in document order", which is
 *  what locateNodes returns nodes in; we always ask for maxNodeCount 1 so there is only one to take. */
async function resolveElementLocator(conn: BidiConnection, contextId: BrowsingContextId, loc: ElementLocator): Promise<ScriptSharedReference> {
  if ("uid" in loc) {
    const stamp = decodeStamp(loc.uid);
    const nodes = await locateNodes(conn, contextId, { type: "css", value: `[${UID_STAMP_ATTR}="${cssEscape(stamp)}"]` });
    if (!nodes.length) throw driverError("stale-uid", `uid does not resolve: ${loc.uid}`);
    return sharedRefOf(nodes[0]!, loc.uid);
  }
  if ("css" in loc) {
    const nodes = await locateNodes(conn, contextId, { type: "css", value: loc.css });
    if (!nodes.length) throw driverError("no-such-element", `css '${loc.css}' matched no element`);
    return sharedRefOf(nodes[0]!, `css '${loc.css}'`);
  }
  if ("xpath" in loc) {
    const nodes = await locateNodes(conn, contextId, { type: "xpath", value: loc.xpath });
    if (!nodes.length) throw driverError("no-such-element", `xpath '${loc.xpath}' matched no element`);
    return sharedRefOf(nodes[0]!, `xpath '${loc.xpath}'`);
  }
  const nodes = await locateNodes(conn, contextId, { type: "innerText", value: loc.text, matchType: "partial" });
  if (!nodes.length) throw driverError("no-such-element", `text '${loc.text}' matched no element`);
  return sharedRefOf(nodes[0]!, `text '${loc.text}'`);
}

/* ---------------------------------- keys ---------------------------------- */
// WebDriver normalized key values (Unicode PUA), the BiDi-side counterpart of CDP's NAMED_KEYS.
const KEY_VALUES: Record<string, string> = {
  enter: "\uE007", return: "\uE007", tab: "\uE004", escape: "\uE00C", esc: "\uE00C",
  backspace: "\uE003", delete: "\uE017", space: " ",
  arrowup: "\uE013", arrowdown: "\uE015", arrowleft: "\uE012", arrowright: "\uE014",
  up: "\uE013", down: "\uE015", left: "\uE012", right: "\uE014",
  home: "\uE011", end: "\uE010", pageup: "\uE00E", pagedown: "\uE00F",
};
const MODIFIER_VALUES: Record<string, string> = { shift: "\uE008", control: "\uE009", ctrl: "\uE009", alt: "\uE00A", meta: "\uE03D", cmd: "\uE03D", command: "\uE03D" };
const BUTTON_CODES: Record<"left" | "right" | "middle", number> = { left: 0, middle: 1, right: 2 };

/** Same scroll-settle technique as cdp/driver.ts's ARM_SCROLL_SETTLE_WATCH / awaitScrollSettle,
 *  see that file's doc comment for the full rationale: a capture-phase 'scroll' listener on
 *  window, debounced 60ms with a 500ms cap, so scroll()'s caller observes the settled position. */
const ARM_SCROLL_SETTLE_WATCH_SOURCE =
  "function(){window.__cdpScrollSettle=new Promise((resolve)=>{let t;const done=()=>{window.removeEventListener('scroll',on,true);resolve(true);};" +
  "const on=()=>{clearTimeout(t);t=setTimeout(done,60);};window.addEventListener('scroll',on,true);t=setTimeout(done,60);setTimeout(done,500);});}";
const AWAIT_SCROLL_SETTLE_SOURCE = "function(){return window.__cdpScrollSettle;}";

/**
 * Firefox 153 capabilities. Only what was empirically verified is declared: emulate.deviceMetrics
 * (browsingContext.setViewport) and the userAgent path (universal, no capability token) both work.
 * emulate.mediaFeatures, emulate.cpuThrottling, emulate.networkConditions, trace.performance,
 * heap.snapshot, audit.lighthouse, input.insertTextAtomic and snapshot.accessibilityTree are all
 * deliberately absent, several because Firefox 153 does not implement the underlying BiDi command
 * at all (see protocol.ts's "Firefox 153: not implemented" tags), the rest because this driver has
 * no accessibility-tree source or CPU-multiplier primitive to offer. locate.xpath rides
 * browsingContext.locateNodes({type:"xpath"}), verified working. locate.text is NOT declared:
 * locateNodes({type:"innerText"}) throws "locator.type argument with value: innerText is not
 * supported yet" on real Firefox 153.0.3, contradicting the initial assumption that both text and
 * xpath locators were live; ElementLocator's `text` branch still resolves and correctly surfaces
 * "unsupported" rather than silently misbehaving, it is simply not offered as a capability.
 * capture.screencast is absent because WebDriver BiDi has no streamed-frame primitive at all:
 * the spec offers only the one-shot browsingContext.captureScreenshot, with no screencast
 * start/stop command and no per-repaint frame event to subscribe to, so the screen-recording
 * pair is honestly missing under Firefox rather than present and throwing.
 * network.intercept rides network.addIntercept + network.beforeRequestSent, verified working
 * (see intercept()'s comment on why urlPatterns is never populated). screenshot.fullPage uses
 * captureScreenshot's origin:"document", screenshot.element uses its clip:{type:"element"}, both verified.
 */
const BIDI_CAPABILITIES: ReadonlySet<Capability> = new Set<Capability>([
  "emulate.deviceMetrics", "screenshot.fullPage", "screenshot.element", "network.intercept", "locate.xpath",
]);

/* --------------------------------- module-scope session memoization --------------------------------- */
// "session" LifetimeModel: ONE BidiConnection per port, shared by every page() acquisition on that
// port. getConnection retains a holder on every call (fresh or reused); callers release() it.
const connections = new Map<number, BidiConnection>();
async function getConnection(port: number, timeoutMs?: number): Promise<BidiConnection> {
  const existing = connections.get(port);
  if (existing) { existing.retain(); return existing; }
  // Firefox 153's default unhandledPromptBehavior is "dismiss": a page-blocking alert()/confirm()
  // gets auto-dismissed before handleDialog() ever runs, and Firefox's own userPromptOpened event
  // reports handler:"dismiss" on it (verified: a bare session.new left "no such alert" on the very
  // next handleUserPrompt call). Setting "ignore" here is what makes handleDialog() able to see
  // and answer a live prompt at all.
  const conn = await connectBidiSession(port, {
    ...(timeoutMs !== undefined ? { timeoutMs } : {}),
    capabilities: { alwaysMatch: { unhandledPromptBehavior: { default: "ignore" } } },
  }); // already retained once
  connections.set(port, conn);
  return conn;
}

/**
 * Contexts that already carry a beacon preload script, keyed port:context ->
 * the script id BiDi handed back.
 *
 * WHY FIREFOX NEEDS NO HELD CONNECTION where Chrome does. This driver's
 * LifetimeModel is "session": ONE BidiConnection is memoized per port above and
 * lives until dispose(), so a preload script registered on it stays registered
 * across navigations for free. Chrome's equivalent registration is cleared when
 * the registering client disconnects, and this toolkit's CDP lifetime is
 * "per-call", which is why cdp/driver.ts has to hold a socket per beaconed tab
 * and this file does not. The map exists only to avoid stacking a second
 * registration on a context that already has one; the in-page script is
 * idempotent, so a duplicate would be harmless but pointless.
 */
const bidiBeaconScripts = new Map<string, string>();

/* ----------------------------------- context/page lookup ----------------------------------- */
async function safeTitle(conn: BidiConnection, contextId: BrowsingContextId): Promise<string> {
  try {
    const res = await conn.send("script.evaluate", { expression: "document.title", target: { context: contextId }, awaitPromise: false });
    return res.type === "success" && res.result.type === "string" ? res.result.value : "";
  } catch {
    return "";
  }
}
async function pageInfoOf(conn: BidiConnection, ctx: BrowsingContextInfo): Promise<PageInfo> {
  return { id: ctx.context, url: ctx.url, title: await safeTitle(conn, ctx.context) };
}
/** Same TargetSelector grammar as client.ts's resolveTarget, but resolved entirely over BiDi
 *  (browsingContext.getTree): there is no HTTP discovery endpoint here, per client.ts's own footer.
 *
 *  THE Firefox choke point for tab leases. Keyed "firefox", never a bare id: a CDP targetId and a
 *  BiDi context id are not disjoint by construction, so one bare key space could produce a false
 *  collision between an unrelated Chrome tab and a Firefox context. Note this backend needs the
 *  lease far less than Chrome does (backend.ts: every MCP server process launches its OWN Firefox,
 *  so two sessions cannot race over one instance the way they do over Chrome on port 9222). It is
 *  here for consistency and for a future shared-instance setup, not to close an observed gap. */
async function resolveContext(
  conn: BidiConnection,
  selector: TargetSelector,
  opts: { lease?: string } = {},
): Promise<BrowsingContextInfo> {
  const { contexts } = await conn.send("browsingContext.getTree", {}).catch((e) => { throw mapBidiError(e); });
  if (!contexts.length) throw driverError("no-such-target", "no browsing contexts available");
  const hit = await pickContext(conn, contexts, selector);
  // liveIds deliberately not passed: hit is by construction a member of contexts, so target-gone
  // could never fire for the context just resolved (see leases.ts's assertLeaseOk callers).
  await assertLeaseOk("firefox", hit.context, { lease: opts.lease, url: hit.url });
  return hit;
}

async function pickContext(
  conn: BidiConnection,
  contexts: BrowsingContextInfo[],
  selector: TargetSelector,
): Promise<BrowsingContextInfo> {
  if (selector === undefined || selector === "active") return contexts[0]!;
  if (selector.startsWith("index:")) {
    const t = contexts[Number(selector.slice(6))];
    if (!t) throw driverError("no-such-target", `no context at ${selector}`);
    return t;
  }
  if (selector.startsWith("url:")) {
    const needle = selector.slice(4);
    const t = contexts.find((c) => c.url.includes(needle));
    if (!t) throw driverError("no-such-target", `no context with url containing '${needle}'`);
    return t;
  }
  if (selector.startsWith("title:")) {
    const needle = selector.slice(6);
    for (const c of contexts) if ((await safeTitle(conn, c.context)).includes(needle)) return c;
    throw driverError("no-such-target", `no context with title containing '${needle}'`);
  }
  const exact = contexts.find((c) => c.context === selector);
  if (exact) return exact;
  throw driverError("no-such-target", `no context matching '${selector}'`);
}

/* ---------------------------------- PageDriver ---------------------------------- */
class BidiPageDriver implements PageDriver {
  private released = false;
  private bodyCollector?: string;
  constructor(private readonly conn: BidiConnection, private readonly contextId: BrowsingContextId, readonly info: PageInfo, readonly browser: BrowserDriver) {}

  /** `location.href` and `document.readyState` in one round trip, NUL-joined so the result comes
   *  back as one plain string (deserializeRemote's simplest shape). Empty strings on any failure —
   *  a transient evaluate error during a navigation is normal and must not abort a poll. */
  private async urlAndReadyState(): Promise<[string, string]> {
    const raw = await this.conn.send("script.evaluate", {
      expression: "location.href + '\\u0000' + document.readyState",
      target: { context: this.contextId }, awaitPromise: false,
    }).then((r) => (r.type === "success" ? String(deserializeRemote(r.result) ?? "") : "")).catch(() => "");
    const [url = "", ready = ""] = raw.split("\u0000");
    return [url, ready];
  }

  /**
   * Bounded readiness wait after a history traversal.
   *
   * WHY THIS EXISTS AT ALL. browsingContext.navigate and .reload both take a `wait` readiness state
   * and block server-side until it is reached, which is why the two branches below simply return
   * `waitedFor: waitUntil`. browsingContext.traverseHistory takes NO `wait` parameter and returns
   * as soon as the traversal is dispatched, so this driver owns the wait for that one path — the
   * same position cdp/driver.ts is in for every navigation.
   *
   * Polling rather than a `browsingContext.load` subscription, matching waitForText's in-file
   * pattern: a bfcache restore does not necessarily re-fire a load event, so an event wait could
   * hang on a perfectly successful traversal while a poll observes the settled document directly.
   *
   * KNOWN LIMIT, stated rather than hidden: "we moved" is inferred from the url changing. A
   * traversal between two history entries with the IDENTICAL url therefore cannot be confirmed and
   * burns the whole budget before returning "timeout" — with the correct url, and after the
   * traversal really did happen. That is the honest reading of the only signal available here.
   */
  private async settleAfterTraversal(beforeUrl: string, waitUntil: "load" | "domcontentloaded", timeoutMs: number): Promise<{ waitedFor: NavigateResult["waitedFor"]; url: string }> {
    const ready = waitUntil === "domcontentloaded" ? ["interactive", "complete"] : ["complete"];
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const [url, state] = await this.urlAndReadyState();
      if (url && url !== beforeUrl && ready.includes(state)) return { waitedFor: waitUntil, url };
      if (Date.now() >= deadline) return { waitedFor: "timeout", url: url || beforeUrl };
      await new Promise((r) => setTimeout(r, 50));
    }
  }

  async navigate(opts: NavigateOptions): Promise<NavigateResult> {
    const reload = opts.reload === true;
    const history = opts.history;
    if (!reload && !history && !opts.url) throw driverError("page-error", "navigate: 'url' is required unless reload:true");
    const waitUntil = opts.waitUntil ?? "load";
    const wait: BrowsingContextReadinessState = waitUntil === "domcontentloaded" ? "interactive" : "complete";
    const sendOpts = opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {};
    try {
      if (reload) {
        const r = await this.conn.send("browsingContext.reload", { context: this.contextId, ignoreCache: opts.ignoreCache === true, wait }, sendOpts);
        return { url: r.url, contextId: this.contextId, reloaded: true, waitedFor: waitUntil };
      }
      if (history) {
        const [beforeUrl] = await this.urlAndReadyState();
        // NavigateOptions.history forbids a silent no-op. Firefox answers a traversal past either
        // end of the session history with a "no such history entry" error, which mapBidiError would
        // relay verbatim — a message that never names the direction the caller asked for. Rewrapped
        // here so back-at-the-start and forward-at-the-end read the same on both backends.
        await this.conn.send("browsingContext.traverseHistory", { context: this.contextId, delta: history === "back" ? -1 : 1 }, sendOpts)
          .catch((e) => {
            const msg = e instanceof Error ? e.message : String(e);
            if (/no such history entry|history/i.test(msg)) throw driverError("page-error", `navigate: no history entry to go ${history} to (${msg})`);
            throw e;
          });
        const settled = await this.settleAfterTraversal(beforeUrl, waitUntil, opts.timeoutMs ?? 15_000);
        return { url: settled.url, contextId: this.contextId, traversed: history, waitedFor: settled.waitedFor };
      }
      const r = await this.conn.send("browsingContext.navigate", { context: this.contextId, url: opts.url as string, wait }, sendOpts);
      return { url: r.url, contextId: this.contextId, waitedFor: waitUntil };
    } catch (e) {
      // NavigateResult.waitedFor's "committed"/"timeout" values assume CDP's fire-and-forget
      // navigate plus separate milestone events (see cdp/driver.ts's own comment on this). BiDi's
      // navigate blocks server-side until `wait` is satisfied, so under this driver there is no
      // soft "timeout" return: an unreachable milestone surfaces as a thrown timeout error instead.
      throw mapBidiError(e);
    }
  }
  async waitForText(text: string, timeoutMs = 15_000, pollMs = 250): Promise<{ found: true; elapsedMs: number }> {
    const start = Date.now();
    const expr = `(() => { const b = document.body; return !!b && typeof b.innerText === 'string' && b.innerText.includes(${JSON.stringify(text)}); })()`;
    for (;;) {
      const found = await this.conn.send("script.evaluate", { expression: expr, target: { context: this.contextId }, awaitPromise: true })
        .then((r) => r.type === "success" && deserializeRemote(r.result) === true)
        .catch(() => false);
      if (found) return { found: true, elapsedMs: Date.now() - start };
      if (Date.now() - start >= timeoutMs) throw driverError("timeout", `waitForText: '${text}' not found within ${timeoutMs}ms`);
      await new Promise((r) => setTimeout(r, Math.min(pollMs, Math.max(0, timeoutMs - (Date.now() - start)))));
    }
  }

  private async callFunctionValue(functionDeclaration: string, args: unknown[], thisRef?: ScriptSharedReference): Promise<unknown> {
    try {
      const res = await this.conn.send("script.callFunction", {
        functionDeclaration, awaitPromise: true, target: { context: this.contextId },
        arguments: args.map(serializeArg), ...(thisRef ? { this: thisRef as ScriptLocalValue } : {}),
      });
      if (res.type === "exception") throw driverError("page-error", exceptionMessage(res.exceptionDetails));
      return deserializeRemote(res.result);
    } catch (e) {
      throw isDriverError(e) ? e : mapBidiError(e);
    }
  }
  async evaluate(expression: string, opts?: { args?: readonly unknown[]; awaitPromise?: boolean }): Promise<unknown> {
    const awaitPromise = opts?.awaitPromise ?? true;
    if (opts?.args && opts.args.length > 0) return this.callFunctionValue(expression, [...opts.args]);
    try {
      const res = await this.conn.send("script.evaluate", { expression, awaitPromise, target: { context: this.contextId } });
      if (res.type === "exception") throw driverError("page-error", exceptionMessage(res.exceptionDetails));
      return deserializeRemote(res.result);
    } catch (e) {
      throw isDriverError(e) ? e : mapBidiError(e);
    }
  }
  async callOnElement(loc: ElementLocator, functionDeclaration: string, args: readonly unknown[] = []): Promise<unknown> {
    const ref = await resolveElementLocator(this.conn, this.contextId, loc);
    return this.callFunctionValue(functionDeclaration, [...args], ref);
  }

  async snapshot(opts?: { interactiveOnly?: boolean }): Promise<SnapshotNode[]> {
    const { snapshot } = await takeStampedSnapshot((src) => this.callFunctionValue(src, []));
    const nodes: SnapshotNode[] = [];
    for (const line of snapshot.split("\n")) {
      if (!line) continue;
      const n = parseSnapshotLine(line);
      if (n) nodes.push(n);
    }
    return opts?.interactiveOnly ? nodes.filter((n) => INTERACTIVE_ROLES.has(n.role)) : nodes;
  }
  async locate(loc: ElementLocator): Promise<DriverUid> {
    if ("uid" in loc) { await this.resolve(loc.uid); return loc.uid; }
    const ref = await resolveElementLocator(this.conn, this.contextId, loc);
    const stamp = await this.callFunctionValue(STAMP_ONE_SOURCE, [], ref);
    if (typeof stamp !== "string") throw driverError("page-error", "stamping the located element did not return a string");
    return encodeUid(stamp);
  }
  async resolve(uid: DriverUid): Promise<void> {
    const stamp = decodeStamp(uid);
    const nodes = await locateNodes(this.conn, this.contextId, { type: "css", value: `[${UID_STAMP_ATTR}="${cssEscape(stamp)}"]` });
    if (!nodes.length) throw driverError("stale-uid", `uid does not resolve: ${uid}`);
  }

  /**
   * THE INPUT DISPATCH CHOKE POINT for Firefox, and the direct counterpart of
   * cdp/driver.ts's dispatchInput. Every synthesized input this driver produces
   * is already funnelled through this one method (hover, click, drag, setValue,
   * typeText, pressKey all build actions and call it), so the dispatch-log write
   * that keeps the toolkit's own input from reading as a human's needs exactly
   * one line, here. See ../activity.ts.
   *
   * NOT routed through here: input.setFiles (upload_file). Same reasoning as the
   * CDP side — it fires none of the beacon's events, so logging it could only
   * suppress a real human input, never prevent a false one.
   */
  private async performActions(actions: InputSourceActions[]): Promise<void> {
    recordDispatch("firefox", this.contextId);
    try {
      await this.conn.send("input.performActions", { context: this.contextId, actions });
    } catch (e) {
      throw mapBidiError(e);
    }
  }
  // Scroll into view + read the viewport-space center, mirroring cdp/driver.ts's centerOf.
  private async centerOf(ref: ScriptSharedReference): Promise<{ x: number; y: number }> {
    const fn = "function(){this.scrollIntoView({block:'center',inline:'center'});const r=this.getBoundingClientRect();if(r.width===0&&r.height===0)return null;return {x:r.left+r.width/2,y:r.top+r.height/2};}";
    const val = await this.callFunctionValue(fn, [], ref);
    if (!val || typeof val !== "object") throw driverError("page-error", "element has zero size / is not visible; cannot compute a click point");
    return val as { x: number; y: number };
  }
  async hover(loc: ElementLocator): Promise<{ x: number; y: number }> {
    const ref = await resolveElementLocator(this.conn, this.contextId, loc);
    const { x, y } = await this.centerOf(ref);
    await this.performActions([{ type: "pointer", id: "cdp-mouse", actions: [{ type: "pointerMove", x, y, duration: 0 }] }]);
    return { x, y };
  }
  // modifiers is new in 1.8.0 (Track P1). Chrome expresses it as a bitmask on the same
  // mousePressed/mouseReleased events (cdp/driver.ts's inputModifierBits); WebDriver BiDi has no
  // equivalent field on a pointerDown/pointerUp action; a modifier chord instead requires a SECOND
  // "key" input source ticked in lockstep with the pointer source across the same performActions
  // call, which the spec explicitly permits skipping ("throw a clear error when modifiers are
  // passed on firefox" — see cdp-toolkit's 1.8.0 spec, Track P1 §3) and this driver was not
  // verified against real Firefox for this pass, so it throws "unsupported" rather than guess at
  // untested tick-synchronization semantics.
  async click(loc: ElementLocator, opts?: MouseButtonOptions): Promise<{ x: number; y: number }> {
    if (opts?.modifiers && opts.modifiers.length > 0) {
      throw driverError("unsupported", "click: 'modifiers' is not supported by the Firefox/BiDi driver; omit 'modifiers' or use --browser chrome for a modifier click.");
    }
    const ref = await resolveElementLocator(this.conn, this.contextId, loc);
    const { x, y } = await this.centerOf(ref);
    const button = BUTTON_CODES[opts?.button ?? "left"];
    const actions: InputPointerSourceAction[] = [{ type: "pointerMove", x, y, duration: 0 }];
    for (let i = 0; i < (opts?.clickCount ?? 1); i++) actions.push({ type: "pointerDown", button }, { type: "pointerUp", button });
    await this.performActions([{ type: "pointer", id: "cdp-mouse", actions }]);
    return { x, y };
  }
  // 1.8.0 Track P1: BiDi's "wheel" input source (a distinct source type from "pointer"/"key")
  // carries x/y/deltaX/deltaY directly on its one "scroll" action — no tick synchronization with
  // another source needed, unlike click's modifiers above, which is what makes this tractable.
  // Same settle-wait rationale as cdp/driver.ts's armScrollSettleWatch: a wheel-triggered scroll
  // is a browser-animated effect, not a synchronous DOM mutation, so a caller reading scroll
  // position immediately after performActions resolves risks the pre-scroll value. Not empirically
  // verified against real Firefox this pass (no Firefox available in this environment), but applied
  // for consistency with the verified Chrome behavior rather than left as a known, unfixed gap.
  async scroll(anchor: ElementLocator | { x: number; y: number } | undefined, opts: ScrollOptions): Promise<{ x: number; y: number }> {
    const { x, y } = await this.resolveScrollPoint(anchor);
    const deltaX = Math.round(opts.deltaX ?? 0);
    const deltaY = Math.round(opts.deltaY ?? 0);
    await this.callFunctionValue(ARM_SCROLL_SETTLE_WATCH_SOURCE, []);
    const actions: InputWheelSourceAction[] = [{ type: "scroll", x: Math.round(x), y: Math.round(y), deltaX, deltaY }];
    await this.performActions([{ type: "wheel", id: "cdp-wheel", actions }]);
    await this.callFunctionValue(AWAIT_SCROLL_SETTLE_SOURCE, []).catch(() => undefined);
    return { x, y };
  }
  private async resolveScrollPoint(anchor: ElementLocator | { x: number; y: number } | undefined): Promise<{ x: number; y: number }> {
    if (anchor === undefined) {
      const v = await this.callFunctionValue("function(){return {x: window.innerWidth / 2, y: window.innerHeight / 2};}", []);
      if (!v || typeof v !== "object") throw driverError("page-error", "could not measure viewport for scroll center");
      return v as { x: number; y: number };
    }
    if ("x" in anchor) return anchor;
    return this.centerOf(await resolveElementLocator(this.conn, this.contextId, anchor));
  }
  // 1.8.0 Track P2. mode:"html5" is REFUSED here, never silently downgraded to mouse mode: WebDriver
  // BiDi has no drag-interception primitive at all (no setInterceptDrags equivalent, no drag event
  // to subscribe to, no dispatchDragEvent), so there is nothing to port. The param-level refusal
  // mirrors click's modifiers-on-Firefox above — `drag` itself stays in tools/list because mouse
  // mode is fully supported here. `to` accepting a point or an offset, and `steps`, are both
  // backend-neutral and DO work on this driver.
  async drag(from: ElementLocator, to: DragDestination, opts?: DragOptions): Promise<{ from: { x: number; y: number }; to: { x: number; y: number } }> {
    if (opts?.mode === "html5") {
      throw driverError(
        "unsupported",
        "drag: mode:'html5' is not supported by the Firefox/BiDi driver (WebDriver BiDi has no drag-interception primitive); " +
          "omit 'mode' for the synthetic-mouse drag, or use --browser chrome for real HTML5 drag events.",
      );
    }
    const fromPt = await this.centerOf(await resolveElementLocator(this.conn, this.contextId, from));
    const toPt = await this.resolveDragDestination(to, fromPt);
    const steps = Math.max(1, Math.trunc(opts?.steps ?? 2));
    const actions: InputPointerSourceAction[] = [
      { type: "pointerMove", x: fromPt.x, y: fromPt.y, duration: 0 }, { type: "pointerDown", button: 0 },
    ];
    for (const pt of interpolatePoints(fromPt, toPt, steps)) actions.push({ type: "pointerMove", x: pt.x, y: pt.y, duration: 50 });
    actions.push({ type: "pointerUp", button: 0 });
    await this.performActions([{ type: "pointer", id: "cdp-mouse", actions }]);
    return { from: fromPt, to: toPt };
  }
  private async resolveDragDestination(to: DragDestination, fromPt: { x: number; y: number }): Promise<{ x: number; y: number }> {
    if ("dx" in to) return { x: fromPt.x + to.dx, y: fromPt.y + to.dy };
    if ("x" in to) return to;
    return this.centerOf(await resolveElementLocator(this.conn, this.contextId, to));
  }
  // No atomic value-commit primitive over BiDi (established fact): every key goes through
  // input.performActions, batched into ONE call regardless of string length, so setValue/typeText
  // cost exactly 2 round trips (one evaluate to focus/clear, one performActions for the keys).
  private async sendKeys(text: string): Promise<void> {
    if (!text.length) return;
    const actions: InputKeySourceAction[] = [];
    for (const ch of text) actions.push({ type: "keyDown", value: ch }, { type: "keyUp", value: ch });
    await this.performActions([{ type: "key", id: "cdp-keyboard", actions }]);
  }
  // <select> is not text input: "synthesized keystrokes" (typeahead-by-first-letter) cannot
  // reliably commit an exact option, so a SELECT element gets a direct value/selectedIndex
  // assignment plus input+change events, the same effective outcome a real option click has.
  // Every other element still goes through focus+clear+sendKeys, honestly synthesized keystrokes.
  private static readonly SELECT_SOURCE = "function(v){var found=false;for(var i=0;i<this.options.length;i++){if(this.options[i].value===v){this.selectedIndex=i;found=true;break;}}if(!found)this.value=v;this.dispatchEvent(new Event('input',{bubbles:true}));this.dispatchEvent(new Event('change',{bubbles:true}));}";
  // Contenteditable is the one element class where synthesized keystrokes do nothing at all.
  // Measured against Firefox 153.0.3, not inferred:
  //   - The raw key route (sendKeys -> input.performActions) fires keydown and keyup on a
  //     contenteditable target and NOTHING else: no beforeinput, no input, no DOM mutation.
  //     That is why fill/type_text silently no-opped there before this branch existed.
  //   - document.execCommand('insertText', ...) performs a real native edit, but ONLY with an
  //     explicit Range/Selection set first. focus() alone is the discriminator: with focus and
  //     no selection anchor execCommand returns false and nothing happens; with the Range
  //     installed it returns true, the DOM mutates, and a real 'input' event fires. Both cases
  //     were probed separately, so this is a proven precondition and not defensive belt-and-braces.
  //   - This route does NOT fire 'beforeinput'. Checked at element level AND at document level in
  //     the capture phase, isTrusted included, so it is not a listener-placement artifact;
  //     queryCommandSupported('insertText') stays true throughout. Chrome's path (CDP
  //     Input.insertText) DOES fire a trusted beforeinput with correct inputType/data before
  //     'input'. That asymmetry matters for rich editors (Lexical, ProseMirror, Slate) that build
  //     their model from beforeinput: on Firefox they will not observe this edit and can desync.
  //     Plain, unmanaged contenteditable, which is what fill/type_text's contract promises, is fine.
  //   - Embedded '\n' is silently dropped by this route. It is dropped on Chrome's Input.insertText
  //     path too, so multi-line contenteditable insertion is a shared gap, not a Firefox one.
  // Deliberately NOT capability-gated: see the footer comment for why no token was added.
  private static readonly INSERT_TEXT_SOURCE =
    "function(v,collapseAtEnd){this.focus();var r=document.createRange();" +
    "r.selectNodeContents(this);if(collapseAtEnd)r.collapse(false);" +
    "var s=window.getSelection();s.removeAllRanges();s.addRange(r);" +
    "return document.execCommand('insertText', false, v);}";
  private static readonly IS_CONTENT_EDITABLE = "function(){return this.isContentEditable===true;}";
  async setValue(loc: ElementLocator, value: string): Promise<void> {
    const ref = await resolveElementLocator(this.conn, this.contextId, loc);
    const isSelect = await this.callFunctionValue("function(){return this.tagName==='SELECT';}", [], ref);
    if (isSelect === true) {
      await this.callFunctionValue(BidiPageDriver.SELECT_SOURCE, [value], ref);
      return;
    }
    const isContentEditable = await this.callFunctionValue(BidiPageDriver.IS_CONTENT_EDITABLE, [], ref);
    if (isContentEditable === true) {
      // collapseAtEnd=false: the Range spans the whole node, so the native insert REPLACES the
      // existing contents in one edit. Do not pre-clear via textContent: that mutation is not a
      // native edit, and it also destroys the selection the execCommand call depends on.
      await this.callFunctionValue(BidiPageDriver.INSERT_TEXT_SOURCE, [value, false], ref);
      return;
    }
    const clear = "function(){this.focus&&this.focus();if('value' in this){this.value='';this.dispatchEvent(new Event('input',{bubbles:true}));}}";
    await this.callFunctionValue(clear, [], ref);
    await this.sendKeys(value);
  }
  async typeText(loc: ElementLocator, text: string): Promise<void> {
    const ref = await resolveElementLocator(this.conn, this.contextId, loc);
    const isContentEditable = await this.callFunctionValue(BidiPageDriver.IS_CONTENT_EDITABLE, [], ref);
    if (isContentEditable === true) {
      // collapseAtEnd=true: caret at the end of the existing contents, so typeText appends.
      await this.callFunctionValue(BidiPageDriver.INSERT_TEXT_SOURCE, [text, true], ref);
      return;
    }
    await this.callFunctionValue("function(){this.focus&&this.focus();}", [], ref);
    await this.sendKeys(text);
  }
  async pressKey(press: KeyPress): Promise<void> {
    const value = KEY_VALUES[press.key.toLowerCase()] ?? (press.key.length === 1 ? press.key : undefined);
    if (value === undefined) throw driverError("page-error", `unknown key '${press.key}' (use a named key like Enter/Tab/ArrowDown or a single character)`);
    const mods: string[] = [];
    for (const m of press.modifiers ?? []) {
      const v = MODIFIER_VALUES[m.toLowerCase()];
      if (v === undefined) throw driverError("page-error", `unknown modifier '${m}'`);
      mods.push(v);
    }
    const actions: InputKeySourceAction[] = [...mods.map((v): InputKeySourceAction => ({ type: "keyDown", value: v })), { type: "keyDown", value }, { type: "keyUp", value }, ...[...mods].reverse().map((v): InputKeySourceAction => ({ type: "keyUp", value: v }))];
    await this.performActions([{ type: "key", id: "cdp-keyboard", actions }]);
  }
  async setFiles(loc: ElementLocator, files: readonly string[]): Promise<void> {
    const ref = await resolveElementLocator(this.conn, this.contextId, loc);
    try {
      await this.conn.send("input.setFiles", { context: this.contextId, element: ref, files: [...files] });
    } catch (e) {
      throw mapBidiError(e);
    }
  }

  async screenshot(opts?: ScreenshotOptions): Promise<{ data: Uint8Array; format: "png" | "jpeg" }> {
    const format = opts?.format ?? "png";
    const params: BrowsingContextCaptureScreenshotParameters = {
      context: this.contextId,
      format: { type: format === "jpeg" ? "image/jpeg" : "image/png", ...(format === "jpeg" ? { quality: (opts?.quality ?? 80) / 100 } : {}) },
    };
    if (opts?.clip) params.clip = { type: "element", element: await resolveElementLocator(this.conn, this.contextId, opts.clip) };
    else if (opts?.fullPage) params.origin = "document";
    try {
      const { data } = await this.conn.send("browsingContext.captureScreenshot", params);
      return { data: new Uint8Array(Buffer.from(data, "base64")), format };
    } catch (e) {
      throw mapBidiError(e);
    }
  }
  // Only userAgent and width/height/deviceScaleFactor are applied: mediaFeatures, cpuThrottling
  // and networkConditions are not in BIDI_CAPABILITIES (see its comment) and this method never
  // claims them. `mobile` has no BiDi viewport-emulation equivalent and is silently ignored,
  // a real parity gap noted in the footer rather than smoothed over.
  async emulate(opts: EmulationOptions): Promise<{ applied: string[] }> {
    if (opts.clearOverrides) {
      await this.conn.send("emulation.setUserAgentOverride", { userAgent: null, contexts: [this.contextId] }).catch(() => undefined);
      await this.conn.send("browsingContext.setViewport", { context: this.contextId, viewport: null, devicePixelRatio: null }).catch(() => undefined);
      return { applied: [] };
    }
    const applied: string[] = [];
    try {
      if (opts.width != null && opts.height != null) {
        await this.conn.send("browsingContext.setViewport", { context: this.contextId, viewport: { width: opts.width, height: opts.height }, ...(opts.deviceScaleFactor != null ? { devicePixelRatio: opts.deviceScaleFactor } : {}) });
        applied.push("deviceMetrics");
      }
      if (opts.userAgent != null) {
        await this.conn.send("emulation.setUserAgentOverride", { userAgent: opts.userAgent, contexts: [this.contextId] });
        applied.push("userAgent");
      }
    } catch (e) {
      throw mapBidiError(e);
    }
    return { applied };
  }

  private static readonly EVENT_MAP: Record<DriverEvent, string> = {
    navigated: "browsingContext.navigationCommitted", console: "log.entryAdded",
    "network.request": "network.beforeRequestSent", "network.response": "network.responseCompleted",
    dialog: "browsingContext.userPromptOpened", "page.closed": "browsingContext.contextDestroyed",
  };
  // log.entryAdded carries no top-level `context` field (it nests under source.context), so console
  // events are passed through unfiltered rather than dropped; every other mapped event does carry
  // `context` and is filtered to this page. Payload shapes are BiDi-native, NOT CDP's Runtime.
  // consoleAPICalled/Network.* shapes, a real cross-driver difference callers must not assume away.
  private contextMatches(event: DriverEvent, payload: Record<string, unknown>): boolean {
    if (event === "console") return true;
    return payload.context === undefined || payload.context === this.contextId;
  }
  on(event: DriverEvent, handler: (payload: Record<string, unknown>) => void): () => void {
    // biome-ignore lint: BidiEventName is a literal union our EVENT_MAP values satisfy at runtime.
    return this.conn.on(BidiPageDriver.EVENT_MAP[event] as never, (params) => {
      const p = params as unknown as Record<string, unknown>;
      if (this.contextMatches(event, p)) handler(p);
    });
  }
  async waitForEvent(event: DriverEvent, predicate?: (p: Record<string, unknown>) => boolean, timeoutMs?: number): Promise<Record<string, unknown>> {
    try {
      const p = await this.conn.waitFor(
        BidiPageDriver.EVENT_MAP[event] as never,
        (params) => {
          const p = params as unknown as Record<string, unknown>;
          return this.contextMatches(event, p) && (!predicate || predicate(p));
        },
        timeoutMs,
      );
      return p as unknown as Record<string, unknown>;
    } catch (e) {
      throw mapBidiError(e);
    }
  }

  private async handleOneDialog(accept: boolean, promptText: string | undefined, timeoutMs: number): Promise<HandledDialogInfo> {
    const opened = await this.conn
      .waitFor("browsingContext.userPromptOpened", (p) => p.context === this.contextId, timeoutMs)
      .catch(() => { throw driverError("timeout", `handleDialog: no dialog opened within ${timeoutMs}ms`); });
    try {
      await this.conn.send("browsingContext.handleUserPrompt", { context: this.contextId, accept, ...(promptText !== undefined ? { userText: promptText } : {}) });
    } catch (e) {
      throw mapBidiError(e);
    }
    return {
      type: opened.type, message: opened.message, url: this.info.url,
      ...(opened.defaultValue !== undefined ? { defaultPrompt: opened.defaultValue } : {}),
      accept, ...(promptText !== undefined ? { promptText } : {}), handled: true,
    };
  }
  /** autoMs: no persistent-listener primitive on this transport, so this polls handleOneDialog with a
   *  short per-iteration timeout until the window elapses. A dialog opening in the few-ms gap between
   *  iterations could theoretically be missed; Firefox has no prior handle_dialog contract to preserve,
   *  so this is an accepted approximation rather than a byte-identical port of anything. */
  async handleDialog(
    accept: boolean,
    promptText?: string,
    opts?: { timeoutMs?: number; autoMs?: number },
  ): Promise<HandledDialogInfo | { handled: HandledDialogInfo[]; count: number }> {
    if (opts?.autoMs !== undefined) {
      const deadline = Date.now() + opts.autoMs;
      const handled: HandledDialogInfo[] = [];
      while (Date.now() < deadline) {
        const remaining = deadline - Date.now();
        if (remaining <= 0) break;
        const d = await this.handleOneDialog(accept, promptText, Math.min(250, remaining)).catch(() => undefined);
        if (d) handled.push(d);
      }
      return { handled, count: handled.length };
    }
    return this.handleOneDialog(accept, promptText, opts?.timeoutMs ?? 15_000);
  }

  /**
   * storage.getCookies, partitioned by THIS browsing context.
   *
   * The context partition is the BiDi counterpart of the CDP driver's choice of
   * the page-scoped Network.getCookies over the browser-wide jar: it asks for
   * the cookies of the tab that was resolved, not for every cookie the profile
   * holds. httpOnly cookies are included, since this reads the cookie store
   * over the protocol rather than evaluating document.cookie in the page.
   */
  async getCookies(): Promise<BrowserCookie[]> {
    try {
      const { cookies } = await this.conn.send("storage.getCookies", { partition: { type: "context", context: this.contextId } });
      return (cookies ?? []).map(normalizeBidiCookie);
    } catch (e) {
      throw mapBidiError(e);
    }
  }

  /**
   * storage.setCookie, partitioned by THIS browsing context.
   *
   * One real difference from CDP to absorb, and it is absorbed EXPLICITLY
   * rather than papered over: BiDi has no `url` parameter and requires
   * `domain`, while CDP accepts either and derives the rest from the url. So a
   * caller who supplied only a url gets its host used as the domain, and a url
   * with no host (about:blank, a data: URL, a malformed string) throws instead
   * of being dropped, because a set that silently did nothing is the failure
   * this tool must never produce.
   *
   * Note the derivation is narrower than CDP's: CDP also takes `path` and
   * `secure` from the url, and this does not, so those stay exactly as the
   * caller gave them on both backends.
   */
  async setCookie(params: SetCookieParams): Promise<void> {
    const domain = params.domain ?? hostFromUrl(params.url, "set_cookie");
    try {
      await this.conn.send("storage.setCookie", {
        cookie: {
          name: params.name,
          value: { type: "string", value: params.value },
          domain,
          ...(params.path !== undefined ? { path: params.path } : {}),
          ...(params.expires !== undefined ? { expiry: params.expires } : {}),
          ...(params.httpOnly !== undefined ? { httpOnly: params.httpOnly } : {}),
          ...(params.secure !== undefined ? { secure: params.secure } : {}),
          ...(params.sameSite !== undefined ? { sameSite: params.sameSite } : {}),
        },
        partition: { type: "context", context: this.contextId },
      });
    } catch (e) {
      throw mapBidiError(e);
    }
  }

  /**
   * storage.deleteCookies with a filter, partitioned by THIS browsing context.
   *
   * Same url-to-domain derivation as setCookie and for the same reason: the
   * BiDi filter has `domain` and no `url`, and a filter that quietly dropped
   * the only site constraint would delete by name across the partition, which
   * is a bigger deletion than the caller asked for.
   *
   * BiDi reports a partitionKey and no count, exactly as CDP reports nothing,
   * so this returns nothing on both backends rather than one of them inventing
   * a number the other cannot produce.
   */
  async deleteCookies(filter: DeleteCookiesFilter): Promise<void> {
    const domain = filter.domain ?? hostFromUrl(filter.url, "delete_cookies");
    try {
      await this.conn.send("storage.deleteCookies", {
        filter: {
          name: filter.name,
          domain,
          ...(filter.path !== undefined ? { path: filter.path } : {}),
        },
        partition: { type: "context", context: this.contextId },
      });
    } catch (e) {
      throw mapBidiError(e);
    }
  }

  // Response bodies need network.addDataCollector armed BEFORE the request, per the established
  // fact this driver was handed: no way to read a body for a request that happened before
  // capture was armed. That is the mirror of the CDP driver's own honest omission of
  // network.responseBodyPostHoc (see cdp/driver.ts's footer), so this driver makes the same call
  // and does not declare it either.
  async startBodyCapture(): Promise<() => Promise<void>> {
    let collector: string;
    try {
      const res = await this.conn.send("network.addDataCollector", { dataTypes: ["response"], maxEncodedDataSize: 100_000_000, contexts: [this.contextId] });
      collector = res.collector;
    } catch (e) {
      throw mapBidiError(e);
    }
    this.bodyCollector = collector;
    return async () => {
      await this.conn.send("network.removeDataCollector", { collector }).catch(() => undefined);
      if (this.bodyCollector === collector) this.bodyCollector = undefined;
    };
  }
  async getResponseBody(requestId: string): Promise<{ body: string; base64Encoded: boolean }> {
    if (!this.bodyCollector) throw driverError("unsupported", "getResponseBody: call startBodyCapture() first (network.responseBodyPostHoc is not supported)");
    try {
      const { bytes } = await this.conn.send("network.getData", { dataType: "response", collector: this.bodyCollector, request: requestId });
      return bytes.type === "base64" ? { body: bytes.value, base64Encoded: true } : { body: bytes.value, base64Encoded: false };
    } catch (e) {
      throw mapBidiError(e);
    }
  }
  // Reuses ../tools/network_mock.ts's pure logic layer (selectRule/buildFulfillParams/
  // effectiveAction), same as cdp/driver.ts's intercept, mapped onto network.addIntercept's
  // beforeRequestSent phase instead of CDP's Fetch domain.
  async intercept(rules: readonly InterceptRule[]): Promise<() => Promise<void>> {
    let intercept: string;
    try {
      // network.addIntercept's urlPatterns are LITERAL/structured matches (network.UrlPattern),
      // not CDP's glob syntax: passing our `*`-glob urlPattern strings through verbatim throws
      // "unescaped forbidden character *" (verified against Firefox 153.0.3). So every request in
      // this context is intercepted and selectRule()'s own glob matching decides continue vs
      // fulfill vs fail below, exactly as urlMatches() already does for the CDP driver's globs.
      const res = await this.conn.send("network.addIntercept", { phases: ["beforeRequestSent"], contexts: [this.contextId] });
      intercept = res.intercept;
    } catch (e) {
      throw mapBidiError(e);
    }
    const off = this.conn.on("network.beforeRequestSent", (params) => {
      void (async () => {
        const req = params.request;
        const rule = selectRule(rules as Array<InterceptRule & { urlPattern: string }>, req.url, req.method);
        if (!rule) { await this.conn.send("network.continueRequest", { request: req.request }).catch(() => undefined); return; }
        if (rule.delayMs) await new Promise((r) => setTimeout(r, rule.delayMs));
        const act = effectiveAction(rule, Math.random());
        if (act === "fulfill") {
          const built = buildFulfillParams(req.request, rule);
          await this.conn.send("network.provideResponse", {
            request: req.request, statusCode: built.responseCode,
            headers: built.responseHeaders.map((h) => ({ name: h.name, value: { type: "string" as const, value: h.value } })),
            body: { type: "base64" as const, value: built.body },
          }).catch(() => undefined);
        } else if (act === "fail") {
          await this.conn.send("network.failRequest", { request: req.request }).catch(() => undefined);
        } else {
          await this.conn.send("network.continueRequest", { request: req.request }).catch(() => undefined);
        }
      })();
    });
    return async () => {
      off();
      await this.conn.send("network.removeIntercept", { intercept }).catch(() => undefined);
    };
  }

  async release(): Promise<void> {
    if (this.released) return;
    this.released = true;
    this.conn.release();
  }
}

/* --------------------------------- BrowserDriver --------------------------------- */
class BidiBrowserDriver implements BrowserDriver {
  readonly scheme = "bidi";
  readonly lifetime: LifetimeModel = "session";
  readonly capabilities = BIDI_CAPABILITIES;
  readonly uidStability: UidStability = "document-stamp";
  readonly snapshotFidelity = "dom-heuristic" as const;
  constructor(private readonly port: number, private readonly timeoutMs?: number) {}

  async listPages(): Promise<PageInfo[]> {
    const conn = await getConnection(this.port, this.timeoutMs);
    try {
      const { contexts } = await conn.send("browsingContext.getTree", {}).catch((e) => { throw mapBidiError(e); });
      return Promise.all(contexts.map((c) => pageInfoOf(conn, c)));
    } finally {
      conn.release();
    }
  }
  async newPage(url?: string): Promise<PageInfo> {
    const conn = await getConnection(this.port, this.timeoutMs);
    try {
      const { context } = await conn.send("browsingContext.create", { type: "tab" }).catch((e) => { throw mapBidiError(e); });
      // Established fact: navigating the default about:home context to a data: URL is rejected,
      // so a fresh context is created here FIRST and only then navigated, never reused as-is.
      if (url) await conn.send("browsingContext.navigate", { context, url, wait: "complete" }).catch((e) => { throw mapBidiError(e); });
      return { id: context, url: url ?? "about:blank", title: await safeTitle(conn, context) };
    } finally {
      conn.release();
    }
  }
  async closePage(id: string): Promise<{ success: boolean }> {
    const conn = await getConnection(this.port, this.timeoutMs);
    try {
      await conn.send("browsingContext.close", { context: id }).catch((e) => { throw mapBidiError(e); });
      return { success: true };
    } finally {
      conn.release();
    }
  }
  async activatePage(id: string): Promise<PageInfo> {
    const conn = await getConnection(this.port, this.timeoutMs);
    try {
      await conn.send("browsingContext.activate", { context: id }).catch((e) => { throw mapBidiError(e); });
      const ctx = await resolveContext(conn, id);
      return await pageInfoOf(conn, ctx);
    } finally {
      conn.release();
    }
  }
  async page(selector: TargetSelector): Promise<PageDriver> {
    const conn = await getConnection(this.port, this.timeoutMs);
    let ctx: BrowsingContextInfo;
    try {
      ctx = await resolveContext(conn, selector);
    } catch (e) {
      conn.release();
      throw e;
    }
    const info = await pageInfoOf(conn, ctx);
    return new BidiPageDriver(conn, ctx.context, info, this);
  }

  /**
   * Install the activity beacon (../activity.ts) into a context and every
   * document it navigates to afterwards.
   *
   * Both legs matter: script.addPreloadScript arms every FUTURE document (and
   * survives navigation for free here, see bidiBeaconScripts above), while the
   * script.evaluate arms the document already loaded, which a preload script
   * never retroactively reaches.
   *
   * DELIBERATELY GATE-FREE (no resolveContext), like its CDP twin and for the
   * same reason: the claim_page{target} path reads and installs around a claim
   * that the lease gate would otherwise take on its own behalf. Returning false
   * rather than throwing is the contract — installBeacon's caller treats this as
   * an annotation that must never fail real work.
   */
  async installActivityBeacon(contextId: string): Promise<boolean> {
    const conn = await getConnection(this.port, this.timeoutMs).catch(() => undefined);
    if (!conn) return false;
    try {
      const key = `${this.port}:${contextId}`;
      if (!bidiBeaconScripts.has(key)) {
        const registered = await conn.send("script.addPreloadScript", {
          functionDeclaration: BEACON_FUNCTION_DECLARATION,
          contexts: [contextId],
        });
        bidiBeaconScripts.set(key, registered.script);
      }
      await conn.send("script.evaluate", {
        expression: BEACON_SOURCE,
        target: { context: contextId },
        awaitPromise: false,
      });
      return true;
    } catch {
      return false;
    } finally {
      conn.release();
    }
  }

  /** Read the beacon timestamp for a context, or null when it has none. Gate-free;
   *  see the declaration in ../driver.ts for why that is required here. */
  async readActivityBeacon(contextId: string): Promise<number | null> {
    const conn = await getConnection(this.port, this.timeoutMs).catch(() => undefined);
    if (!conn) return null;
    try {
      const res = await conn.send("script.evaluate", {
        expression: BEACON_READ_EXPRESSION,
        target: { context: contextId },
        awaitPromise: false,
      });
      if (res.type !== "success") return null;
      const value = deserializeRemote(res.result);
      return typeof value === "number" && Number.isFinite(value) ? value : null;
    } catch {
      return null;
    } finally {
      conn.release();
    }
  }

  async dispose(): Promise<void> {
    for (const key of [...bidiBeaconScripts.keys()]) {
      if (key.startsWith(`${this.port}:`)) bidiBeaconScripts.delete(key);
    }
    const conn = connections.get(this.port);
    if (!conn) return;
    connections.delete(this.port);
    conn.dispose();
  }
}

/** Construct the BiDi implementation of the frozen Driver contract. `port` is a Firefox debug
 *  port already listening (see ./launch.ts's launchFirefox), never 9222/CDP's convention. */
export function createFirefoxDriver(port: number, opts?: { timeoutMs?: number }): BrowserDriver {
  return new BidiBrowserDriver(port, opts?.timeoutMs);
}
// resolveContext is exported for ONE reason: it is the Firefox lease choke
// point, and a choke point nothing can call directly is a choke point nothing
// can test. Its gate was deletable with a green suite until test/leases.test.ts
// could drive it against a stub connection. Not part of the public surface.
export { BidiBrowserDriver, BidiPageDriver, resolveContext };

/* ------------------------------------------------------------------------------
 * BiDi modules/commands used: session (new, subscribe/unsubscribe, via client.ts); browsingContext
 * (create, close, activate, getTree, navigate, reload, locateNodes, captureScreenshot, setViewport,
 * handleUserPrompt); script (evaluate, callFunction); input (performActions, setFiles); network
 * (addDataCollector, removeDataCollector, getData, addIntercept, removeIntercept, continueRequest,
 * provideResponse, failRequest, beforeRequestSent event); emulation (setUserAgentOverride). Events
 * subscribed via BidiConnection.on/waitFor: browsingContext.navigationCommitted/userPromptOpened/
 * contextDestroyed, log.entryAdded, network.beforeRequestSent/responseCompleted.
 *
 * Parity gaps vs cdp/driver.ts, one line each:
 *   - locate.text: not declared, unlike CDP (which has it via DOM.performSearch). Firefox 153's
 *     browsingContext.locateNodes rejects locator.type "innerText" as not-yet-supported; the
 *     ElementLocator `text` branch still resolves and correctly surfaces "unsupported" if called.
 *   - snapshot.accessibilityTree: not declared. snapshotFidelity is "dom-heuristic" (a DOM walk in
 *     ../bidi/snapshot.ts), not a native a11y-tree dump; Firefox 153 BiDi has no such domain.
 *   - input.insertTextAtomic: not declared. There is no atomic value-commit primitive over BiDi.
 *     WebDriver BiDi has no input.insertText command at all (input.performActions and
 *     input.setFiles are the whole input module), so there is nothing to fall back on. For
 *     <input>/<textarea> setValue/typeText synthesize keystrokes via input.performActions (see
 *     sendKeys); for contenteditable that route fires keydown/keyup and nothing else, so those
 *     take the execCommand('insertText')-with-explicit-Range branch instead (see setValue).
 *   - beforeinput on contenteditable: NOT fired under Firefox 153.0.3, while Chrome's
 *     Input.insertText path fires a trusted one with correct inputType/data. Verified on both
 *     backends at document/capture level. Stated here as a known limit rather than declared as a
 *     capability token on purpose: the Capability union exists solely so tools/list can hide a
 *     tool an agent must not call (REQUIRED_CAPABILITIES, src/driver.ts), and no tool should
 *     REQUIRE this. Gating fill/type_text on it would delete two working tools from Firefox, where
 *     they are correct for inputs, textareas, selects and plain contenteditables. A token that
 *     gates nothing is dead code shaped like a safety mechanism, and MCP tool descriptions are a
 *     static MANIFEST (src/manifest.ts) that tools/list forwards verbatim, filtered by name only
 *     (src/mcp.ts), so there is no per-backend description channel to carry the caveat either.
 *   - Multi-line contenteditable: an embedded '\n' is silently dropped on BOTH backends, not just
 *     this one. Neither insertText route synthesizes a <br> or a block break.
 *   - trace.performance / heap.snapshot / audit.lighthouse: not declared, Chrome-only domains with
 *     no BiDi equivalent at all.
 *   - emulate.mediaFeatures / emulate.cpuThrottling / emulate.networkConditions: not declared.
 *     Firefox 153 does not implement setMediaFeaturesOverride; CPU throttling and network condition
 *     emulation have no verified-working BiDi path in this environment, so emulate() never claims
 *     them and silently ignores the `mobile` flag (no BiDi mobile-viewport emulation exists either).
 *   - network.responseBodyPostHoc: not declared, deliberately, mirroring cdp/driver.ts's own call.
 *     network.addDataCollector must be armed before the request; there is no reading a body for a
 *     request that predates arming, so an honest capability set omits it exactly as Chrome's does.
 *   - NavigateResult.waitedFor never returns "timeout": BiDi's navigate/reload block server-side on
 *     `wait`, so an unreachable milestone is a thrown "timeout" DriverError, not CDP's soft return.
 *   - LifetimeModel's "MUST re-establish itself transparently if the transport dies" is NOT
 *     implemented: a dead BiDi socket surfaces as "disconnected" on every subsequent call instead
 *     of silently starting a new session underneath the caller. See the top-of-file comment.
 * ---------------------------------------------------------------------------- */
