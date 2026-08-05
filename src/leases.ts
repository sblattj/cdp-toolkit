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
 */
import { randomBytes } from "node:crypto";
import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
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

export async function readLease(backend: LeaseBackend, targetId: string): Promise<LeaseRecord | undefined> {
  try {
    const rec = JSON.parse(await readFile(leaseFile(backend, targetId), "utf8")) as LeaseRecord;
    if (typeof rec?.nonce === "string" && typeof rec?.pid === "number") return rec;
    return undefined;
  } catch {
    return undefined;
  }
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
