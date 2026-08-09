/**
 * Closing tabs whose agent died, without a background sweeper.
 *
 * WHY REAP AT ALL. release_page closes a tab an agent gives back, but an agent
 * that crashes, is killed, or simply stops calling never gives anything back.
 * Its tab stays open forever with a lease file nobody will ever release. That
 * is the failure this module exists for, and it is the common one: a timeout is
 * a more likely end to an agent than a clean shutdown.
 *
 * WHY REAP-ON-READ AND NOT A SWEEPER. Same reasoning as origins.ts's ledger: a
 * background sweeper is a second lifetime to reason about and a process that
 * has to be running. list_pages and list_leases already hold the browser's
 * target list and the lease directory at the moment they run, so doing it there
 * costs one extra pass over data already in hand and needs nothing scheduled.
 *
 * WHY THE SELECTION IS A PURE FUNCTION. Every mistake in this module closes a
 * tab someone wanted. A pure selector over plain data is testable across the
 * whole matrix of {provenance} x {lease state} x {liveness} with no browser and
 * no filesystem, which is the only way to be confident about a destructive
 * operation. The impure wrapper below does nothing but call it and act.
 */
import type { BrowserDriver } from "./driver.ts";
import { listLeases, releaseLeaseFor, type LeaseBackend, type LeaseSummary } from "./leases.ts";
import { originIndex, type OriginSummary } from "./origins.ts";

export interface ReapedTab {
  targetId: string;
  label: string;
  /** Why it was reaped. Deliberately narrower than LeaseStaleReason: see below. */
  reason: "dead-pid" | "expired";
}

export interface ReapInput {
  backend: LeaseBackend;
  /**
   * Ids from the PAGE-ONLY listing, never from an `all:true` listing. A worker,
   * iframe or background page can carry a lease (pickPage's bare-id branch
   * resolves non-page targets), and "close the stale tab" is meaningless for
   * one. This is a different set from the one shared-tools' reapSet feeds to the
   * origin ledger, which deliberately uses the unfiltered listing so a live but
   * filtered-out target does not lose its provenance record. Two reaps, two
   * questions, two id sets: do not merge them.
   */
  livePageIds: readonly string[];
  origins: ReadonlyMap<string, OriginSummary>;
  leases: readonly LeaseSummary[];
}

/**
 * Select the tabs that may be closed. PURE: no I/O, no driver, no clock.
 *
 * All four conditions must hold, and condition 4 is the load-bearing one:
 *
 *  1. the lease row is for this backend and READABLE. An `unreadable` row is
 *     never reaped for the same reason listLeases reports it as stale:false -
 *     we cannot see who owns it, and a guess in the destructive direction is
 *     the one guess that cannot be undone.
 *  2. it is stale for `dead-pid` or `expired`. NOT `target-gone`, which means
 *     the tab is already closed and there is nothing to do, and obviously not
 *     `false`.
 *  3. the target is actually still open, per livePageIds.
 *  4. the toolkit OPENED it. An agent-created tab with NO lease is deliberately
 *     never reaped: that is exactly what new_page produces for a user who never
 *     touches leases, and closing those would be a data-loss bug rather than a
 *     cleanup. Only a tab that was claimed and then abandoned qualifies.
 */
export function staleAgentTabs(input: ReapInput): ReapedTab[] {
  const live = new Set(input.livePageIds);
  const out: ReapedTab[] = [];
  for (const row of input.leases) {
    if (row.backend !== input.backend) continue;
    if (row.unreadable !== undefined) continue;
    if (row.stale !== "dead-pid" && row.stale !== "expired") continue;
    if (!live.has(row.targetId)) continue;
    const origin = input.origins.get(row.targetId);
    if (origin === undefined || origin.unreadable !== undefined) continue;
    out.push({ targetId: row.targetId, label: row.label, reason: row.stale });
  }
  return out;
}

/**
 * Select, close, and drop the leases. Returns ONLY the tabs actually closed.
 *
 * A close that fails is not reported, and that asymmetry is deliberate: the
 * caller filters its listing by this array, so reporting a tab we failed to
 * close would hide a tab that is still open. Failing quietly leaves the tab
 * visible and the lease in place, and the next read tries again.
 *
 * The lease file is unlinked; the ORIGIN record is not. listOrigins already
 * reaps records for targets the browser no longer has, so the record disappears
 * on the next listing. One lifetime rule for origin records, not three.
 */
export async function reapStaleAgentTabs(driver: BrowserDriver, backend: LeaseBackend): Promise<ReapedTab[]> {
  // The PAGE-ONLY listing: see ReapInput.livePageIds.
  const livePageIds = (await driver.listPages()).map((p) => p.id);
  const [origins, leases] = await Promise.all([
    // undefined liveIds = reap nothing from the ledger here. Reaping origin
    // records is list_pages' job and it uses a DIFFERENT id set (the unfiltered
    // listing); doing it here too would delete records for targets that are
    // live but filtered out of the page-only view.
    originIndex(backend, undefined),
    listLeases({ liveIds: livePageIds, liveBackend: backend }).catch(() => [] as LeaseSummary[]),
  ]);
  const candidates = staleAgentTabs({ backend, livePageIds, origins, leases });
  const closed: ReapedTab[] = [];
  for (const c of candidates) {
    const res = await driver.closePage(c.targetId).catch(() => ({ success: false }));
    if (res.success !== true) continue;
    await releaseLeaseFor(backend, c.targetId);
    closed.push(c);
  }
  return closed;
}
