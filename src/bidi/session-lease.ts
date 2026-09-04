/**
 * Firefox BiDi SESSION-slot lease: cross-process coordination for the ONE
 * WebDriver-BiDi session a single Firefox instance will serve.
 *
 * WHY THIS EXISTS. Firefox admits exactly one active WebDriver-BiDi session per
 * browser. When two cdp-toolkit MCP-server processes ATTACH to the same
 * user-launched Firefox endpoint (e.g. ws://127.0.0.1:9223/session), they both
 * want that one slot. Today the second process calls session.new and gets a
 * hard "Maximum number of active sessions" with no way to tell a LIVE holder
 * (another agent legitimately driving the browser) from a DEAD one (a crashed
 * process that left the slot occupied). This module makes that distinction on
 * disk, so a live holder is respected and a dead holder's orphan is reclaimed.
 *
 * WHY A FILE, AND WHY KEYED BY ENDPOINT. Same reasoning as the tab leases in
 * ../leases.ts: two MCP servers are two processes, so in-process state would
 * guard the wrong boundary. The tab lease is keyed by (backend, targetId)
 * because it owns a tab; this lease is keyed by the BiDi ws ENDPOINT string
 * because it owns the browser's single session slot, which is a property of the
 * endpoint, not of any tab. One lock file per endpoint.
 *
 * WHY NO NONCE/TOKEN. A tab lease mints a nonce because a caller passes a token
 * back and a reclamation must invalidate the superseded one. Nobody passes a
 * session token back here: the slot is owned by whichever process currently
 * holds the live BiDi connection and is released on dispose. Ownership is
 * therefore identified by (pid, createdAt) of the record we wrote, which is
 * enough to keep release from unlinking a record another process created after
 * stealing the slot from us.
 *
 * WHY STALENESS IS PURE PID-LIVENESS, WITH NO TTL. A long-lived MCP server can
 * legitimately hold the slot for hours, so a time-based expiry would reap a
 * healthy holder. The only thing that makes a holder illegitimate is that its
 * process is gone. So the sole staleness test is isPidAlive (reused from
 * ../leases.ts): pid alive -> legitimate holder; pid dead -> orphan to steal.
 *
 * ATOMICITY. Claims are exclusive creates (writeFile flag "wx"), exactly like
 * ../leases.ts claimLease, so "is the slot free, and if so take it" is atomic
 * against a racing process for free, with no registry lock.
 *
 * THE MUX: WHY A LIVE HOLDER IS NO LONGER A DEAD END. Everything above still
 * holds — one process owns Firefox's single BiDi session — but the holder now
 * also hosts a loopback BiDi multiplexer (./mux.ts) over that one real session
 * and ADVERTISES its ws endpoint in this record (`muxEndpoint`). Two consequences
 * for this module, and nothing else changes:
 *
 *  - THE HOLDER advertises via advertiseMux() once its mux is listening. That is
 *    a rewrite of its OWN record, guarded by the same (pid, createdAt) ownership
 *    test release uses, and written atomically (tmp + rename) so a concurrent
 *    reader never sees a half-written record. Advertising is best-effort: a
 *    refusal (`advertised:false`) means the record is no longer ours and the
 *    holder simply runs alone.
 *  - A JOINER DOES NOT WAIT. When acquire finds a LIVE holder that carries a
 *    muxEndpoint, there is nothing to wait FOR: the slot will not free up (the
 *    holder is healthy) and it does not need to, because the mux serves that one
 *    session to as many processes as ask. So acquire returns { joinMux }
 *    immediately, with NO handle and nothing written to disk — the joiner holds
 *    no slot and must never release one. The record is re-read on every poll
 *    iteration, so a holder that took the slot a moment ago and advertises a beat
 *    later is joined as soon as it does, inside the existing wait window.
 *
 * A live holder with NO muxEndpoint (a foreign client, an older cdp-toolkit, or
 * one running with CDP_FIREFOX_MUX=off) is still plain BUSY and still throws
 * SessionSlotBusyError at the deadline — exactly today's behavior. CDP_FIREFOX_MUX=off
 * makes acquire ignore muxEndpoint entirely, which is the opt-out.
 */
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { isPidAlive, leaseDir } from "../leases.ts";

/**
 * The on-disk record for a held session slot. Keyed by endpoint (one file per
 * endpoint). No nonce: see the header. marionettePort is carried so a stealer
 * can surface which Marionette port an orphaned session was bound to when it
 * has to force-clear it.
 */
export interface SessionSlotRecord {
  endpoint: string;
  /** Owning MCP server process. The one field staleness turns on. */
  pid: number;
  /** Caller-supplied agent label, surfaced in busy/steal reporting. */
  label: string;
  createdAt: number;
  /** Optional Marionette control port bound to this Firefox, when known. */
  marionettePort?: number;
  /**
   * Loopback ws endpoint of the BiDi multiplexer this holder hosts over the one
   * real session (see ./mux.ts and the header). Absent means "this holder serves
   * nobody but itself", which is what every pre-mux client's record looks like.
   */
  muxEndpoint?: string;
}

/**
 * What a holder keeps so it can release ITS OWN record and never another
 * process's. endpoint locates the file; (pid, createdAt) identify our record.
 */
export interface SessionSlotHandle {
  endpoint: string;
  pid: number;
  createdAt: number;
}

export interface AcquireResult {
  /**
   * Present iff WE took the slot. Absent on the joinMux path: a joiner owns no
   * slot, wrote no record, and must never release one.
   */
  handle?: SessionSlotHandle;
  /**
   * Set only when we STOLE a dead holder's slot. Its presence tells the caller
   * that Firefox may still believe an orphaned BiDi session is active, so the
   * caller must force-clear that session (e.g. via Marionette) before it calls
   * session.new, or Firefox will still refuse with "Maximum number of active
   * sessions". Absent on a clean first acquire.
   */
  staleHolder?: SessionSlotRecord;
  /**
   * Set instead of `handle` when a LIVE holder advertises a BiDi multiplexer.
   * The caller dials `endpoint` exactly as it would dial Firefox; `holder` is the
   * record it came from, for error reporting. Nothing was written to disk.
   */
  joinMux?: { endpoint: string; holder: SessionSlotRecord };
}

export interface AcquireOptions {
  label: string;
  marionettePort?: number;
  /** How long to keep polling a LIVE holder before giving up. Default sessionWaitMs(). */
  waitMs?: number;
  /** Injectable clock for the record's createdAt, so tests are deterministic. */
  now?: number;
  /** Poll interval while waiting on a live holder. Default DEFAULT_POLL_MS. */
  pollMs?: number;
}

/** Env-overridable wait ceiling, in ms. */
const DEFAULT_SESSION_WAIT_MS = 10_000;
/** Poll cadence while a live holder is blocking us. */
const DEFAULT_POLL_MS = 250;

/** Same substitution rule as ../leases.ts safeId, applied to the endpoint URL. */
function safeEndpoint(endpoint: string): string {
  return endpoint.replace(/[^A-Za-z0-9._-]/g, "_");
}

/** One lock file per endpoint, a sibling of the tab lease files in ARTIFACT_DIR. */
export function sessionSlotFile(endpoint: string): string {
  return join(leaseDir(), `ff-session-${safeEndpoint(endpoint)}.json`);
}

/**
 * Where the detached mux DAEMON (./mux-daemon.ts) appends its one-line diagnostics for this
 * endpoint. It is spawned with stdio:"ignore" (no console at all), so this file is the ONLY
 * record of why a daemon refused to start; the driver names it in the error it raises when a
 * daemon it spawned never advertised. Sibling of the slot file, same safeEndpoint key.
 */
export function muxDaemonLogFile(endpoint: string): string {
  return join(leaseDir(), `ff-mux-${safeEndpoint(endpoint)}.log`);
}

/** Read per call (like leaseDir/leaseTtlMs), so a test can redirect it. A value
 *  that is not a finite number > 0 falls back to the default. */
export function sessionWaitMs(): number {
  const raw = Number(process.env.CDP_FIREFOX_SESSION_WAIT_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_SESSION_WAIT_MS;
}

/**
 * Thrown when the slot is held by a LIVE process and did not free up within the
 * wait window (or the attempt cap was hit). Names the live holder so the caller
 * can decide to wait and retry or point this server at a different browser.
 */
export class SessionSlotBusyError extends Error {
  readonly endpoint: string;
  readonly holderPid?: number;
  readonly holderLabel?: string;
  constructor(endpoint: string, holder?: SessionSlotRecord) {
    const who = holder ? `'${holder.label}' (pid ${holder.pid})` : "another live process";
    super(
      `Firefox BiDi session slot for endpoint '${endpoint}' is held by ${who}. ` +
        `Firefox serves exactly ONE WebDriver-BiDi session per browser instance, and this slot is held ` +
        `by a LIVE process, so it cannot be taken. Wait for that process to release it and retry, or point ` +
        `this server at a different endpoint/browser.`,
    );
    this.name = "SessionSlotBusyError";
    this.endpoint = endpoint;
    if (holder) {
      this.holderPid = holder.pid;
      this.holderLabel = holder.label;
    }
  }
}

/**
 * Read the slot record, or undefined if the slot is genuinely free.
 *
 * Mirrors ../leases.ts readLease's fail-closed contract: ENOENT is "free" and
 * returns undefined; any OTHER errno (EACCES, EIO, EISDIR, EMFILE...) is
 * rethrown rather than reported as absent, because reporting "free" for a file
 * that merely could not be read would admit a second process to a slot that is
 * very much held. A record that reads but does not PARSE is treated as absent,
 * deliberately: a corrupt record can never become readable, and failing closed
 * on it would brick the endpoint with no in-product recovery, whereas an errno
 * is transient.
 */
export async function readSessionSlot(endpoint: string): Promise<SessionSlotRecord | undefined> {
  let raw: string;
  try {
    raw = await readFile(sessionSlotFile(endpoint), "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined; // genuinely free
    throw err; // unreadable is not absent: fail closed
  }
  try {
    const rec = JSON.parse(raw) as SessionSlotRecord;
    if (typeof rec?.pid === "number" && typeof rec?.endpoint === "string" && typeof rec?.label === "string") {
      return rec;
    }
  } catch {
    /* unparseable: fall through to undefined, see the doc comment above */
  }
  return undefined;
}

/**
 * Take the endpoint's session slot, coordinating with any other process.
 *
 * Returns { handle } on a clean acquire. Returns { handle, staleHolder } when
 * the previous holder's process was dead and we stole its orphaned slot (the
 * caller must then force-clear Firefox's orphaned session before session.new).
 * Throws SessionSlotBusyError when a LIVE holder does not free the slot inside
 * the wait window.
 */
export async function acquireSessionSlot(endpoint: string, opts: AcquireOptions): Promise<AcquireResult> {
  const waitMs = opts.waitMs ?? sessionWaitMs();
  const pollMs = opts.pollMs !== undefined && opts.pollMs > 0 ? opts.pollMs : DEFAULT_POLL_MS;
  // opts.now stamps OUR record deterministically for tests; the wait deadline
  // uses real time (with real sleeps) so a small waitMs actually times out.
  const createdAt = opts.now ?? Date.now();
  const file = sessionSlotFile(endpoint);

  const record: SessionSlotRecord = {
    endpoint,
    pid: process.pid,
    label: opts.label,
    createdAt,
  };
  if (opts.marionettePort !== undefined) record.marionettePort = opts.marionettePort;
  const handle: SessionSlotHandle = { endpoint, pid: process.pid, createdAt };
  const payload = JSON.stringify(record);

  await mkdir(leaseDir(), { recursive: true });

  const deadline = Date.now() + waitMs;
  // Bounds the immediate-retry paths (released-mid-race, steal-raced) so a
  // pathological create/release partner can never spin us forever. The live
  // holder is bounded by `deadline` instead; this cap is generous relative to
  // it so it only bites on pathology, never on ordinary waiting.
  const maxAttempts = Math.max(100, Math.ceil(waitMs / pollMs) + 100);

  let attempts = 0;
  let lastLiveHolder: SessionSlotRecord | undefined;

  while (true) {
    if (attempts >= maxAttempts) throw new SessionSlotBusyError(endpoint, lastLiveHolder);
    attempts++;

    // 1. Try to take the slot outright.
    try {
      await writeFile(file, payload, { flag: "wx" });
      return { handle };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
    }

    // 2. Occupied. Read the holder to classify it.
    const holder = await readSessionSlot(endpoint);
    if (!holder) continue; // released between our create and our read: retry immediately

    if (!isPidAlive(holder.pid)) {
      // 3. DEAD holder: orphan. Steal it — unlink, then re-create OUR record.
      await unlink(file).catch(() => undefined);
      try {
        await writeFile(file, payload, { flag: "wx" });
        return { handle, staleHolder: holder };
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
        continue; // steal raced another process: retry immediately
      }
    }

    // 4. LIVE holder. If it advertises a mux, JOIN it instead of waiting: the slot
    // is never going to free up, and it does not have to — the holder's mux serves
    // the one real session to every joiner. Return immediately, writing nothing.
    // (The re-read at step 2 happens every iteration, so a holder that advertises a
    // beat after taking the slot is picked up on the next poll.) CDP_FIREFOX_MUX=off
    // opts out and restores the pre-mux busy-wait exactly.
    if (typeof holder.muxEndpoint === "string" && holder.muxEndpoint.length > 0 && process.env.CDP_FIREFOX_MUX !== "off") {
      return { joinMux: { endpoint: holder.muxEndpoint, holder } };
    }
    // No mux: legitimate contention. Poll until the deadline, then fail.
    lastLiveHolder = holder;
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new SessionSlotBusyError(endpoint, holder);
    await sleep(Math.min(pollMs, remaining));
  }
}

/**
 * Publish this holder's BiDi multiplexer endpoint into its OWN slot record, so a
 * contending process joins the mux instead of waiting out the slot.
 *
 * Ownership-guarded by the same (pid, createdAt) test releaseSessionSlot uses: if
 * the record on disk is missing or belongs to someone else (we were stolen from
 * as a dead-looking holder, or we already released), we refuse with
 * { advertised: false } and leave the file byte-for-byte untouched rather than
 * stamping our mux onto a stranger's claim.
 *
 * Atomic: the merged record is written to `<file>.tmp-<pid>` and renamed over the
 * original, so a concurrent acquire's read sees either the old record or the new
 * one, never a truncated one. Every other field is preserved.
 */
export async function advertiseMux(handle: SessionSlotHandle, muxEndpoint: string): Promise<{ advertised: boolean }> {
  const current = await readSessionSlot(handle.endpoint);
  if (!current) return { advertised: false };
  if (current.pid !== process.pid || current.createdAt !== handle.createdAt) return { advertised: false };
  const file = sessionSlotFile(handle.endpoint);
  const tmp = `${file}.tmp-${process.pid}`;
  const next: SessionSlotRecord = { ...current, muxEndpoint };
  try {
    await writeFile(tmp, JSON.stringify(next), "utf8");
    await rename(tmp, file);
  } catch {
    await unlink(tmp).catch(() => undefined);
    return { advertised: false };
  }
  return { advertised: true };
}

/**
 * Release the slot, but ONLY if the record on disk is still the one we wrote.
 *
 * A record is ours iff its pid is this process AND its createdAt matches the
 * handle. That guard is what stops us from unlinking a record another process
 * created after stealing the slot from us (dead-pid steal), which would hand
 * two processes the slot at once. Idempotent: a missing record is released:false.
 */
export async function releaseSessionSlot(handle: SessionSlotHandle): Promise<{ released: boolean }> {
  const current = await readSessionSlot(handle.endpoint);
  if (!current) return { released: false };
  if (current.pid !== process.pid || current.createdAt !== handle.createdAt) return { released: false };
  await unlink(sessionSlotFile(handle.endpoint)).catch(() => undefined); // swallow release races
  return { released: true };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
