/**
 * ONE implementation per tool, built only on the browser-neutral Driver contract in driver.ts
 * (ADR-001), used by BOTH Chrome (via cdp/driver.ts's createCdpDriver()) and Firefox (via
 * bidi/driver.ts's createFirefoxDriver()). This file replaces the split that used to exist
 * between src/tools/*.ts (raw CDP, Chrome only) and src/neutral.ts (Driver-based, Firefox only)
 * for 20 of the 23 tools below. The other three, the list_cookies/set_cookie/delete_cookies
 * cookie group, landed here directly and never had a Chrome-only copy.
 *
 * THE HARD REQUIREMENT this file exists to satisfy: Chrome's return shape, timing, and quirks
 * stay byte-identical to what src/tools/*.ts produced before this migration: that already
 * shipped to npm. Where the clean Driver abstraction and that requirement conflicted, the
 * requirement won; every such place is called out in a comment at the call site. The most
 * significant ones:
 *   - take_snapshot's uid is rendered as a bare digit for the "cdp" scheme (matching the legacy
 *     backendDOMNodeId-as-uid contract) rather than the driver's own tagged "cdp:N" form, and its
 *     extras (checked/expanded/disabled/url/focused) keep the legacy per-key quoting AND the
 *     "expanded" quirk (included even when literally "false") rather than a clean uniform rule.
 *   - navigate_page's field names (frameId, not contextId) and waitedFor vocabulary (load /
 *     domcontentloaded / frameStoppedLoading / navigate-only) are the legacy CDP tool's, not the
 *     Driver's own (committed / timeout).
 *   - Every nested `target` object in a result is the legacy 3-field {id,url,title}: PageInfo's
 *     additive `type` field is deliberately dropped there (list_pages is the one place `type` is
 *     part of the contract).
 *
 * NOT here: list_console_messages / get_console_message / list_network_requests /
 * get_network_request / mock_request / list_mocks / clear_mocks. Chrome's versions of those 7
 * tools are built on src/tools/recorder.ts, a disk-persisted, cross-process capture keyed by
 * target id (rec-<targetId>.jsonl) with a materially richer shape (ConsoleEntry/NetworkRequest
 * correlation, per-rule hit counts, dedup-by-pattern+method). Firefox's existing implementation
 * (now in src/bidi-tools.ts) is a same-process, in-memory event buffer with a different shape.
 * Unifying them safely would mean either dropping Chrome's cross-process persistence (a real
 * behavior change to something that ships today) or teaching Firefox to write the same JSONL
 * format (new feature work, not a safety-preserving migration). Per the explicit instruction that
 * behavior outranks the abstraction, these 7 stay two implementations; see the migration report.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type {
  BrowserCookie, BrowserDriver, DriverUid, ElementLocator, NavigateResult, PageDriver, PageInfo, SnapshotNode,
} from "./driver.ts";
import type { TargetSelector } from "./types.ts";
import { assertLeaseOk, claimLease, defaultLabel, leaseTtlMs, releaseLeaseFor, type LeaseBackend, type LeaseToken } from "./leases.ts";
import { newTrackedPage, originIndex, type PageOrigin } from "./origins.ts";

const ARTIFACT_DIR = process.env.CDP_ARTIFACT_DIR ?? "/tmp/cdp-toolkit";
const STATE_DIR = process.env.CDP_STATE_DIR ?? "/tmp/cdp-toolkit";

class SharedToolError extends Error {}

/** Trim a PageInfo down to the legacy 3-field {id,url,title} target shape used everywhere except list_pages. */
function target3(p: PageInfo): { id: string; url: string; title: string } {
  return { id: p.id, url: p.url, title: p.title };
}

/** Same discriminator leases-tools.ts uses: the driver's own uid scheme tag
 *  ("cdp" for Chrome, "bidi" for Firefox). */
function backendOf(driver: BrowserDriver): LeaseBackend {
  return driver.scheme === "bidi" ? "firefox" : "chrome";
}

/* -------------------------------- page acquisition -------------------------------- */

/** Acquire, run, always release: the Driver counterpart of client.ts's withPage. */
async function withPage<T>(driver: BrowserDriver, target: TargetSelector | undefined, fn: (page: PageDriver) => Promise<T>): Promise<T> {
  const page = await driver.page(target);
  try {
    return await fn(page);
  } finally {
    await page.release();
  }
}

/** Exported for leases-tools.ts's release_page{target}, which needs exactly this
 *  gate: resolving through here is what authorizes the release. */
export async function resolvePage(driver: BrowserDriver, selector?: TargetSelector): Promise<PageInfo> {
  const pages = await driver.listPages();
  const hit = await pickPage(driver, pages, selector);
  // THE third choke point. close_page and select_page resolve here and nowhere
  // else, so the lease check has to be here too, not only in resolveTarget /
  // resolveContext. Closing someone else's leased tab is the worst version of
  // the collision this feature exists to stop.
  //
  // Deliberately NOT passing liveIds, matching resolveTarget and resolveContext.
  // For every branch but one it would be inert (hit is an element of `pages`),
  // and for the bare-id branch it would be actively wrong: that branch can
  // return a non-page target off the `all:true` listing, whose id is absent
  // from `pages`, so passing pages' ids would report a perfectly healthy lease
  // as target-gone and wave the caller straight through it.
  await assertLeaseOk(backendOf(driver), hit.id, { url: hit.url, title: hit.title });
  return hit;
}

/**
 * Same TargetSelector grammar as client.ts's resolveTarget. Matches its one asymmetry exactly:
 * every branch resolves against page-type targets only EXCEPT a bare-id lookup, which (like
 * legacy resolveTarget's `targets.find`) searches the FULL unfiltered listing, so passing an
 * exact non-page targetId (a worker, an iframe) still resolves.
 */
async function pickPage(driver: BrowserDriver, pages: PageInfo[], selector?: TargetSelector): Promise<PageInfo> {
  if (selector === undefined || selector === "active") {
    if (!pages.length) throw new SharedToolError("no page targets open");
    return pages[0]!;
  }
  if (selector.startsWith("index:")) {
    const p = pages[Number(selector.slice(6))];
    if (!p) throw new SharedToolError(`no page target at index ${selector.slice(6)} (have ${pages.length})`);
    return p;
  }
  if (selector.startsWith("url:")) {
    const needle = selector.slice(4);
    const p = pages.find((x) => x.url.includes(needle));
    if (!p) throw new SharedToolError(`no page url containing '${needle}'`);
    return p;
  }
  if (selector.startsWith("title:")) {
    const needle = selector.slice(6);
    const p = pages.find((x) => x.title.includes(needle));
    if (!p) throw new SharedToolError(`no page title containing '${needle}'`);
    return p;
  }
  const exactPage = pages.find((x) => x.id === selector);
  if (exactPage) return exactPage;
  const all = await driver.listPages({ all: true });
  const exact = all.find((x) => x.id === selector);
  if (exact) return exact;
  throw new SharedToolError(`no target with id '${selector}'`);
}

/* -------------------------------- element locators -------------------------------- */

function locatorOf(args: { uid?: DriverUid; selector?: string }): ElementLocator {
  const hasUid = args.uid !== undefined && args.uid !== null && args.uid !== ("" as unknown);
  const hasSelector = typeof args.selector === "string" && args.selector.length > 0;
  if (hasUid === hasSelector) throw new SharedToolError("provide exactly one of { uid } or { selector }");
  return hasUid ? { uid: args.uid as DriverUid } : { css: args.selector as string };
}

/* -------------------------------- pages (4) -------------------------------- */

/**
 * A page listing entry, PageInfo plus provenance. STRICTLY ADDITIVE: {id, url,
 * title, type} are unchanged in name, type and value, because consumers read
 * them today.
 */
export interface ListedPage extends PageInfo {
  /** "agent" when the creation ledger has a record for this target. Otherwise
   *  "unknown", NEVER "human": the absence of a record is not proof that a
   *  person opened the tab. See src/origins.ts. */
  origin: PageOrigin;
  /** The creating agent's label. Present only when origin is "agent". */
  label?: string;
  /** When this toolkit created the tab (epoch ms). Only when origin is "agent". */
  createdAt?: number;
  /** Present only when this target HAS a ledger record that could not be read:
   *  the errno, or "unparseable". origin stays "unknown" because provenance is
   *  genuinely unknown, but this field is what keeps an unreadable record from
   *  being reported as a clean "nothing was ever recorded". */
  originUnreadable?: string;
}

/**
 * The reap set for the origin ledger: every target the browser currently has,
 * INCLUDING non-page targets, regardless of what this call is listing.
 *
 * Using the filtered page list would be a bug with a plausible disguise: a
 * default list_pages call drops workers and iframes, so reaping against it
 * would delete the ledger record of any target that is alive but filtered out.
 * Returning undefined (which listOrigins reads as "reap nothing") when the
 * unfiltered listing fails is the same principle one step further: a failed
 * enumeration must never be able to empty the ledger.
 */
async function reapSet(driver: BrowserDriver, pages: PageInfo[], all?: boolean): Promise<readonly string[] | undefined> {
  if (all === true) return pages.map((p) => p.id);
  try {
    return (await driver.listPages({ all: true })).map((p) => p.id);
  } catch {
    return undefined;
  }
}

export async function listPages(driver: BrowserDriver, args: { all?: boolean } = {}): Promise<{ pages: ListedPage[]; count: number }> {
  const pages = await driver.listPages({ all: args.all });
  // Never let provenance break the listing: originIndex does not throw, and a
  // missing or unreadable ledger yields an empty map, so every page falls back
  // to origin "unknown" exactly as a pre-ledger consumer always saw.
  const ledger = await originIndex(backendOf(driver), await reapSet(driver, pages, args.all));
  const annotated: ListedPage[] = pages.map((p) => {
    const rec = ledger.get(p.id);
    if (!rec) return { ...p, origin: "unknown" };
    if (rec.unreadable !== undefined) return { ...p, origin: "unknown", originUnreadable: rec.unreadable };
    return { ...p, origin: "agent", label: rec.label, createdAt: rec.createdAt };
  });
  return { pages: annotated, count: annotated.length };
}

export async function newPage(
  driver: BrowserDriver,
  args: { url?: string; claim?: boolean; label?: string; ttlMs?: number } = {},
): Promise<{ targetId: string; url: string; lease?: LeaseToken; label?: string; expiresAt?: number }> {
  const label = typeof args.label === "string" && args.label.length ? args.label : defaultLabel();
  // Creates the tab AND writes its creation record. The record outlives any
  // lease taken below, which is the point: a released tab is still an agent's.
  const p = await newTrackedPage(driver, backendOf(driver), { url: args.url, label });
  if (args.claim !== true) return { targetId: p.id, url: p.url };
  // Atomic in the sense that matters: the tab is claimed before this call
  // returns, so no other agent can see it unclaimed and take it first.
  const { record, token } = await claimLease(backendOf(driver), p.id, {
    label,
    ttlMs: typeof args.ttlMs === "number" && args.ttlMs > 0 ? args.ttlMs : leaseTtlMs(),
  });
  return { targetId: p.id, url: p.url, lease: token, label: record.label, expiresAt: record.lastUsedAt + record.ttlMs };
}

export async function closePage(
  driver: BrowserDriver,
  args: { target?: TargetSelector },
): Promise<{ closed: string; success: boolean; leaseReleased?: boolean }> {
  if (args.target === undefined || args.target === "") throw new SharedToolError("close_page requires an explicit target; refusing to guess which page to close");
  const p = await resolvePage(driver, args.target);
  const res = await driver.closePage(p.id);
  // A failed close (target refused to close, or was already gone) must leave
  // the lease intact: the caller still owns a tab that never actually closed,
  // and releasing it here would let another agent claim a tab this one still
  // thinks it holds.
  if (!res.success) return { closed: p.id, success: false, leaseReleased: false };
  // Closing a leased tab must not leave its lease file behind waiting on the
  // TTL. resolvePage above already refused this call unless the caller holds
  // the lease, so no token is needed here.
  const released = await releaseLeaseFor(backendOf(driver), p.id);
  return { closed: p.id, success: true, ...(released.released ? { leaseReleased: true } : {}) };
}

async function writeSelectedFile(id: string): Promise<void> {
  await mkdir(STATE_DIR, { recursive: true });
  await writeFile(join(STATE_DIR, "selected"), id, "utf8");
}

export async function selectPage(driver: BrowserDriver, args: { target?: TargetSelector }): Promise<{ selected: string }> {
  if (args.target === undefined || args.target === "") throw new SharedToolError("select_page requires an explicit target");
  const p = await resolvePage(driver, args.target);
  const activated = await driver.activatePage(p.id);
  await writeSelectedFile(activated.id);
  return { selected: activated.id };
}

/* ------------------------------ navigation (2) ------------------------------ */

/** Legacy tools/navigation.ts vocabulary, not the Driver's own (see file header). */
function toLegacyWaitedFor(w: NavigateResult["waitedFor"]): "load" | "domcontentloaded" | "frameStoppedLoading" | "navigate-only" {
  if (w === "committed") return "frameStoppedLoading";
  if (w === "timeout") return "navigate-only";
  return w;
}

export interface LegacyNavigateResult {
  url: string;
  frameId: string;
  reloaded?: boolean;
  waitedFor: "load" | "domcontentloaded" | "frameStoppedLoading" | "navigate-only";
}

export async function navigatePage(
  driver: BrowserDriver,
  args: { target?: TargetSelector; url?: string; reload?: boolean; ignoreCache?: boolean; waitUntil?: "load" | "domcontentloaded"; timeoutMs?: number },
): Promise<LegacyNavigateResult> {
  const reload = args.reload === true;
  if (!reload && (!args.url || typeof args.url !== "string")) {
    throw new SharedToolError("navigate_page: 'url' is required (or pass reload:true to reload the current page)");
  }
  return withPage(driver, args.target, async (page) => {
    const r = await page.navigate(args);
    return {
      url: r.url,
      frameId: r.contextId,
      ...(r.reloaded ? { reloaded: r.reloaded } : {}),
      waitedFor: toLegacyWaitedFor(r.waitedFor),
    };
  });
}

export async function waitForText(driver: BrowserDriver, args: { target?: TargetSelector; text: string; timeoutMs?: number; pollMs?: number }): Promise<{ found: true; waitedMs: number }> {
  if (typeof args.text !== "string" || args.text.length === 0) throw new SharedToolError("wait_for: 'text' is required");
  return withPage(driver, args.target, async (page) => {
    const r = await page.waitForText(args.text, args.timeoutMs ?? 15_000, args.pollMs ?? 250);
    return { found: true, waitedMs: r.elapsedMs };
  });
}
/** Contract-mandated alias, matching tools/navigation.ts's exported `waitFor`. */
export const waitFor = waitForText;

/* ------------------------------- evaluate (1) ------------------------------- */

/**
 * The `savePath` result shape. Deliberately carries NO form of the evaluated
 * value: not the value, not a preview, not a truncation, not a byte prefix.
 * The whole reason `savePath` exists is that the value may be a credential
 * (a JWT or session token read out of localStorage), and anything this object
 * carried would land in the caller's transcript, which is the exact leak the
 * file sink is here to prevent. `type` is the JS typeof of the value ("null"
 * for null), which describes the value without disclosing any of it.
 */
export interface EvaluateScriptSaveResult {
  path: string;
  bytes: number;
  type: string;
  target: { id: string; url: string; title: string };
}

/**
 * Serialize an evaluated value for the file sink. `undefined` (an expression
 * with no result) is written as JSON null rather than left unwritten, so the
 * file always exists and always parses.
 */
function serializeForSink(value: unknown): string {
  const json = JSON.stringify(value === undefined ? null : value, null, 2);
  return json ?? "null";
}

/**
 * THE file sink, shared by every tool that takes a `savePath`: serialize the
 * value as JSON, write it, and report only where it went and how big it was.
 * It returns no form of the value on purpose, so a caller of this helper
 * cannot accidentally leak one back into a response.
 *
 * Path resolution matches take_heapsnapshot: an absolute path is used as-is, a
 * relative one resolves under the artifact dir, and missing parent directories
 * are created.
 */
async function writeJsonSink(savePath: string, value: unknown): Promise<{ path: string; bytes: number }> {
  const path = savePath.startsWith("/") ? savePath : join(ARTIFACT_DIR, savePath);
  await mkdir(dirname(path), { recursive: true });
  const json = serializeForSink(value);
  await writeFile(path, json, "utf8");
  return { path, bytes: Buffer.byteLength(json, "utf8") };
}

/** True when a savePath argument actually asks for the sink. An empty string is
 *  treated as absent, so the caller gets the value inline. */
function sinkRequested(savePath?: string): savePath is string {
  return savePath !== undefined && savePath !== "";
}

export async function evaluateScript(
  driver: BrowserDriver,
  args: { target?: TargetSelector; expression: string; awaitPromise?: boolean; args?: unknown[]; savePath?: string },
): Promise<unknown> {
  if (typeof args.expression !== "string" || args.expression.length === 0) {
    throw new SharedToolError("evaluateScript: 'expression' must be a non-empty string");
  }
  return withPage(driver, args.target, async (page) => {
    const value = await page.evaluate(args.expression, { args: args.args, awaitPromise: args.awaitPromise ?? true });
    // No savePath: byte-identical to the pre-sink behavior, the value itself.
    // A thrown page-side exception never reaches here, so it still surfaces as
    // an error rather than being written into the file.
    if (!sinkRequested(args.savePath)) return value;

    const { path, bytes } = await writeJsonSink(args.savePath, value);
    const result: EvaluateScriptSaveResult = {
      path,
      bytes,
      type: value === null ? "null" : typeof value,
      target: target3(page.info),
    };
    return result;
  });
}

/* -------------------------------- cookies (1) -------------------------------- */

/**
 * The `savePath` result shape for list_cookies. Same rule as
 * EvaluateScriptSaveResult: NO cookie value in any form, not even a prefix. A
 * session cookie IS the credential, so a preview of one is a leaked one.
 * `count` is how many cookies were written, which tells a caller the read
 * worked without disclosing anything about what it read.
 */
export interface ListCookiesSaveResult {
  path: string;
  bytes: number;
  count: number;
  target: { id: string; url: string; title: string };
}

export interface ListCookiesResult {
  cookies: BrowserCookie[];
  count: number;
  target: { id: string; url: string; title: string };
}

/**
 * Cookie domain matching for the `domain` filter, deliberately small.
 *
 * A cookie's own domain carries a leading dot when it was set for subdomains
 * (".example.test") and none when it was host-only ("example.test"), and a
 * caller who types "example.test" means both. So the comparison strips a
 * leading dot from each side and then accepts an exact match or a subdomain of
 * the filter ("app.example.test" matches "example.test"). That is the whole
 * rule: no wildcards, no patterns, no query language.
 */
function cookieDomainMatches(cookieDomain: string, filter: string): boolean {
  const bare = (d: string) => (d.startsWith(".") ? d.slice(1) : d).toLowerCase();
  const c = bare(cookieDomain);
  const f = bare(filter);
  return c === f || c.endsWith(`.${f}`);
}

/** Apply the optional name/domain filters. Exported for the unit tests, which
 *  can then check the matching rule without standing up a browser. */
export function filterCookies(cookies: readonly BrowserCookie[], filter: { domain?: string; name?: string }): BrowserCookie[] {
  return cookies.filter((c) => {
    if (filter.name !== undefined && filter.name !== "" && c.name !== filter.name) return false;
    if (filter.domain !== undefined && filter.domain !== "" && !cookieDomainMatches(c.domain, filter.domain)) return false;
    return true;
  });
}

/**
 * Read the cookies of the target page, httpOnly ones included.
 *
 * This is the one read that a page script cannot do: document.cookie omits
 * every httpOnly cookie by design, which is precisely the set a session
 * credential lives in. Both drivers answer over the protocol's own cookie
 * store, so the flags come from the browser rather than being inferred.
 *
 * With `savePath` set the cookie array is written to that file as JSON and the
 * response carries only {path, bytes, count, target}: no value, no preview, no
 * truncation. Without it, the cookies are returned inline.
 */
export async function listCookies(
  driver: BrowserDriver,
  args: { target?: TargetSelector; domain?: string; name?: string; savePath?: string } = {},
): Promise<ListCookiesResult | ListCookiesSaveResult> {
  return withPage(driver, args.target, async (page) => {
    const all = await page.getCookies();
    const cookies = filterCookies(all, { domain: args.domain, name: args.name });
    if (!sinkRequested(args.savePath)) {
      return { cookies, count: cookies.length, target: target3(page.info) };
    }
    const { path, bytes } = await writeJsonSink(args.savePath, cookies);
    return { path, bytes, count: cookies.length, target: target3(page.info) };
  });
}

export interface SetCookieResult {
  set: true;
  target: { id: string; url: string; title: string };
}

export interface DeleteCookiesResult {
  deleted: true;
  target: { id: string; url: string; title: string };
}

/**
 * THE site constraint both write tools share: a cookie has to be attributed to
 * a site, and `url` or `domain` is how a caller says which.
 *
 * Checked here, above the drivers, so the refusal is ONE message on both
 * backends rather than a CDP protocol error on one and a Firefox no-op on the
 * other. It throws rather than defaulting to the current page's origin: a
 * guessed domain writes a real cookie somewhere the caller did not name, and a
 * cookie written to the wrong site is worse than a call that failed loudly.
 *
 * Exported for the unit tests, which pin the message without a browser.
 */
export function assertCookieSite(
  args: { url?: string; domain?: string },
  toolName: string,
): void {
  const hasUrl = args.url !== undefined && args.url !== "";
  const hasDomain = args.domain !== undefined && args.domain !== "";
  if (!hasUrl && !hasDomain) {
    throw new Error(`${toolName} requires either 'url' or 'domain': a cookie has to be attributed to a site, and neither was given.`);
  }
}

/** The shared 'name' check. A write tool with no name has nothing to write and
 *  a delete tool with no name would match every cookie, so an empty one is
 *  refused rather than treated as absent. */
function assertCookieName(name: string | undefined, toolName: string): asserts name is string {
  if (name === undefined || name === "") {
    throw new Error(`${toolName} requires a non-empty 'name'.`);
  }
}

/**
 * Write one cookie into the target page's cookie store.
 *
 * The response is deliberately tiny: `{set: true, target}`. It does NOT echo
 * the value back, because the value is frequently the credential and a caller
 * who just supplied it does not need it repeated into their transcript. The
 * `set: true` is earned rather than assumed: the CDP driver throws on Chrome's
 * `{success:false}` refusal and the BiDi driver throws when it cannot derive
 * the domain BiDi requires, so reaching this line means a backend confirmed
 * the write.
 */
export async function setCookie(
  driver: BrowserDriver,
  args: {
    target?: TargetSelector; name: string; value: string; url?: string; domain?: string;
    path?: string; expires?: number; httpOnly?: boolean; secure?: boolean;
    sameSite?: "strict" | "lax" | "none" | "default";
  },
): Promise<SetCookieResult> {
  assertCookieName(args.name, "set_cookie");
  if (typeof args.value !== "string") throw new Error("set_cookie requires a string 'value'.");
  assertCookieSite(args, "set_cookie");
  return withPage(driver, args.target, async (page) => {
    await page.setCookie({
      name: args.name,
      value: args.value,
      ...(args.url !== undefined ? { url: args.url } : {}),
      ...(args.domain !== undefined ? { domain: args.domain } : {}),
      ...(args.path !== undefined ? { path: args.path } : {}),
      ...(args.expires !== undefined ? { expires: args.expires } : {}),
      ...(args.httpOnly !== undefined ? { httpOnly: args.httpOnly } : {}),
      ...(args.secure !== undefined ? { secure: args.secure } : {}),
      ...(args.sameSite !== undefined ? { sameSite: args.sameSite } : {}),
    });
    return { set: true as const, target: target3(page.info) };
  });
}

/**
 * Remove the named cookie from the target page's cookie store.
 *
 * `{deleted: true, target}` and NO count, on purpose. Neither protocol reports
 * how many cookies it removed, so any number here would be invented; a caller
 * who needs one reads list_cookies before and after. `deleted: true` means the
 * backend accepted and performed the deletion, not that a matching cookie
 * existed: deleting an absent cookie is a success on both backends.
 */
export async function deleteCookies(
  driver: BrowserDriver,
  args: { target?: TargetSelector; name: string; url?: string; domain?: string; path?: string },
): Promise<DeleteCookiesResult> {
  assertCookieName(args.name, "delete_cookies");
  assertCookieSite(args, "delete_cookies");
  return withPage(driver, args.target, async (page) => {
    await page.deleteCookies({
      name: args.name,
      ...(args.url !== undefined ? { url: args.url } : {}),
      ...(args.domain !== undefined ? { domain: args.domain } : {}),
      ...(args.path !== undefined ? { path: args.path } : {}),
    });
    return { deleted: true as const, target: target3(page.info) };
  });
}

/* -------------------------------- snapshot (1) -------------------------------- */

/**
 * Legacy-faithful render, keyed by field name (see the file header's uid/extras note). The
 * "cdp" scheme strips its "cdp:" tag to reproduce the historical bare-backendDOMNodeId uid;
 * every other scheme keeps its tag (a tool must never guess at a foreign driver's uid grammar,
 * per driver.ts's THE UID CODEC block: this is a display choice made by the tool that already
 * knows its own driver's scheme, not a parse of a uid it didn't mint).
 */
const BARE_TOKEN_EXTRAS = new Set(["disabled", "focused"]);
const UNQUOTED_EXTRAS = new Set(["checked", "expanded", "url"]);

function renderSnapshotLine(n: SnapshotNode, scheme: string): string {
  const indent = "  ".repeat(n.depth);
  const uidText = scheme === "cdp" && n.uid.startsWith("cdp:") ? n.uid.slice(4) : n.uid;
  const name = n.name !== undefined ? ` ${JSON.stringify(n.name)}` : "";
  const extrasToks: string[] = [];
  if (n.extras) {
    for (const [k, v] of Object.entries(n.extras)) {
      if (BARE_TOKEN_EXTRAS.has(k)) extrasToks.push(k);
      else if (UNQUOTED_EXTRAS.has(k)) extrasToks.push(`${k}=${v}`);
      else extrasToks.push(`${k}=${JSON.stringify(v)}`);
    }
  }
  const extra = extrasToks.length ? ` [${extrasToks.join(" ")}]` : "";
  return `${indent}[${uidText}] ${n.role}${name}${extra}`;
}

export async function takeSnapshot(
  driver: BrowserDriver,
  args: { target?: TargetSelector; interactiveOnly?: boolean } = {},
): Promise<{ snapshot: string; target: { id: string; url: string; title: string }; nodeCount: number }> {
  return withPage(driver, args.target, async (page) => {
    const nodes = await page.snapshot({ interactiveOnly: args.interactiveOnly ?? false });
    const scheme = page.browser.scheme;
    return { snapshot: nodes.map((n) => renderSnapshotLine(n, scheme)).join("\n"), target: target3(page.info), nodeCount: nodes.length };
  });
}

/* ------------------------------ interaction (8) ------------------------------ */

export async function click(
  driver: BrowserDriver,
  args: { target?: TargetSelector; uid?: DriverUid; selector?: string; button?: "left" | "right" | "middle"; clickCount?: number },
): Promise<{ clicked: true; x: number; y: number }> {
  return withPage(driver, args.target, async (page) => {
    const { x, y } = await page.click(locatorOf(args), { button: args.button ?? "left", clickCount: args.clickCount ?? 1 });
    return { clicked: true, x, y };
  });
}

export async function hover(driver: BrowserDriver, args: { target?: TargetSelector; uid?: DriverUid; selector?: string }): Promise<{ hovered: true; x: number; y: number }> {
  return withPage(driver, args.target, async (page) => {
    const { x, y } = await page.hover(locatorOf(args));
    return { hovered: true, x, y };
  });
}

export async function drag(
  driver: BrowserDriver,
  args: { target?: TargetSelector; from: { uid?: DriverUid; selector?: string }; to: { uid?: DriverUid; selector?: string } },
): Promise<{ dragged: true; from: { x: number; y: number }; to: { x: number; y: number } }> {
  if (!args.from || !args.to) throw new SharedToolError("drag requires { from } and { to }");
  return withPage(driver, args.target, async (page) => {
    const { from, to } = await page.drag(locatorOf(args.from), locatorOf(args.to));
    return { dragged: true, from, to };
  });
}

export async function fill(driver: BrowserDriver, args: { target?: TargetSelector; uid?: DriverUid; selector?: string; value: string }): Promise<{ filled: true; value: string }> {
  if (typeof args.value !== "string") throw new SharedToolError("fill requires a string { value }");
  return withPage(driver, args.target, async (page) => {
    await page.setValue(locatorOf(args), args.value);
    return { filled: true, value: args.value };
  });
}

export async function fillForm(
  driver: BrowserDriver,
  args: { target?: TargetSelector; fields: Array<{ uid?: DriverUid; selector?: string; value: string }> },
): Promise<{ filled: number; fields: number }> {
  if (!Array.isArray(args.fields) || args.fields.length === 0) throw new SharedToolError("fill_form requires a non-empty { fields } array");
  return withPage(driver, args.target, async (page) => {
    let filled = 0;
    for (const f of args.fields) {
      if (typeof f.value !== "string") throw new SharedToolError("each fill_form field requires a string value");
      await page.setValue(locatorOf(f), f.value);
      filled++;
    }
    return { filled, fields: args.fields.length };
  });
}

export async function typeText(driver: BrowserDriver, args: { target?: TargetSelector; uid?: DriverUid; selector?: string; text: string }): Promise<{ typed: true; text: string }> {
  if (typeof args.text !== "string") throw new SharedToolError("type_text requires a string { text }");
  return withPage(driver, args.target, async (page) => {
    await page.typeText(locatorOf(args), args.text);
    return { typed: true, text: args.text };
  });
}

export async function pressKey(driver: BrowserDriver, args: { target?: TargetSelector; key: string; modifiers?: string[] }): Promise<{ pressed: string; modifiers: string[] }> {
  if (typeof args.key !== "string" || !args.key.length) throw new SharedToolError("press_key requires a non-empty { key }");
  const modifiers = args.modifiers ?? [];
  return withPage(driver, args.target, async (page) => {
    await page.pressKey({ key: args.key, modifiers });
    return { pressed: args.key, modifiers };
  });
}

export async function uploadFile(driver: BrowserDriver, args: { target?: TargetSelector; uid?: DriverUid; selector?: string; files: string | string[] }): Promise<{ uploaded: string[] }> {
  const files = Array.isArray(args.files) ? args.files : [args.files];
  if (!files.length || files.some((f) => typeof f !== "string" || !f.length)) {
    throw new SharedToolError("upload_file requires { files } as a non-empty path or array of paths");
  }
  return withPage(driver, args.target, async (page) => {
    await page.setFiles(locatorOf(args), files);
    return { uploaded: files };
  });
}

/* -------------------------- screenshot + emulation (3) -------------------------- */

function stamp(): string {
  return new Date(Date.now()).toISOString().replace(/[:.]/g, "-");
}

export async function takeScreenshot(
  driver: BrowserDriver,
  args: {
    target?: TargetSelector; format?: "png" | "jpeg"; quality?: number; fullPage?: boolean;
    uid?: DriverUid; selector?: string; savePath?: string; returnBase64?: boolean;
  } = {},
): Promise<{ path: string; bytes: number; format: "png" | "jpeg"; target: { id: string; url: string; title: string }; base64?: string }> {
  if ((args.uid !== undefined && args.uid !== "") && args.selector) throw new SharedToolError("provide exactly one of uid or selector, not both");
  const format = args.format ?? "png";
  return withPage(driver, args.target, async (page) => {
    const clip = args.uid !== undefined || args.selector ? locatorOf(args) : undefined;
    const { data, format: outFormat } = await page.screenshot({ format, quality: args.quality, fullPage: args.fullPage, ...(clip ? { clip } : {}) });
    if (data.byteLength === 0) throw new SharedToolError("captureScreenshot returned empty data");
    await mkdir(ARTIFACT_DIR, { recursive: true });
    const ext = outFormat === "jpeg" ? "jpg" : "png";
    const path = args.savePath ?? join(ARTIFACT_DIR, `screenshot-${page.info.id.slice(0, 8)}-${stamp()}.${ext}`);
    await writeFile(path, Buffer.from(data));
    const result: { path: string; bytes: number; format: "png" | "jpeg"; target: { id: string; url: string; title: string }; base64?: string } = {
      path, bytes: data.byteLength, format: outFormat, target: target3(page.info),
    };
    if (args.returnBase64) result.base64 = Buffer.from(data).toString("base64");
    return result;
  });
}

export async function emulate(
  driver: BrowserDriver,
  args: {
    target?: TargetSelector; width?: number; height?: number; deviceScaleFactor?: number; mobile?: boolean;
    userAgent?: string; cpuThrottlingRate?: number; media?: string; mediaFeatures?: Array<{ name: string; value: string }>;
    networkConditions?: { offline?: boolean; latency?: number; downloadThroughput?: number; uploadThroughput?: number; connectionType?: string };
    clearOverrides?: boolean;
  } = {},
): Promise<{ target: { id: string; url: string; title: string }; applied: string[]; cleared?: boolean }> {
  return withPage(driver, args.target, async (page) => {
    if (args.clearOverrides) {
      await page.emulate({ clearOverrides: true });
      return { target: target3(page.info), applied: [], cleared: true };
    }
    const { applied } = await page.emulate(args);
    if (applied.length === 0) throw new SharedToolError("emulate: no overrides specified (pass clearOverrides:true to reset)");
    return { target: target3(page.info), applied };
  });
}

export async function resizePage(
  driver: BrowserDriver,
  args: { target?: TargetSelector; width: number; height: number; deviceScaleFactor?: number; mobile?: boolean },
): Promise<{ target: { id: string; url: string; title: string }; width: number; height: number; innerWidth: number; innerHeight: number }> {
  if (!Number.isFinite(args.width) || !Number.isFinite(args.height) || args.width <= 0 || args.height <= 0) {
    throw new SharedToolError("resize_page requires positive numeric width and height");
  }
  return withPage(driver, args.target, async (page) => {
    await page.emulate({ width: args.width, height: args.height, deviceScaleFactor: args.deviceScaleFactor, mobile: args.mobile });
    const v = (await page.evaluate("({ w: window.innerWidth, h: window.innerHeight })")) as { w?: number; h?: number } | undefined;
    return { target: target3(page.info), width: args.width, height: args.height, innerWidth: v?.w ?? args.width, innerHeight: v?.h ?? args.height };
  });
}

/* ---------------------------------- dialogs (1) ---------------------------------- */

export async function handleDialog(
  driver: BrowserDriver,
  args: { target?: TargetSelector; accept: boolean; promptText?: string; timeoutMs?: number; autoMs?: number },
): Promise<unknown> {
  if (args.accept === undefined) throw new SharedToolError("handle_dialog requires { accept }");
  return withPage(driver, args.target, (page) => page.handleDialog(args.accept, args.promptText, { timeoutMs: args.timeoutMs, autoMs: args.autoMs }));
}

/* ------------------------------------- registry ------------------------------------- */

/** The 23 tools this file unifies, importable by both src/index.ts (Chrome) and
 *  src/firefox-tools.ts (Firefox). Each function is (driver, args) => Promise<result>. */
export const SHARED_TOOLS = {
  list_pages: listPages,
  new_page: newPage,
  close_page: closePage,
  select_page: selectPage,
  navigate_page: navigatePage,
  wait_for: waitForText,
  evaluate_script: evaluateScript,
  list_cookies: listCookies,
  set_cookie: setCookie,
  delete_cookies: deleteCookies,
  take_snapshot: takeSnapshot,
  click,
  hover,
  drag,
  fill,
  fill_form: fillForm,
  type_text: typeText,
  press_key: pressKey,
  upload_file: uploadFile,
  take_screenshot: takeScreenshot,
  emulate,
  resize_page: resizePage,
  handle_dialog: handleDialog,
} satisfies Record<string, (driver: BrowserDriver, args: never) => Promise<unknown>>;
