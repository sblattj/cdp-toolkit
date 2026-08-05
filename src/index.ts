/**
 * cdp-toolkit public surface.
 *
 * Two exports:
 *   1. `TOOLS` : the registry mapping every chrome-devtools-mcp tool name
 *      (snake_case string, all 29) to its raw-CDP implementation function. The
 *      CLI and any embedder dispatch through this single table.
 *   2. The client primitives, re-exported so consumers can build their own
 *      flows on the same connection/timeout machinery the tools use.
 *
 * Every tool fn takes a single typed args object and returns a JSON-serializable
 * value (or throws). See CONTRACT.md for the design rules each module follows.
 */

// --- the 20 tools unified with Firefox onto one Driver-based implementation ---
// (list_pages/new_page/close_page/select_page, navigate_page/wait_for, evaluate_script,
// take_snapshot, click/hover/drag/fill/fill_form/type_text/press_key/upload_file,
// take_screenshot/emulate/resize_page, handle_dialog). See shared-tools.ts's file header for
// the byte-identical-Chrome-behavior contract this bind honors, and for the 7 tools that stay
// two implementations (console/network/mock, immediately below, unchanged from before).
import { createCdpDriver } from "./cdp/driver.ts";
import { SHARED_TOOLS } from "./shared-tools.ts";
// --- console + network (read the recorder buffer) ---
import { listConsoleMessages, getConsoleMessage } from "./tools/console.ts";
import { listNetworkRequests, getNetworkRequest } from "./tools/network.ts";
// --- performance ---
import {
  performanceStartTrace,
  performanceStopTrace,
  performanceAnalyzeInsight,
  performanceTrace,
} from "./tools/performance.ts";
// --- heap ---
import { takeHeapsnapshot } from "./tools/heap.ts";
// --- lighthouse (the sole non-CDP tool) ---
import { lighthouseAudit } from "./tools/lighthouse.ts";
// --- network mocking (Fetch domain) : toolkit addition beyond the 29 parity tools ---
import { mockRequest, listMocks, clearMocks } from "./tools/network_mock.ts";

/** A toolkit tool: a single typed-args function returning JSON-serializable data. */
export type ToolFn = (args: never) => Promise<unknown>;

// One stateless CDP driver, reused across calls (lifetime "per-call": every page() acquisition
// still opens its own throwaway connection, same as the pre-migration withPage per-call model).
// Constructing it does not dial a browser (capabilities.ts already relies on this).
const cdpDriver = createCdpDriver();

/** Bind a shared-tools.ts function to the module-level CDP driver, args-typed for the registry. */
function onCdp<A>(fn: (driver: ReturnType<typeof createCdpDriver>, args: A) => Promise<unknown>): (args: A) => Promise<unknown> {
  return (args: A) => fn(cdpDriver, args);
}

/**
 * The complete chrome-devtools-mcp parity surface: all 29 MCP tools keyed by
 * their canonical MCP (snake_case) name, plus one convenience superset tool
 * (`performance_trace`, a robust single-call trace : the start/stop pair cannot
 * span two stateless CLI processes), plus a 3-tool network-mocking group
 * (mock_request/list_mocks/clear_mocks : a persistent per-target fake backend).
 * 33 entries total. Listed explicitly so the mapping is auditable at a glance and
 * the CLI can `--list` it.
 *
 * 20 of the 29 MCP-parity tools (pages/navigation/evaluate/snapshot/interaction/
 * screenshot+emulation/dialogs) now route through shared-tools.ts's single Driver-based
 * implementation via the CDP driver, instead of a Chrome-only copy in src/tools/*.ts.
 * See shared-tools.ts's file header for the shape/behavior contract this preserves.
 */
export const TOOLS = {
  // pages (4)
  list_pages: onCdp(SHARED_TOOLS.list_pages),
  new_page: onCdp(SHARED_TOOLS.new_page),
  close_page: onCdp(SHARED_TOOLS.close_page),
  select_page: onCdp(SHARED_TOOLS.select_page),
  // navigation (2)
  navigate_page: onCdp(SHARED_TOOLS.navigate_page),
  wait_for: onCdp(SHARED_TOOLS.wait_for),
  // evaluate (1)
  evaluate_script: onCdp(SHARED_TOOLS.evaluate_script),
  // snapshot (1)
  take_snapshot: onCdp(SHARED_TOOLS.take_snapshot),
  // interaction (8)
  click: onCdp(SHARED_TOOLS.click),
  hover: onCdp(SHARED_TOOLS.hover),
  drag: onCdp(SHARED_TOOLS.drag),
  fill: onCdp(SHARED_TOOLS.fill),
  fill_form: onCdp(SHARED_TOOLS.fill_form),
  type_text: onCdp(SHARED_TOOLS.type_text),
  press_key: onCdp(SHARED_TOOLS.press_key),
  upload_file: onCdp(SHARED_TOOLS.upload_file),
  // screenshot + emulation (3)
  take_screenshot: onCdp(SHARED_TOOLS.take_screenshot),
  emulate: onCdp(SHARED_TOOLS.emulate),
  resize_page: onCdp(SHARED_TOOLS.resize_page),
  // dialogs (1)
  handle_dialog: onCdp(SHARED_TOOLS.handle_dialog),
  // console + network (4)
  list_console_messages: listConsoleMessages,
  get_console_message: getConsoleMessage,
  list_network_requests: listNetworkRequests,
  get_network_request: getNetworkRequest,
  // performance (3 MCP + 1 convenience one-shot)
  performance_start_trace: performanceStartTrace,
  performance_stop_trace: performanceStopTrace,
  performance_analyze_insight: performanceAnalyzeInsight,
  performance_trace: performanceTrace,
  // heap (1)
  take_heapsnapshot: takeHeapsnapshot,
  // lighthouse (1) : the only non-CDP tool
  lighthouse_audit: lighthouseAudit,
  // network mocking (3) : persistent per-target fake backend (toolkit addition, Fetch domain)
  mock_request: mockRequest,
  list_mocks: listMocks,
  clear_mocks: clearMocks,
} satisfies Record<string, (args: never) => Promise<unknown>>;

/** Canonical MCP tool name accepted by the registry. */
export type ToolName = keyof typeof TOOLS;

/** All tool names (handy for `--list` and validation). */
export const TOOL_NAMES = Object.keys(TOOLS) as ToolName[];

/* ----------------------------- client primitives ----------------------------- */

export {
  BASE,
  DEFAULT_TIMEOUT_MS,
  CdpError,
  CdpConnection,
  listTargets,
  browserWsUrl,
  resolveTarget,
  openBrowser,
  openPage,
  withPage,
} from "./client.ts";

export type { Target, TargetSelector, Uid, CdpResponse, CdpEvent, ToolResult } from "./types.ts";
