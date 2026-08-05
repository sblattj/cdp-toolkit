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
  UID_STAMP_ATTR, isDriverError,
  type BrowserDriver, type Capability, type DialogInfo, type DriverError, type DriverErrorCode, type DriverEvent,
  type DriverUid, type ElementLocator, type EmulationOptions, type InterceptRule, type KeyPress, type LifetimeModel,
  type MouseButtonOptions, type NavigateOptions, type NavigateResult, type PageDriver, type PageInfo,
  type ScreenshotOptions, type SnapshotNode, type UidStability,
} from "../driver.ts";
import { BidiConnection, BidiError, connectBidiSession } from "./client.ts";
import { takeStampedSnapshot } from "./snapshot.ts";
import { selectRule, buildFulfillParams, effectiveAction } from "../tools/network_mock.ts";
import type {
  BrowsingContextId, BrowsingContextInfo, BrowsingContextLocator, BrowsingContextReadinessState,
  BrowsingContextCaptureScreenshotParameters, ScriptSharedReference, ScriptRemoteValue, ScriptLocalValue,
  ScriptNodeRemoteValue, ScriptExceptionDetails, InputSourceActions, InputPointerSourceAction, InputKeySourceAction,
} from "./protocol.ts";

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
 *  (browsingContext.getTree): there is no HTTP discovery endpoint here, per client.ts's own footer. */
async function resolveContext(conn: BidiConnection, selector: TargetSelector): Promise<BrowsingContextInfo> {
  const { contexts } = await conn.send("browsingContext.getTree", {}).catch((e) => { throw mapBidiError(e); });
  if (!contexts.length) throw driverError("no-such-target", "no browsing contexts available");
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

  async navigate(opts: NavigateOptions): Promise<NavigateResult> {
    const reload = opts.reload === true;
    if (!reload && !opts.url) throw driverError("page-error", "navigate: 'url' is required unless reload:true");
    const waitUntil = opts.waitUntil ?? "load";
    const wait: BrowsingContextReadinessState = waitUntil === "domcontentloaded" ? "interactive" : "complete";
    const sendOpts = opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {};
    try {
      if (reload) {
        const r = await this.conn.send("browsingContext.reload", { context: this.contextId, ignoreCache: opts.ignoreCache === true, wait }, sendOpts);
        return { url: r.url, contextId: this.contextId, reloaded: true, waitedFor: waitUntil };
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
  async waitForText(text: string, timeoutMs = 15_000): Promise<{ found: true; elapsedMs: number }> {
    const start = Date.now();
    const expr = `(() => { const b = document.body; return !!b && typeof b.innerText === 'string' && b.innerText.includes(${JSON.stringify(text)}); })()`;
    for (;;) {
      const found = await this.conn.send("script.evaluate", { expression: expr, target: { context: this.contextId }, awaitPromise: true })
        .then((r) => r.type === "success" && deserializeRemote(r.result) === true)
        .catch(() => false);
      if (found) return { found: true, elapsedMs: Date.now() - start };
      if (Date.now() - start >= timeoutMs) throw driverError("timeout", `waitForText: '${text}' not found within ${timeoutMs}ms`);
      await new Promise((r) => setTimeout(r, Math.min(250, Math.max(0, timeoutMs - (Date.now() - start)))));
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

  private async performActions(actions: InputSourceActions[]): Promise<void> {
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
  async click(loc: ElementLocator, opts?: MouseButtonOptions): Promise<{ x: number; y: number }> {
    const ref = await resolveElementLocator(this.conn, this.contextId, loc);
    const { x, y } = await this.centerOf(ref);
    const button = BUTTON_CODES[opts?.button ?? "left"];
    const actions: InputPointerSourceAction[] = [{ type: "pointerMove", x, y, duration: 0 }];
    for (let i = 0; i < (opts?.clickCount ?? 1); i++) actions.push({ type: "pointerDown", button }, { type: "pointerUp", button });
    await this.performActions([{ type: "pointer", id: "cdp-mouse", actions }]);
    return { x, y };
  }
  async drag(from: ElementLocator, to: ElementLocator): Promise<{ from: { x: number; y: number }; to: { x: number; y: number } }> {
    const fromPt = await this.centerOf(await resolveElementLocator(this.conn, this.contextId, from));
    const toPt = await this.centerOf(await resolveElementLocator(this.conn, this.contextId, to));
    const actions: InputPointerSourceAction[] = [
      { type: "pointerMove", x: fromPt.x, y: fromPt.y, duration: 0 }, { type: "pointerDown", button: 0 },
      { type: "pointerMove", x: (fromPt.x + toPt.x) / 2, y: (fromPt.y + toPt.y) / 2, duration: 50 },
      { type: "pointerMove", x: toPt.x, y: toPt.y, duration: 50 }, { type: "pointerUp", button: 0 },
    ];
    await this.performActions([{ type: "pointer", id: "cdp-mouse", actions }]);
    return { from: fromPt, to: toPt };
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
  async setValue(loc: ElementLocator, value: string): Promise<void> {
    const ref = await resolveElementLocator(this.conn, this.contextId, loc);
    const isSelect = await this.callFunctionValue("function(){return this.tagName==='SELECT';}", [], ref);
    if (isSelect === true) {
      await this.callFunctionValue(BidiPageDriver.SELECT_SOURCE, [value], ref);
      return;
    }
    const clear = "function(){this.focus&&this.focus();if('value' in this){this.value='';this.dispatchEvent(new Event('input',{bubbles:true}));}else if(this.isContentEditable){this.textContent='';}}";
    await this.callFunctionValue(clear, [], ref);
    await this.sendKeys(value);
  }
  async typeText(loc: ElementLocator, text: string): Promise<void> {
    const ref = await resolveElementLocator(this.conn, this.contextId, loc);
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

  async handleDialog(accept: boolean, promptText?: string): Promise<DialogInfo> {
    const opened = await this.conn
      .waitFor("browsingContext.userPromptOpened", (p) => p.context === this.contextId, 15_000)
      .catch(() => { throw driverError("timeout", "handleDialog: no dialog opened within 15000ms"); });
    try {
      await this.conn.send("browsingContext.handleUserPrompt", { context: this.contextId, accept, ...(promptText !== undefined ? { userText: promptText } : {}) });
    } catch (e) {
      throw mapBidiError(e);
    }
    return { type: opened.type, message: opened.message, url: this.info.url, ...(opened.defaultValue !== undefined ? { defaultPrompt: opened.defaultValue } : {}) };
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
  async closePage(id: string): Promise<void> {
    const conn = await getConnection(this.port, this.timeoutMs);
    try {
      await conn.send("browsingContext.close", { context: id }).catch((e) => { throw mapBidiError(e); });
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
  async dispose(): Promise<void> {
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
export { BidiBrowserDriver, BidiPageDriver };

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
 *   - input.insertTextAtomic: not declared. There is no atomic value-commit primitive over BiDi;
 *     setValue/typeText always synthesize keystrokes via input.performActions (see sendKeys).
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
