/**
 * Firefox-only tool implementations, built on the browser-neutral Driver contract (ADR-001).
 * These are the 7 tools NOT unified with Chrome's src/tools/*.ts implementations: Chrome's
 * console/network/mock tools are built on src/tools/recorder.ts, a disk-persisted,
 * cross-process capture keyed by target id; these are a same-process, in-memory event buffer.
 * See src/shared-tools.ts's file header for why unifying them was not a safe behavior-preserving
 * move and was left as two implementations. This file is what src/neutral.ts shrank to once its
 * other 20 tools became src/shared-tools.ts's single real implementation.
 */
import type { BrowserDriver, InterceptRule, PageDriver, PageInfo } from "./driver.ts";
import { selectRule, buildFulfillParams, effectiveAction } from "./tools/network_mock.ts";
import type { TargetSelector } from "./types.ts";

class BidiToolError extends Error {}

async function withPage<T>(driver: BrowserDriver, target: TargetSelector | undefined, fn: (page: PageDriver) => Promise<T>): Promise<T> {
  const page = await driver.page(target);
  try {
    return await fn(page);
  } finally {
    await page.release();
  }
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

export async function listConsoleMessages(
  driver: BrowserDriver,
  args: { target?: TargetSelector; reload?: boolean; durationMs?: number } = {},
): Promise<{ messages: Array<Record<string, unknown>>; count: number }> {
  return withPage(driver, args.target, async (page) => {
    if (args.reload) await captureFresh(page, args.durationMs ?? 2500);
    const buf = bufferFor(consoleBuffers, page.info.id);
    return { messages: [...buf], count: buf.length };
  });
}

export async function getConsoleMessage(
  driver: BrowserDriver,
  args: { target?: TargetSelector; index?: number } = {},
): Promise<Record<string, unknown>> {
  return withPage(driver, args.target, async (page) => {
    const buf = bufferFor(consoleBuffers, page.info.id);
    const idx = args.index ?? 0;
    const entry = buf[idx];
    if (!entry) throw new BidiToolError(`no console message at index ${idx}; run list_console_messages first`);
    return entry;
  });
}

export async function listNetworkRequests(
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

export async function getNetworkRequest(
  driver: BrowserDriver,
  args: { target?: TargetSelector; requestId?: string; url?: string } = {},
): Promise<Record<string, unknown>> {
  if (!args.requestId && !args.url) throw new BidiToolError("get_network_request requires requestId or url");
  return withPage(driver, args.target, async (page) => {
    const buf = bufferFor(networkBuffers, page.info.id);
    const found = args.requestId
      ? buf.find((r) => r.requestId === args.requestId || r.request === args.requestId)
      : buf.find((r) => typeof r.url === "string" && (r.url as string).includes(args.url as string));
    if (!found) throw new BidiToolError("no matching network request in the current buffer; run list_network_requests first");
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

export async function mockRequest(
  driver: BrowserDriver,
  args: {
    target?: TargetSelector; urlPattern: string; action?: "fulfill" | "fail" | "continue"; status?: number;
    body?: string; contentType?: string; headers?: Record<string, string>; errorReason?: string; method?: string;
    delayMs?: number; failRate?: number; reload?: boolean;
  },
): Promise<{ target: PageInfo; rule: { urlPattern: string; action: string }; ruleCount: number }> {
  if (!args.urlPattern) throw new BidiToolError("mock_request requires a { urlPattern }");
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

export async function listMocks(
  _driver: BrowserDriver,
  _args: { target?: TargetSelector } = {},
): Promise<{ sessions: Array<{ target: string; rules: Array<{ urlPattern: string; action: string; method?: string }> }> }> {
  const sessions = [...mockSessions.entries()].map(([id, s]) => ({
    target: id,
    rules: s.rules.map((r) => ({ urlPattern: r.urlPattern, action: r.action, method: r.method })),
  }));
  return { sessions };
}

export async function clearMocks(
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

// selectRule/buildFulfillParams/effectiveAction are imported above purely so this module's
// footer can name them as reused; the actual call sites live inside bidi/driver.ts's
// PageDriver.intercept() implementation, which this file drives through the neutral
// `intercept(rules)` surface rather than re-implementing.
void selectRule; void buildFulfillParams; void effectiveAction;

/** The 7 Firefox-only tools: no Chrome equivalent is wired through this file (see header). */
export const BIDI_ONLY_TOOLS = {
  list_console_messages: listConsoleMessages,
  get_console_message: getConsoleMessage,
  list_network_requests: listNetworkRequests,
  get_network_request: getNetworkRequest,
  mock_request: mockRequest,
  list_mocks: listMocks,
  clear_mocks: clearMocks,
} satisfies Record<string, (driver: BrowserDriver, args: never) => Promise<unknown>>;
