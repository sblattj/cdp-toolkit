/**
 * Shared types for the raw-CDP toolkit.
 *
 * The toolkit speaks the Chrome DevTools Protocol directly over the
 * remote-debugging WebSocket (default ws://127.0.0.1:9222), with no Puppeteer
 * / chrome-devtools-mcp layer in between. See CONTRACT.md for the design rules
 * every tool module follows.
 */

/** A CDP target as returned by GET /json/list. */
export interface Target {
  id: string;
  type: "page" | "background_page" | "service_worker" | "shared_worker" | "browser" | "other" | string;
  title: string;
  url: string;
  webSocketDebuggerUrl: string;
  /** present on some Chromium builds */
  parentId?: string;
  faviconUrl?: string;
}

/** Raw CDP response envelope. */
export interface CdpResponse<T = unknown> {
  id: number;
  result?: T;
  error?: { code: number; message: string; data?: unknown };
}

/** Raw CDP event envelope. */
export interface CdpEvent<P = Record<string, unknown>> {
  method: string;
  params: P;
  /** flat-session id when attached via Target.attachToTarget(flatten:true) */
  sessionId?: string;
}

/**
 * Target selector grammar accepted by resolveTarget():
 *   - undefined / "active"   -> first page-type target
 *   - "<32-hex targetId>"    -> exact target by id
 *   - "index:N"              -> Nth page-type target (0-based)
 *   - "url:<substring>"      -> first page whose url contains substring
 *   - "title:<substring>"    -> first page whose title contains substring
 *   - "label:<name>"         -> the page-type target whose label EXACTLY
 *     matches `name`, checked against both the origin ledger (agent-created
 *     tabs, see src/origins.ts) and live lease records (covers a taken-over
 *     tab claimed with a label, which has no origin record — see
 *     src/leases-tools.ts's claimPage). The resolved id must be present in
 *     the listing this call is resolving against; a label whose tab is gone
 *     falls through to the normal no-match error. A miss enumerates the
 *     labels that DO exist; two live targets sharing a label is an ambiguity
 *     error naming both ids, never a silent first-match. See pickPage in
 *     src/shared-tools.ts.
 *   - "worker:<substring>"    -> a service_worker/shared_worker target whose
 *     URL contains the substring (an MV3 extension's background worker is
 *     `chrome-extension://<id>/<script>`, so both the extension id and the
 *     script name match). NOT UNIVERSAL, unlike every arm above it: resolved
 *     only by Chrome's pickTarget (client.ts's resolveTarget), accepted by the
 *     four tools in WORKER_CAPABLE_TOOLS (evaluate_script, which evaluates in a
 *     worker, plus list_network_requests / get_network_request /
 *     list_console_messages, which record one), refused with a capability error
 *     on Firefox and by the page-only resolvers. It reads the UNFILTERED target
 *     listing, because a worker is not a page target — and a worker that is
 *     idle-evicted is in no listing at all, which is what `wake` exists for.
 *     See src/workers.ts and src/cdp/workers.ts.
 */
export type TargetSelector = string | undefined;

/**
 * The canonical element-reference scheme shared across take_snapshot and every
 * interaction tool (click/hover/fill/...). A `uid` IS a CDP backendDOMNodeId
 * (a number, stable while the node exists in the live DOM). This makes refs
 * stateless: take_snapshot emits them, interaction tools resolve them via
 * DOM.resolveNode({ backendNodeId: uid }). No server-side ref table is kept.
 */
export type Uid = number;

export interface ToolResult<T = unknown> {
  ok: boolean;
  tool: string;
  data?: T;
  error?: string;
  /** terminal-state evidence: artifact paths, observed values, etc. */
  evidence?: Record<string, unknown>;
}
