/**
 * Tab-lease end-to-end harness: two genuinely separate OS processes, one real browser.
 *
 * WHY THIS CANNOT BE A UNIT TEST OR A CLI LOOP. A lease records the claiming pid,
 * and a dead pid makes that record instantly reclaimable, so two sequential CLI
 * invocations never actually collide: the first process is gone before the second
 * starts. That is the same reason `claim_page` is refused from the CLI. Proving the
 * gate needs a long-lived OWNER process and a second long-lived process with a real,
 * different pid, both pointed at the same browser and the same CDP_ARTIFACT_DIR.
 * This file is every one of those roles (owner, stranger, doomed child, corpse),
 * selected by --role, so the owner can spawn the others as real children of itself.
 *
 * The second half of the file runs the same browser under STRICT MODE
 * (CDP_REQUIRE_LEASE), which `bun test` cannot reach either: a cross-process
 * refusal needs two pids, and reap only fires from a long-lived process.
 *
 * ============================ SAFETY RULES ============================
 * Whoever runs this next will point it at a real person's browser with real tabs
 * open. Every rule below is load-bearing; do not relax one to make a test easier.
 *
 *   - Every tab this harness touches is a throwaway `about:blank` tab it opened
 *     itself, and each one is closed by its own explicit target id. One of them
 *     is closed by `release_page` and one by REAP, which are the behaviors under
 *     test; the rest are closed in `finally`.
 *   - Every selector passed to every tool is either a bare target id this harness
 *     minted itself, or a deliberately non-matching probe id. NEVER `active`,
 *     NEVER `index:N`, NEVER a `url:` or `title:` matcher, any of which can resolve
 *     onto somebody's mail or banking tab.
 *   - No pre-existing tab is navigated, clicked, read, or closed. The browser is
 *     never closed; `Browser.close` is never called.
 *   - REAP IS THE MOST DANGEROUS THING IN THIS FILE, because closing tabs is its
 *     entire job. What protects a human's tab from it is STRUCTURAL, not a
 *     careful selector: reap considers a tab only if it has BOTH an origin
 *     record AND a lease record, and both stores live in this run's private
 *     CDP_ARTIFACT_DIR, where a pre-existing tab has no record of either kind.
 *     Never point a scenario at the default `/tmp/cdp-toolkit` artifact dir, and
 *     never weaken that two-record condition to make a scenario pass.
 *   - The baseline listing is captured at RUNTIME as step zero and the final
 *     listing is diffed against THAT, in `finally`, AFTER the reap scenario. No
 *     tab id is ever hardcoded: a hardcoded list goes stale the moment the owner
 *     closes a tab and then raises a false alarm. Tabs that APPEAR mid-run belong
 *     to the human and are ignored. Only a BASELINE tab that disappeared is a
 *     failure. That assertion is mandatory, not optional.
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
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
// TYPE-ONLY, and that is what makes it safe here: a type import is erased, so
// it does not evaluate src/leases.ts before CDP_BASE is set below, which is the
// whole reason every other import in this file is dynamic.
import type { LeaseRecord } from "../src/leases.ts";

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
const { LeaseConflictError, isPidAlive, leaseFile, markLongLivedProcess, requireLease, tokenParts, withLeaseScope } =
  await import("../src/leases.ts");
const { originFile } = await import("../src/origins.ts");

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
  /** false when the claim took over a tab that was already open. */
  opened: boolean;
}

/** `lease` is optional on the tool, but never absent under strict mode: that is
 *  itself asserted below rather than assumed, so the type here is the strict
 *  shape and a missing token shows up as a failed assertion, not a crash. */
interface NewPageResult {
  targetId: string;
  url: string;
  lease?: string;
}

interface ReleaseResult {
  released: boolean;
  closed: boolean;
  targetId?: string;
}

interface ReapedRow {
  targetId: string;
  label: string;
  reason: string;
}

interface ListPagesResult {
  pages: Array<{ id: string }>;
  reaped?: ReapedRow[];
}

/**
 * STRANGER. A second long-lived process holding NO lease token at all, sharing the
 * owner's CDP_ARTIFACT_DIR. Reads one JSON command per line on stdin and answers
 * one JSON line on stdout, so it stays alive (and its pid stays alive) for as long
 * as the owner holds the lease. It only ever drives the id the owner hands it.
 *
 * `--strict=1` puts this child in the same mode as the parent's strict phase.
 * STRICT MODE IS TWO CONDITIONS, NOT ONE: requireLease() stays false unless
 * CDP_REQUIRE_LEASE is set (inherited through the spawn env) AND this process is
 * marked long-lived, which only mcp.ts does at startup. Setting the env var
 * alone is inert, and a child that looked strict but was not would still be
 * refused here for the ordinary cross-pid reason, quietly testing nothing.
 */
async function runStranger(): Promise<void> {
  if (argValue("--strict") === "1") markLongLivedProcess();
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

/**
 * CORPSE. Announces its pid and exits, touching no tab and no lease. It exists
 * to hand the reap scenario a pid that is GENUINELY dead.
 *
 * A hardcoded number would be a guess in both directions: one that happens to
 * be live leaves the tab un-reapable, so the scenario "passes" by closing
 * nothing and asserting nothing, and one that is dead today is live tomorrow.
 * Reusing the doomed child's pid would work but would couple the reap scenario
 * to whether an earlier, unrelated scenario got far enough to produce one.
 */
async function runCorpse(): Promise<void> {
  process.stdout.write(`${JSON.stringify({ pid: process.pid })}\n`, () => process.exit(0));
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

/**
 * How many creation records sit in this run's private artifact dir.
 *
 * This is how "no tab was opened" is asserted, instead of counting the browser's
 * tabs: every tab the toolkit opens writes an origin record, so this counts tabs
 * THIS TOOLKIT made and nothing else. A tab count would be the obvious check and
 * the wrong one — the human opening a tab of their own mid-run would move it, and
 * a safety assertion that a stranger can trip at any moment is worse than none.
 */
async function originRecordCount(): Promise<number> {
  const names = await readdir(dirname(originFile("chrome", "probe"))).catch(() => [] as string[]);
  return names.filter((n) => n.startsWith("origin-")).length;
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
  let strictStranger: Peer | undefined;
  // Every tab the strict phase opens, in creation order. Two of them are closed
  // by the behavior under test (release_page, then reap); whatever is still open
  // at the end is closed in `finally`, each by its own id. A tab is pushed here
  // the instant it exists, BEFORE any assertion about it, so a scenario that
  // fails halfway still leaves its tab on the cleanup list.
  const opened: string[] = [];

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
    // `close:false` is REQUIRED here and is not a convenience. As of 1.5.0
    // release_page closes a tab the toolkit itself opened, and claim_page opened
    // this one, so a bare release would close it and every assertion below —
    // the tokenless stranger, the whole dead-pid reclamation sequence — would
    // fail on a tab that no longer exists. This scenario is about giving the
    // LEASE back while the tab stays open, which is what the documented opt-out
    // expresses. Close-on-release gets its own scenario, further down.
    const released = (await TOOLS.release_page({ lease: ownerToken, close: false })) as ReleaseResult;
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

    /* ===================== strict mode: CDP_REQUIRE_LEASE ===================== */
    // Everything above ran with the flag OFF, which is 1.4.0 behavior and must
    // keep passing unchanged. From here the flag is ON and stays on.
    //
    // Turning it on is TWO steps, not one, and the second is the one that gets
    // forgotten: requireLease() returns false unless this process is also marked
    // long-lived (mcp.ts does it at startup; cli.ts deliberately never does, so
    // a one-shot CLI cannot auto-acquire leases it would abandon on exit). Both
    // steps happen BEFORE any child is spawned, so children inherit the env var.
    markLongLivedProcess();
    process.env.CDP_REQUIRE_LEASE = "1";
    record(
      "strict mode is actually on for this process",
      requireLease() === true,
      "CDP_REQUIRE_LEASE=1 AND the process is marked long-lived; either alone is inert",
    );

    // --- scenario 1: strict cross-process refusal ---
    // The lease is acquired BY THE GATE, not by claim_page: new_page under
    // strict hands back a token, that token is given straight back with
    // close:false (leaving an open, unleased, agent-created tab), and the next
    // ORDINARY tool call is what takes the lease. That is the path an agent
    // that never learned the lease protocol actually walks.
    const created = (await TOOLS.new_page({ label: `${OWNER_LABEL}-strict` })) as NewPageResult;
    const strictTab = created.targetId;
    opened.push(strictTab);
    record(
      "new_page under strict returns a lease for the tab it just made",
      typeof created.lease === "string" && tokenParts(created.lease)?.targetId === strictTab,
      `lease present=${typeof created.lease === "string"}`,
    );
    const handedBack = (await TOOLS.release_page({ lease: created.lease, close: false })) as ReleaseResult;
    record(
      "that lease can be handed back without closing the tab",
      handedBack.released === true && handedBack.closed === false && !existsSync(leaseFile("chrome", strictTab)),
      `${JSON.stringify(handedBack)}, lease file gone`,
    );

    const strictOwnerMark = await TOOLS.evaluate_script({
      target: strictTab,
      expression: "(() => { window.__leaseSmokeStrictOwner = 'OWNER-STRICT'; return 'owner-touched'; })()",
    });
    record(
      "an ordinary tokenless call auto-acquires the lease under strict",
      strictOwnerMark === "owner-touched" && existsSync(leaseFile("chrome", strictTab)),
      `=> ${JSON.stringify(strictOwnerMark)}, lease file now exists`,
    );
    const autoRec = JSON.parse(await readFile(leaseFile("chrome", strictTab), "utf8")) as LeaseRecord;
    record(
      "the auto-acquired lease is marked auto and held by this pid",
      autoRec.auto === true && autoRec.pid === process.pid,
      `auto=${autoRec.auto}, pid=${autoRec.pid}, label=${JSON.stringify(autoRec.label)}`,
    );

    // A SECOND live OS process, strict itself, holding no token. `bun test`
    // cannot stand here: a lease is keyed on the claiming pid and in-process
    // calls all share one pid, so nothing in-process can ever collide.
    strictStranger = new Peer(["--role=stranger", "--strict=1"]);
    const strictBlocked = await strictStranger.ask({
      op: "eval",
      target: strictTab,
      // Two durable side effects again, so the refusal is proved by absence.
      expression:
        "(() => { window.__leaseSmokeStrictStranger = 'STRICT-BLOCKED-CALL-RAN'; document.title = 'lease-smoke-strict-stranger-ran'; return 'ran'; })()",
    });
    record(
      "the strict stranger is a genuinely separate process",
      strictStranger.pid > 0 && strictStranger.pid !== process.pid,
      `owner pid=${process.pid}, strict stranger pid=${strictBlocked.pid}`,
    );
    record(
      "strict: a second process with no token is refused",
      strictBlocked.ok === false,
      strictBlocked.ok ? `WRONGLY ALLOWED, returned ${JSON.stringify(strictBlocked.value)}` : "call threw",
    );
    const strictErr = strictBlocked.err;
    record(
      "strict: the refusal keeps the LeaseConflictError type",
      strictErr?.isLeaseConflict === true && strictErr?.ctor === "LeaseConflictError",
      `ctor=${strictErr?.ctor}, instanceof LeaseConflictError=${strictErr?.isLeaseConflict}`,
    );
    record(
      "strict: the refusal keeps targetId and holder",
      // The holder is compared against the label read off the lease record on
      // disk, not a string written here: the gate labels an auto lease itself,
      // and hardcoding what it "should" say would test this file, not the gate.
      strictErr?.targetId === strictTab && strictErr?.holder === autoRec.label,
      `targetId matches=${strictErr?.targetId === strictTab}, holder=${JSON.stringify(strictErr?.holder)}`,
    );
    record(
      "strict: the refusal is NOT coded no-such-target",
      strictErr?.code !== "no-such-target",
      `code=${strictErr?.code ?? "undefined"}`,
    );

    const afterStrictBlocked = (await TOOLS.evaluate_script({
      target: strictTab,
      expression:
        "({ stranger: window.__leaseSmokeStrictStranger ?? null, owner: window.__leaseSmokeStrictOwner ?? null, title: document.title })",
    })) as { stranger: string | null; owner: string | null; title: string };
    record(
      // The owner marker is the CONTROL, and it is what stops this from being an
      // assertion that cannot fail. A null stranger marker on its own is equally
      // consistent with "the write was blocked" and "we are reading some other
      // page, or a page that was reloaded out from under both of us". Reading
      // the owner's own marker back from the SAME evaluation proves this is the
      // context a write does land in, so the missing one is missing because it
      // was refused.
      "strict: the refusal prevented the side effect, proved by read-back",
      afterStrictBlocked.stranger === null && afterStrictBlocked.title === "" && afterStrictBlocked.owner === "OWNER-STRICT",
      `stranger=${JSON.stringify(afterStrictBlocked.stranger)}, owner=${JSON.stringify(afterStrictBlocked.owner)}, title=${JSON.stringify(afterStrictBlocked.title)}`,
    );

    // --- scenario 2: release closes an agent tab, and ONLY an agent tab ---
    const agentTab = ((await TOOLS.new_page({ label: `${OWNER_LABEL}-agent-tab` })) as NewPageResult).targetId;
    opened.push(agentTab);
    // target mode, not lease mode: an auto-acquired lease never handed anyone a
    // token, so this is the only way such an agent can give its tab back.
    const relAgent = (await TOOLS.release_page({ target: agentTab })) as ReleaseResult;
    record(
      "release_page{target} closes a tab the toolkit opened",
      relAgent.released === true && relAgent.closed === true,
      JSON.stringify(relAgent),
    );
    const afterAgentRelease = await pageIds();
    record("the released agent tab is gone from list_pages", !afterAgentRelease.has(agentTab), `target=${agentTab}`);

    // The other half, and the one that matters on a real person's browser: a tab
    // with NO origin record survives being claimed and released. It is opened
    // here rather than borrowed from the human — the id must be one this harness
    // minted — and then its creation record is deleted, which is the only thing
    // that distinguishes an agent's tab from anyone else's.
    const standIn = (await TOOLS.new_page({ label: `${OWNER_LABEL}-stand-in` })) as NewPageResult;
    const standInTab = standIn.targetId;
    opened.push(standInTab);
    await rm(originFile("chrome", standInTab), { force: true });
    record(
      "the stand-in tab has no origin record, like a tab the toolkit never opened",
      !existsSync(originFile("chrome", standInTab)),
      `target=${standInTab}`,
    );
    const relStandIn = (await TOOLS.release_page({ lease: standIn.lease })) as ReleaseResult;
    record(
      "release_page leaves a tab with no origin record alone",
      relStandIn.released === true && relStandIn.closed === false,
      JSON.stringify(relStandIn),
    );
    // Now claim it EXPLICITLY and release it again: an explicit claim is the
    // strongest form of ownership there is, and it still must not license a
    // close, because provenance and ownership are different questions.
    const claimedStandIn = (await TOOLS.claim_page({ targetId: standInTab, label: `${OWNER_LABEL}-stand-in-claim` })) as ClaimResult;
    const relClaimed = (await TOOLS.release_page({ lease: claimedStandIn.lease })) as ReleaseResult;
    record(
      "an explicitly claimed tab with no origin record is released, not closed",
      relClaimed.released === true && relClaimed.closed === false,
      JSON.stringify(relClaimed),
    );
    const afterStandIn = await pageIds();
    record("the claimed-and-released non-agent tab is still open", afterStandIn.has(standInTab), `target=${standInTab}`);

    // --- scenario 3: reap closes an abandoned agent tab, and only that one ---
    // The single most dangerous thing this file does. See the SAFETY RULES
    // header: what protects a human's tab here is that reap requires BOTH an
    // origin record AND a lease record, and both stores are this run's private
    // temp dir, in which no pre-existing tab has any record at all.
    const reapLabel = `${OWNER_LABEL}-abandoned`;
    const reapTab = ((await TOOLS.new_page({ label: reapLabel })) as NewPageResult).targetId;
    opened.push(reapTab);
    record(
      "the abandoned tab has BOTH records reap requires, and both are in the private dir",
      existsSync(originFile("chrome", reapTab)) && existsSync(leaseFile("chrome", reapTab)),
      `target=${reapTab}, dir=${artifactDir}`,
    );

    const corpse = new Peer(["--role=corpse"]);
    const corpseExit = corpse.exited();
    const corpsePid = (JSON.parse(await corpse.nextLine()) as { pid: number }).pid;
    await corpseExit;
    for (let i = 0; i < 20 && isPidAlive(corpsePid); i++) await pause(50);
    record("a real child process died to supply a dead pid", !isPidAlive(corpsePid), `signal-0 probe on pid ${corpsePid}`);

    // Overwrite the lease in place with the same record under a dead holder:
    // that is exactly the on-disk state an agent leaves behind when it is
    // killed, and it is what reap exists to clean up.
    const liveRec = JSON.parse(await readFile(leaseFile("chrome", reapTab), "utf8")) as LeaseRecord;
    await writeFile(leaseFile("chrome", reapTab), JSON.stringify({ ...liveRec, pid: corpsePid }), "utf8");
    const deadRec = JSON.parse(await readFile(leaseFile("chrome", reapTab), "utf8")) as LeaseRecord;
    record(
      "its lease now names a holder that is dead",
      deadRec.pid === corpsePid && !isPidAlive(deadRec.pid) && deadRec.label === reapLabel,
      `pid=${deadRec.pid}, label=${JSON.stringify(deadRec.label)}`,
    );

    const listed = (await TOOLS.list_pages({})) as ListPagesResult;
    const reaped = listed.reaped ?? [];
    record(
      "list_pages reaped the abandoned tab and named it with reason dead-pid",
      reaped.some((r) => r.targetId === reapTab && r.reason === "dead-pid" && r.label === reapLabel),
      `reaped=${JSON.stringify(reaped)}`,
    );
    record(
      "the reaped tab is absent from the very listing that closed it",
      !listed.pages.some((p) => p.id === reapTab),
      "a read that closes a tab never reports it as open",
    );
    record(
      "reap closed exactly one tab, and it was that one",
      reaped.length === 1 && reaped[0]?.targetId === reapTab,
      `reaped ${reaped.length} tab(s)`,
    );
    const afterReap = await pageIds();
    record(
      "the reaped tab is really gone from the browser, not merely filtered out",
      !afterReap.has(reapTab),
      "confirmed by a second, independent listing",
    );
    record(
      // The narrow-blast-radius check. The baseline diff in `finally` covers the
      // human's tabs; this covers the harness's own, which reap could equally
      // have taken and which the baseline diff would not notice.
      "reap left every other tab this run opened alone",
      afterReap.has(strictTab) && afterReap.has(standInTab) && afterReap.has(tab),
      `strict tab, stand-in tab and the original throwaway all still open`,
    );

    // --- scenario 4: taking over a tab that was already open ---
    // `claim_page{target}` is the takeover path, and strict mode is the only
    // place its one hard requirement is observable: resolution is GATE-FREE.
    // Routed through resolvePage instead, the gate would auto-acquire a lease on
    // the way in and the explicit claim behind it would then collide with the
    // lease taken on its own behalf. Nothing under `bun test` runs inside a
    // process where requireLease() is true, so that collision cannot be
    // reproduced there. It runs LAST, after reap, so the tab it leaves open for
    // most of its length is never in front of the destructive scenario.
    //
    // The stand-in for a human's tab is built exactly as scenario 2's was, and
    // for the same reason: the id must be one this harness minted. It opens a
    // tab and then strips the two things a human's tab does not have, an origin
    // record and a lease. Building it in one process rather than two is not a
    // shortcut — those two absences are the entire definition of "somebody
    // else's tab" here, and a peer that opened it would leave exactly the same
    // records behind for the owner to delete.
    const humanish = (await TOOLS.new_page({ label: `${OWNER_LABEL}-humanish` })) as NewPageResult;
    const humanTab = humanish.targetId;
    opened.push(humanTab);
    await rm(originFile("chrome", humanTab), { force: true });
    const handedOver = (await TOOLS.release_page({ lease: humanish.lease, close: false })) as ReleaseResult;
    record(
      "a stand-in for a human's tab: open, unleased, no origin record",
      handedOver.released === true &&
        !existsSync(leaseFile("chrome", humanTab)) &&
        !existsSync(originFile("chrome", humanTab)) &&
        (await pageIds()).has(humanTab),
      `target=${humanTab}`,
    );

    // A bare target id and nothing else. `active`, `url:` or `title:` here would
    // be the one selector in this file able to resolve onto a real person's tab,
    // and this is the tool that would then take a lease on it.
    const took = (await TOOLS.claim_page({ target: humanTab, label: `${OWNER_LABEL}-takeover` })) as ClaimResult;
    record(
      "claim_page{target} takes over a tab that was already open",
      took.targetId === humanTab && took.opened === false && existsSync(leaseFile("chrome", humanTab)),
      `targetId matches=${took.targetId === humanTab}, opened=${took.opened}, lease file written`,
    );
    const tookMark = await withLeaseScope(took.lease, () =>
      TOOLS.evaluate_script({
        target: humanTab,
        expression: "(() => { window.__leaseSmokeTakeover = 'TAKEN-OVER'; return 'took-over'; })()",
      }),
    );
    record("the taken-over tab is drivable with the token the takeover returned", tookMark === "took-over", `=> ${JSON.stringify(tookMark)}`);

    // No `close:false` here, deliberately: the opt-out would hide the property
    // under test. An explicit claim is the strongest ownership there is and it
    // still must not license a close, because the toolkit did not open this tab.
    const relTook = (await TOOLS.release_page({ lease: took.lease })) as ReleaseResult;
    record(
      "releasing a taken-over tab gives the lease back and does NOT close it",
      relTook.released === true && relTook.closed === false && !existsSync(leaseFile("chrome", humanTab)),
      JSON.stringify(relTook),
    );
    const afterTakeover = await pageIds();
    record("the taken-over tab is still open and still listed after release", afterTakeover.has(humanTab), `target=${humanTab}`);

    // A takeover that matches nothing must be an error, never a silently
    // substituted new tab: "the tab I asked for is not there" and "here is a
    // blank one instead" are answers a caller has to be able to tell apart, and
    // on a real browser the second one litters it. Counted off the creation
    // ledger, not the tab list — see originRecordCount.
    const ledgerBefore = await originRecordCount();
    let missDetail = "NOT REFUSED: the call returned instead of throwing";
    try {
      await TOOLS.claim_page({ target: MISSING_TARGET_ID, label: `${OWNER_LABEL}-miss` });
    } catch (miss) {
      missDetail = identify(miss).message;
    }
    const ledgerAfter = await originRecordCount();
    record(
      "a takeover that matches nothing is refused and opens no tab",
      missDetail.startsWith("NOT REFUSED") === false && ledgerAfter === ledgerBefore,
      `creation records ${ledgerBefore} -> ${ledgerAfter}; ${missDetail}`,
    );
  } catch (fatal) {
    record("FATAL", false, fatal instanceof Error ? `${fatal.name}: ${fatal.message}` : String(fatal));
  } finally {
    stranger?.shutdown();
    strictStranger?.shutdown();

    if (tab) {
      try {
        const closed = (await withLeaseScope(ownerToken, () => TOOLS.close_page({ target: tab }))) as { success?: boolean };
        record("throwaway tab closed by its own id", closed.success !== false, "closed one tab, browser untouched");
      } catch (closeErr) {
        record("throwaway tab closed by its own id", false, closeErr instanceof Error ? closeErr.message : String(closeErr));
      }
    }

    // Whatever the strict phase opened and the behaviors under test did not
    // already close. Each is closed by its own bare target id; `active` or
    // `index:N` here would close whichever tab the human happens to be looking
    // at. A tab that is already gone is skipped rather than closed blind.
    if (opened.length) {
      let stillOpen = new Set<string>();
      try {
        stillOpen = await pageIds();
      } catch {
        /* the diff below reports the listing failure; do not guess and close */
      }
      const leftovers = opened.filter((id) => stillOpen.has(id));
      const failures: string[] = [];
      for (const id of leftovers) {
        try {
          const res = (await TOOLS.close_page({ target: id })) as { success?: boolean };
          if (res.success === false) failures.push(id);
        } catch {
          failures.push(id);
        }
      }
      record(
        "every tab the strict phase opened is closed by its own id",
        failures.length === 0,
        `opened=${opened.length}, closed by the behavior under test=${opened.length - leftovers.length}, closed here=${leftovers.length - failures.length}, failed=${failures.length}`,
      );
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
else if (ROLE === "corpse") await runCorpse();
else await runOwner();
