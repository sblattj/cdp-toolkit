/**
 * Tab-lease end-to-end harness: two genuinely separate OS processes, one real browser.
 *
 * WHY THIS CANNOT BE A UNIT TEST OR A CLI LOOP. A lease records the claiming pid,
 * and a dead pid makes that record instantly reclaimable, so two sequential CLI
 * invocations never actually collide: the first process is gone before the second
 * starts. That is the same reason `claim_page` is refused from the CLI. Proving the
 * gate needs a long-lived OWNER process and a second long-lived process with a real,
 * different pid, both pointed at the same browser and the same CDP_ARTIFACT_DIR.
 * This file is all three roles (owner, stranger, doomed child), selected by --role,
 * so the owner can spawn the others as real children of itself.
 *
 * ============================ SAFETY RULES ============================
 * Whoever runs this next will point it at a real person's browser with real tabs
 * open. Every rule below is load-bearing; do not relax one to make a test easier.
 *
 *   - Exactly ONE throwaway `about:blank` tab is opened, and exactly that tab is
 *     closed, always by its own explicit target id.
 *   - Every selector passed to every tool is either a bare target id this harness
 *     minted itself, or a deliberately non-matching probe id. NEVER `active`,
 *     NEVER `index:N`, NEVER a `url:` or `title:` matcher, any of which can resolve
 *     onto somebody's mail or banking tab.
 *   - No pre-existing tab is navigated, clicked, read, or closed. The browser is
 *     never closed; `Browser.close` is never called.
 *   - The baseline listing is captured at RUNTIME as step zero and the final
 *     listing is diffed against THAT. No tab id is ever hardcoded: a hardcoded
 *     list goes stale the moment the owner closes a tab and then raises a false
 *     alarm. Tabs that APPEAR mid-run belong to the human and are ignored. Only a
 *     BASELINE tab that disappeared is a failure.
 *   - Lease files and state files go to a private temp dir, removed on exit, so
 *     nothing lands in the repo or in a shared artifact dir.
 * ======================================================================
 *
 * Run with `bun run lease:smoke`. `CDP_BASE` selects the browser, defaulting to
 * the same port as the rest of the toolkit; the harness fails fast with a clear
 * message if nothing is listening there rather than hanging. Prints one PASS/FAIL
 * line per assertion and exits non-zero naming every failure.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

const SELF = fileURLToPath(import.meta.url);

function argValue(flag: string): string | undefined {
  const hit = process.argv.find((a) => a.startsWith(`${flag}=`));
  return hit === undefined ? undefined : hit.slice(flag.length + 1);
}

const ROLE = argValue("--role") ?? "owner";

// CDP_BASE is read into a module-level const inside src/client.ts, so the default
// has to be in the environment BEFORE the toolkit is imported. Hence the dynamic
// imports below. Children inherit this env, so all three roles agree on the port.
process.env.CDP_BASE = process.env.CDP_BASE ?? "http://127.0.0.1:9222";

const { BASE, TOOLS } = await import("../src/index.ts");
const { LeaseConflictError, isPidAlive, leaseFile, tokenParts, withLeaseScope } = await import("../src/leases.ts");

/** A target id shaped like a real one that no browser will ever have open. */
const MISSING_TARGET_ID = "0000000000000000000000000000DEAD";
const OWNER_LABEL = "lease-smoke-owner";

/* --------------------------- error identity capture --------------------------- */

interface ErrIdentity {
  ctor: string | null;
  name: string | null;
  isLeaseConflict: boolean;
  code: string | null;
  targetId: string | null;
  holder: string | null;
  message: string;
}

/** Flatten an error into something that survives a JSON hop between processes.
 *  `instanceof` is evaluated in the process that CAUGHT the error, which is the
 *  only place it means anything. */
function identify(err: unknown): ErrIdentity {
  const e = err as { name?: unknown; code?: unknown; targetId?: unknown; holder?: unknown; message?: unknown } | null;
  return {
    ctor: (err as { constructor?: { name?: string } } | null)?.constructor?.name ?? null,
    name: typeof e?.name === "string" ? e.name : null,
    isLeaseConflict: err instanceof LeaseConflictError,
    code: e?.code === undefined || e?.code === null ? null : String(e.code),
    targetId: typeof e?.targetId === "string" ? e.targetId : null,
    holder: typeof e?.holder === "string" ? e.holder : null,
    message: typeof e?.message === "string" ? e.message : String(err),
  };
}

/* ------------------------------ the peer roles ------------------------------ */

interface PeerReply {
  ok: boolean;
  pid: number;
  value?: unknown;
  err?: ErrIdentity;
}

/** The tools are registered as `(args) => Promise<unknown>`, so results are cast
 *  at the call site here exactly as test/smoke.ts does. */
interface ClaimResult {
  lease: string;
  targetId: string;
  url: string;
  label: string;
}

/**
 * STRANGER. A second long-lived process holding NO lease token at all, sharing the
 * owner's CDP_ARTIFACT_DIR. Reads one JSON command per line on stdin and answers
 * one JSON line on stdout, so it stays alive (and its pid stays alive) for as long
 * as the owner holds the lease. It only ever drives the id the owner hands it.
 */
async function runStranger(): Promise<void> {
  const rl = createInterface({ input: process.stdin });
  for await (const line of rl) {
    const cmd = JSON.parse(line) as { op: string; target?: string; expression?: string };
    if (cmd.op === "exit") break;
    let reply: PeerReply;
    try {
      const value = await TOOLS.evaluate_script({ target: cmd.target, expression: cmd.expression ?? "1" });
      reply = { ok: true, pid: process.pid, value };
    } catch (err) {
      reply = { ok: false, pid: process.pid, err: identify(err) };
    }
    process.stdout.write(`${JSON.stringify(reply)}\n`);
  }
  process.exit(0);
}

/**
 * DOOMED CHILD. Claims the owner's throwaway tab and exits immediately, leaving a
 * real orphaned lease behind a genuinely dead pid. This is what makes the
 * reclamation assertion real rather than a stubbed pid.
 */
async function runDoomed(): Promise<void> {
  const targetId = argValue("--target") ?? "";
  const claim = (await TOOLS.claim_page({ targetId, label: "lease-smoke-doomed-child" })) as ClaimResult;
  // Write-then-exit via the callback: a bare process.exit() can truncate stdout.
  process.stdout.write(`${JSON.stringify({ pid: process.pid, lease: claim.lease })}\n`, () => process.exit(0));
}

/** Owner-side handle on a spawned child, with a line-oriented request/reply queue. */
class Peer {
  private readonly child: ChildProcess;
  private readonly queued: string[] = [];
  private readonly waiting: Array<(line: string) => void> = [];

  constructor(args: string[]) {
    this.child = spawn(process.execPath, [SELF, ...args], {
      env: process.env,
      stdio: ["pipe", "pipe", "inherit"],
    });
    createInterface({ input: this.child.stdout! }).on("line", (line) => {
      const waiter = this.waiting.shift();
      if (waiter) waiter(line);
      else this.queued.push(line);
    });
  }

  get pid(): number {
    return this.child.pid ?? -1;
  }

  nextLine(timeoutMs = 45_000): Promise<string> {
    const ready = this.queued.shift();
    if (ready !== undefined) return Promise.resolve(ready);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`timed out after ${timeoutMs}ms waiting for the peer process`)), timeoutMs);
      this.waiting.push((line) => {
        clearTimeout(timer);
        resolve(line);
      });
    });
  }

  async ask(msg: unknown): Promise<PeerReply> {
    this.child.stdin!.write(`${JSON.stringify(msg)}\n`);
    return JSON.parse(await this.nextLine()) as PeerReply;
  }

  /** Register BEFORE the child can exit, or the event is missed and never fires. */
  exited(): Promise<number> {
    return new Promise((resolve) => this.child.once("exit", (code) => resolve(code ?? -1)));
  }

  shutdown(): void {
    try {
      this.child.stdin!.write(`${JSON.stringify({ op: "exit" })}\n`);
    } catch {
      /* already gone */
    }
    this.child.kill("SIGKILL");
  }
}

/* ---------------------------------- owner ---------------------------------- */

interface Check {
  name: string;
  ok: boolean;
  detail: string;
}
const checks: Check[] = [];
function record(name: string, ok: boolean, detail: string): void {
  checks.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"} ${name}: ${detail}`);
}

async function pageIds(): Promise<Set<string>> {
  const { pages } = (await TOOLS.list_pages({})) as { pages: Array<{ id: string }> };
  return new Set(pages.map((p) => p.id));
}

/** Refuse to hang: if no DevTools endpoint answers, say so and stop. */
async function preflight(): Promise<void> {
  try {
    const res = await fetch(`${BASE}/json/version`, { signal: AbortSignal.timeout(5_000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
  } catch (err) {
    const why = err instanceof Error ? err.message : String(err);
    console.error(`FATAL: no DevTools endpoint answered at ${BASE} (${why}).`);
    console.error("Start the browser with remote debugging on that port, or set CDP_BASE to the right origin.");
    process.exit(1);
  }
}

function pause(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function runOwner(): Promise<void> {
  await preflight();

  const artifactDir = await mkdtemp(join(tmpdir(), "cdp-lease-smoke-"));
  // Set AFTER mkdtemp but BEFORE any tool call or spawn: leaseDir() is read per
  // call, and children inherit this env, so all processes share one lease dir.
  process.env.CDP_ARTIFACT_DIR = artifactDir;
  process.env.CDP_STATE_DIR = artifactDir;
  console.log(`browser=${BASE}  artifacts=${artifactDir}  owner pid=${process.pid}`);

  let baseline = new Set<string>();
  let tab = "";
  let ownerToken: string | undefined;
  let stranger: Peer | undefined;

  try {
    // --- step 0: the baseline, captured at runtime, never hardcoded ---
    baseline = await pageIds();
    record("baseline captured at runtime", true, `${baseline.size} pre-existing page targets recorded before any change`);

    // --- claim: opens its own throwaway tab and claims it in one call ---
    const claim = (await TOOLS.claim_page({ label: OWNER_LABEL })) as ClaimResult;
    tab = claim.targetId;
    ownerToken = claim.lease;
    const parts = tokenParts(claim.lease);
    record(
      "claim_page opened and claimed one throwaway tab",
      parts !== undefined && parts.backend === "chrome" && parts.targetId === tab && parts.nonce.length === 24,
      `url=${claim.url}, token=backend:targetId:<${parts?.nonce.length ?? 0}-hex nonce>`,
    );
    record("lease record written to the temp artifact dir", existsSync(leaseFile("chrome", tab)), `dir=${artifactDir}`);

    // --- owner can act on the tab it owns ---
    const owned = await withLeaseScope(ownerToken, () => TOOLS.evaluate_script({ target: tab, expression: "6*7" }));
    record("owner acts on its own leased tab", owned === 42, `6*7 => ${JSON.stringify(owned)}`);

    // --- stranger: a real second process, real second pid, no token ---
    stranger = new Peer(["--role=stranger"]);
    const blocked = await stranger.ask({
      op: "eval",
      target: tab,
      // Written to leave TWO durable side effects if it ever runs, so the refusal
      // can be proved by absence rather than inferred from the throw.
      expression: "(() => { window.__leaseSmokeStranger = 'BLOCKED-CALL-RAN'; document.title = 'lease-smoke-stranger-ran'; return 'ran'; })()",
    });
    record("stranger runs in a genuinely separate process", stranger.pid > 0 && stranger.pid !== process.pid, `owner pid=${process.pid}, stranger pid=${blocked.pid}`);
    record("stranger with no token is refused", blocked.ok === false, blocked.ok ? `WRONGLY ALLOWED, returned ${JSON.stringify(blocked.value)}` : "call threw");

    const err = blocked.err;
    record(
      "refusal keeps the LeaseConflictError type",
      err?.isLeaseConflict === true && err?.ctor === "LeaseConflictError",
      `ctor=${err?.ctor}, instanceof LeaseConflictError=${err?.isLeaseConflict}`,
    );
    record(
      "refusal keeps targetId and holder",
      err?.targetId === tab && err?.holder === OWNER_LABEL,
      `targetId matches=${err?.targetId === tab}, holder=${JSON.stringify(err?.holder)}`,
    );
    record("refusal is NOT coded no-such-target", err?.code !== "no-such-target", `code=${err?.code ?? "undefined"}`);

    // --- the refusal PREVENTED the side effect (read back, never inferred) ---
    const afterBlocked = (await withLeaseScope(ownerToken, () =>
      TOOLS.evaluate_script({
        target: tab,
        expression: "({ stranger: window.__leaseSmokeStranger ?? null, title: document.title })",
      }),
    )) as { stranger: string | null; title: string };
    record(
      "refusal prevented the side effect, proved by read-back",
      afterBlocked.stranger === null && afterBlocked.title === "",
      `marker=${JSON.stringify(afterBlocked.stranger)}, title=${JSON.stringify(afterBlocked.title)}`,
    );

    // --- no over-correction: a genuinely missing target is still no-such-target ---
    try {
      await TOOLS.evaluate_script({ target: MISSING_TARGET_ID, expression: "1" });
      record("missing target still surfaces no-such-target", false, "the call against a nonexistent target did not throw");
    } catch (missing) {
      const id = identify(missing);
      record(
        "missing target still surfaces no-such-target",
        id.code === "no-such-target" && id.isLeaseConflict === false,
        `code=${id.code}, instanceof LeaseConflictError=${id.isLeaseConflict}`,
      );
    }

    // --- owner with the correct token still succeeds through the same path ---
    const ownerMark = await withLeaseScope(ownerToken, () =>
      TOOLS.evaluate_script({ target: tab, expression: "(() => { window.__leaseSmokeOwner = 'OWNER-OK'; return window.__leaseSmokeOwner; })()" }),
    );
    record("owner with the correct token still succeeds", ownerMark === "OWNER-OK", `=> ${JSON.stringify(ownerMark)}`);

    // --- release ---
    const released = (await TOOLS.release_page({ lease: ownerToken })) as { released: boolean };
    ownerToken = undefined;
    record("release_page gives the lease back", released.released === true, JSON.stringify(released));
    record("lease record removed from disk", !existsSync(leaseFile("chrome", tab)), "lease file gone");

    // --- after release the same stranger, still tokenless, can act ---
    const allowed = await stranger.ask({
      op: "eval",
      target: tab,
      expression: "(() => { window.__leaseSmokeStrangerAfter = 'AFTER-RELEASE'; return 'ran-after-release'; })()",
    });
    record("stranger can act once the lease is released", allowed.ok === true && allowed.value === "ran-after-release", `=> ${JSON.stringify(allowed.ok ? allowed.value : allowed.err?.message)}`);

    const bothMarks = (await TOOLS.evaluate_script({
      target: tab,
      expression: "({ before: window.__leaseSmokeStranger ?? null, after: window.__leaseSmokeStrangerAfter ?? null })",
    })) as { before: string | null; after: string | null };
    record(
      "the blocked write never landed and the allowed one did",
      bothMarks.before === null && bothMarks.after === "AFTER-RELEASE",
      `before=${JSON.stringify(bothMarks.before)}, after=${JSON.stringify(bothMarks.after)}`,
    );

    // --- dead-pid reclamation against a real child process that exits ---
    const doomed = new Peer(["--role=doomed", `--target=${tab}`]);
    const doomedExit = doomed.exited();
    const announced = JSON.parse(await doomed.nextLine()) as { pid: number; lease: string };
    const exitCode = await doomedExit;
    record("doomed child claimed the tab and exited", exitCode === 0, `child pid=${announced.pid}, exit code=${exitCode}`);

    for (let i = 0; i < 20 && isPidAlive(announced.pid); i++) await pause(50);
    record("doomed child pid is genuinely dead", !isPidAlive(announced.pid), `signal-0 probe on pid ${announced.pid}`);
    record(
      "its lease record is orphaned on disk, not released",
      existsSync(leaseFile("chrome", tab)),
      "an orphaned lease, which is the case reclamation is for",
    );

    const vsOrphan = await stranger.ask({ op: "eval", target: tab, expression: "'dead-holder-does-not-block'" });
    record("a dead holder does not block a stranger", vsOrphan.ok === true, `=> ${JSON.stringify(vsOrphan.ok ? vsOrphan.value : vsOrphan.err?.message)}`);

    const reclaimed = (await TOOLS.claim_page({ targetId: tab, label: `${OWNER_LABEL}-reclaim` })) as ClaimResult;
    ownerToken = reclaimed.lease;
    record("owner reclaims the orphaned lease", reclaimed.targetId === tab, `label=${reclaimed.label}`);
    const oldNonce = tokenParts(announced.lease)?.nonce;
    const newNonce = tokenParts(reclaimed.lease)?.nonce;
    record(
      "reclamation mints a fresh nonce, invalidating the dead holder's token",
      oldNonce !== undefined && newNonce !== undefined && oldNonce !== newNonce,
      "old and new nonces differ",
    );
  } catch (fatal) {
    record("FATAL", false, fatal instanceof Error ? `${fatal.name}: ${fatal.message}` : String(fatal));
  } finally {
    stranger?.shutdown();

    if (tab) {
      try {
        const closed = (await withLeaseScope(ownerToken, () => TOOLS.close_page({ target: tab }))) as { success?: boolean };
        record("throwaway tab closed by its own id", closed.success !== false, "closed one tab, browser untouched");
      } catch (closeErr) {
        record("throwaway tab closed by its own id", false, closeErr instanceof Error ? closeErr.message : String(closeErr));
      }
    }

    // The invariant that matters on someone's real browser: every tab that was
    // open BEFORE this run is still open. Tabs opened during the run by the human
    // are none of our business and are ignored.
    try {
      const finalIds = await pageIds();
      const lost = [...baseline].filter((id) => !finalIds.has(id));
      record("no pre-existing tab was lost", lost.length === 0, `baseline=${baseline.size}, still open=${baseline.size - lost.length}, lost=${lost.length}`);
      record("the throwaway tab is gone", tab === "" || !finalIds.has(tab), "the one tab this harness opened is closed");
    } catch (listErr) {
      record("no pre-existing tab was lost", false, listErr instanceof Error ? listErr.message : String(listErr));
    }

    await rm(artifactDir, { recursive: true, force: true }).catch(() => undefined);
  }

  const failed = checks.filter((c) => !c.ok);
  console.log(`\n${checks.length - failed.length}/${checks.length} assertions passed`);
  if (failed.length) {
    console.error(`FAILED (${failed.length}): ${failed.map((c) => c.name).join(" | ")}`);
    process.exit(1);
  }
  console.log("LEASE SMOKE OK");
}

if (ROLE === "stranger") await runStranger();
else if (ROLE === "doomed") await runDoomed();
else await runOwner();
