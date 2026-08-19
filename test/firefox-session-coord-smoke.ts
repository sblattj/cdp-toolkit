/**
 * Firefox cross-process BiDi SESSION-coordination end-to-end smoke — the live CEV
 * for issues #4 and #5, against a REAL Firefox. NO mocks, NO stubbed pids.
 *
 * WHAT THIS PROVES that no unit test can. session-coord.test.ts drives the
 * getConnection lease logic deterministically by pre-seeding the on-disk slot and
 * dialing a dead port; it deliberately never launches a browser. The two things it
 * leaves for this file are exactly the two that ARE the feature:
 *   - #4 headline: a process that opened a real BiDi session and was KILLED without
 *     session.end leaves Firefox holding an orphaned session AND a dead-pid slot
 *     lease. A fresh process must auto-recover — steal the dead lease, force-clear
 *     the orphan over Marionette (WITHOUT killing Firefox), retry session.new — and
 *     SUCCEED. Firefox must be the SAME pid afterwards (recovery never restarts it).
 *   - #5: two genuinely-live processes contending for the one BiDi session slot of a
 *     single user-launched Firefox. The second must fail FAST with a distinguishable
 *     "held by a LIVE process" error naming the endpoint — not hang, not the raw
 *     "Maximum number of active sessions" wedge — and must SUCCEED once the holder
 *     is gone.
 *
 * WHY REAL SEPARATE PROCESSES. The whole mechanism is a FILE lease keyed by
 * endpoint, whose staleness test is pid-liveness. A dead pid is instantly
 * reclaimable, so two sequential calls in one process never collide, and an
 * in-process test can only ever seed a fake record. Proving it needs a long-lived
 * OWNER/HOLDER process with a real, different pid and a doomed ORPHAN process with a
 * real, dead one, all pointed at the same Firefox and the same CDP_ARTIFACT_DIR.
 * This file is every one of those roles, selected by --role, and the parent spawns
 * the others as real children of itself. Every process drives the REAL product path
 * (backend.ts resolveFirefoxEndpoint -> startFirefoxSession -> driver.listPages,
 * which routes through the getConnection coordination choke point).
 *
 * SAFETY. WE launch ONE throwaway-profile headless Firefox on OS-assigned ephemeral
 * ports (a debug port for BiDi and a Marionette port set via the `marionette.port`
 * pref, so nothing ever collides with a developer's own Firefox or the default
 * 2828). WE own that process and SIGKILL it by the pid we spawned in `finally`; the
 * product code deliberately never closes a browser it attached to. A hard
 * wall-clock cap kills it and exits non-zero if anything hangs, so this can never
 * leak a browser or wedge CI. The private CDP_ARTIFACT_DIR and the profile dir are
 * removed on exit. If the Firefox binary is absent this prints SKIP and exits 0,
 * like the repo's other browser-gated smokes.
 *
 * Run with `bun run firefox:coord:smoke`. One PASS/FAIL line per scenario; exits
 * non-zero naming every failure.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createConnection, createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { resolveFirefoxEndpoint, startFirefoxSession, type FirefoxSession } from "../src/backend.ts";
import { readSessionSlot } from "../src/bidi/session-lease.ts";
import { connectBidiSessionUrl } from "../src/bidi/client.ts";

const SELF = fileURLToPath(import.meta.url);

function argValue(flag: string): string | undefined {
  const hit = process.argv.find((a) => a.startsWith(`${flag}=`));
  return hit === undefined ? undefined : hit.slice(flag.length + 1);
}
const ROLE = argValue("--role") ?? "parent";

/* ------------------------------ cross-process error identity ------------------------------ */
interface ErrId {
  name: string | null;
  code: string | null;
  message: string;
}
/** Flatten an error into something that survives the JSON hop from a child to the parent.
 *  A DriverError carries `.code` (e.g. "disconnected"); that is the field the assertions gate on. */
function identify(err: unknown): ErrId {
  const e = err as { name?: unknown; code?: unknown; message?: unknown } | null;
  return {
    name: typeof e?.name === "string" ? e.name : null,
    code: e?.code === undefined || e?.code === null ? null : String(e.code),
    message: typeof e?.message === "string" ? e.message : String(err),
  };
}

/* =========================================================================================
 * CHILD ROLES. Each attaches to the shared Firefox through the real product path and reports
 * one JSON line on stdout. The endpoint, the shared artifact dir, and (per role) the
 * Marionette port all arrive through the inherited spawn env — the same env a real MCP server
 * process would read.
 * ========================================================================================= */

/** One-shot attacher: attach, do a real tool call (listPages -> getConnection coordination),
 *  report {ok,...}, then ALWAYS dispose (session.end frees Firefox's slot + releases our lease)
 *  and exit. `ms` times only the attach attempt, so the #5 "fails fast" assertion is honest. */
async function runProbe(): Promise<void> {
  const started = Date.now();
  let session: FirefoxSession | undefined;
  let result: Record<string, unknown>;
  try {
    const endpoint = resolveFirefoxEndpoint([], process.env);
    if (!endpoint) throw new Error("probe: no endpoint resolved from CDP_FIREFOX_ENDPOINT");
    session = await startFirefoxSession({ endpoint });
    const pages = await session.driver.listPages();
    result = { ok: true, pid: process.pid, pages: pages.length, ms: Date.now() - started };
  } catch (err) {
    result = { ok: false, pid: process.pid, ms: Date.now() - started, err: identify(err) };
  }
  try {
    if (session) await session.dispose();
  } catch {
    /* best effort: attach mode never closes the browser, only the session */
  }
  process.stdout.write(`${JSON.stringify(result)}\n`, () => process.exit(0));
}

/** ORPHAN: attach, open a real session (writes a slot lease under OUR pid + the env Marionette
 *  port), announce ready, then hang forever WITHOUT ever disposing. The parent SIGKILLs it, which
 *  leaves Firefox holding the orphaned session and the lease stamped with a now-dead pid — the
 *  exact wedge #4 recovery must clear. */
async function runOrphan(): Promise<void> {
  try {
    const endpoint = resolveFirefoxEndpoint([], process.env);
    if (!endpoint) throw new Error("orphan: no endpoint resolved");
    const session = await startFirefoxSession({ endpoint });
    await session.driver.listPages();
    process.stdout.write(`${JSON.stringify({ ok: true, pid: process.pid })}\n`);
    setInterval(() => {}, 1 << 30); // stay alive so our pid stays live until the parent kills us
  } catch (err) {
    process.stdout.write(`${JSON.stringify({ ok: false, pid: process.pid, err: identify(err) })}\n`, () => process.exit(1));
  }
}

/** HOLDER: attach and keep a genuinely-LIVE session open (its pid stays alive → #5 contention).
 *  On a stdin {op:"release"} it disposes CLEANLY (session.end + slot release) and exits, which is
 *  the clean cross-process handoff scenario. If instead the parent SIGKILLs it, it dies without
 *  disposing (the orphan path), which is the #5 "holder gone, retry recovers" scenario. */
async function runHolder(): Promise<void> {
  let session: FirefoxSession | undefined;
  try {
    const endpoint = resolveFirefoxEndpoint([], process.env);
    if (!endpoint) throw new Error("holder: no endpoint resolved");
    session = await startFirefoxSession({ endpoint });
    await session.driver.listPages();
    process.stdout.write(`${JSON.stringify({ ok: true, pid: process.pid })}\n`);
  } catch (err) {
    process.stdout.write(`${JSON.stringify({ ok: false, pid: process.pid, err: identify(err) })}\n`, () => process.exit(1));
    return;
  }
  const rl = createInterface({ input: process.stdin });
  for await (const line of rl) {
    let cmd: { op?: string };
    try {
      cmd = JSON.parse(line) as { op?: string };
    } catch {
      continue;
    }
    if (cmd.op === "release") {
      await session.dispose().catch(() => undefined);
      process.stdout.write(`${JSON.stringify({ released: true, pid: process.pid })}\n`, () => process.exit(0));
      return;
    }
    if (cmd.op === "exit") break;
  }
  process.exit(0);
}

/* =========================================================================================
 * PARENT (orchestrator)
 * ========================================================================================= */

const WALL_CLOCK_MS = 180_000;
const EXPECTED_MARIONETTE_DEFAULT = 2828; // documented default; we deliberately do NOT use it

type Check = { name: string; ok: boolean; detail: string };
const checks: Check[] = [];
function record(name: string, ok: boolean, detail: string): void {
  checks.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"} ${name}: ${detail}`);
}

function resolveFirefoxBinary(): string {
  const fromEnv = process.env.FIREFOX_BIN;
  if (fromEnv) return fromEnv;
  const mac = "/Applications/Firefox.app/Contents/MacOS/firefox";
  if (existsSync(mac)) return mac;
  return "firefox"; // PATH
}
function firefoxAvailable(bin: string): boolean {
  if (bin.includes("/")) return existsSync(bin);
  // PATH fallback: a best-effort which; if we cannot resolve it, treat as absent → SKIP.
  const paths = (process.env.PATH ?? "").split(":");
  return paths.some((p) => p && existsSync(join(p, bin)));
}

/** Bind an OS-assigned ephemeral port, read it, release it. Same as firefox-attach-smoke's
 *  pickFreePort — a fixed port would collide with a developer's browser or a concurrent run. */
function pickFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const addr = probe.address();
      if (addr === null || typeof addr === "string") {
        probe.close();
        reject(new Error("failed to allocate a port"));
        return;
      }
      const { port } = addr;
      probe.close(() => resolve(port));
    });
  });
}
/** Wait until a TCP port actually accepts a connection. Never a fixed sleep. */
function pollPort(port: number, deadlineMs: number, label: string): Promise<void> {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const attempt = (): void => {
      const sock = createConnection({ port, host: "127.0.0.1" });
      sock.once("connect", () => {
        sock.destroy();
        resolve();
      });
      sock.once("error", () => {
        sock.destroy();
        if (Date.now() - start >= deadlineMs) {
          reject(new Error(`${label} port ${port} did not accept a connection within ${deadlineMs}ms`));
          return;
        }
        setTimeout(attempt, 100);
      });
    };
    attempt();
  });
}
/** Existence check on a pid: signal 0 sends nothing, it only asks the kernel whether the process
 *  is still there. This is how "recovery did NOT restart Firefox" is observed. */
function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false; // ESRCH
  }
}

/** Owner-side handle on a spawned child, line-oriented request/reply queue (from lease-smoke.ts). */
class Child {
  readonly proc: ChildProcess;
  private readonly queued: string[] = [];
  private readonly waiting: Array<(line: string) => void> = [];
  constructor(
    readonly role: string,
    opts: { env?: Record<string, string>; args?: string[] } = {},
  ) {
    this.proc = spawn(process.execPath, [SELF, `--role=${role}`, ...(opts.args ?? [])], {
      env: { ...process.env, ...(opts.env ?? {}) },
      stdio: ["pipe", "pipe", "inherit"],
    });
    liveChildren.add(this);
    this.proc.once("exit", () => liveChildren.delete(this));
    createInterface({ input: this.proc.stdout! }).on("line", (line) => {
      const w = this.waiting.shift();
      if (w) w(line);
      else this.queued.push(line);
    });
  }
  get pid(): number {
    return this.proc.pid ?? -1;
  }
  nextLine(timeoutMs = 60_000): Promise<string> {
    const ready = this.queued.shift();
    if (ready !== undefined) return Promise.resolve(ready);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`timed out after ${timeoutMs}ms waiting for the ${this.role} child`)), timeoutMs);
      this.waiting.push((line) => {
        clearTimeout(timer);
        resolve(line);
      });
    });
  }
  async json<T = Record<string, unknown>>(timeoutMs?: number): Promise<T> {
    return JSON.parse(await this.nextLine(timeoutMs)) as T;
  }
  writeLine(obj: unknown): void {
    try {
      this.proc.stdin!.write(`${JSON.stringify(obj)}\n`);
    } catch {
      /* already gone */
    }
  }
  kill(sig: NodeJS.Signals): void {
    try {
      this.proc.kill(sig);
    } catch {
      /* already gone */
    }
  }
  exited(): Promise<number> {
    if (this.proc.exitCode !== null) return Promise.resolve(this.proc.exitCode);
    return new Promise((resolve) => this.proc.once("exit", (code) => resolve(code ?? -1)));
  }
}

const liveChildren = new Set<Child>();

let firefox: ChildProcess | undefined;
let firefoxPid: number | undefined;
let profilePath: string | undefined;
let artifactDir: string | undefined;

const hardTimer = setTimeout(() => {
  console.error(`FAIL wall-clock cap: did not finish within ${WALL_CLOCK_MS}ms; killing everything and exiting`);
  cleanup();
  process.exit(1);
}, WALL_CLOCK_MS);

function cleanup(): void {
  for (const c of liveChildren) c.kill("SIGKILL");
  if (firefoxPid !== undefined) {
    try {
      process.kill(firefoxPid, "SIGKILL");
    } catch {
      /* already gone */
    }
  }
  if (profilePath !== undefined) rmSync(profilePath, { recursive: true, force: true });
  if (artifactDir !== undefined) rmSync(artifactDir, { recursive: true, force: true });
}

async function runParent(): Promise<void> {
  const binary = resolveFirefoxBinary();
  if (!firefoxAvailable(binary)) {
    clearTimeout(hardTimer);
    console.log(`SKIP firefox-session-coord-smoke: Firefox binary not found (looked for ${binary}). Set FIREFOX_BIN to run.`);
    process.exit(0);
  }

  // --- shared state every process agrees on ---
  const rdpPort = await pickFreePort();
  let marionettePort = await pickFreePort();
  while (marionettePort === rdpPort) marionettePort = await pickFreePort();
  artifactDir = mkdtempSync(join(tmpdir(), "cdp-ff-coord-artifacts-"));
  profilePath = mkdtempSync(join(tmpdir(), "cdp-ff-coord-profile-"));
  // Control the Marionette port via the profile pref so it never collides with the default 2828 or
  // a developer's own Firefox. `--marionette` enables Marionette; this pref chooses its port.
  writeFileSync(join(profilePath, "user.js"), `user_pref("marionette.port", ${marionettePort});\n`);

  const endpoint = `ws://127.0.0.1:${rdpPort}/session`;
  // The env every child (and this parent's own readSessionSlot calls) reads. This is the real
  // MCP-server-shaped env: which browser, which endpoint, which shared artifact dir, which
  // Marionette port. WAIT_MS is left at the 10s default here and overridden per-probe where a
  // scenario needs a fast timeout.
  process.env.CDP_BROWSER = "firefox";
  process.env.CDP_FIREFOX_ENDPOINT = String(rdpPort);
  process.env.CDP_ARTIFACT_DIR = artifactDir;
  process.env.CDP_FIREFOX_MARIONETTE_PORT = String(marionettePort);

  console.log(
    `launching Firefox: bin=${binary} rdp=${rdpPort} marionette=${marionettePort} (default ${EXPECTED_MARIONETTE_DEFAULT} deliberately avoided)\n` +
      `  endpoint=${endpoint}\n  artifactDir=${artifactDir}\n  profile=${profilePath}`,
  );

  // --- stand up "the user's already-running Firefox", NOT via src/bidi/launch.ts ---
  firefox = spawn(
    binary,
    ["--profile", profilePath, "--remote-debugging-port", String(rdpPort), "--marionette", "--no-remote", "--headless"],
    { stdio: "ignore", detached: false },
  );
  firefoxPid = firefox.pid;
  if (firefoxPid === undefined) throw new Error(`failed to spawn Firefox at ${binary}`);
  await pollPort(rdpPort, 45_000, "Firefox BiDi debug");
  await pollPort(marionettePort, 45_000, "Firefox Marionette");
  console.log(`Firefox up: pid=${firefoxPid}, both ports accepting\n`);

  const slotFree = async (): Promise<boolean> => (await readSessionSlot(endpoint)) === undefined;

  /* ----------------------------------------------------------------------------------------
   * SCENARIO 3 — clean cross-process handoff (slot freed on dispose, no force-clear needed)
   * ---------------------------------------------------------------------------------------- */
  try {
    console.log("── SCENARIO 3: clean cross-process handoff ──");
    const a = new Child("holder");
    const aReady = await a.json<{ ok: boolean; pid: number }>();
    const heldNow = await readSessionSlot(endpoint);
    a.writeLine({ op: "release" }); // clean dispose → session.end + slot release
    const aRel = await a.json<{ released: boolean }>();
    await a.exited();
    const freedAfterRelease = await slotFree();
    const b = new Child("probe");
    const bRes = await b.json<{ ok: boolean; pid: number; pages?: number; err?: ErrId }>();
    await b.exited();
    const ok =
      aReady.ok === true &&
      heldNow?.pid === a.pid &&
      aRel.released === true &&
      freedAfterRelease === true &&
      bRes.ok === true &&
      bRes.pid !== a.pid;
    record(
      "S3 clean handoff: after A's clean release, a fresh process B attaches (slot freed cross-process, no force-clear)",
      ok,
      `A.pid=${a.pid} heldBy=${heldNow?.pid} released=${aRel.released} slotFreed=${freedAfterRelease} B.ok=${bRes.ok} B.pid=${bRes.pid} B.pages=${bRes.pages ?? "-"}`,
    );
  } catch (e) {
    record("S3 clean handoff", false, `threw: ${e instanceof Error ? e.message : String(e)}`);
  }

  /* ----------------------------------------------------------------------------------------
   * SCENARIO 2 — #5 live contention: distinguishable + fast, not a hang; recovers when gone
   * ---------------------------------------------------------------------------------------- */
  try {
    console.log("── SCENARIO 2: #5 live contention (fast, distinguishable) ──");
    const holder = new Child("holder");
    const hReady = await holder.json<{ ok: boolean; pid: number }>();
    // Probe B with a SMALL wait ceiling: it must FAIL FAST with the #5 error, not the raw wedge.
    const bBusy = new Child("probe", { env: { CDP_FIREFOX_SESSION_WAIT_MS: "1500" } });
    const bBusyRes = await bBusy.json<{ ok: boolean; ms: number; err?: ErrId }>();
    await bBusy.exited();
    const err = bBusyRes.err;
    const distinguishable =
      bBusyRes.ok === false &&
      err?.code === "disconnected" &&
      /held by a LIVE process/i.test(err?.message ?? "") &&
      (err?.message ?? "").includes(endpoint);
    const fast = bBusyRes.ms < 6_000; // wait ceiling was 1500ms; a hang would be ≥ the 10s default
    record(
      "S2a #5 live contention fails FAST and is distinguishable (names the LIVE holder + endpoint, not the raw max-sessions wedge)",
      hReady.ok === true && distinguishable && fast,
      `holder.pid=${holder.pid} B.ok=${bBusyRes.ok} B.code=${err?.code} fast=${fast}(${bBusyRes.ms}ms) msg=${JSON.stringify((err?.message ?? "").slice(0, 160))}`,
    );

    // Now the holder goes away (SIGKILL: dies without session.end → its session is orphaned). A
    // retry must recover (dead-holder steal + Marionette force-clear) and SUCCEED.
    holder.kill("SIGKILL");
    await holder.exited();
    const holderDead = !pidAlive(holder.pid);
    const bRetry = new Child("probe");
    const bRetryRes = await bRetry.json<{ ok: boolean; pid: number; err?: ErrId }>();
    await bRetry.exited();
    record(
      "S2b after the LIVE holder is killed, a retry SUCCEEDS (contention resolved; orphan recovered)",
      holderDead && bRetryRes.ok === true,
      `holderDead=${holderDead} B.ok=${bRetryRes.ok} B.err=${bRetryRes.err ? JSON.stringify(bRetryRes.err.message.slice(0, 120)) : "-"}`,
    );
  } catch (e) {
    record("S2 live contention", false, `threw: ${e instanceof Error ? e.message : String(e)}`);
  }

  /* ----------------------------------------------------------------------------------------
   * SCENARIO 1 — #4 HEADLINE: orphan auto-recovery over Marionette, Firefox NOT restarted
   * ---------------------------------------------------------------------------------------- */
  try {
    console.log("── SCENARIO 1: #4 orphan auto-recovery (headline) ──");
    const orphan = new Child("orphan");
    const oReady = await orphan.json<{ ok: boolean; pid: number }>();
    const orphanPid = oReady.pid;
    const leaseHeld = await readSessionSlot(endpoint); // written under the orphan's live pid
    orphan.kill("SIGKILL");
    await orphan.exited();
    const orphanDead = !pidAlive(orphanPid);
    const leaseAfterKill = await readSessionSlot(endpoint); // still the orphan's now-DEAD pid

    // OPTIONAL confirmation that the orphan really wedges the RAW path: a raw session.new (no
    // coordination) must be refused by Firefox with "Maximum number of active sessions". A rejected
    // session.new leaves Firefox untouched (connectBidiSessionUrl closes its own socket), so this
    // does not disturb the recovery that follows. Informational only — never gates the verdict.
    let rawWedge = "not-checked";
    try {
      const raw = await connectBidiSessionUrl(endpoint, { timeoutMs: 5_000 });
      raw.dispose(); // unexpected: no orphan present
      rawWedge = "UNEXPECTED-SUCCESS(no orphan?)";
    } catch (e) {
      rawWedge = /maximum number of active sessions/i.test(e instanceof Error ? e.message : String(e))
        ? "wedged-as-expected (raw session.new refused)"
        : `other: ${e instanceof Error ? e.message : String(e)}`;
    }
    console.log(`  raw-path wedge check: ${rawWedge}`);

    // THE POINT OF #4: a FRESH process auto-recovers and SUCCEEDS.
    const b = new Child("probe");
    const bRes = await b.json<{ ok: boolean; pid: number; pages?: number; err?: ErrId }>();
    await b.exited();
    const firefoxSamePid = firefoxPid !== undefined && pidAlive(firefoxPid);
    const recovered = orphanDead && leaseAfterKill?.pid === orphanPid && bRes.ok === true && firefoxSamePid;
    record(
      "S1 #4 orphan auto-recovery: a fresh process attaches SUCCESSFULLY after a killed orphan (Marionette force-cleared Firefox's stranded session + retried)",
      recovered,
      `orphanPid=${orphanPid} orphanDead=${orphanDead} leaseWasHeld=${leaseHeld?.pid === orphanPid} leaseAfterKill.pid=${leaseAfterKill?.pid} B.ok=${bRes.ok} B.pages=${bRes.pages ?? "-"} B.err=${bRes.err ? JSON.stringify(bRes.err.message.slice(0, 120)) : "-"}`,
    );
    record(
      "S1 #4 Firefox is the SAME pid after recovery (recovery cleared the orphan WITHOUT restarting the browser)",
      firefoxSamePid,
      `firefoxPid=${firefoxPid} alive=${firefoxSamePid} rawWedge=${JSON.stringify(rawWedge)}`,
    );
  } catch (e) {
    record("S1 orphan auto-recovery", false, `threw: ${e instanceof Error ? e.message : String(e)}`);
  }

  /* ----------------------------------------------------------------------------------------
   * SCENARIO 4 — no-Marionette degradation: a clear "needs --marionette" error, not a hang
   * (deterministic here: the orphan records a DEAD Marionette port, so force-clear cannot run)
   * ---------------------------------------------------------------------------------------- */
  try {
    console.log("── SCENARIO 4: no-Marionette degradation (best-effort) ──");
    let deadMPort = await pickFreePort();
    while (deadMPort === rdpPort || deadMPort === marionettePort) deadMPort = await pickFreePort();
    // The orphan records the DEAD Marionette port into its lease, so the stealer's force-clear
    // targets a port nothing listens on — the launch-mode / no-`--marionette` situation.
    const orphan = new Child("orphan", { env: { CDP_FIREFOX_MARIONETTE_PORT: String(deadMPort) } });
    const oReady = await orphan.json<{ ok: boolean; pid: number }>();
    orphan.kill("SIGKILL");
    await orphan.exited();
    // Probe B4 also points Marionette at the dead port, so BOTH force-clear attempts fail →
    // the actionable orphanNotClearedError, and it must be FAST (ECONNREFUSED), not a hang.
    const b4 = new Child("probe", { env: { CDP_FIREFOX_MARIONETTE_PORT: String(deadMPort) } });
    const b4Res = await b4.json<{ ok: boolean; ms: number; err?: ErrId }>();
    await b4.exited();
    const degraded =
      b4Res.ok === false &&
      b4Res.err?.code === "disconnected" &&
      /could not be auto-cleared/i.test(b4Res.err?.message ?? "") &&
      /--marionette/i.test(b4Res.err?.message ?? "");
    const fast = b4Res.ms < 15_000;
    record(
      "S4 no-Marionette degradation: yields the clear 'needs --marionette' error (not a hang, not the raw wedge)",
      degraded && fast,
      `B4.ok=${b4Res.ok} B4.code=${b4Res.err?.code} fast=${fast}(${b4Res.ms}ms) msg=${JSON.stringify((b4Res.err?.message ?? "").slice(0, 180))}`,
    );

    // CLEANUP: Firefox still holds S4's orphan (never cleared). A coordinated attach with the REAL
    // Marionette port clears it (free slot → dial → max-sessions → force-clear(real) → retry), both
    // recovering the browser and re-confirming recovery works.
    const cleanupProbe = new Child("probe");
    const cRes = await cleanupProbe.json<{ ok: boolean; err?: ErrId }>();
    await cleanupProbe.exited();
    record(
      "S4 cleanup: a coordinated attach with the REAL Marionette port clears the lingering orphan",
      cRes.ok === true,
      `cleanup.ok=${cRes.ok} slotFreeAfter=${await slotFree()} err=${cRes.err ? JSON.stringify(cRes.err.message.slice(0, 120)) : "-"}`,
    );
  } catch (e) {
    record("S4 no-Marionette degradation", false, `threw (best-effort scenario): ${e instanceof Error ? e.message : String(e)}`);
  }

  // Final invariant: the browser we attached to all along was never killed by the product code.
  record(
    "FINAL: the attached Firefox is STILL the same live pid after every scenario (product code never closed it)",
    firefoxPid !== undefined && pidAlive(firefoxPid),
    `firefoxPid=${firefoxPid} alive=${firefoxPid !== undefined && pidAlive(firefoxPid)}`,
  );
}

/* ---------------------------------- dispatch ---------------------------------- */
if (ROLE === "probe") {
  await runProbe();
} else if (ROLE === "orphan") {
  await runOrphan();
} else if (ROLE === "holder") {
  await runHolder();
} else {
  try {
    await runParent();
  } catch (err) {
    record("FATAL parent", false, err instanceof Error ? (err.stack ?? err.message) : String(err));
  } finally {
    clearTimeout(hardTimer);
    cleanup();
  }
  const failed = checks.filter((c) => !c.ok);
  console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`);
  if (failed.length) {
    console.error(`FAILED: ${failed.map((c) => c.name).join(" | ")}`);
    process.exit(1);
  }
  console.log("FIREFOX SESSION-COORD SMOKE OK");
  process.exit(0);
}
