/**
 * network_mock.ts — a per-target FAKE BACKEND for the page: intercept matching
 * requests via the CDP Fetch domain and fulfill them with a canned response,
 * fail (abort) them, or let them continue (optionally with fault injection).
 * The rod `HijackRequests` capability the read-only console/network tools lack.
 *
 * This file is split into two layers:
 *   1. PURE logic (urlMatches / selectRule / buildFulfillParams / effectiveAction)
 *      — no browser, unit-tested in test/network_mock.test.ts.
 *   2. STATEFUL tools (mockRequest / listMocks / clearMocks) — hold a persistent
 *      CDP connection per target; integration-tested in test/mock-smoke.ts.
 */
import { CdpError, openPage, resolveTarget } from "../client.ts";
import type { CdpConnection } from "../client.ts";
import type { Target, TargetSelector } from "../types.ts";

/* ============================================================================
 * LAYER 1 — pure logic (no I/O)
 * ========================================================================== */

export type MockAction = "fulfill" | "fail" | "continue";

/** Escape a single character for literal use inside a RegExp. */
function escapeRegExpChar(ch: string): string {
  return /[.*+?^${}()|[\]\\]/.test(ch) ? `\\${ch}` : ch;
}

/**
 * Convert a CDP Fetch `urlPattern` glob to an anchored RegExp.
 * CDP semantics: `*` = zero or more chars, `?` = exactly one, `\` escapes the
 * next char. Everything else is literal.
 */
function globToRegExp(pattern: string): RegExp {
  let re = "";
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i]!;
    if (ch === "\\") {
      const next = pattern[i + 1];
      if (next !== undefined) {
        re += escapeRegExpChar(next);
        i++;
      } else {
        re += "\\\\";
      }
    } else if (ch === "*") {
      re += ".*";
    } else if (ch === "?") {
      re += ".";
    } else {
      re += escapeRegExpChar(ch);
    }
  }
  return new RegExp(`^${re}$`);
}

/** True if `url` matches the CDP urlPattern glob `pattern`. */
export function urlMatches(pattern: string, url: string): boolean {
  return globToRegExp(pattern).test(url);
}

/** First rule whose pattern matches `url` and whose method filter (if any) matches. */
export function selectRule<T extends { urlPattern: string; method?: string }>(
  rules: T[],
  url: string,
  method: string,
): T | undefined {
  return rules.find(
    (r) => urlMatches(r.urlPattern, url) && (!r.method || r.method.toUpperCase() === method.toUpperCase()),
  );
}

/** CDP Fetch.fulfillRequest params. */
export interface FulfillParams {
  requestId: string;
  responseCode: number;
  responseHeaders: Array<{ name: string; value: string }>;
  /** base64-encoded body (CDP requires base64). */
  body: string;
}

/**
 * Build CDP `Fetch.fulfillRequest` params from a rule: status, headers
 * (Content-Type default, overridable by custom headers, case-insensitively),
 * and a base64-encoded body.
 */
export function buildFulfillParams(
  requestId: string,
  rule: { status?: number; body?: string; contentType?: string; headers?: Record<string, string> },
): FulfillParams {
  const merged = new Map<string, { name: string; value: string }>();
  merged.set("content-type", { name: "Content-Type", value: rule.contentType ?? "application/json" });
  for (const [name, value] of Object.entries(rule.headers ?? {})) {
    merged.set(name.toLowerCase(), { name, value });
  }
  return {
    requestId,
    responseCode: rule.status ?? 200,
    responseHeaders: [...merged.values()],
    body: Buffer.from(rule.body ?? "", "utf8").toString("base64"),
  };
}

/**
 * Resolve the action to take, applying fault injection: if `failRate` is set and
 * the injected roll `rnd` (0..1) falls under it, force a "fail"; otherwise the
 * rule's configured action.
 */
export function effectiveAction(rule: { action: MockAction; failRate?: number }, rnd: number): MockAction {
  if (rule.failRate !== undefined && rule.failRate > 0 && rnd < rule.failRate) return "fail";
  return rule.action;
}

/* ============================================================================
 * LAYER 2 — stateful tools (persistent per-target CDP connection)
 *
 * A "fake backend" is a per-target SESSION holding ONE persistent CDP connection
 * with the Fetch domain enabled. Each session carries a list of rules; an
 * incoming request that matches a pattern is paused (Fetch.requestPaused) and we
 * fulfill / fail / continue it. The session survives navigations and reloads on
 * the same target and lives until clear_mocks (or the tab closes).
 *
 * Persistence works because the MCP server process is long-lived across tool
 * calls, so this module-level `sessions` map and its open connections outlive a
 * single call. (The stateless CLI process exits after one command, so persistent
 * mocking is an MCP-server capability — like the recorder's background mode.)
 *
 * SAFETY: every paused request MUST be answered or the renderer hangs. A request
 * that pauses but matches no rule is continued untouched.
 * ========================================================================== */

interface MockRule {
  urlPattern: string;
  action: MockAction;
  status?: number;
  body?: string;
  contentType?: string;
  headers?: Record<string, string>;
  errorReason?: string;
  method?: string;
  delayMs?: number;
  failRate?: number;
  hits: number;
}

interface MockSession {
  conn: CdpConnection;
  target: Target;
  rules: MockRule[];
  intercepted: Array<{ url: string; method: string; action: MockAction }>;
  chain: Promise<void>;
  dead: boolean;
}

/** Per-target fake-backend sessions, keyed by targetId. Persists across calls in the MCP server process. */
const sessions = new Map<string, MockSession>();

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Wire the Fetch.requestPaused handler (serialized so Fetch.disable waits for in-flight answers). */
function registerHandler(session: MockSession): void {
  session.conn.on("Fetch.requestPaused", (params) => {
    const p = params as { requestId: string; request: { url: string; method: string } };
    session.chain = session.chain
      .then(async () => {
        const rule = selectRule(session.rules, p.request.url, p.request.method);
        if (!rule) {
          await session.conn.send("Fetch.continueRequest", { requestId: p.requestId });
          return;
        }
        if (rule.delayMs) await delay(rule.delayMs);
        const act = effectiveAction(rule, Math.random());
        if (act === "fulfill") {
          await session.conn.send("Fetch.fulfillRequest", { ...buildFulfillParams(p.requestId, rule) });
        } else if (act === "fail") {
          await session.conn.send("Fetch.failRequest", { requestId: p.requestId, errorReason: rule.errorReason ?? "Failed" });
        } else {
          await session.conn.send("Fetch.continueRequest", { requestId: p.requestId });
        }
        rule.hits++;
        session.intercepted.push({ url: p.request.url, method: p.request.method, action: act });
      })
      .catch((e) => {
        // Tab navigated away mid-flight or the connection dropped — best-effort.
        if (/closed|connection|Target|Inspected/i.test(String(e))) session.dead = true;
      });
  });
}

export interface MockRequestArgs {
  target?: TargetSelector;
  /** CDP Fetch urlPattern glob (`*` = any run, `?` = one char). Only matching URLs pause. */
  urlPattern: string;
  /** What to do with a matched request (default "fulfill"). */
  action?: MockAction;
  /** fulfill: HTTP status (default 200). */
  status?: number;
  /** fulfill: response body string. */
  body?: string;
  /** fulfill: Content-Type (default "application/json"). */
  contentType?: string;
  /** fulfill: extra response headers (override Content-Type case-insensitively). */
  headers?: Record<string, string>;
  /** fail: CDP Network.ErrorReason (default "Failed"), e.g. "BlockedByClient". */
  errorReason?: string;
  /** Only mock requests with this HTTP method; others pass through. */
  method?: string;
  /** Fault injection: artificial latency before responding, ms. */
  delayMs?: number;
  /** Fault injection: probability 0..1 of failing a matched request regardless of action. */
  failRate?: number;
  /** Reload the target after arming so the mock immediately catches traffic. */
  reload?: boolean;
}

export interface MockRequestResult {
  target: { id: string; url: string; title: string };
  pattern: string;
  ruleCount: number;
  reloaded: boolean;
}

/**
 * Register (or update) a mock rule on a target's fake-backend session, creating
 * the persistent session on first use. Pass `reload:true` to apply it right away.
 */
export async function mockRequest(args: MockRequestArgs): Promise<MockRequestResult> {
  if (!args.urlPattern) throw new CdpError("mock_request requires a { urlPattern }");
  const rule: MockRule = {
    urlPattern: args.urlPattern,
    action: args.action ?? "fulfill",
    status: args.status,
    body: args.body,
    contentType: args.contentType,
    headers: args.headers,
    errorReason: args.errorReason,
    method: args.method,
    delayMs: args.delayMs,
    failRate: args.failRate,
    hits: 0,
  };

  const resolved = await resolveTarget(args.target);
  let session = sessions.get(resolved.id);

  if (session && !session.dead) {
    // Replace a same-pattern+method rule, else append; then refresh the patterns.
    const idx = session.rules.findIndex(
      (r) => r.urlPattern === rule.urlPattern && (r.method ?? "") === (rule.method ?? ""),
    );
    if (idx >= 0) session.rules[idx] = rule;
    else session.rules.push(rule);
    await session.conn.send("Fetch.enable", { patterns: session.rules.map((r) => ({ urlPattern: r.urlPattern })) });
  } else {
    const { conn, target } = await openPage(resolved.id);
    session = { conn, target, rules: [rule], intercepted: [], chain: Promise.resolve(), dead: false };
    registerHandler(session);
    await conn.send("Fetch.enable", { patterns: [{ urlPattern: rule.urlPattern }] });
    sessions.set(target.id, session);
  }

  let reloaded = false;
  if (args.reload) {
    await session.conn.send("Page.enable");
    await session.conn.send("Page.reload", { ignoreCache: true });
    await delay(800);
    reloaded = true;
  }

  return {
    target: { id: session.target.id, url: session.target.url, title: session.target.title },
    pattern: rule.urlPattern,
    ruleCount: session.rules.length,
    reloaded,
  };
}

export interface ListMocksResult {
  count: number;
  mocks: Array<{
    target: { id: string; url: string; title: string };
    rules: Array<{ urlPattern: string; action: MockAction; method?: string; hits: number }>;
    hits: number;
  }>;
}

/** List active fake-backend sessions and their rules/hit counts. Prunes dead sessions. */
export async function listMocks(_args: { target?: TargetSelector } = {}): Promise<ListMocksResult> {
  // Probe liveness cheaply; a closed tab's connection rejects immediately.
  for (const [id, s] of sessions) {
    if (s.dead) {
      try {
        s.conn.close();
      } catch {
        /* ignore */
      }
      sessions.delete(id);
      continue;
    }
    try {
      await s.conn.send("Runtime.evaluate", { expression: "1", returnByValue: true }, { timeoutMs: 3000 });
    } catch {
      try {
        s.conn.close();
      } catch {
        /* ignore */
      }
      sessions.delete(id);
    }
  }
  const mocks = [...sessions.values()].map((s) => ({
    target: { id: s.target.id, url: s.target.url, title: s.target.title },
    rules: s.rules.map((r) => ({ urlPattern: r.urlPattern, action: r.action, method: r.method, hits: r.hits })),
    hits: s.intercepted.length,
  }));
  return { count: mocks.length, mocks };
}

export interface ClearMocksArgs {
  target?: TargetSelector;
  /** Clear every active session instead of just the resolved target's. */
  all?: boolean;
}

/** Tear down fake-backend sessions: Fetch.disable + close the connection. */
export async function clearMocks(args: ClearMocksArgs = {}): Promise<{ cleared: number }> {
  let ids: string[];
  if (args.all) {
    ids = [...sessions.keys()];
  } else {
    const resolved = await resolveTarget(args.target);
    ids = sessions.has(resolved.id) ? [resolved.id] : [];
  }
  let cleared = 0;
  for (const id of ids) {
    const s = sessions.get(id);
    if (!s) continue;
    try {
      await s.conn.send("Fetch.disable");
    } catch {
      /* tab may be gone */
    }
    try {
      s.conn.close();
    } catch {
      /* ignore */
    }
    sessions.delete(id);
    cleared++;
  }
  return { cleared };
}

/* ------------------------------------------------------------------------------
 * CDP methods used:
 *   Fetch.enable (patterns), Fetch.requestPaused (event),
 *   Fetch.fulfillRequest / Fetch.failRequest / Fetch.continueRequest, Fetch.disable,
 *   Page.enable + Page.reload (reload:true), Runtime.evaluate (liveness probe).
 * Model: persistent per-target session (like recorder.ts), MCP-server-scoped state.
 * Parity gaps vs rod HijackRequests / chrome-devtools-mcp:
 *   - Request-stage only — no live Response-body rewriting (add requestStage:"Response"
 *     + Fetch.getResponseBody/continueResponse for that).
 *   - Persistence is in-process: works via the long-lived MCP server, not the
 *     one-shot CLI (mirrors the recorder's background mode).
 *   - Cached requests aren't intercepted (use reload:true / a hard reload to refetch).
 * ---------------------------------------------------------------------------- */
