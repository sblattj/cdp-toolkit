/**
 * The three lease tools, shaped like src/shared-tools.ts entries
 * ((driver, args) => Promise<result>) so ONE implementation serves Chrome and
 * Firefox, exactly as the 23 unified tools in that file do.
 */
import type { BrowserDriver } from "./driver.ts";
import { newTrackedPage, readOrigin } from "./origins.ts";
import { reapStaleAgentTabs, type ReapedTab } from "./reap.ts";
import { resolvePage } from "./shared-tools.ts";
import type { TargetSelector } from "./types.ts";
import {
  claimLease,
  defaultLabel,
  leaseTtlMs,
  listLeases,
  releaseLease,
  releaseLeaseFor,
  requireLease,
  tokenParts,
  type LeaseBackend,
  type LeaseSummary,
  type LeaseToken,
} from "./leases.ts";

class LeaseToolError extends Error {}

/** The driver's uid scheme is the one stable per-backend discriminator on the
 *  BrowserDriver surface ("cdp" for Chrome, "bidi" for Firefox). */
function backendOf(driver: BrowserDriver): LeaseBackend {
  return driver.scheme === "bidi" ? "firefox" : "chrome";
}

export interface ClaimPageResult {
  lease: LeaseToken;
  targetId: string;
  url: string;
  label: string;
  ttlMs: number;
  expiresAt: number;
}

/**
 * Claim a tab. With no targetId, opens a fresh tab first (optionally at `url`)
 * and claims that, so "give me my own tab" is one call. With a targetId, claims
 * an already-open tab.
 */
export async function claimPage(
  driver: BrowserDriver,
  args: { targetId?: string; url?: string; label?: string; ttlMs?: number } = {},
): Promise<ClaimPageResult> {
  const backend = backendOf(driver);
  const label = typeof args.label === "string" && args.label.length ? args.label : defaultLabel();
  const pages = await driver.listPages();
  let targetId = args.targetId;
  let url = args.url ?? "about:blank";
  if (targetId === undefined || targetId === "") {
    // Creation ledger, not the lease: this record survives release_page and
    // expiry, so the tab stays attributable to `label` after the lease is gone.
    // Claiming an EXISTING tab (the else branch) records nothing, because this
    // toolkit did not create it and provenance is not ownership.
    const page = await newTrackedPage(driver, backend, { url: args.url, label });
    targetId = page.id;
    url = page.url;
  } else {
    const existing = pages.find((p) => p.id === targetId);
    if (!existing) throw new LeaseToolError(`claim_page: no page target with id '${targetId}'`);
    url = existing.url;
  }
  const liveIds = [...pages.map((p) => p.id), targetId];
  const { record, token } = await claimLease(backend, targetId, {
    label,
    ttlMs: typeof args.ttlMs === "number" && args.ttlMs > 0 ? args.ttlMs : leaseTtlMs(),
    liveIds,
  });
  return {
    lease: token,
    targetId,
    url,
    label: record.label,
    ttlMs: record.ttlMs,
    expiresAt: record.lastUsedAt + record.ttlMs,
  };
}

/**
 * Give a lease back, and close the tab if this toolkit opened it.
 *
 * TWO WAYS IN, because an auto-acquired lease never handed the caller a token:
 * `lease` is the 1.4.0 path, `target` resolves through shared-tools' resolvePage
 * and is authorized by the same gate as any other call. Exactly one is required;
 * accepting both would leave it ambiguous which one authorizes the close.
 *
 * WHY PROVENANCE DECIDES THE CLOSE. A lease says who is driving a tab, never who
 * opened it. Closing on release is right for a tab this toolkit opened for an
 * agent and wrong for a tab the human already had open and an agent merely
 * claimed. origins.ts records exactly that distinction and its records outlive
 * the lease, so the answer is still there at release time.
 *
 * A RELEASE THAT DID NOT HAPPEN NEVER CLOSES. An already-released or reclaimed
 * lease reports released:false, and the tab may well belong to another agent by
 * then; closing it would destroy a tab someone else is driving. This is the one
 * rule in this function that is a safety property rather than a convenience.
 */
export async function releasePage(
  driver: BrowserDriver,
  args: { lease?: LeaseToken; target?: TargetSelector; close?: boolean } = {},
): Promise<{ released: boolean; closed: boolean; targetId?: string }> {
  const hasLease = typeof args.lease === "string" && args.lease.length > 0;
  const hasTarget = typeof args.target === "string" && args.target.length > 0;
  if (hasLease === hasTarget) {
    throw new LeaseToolError(
      "release_page takes exactly one of 'lease' (the token claim_page returned) or 'target' (a selector for a tab this process holds)",
    );
  }

  const backend = backendOf(driver);
  let targetId: string;
  let released: boolean;

  if (hasLease) {
    const parts = tokenParts(args.lease as LeaseToken);
    // A malformed token names no tab, so there is nothing to release and
    // nothing to close. Idempotent rather than throwing, as in 1.4.0.
    if (!parts) return { released: false, closed: false };
    targetId = parts.targetId;
    released = (await releaseLease(args.lease as LeaseToken)).released;
  } else {
    // resolvePage runs assertLeaseOk, which IS the authorization: a tab held by
    // another process throws here, and under strict mode an unleased tab is
    // acquired first, so the caller holds it by the time we release it.
    const page = await resolvePage(driver, args.target);
    targetId = page.id;
    released = (await releaseLeaseFor(backend, targetId)).released;
  }

  if (!released) return { released: false, closed: false, ...(hasTarget ? { targetId } : {}) };

  const shouldClose =
    args.close === false ? false
    : args.close === true ? true
    : (await readOrigin(backend, targetId)) !== undefined;
  if (!shouldClose) return { released: true, closed: false, targetId };

  // The release already succeeded and is not undone by a failed close: the
  // caller has genuinely given the lease back either way, and throwing here
  // would report a release that did happen as an error.
  const res = await driver.closePage(targetId).catch(() => ({ success: false }));
  return { released: true, closed: res.success === true, targetId };
}

/** Enumerate active leases for diagnosis. Requires no token by design. */
export async function listLeasesTool(
  driver: BrowserDriver,
  _args: Record<string, never> = {} as Record<string, never>,
): Promise<{ leases: LeaseSummary[]; count: number; reaped?: ReapedTab[] }> {
  const backend = backendOf(driver);
  // Same reap as list_pages, and for the same reason: this is the other tool an
  // operator runs when tabs look wrong, so it must not report a lease it is
  // about to delete. Strict mode only.
  const reaped = requireLease() ? await reapStaleAgentTabs(driver, backend) : [];
  const reapedIds = new Set(reaped.map((r) => r.targetId));
  const liveIds = (await driver.listPages()).map((p) => p.id);
  // liveBackend scopes the target-gone test to the browser these ids came from,
  // so leases held on the OTHER backend are not mislabeled as reclaimable.
  const all = await listLeases({ liveIds, liveBackend: backend });
  const leases = all.filter((l) => !(l.backend === backend && reapedIds.has(l.targetId)));
  return { leases, count: leases.length, ...(reaped.length ? { reaped } : {}) };
}

export const LEASE_TOOLS = {
  claim_page: claimPage,
  release_page: releasePage,
  list_leases: listLeasesTool,
} satisfies Record<string, (driver: BrowserDriver, args: never) => Promise<unknown>>;
