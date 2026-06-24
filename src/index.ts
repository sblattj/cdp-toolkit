/**
 * cdp-toolkit public surface.
 *
 * Two exports:
 *   1. `TOOLS` — the registry mapping every chrome-devtools-mcp tool name
 *      (snake_case string, all 29) to its raw-CDP implementation function. The
 *      CLI and any embedder dispatch through this single table.
 *   2. The client primitives, re-exported so consumers can build their own
 *      flows on the same connection/timeout machinery the tools use.
 *
 * Every tool fn takes a single typed args object and returns a JSON-serializable
 * value (or throws). See CONTRACT.md for the design rules each module follows.
 */

// --- pages (browser endpoint: Target.*) ---
import { listPages, newPage, closePage, selectPage } from "./tools/pages.ts";
// --- navigation ---
import { navigatePage, waitForText } from "./tools/navigation.ts";
// --- evaluate ---
import { evaluateScript } from "./tools/evaluate.ts";
// --- snapshot (a11y tree + shared resolveUid helper) ---
import { takeSnapshot } from "./tools/snapshot.ts";
// --- input / interaction ---
import { click, hover, drag, fill, fillForm, typeText, pressKey, uploadFile } from "./tools/input.ts";
// --- screenshot + emulation ---
import { takeScreenshot } from "./tools/screenshot.ts";
import { emulate, resizePage } from "./tools/emulation.ts";
// --- dialogs ---
import { handleDialog } from "./tools/dialogs.ts";
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
// --- network mocking (Fetch domain) — toolkit addition beyond the 29 parity tools ---
import { mockRequest, listMocks, clearMocks } from "./tools/network_mock.ts";

/** A toolkit tool: a single typed-args function returning JSON-serializable data. */
export type ToolFn = (args: never) => Promise<unknown>;

/**
 * The complete chrome-devtools-mcp parity surface: all 29 MCP tools keyed by
 * their canonical MCP (snake_case) name, plus one convenience superset tool
 * (`performance_trace`, a robust single-call trace — the start/stop pair cannot
 * span two stateless CLI processes), plus a 3-tool network-mocking group
 * (mock_request/list_mocks/clear_mocks — a persistent per-target fake backend).
 * 33 entries total. Listed explicitly so the mapping is auditable at a glance and
 * the CLI can `--list` it.
 */
export const TOOLS = {
  // pages (4)
  list_pages: listPages,
  new_page: newPage,
  close_page: closePage,
  select_page: selectPage,
  // navigation (2)
  navigate_page: navigatePage,
  wait_for: waitForText,
  // evaluate (1)
  evaluate_script: evaluateScript,
  // snapshot (1)
  take_snapshot: takeSnapshot,
  // interaction (8)
  click: click,
  hover: hover,
  drag: drag,
  fill: fill,
  fill_form: fillForm,
  type_text: typeText,
  press_key: pressKey,
  upload_file: uploadFile,
  // screenshot + emulation (3)
  take_screenshot: takeScreenshot,
  emulate: emulate,
  resize_page: resizePage,
  // dialogs (1)
  handle_dialog: handleDialog,
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
  // lighthouse (1) — the only non-CDP tool
  lighthouse_audit: lighthouseAudit,
  // network mocking (3) — persistent per-target fake backend (toolkit addition, Fetch domain)
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
