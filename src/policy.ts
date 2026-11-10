/**
 * Read-only endpoint policy (#15): which tools may run against an endpoint marked read-only.
 *
 * The rule: a READ tool sends no CDP command that changes page or browser state. Every tool in
 * the registry (`TOOLS`, src/index.ts) is in exactly one of READ_TOOLS / MUTATING_TOOLS, and the
 * dispatch-only meta tools of src/mcp.ts (search_tools, call_tool, describe_tool) are META: the
 * inner tool of a call_tool is checked when it re-enters dispatch. test/policy.test.ts fails when
 * a tool is added to the registry without being classified here.
 *
 * Default-deny: a name in none of the sets is treated as MUTATING.
 *
 * DECISION (user): evaluate_script is READ. The agent is responsible for what it runs.
 *
 * Classification is by tool name. A few READ tools have arguments that escalate them to a state
 * change (see `escalatesToMutation`); the optional `args` parameter of `assertAllowed` covers those.
 */

/** Tools that change no page or browser state (see the borderline notes inline). */
export const READ_TOOLS: ReadonlySet<string> = new Set([
  // borderline: GET /json/list, plus a local lease/ledger read. `probe` only does a Runtime.evaluate
  // (renderer ping + beacon read). CAVEAT for the dispatcher: under strict-lease mode listPages first
  // reaps stale agent tabs (Target.closeTarget, src/shared-tools.ts listPages); skip the reap on a
  // read-only endpoint.
  "list_pages",
  // borderline: polls Runtime.evaluate for text; changes nothing.
  "wait_for",
  // borderline: arbitrary JS. READ by the user's decision, not by the nature of the tool.
  "evaluate_script",
  // Network.getCookies only. (set_cookie / delete_cookies are MUTATING.)
  "list_cookies",
  // borderline: Accessibility.enable + getFullAXTree; enabling a domain is not a page change.
  "take_snapshot",
  // borderline: Page.getLayoutMetrics + Page.captureScreenshot. With `uid`/`selector` it calls
  // DOM.scrollIntoViewIfNeeded (a scroll); with renderWidth/renderHeight it applies and restores an
  // Emulation.setDeviceMetricsOverride. The latter is escalated in `escalatesToMutation`.
  "take_screenshot",
  // borderline: default reads a buffer a prior recorder wrote. `reload:true` runs Page.reload
  // (escalated in `escalatesToMutation`).
  "list_console_messages",
  "get_console_message",
  "list_network_requests",
  // borderline: metadata read, but `includeBody` with `url` drives a reload capture (escalated).
  "get_network_request",
  // borderline: reads a local trace JSON file; sends no CDP command at all.
  "performance_analyze_insight",
  // borderline: HeapProfiler.enable + takeHeapSnapshot. Forces a GC and can stall the page for a
  // moment, but changes no state.
  "take_heapsnapshot",
  // borderline: lists local fake-backend sessions; its only CDP command is a Runtime.evaluate("1") liveness ping.
  "list_mocks",
  // borderline: a Runtime.evaluate that cleans the page HTML, then POSTs it to an LLM endpoint.
  // Nothing is written to the page. Data leaves the machine; that is not a page-state change.
  "extract_page",
  // borderline: reads the local lease store and /json/list. Same strict-mode reap caveat as list_pages.
  "list_leases",
]);

/** Tools that send a CDP command that changes page or browser state, or change lease state. */
export const MUTATING_TOOLS: ReadonlySet<string> = new Set([
  // pages
  "new_page", // Target.createTarget
  "close_page", // Target.closeTarget
  // borderline: Target.activateTarget raises the tab and steals window focus. A state change.
  "select_page",
  "navigate_page", // Page.navigate / reload / history
  "set_cookie",
  "delete_cookies",
  // interaction
  "click",
  "hover", // borderline: Input.dispatchMouseEvent mouseMoved fires hover handlers and can open menus
  "drag",
  "scroll", // borderline: wheel event moves the scroll offset and can trigger lazy loading
  "fill",
  "fill_form",
  "type_text",
  "press_key",
  "upload_file",
  // emulation
  "emulate",
  "resize_page",
  "handle_dialog",
  // performance
  // borderline: Tracing.start begins a browser-wide trace session, and the one-shot variant also reloads.
  "performance_start_trace",
  "performance_stop_trace",
  "performance_trace",
  // recorder: Page.startScreencast / bringToFront, plus ffmpeg and files
  "start_screen_recording",
  "stop_screen_recording",
  // borderline: attaches Lighthouse, which navigates, reloads and throttles the page
  "lighthouse_audit",
  // Fetch.enable: intercepts and rewrites the page's traffic
  "mock_request",
  "clear_mocks",
  "dispatch_mouse",
  "focus_emulation", // Emulation.setFocusEmulationEnabled
  "click_focus_gated",
  "wait_for_download", // borderline: Browser.setDownloadBehavior changes browser state
  "grant_permissions", // Browser.grantPermissions
  // leases: claim installs an activity beacon in the page and writes a lease; release can close a tab
  "claim_page",
  "release_page",
]);

/** Dispatch-only tools of src/mcp.ts (not in TOOLS). The inner tool is checked on re-entry. */
export const META_TOOLS: ReadonlySet<string> = new Set(["search_tools", "call_tool", "describe_tool"]);

export class PolicyError extends Error {
  readonly code = "read_only_endpoint";
  readonly tool: string;
  readonly endpoint: string;
  constructor(tool: string, endpoint: string) {
    super(`'${tool}' is not allowed on endpoint '${endpoint}': the endpoint is read-only (tools that change state are refused before any CDP message is sent)`);
    this.name = "PolicyError";
    this.tool = tool;
    this.endpoint = endpoint;
  }
}

/** True when the tool is a known READ tool. Unknown names are false (default-deny). */
export function isReadTool(name: string): boolean {
  return READ_TOOLS.has(name);
}

/**
 * Argument combinations that turn a READ tool into a state change. Returns true when the call
 * must be refused on a read-only endpoint even though the tool name is READ.
 */
export function escalatesToMutation(tool: string, args: unknown): boolean {
  if (typeof args !== "object" || args === null) return false;
  const a = args as Record<string, unknown>;
  switch (tool) {
    case "list_console_messages":
    case "list_network_requests":
      return a.reload === true;
    case "get_network_request":
      return a.includeBody === true && typeof a.url === "string" && a.url !== "";
    case "take_screenshot":
      return a.renderWidth !== undefined || a.renderHeight !== undefined;
    default:
      return false;
  }
}

/**
 * Throw PolicyError when the endpoint is read-only and `tool` may change state. Unknown names are
 * treated as MUTATING. Pass the call's `args` to also refuse the escalating combinations above.
 */
export function assertAllowed(
  tool: string,
  endpoint: { name: string; readOnly: boolean },
  args?: unknown,
): void {
  if (!endpoint.readOnly) return;
  if (META_TOOLS.has(tool)) return;
  if (!READ_TOOLS.has(tool)) throw new PolicyError(tool, endpoint.name);
  if (escalatesToMutation(tool, args)) throw new PolicyError(tool, endpoint.name);
}

/** MCP tools/list annotation: `readOnlyHint` is true for READ tools only. */
export function toolAnnotations(name: string): { readOnlyHint: boolean } {
  return { readOnlyHint: READ_TOOLS.has(name) };
}
