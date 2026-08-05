/**
 * Driver-neutral tool implementations, built ONLY on the browser-neutral
 * Driver contract in driver.ts (ADR-001), no CDP, no BiDi specifics. This is
 * the execution path for any BrowserDriver whose tools are not (yet) wired
 * through the raw-CDP modules in src/tools/*.ts, today: Firefox over BiDi.
 *
 * Why this file exists at all: src/index.ts's TOOLS registry calls straight
 * into src/tools/*.ts, and every one of those modules opens its own raw CDP
 * connection via src/client.ts. They know nothing about driver.ts's
 * BrowserDriver/PageDriver interface and cannot run against Firefox. Rather
 * than teach 29 CDP-shaped modules a second protocol, NEUTRAL_TOOLS below
 * re-implements the same tool surface directly on PageDriver/BrowserDriver,
 * so the SAME REQUIRED_CAPABILITIES contract that filters tools/list also
 * describes exactly what is actually wired here: every tool absent from
 * REQUIRED_CAPABILITIES, plus mock_request/list_mocks/clear_mocks (declared
 * by BiDi's "network.intercept"), is implemented below. Nothing is listed
 * as available and then throws "unsupported" at call time (ADR-001 rejected
 * alternative E): a tool is either genuinely runnable through this file or
 * it is filtered out of tools/list upstream.
 *
 * The Chrome path in src/index.ts's TOOLS is completely untouched by this
 * file: chrome dispatch never reaches here.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type {
  BrowserDriver, DriverUid, ElementLocator, InterceptRule, PageDriver, PageInfo, SnapshotNode,
} from "./driver.ts";
import { selectRule, buildFulfillParams, effectiveAction } from "./tools/network_mock.ts";
import type { ToolName } from "./index.ts";
import type { TargetSelector } from "./types.ts";

const ARTIFACT_DIR = process.env.CDP_ARTIFACT_DIR ?? "/tmp/cdp-toolkit";
const STATE_DIR = process.env.CDP_STATE_DIR ?? "/tmp/cdp-toolkit";

class NeutralError extends Error {}

/* -------------------------------- page acquisition -------------------------------- */

/** Acquire, run, always release: the neutral-driver counterpart of client.ts's withPage. */
async function withPage<T>(driver: BrowserDriver, target: TargetSelector | undefined, fn: (page: PageDriver) => Promise<T>): Promise<T> {
  const page = await driver.page(target);
  try {
    return await fn(page);
  } finally {
    await page.release();
  }
}

/** Same TargetSelector grammar as client.ts's resolveTarget, resolved over BrowserDriver.listPages(). */
async function resolvePage(driver: BrowserDriver, selector?: TargetSelector): Promise<PageInfo> {
  const pages = await driver.listPages();
  if (!pages.length) throw new NeutralError("no pages available");
  if (selector === undefined || selector === "active") return pages[0]!;
  if (selector.startsWith("index:")) {
    const p = pages[Number(selector.slice(6))];
    if (!p) throw new NeutralError(`no page at ${selector}`);
    return p;
  }
  if (selector.startsWith("url:")) {
    const needle = selector.slice(4);
    const p = pages.find((x) => x.url.includes(needle));
    if (!p) throw new NeutralError(`no page with url containing '${needle}'`);
    return p;
  }
  if (selector.startsWith("title:")) {
    const needle = selector.slice(6);
    const p = pages.find((x) => x.title.includes(needle));
    if (!p) throw new NeutralError(`no page with title containing '${needle}'`);
    return p;
  }
  const exact = pages.find((x) => x.id === selector);
  if (exact) return exact;
  throw new NeutralError(`no page matching '${selector}'`);
}

/* -------------------------------- element locators -------------------------------- */

function locatorOf(args: { uid?: DriverUid; selector?: string }): ElementLocator {
  const hasUid = args.uid !== undefined && args.uid !== null && args.uid !== "";
  const hasSelector = typeof args.selector === "string" && args.selector.length > 0;
  if (hasUid === hasSelector) throw new NeutralError("provide exactly one of { uid } or { selector }");
  return hasUid ? { uid: args.uid as DriverUid } : { css: args.selector as string };
}

/* -------------------------------- pages (4) -------------------------------- */

export async function listPagesN(driver: BrowserDriver, _args: { all?: boolean } = {}): Promise<{ pages: PageInfo[]; count: number }> {
  const pages = await driver.listPages();
  return { pages, count: pages.length };
}

export async function newPageN(driver: BrowserDriver, args: { url?: string } = {}): Promise<{ targetId: string; url: string }> {
  const p = await driver.newPage(args.url);
  return { targetId: p.id, url: p.url };
}

export async function closePageN(driver: BrowserDriver, args: { target?: TargetSelector }): Promise<{ closed: string; success: boolean }> {
  if (!args.target) throw new NeutralError("close_page requires an explicit target; refusing to guess which page to close");
  const p = await resolvePage(driver, args.target);
  await driver.closePage(p.id);
  return { closed: p.id, success: true };
}

async function writeSelectedFile(id: string): Promise<void> {
  await mkdir(STATE_DIR, { recursive: true });
  await writeFile(join(STATE_DIR, "selected"), id, "utf8");
}

export async function selectPageN(driver: BrowserDriver, args: { target?: TargetSelector }): Promise<{ selected: string }> {
  if (!args.target) throw new NeutralError("select_page requires an explicit target");
  const p = await resolvePage(driver, args.target);
  const activated = await driver.activatePage(p.id);
  await writeSelectedFile(activated.id);
  return { selected: activated.id };
}

/* ------------------------------ navigation (2) ------------------------------ */

export async function navigatePageN(
  driver: BrowserDriver,
  args: { target?: TargetSelector; url?: string; reload?: boolean; ignoreCache?: boolean; waitUntil?: "load" | "domcontentloaded"; timeoutMs?: number },
): Promise<unknown> {
  return withPage(driver, args.target, (page) => page.navigate(args));
}

export async function waitForN(driver: BrowserDriver, args: { target?: TargetSelector; text: string; timeoutMs?: number }): Promise<unknown> {
  if (!args.text) throw new NeutralError("wait_for requires { text }");
  return withPage(driver, args.target, (page) => page.waitForText(args.text, args.timeoutMs));
}

/* ------------------------------- evaluate (1) ------------------------------- */

export async function evaluateScriptN(
  driver: BrowserDriver,
  args: { target?: TargetSelector; expression: string; awaitPromise?: boolean; args?: unknown[] },
): Promise<unknown> {
  if (!args.expression) throw new NeutralError("evaluate_script requires { expression }");
  return withPage(driver, args.target, (page) =>
    page.evaluate(args.expression, { args: args.args, awaitPromise: args.awaitPromise }));
}

/* -------------------------------- snapshot (1) -------------------------------- */

function renderSnapshotLine(n: SnapshotNode): string {
  const indent = "  ".repeat(n.depth);
  const name = n.name !== undefined ? ` ${JSON.stringify(n.name)}` : "";
  const extrasToks = n.extras
    ? Object.entries(n.extras).map(([k, v]) => (v === "true" ? k : `${k}=${JSON.stringify(v)}`))
    : [];
  const extra = extrasToks.length ? ` [${extrasToks.join(" ")}]` : "";
  return `${indent}[${n.uid}] ${n.role}${name}${extra}`;
}

export async function takeSnapshotN(
  driver: BrowserDriver,
  args: { target?: TargetSelector; interactiveOnly?: boolean } = {},
): Promise<{ snapshot: string; target: PageInfo; nodeCount: number }> {
  return withPage(driver, args.target, async (page) => {
    const nodes = await page.snapshot({ interactiveOnly: args.interactiveOnly });
    return { snapshot: nodes.map(renderSnapshotLine).join("\n"), target: page.info, nodeCount: nodes.length };
  });
}

/* ------------------------------ interaction (8) ------------------------------ */

export async function clickN(
  driver: BrowserDriver,
  args: { target?: TargetSelector; uid?: DriverUid; selector?: string; button?: "left" | "right" | "middle"; clickCount?: number },
): Promise<unknown> {
  return withPage(driver, args.target, (page) => page.click(locatorOf(args), { button: args.button, clickCount: args.clickCount }));
}

export async function hoverN(driver: BrowserDriver, args: { target?: TargetSelector; uid?: DriverUid; selector?: string }): Promise<unknown> {
  return withPage(driver, args.target, (page) => page.hover(locatorOf(args)));
}

export async function dragN(
  driver: BrowserDriver,
  args: { target?: TargetSelector; from: { uid?: DriverUid; selector?: string }; to: { uid?: DriverUid; selector?: string } },
): Promise<unknown> {
  if (!args.from || !args.to) throw new NeutralError("drag requires { from, to }");
  return withPage(driver, args.target, (page) => page.drag(locatorOf(args.from), locatorOf(args.to)));
}

export async function fillN(
  driver: BrowserDriver,
  args: { target?: TargetSelector; uid?: DriverUid; selector?: string; value: string },
): Promise<{ ok: true }> {
  if (args.value === undefined) throw new NeutralError("fill requires { value }");
  return withPage(driver, args.target, async (page) => {
    await page.setValue(locatorOf(args), args.value);
    return { ok: true };
  });
}

export async function fillFormN(
  driver: BrowserDriver,
  args: { target?: TargetSelector; fields: Array<{ uid?: DriverUid; selector?: string; value: string }> },
): Promise<{ filled: number }> {
  if (!args.fields?.length) throw new NeutralError("fill_form requires a non-empty { fields } array");
  return withPage(driver, args.target, async (page) => {
    for (const f of args.fields) await page.setValue(locatorOf(f), f.value);
    return { filled: args.fields.length };
  });
}

export async function typeTextN(
  driver: BrowserDriver,
  args: { target?: TargetSelector; uid?: DriverUid; selector?: string; text: string },
): Promise<{ ok: true }> {
  if (args.text === undefined) throw new NeutralError("type_text requires { text }");
  return withPage(driver, args.target, async (page) => {
    await page.typeText(locatorOf(args), args.text);
    return { ok: true };
  });
}

export async function pressKeyN(
  driver: BrowserDriver,
  args: { target?: TargetSelector; key: string; modifiers?: string[] },
): Promise<{ ok: true }> {
  if (!args.key) throw new NeutralError("press_key requires { key }");
  return withPage(driver, args.target, async (page) => {
    await page.pressKey({ key: args.key, modifiers: args.modifiers });
    return { ok: true };
  });
}

export async function uploadFileN(
  driver: BrowserDriver,
  args: { target?: TargetSelector; uid?: DriverUid; selector?: string; files: string | string[] },
): Promise<{ ok: true }> {
  if (!args.files) throw new NeutralError("upload_file requires { files }");
  const files = Array.isArray(args.files) ? args.files : [args.files];
  return withPage(driver, args.target, async (page) => {
    await page.setFiles(locatorOf(args), files);
    return { ok: true };
  });
}

/* -------------------------- screenshot + emulation (3) -------------------------- */

function stamp(): string {
  return new Date(Date.now()).toISOString().replace(/[:.]/g, "-");
}

export async function takeScreenshotN(
  driver: BrowserDriver,
  args: {
    target?: TargetSelector; format?: "png" | "jpeg"; quality?: number; fullPage?: boolean;
    uid?: DriverUid; selector?: string; savePath?: string; returnBase64?: boolean;
  } = {},
): Promise<{ path: string; bytes: number; format: "png" | "jpeg"; target: PageInfo; base64?: string }> {
  if ((args.uid !== undefined && args.uid !== "") && args.selector) throw new NeutralError("provide exactly one of uid or selector, not both");
  const format = args.format ?? "png";
  return withPage(driver, args.target, async (page) => {
    const clip = args.uid !== undefined || args.selector ? locatorOf(args) : undefined;
    const { data, format: outFormat } = await page.screenshot({
      format, quality: args.quality, fullPage: args.fullPage, ...(clip ? { clip } : {}),
    });
    await mkdir(ARTIFACT_DIR, { recursive: true });
    const ext = outFormat === "jpeg" ? "jpg" : "png";
    const path = args.savePath ?? join(ARTIFACT_DIR, `screenshot-${page.info.id.slice(0, 8)}-${stamp()}.${ext}`);
    await writeFile(path, Buffer.from(data));
    const result: { path: string; bytes: number; format: "png" | "jpeg"; target: PageInfo; base64?: string } = {
      path, bytes: data.byteLength, format: outFormat, target: page.info,
    };
    if (args.returnBase64) result.base64 = Buffer.from(data).toString("base64");
    return result;
  });
}

export async function emulateN(
  driver: BrowserDriver,
  args: {
    target?: TargetSelector; width?: number; height?: number; deviceScaleFactor?: number; mobile?: boolean;
    userAgent?: string; cpuThrottlingRate?: number; media?: string; mediaFeatures?: Array<{ name: string; value: string }>;
    networkConditions?: { offline?: boolean; latency?: number; downloadThroughput?: number; uploadThroughput?: number };
    clearOverrides?: boolean;
  } = {},
): Promise<{ target: PageInfo; applied: string[]; cleared?: boolean }> {
  return withPage(driver, args.target, async (page) => {
    if (args.clearOverrides) {
      await page.emulate({ clearOverrides: true });
      return { target: page.info, applied: [], cleared: true };
    }
    const { applied } = await page.emulate(args);
    if (!applied.length) throw new NeutralError("emulate: no overrides applied under this backend's declared capabilities (pass clearOverrides:true to reset)");
    return { target: page.info, applied };
  });
}

export async function resizePageN(
  driver: BrowserDriver,
  args: { target?: TargetSelector; width: number; height: number; deviceScaleFactor?: number; mobile?: boolean },
): Promise<{ target: PageInfo; width: number; height: number; innerWidth: number; innerHeight: number }> {
  if (!Number.isFinite(args.width) || !Number.isFinite(args.height) || args.width <= 0 || args.height <= 0) {
    throw new NeutralError("resize_page requires positive numeric width and height");
  }
  return withPage(driver, args.target, async (page) => {
    await page.emulate({ width: args.width, height: args.height, deviceScaleFactor: args.deviceScaleFactor, mobile: args.mobile });
    const v = (await page.evaluate("({ w: window.innerWidth, h: window.innerHeight })")) as { w?: number; h?: number } | undefined;
    return { target: page.info, width: args.width, height: args.height, innerWidth: v?.w ?? args.width, innerHeight: v?.h ?? args.height };
  });
}

/* ---------------------------------- dialogs (1) ---------------------------------- */

export async function handleDialogN(
  driver: BrowserDriver,
  args: { target?: TargetSelector; accept: boolean; promptText?: string },
): Promise<unknown> {
  if (args.accept === undefined) throw new NeutralError("handle_dialog requires { accept }");
  return withPage(driver, args.target, (page) => page.handleDialog(args.accept, args.promptText));
}

/* ------------------------------ console + network (4) ------------------------------ */
// No recorder-style raw-CDP buffer exists for the neutral driver. Buffering rides
// PageDriver.on(), scoped to the calling process's lifetime, an identical constraint
// to the CDP recorder (both are per-process). Payloads are the driver's own event
// shape (BiDi's log.entryAdded / network.* records), NOT normalized to CDP's
// Runtime.consoleAPICalled / Network.* shapes, a real cross-driver difference,
// documented in README.md rather than smoothed over.

const consoleBuffers = new Map<string, Array<Record<string, unknown>>>();
const networkBuffers = new Map<string, Array<Record<string, unknown>>>();

function bufferFor(map: Map<string, Array<Record<string, unknown>>>, id: string): Array<Record<string, unknown>> {
  let b = map.get(id);
  if (!b) { b = []; map.set(id, b); }
  return b;
}

async function captureFresh(page: PageDriver, durationMs: number): Promise<void> {
  const cBuf = bufferFor(consoleBuffers, page.info.id);
  const nBuf = bufferFor(networkBuffers, page.info.id);
  cBuf.length = 0;
  nBuf.length = 0;
  const offC = page.on("console", (p) => cBuf.push(p));
  const offReq = page.on("network.request", (p) => nBuf.push({ ...p, phase: "request" }));
  const offRes = page.on("network.response", (p) => nBuf.push({ ...p, phase: "response" }));
  try {
    await page.navigate({ reload: true }).catch(() => undefined);
    await new Promise((r) => setTimeout(r, durationMs));
  } finally {
    offC(); offReq(); offRes();
  }
}

export async function listConsoleMessagesN(
  driver: BrowserDriver,
  args: { target?: TargetSelector; reload?: boolean; durationMs?: number } = {},
): Promise<{ messages: Array<Record<string, unknown>>; count: number }> {
  return withPage(driver, args.target, async (page) => {
    if (args.reload) await captureFresh(page, args.durationMs ?? 2500);
    const buf = bufferFor(consoleBuffers, page.info.id);
    return { messages: [...buf], count: buf.length };
  });
}

export async function getConsoleMessageN(
  driver: BrowserDriver,
  args: { target?: TargetSelector; index?: number } = {},
): Promise<Record<string, unknown>> {
  return withPage(driver, args.target, async (page) => {
    const buf = bufferFor(consoleBuffers, page.info.id);
    const idx = args.index ?? 0;
    const entry = buf[idx];
    if (!entry) throw new NeutralError(`no console message at index ${idx}; run list_console_messages first`);
    return entry;
  });
}

export async function listNetworkRequestsN(
  driver: BrowserDriver,
  args: { target?: TargetSelector; reload?: boolean; durationMs?: number; filterUrl?: string } = {},
): Promise<{ requests: Array<Record<string, unknown>>; count: number }> {
  return withPage(driver, args.target, async (page) => {
    if (args.reload) await captureFresh(page, args.durationMs ?? 2500);
    let buf = bufferFor(networkBuffers, page.info.id);
    if (args.filterUrl) buf = buf.filter((r) => typeof r.url === "string" && (r.url as string).includes(args.filterUrl as string));
    return { requests: buf, count: buf.length };
  });
}

export async function getNetworkRequestN(
  driver: BrowserDriver,
  args: { target?: TargetSelector; requestId?: string; url?: string } = {},
): Promise<Record<string, unknown>> {
  if (!args.requestId && !args.url) throw new NeutralError("get_network_request requires requestId or url");
  return withPage(driver, args.target, async (page) => {
    const buf = bufferFor(networkBuffers, page.info.id);
    const found = args.requestId
      ? buf.find((r) => r.requestId === args.requestId || r.request === args.requestId)
      : buf.find((r) => typeof r.url === "string" && (r.url as string).includes(args.url as string));
    if (!found) throw new NeutralError("no matching network request in the current buffer; run list_network_requests first");
    return found;
  });
}

/* ------------------------------- network mocking (3) ------------------------------- */
// Reuses tools/network_mock.ts's pure logic layer (selectRule/buildFulfillParams/
// effectiveAction) over PageDriver.intercept(), same pattern bidi/driver.ts's own
// intercept() uses internally. Session-scoped: intercept() takes the FULL rule set
// on every (re)arm, so adding a rule disposes the old interceptor and re-arms with
// the appended array. Persistent only for the life of the calling process: the MCP
// server (long-lived) keeps it across calls; the CLI (one-shot) does not.

interface MockSession {
  rules: Array<InterceptRule & { hits: number }>;
  dispose: () => Promise<void>;
}
const mockSessions = new Map<string, MockSession>();

export async function mockRequestN(
  driver: BrowserDriver,
  args: {
    target?: TargetSelector; urlPattern: string; action?: "fulfill" | "fail" | "continue"; status?: number;
    body?: string; contentType?: string; headers?: Record<string, string>; errorReason?: string; method?: string;
    delayMs?: number; failRate?: number; reload?: boolean;
  },
): Promise<{ target: PageInfo; rule: { urlPattern: string; action: string }; ruleCount: number }> {
  if (!args.urlPattern) throw new NeutralError("mock_request requires a { urlPattern }");
  return withPage(driver, args.target, async (page) => {
    const existing = mockSessions.get(page.info.id);
    const rule: InterceptRule & { hits: number } = {
      urlPattern: args.urlPattern, method: args.method, action: args.action ?? "fulfill",
      status: args.status, body: args.body, contentType: args.contentType, headers: args.headers,
      errorReason: args.errorReason, delayMs: args.delayMs, failRate: args.failRate, hits: 0,
    };
    const rules = existing ? [...existing.rules, rule] : [rule];
    if (existing) await existing.dispose().catch(() => undefined);
    const dispose = await page.intercept(rules);
    mockSessions.set(page.info.id, { rules, dispose });
    if (args.reload) await page.navigate({ reload: true }).catch(() => undefined);
    return { target: page.info, rule: { urlPattern: rule.urlPattern, action: rule.action }, ruleCount: rules.length };
  });
}

export async function listMocksN(
  driver: BrowserDriver,
  _args: { target?: TargetSelector } = {},
): Promise<{ sessions: Array<{ target: string; rules: Array<{ urlPattern: string; action: string; method?: string }> }> }> {
  const sessions = [...mockSessions.entries()].map(([id, s]) => ({
    target: id,
    rules: s.rules.map((r) => ({ urlPattern: r.urlPattern, action: r.action, method: r.method })),
  }));
  return { sessions };
}

export async function clearMocksN(
  driver: BrowserDriver,
  args: { target?: TargetSelector; all?: boolean } = {},
): Promise<{ cleared: number }> {
  if (args.all) {
    let n = 0;
    for (const [, s] of mockSessions) { await s.dispose().catch(() => undefined); n++; }
    mockSessions.clear();
    return { cleared: n };
  }
  return withPage(driver, args.target, async (page) => {
    const existing = mockSessions.get(page.info.id);
    if (!existing) return { cleared: 0 };
    await existing.dispose().catch(() => undefined);
    mockSessions.delete(page.info.id);
    return { cleared: 1 };
  });
}

// selectRule/buildFulfillParams/effectiveAction are imported above purely so this
// module's footer can name them as reused; the actual call sites live inside
// bidi/driver.ts's PageDriver.intercept() implementation, which this file drives
// through the neutral `intercept(rules)` surface rather than re-implementing.
void selectRule; void buildFulfillParams; void effectiveAction;

/* ------------------------------------- registry ------------------------------------- */

/**
 * Every tool actually wired for a driver-neutral backend (today: Firefox/BiDi).
 * Exactly the tool set REQUIRED_CAPABILITIES + each driver's declared capabilities
 * predict as available: universal tools, plus mock_request/list_mocks/clear_mocks
 * (network.intercept). The four performance tools, take_heapsnapshot, and
 * lighthouse_audit are deliberately absent: no BiDi capability declares them, and
 * tools/list already filters them out upstream, so their absence here is not a
 * gap, it is the contract.
 */
export const NEUTRAL_TOOLS: Partial<Record<ToolName, (driver: BrowserDriver, args: never) => Promise<unknown>>> = {
  list_pages: listPagesN as never,
  new_page: newPageN as never,
  close_page: closePageN as never,
  select_page: selectPageN as never,
  navigate_page: navigatePageN as never,
  wait_for: waitForN as never,
  evaluate_script: evaluateScriptN as never,
  take_snapshot: takeSnapshotN as never,
  click: clickN as never,
  hover: hoverN as never,
  drag: dragN as never,
  fill: fillN as never,
  fill_form: fillFormN as never,
  type_text: typeTextN as never,
  press_key: pressKeyN as never,
  upload_file: uploadFileN as never,
  take_screenshot: takeScreenshotN as never,
  emulate: emulateN as never,
  resize_page: resizePageN as never,
  handle_dialog: handleDialogN as never,
  list_console_messages: listConsoleMessagesN as never,
  get_console_message: getConsoleMessageN as never,
  list_network_requests: listNetworkRequestsN as never,
  get_network_request: getNetworkRequestN as never,
  mock_request: mockRequestN as never,
  list_mocks: listMocksN as never,
  clear_mocks: clearMocksN as never,
};
