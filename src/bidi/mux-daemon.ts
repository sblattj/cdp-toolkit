/**
 * The detached BiDi mux DAEMON: a tiny process whose only job is to OWN Firefox's single
 * WebDriver-BiDi session and serve it to every cdp-toolkit process through a loopback mux (./mux.ts).
 *
 * WHY IT IS A SEPARATE PROCESS. Firefox 153.0.3 regenerates EVERY top-level browsing-context id
 * whenever its one BiDi session is re-created — measured: a clean session.end + session.new keeps
 * the tab (same url) but browsingContext.getTree reports a new id; a SIGKILLed holder is worse, as
 * Firefox never reaps the dead session at all and only a Marionette WebDriver:DeleteSession frees
 * it. So while the session lived inside a client process, the moment that client exited — even
 * cleanly, e.g. the first agent session finishing while a second is mid-task — every other client's
 * cached target ids, tab leases and origin records went stale. Hosting the session here means no
 * client's lifetime is the session's lifetime.
 *
 * WHY IT STILL EXITS. A daemon nobody asked for is a leak, so it exits as soon as it is unused:
 * CDP_FIREFOX_MUX_IDLE_MS (default 15s) with zero clients, counted from startup too, so a spawner
 * that dies before connecting leaves nothing behind. It also exits when Firefox goes away or on a
 * signal, always through the same dispose (mux close -> session.end -> slot release).
 *
 * Argv: <endpoint> <spawnerPid>. Env read exactly as the driver reads it (CDP_ARTIFACT_DIR,
 * CDP_FIREFOX_MARIONETTE_PORT, CDP_FIREFOX_SESSION_WAIT_MS), plus CDP_FIREFOX_MUX_IDLE_MS.
 * Spawned detached with stdio:"ignore", so it has NO console: every diagnostic goes to
 * <leaseDir()>/ff-mux-<safeEndpoint>.log, best-effort, never throwing.
 */
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { muxDaemonLogFile } from "./session-lease.ts";

const DEFAULT_IDLE_MS = 15_000;
const CLIENT_POLL_MS = 500;
const DISPOSE_TIMEOUT_MS = 10_000;

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

const endpoint = process.argv[2];
const spawnerPid = process.argv[3] ?? "?";

function idleMs(): number {
  const raw = Number(process.env.CDP_FIREFOX_MUX_IDLE_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_IDLE_MS;
}

/** Append one diagnostic line. Never throws: a daemon must not die because a log write failed. */
function log(line: string): void {
  if (!endpoint) return;
  try {
    const file = muxDaemonLogFile(endpoint);
    mkdirSync(dirname(file), { recursive: true });
    appendFileSync(file, `${new Date().toISOString()} pid=${process.pid} ${line}\n`);
  } catch {
    /* best effort */
  }
}

function fail(reason: string): never {
  log(`EXIT(1) ${reason}`);
  process.exit(1);
}

async function main(): Promise<void> {
  if (!endpoint) fail("no endpoint argument");
  // Must be set BEFORE the driver module is imported so its holder path is the one that runs;
  // this is also the flag hostFirefoxMux asserts on.
  process.env.CDP_FIREFOX_MUX = "host";
  log(`start endpoint=${endpoint} spawner=${spawnerPid} idleMs=${idleMs()}`);

  const { hostFirefoxMux } = await import("./driver.ts");
  let hosted: Awaited<ReturnType<typeof hostFirefoxMux>>;
  try {
    hosted = await hostFirefoxMux(endpoint, { label: `mux-daemon(spawned by pid ${spawnerPid})` });
  } catch (e) {
    // Busy slot, a racing daemon that won (arrives as a join), Marionette unavailable, dial error.
    // Every one of these is "this daemon is not the holder", and the spawner's fallback path
    // reproduces the actionable error in-process. Nothing was written that is not ours to write.
    fail(`could not host: ${e instanceof Error ? e.message : String(e)}`);
  }
  log(`advertised mux=${hosted.mux.endpoint}`);

  let shuttingDown = false;
  const shutdown = async (reason: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    clearInterval(timer);
    log(`shutdown begin: ${reason}`);
    // BOUNDED. dispose() closes the mux's listening socket, and node's server.close() only calls
    // back once every accepted connection is gone — a client that connects while we are closing can
    // therefore hold it open indefinitely. A daemon that cannot die is worse than one that dies
    // without a clean session.end (the slot record it leaves behind carries a DEAD pid, which the
    // next process steals and force-clears over Marionette, the existing #4 recovery path). So the
    // teardown gets a deadline and we exit either way.
    await Promise.race([hosted.dispose().catch(() => undefined), sleep(DISPOSE_TIMEOUT_MS)]);
    log(`EXIT(0) ${reason}`);
    process.exit(0);
  };

  // Idle exit. The clock starts NOW, not at the first client, so a spawner that never connects
  // (crashed, or fell back) cannot leave a daemon behind.
  let idleSince: number | undefined = Date.now();
  const timer = setInterval(() => {
    if (shuttingDown) return;
    if (!hosted.conn.isOpen) {
      void shutdown("upstream Firefox connection closed");
      return;
    }
    if (hosted.mux.clients() > 0) {
      idleSince = undefined;
      return;
    }
    if (idleSince === undefined) idleSince = Date.now();
    if (Date.now() - idleSince >= idleMs()) void shutdown(`idle for ${idleMs()}ms with no clients`);
  }, Math.max(50, Math.min(CLIENT_POLL_MS, Math.floor(idleMs() / 4))));

  for (const sig of ["SIGTERM", "SIGINT", "SIGHUP"] as const) {
    process.on(sig, () => void shutdown(`signal ${sig}`));
  }
  // A dispose on the way out of an unexpected throw, so we never strand Firefox's session.
  process.on("uncaughtException", (e) => {
    log(`uncaught: ${e instanceof Error ? e.message : String(e)}`);
    void shutdown("uncaught exception");
  });
}

void main().catch((e: unknown) => fail(`startup threw: ${e instanceof Error ? e.message : String(e)}`));
