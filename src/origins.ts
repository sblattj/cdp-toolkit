/**
 * Tab origins: a creation ledger recording every tab THIS TOOLKIT opened.
 *
 * WHY THIS IS NOT list_leases. A lease answers "who is DRIVING this tab right
 * now". Provenance is a different and longer-lived question: "who OPENED this
 * tab". The two diverge the moment an agent releases, expires, or dies, and
 * that is exactly when a human most needs the answer, because from then on the
 * agent's abandoned tab is indistinguishable from one the human opened. So a
 * record here deliberately OUTLIVES the lease and is never removed by
 * release_page, by expiry, or by reclamation.
 *
 * WHY ONE FILE PER TAB, IN THE LEASE DIRECTORY. Same reasoning as leases.ts:
 * two MCP server processes drive one browser, so module state would protect
 * one process and miss the collision that matters, and a single registry file
 * would need its own lock. Exclusive-create ("wx") per tab gives the atomicity
 * for free, and the filename carries enough to describe a row whose contents
 * cannot be read.
 *
 * WHY THE ONLY DELETE IS A REAP ON READ. A background sweeper would be a
 * second lifetime to reason about and a process that has to be running. The
 * ledger is read rarely (list_pages) and the browser's own target list is
 * already in hand at that moment, so dropping records for targets that no
 * longer exist costs nothing and keeps the directory bounded without anything
 * scheduled.
 *
 * WHAT THIS CANNOT PROVE. The absence of a record is not evidence that a human
 * opened the tab: an agent driving Chrome by some other means, a tab restored
 * from a previous session, or a record lost to a write failure all read the
 * same way. That is why the annotation on list_pages says "unknown" and never
 * "human". Never add a "human" value here.
 */
import { mkdir, readFile, readdir, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { BrowserDriver, PageInfo } from "./driver.ts";
import { defaultLabel, leaseDir, type LeaseBackend } from "./leases.ts";

/** What list_pages can say about where a tab came from. There is deliberately
 *  no "human": see the file header. */
export type PageOrigin = "agent" | "unknown";

export interface OriginRecord {
  backend: LeaseBackend;
  targetId: string;
  /** Caller-supplied agent label, or leases.ts's pid-derived default. */
  label: string;
  /** The MCP server process that created the tab. Recorded for diagnosis only:
   *  unlike a lease, this record stays meaningful after that pid is gone. */
  pid: number;
  createdAt: number;
}

/** Same character policy as leaseFile, so the two stores agree on what a
 *  filename-safe id looks like and a reader can compare them. */
function safeId(id: string): string {
  return id.replace(/[^A-Za-z0-9._-]/g, "_");
}

/** Sibling of leases.ts's lease-<backend>-<targetId>.json, same directory. */
export function originFile(backend: LeaseBackend, targetId: string): string {
  return join(leaseDir(), `origin-${backend}-${safeId(targetId)}.json`);
}

const ORIGIN_FILE_RE = /^origin-(chrome|firefox)-(.+)\.json$/;

/**
 * Record that this toolkit just created `targetId`.
 *
 * ATOMICITY MATCHES leases.ts: exclusive create, never a modify in place. A
 * record is written once and thereafter only deleted, so two processes racing
 * on the same id cannot interleave a half-written file.
 *
 * ON EEXIST THE NEW RECORD WINS, and that is the answer to target-id reuse.
 * A browser is free to hand out an id that a closed tab used to hold. Reaping
 * on read makes that benign in the normal case: the old record is dropped the
 * first time anyone lists pages after the old tab closed, so the id is usually
 * free by the time it is reused. If nobody read the ledger in between, the
 * stale record is still sitting there when this runs, and the unlink-then-
 * recreate below replaces it. The residual case is a reused id whose new tab
 * this toolkit did NOT create: that tab inherits the old record and reports
 * origin "agent" with a createdAt older than the tab itself. It errs toward
 * flagging a tab as agent-created, which is the safe direction for a tool whose
 * job is to help a human find stray agent tabs, and the stale createdAt is the
 * tell. Do not "fix" it by trusting the record blindly in the other direction.
 *
 * FAILURES ARE SWALLOWED DELIBERATELY. This is an annotation, not the work the
 * caller asked for: new_page must not fail because a provenance record could
 * not be persisted. The cost is real and worth stating plainly: a tab created
 * while the artifact directory is unwritable reports origin "unknown" forever,
 * with no signal anywhere. If agent tabs ever start reading as unknown, an
 * ENOSPC or EACCES here is the first place to look.
 */
export async function recordOrigin(
  backend: LeaseBackend,
  targetId: string,
  opts: { label?: string; now?: number } = {},
): Promise<void> {
  const record: OriginRecord = {
    backend,
    targetId,
    label: typeof opts.label === "string" && opts.label.length ? opts.label : defaultLabel(),
    pid: process.pid,
    createdAt: opts.now ?? Date.now(),
  };
  const file = originFile(backend, targetId);
  try {
    await mkdir(leaseDir(), { recursive: true });
    try {
      await writeFile(file, JSON.stringify(record), { flag: "wx" });
      return;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
    }
    // A record already exists for this id: the browser reused it. Replace
    // rather than modify in place, so a reader never sees a partial rewrite.
    await unlink(file).catch(() => undefined);
    await writeFile(file, JSON.stringify(record), { flag: "wx" });
  } catch {
    /* annotation only, never fail the caller's real work: see the doc comment */
  }
}

/**
 * Read one origin record, or undefined if this toolkit did not create the tab.
 *
 * UNLIKE readLease, AN UNREADABLE FILE IS NOT RETHROWN HERE. The asymmetry is
 * deliberate and rests on what each answer authorizes. readLease's answer gates
 * ADMISSION to a tab, so "unreadable" reading as "unleased" would hand a held
 * tab to a stranger, and failing the call is the lesser harm. This answer gates
 * nothing: it decorates a listing. Failing list_pages because one provenance
 * file is unreadable would break a working tool over a cosmetic field. The
 * honesty requirement is met a different way, by listOrigins, which reports an
 * unreadable row rather than omitting it, so "unreadable" never silently reads
 * as "no record". Callers that need that distinction use listOrigins, not this.
 */
export async function readOrigin(backend: LeaseBackend, targetId: string): Promise<OriginRecord | undefined> {
  let raw: string;
  try {
    raw = await readFile(originFile(backend, targetId), "utf8");
  } catch {
    return undefined;
  }
  try {
    const rec = JSON.parse(raw) as OriginRecord;
    if (typeof rec?.targetId === "string" && typeof rec?.label === "string" && typeof rec?.createdAt === "number") return rec;
  } catch {
    /* unparseable: see listOrigins, which surfaces it as an unreadable row */
  }
  return undefined;
}

export interface OriginSummary {
  backend: LeaseBackend;
  targetId: string;
  label: string;
  pid: number;
  createdAt: number;
  /**
   * Present ONLY on a row this function could not read: the errno of the failed
   * read, or "unparseable" for a file whose contents are not an origin record.
   * Same convention, and the same reason, as LeaseSummary.unreadable: a
   * silently skipped file is the one thing that makes a broken record
   * impossible to diagnose, and it would make a tab that HAS a record read as
   * a clean "no record at all". Every other field on such a row is a
   * placeholder derived from the FILENAME and nothing else.
   */
  unreadable?: string;
}

/**
 * Enumerate the ledger, dropping records for targets the browser no longer has.
 *
 * `liveIds` is the reap set and is optional on purpose. When it is undefined
 * nothing is reaped: a caller that could not enumerate the browser's targets
 * must not be able to delete the ledger by failing. Passing an EMPTY array is
 * a real statement ("the browser has no targets") and does reap.
 *
 * `liveBackend` scopes the reap to the browser those ids came from, exactly as
 * listLeases does: a Chrome target list says nothing about whether a Firefox
 * context is still open, and reaping on it would delete live Firefox records.
 */
export async function listOrigins(
  opts: { liveIds?: readonly string[]; liveBackend?: LeaseBackend } = {},
): Promise<OriginSummary[]> {
  let names: string[] = [];
  try {
    names = await readdir(leaseDir());
  } catch {
    // Unlike listLeases, an unreadable directory is reported as an empty
    // ledger rather than thrown: every consumer of this list degrades to
    // origin "unknown", which is the honest answer when provenance cannot be
    // read, and no caller of this function is making an authorization decision.
    return [];
  }
  const live = opts.liveIds === undefined ? undefined : new Set(opts.liveIds.map((id) => safeId(id)));
  const out: OriginSummary[] = [];
  for (const name of names) {
    const parts = ORIGIN_FILE_RE.exec(name);
    if (!parts) continue;
    const backend = parts[1] as LeaseBackend;
    const nameId = parts[2] as string;
    // The reap test runs on the FILENAME id, which is the only id an unreadable
    // row has. safeId() is applied to both sides so the comparison is like for
    // like; an id that safeId rewrote is an identifying label, not a key, so a
    // collision would at worst spare a record from reaping.
    const scoped = live !== undefined && (opts.liveBackend === undefined || opts.liveBackend === backend);
    if (scoped && !live.has(nameId)) {
      await unlink(join(leaseDir(), name)).catch(() => undefined);
      continue;
    }
    const fromName: OriginSummary = { backend, targetId: nameId, label: "", pid: 0, createdAt: 0 };
    let rec: OriginRecord;
    try {
      rec = JSON.parse(await readFile(join(leaseDir(), name), "utf8")) as OriginRecord;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      // Vanished between readdir and readFile: reaped by a concurrent reader.
      if (code === "ENOENT") continue;
      out.push({ ...fromName, unreadable: code ?? "unparseable" });
      continue;
    }
    if (typeof rec?.targetId !== "string" || typeof rec?.label !== "string" || typeof rec?.createdAt !== "number") {
      out.push({ ...fromName, unreadable: "unparseable" });
      continue;
    }
    out.push({ backend: rec.backend, targetId: rec.targetId, label: rec.label, pid: rec.pid, createdAt: rec.createdAt });
  }
  return out;
}

/**
 * listOrigins keyed by targetId, for annotating a page listing.
 *
 * NEVER THROWS. The whole annotation is best-effort: a caller that cannot read
 * the ledger reports every page as origin "unknown", which is what a consumer
 * with no ledger at all has always seen. An empty map and a missing ledger are
 * the same thing to the caller by construction.
 */
export async function originIndex(
  backend: LeaseBackend,
  liveIds?: readonly string[],
): Promise<Map<string, OriginSummary>> {
  const rows = await listOrigins({ liveIds, liveBackend: backend }).catch(() => [] as OriginSummary[]);
  const index = new Map<string, OriginSummary>();
  for (const row of rows) {
    if (row.backend !== backend) continue;
    index.set(row.targetId, row);
  }
  return index;
}

/**
 * Open a tab AND record its provenance. THE ONLY WAY THE TOOLKIT SHOULD CREATE
 * A PAGE. Both creation paths (new_page in shared-tools.ts, claim_page opening
 * a fresh tab in leases-tools.ts) route through here so a third path added
 * later cannot forget the ledger write by omission: `driver.newPage(` should
 * appear in exactly one place outside the drivers themselves, which is here.
 */
export async function newTrackedPage(
  driver: BrowserDriver,
  backend: LeaseBackend,
  opts: { url?: string; label?: string } = {},
): Promise<PageInfo> {
  const page = await driver.newPage(opts.url);
  await recordOrigin(backend, page.id, { label: opts.label });
  return page;
}
