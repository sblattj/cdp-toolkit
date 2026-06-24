/**
 * performance.ts — performance tracing + insight analysis over raw CDP.
 *
 * NOTE ON THE INSIGHT ANALYZER: `performanceAnalyzeInsight` is a CDP-native
 * APPROXIMATION of chrome-devtools-mcp's insight analyzer. The MCP tool runs the
 * DevTools/Lighthouse "Trace Engine" insight pipeline (a large TS engine that
 * models the full RAIL/Core-Web-Vitals heuristics). We do NOT vendor that
 * engine (zero-runtime-deps rule). Instead we parse the raw Chrome trace event
 * stream ourselves and derive the headline metrics — navigationStart, FCP, LCP,
 * long tasks (>50ms), layout shifts / CLS, and total blocking time — directly
 * from the trace events. Numbers will be close to but not byte-identical with
 * the MCP/DevTools panel, which applies extra normalization (e.g. main-thread
 * attribution, frame-scoped LCP, soft-navigation handling).
 *
 * NOTE ON TRACING STATE: CDP `Tracing.start`/`Tracing.end` are bound to a single
 * live session — the recording lives on the WebSocket connection, and
 * `Tracing.dataCollected` events stream back on that same connection. There is
 * no way to "re-attach" to an in-flight trace from a fresh process, because the
 * buffer is owned by the connection that started it. Cross-process persistence
 * of a live recording is therefore INFEASIBLE.
 *
 * What we do instead:
 *   - `performanceStartTrace` / `performanceStopTrace` are implemented as a
 *     best-effort in-process pair: start opens a persistent page connection,
 *     parks it in a module-level registry keyed by targetId, and writes a state
 *     file recording which target is being traced. stop looks up the live
 *     connection in the registry, ends the trace, drains data, writes JSON.
 *     This works when start and stop run in the SAME process (e.g. the MCP
 *     dispatcher staying resident, or a single CLI invocation that does both).
 *     If stop runs in a DIFFERENT process than start, the connection is gone and
 *     stop throws a clear CdpError telling the caller to use `performanceTrace`.
 *   - `performanceTrace` is the PRIMARY, robust one-shot: it starts tracing,
 *     optionally reloads/navigates the page, waits `durationMs`, ends the trace,
 *     writes the trace JSON, and returns `{ path, bytes }`. This is the smoke
 *     path and the recommended entry point.
 */
import type { Target, TargetSelector } from "../types.ts";
import type { CdpConnection } from "../client.ts";
import { CdpError, openPage } from "../client.ts";
import { mkdir, readFile, writeFile, stat, unlink } from "node:fs/promises";
import { join } from "node:path";

const ARTIFACT_DIR = process.env.CDP_ARTIFACT_DIR ?? "/tmp/cdp-toolkit";
const STATE_DIR = process.env.CDP_STATE_DIR ?? "/tmp/cdp-toolkit";

/** Default trace categories: timeline + user timing + loading + the disabled-by-default timeline track that carries LCP/LayoutShift/RunTask. */
const DEFAULT_CATEGORIES = [
  "devtools.timeline",
  "blink.user_timing",
  "loading",
  "disabled-by-default-devtools.timeline",
  "disabled-by-default-devtools.timeline.frame",
];

/** A single Chrome trace event (the shape we read from Tracing.dataCollected / saved JSON). */
interface TraceEvent {
  cat?: string;
  name?: string;
  ph?: string;
  ts?: number; // microseconds
  dur?: number; // microseconds
  pid?: number;
  tid?: number;
  args?: Record<string, unknown> & {
    data?: Record<string, unknown> & {
      score?: number;
      had_recent_input?: boolean;
      candidateIndex?: number;
      size?: number;
      navigationId?: string;
    };
    frame?: string;
  };
}

/** A traced-page registry entry held in-process between start and stop. */
interface LiveTrace {
  conn: CdpConnection;
  target: Target;
  events: TraceEvent[];
  startedAt: number;
}

/**
 * In-process registry of live traces keyed by targetId. Survives only within a
 * single Node/Bun process (see header note on cross-process infeasibility).
 */
const liveTraces = new Map<string, LiveTrace>();

interface TraceStateFile {
  targetId: string;
  url: string;
  startedAt: number;
  pid: number;
  categories: string[];
}

function stamp(): string {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

function shortId(id: string): string {
  return id.slice(0, 8);
}

function stateFilePath(): string {
  return join(STATE_DIR, "trace-state.json");
}

/** Subscribe to Tracing.dataCollected and buffer every event into `sink`. */
function bufferTraceData(conn: CdpConnection, sink: TraceEvent[]): () => void {
  return conn.on("Tracing.dataCollected", (params: Record<string, unknown>) => {
    const value = (params as { value?: TraceEvent[] }).value;
    if (Array.isArray(value)) sink.push(...value);
  });
}

/** Begin a trace on an already-open page connection. */
async function beginTrace(conn: CdpConnection, categories: string[]): Promise<void> {
  await conn.send("Tracing.start", {
    traceConfig: { includedCategories: categories },
    transferMode: "ReportEvents",
  });
}

/**
 * End a trace, drain all buffered Tracing.dataCollected, and resolve once
 * Tracing.tracingComplete fires (or the timeout elapses). Returns the events.
 */
async function endTrace(conn: CdpConnection, sink: TraceEvent[], timeoutMs = 30_000): Promise<TraceEvent[]> {
  const complete = conn.waitFor("Tracing.tracingComplete", undefined, timeoutMs);
  await conn.send("Tracing.end");
  await complete;
  return sink;
}

/** Write a trace event array to ARTIFACT_DIR as a DevTools-loadable JSON file. */
async function writeTrace(events: TraceEvent[], targetId: string): Promise<{ path: string; bytes: number }> {
  await mkdir(ARTIFACT_DIR, { recursive: true });
  const path = join(ARTIFACT_DIR, `trace-${shortId(targetId)}-${stamp()}.json`);
  // DevTools accepts either a bare array or { traceEvents: [...] }; use the wrapped
  // form so the file is also openable in the Performance panel.
  const body = JSON.stringify({ traceEvents: events, metadata: { source: "cdp-toolkit" } });
  await writeFile(path, body, "utf8");
  const { size } = await stat(path);
  return { path, bytes: size };
}

/* ------------------------------------------------------------------ */
/* performanceStartTrace / performanceStopTrace (in-process pair)      */
/* ------------------------------------------------------------------ */

export interface PerformanceStartTraceArgs {
  target?: TargetSelector;
  categories?: string[];
}

/**
 * Start a performance trace on the target page and keep the recording
 * connection alive in-process. Pairs with `performanceStopTrace` WITHIN THE
 * SAME PROCESS. For a robust cross-call trace, prefer `performanceTrace`.
 */
export async function performanceStartTrace(
  args: PerformanceStartTraceArgs = {},
): Promise<{ target: { id: string; url: string; title: string }; categories: string[]; note: string }> {
  const categories = args.categories?.length ? args.categories : DEFAULT_CATEGORIES;
  const { conn, target } = await openPage(args.target);

  if (liveTraces.has(target.id)) {
    conn.close();
    throw new CdpError(`a trace is already in progress for target ${shortId(target.id)}; call performanceStopTrace first`);
  }

  const events: TraceEvent[] = [];
  bufferTraceData(conn, events);
  try {
    await beginTrace(conn, categories);
  } catch (err) {
    conn.close();
    throw err;
  }

  liveTraces.set(target.id, { conn, target, events, startedAt: Date.now() });

  await mkdir(STATE_DIR, { recursive: true });
  const state: TraceStateFile = {
    targetId: target.id,
    url: target.url,
    startedAt: Date.now(),
    pid: process.pid,
    categories,
  };
  await writeFile(stateFilePath(), JSON.stringify(state), "utf8");

  return {
    target: { id: target.id, url: target.url, title: target.title },
    categories,
    note: "Trace recording. Call performanceStopTrace in THIS process to finalize. Cross-process? use performanceTrace instead.",
  };
}

export interface PerformanceStopTraceArgs {
  target?: TargetSelector;
}

/**
 * Stop the in-process trace started by `performanceStartTrace`, drain the
 * buffered events, write the trace JSON, and clear state. Throws if no live
 * trace exists in this process (e.g. start ran in a different process).
 */
export async function performanceStopTrace(
  args: PerformanceStopTraceArgs = {},
): Promise<{ path: string; bytes: number; events: number; metrics: TraceMetrics }> {
  // CDP tracing is browser-GLOBAL: a second Tracing.start throws "Tracing has
  // already been started", so at most one trace is ever live in this process.
  // There is therefore nothing to disambiguate by target — take the single live
  // trace if present. (`args.target` is accepted for API symmetry with start.)
  void args.target;
  const entry: LiveTrace | undefined = liveTraces.size === 1 ? [...liveTraces.values()][0] : undefined;

  if (!entry) {
    let hint = "";
    try {
      const raw = await readFile(stateFilePath(), "utf8");
      const state = JSON.parse(raw) as TraceStateFile;
      hint =
        state.pid === process.pid
          ? ` (state file lists target ${shortId(state.targetId)} but its live connection is gone)`
          : ` (trace was started by a DIFFERENT process pid=${state.pid}; live recordings cannot cross process boundaries)`;
    } catch {
      /* no state file */
    }
    throw new CdpError(
      `no in-process trace to stop${hint}. Use performanceTrace for a robust single-call trace.`,
    );
  }

  const { conn, target, events } = entry;
  try {
    await endTrace(conn, events);
  } finally {
    conn.close();
    liveTraces.delete(target.id);
    await unlink(stateFilePath()).catch(() => {});
  }

  const written = await writeTrace(events, target.id);
  const metrics = analyzeEvents(events);
  return { ...written, events: events.length, metrics };
}

/* ------------------------------------------------------------------ */
/* performanceTrace (PRIMARY one-shot — the smoke path)               */
/* ------------------------------------------------------------------ */

export interface PerformanceTraceArgs {
  target?: TargetSelector;
  /** how long to record after (optionally) reloading, ms. Default 3000. */
  durationMs?: number;
  /** reload the page after starting the trace (captures full nav timing). */
  reload?: boolean;
  /** navigate to this URL after starting the trace (alternative to reload). */
  navigateTo?: string;
  categories?: string[];
}

/**
 * One-shot trace: start → (reload/navigate) → wait → stop → write JSON. Holds a
 * single connection open for the whole window, so it is immune to the
 * cross-process limitation of start/stop. This is the recommended entry point.
 */
export async function performanceTrace(
  args: PerformanceTraceArgs = {},
): Promise<{ path: string; bytes: number; events: number; metrics: TraceMetrics; target: { id: string; url: string } }> {
  const durationMs = args.durationMs ?? 3_000;
  const categories = args.categories?.length ? args.categories : DEFAULT_CATEGORIES;
  const { conn, target } = await openPage(args.target);
  const events: TraceEvent[] = [];
  bufferTraceData(conn, events);

  try {
    await conn.send("Page.enable");
    await beginTrace(conn, categories);

    if (args.navigateTo) {
      const loaded = conn.waitFor("Page.loadEventFired", undefined, durationMs + 5_000);
      await conn.send("Page.navigate", { url: args.navigateTo });
      await loaded.catch(() => {});
    } else if (args.reload) {
      const loaded = conn.waitFor("Page.loadEventFired", undefined, durationMs + 5_000);
      await conn.send("Page.reload", { ignoreCache: false });
      await loaded.catch(() => {});
    }

    await new Promise((r) => setTimeout(r, durationMs));
    await endTrace(conn, events);
  } finally {
    conn.close();
  }

  const written = await writeTrace(events, target.id);
  const metrics = analyzeEvents(events);
  return { ...written, events: events.length, metrics, target: { id: target.id, url: target.url } };
}

/* ------------------------------------------------------------------ */
/* performanceAnalyzeInsight (CDP-native approximation)               */
/* ------------------------------------------------------------------ */

export interface PerformanceMetrics {
  /** navigationStart timestamp in trace-clock microseconds, if found. */
  navigationStartUs?: number;
  /** First Contentful Paint, ms after navigationStart. */
  fcpMs?: number;
  /** Largest Contentful Paint, ms after navigationStart. */
  lcpMs?: number;
  /** DOMContentLoaded, ms after navigationStart. */
  domContentLoadedMs?: number;
  /** load event, ms after navigationStart. */
  loadMs?: number;
  /** Cumulative Layout Shift score (sum of layout-shift scores w/o recent input). */
  cls?: number;
  /** Total Blocking Time: sum over long tasks of (dur_ms - 50), ms. */
  totalBlockingTimeMs: number;
}

export interface TraceMetrics {
  metrics: PerformanceMetrics;
  longTasks: number;
  longTasksTotalMs: number;
  layoutShifts: number;
  eventCount: number;
}

/**
 * Parse a raw Chrome trace event array into headline metrics. Pure function so
 * both the live tools and `performanceAnalyzeInsight` share one code path.
 */
export function analyzeEvents(events: TraceEvent[]): TraceMetrics {
  let navigationStartUs: number | undefined;
  let fcpUs: number | undefined;
  let lcpUs: number | undefined;
  let dclUs: number | undefined;
  let loadUs: number | undefined;
  let cls = 0;
  let layoutShifts = 0;
  let longTasks = 0;
  let longTasksTotalMs = 0;
  let totalBlockingTimeMs = 0;

  for (const e of events) {
    const name = e.name;
    if (!name) continue;

    // navigationStart: prefer the earliest marker we see.
    if (name === "navigationStart") {
      if (typeof e.ts === "number" && (navigationStartUs === undefined || e.ts < navigationStartUs)) {
        navigationStartUs = e.ts;
      }
      continue;
    }

    // First Contentful Paint marker.
    if ((name === "firstContentfulPaint" || name === "FirstContentfulPaint") && typeof e.ts === "number") {
      if (fcpUs === undefined || e.ts < fcpUs) fcpUs = e.ts;
      continue;
    }

    // LCP candidate — the LAST candidate before user input is the real LCP.
    if (name === "largestContentfulPaint::Candidate" && typeof e.ts === "number") {
      // candidates are monotonic; keep the latest timestamp seen.
      if (lcpUs === undefined || e.ts > lcpUs) lcpUs = e.ts;
      continue;
    }

    if ((name === "domContentLoadedEventEnd" || name === "DOMContentLoaded") && typeof e.ts === "number") {
      if (dclUs === undefined || e.ts > dclUs) dclUs = e.ts;
      continue;
    }

    if ((name === "loadEventEnd" || name === "MarkLoad") && typeof e.ts === "number") {
      if (loadUs === undefined || e.ts > loadUs) loadUs = e.ts;
      continue;
    }

    // Layout shifts — sum scores that did NOT follow recent user input.
    if (name === "LayoutShift") {
      const data = e.args?.data;
      const hadRecentInput = data?.had_recent_input === true;
      const score = typeof data?.score === "number" ? data.score : undefined;
      if (!hadRecentInput && typeof score === "number") {
        cls += score;
        layoutShifts += 1;
      }
      continue;
    }

    // Long tasks: complete ('X') RunTask events with dur > 50ms contribute to
    // TBT (the portion of each task beyond 50ms).
    if (name === "RunTask" && typeof e.dur === "number") {
      const durMs = e.dur / 1000;
      if (durMs > 50) {
        longTasks += 1;
        longTasksTotalMs += durMs;
        totalBlockingTimeMs += durMs - 50;
      }
      continue;
    }
  }

  const relMs = (us: number | undefined): number | undefined =>
    us !== undefined && navigationStartUs !== undefined ? (us - navigationStartUs) / 1000 : undefined;

  const metrics: PerformanceMetrics = {
    navigationStartUs,
    fcpMs: relMs(fcpUs),
    lcpMs: relMs(lcpUs),
    domContentLoadedMs: relMs(dclUs),
    loadMs: relMs(loadUs),
    cls: layoutShifts > 0 ? Number(cls.toFixed(4)) : 0,
    totalBlockingTimeMs: Number(totalBlockingTimeMs.toFixed(2)),
  };

  return {
    metrics,
    longTasks,
    longTasksTotalMs: Number(longTasksTotalMs.toFixed(2)),
    layoutShifts,
    eventCount: events.length,
  };
}

export interface PerformanceAnalyzeInsightArgs {
  /** Path to a trace JSON written by performanceTrace/performanceStopTrace. */
  tracePath?: string;
}

/**
 * CDP-native approximation of the MCP insight analyzer. Reads a trace JSON file
 * (bare array OR { traceEvents: [...] }) and returns structured headline
 * metrics. If `tracePath` is omitted, throws — there is no implicit "latest
 * trace" magic; callers pass the path returned by a trace tool.
 */
export async function performanceAnalyzeInsight(
  args: PerformanceAnalyzeInsightArgs = {},
): Promise<TraceMetrics & { tracePath: string }> {
  if (!args.tracePath) {
    throw new CdpError("performanceAnalyzeInsight requires { tracePath } pointing at a trace JSON file");
  }
  let raw: string;
  try {
    raw = await readFile(args.tracePath, "utf8");
  } catch (err) {
    throw new CdpError(`cannot read trace file '${args.tracePath}': ${(err as Error).message}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new CdpError(`trace file '${args.tracePath}' is not valid JSON: ${(err as Error).message}`);
  }
  const events: TraceEvent[] = Array.isArray(parsed)
    ? (parsed as TraceEvent[])
    : Array.isArray((parsed as { traceEvents?: unknown }).traceEvents)
      ? ((parsed as { traceEvents: TraceEvent[] }).traceEvents)
      : (() => {
          throw new CdpError(`trace file '${args.tracePath}' has no traceEvents array`);
        })();

  return { ...analyzeEvents(events), tracePath: args.tracePath };
}

/*
 * CDP methods/domains used:
 *   - Tracing.start (traceConfig.includedCategories, transferMode:ReportEvents)
 *   - Tracing.dataCollected   (event — buffered into the event array)
 *   - Tracing.end
 *   - Tracing.tracingComplete (event — awaited to know recording is flushed)
 *   - Page.enable / Page.navigate / Page.reload / Page.loadEventFired (one-shot reload path)
 *
 * Parity gaps vs chrome-devtools-mcp performance tools:
 *   - performance_start_trace/performance_stop_trace work only WITHIN one process
 *     (a live CDP trace buffer is bound to its connection and cannot be re-attached
 *     cross-process); performanceTrace is the robust single-call alternative.
 *   - performance_analyze_insight is a CDP-native APPROXIMATION: it parses raw trace
 *     events rather than running DevTools' Trace Engine, so FCP/LCP/CLS/TBT are close
 *     but not byte-identical (no main-thread attribution, frame-scoped LCP, or
 *     soft-navigation handling; no named "insights"/recommendations).
 *   - We do not auto-discover the "latest" trace; analyze requires an explicit tracePath.
 *   - No CPU/network throttle presets applied during the trace (the MCP tool can stage
 *     a Lighthouse-style throttled environment); emulation is left to emulation.ts.
 */
