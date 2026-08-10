/**
 * recorder.ts: the stateful console+network capture engine.
 *
 * RECORDER MODEL
 * ==============
 * A recorder holds ONE persistent page connection (via `openPage`, never closed
 * until `stop()`), enables the relevant CDP domains, and appends every relevant
 * event as a single-line JSON object ("JSON Lines") to a per-target buffer file:
 *
 *     ${ARTIFACT_DIR}/rec-<targetId>.jsonl
 *
 * Each line is one CDP event, wrapped with a discriminator so the console/network
 * readers can cheaply filter the same file:
 *
 *     { "kind": "network" | "console", "method": "<CDP event>", "ts": <ms>, "params": { ... } }
 *
 * Domains enabled per option:
 *   - network: Network.enable        -> Network.requestWillBeSent, .responseReceived,
 *                                       .loadingFinished, .loadingFailed
 *   - console: Runtime.enable        -> Runtime.consoleAPICalled, .exceptionThrown
 *              Log.enable            -> Log.entryAdded   (browser-surfaced messages)
 *
 * CAPTURE MODEL (what the tool surface actually uses)
 * ---------------------------------------------------
 * The console/network tools drive `captureWindow()`, a one-shot reload capture
 * that records BOTH domains into a UNIQUE per-capture file
 * (`rec-<targetId>-<captureId>.jsonl`) and, on stop, publishes that capture as
 * the target's shared "latest" buffer (`rec-<targetId>.jsonl`). Capturing both
 * domains every time means a network capture never clobbers console history
 * (and vice-versa); the per-capture file means two concurrent captures against
 * the same target can't interleave into one another's results.
 *
 * BACKGROUND RECORDING (library-only)
 * -----------------------------------
 * `startRecorder({ truncate: false })` opens a long-lived appending recorder.
 * This is reachable from the library API but NOT wired to a CLI tool (a stateless
 * CLI process can't keep it alive across invocations); the CLI surface is
 * reload-driven via `captureWindow`. `startRecorder` resolves only AFTER the CDP
 * domains are enabled, so a caller can trigger navigation/reload immediately and
 * be sure events are caught.
 *
 * SERVICE WORKERS (1.9.1)
 * -----------------------
 * A `worker:<substring>` (or bare worker-id) target records the same two domains
 * over the worker's OWN connection, which is the whole point of the feature: the
 * outbound fetch an MV3 background worker makes is a Network event on that
 * session and nothing else can see it reliably. Measured on Chrome 151.0.7922.109
 * before any of this was written:
 *
 *   - `Network.enable` succeeds on a direct worker connection and
 *     requestWillBeSent / responseReceived / loadingFinished all arrive for a
 *     fetch the worker performs; `Network.getResponseBody` serves its body.
 *   - `Runtime.consoleAPICalled` delivers the worker's console.log on the same
 *     session. (`Log.enable` also succeeds but emits nothing there.)
 *   - `Page.enable` and `Page.reload` DO NOT EXIST on a worker session: both
 *     answer `-32601 ... wasn't found`. So a worker capture window cannot be
 *     reload-driven, and this module skips both instead of catching a failure —
 *     the window simply LISTENS for durationMs while the worker runs.
 *   - A held session SUPPRESSES MV3 idle-eviction (measured: alive and still
 *     emitting Network events after 60s held; evicted ~30s after the detach). A
 *     recording therefore keeps the worker alive for exactly as long as it runs,
 *     which is a documented side effect of these tools, not an accident.
 *   - An evicted worker that is woken has ALREADY run its top-level code by the
 *     time the recorder attaches, so a request the worker makes at startup can be
 *     missed. Trigger the work you want to observe during the window.
 */
import { mkdir, appendFile, writeFile, copyFile } from "node:fs/promises";
import { CdpError, listTargets, openPage, resolveTarget } from "../client.ts";
import type { CdpConnection } from "../client.ts";
import { resolveWorkerSelector } from "../cdp/workers.ts";
import type { Target, TargetSelector } from "../types.ts";
import {
  isWorkerSelector,
  isWorkerTargetType,
  resolveWorkerTargets,
  workerAmbiguityMessage,
  workerBufferReadMissMessage,
  workerNeedle,
  workerWakeMisuseMessage,
  WORKER_EMPTY_NEEDLE_MESSAGE,
} from "../workers.ts";

/** Artifact / buffer directory (shared with the rest of the toolkit). */
export const ARTIFACT_DIR = process.env.CDP_ARTIFACT_DIR ?? "/tmp/cdp-toolkit";

/** Compute the shared "latest" JSONL buffer path for a given targetId. */
export function recFile(targetId: string): string {
  return `${ARTIFACT_DIR}/rec-${targetId}.jsonl`;
}

/** Compute a unique per-capture JSONL buffer path (isolates concurrent captures). */
export function captureFile(targetId: string, captureId: string): string {
  return `${ARTIFACT_DIR}/rec-${targetId}-${captureId}.jsonl`;
}

/** Sleep helper (module runtime only; not the workflow-script sandbox). */
function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/* ------------------------- worker targets (1.9.1) ------------------------- */

/**
 * Resolve the target for a console/network call, which is the ONE place the
 * three reader tools differ from every other tool: a capture may start a
 * stopped worker, a read never may.
 *
 * `capture: true`  — a recording is about to be made, so a `worker:` selector
 *   goes through the waking resolver (Chrome-only, `cdp/workers.ts`), default
 *   wake:true, exactly like evaluate_script.
 * `capture: false` — an existing buffer is about to be read, so the same
 *   selector resolves against the RUNNING workers only, and a miss gets the
 *   read-path message rather than a promise that waking would help (it would
 *   not: the buffer is keyed by a target id the restart re-mints).
 *
 * Non-worker selectors are untouched: they go through client.ts's resolveTarget,
 * lease gate and all.
 */
export async function resolveRecorderTarget(
  target: TargetSelector,
  opts: { capture: boolean; wake?: boolean },
): Promise<Target> {
  if (!isWorkerSelector(target)) return resolveTarget(target);
  if (opts.capture) return resolveWorkerSelector(target, { wake: opts.wake ?? true });

  const needle = workerNeedle(target);
  if (needle === "") throw new CdpError(WORKER_EMPTY_NEEDLE_MESSAGE);
  const { matches, liveWorkers } = resolveWorkerTargets(await listTargets(), needle);
  if (matches.length > 1) throw new CdpError(workerAmbiguityMessage(needle, matches));
  if (matches.length === 1) return matches[0]!;
  throw new CdpError(workerBufferReadMissMessage(needle, liveWorkers));
}

/**
 * Validate `wake` for the three reader tools. It is REFUSED where it would do
 * nothing rather than accepted and ignored — the evaluate_script precedent: an
 * accepted argument reads as "this call will wake something", and a caller who
 * is wrong about that never finds out.
 */
export function assertWakeApplies(target: TargetSelector, wake: boolean | undefined, capture: boolean): void {
  if (wake === undefined) return;
  if (typeof wake !== "boolean") throw new CdpError("'wake' must be a boolean");
  if (!isWorkerSelector(target)) throw new CdpError(workerWakeMisuseMessage("not-a-worker-selector"));
  if (!capture) throw new CdpError(workerWakeMisuseMessage("read-only-call"));
}

/** Network CDP events we persist. */
const NETWORK_EVENTS = [
  "Network.requestWillBeSent",
  "Network.responseReceived",
  "Network.loadingFinished",
  "Network.loadingFailed",
] as const;

/** Console / log CDP events we persist. */
const CONSOLE_EVENTS = ["Runtime.consoleAPICalled", "Runtime.exceptionThrown", "Log.entryAdded"] as const;

/** A single persisted line in a rec-<targetId>.jsonl buffer. */
export interface RecLine {
  kind: "network" | "console";
  method: string;
  ts: number;
  params: Record<string, unknown>;
}

export interface RecorderOptions {
  /** Capture Network.* events (default true). */
  network?: boolean;
  /** Capture Runtime/Log console events (default true). */
  console?: boolean;
  /** Truncate the buffer file before recording (fresh capture window). */
  truncate?: boolean;
  /** Override the buffer file path (defaults to the shared recFile(targetId)). */
  file?: string;
  /** Per-command timeout override forwarded to the connection. */
  timeoutMs?: number;
}

export interface RecorderHandle {
  /** Await all in-flight appends WITHOUT closing the connection (so bodies stay fetchable). */
  flush(): Promise<void>;
  /** Flush, then close the connection (events stop, file stays). */
  stop(): Promise<void>;
  /** The JSONL buffer file being written. */
  file: string;
  /** The resolved target this recorder is attached to. */
  target: Target;
  /** The live connection (exposed so a one-shot caller can drive Page.reload on it). */
  conn: CdpConnection;
  /** Count of buffer-write failures observed (0 on a healthy capture). */
  droppedWrites(): number;
}

/**
 * Start a persistent recorder against `target`. Enables the requested domains
 * and begins appending matching events to the per-target JSONL buffer. The
 * returned handle's `stop()` closes the connection (events stop, file stays).
 */
export async function startRecorder(target: TargetSelector, opts: RecorderOptions = {}): Promise<RecorderHandle> {
  const network = opts.network ?? true;
  const consoleCap = opts.console ?? true;

  await mkdir(ARTIFACT_DIR, { recursive: true });
  const { conn, target: resolved } = await openPage(target, { timeoutMs: opts.timeoutMs });
  const file = opts.file ?? recFile(resolved.id);

  if (opts.truncate) {
    await writeFile(file, "");
  }

  // Serialize appends so concurrent events never interleave a partial line.
  let chain: Promise<void> = Promise.resolve();
  let dropped = 0;
  const persist = (kind: RecLine["kind"], method: string, params: Record<string, unknown>): void => {
    const line: RecLine = { kind, method, ts: Date.now(), params };
    const text = `${JSON.stringify(line)}\n`;
    chain = chain.then(() => appendFile(file, text)).catch(() => {
      // Buffer-write failures are tolerated (capture is best-effort) but counted
      // so callers can surface under-capture instead of silently returning fewer rows.
      dropped += 1;
    });
  };

  const unsubs: Array<() => void> = [];

  try {
    if (network) {
      await conn.send("Network.enable");
      for (const ev of NETWORK_EVENTS) {
        unsubs.push(conn.on(ev, (params) => persist("network", ev, params)));
      }
    }
    if (consoleCap) {
      await conn.send("Runtime.enable");
      // Log domain is optional on some targets; tolerate failure.
      try {
        await conn.send("Log.enable");
      } catch {
        /* Log not supported on this target type; Runtime events still flow */
      }
      for (const ev of CONSOLE_EVENTS) {
        unsubs.push(conn.on(ev, (params) => persist("console", ev, params)));
      }
    }
  } catch (err) {
    conn.close();
    throw err;
  }

  // Stop accepting new events, then let queued appends settle, without closing
  // the connection (response bodies stay fetchable on `conn`).
  const flush = async (): Promise<void> => {
    for (const off of unsubs) off();
    await chain;
  };

  return {
    file,
    target: resolved,
    conn,
    droppedWrites: () => dropped,
    flush,
    async stop(): Promise<void> {
      await flush();
      conn.close();
    },
  };
}

/**
 * One-shot capture used by the console/network tools. Records BOTH domains into
 * a unique per-capture file, waits `durationMs`, and (on stop) publishes the
 * capture as the target's shared "latest" buffer. The returned handle keeps the
 * connection open until `stop()`, so a caller can `flush()` then fetch response
 * bodies before closing.
 *
 * A PAGE window reloads to generate the traffic. A WORKER window does not (and
 * cannot: `Page.*` is absent on a worker session) — it listens while the worker
 * runs, and the session it holds keeps that worker from being idle-evicted for
 * the length of the window.
 */
export interface CaptureWindow {
  /** The unique per-capture buffer file (read this for isolated results). */
  file: string;
  /** Live connection (open until stop), for Network.getResponseBody etc. */
  conn: CdpConnection;
  /** Resolved target identity. */
  resolved: { id: string; url: string; title: string };
  /** How the window was driven: "reload" for a page, "listen" for a worker. */
  mode: "reload" | "listen";
  /** Buffer-write failure count. */
  droppedWrites(): number;
  /** Await in-flight appends without closing (bodies stay fetchable). */
  flush(): Promise<void>;
  /** Flush, publish to the shared latest buffer, and close the connection. */
  stop(): Promise<void>;
}

export async function captureWindow(
  target: TargetSelector,
  durationMs: number,
  opts: { timeoutMs?: number; wake?: boolean } = {},
): Promise<CaptureWindow> {
  const resolved = await resolveRecorderTarget(target, { capture: true, wake: opts.wake });
  // A WORKER window is "listen", not "reload": Page.enable/Page.reload answer
  // -32601 on a worker session (measured), and there is nothing to reload
  // anyway — the caller triggers the worker's work during the window. Keyed off
  // the RESOLVED TYPE rather than the selector shape, so a bare worker target id
  // takes the same branch as `worker:<substring>`.
  const isWorker = isWorkerTargetType(resolved.type);
  const captureId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const file = captureFile(resolved.id, captureId);
  // Record both domains so neither tool clobbers the other's history.
  const rec = await startRecorder(resolved.id, {
    network: true,
    console: true,
    truncate: true,
    file,
    timeoutMs: opts.timeoutMs,
  });
  if (!isWorker) {
    await rec.conn.send("Page.enable");
    await rec.conn.send("Page.reload", { ignoreCache: false });
  }
  await delay(durationMs);
  return {
    file: rec.file,
    conn: rec.conn,
    resolved: { id: rec.target.id, url: rec.target.url, title: rec.target.title },
    mode: isWorker ? "listen" : "reload",
    droppedWrites: rec.droppedWrites,
    flush: () => rec.flush(),
    async stop(): Promise<void> {
      await rec.stop();
      // Publish this capture as the target's shared "latest" buffer (best-effort),
      // so a later default (reload:false) read surfaces the most recent capture.
      try {
        await copyFile(rec.file, recFile(rec.target.id));
      } catch {
        /* shared-buffer publish is best-effort */
      }
    },
  };
}

/*
 * CDP methods / domains used:
 *   Network.enable
 *   Network.requestWillBeSent (event)
 *   Network.responseReceived (event)
 *   Network.loadingFinished (event)
 *   Network.loadingFailed (event)
 *   Runtime.enable
 *   Runtime.consoleAPICalled (event)
 *   Runtime.exceptionThrown (event)
 *   Log.enable
 *   Log.entryAdded (event)
 *   Page.enable / Page.reload   (PAGE capture windows only: absent on a worker)
 *   ServiceWorker.enable / .startWorker  (via cdp/workers.ts, worker wake only)
 *
 * Parity gaps vs chrome-devtools-mcp:
 *   - Buffering is to a per-target JSONL file on disk, not an in-memory ring; the
 *     MCP keeps an in-process buffer scoped to its single managed page.
 *   - No automatic resource-type / initiator enrichment beyond raw CDP params.
 */
