/**
 * The three lease tools, shaped like src/shared-tools.ts entries
 * ((driver, args) => Promise<result>) so ONE implementation serves Chrome and
 * Firefox, exactly as the other 20 unified tools do.
 */
import type { BrowserDriver } from "./driver.ts";
import { newTrackedPage } from "./origins.ts";
import {
  claimLease,
  defaultLabel,
  leaseTtlMs,
  listLeases,
  releaseLease,
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

/** Release a held lease. Idempotent: an already-released or reclaimed lease
 *  reports released:false rather than throwing. */
export async function releasePage(
  _driver: BrowserDriver,
  args: { lease?: LeaseToken },
): Promise<{ released: boolean }> {
  if (typeof args.lease !== "string" || !args.lease.length) {
    throw new LeaseToolError("release_page requires the 'lease' token returned by claim_page");
  }
  return releaseLease(args.lease);
}

/** Enumerate active leases for diagnosis. Requires no token by design. */
export async function listLeasesTool(
  driver: BrowserDriver,
  _args: Record<string, never> = {} as Record<string, never>,
): Promise<{ leases: LeaseSummary[]; count: number }> {
  const liveIds = (await driver.listPages()).map((p) => p.id);
  // liveBackend scopes the target-gone test to the browser these ids came from,
  // so leases held on the OTHER backend are not mislabeled as reclaimable.
  const leases = await listLeases({ liveIds, liveBackend: backendOf(driver) });
  return { leases, count: leases.length };
}

export const LEASE_TOOLS = {
  claim_page: claimPage,
  release_page: releasePage,
  list_leases: listLeasesTool,
} satisfies Record<string, (driver: BrowserDriver, args: never) => Promise<unknown>>;
