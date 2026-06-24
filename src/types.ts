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
