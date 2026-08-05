/**
 * Tab leases: one file per leased tab, exclusive-create claims, opaque tokens.
 *
 * WHY A FILE AND NOT MODULE STATE. Two Claude Code sessions each run their own
 * MCP server process against the same Chrome on port 9222 (see backend.ts's
 * header), so in-process state would protect two agents inside one process and
 * miss the case that actually collides. Intermittent protection is worse than
 * none, because a caller learns to distrust a refusal it only sometimes gets.
 *
 * WHY ONE FILE PER TAB AND NOT ONE REGISTRY. A shared registry file would need
 * its own lock to make "check if free, then claim" atomic, which relocates the
 * race one level up. Filesystem exclusive-create (the "wx" flag below) gives
 * that atomicity per tab for free. This is the first use of "wx" in the repo.
 *
 * WHY THE TOKEN EMBEDS A NONCE. Reclaiming a stale lease mints a fresh nonce,
 * so the superseded token stops matching by construction rather than by a check
 * someone could forget to write. See assertLeaseOk.
 *
 * THE ONE WRITE THAT COULD BREAK THAT GUARANTEE is touchLease, because it is
 * the only write here that is not an exclusive create. Everything else either
 * creates with "wx" or unlinks, so a record can never be modified in place and
 * a nonce can never survive a reclamation. touchLease has to rewrite an
 * existing file, so it re-reads and re-checks the nonce immediately before
 * writing and writes only what it just read. Anyone adding a second
 * non-exclusive write to this module owes the same guard, or the whole feature
 * loses the property it rests on.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { randomBytes } from "node:crypto";
import { mkdir, readFile, readdir, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";

/** Opaque ownership token. Hold it, pass it back, never parse or build one. */
export type LeaseToken = string;

/** Ownership is keyed by backend plus id: a CDP targetId and a BiDi context id
 *  are not guaranteed disjoint, so a bare id could collide across browsers. */
export type LeaseBackend = "chrome" | "firefox";

export interface LeaseRecord {
  backend: LeaseBackend;
  targetId: string;
  /** The value embedded in the token, compared on every call. */
  nonce: string;
  /** Owning MCP server process. */
  pid: number;
  /** Caller-supplied agent label, surfaced in conflicts and list_leases. */
  label: string;
  createdAt: number;
  lastUsedAt: number;
  ttlMs: number;
}

/** 15 minutes. Refresh-on-use means an active agent never expires, so this only
 *  bites on abandonment and can afford to be generous. */
export const DEFAULT_LEASE_TTL_MS = 900_000;

/** Read per call, not at module load, so a test can redirect the directory. */
export function leaseDir(): string {
  return process.env.CDP_ARTIFACT_DIR ?? "/tmp/cdp-toolkit";
}

export function leaseTtlMs(): number {
  const raw = Number(process.env.CDP_LEASE_TTL_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_LEASE_TTL_MS;
}

function safeId(id: string): string {
  return id.replace(/[^A-Za-z0-9._-]/g, "_");
}

/** Sibling of recorder.ts's rec-<targetId>.jsonl, in the same ARTIFACT_DIR. */
export function leaseFile(backend: LeaseBackend, targetId: string): string {
  return join(leaseDir(), `lease-${backend}-${safeId(targetId)}.json`);
}

export function mintToken(backend: LeaseBackend, targetId: string, nonce: string): LeaseToken {
  return `${backend}:${targetId}:${nonce}`;
}

/** Split on the FIRST and LAST colon so an id containing a colon still parses. */
export function tokenParts(token: LeaseToken): { backend: LeaseBackend; targetId: string; nonce: string } | undefined {
  if (typeof token !== "string") return undefined;
  const first = token.indexOf(":");
  const last = token.lastIndexOf(":");
  if (first <= 0 || last <= first) return undefined;
  const backend = token.slice(0, first);
  if (backend !== "chrome" && backend !== "firefox") return undefined;
  const targetId = token.slice(first + 1, last);
  const nonce = token.slice(last + 1);
  if (!targetId.length || !/^[0-9a-f]{24}$/.test(nonce)) return undefined;
  return { backend, targetId, nonce };
}

export class LeaseConflictError extends Error {
  constructor(
    message: string,
    readonly targetId: string,
    readonly holder?: string,
  ) {
    super(message);
    this.name = "LeaseConflictError";
  }
}

/**
 * Read a lease record, or undefined if the tab is genuinely unleased.
 *
 * "UNREADABLE" IS NOT "ABSENT", AND CONFLATING THEM IS WRONG IN BOTH DIRECTIONS
 * AT ONCE. Enforcement reads `undefined` as "free to take". If an EACCES, EIO or
 * EMFILE on a live, healthy lease file also produced `undefined`, a stranger
 * would be ADMITTED to a tab someone owns, while the true owner would be
 * REFUSED with "not leased any more" (its token names a tab that now reads as
 * unleased). Fd exhaustion on a long-lived MCP server is the most plausible
 * trigger. So every errno other than ENOENT is rethrown and the call fails.
 *
 * FAILING CLOSED HERE CANNOT REGRESS THE UPGRADE PATH, and that is what makes
 * it safe: a user who never calls claim_page and never passes claim:true has NO
 * lease files at all, so every read here is a plain ENOENT and this throw is
 * unreachable for them. Only a tab that already has a lease file can reach it.
 *
 * A record that reads fine but does not PARSE is treated as absent instead,
 * deliberately: a corrupt record can never become readable, so throwing would
 * brick that tab permanently with no in-product recovery, whereas an errno is
 * transient. Only this module writes these files, so a parse failure means the
 * file was tampered with, not that the writer is buggy. listLeases reports such
 * a file so an operator can see it and delete it.
 */
export async function readLease(backend: LeaseBackend, targetId: string): Promise<LeaseRecord | undefined> {
  let raw: string;
  try {
    raw = await readFile(leaseFile(backend, targetId), "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined; // genuinely unleased
    throw err; // unreadable is not absent: refuse rather than hand out a held tab
  }
  try {
    const rec = JSON.parse(raw) as LeaseRecord;
    if (typeof rec?.nonce === "string" && typeof rec?.pid === "number") return rec;
  } catch {
    /* unparseable: fall through to undefined, see the doc comment above */
  }
  return undefined;
}

export interface ClaimOptions {
  label: string;
  ttlMs?: number;
  now?: number;
  /** Live target ids from the browser, enabling the "target-gone" reclamation. */
  liveIds?: readonly string[];
}

/** Why an existing lease may be taken over. All three are sufficient alone. */
export type LeaseStaleReason = "dead-pid" | "expired" | "target-gone";

/** Signal-0 liveness probe. EPERM means the pid exists but belongs to another
 *  user, which still counts as alive. */
export function isPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * Classify a lease. `liveIds` is passed in by the caller rather than looked up
 * here on purpose: it is the only browser-derived input this module needs, and
 * taking it as data keeps leases.ts free of any CDP or BiDi import, which is
 * what makes the negative tests cheap to run.
 */
export function staleReason(
  rec: LeaseRecord,
  opts: { now: number; liveIds?: readonly string[] },
): LeaseStaleReason | false {
  if (!isPidAlive(rec.pid)) return "dead-pid";
  if (opts.now - rec.lastUsedAt > rec.ttlMs) return "expired";
  if (opts.liveIds && !opts.liveIds.includes(rec.targetId)) return "target-gone";
  return false;
}

/** Take exclusive ownership. Throws LeaseConflictError if the tab is held and
 *  not stale. A stale lease is reclaimed: the old file is unlinked and a fresh
 *  record with a fresh nonce is created, never overwritten in place, so the
 *  superseded token stops matching by construction. */
export async function claimLease(
  backend: LeaseBackend,
  targetId: string,
  opts: ClaimOptions,
): Promise<{ token: LeaseToken; record: LeaseRecord }> {
  const now = opts.now ?? Date.now();
  await mkdir(leaseDir(), { recursive: true });
  for (let attempt = 0; attempt < 3; attempt++) {
    const record: LeaseRecord = {
      backend,
      targetId,
      // A fresh nonce on EVERY attempt, so a reclamation cannot reuse the
      // nonce it displaced. This is what invalidates the old owner's token.
      nonce: randomBytes(12).toString("hex"),
      pid: process.pid,
      label: opts.label,
      createdAt: now,
      lastUsedAt: now,
      ttlMs: opts.ttlMs ?? leaseTtlMs(),
    };
    try {
      await writeFile(leaseFile(backend, targetId), JSON.stringify(record), { flag: "wx" });
      return { token: mintToken(backend, targetId, record.nonce), record };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
    }
    const existing = await readLease(backend, targetId);
    if (!existing) continue; // released between our create and our read: retry
    const stale = staleReason(existing, { now, liveIds: opts.liveIds });
    if (!stale) {
      throw new LeaseConflictError(
        `target '${targetId}' is already leased by '${existing.label}' (pid ${existing.pid}); call release_page with that lease's token, or list_leases to inspect it`,
        targetId,
        existing.label,
      );
    }
    await unlink(leaseFile(backend, targetId)).catch(() => undefined);
  }
  throw new LeaseConflictError(
    `target '${targetId}' could not be claimed after 3 attempts: another process is claiming and releasing it concurrently`,
    targetId,
  );
}

/** Give up a lease. Idempotent: releasing an already-gone lease is not an error. */
export async function releaseLease(token: LeaseToken): Promise<{ released: boolean }> {
  const parts = tokenParts(token);
  if (!parts) return { released: false };
  const rec = await readLease(parts.backend, parts.targetId);
  if (!rec || rec.nonce !== parts.nonce) return { released: false };
  await unlink(leaseFile(parts.backend, parts.targetId)).catch(() => undefined);
  return { released: true };
}

/** Drop whatever lease a tab has, token or not. Only for close_page, which is
 *  already authorized against the lease by the time it calls this. */
export async function releaseLeaseFor(backend: LeaseBackend, targetId: string): Promise<{ released: boolean }> {
  if (!(await readLease(backend, targetId))) return { released: false };
  await unlink(leaseFile(backend, targetId)).catch(() => undefined);
  return { released: true };
}

/* -------------------------------- the gate -------------------------------- */

/**
 * The lease token for the tool call currently being dispatched.
 *
 * This exists so enforcement can stay at ONE point per resolution path while
 * the token still reaches it. The token arrives as a key on a tool's args
 * object, many frames above resolveTarget, and threading a parameter through
 * all 36 tools would put the burden on every future contributor to remember
 * the check exists: one missed tool would silently defeat the feature for that
 * tool. mcp.ts and cli.ts open this scope once per dispatch instead, so a tool
 * added tomorrow is covered with no action from whoever writes it.
 */
const leaseScope = new AsyncLocalStorage<LeaseToken | undefined>();

export function withLeaseScope<T>(lease: LeaseToken | undefined, fn: () => Promise<T>): Promise<T> {
  return leaseScope.run(lease, fn);
}

export function currentLease(): LeaseToken | undefined {
  return leaseScope.getStore();
}

/** Pull the token off a tool's loosely-typed args object at the dispatch site.
 *  Kept here rather than duplicated in mcp.ts and cli.ts so the two entry points
 *  can never disagree about what counts as a token. An empty string is treated
 *  as absent: a caller that sends lease:"" means "no lease", and letting it
 *  through would trip the malformed-token branch with a confusing message. */
export function leaseFromArgs(args: unknown): LeaseToken | undefined {
  if (!args || typeof args !== "object") return undefined;
  const lease = (args as { lease?: unknown }).lease;
  return typeof lease === "string" && lease.length > 0 ? lease : undefined;
}

/**
 * Refresh lastUsedAt. Every checked call already touches this file, so keeping
 * an active lease alive needs no separate heartbeat.
 *
 * THIS IS THE ONE WRITE IN THIS MODULE THAT IS NOT AN EXCLUSIVE CREATE, so it
 * is the one write that could violate the nonce guarantee. `rec` was read some
 * time ago by the caller; between that read and this write another process can
 * reclaim the tab, which unlinks the file and creates a new one with a fresh
 * nonce. A blind `writeFile` of `rec` would then clobber the new owner's record
 * with the old nonce: the new owner's token would start failing and the
 * superseded one would start passing. That is the two-owner failure inverted.
 *
 * So this re-reads and compares the nonce immediately before writing, and
 * writes the record it just read rather than the caller's older copy. A lease
 * that was reclaimed or released underneath us is left alone.
 *
 * Errors are swallowed DELIBERATELY: this is a heartbeat, and a tool call that
 * did real work must not fail because a lastUsedAt refresh could not be
 * persisted. The cost of that choice is real and worth stating plainly: an
 * EACCES or ENOSPC here means the holder's lease quietly stops being refreshed
 * and expires under it after ttlMs, with no signal anywhere. If lease
 * expiry-under-load ever gets reported, this silence is the first place to look.
 */
export async function touchLease(rec: LeaseRecord, now: number = Date.now()): Promise<void> {
  // readLease now THROWS on an unreadable file rather than reporting absence.
  // That throw is load-bearing at the gate and must not leak out of a
  // heartbeat, so it is caught here and treated as "leave the record alone",
  // which is the same thing this function does for any record it does not own.
  const current = await readLease(rec.backend, rec.targetId).catch(() => undefined);
  if (!current || current.nonce !== rec.nonce) return; // reclaimed or released: not ours to write
  await writeFile(leaseFile(current.backend, current.targetId), JSON.stringify({ ...current, lastUsedAt: now }), "utf8").catch(
    () => undefined,
  );
}

export interface LeaseCheckContext {
  /** Explicit token. Falls back to the ambient dispatch scope when absent. */
  lease?: LeaseToken;
  url?: string;
  title?: string;
  /** Live ids from the resolution the caller just did, for "target-gone". */
  liveIds?: readonly string[];
  now?: number;
}

function describeTarget(targetId: string, ctx: LeaseCheckContext): string {
  const url = ctx.url ? ` (url ${ctx.url})` : ctx.title ? ` (title ${JSON.stringify(ctx.title)})` : "";
  return `target '${targetId}'${url}`;
}

/**
 * The single enforcement point, called from every target-resolution path.
 *
 * NOT an ADR-001 capability gap. ADR-001 says a capability a backend can never
 * do is ABSENT from tools/list rather than present and throwing, because that
 * gap is static and known before the first call. A lease conflict is the
 * opposite: the same tool against the same tab succeeds or fails depending on
 * who holds it at that instant. There is nothing to remove from tools/list,
 * because the tool is not unsupported, it is supported and currently spoken
 * for. So this throws, loudly, naming the holder. Do not "fix" the
 * inconsistency with ADR-001 by hiding leased tools from tools/list: the two
 * situations differ in kind, not degree.
 */
export async function assertLeaseOk(
  backend: LeaseBackend,
  targetId: string,
  ctx: LeaseCheckContext = {},
): Promise<void> {
  const token = ctx.lease ?? currentLease();
  const now = ctx.now ?? Date.now();
  // NOT wrapped in a catch. If the lease file exists but cannot be read,
  // readLease throws and that error propagates out of the gate, failing the
  // call. Swallowing it here would put us back where "unreadable" means
  // "unleased", which admits a stranger to a held tab. See readLease.
  const rec = await readLease(backend, targetId);
  const held = rec && !staleReason(rec, { now, liveIds: ctx.liveIds }) ? rec : undefined;
  const where = describeTarget(targetId, ctx);

  if (token === undefined) {
    if (!held) return; // unleased, or leased-but-reclaimable: today's behavior
    throw new LeaseConflictError(
      `${where} is leased by '${held.label}' (pid ${held.pid}). Pass that lease's token as the 'lease' argument, or call release_page to free it. list_leases shows every active lease.`,
      targetId,
      held.label,
    );
  }

  const parts = tokenParts(token);
  if (!parts) {
    throw new LeaseConflictError(
      `malformed lease token for ${where}. Pass back the token claim_page returned, never a constructed one.`,
      targetId,
    );
  }
  // The "is this token even about this tab" question comes FIRST, before the
  // "is this tab leased" question. Order matters: holding a token for TAB-A
  // must not change what happens when you touch an unrelated TAB-C. If the
  // mismatch check ran second, a token for another tab would fall into the
  // !held branch below and refuse every unleased tab with a message about a
  // lease that was "released or reclaimed", which is both wrong and confusing.
  // Under the ambient dispatch scope that is the COMMON case, not an edge one:
  // any agent holding one tab that touches a second unleased tab in the same
  // call arrives here, select_page via activatePage included.
  if (parts.backend !== backend || parts.targetId !== targetId) {
    // The token is about a different tab, so it says nothing about this one.
    // An unleased tab is open to everyone, token in hand or not.
    if (!held) return;
    throw new LeaseConflictError(
      `the lease token you passed is for ${parts.backend} target '${parts.targetId}', not ${where}, which is leased by '${held.label}'. Resolve the tab you actually hold, or claim this one.`,
      targetId,
      held.label,
    );
  }
  // From here the token names THIS tab, so the caller believes it holds this
  // tab. Being wrong about that is an error, never a pass-through.
  if (!held) {
    throw new LeaseConflictError(
      `${where} is not leased any more: the token you passed belongs to a lease that was released or reclaimed. Call claim_page again to take the tab.`,
      targetId,
    );
  }
  // The nonce match is what makes reclamation safe. Without it a stalled agent
  // that comes back after its lease was reclaimed would sail through with a
  // token whose backend and targetId still line up, and two owners would be
  // driving one tab. claimLease mints a fresh nonce on every create, so the
  // superseded token can never match here.
  if (parts.nonce !== held.nonce) {
    throw new LeaseConflictError(
      `${where} was reclaimed and is now leased by '${held.label}' (pid ${held.pid}). Your token was invalidated by that reclamation. Call claim_page again if you still need this tab.`,
      targetId,
      held.label,
    );
  }
  await touchLease(held, now);
}

/* ------------------------------- enumeration ------------------------------- */

export interface LeaseSummary {
  backend: LeaseBackend;
  targetId: string;
  label: string;
  pid: number;
  createdAt: number;
  lastUsedAt: number;
  ttlMs: number;
  pidAlive: boolean;
  stale: LeaseStaleReason | false;
  /**
   * Present ONLY on a row this function could not read: the errno of the failed
   * read, or "unparseable" for a file whose contents are not a lease record.
   * The row still appears, because the whole point of this tool is to show an
   * operator what is on disk, and a silently skipped file is the one thing that
   * makes an unreadable lease impossible to diagnose. Every other field on such
   * a row is a placeholder derived from the FILENAME and nothing else: backend
   * and targetId are real (the filename carries both), the rest are zeroed. It
   * reports stale:false so the row never reads as "free to take".
   */
  unreadable?: string;
}

const LEASE_FILE_RE = /^lease-(chrome|firefox)-(.+)\.json$/;

/**
 * Enumerate every lease on disk. Diagnosis only, so it needs no token.
 *
 * `liveIds` comes from ONE browser, but this enumeration spans both backends,
 * so `liveBackend` names which backend those ids belong to and the target-gone
 * test is applied only to records of that backend. Without that scoping, a
 * caller listing from Chrome would see every Firefox lease reported as
 * target-gone (its context ids are simply not in Chrome's target list), which
 * reads as "free to take" for a lease that is very much held.
 *
 * Residual: for records of the OTHER backend, the target-gone test is never
 * evaluated, so a cross-backend lease whose tab really did close reports
 * stale:false until its owning pid dies or its ttlMs elapses. That errs
 * toward "held", which is the safe direction, and a Firefox lease fails the
 * dead-pid test as soon as its per-invocation process exits.
 */
export async function listLeases(
  opts: { now?: number; liveIds?: readonly string[]; liveBackend?: LeaseBackend } = {},
): Promise<LeaseSummary[]> {
  const now = opts.now ?? Date.now();
  let names: string[] = [];
  try {
    names = await readdir(leaseDir());
  } catch (err) {
    // An absent directory means nobody has ever claimed anything, which is the
    // normal state for a user who never opts in and is genuinely "no leases".
    // Any OTHER errno means leases may exist and we cannot see them, and
    // answering "none" to that question is exactly the hidden failure this
    // function is supposed to expose. Fail loudly instead.
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
  const out: LeaseSummary[] = [];
  for (const name of names) {
    const parts = LEASE_FILE_RE.exec(name);
    if (!parts) continue;
    // Everything the filename alone can tell us, used only to describe a row
    // whose contents we could not read. safeId() may have substituted
    // characters in the id, so this is an identifying label, not a key.
    const fromName = {
      backend: parts[1] as LeaseBackend,
      targetId: parts[2] as string,
      label: "",
      pid: 0,
      createdAt: 0,
      lastUsedAt: 0,
      ttlMs: 0,
      pidAlive: false,
      // Never "reclaimable": we do not know, and this errs toward held.
      stale: false as const,
    };
    let rec: LeaseRecord;
    try {
      rec = JSON.parse(await readFile(join(leaseDir(), name), "utf8")) as LeaseRecord;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      // A file that vanished between readdir and readFile is not a problem; it
      // was released. Anything else is reported rather than skipped.
      if (code === "ENOENT") continue;
      out.push({ ...fromName, unreadable: code ?? "unparseable" });
      continue;
    }
    if (typeof rec?.nonce !== "string" || typeof rec?.pid !== "number") {
      out.push({ ...fromName, unreadable: "unparseable" });
      continue;
    }
    out.push({
      backend: rec.backend,
      targetId: rec.targetId,
      label: rec.label,
      pid: rec.pid,
      createdAt: rec.createdAt,
      lastUsedAt: rec.lastUsedAt,
      ttlMs: rec.ttlMs,
      pidAlive: isPidAlive(rec.pid),
      // The nonce never leaves this function: it is not in LeaseSummary, so a
      // diagnosis read can never be turned into a forged token.
      stale: staleReason(rec, {
        now,
        liveIds: opts.liveBackend === undefined || opts.liveBackend === rec.backend ? opts.liveIds : undefined,
      }),
    });
  }
  return out;
}
