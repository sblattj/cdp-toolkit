/**
 * ADR-001: one browser-neutral Driver interface behind the 33 tools.
 *
 * Context. Every tool in src/tools/ is a stateless one-shot on withPage():
 * open a socket, act, always close. That is only correct because a CDP `Uid`
 * IS a backendDOMNodeId, a browser-global integer outliving the connection
 * that made it, so take_snapshot in one process and click(uid) in the next
 * interoperate. BiDi breaks both halves: a session is bound to ONE WebSocket
 * (re-dialing gets `invalid session id`) and a `sharedId` is document-scoped,
 * dying on any navigation with `no such node`. A literal port would break
 * snapshot-then-click, the tool's core workflow.
 *
 * Decision.
 *  1. `Uid` becomes an OPAQUE TAGGED STRING, `<scheme>:<payload>`. Tools never
 *     parse, build, or order uids; only the driver whose scheme tags a uid may
 *     resolve it. Byte-level codec: THE UID CODEC block below.
 *  2. The CDP driver keeps its handle: `cdp:<backendDOMNodeId>`, and still
 *     accepts bare digits, so old snapshots and the MCP schema keep working.
 *  3. The BiDi driver does NOT encode a `sharedId`. It STAMPS the page:
 *     snapshot writes `data-cdp-uid="<stamp>"` onto every emitted node and the
 *     uid is `bidi:<stamp>`, resolved by a locateNodes css lookup. Page state,
 *     not protocol state, so it survives a dropped socket, a fresh session,
 *     and a fresh CLI process, which is what the one-shot tools depend on.
 *  4. Connection lifetime is declared, not implied: `lifetime` is "per-call"
 *     (CDP, release() closes) or "session" (BiDi, release() is a refcount
 *     decrement and the socket lives until dispose()). Tools call withDriver()
 *     and stay ignorant of which they got.
 *  5. Anything on exactly one browser stays OUT of the interface and is named
 *     in `Capability`. tools/list filters on REQUIRED_CAPABILITIES, so
 *     tracing, heap, lighthouse, and CPU throttling are simply absent under
 *     Firefox rather than present and throwing.
 *
 * Rejected alternatives.
 *  A. `Uid = number` indexing a driver-side handle table. The table dies with
 *     the process, so the CLI (one process per call) could never resolve a uid
 *     it printed last call: works under MCP, fails under CLI, the worst split.
 *  B. Encode the `sharedId` (`bidi:<ctx>:<sharedId>`). It is meaningless
 *     outside the session that minted it and dies on every navigation. Both
 *     verified against Firefox 153.0.3.
 *  C. A long-lived module-scoped BiDi session as the WHOLE answer, no stamps.
 *     Insufficient, not wrong: it fixes the socket, and recorder.ts /
 *     network_mock.ts already prove the pattern, but navigation still voids
 *     every sharedId and the CLI gets a new session per process. Adopted as
 *     the transport (4) with stamps on top (3). Combination, not either/or.
 *  D. A computed unique css path instead of stamping, to avoid touching the
 *     DOM. Any sibling insertion silently resolves it to the WRONG node, while
 *     a stamp resolves to the right node or none. Loud miss over quiet mis-hit.
 *  E. One flat interface with `throw new Error("unsupported")` bodies under
 *     Firefox. Moves discovery from tools/list to runtime and makes an honest
 *     asymmetry look like a bug.
 *
 * Consequences. Stamping mutates the page (one attribute per snapshotted
 * node), and a node the page re-renders from scratch loses its stamp, so uids
 * expire on re-render rather than on navigation. Both are stated in
 * `uidStability`. Do not "simplify" Uid back to a number: that is A, and it
 * breaks the CLI.
 */

import type { ToolName } from "./index.ts";
import type { TargetSelector } from "./types.ts";

/* ---------------------------------- uids ---------------------------------- */

/**
 * An opaque element reference. NEVER parse, construct, or compare a DriverUid
 * except by string equality. It is produced by Driver.snapshot / Driver.locate
 * and consumed by Driver.resolve.
 */
export type DriverUid = string;

/* THE UID CODEC, binding on every driver. Two implementers reading only this
 * block must produce interoperable encodings.
 *
 * GRAMMAR. `uid := scheme ":" payload`, split on the FIRST colon only.
 * scheme matches /^[a-z][a-z0-9]{0,7}$/ and equals the driver's `scheme`
 * field; payload is 1..503 chars, no control chars, MAY contain ":"; total
 * length <= 512. A driver MUST reject a uid whose scheme is not its own with
 * code "foreign-uid" and MUST NOT guess at another driver's scheme.
 *
 * SCHEME "cdp". payload := decimal backendDOMNodeId, no sign, no leading
 * zeros, no whitespace. Encode `cdp:${backendNodeId}`; decode Number(payload),
 * which must be a positive safe integer. LEGACY: a uid matching
 * LEGACY_NUMERIC_UID with no scheme prefix MUST be accepted by the cdp driver
 * as `cdp:<digits>`, and by no other driver.
 *
 * SCHEME "bidi". payload := exactly 12 lowercase hex chars, /^[0-9a-f]{12}$/,
 * from a cryptographically-uniform source, never reused within a document.
 * The driver writes it into the live DOM as UID_STAMP_ATTR on the referenced
 * element in the SAME call that mints the uid. Resolution is
 * browsingContext.locateNodes `{type:"css", value:'[data-cdp-uid="<payload>"]'}`
 * in the uid's context. Zero matches MUST raise "stale-uid". More than one
 * match MUST take the first node in document order and MUST NOT throw, since
 * cloning a stamped subtree is legal page behavior.
 */

/** Attribute the bidi scheme stamps onto elements. Never change this string. */
export const UID_STAMP_ATTR = "data-cdp-uid" as const;

/** Matches the legacy bare-integer uid that the cdp driver must still accept. */
export const LEGACY_NUMERIC_UID = /^[0-9]+$/;

/** True when `u` carries `scheme` as its tag (or is a legacy bare integer for cdp). */
export function uidHasScheme(u: DriverUid, scheme: string): boolean {
  return u.startsWith(`${scheme}:`) || (scheme === "cdp" && LEGACY_NUMERIC_UID.test(u));
}

/**
 * How long a uid stays resolvable. Declared per driver so a caller can decide
 * when to re-snapshot instead of learning it from a failure.
 *  - "browser-node": valid until the underlying DOM node is destroyed, across
 *    connections and processes (cdp).
 *  - "document-stamp": valid until the document unloads OR the node is
 *    re-created by the page, across connections and processes (bidi).
 */
export type UidStability = "browser-node" | "document-stamp";

/* ------------------------------- capabilities ------------------------------- */

/**
 * Capabilities that are NOT universal. Anything a driver can always do has no
 * token here. A driver declares the subset it supports; tools/list filters on
 * REQUIRED_CAPABILITIES so an unsupported tool is absent, never present and
 * throwing.
 */
export type Capability =
  | "trace.performance" // Chrome tracing, behind every performance_* tool
  | "heap.snapshot" // V8 heap snapshots
  | "audit.lighthouse" // shelling out to lighthouse against a debug port
  | "emulate.cpuThrottling" // CPU multiplier; absent from BiDi's emulation module
  | "emulate.mediaFeatures" // media type + features, e.g. prefers-color-scheme
  | "emulate.deviceMetrics" // past width/height: scale factor, mobile flag
  | "emulate.networkConditions" // throttled or offline conditions
  | "screenshot.fullPage" // one-shot full scrollable page, not just the viewport
  | "screenshot.element" // capture clipped to a single element
  | "network.intercept" // fulfill, fail, or continue a matched request
  | "network.responseBodyPostHoc" // read a body for a request not armed in advance
  | "snapshot.accessibilityTree" // native a11y dump, not a DOM-walk approximation
  | "input.insertTextAtomic" // atomic value commit, not synthesized keystrokes
  | "locate.text" // find a node by visible text substring
  | "locate.xpath"; // find a node by xpath

/**
 * Tools whose availability depends on a capability. A tool absent from this
 * map is universal and must be listed by every driver. Keyed by ToolName so
 * the compiler catches a renamed tool.
 */
export const REQUIRED_CAPABILITIES: Partial<Record<ToolName, readonly Capability[]>> = {
  performance_start_trace: ["trace.performance"],
  performance_stop_trace: ["trace.performance"],
  performance_analyze_insight: ["trace.performance"],
  performance_trace: ["trace.performance"],
  take_heapsnapshot: ["heap.snapshot"],
  lighthouse_audit: ["audit.lighthouse"],
  mock_request: ["network.intercept"],
  list_mocks: ["network.intercept"],
  clear_mocks: ["network.intercept"],
} as const;

/* --------------------------------- errors --------------------------------- */

/** Machine-readable failure kinds every driver maps its protocol errors onto. */
export type DriverErrorCode =
  | "foreign-uid" // the uid's scheme belongs to another driver
  | "stale-uid" // ours, but no longer resolves: node gone or document unloaded
  | "no-such-element" // a locator matched nothing
  | "no-such-target" // no page/context matched the TargetSelector
  | "unsupported" // operation not supported; check Capability first
  | "timeout" // the per-command deadline elapsed
  | "disconnected" // socket closed, session ended, or browser exited
  | "page-error"; // page-side exception: evaluate threw, navigation rejected

export interface DriverError extends Error {
  readonly code: DriverErrorCode;
  readonly data?: unknown;
}

export function isDriverError(e: unknown): e is DriverError {
  return e instanceof Error && typeof (e as { code?: unknown }).code === "string";
}

/* ------------------------------ neutral shapes ------------------------------ */

/** A page/tab, neutral over CDP targets and BiDi browsing contexts. */
export interface PageInfo {
  id: string;
  url: string;
  title: string;
  /** CDP target type ("page", "iframe", "worker", ...), when the driver has one. Additive: BiDi leaves it unset. */
  type?: string;
}

/** How a caller points at an element. Exactly one field is set. */
export type ElementLocator =
  | { uid: DriverUid }
  | { css: string }
  | { xpath: string } // requires Capability "locate.xpath"
  | { text: string }; // requires Capability "locate.text"

/** One line of the snapshot tree, before it is rendered to text. */
export interface SnapshotNode {
  uid: DriverUid;
  role: string;
  name?: string;
  depth: number;
  /** value / checked / expanded / disabled / url / focused, already stringified. */
  extras?: Record<string, string>;
}

export interface NavigateOptions {
  url?: string;
  reload?: boolean;
  ignoreCache?: boolean;
  waitUntil?: "load" | "domcontentloaded";
  timeoutMs?: number;
}

export interface NavigateResult {
  url: string;
  /** CDP frameId or BiDi context id. Opaque. */
  contextId: string;
  reloaded?: boolean;
  waitedFor: "load" | "domcontentloaded" | "committed" | "timeout";
}

export interface MouseButtonOptions {
  button?: "left" | "right" | "middle";
  clickCount?: number;
}

export interface KeyPress {
  /** "Enter", "Tab", "ArrowDown", or a single printable character. */
  key: string;
  /** "Control" | "Shift" | "Alt" | "Meta", case-insensitive. */
  modifiers?: readonly string[];
}

export interface ScreenshotOptions {
  format?: "png" | "jpeg";
  quality?: number;
  fullPage?: boolean; // requires "screenshot.fullPage"
  clip?: ElementLocator; // requires "screenshot.element"
}

/** Each optional field names the Capability it requires, if any. */
export interface EmulationOptions {
  width?: number;
  height?: number;
  deviceScaleFactor?: number; // "emulate.deviceMetrics"
  mobile?: boolean; // "emulate.deviceMetrics"
  userAgent?: string;
  cpuThrottlingRate?: number; // "emulate.cpuThrottling"
  media?: string; // "emulate.mediaFeatures"
  mediaFeatures?: ReadonlyArray<{ name: string; value: string }>; // "emulate.mediaFeatures"
  /** Requires "emulate.networkConditions". connectionType is additive: CDP's optional
   *  Network.ConnectionType hint ("wifi", "cellular4g", ...); drivers without a matching
   *  concept simply ignore it. */
  networkConditions?: { offline?: boolean; latency?: number; downloadThroughput?: number; uploadThroughput?: number; connectionType?: string };
  clearOverrides?: boolean;
}

/** Neutral event names. Payload shapes are the driver's normalized records. */
export type DriverEvent =
  | "navigated"
  | "console"
  | "network.request"
  | "network.response"
  | "dialog"
  | "page.closed";

export interface DialogInfo {
  type: string;
  message: string;
  url: string;
  defaultPrompt?: string;
}

/** One dialog the driver answered, echoing back how it was answered. */
export interface HandledDialogInfo extends DialogInfo {
  accept: boolean;
  promptText?: string;
  handled: true;
}

export interface InterceptRule {
  /** Glob: `*` any run, `?` one char. Both drivers normalize to this. */
  urlPattern: string;
  method?: string;
  action: "fulfill" | "fail" | "continue";
  status?: number;
  body?: string;
  contentType?: string;
  headers?: Record<string, string>;
  errorReason?: string;
  delayMs?: number;
  failRate?: number;
}

/* --------------------------------- drivers --------------------------------- */

/**
 * Connection ownership, declared rather than discovered.
 *  - "per-call": acquiring opens a transport and release() closes it. Nothing
 *    survives between tool calls. This is CDP today.
 *  - "session": the transport carries a session that CANNOT be re-dialed, so
 *    release() only decrements a refcount and the transport lives until
 *    dispose(). This is BiDi. A "session" driver MUST be memoized at module
 *    scope (see recorder.ts / network_mock.ts for the existing pattern) and
 *    MUST tolerate concurrent holders. It does NOT transparently re-establish
 *    itself if the transport dies: a BiDi session cannot be resumed on a
 *    second socket (re-dialing gets `invalid session id`), so a dead
 *    transport surfaces as an error on every subsequent call instead, and a
 *    caller that hits one must dispose() and acquire a fresh driver.
 * Tools MUST NOT branch on this value. It exists so that withDriver's contract
 * is unambiguous and so a reader knows why release() is not a close().
 */
export type LifetimeModel = "per-call" | "session";

/** Browser-scoped operations. One per browser process. */
export interface BrowserDriver {
  /** Uid scheme tag owned by this driver, e.g. "cdp" or "bidi". */
  readonly scheme: string;
  readonly lifetime: LifetimeModel;
  readonly capabilities: ReadonlySet<Capability>;
  readonly uidStability: UidStability;
  /** "accessibility-tree" when snapshots come from a native a11y dump. */
  readonly snapshotFidelity: "accessibility-tree" | "dom-heuristic";

  /** opts.all: include non-page targets (workers, iframes, ...) when the driver has that concept. */
  listPages(opts?: { all?: boolean }): Promise<PageInfo[]>;
  newPage(url?: string): Promise<PageInfo>;
  /** success mirrors the underlying protocol's own success signal when it has one (CDP's
   *  Target.closeTarget); a driver without such a signal reports true once close resolves. */
  closePage(id: string): Promise<{ success: boolean }>;
  /** Bring a page to the front. Also writes the selected-page state file. */
  activatePage(id: string): Promise<PageInfo>;

  /** Acquire a page handle. The caller MUST release() it. Prefer withDriver. */
  page(selector: TargetSelector): Promise<PageDriver>;

  /** Tear down the transport: process exit (CLI) or shutdown (MCP server).
   *  Idempotent. MUST NOT be called by a tool. */
  dispose(): Promise<void>;
}

/** Page-scoped operations. Every tool in src/tools/ maps onto this surface. */
export interface PageDriver {
  readonly info: PageInfo;
  readonly browser: BrowserDriver;

  /* navigation */
  navigate(opts: NavigateOptions): Promise<NavigateResult>;
  /** Poll until `text` appears in the rendered body, or reject with "timeout". */
  waitForText(text: string, timeoutMs?: number, pollMs?: number): Promise<{ found: true; elapsedMs: number }>;

  /* script */
  /** Evaluate an expression, or call it as a function when `args` is given. */
  evaluate(expression: string, opts?: { args?: readonly unknown[]; awaitPromise?: boolean }): Promise<unknown>;
  /** Call a function literal with an element as `this`, returning by value. */
  callOnElement(loc: ElementLocator, functionDeclaration: string, args?: readonly unknown[]): Promise<unknown>;

  /* elements */
  /** Emit the snapshot tree. Mints (and, under "bidi", stamps) every uid. */
  snapshot(opts?: { interactiveOnly?: boolean }): Promise<SnapshotNode[]>;
  /** Mint a uid for the first node matching a non-uid locator. */
  locate(loc: ElementLocator): Promise<DriverUid>;
  /** Assert a uid still resolves. Rejects "stale-uid" / "foreign-uid". */
  resolve(uid: DriverUid): Promise<void>;

  /* input */
  click(loc: ElementLocator, opts?: MouseButtonOptions): Promise<{ x: number; y: number }>;
  hover(loc: ElementLocator): Promise<{ x: number; y: number }>;
  drag(from: ElementLocator, to: ElementLocator): Promise<{ from: { x: number; y: number }; to: { x: number; y: number } }>;
  /** Overwrite an element's value. One atomic commit under
   *  "input.insertTextAtomic", else synthesized keystrokes, so per-key handlers
   *  on the page WILL fire. Callers must not depend on either behavior. */
  setValue(loc: ElementLocator, value: string): Promise<void>;
  /** Append text at the focus point without clearing first. */
  typeText(loc: ElementLocator, text: string): Promise<void>;
  pressKey(press: KeyPress): Promise<void>;
  /** Attach absolute file paths to a file input. */
  setFiles(loc: ElementLocator, files: readonly string[]): Promise<void>;

  /* rendering */
  /** Returns raw image bytes. Artifact naming and writing stay in the tool. */
  screenshot(opts?: ScreenshotOptions): Promise<{ data: Uint8Array; format: "png" | "jpeg" }>;
  /** Apply overrides. Returns the field names actually applied. */
  emulate(opts: EmulationOptions): Promise<{ applied: string[] }>;

  /* events */
  /** Subscribe to a neutral event. Returns an unsubscribe fn. */
  on(event: DriverEvent, handler: (payload: Record<string, unknown>) => void): () => void;
  /** Resolve on the first matching event, or reject with "timeout". */
  waitForEvent(event: DriverEvent, predicate?: (p: Record<string, unknown>) => boolean, timeoutMs?: number): Promise<Record<string, unknown>>;

  /* dialogs */
  /** Answer the next user prompt. Combine with waitForEvent("dialog") to arm first.
   *  opts.timeoutMs: how long to wait for a dialog to open (default 15000).
   *  opts.autoMs: instead of waiting for exactly one dialog, answer every dialog that
   *  opens during this window (ms) and resolve with the list, never throwing on none. */
  handleDialog(
    accept: boolean,
    promptText?: string,
    opts?: { timeoutMs?: number; autoMs?: number },
  ): Promise<HandledDialogInfo | { handled: HandledDialogInfo[]; count: number }>;

  /* network */
  /** Begin retaining response bodies. REQUIRED before getResponseBody unless
   *  the driver declares "network.responseBodyPostHoc". Returns a stop fn. */
  startBodyCapture(): Promise<() => Promise<void>>;
  getResponseBody(requestId: string): Promise<{ body: string; base64Encoded: boolean }>;
  /** Requires "network.intercept". Returns a fn that removes the rule. */
  intercept(rules: readonly InterceptRule[]): Promise<() => Promise<void>>;

  /** Give up this handle: closes the transport under "per-call", decrements a
   *  refcount under "session". Idempotent. Never assume it ends the session. */
  release(): Promise<void>;
}

/** The neutral replacement for withPage(): acquire, run, always release. The
 *  ONLY acquisition path a tool should use, correct under both LifetimeModels. */
export type WithDriver = <T>(selector: TargetSelector, fn: (page: PageDriver) => Promise<T>) => Promise<T>;

/** Names a driver can be selected by, e.g. via a CDP_BROWSER env var. */
export type DriverKind = "chrome" | "firefox";
