/**
 * The three lease tools, shaped like src/shared-tools.ts entries
 * ((driver, args) => Promise<result>) so ONE implementation serves Chrome and
 * Firefox, exactly as the 23 unified tools in that file do.
 */
import { beaconSupported, contentionWarning, installBeacon, readHumanActiveMs } from "./activity.ts";
import type { BrowserDriver } from "./driver.ts";
import { newTrackedPage, readOrigin } from "./origins.ts";
import { reapStaleAgentTabs, type ReapedTab } from "./reap.ts";
import { pickPage, resolvePage } from "./shared-tools.ts";
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
  /** true when this call CREATED the tab, false when it claimed one that was
   *  already open. The same distinction the creation ledger records, surfaced
   *  in the answer so a caller knows without a second lookup whether
   *  release_page will close the tab. */
  opened: boolean;
  /**
   * Milliseconds since the last input this server cannot account for — i.e.
   * since a HUMAN last touched this tab. See src/activity.ts for how that
   * attribution is made and what it cannot prove.
   *
   * `null` means NO DATA, and never "no human": the tab carries no beacon (the
   * usual case the first time anyone claims a person's tab), or every timestamp
   * on it is explained by this server's own dispatches. ABSENT ENTIRELY on a
   * backend with no beacon support, so a caller can tell "this browser cannot
   * answer" from "this browser answered, and the answer is no data".
   */
  humanActiveMs?: number | null;
  /**
   * Present only on a TAKEOVER of a tab a human used within the last 30s. A
   * warning, never a refusal — the claim in this same result already succeeded.
   * See contentionWarning in src/activity.ts for why refusing would be wrong.
   */
  contention?: string;
}

/**
 * Claim a tab, in one of two modes.
 *
 * OPEN: with neither `target` nor `targetId`, opens a fresh tab (optionally at
 * `url`) and claims that, so "give me my own tab" is one call.
 *
 * TAKE OVER: with `target`, claims a tab that is ALREADY OPEN — the first-class
 * path for "work in the tab I have open", which previously had none, because
 * `targetId` demands an exact id a human never has to hand and no id at all
 * meant a brand new tab. `target` takes the toolkit's whole selector grammar
 * (active | index:N | url:<substr> | title:<substr> | <targetId>).
 *
 * `targetId` is unchanged and still accepted; `target` is the same thing with a
 * grammar, so exactly one of the two may be given.
 *
 * WHY RESOLUTION IS GATE-FREE HERE. `target` resolves through pickPage, NOT
 * resolvePage. resolvePage runs assertLeaseOk, which under CDP_REQUIRE_LEASE
 * auto-acquires a lease on an unleased tab: routing a claim through it would
 * claim the tab twice and collide with itself. The protection is not lost, only
 * moved — claimLease below still refuses a tab a live process holds.
 *
 * TAKEOVER IS OF UNLEASED TABS ONLY. There is deliberately no force/steal
 * option: a tab another live agent holds stays refused with the same conflict
 * error as before. The tab this feature exists to take over is a human's, and a
 * human's tab carries no lease.
 *
 * RESOLUTION NEVER CREATES A TAB. With `target` given, the open branch is
 * unreachable: an unmatched selector is an error, never a silently substituted
 * new tab, because "the tab I asked for is not there" and "here is an empty one
 * instead" are answers a caller must be able to tell apart.
 *
 * THE ACTIVITY BEACON IS READ BEFORE THE CLAIM AND INSTALLED AFTER IT, and the
 * order is not arbitrary in either half.
 *
 * Read first, because the read has to be GATE-FREE for exactly the reason the
 * resolution above is: under CDP_REQUIRE_LEASE, anything that touches the tab
 * through the lease gate auto-acquires a lease on it, and a claim that ran after
 * that would collide with the lease taken on its own behalf. The driver members
 * behind readHumanActiveMs bypass the gate and can do nothing but return one
 * number (see driver.ts).
 *
 * Install after, because installing is a WRITE into the page, and this is the
 * first moment we are entitled to make one: the claim has succeeded, so the tab
 * is ours. It is also the only ordering that keeps the read honest, since
 * installing first cannot invent a timestamp but re-arming a beacon on a tab
 * whose claim then FAILED would leave our script running in somebody else's tab
 * for nothing.
 *
 * A CLAIM IS NEVER REFUSED ON HUMAN ACTIVITY. Taking over a person's tab is the
 * feature; a caller that asked for this tab gets this tab. Contention is
 * reported in the result and the caller decides. See contentionWarning.
 */
export async function claimPage(
  driver: BrowserDriver,
  args: { target?: TargetSelector; targetId?: string; url?: string; label?: string; ttlMs?: number } = {},
): Promise<ClaimPageResult> {
  const hasTarget = typeof args.target === "string" && args.target.length > 0;
  const hasTargetId = typeof args.targetId === "string" && args.targetId.length > 0;
  if (hasTarget && hasTargetId) {
    throw new LeaseToolError(
      "claim_page takes at most one of 'target' (any selector: active | index:N | url:<substr> | title:<substr> | <targetId>) or 'targetId' (an exact target id, kept for back-compat). Pass 'target' alone to claim an open tab, or neither to open a fresh one.",
    );
  }
  const backend = backendOf(driver);
  const label = typeof args.label === "string" && args.label.length ? args.label : defaultLabel();
  const pages = await driver.listPages();
  let targetId: string;
  let url: string;
  let opened: boolean;
  if (hasTarget) {
    // Gate-free on purpose: see the header. No tab is created on this path,
    // including when nothing matches.
    const hit = await pickPage(driver, pages, args.target).catch((err: unknown) => {
      throw new LeaseToolError(
        `claim_page: no open tab matches target '${args.target}' (${(err as Error).message}). No tab was opened: claim_page never creates one when 'target' is given.`,
      );
    });
    targetId = hit.id;
    url = hit.url;
    opened = false;
  } else if (hasTargetId) {
    const existing = pages.find((p) => p.id === args.targetId);
    if (!existing) throw new LeaseToolError(`claim_page: no page target with id '${args.targetId}'`);
    targetId = existing.id;
    url = existing.url;
    opened = false;
  } else {
    // Creation ledger, not the lease: this record survives release_page and
    // expiry, so the tab stays attributable to `label` after the lease is gone.
    // Claiming an EXISTING tab (the branches above) records nothing, because
    // this toolkit did not create it and provenance is not ownership.
    const page = await newTrackedPage(driver, backend, { url: args.url, label });
    targetId = page.id;
    url = page.url;
    opened = true;
  }
  // Gate-free, before the claim, and only for a takeover: a tab this call is
  // about to CREATE cannot have a human in it, so asking would be theatre.
  const humanMs = opened ? null : await readHumanActiveMs(driver, backend, targetId);
  const liveIds = [...pages.map((p) => p.id), targetId];
  const { record, token } = await claimLease(backend, targetId, {
    label,
    ttlMs: typeof args.ttlMs === "number" && args.ttlMs > 0 ? args.ttlMs : leaseTtlMs(),
    liveIds,
  });
  // Best effort by construction (installBeacon never throws): a claim that
  // succeeded must not be reported as a failure because a diagnostic script
  // could not be injected. The cost is a tab that reports humanActiveMs null
  // forever, which reads the same as a tab nobody has touched.
  await installBeacon(driver, targetId);
  const contention = contentionWarning(humanMs, { takeover: !opened });
  return {
    lease: token,
    targetId,
    url,
    label: record.label,
    ttlMs: record.ttlMs,
    expiresAt: record.lastUsedAt + record.ttlMs,
    opened,
    // Absent, not null, when the backend has no beacon at all: "cannot answer"
    // and "answered, no data" are different facts (ADR-001's absent-over-
    // throwing rule applied to a field rather than to a whole tool).
    ...(beaconSupported(driver) ? { humanActiveMs: humanMs } : {}),
    ...(contention !== undefined ? { contention } : {}),
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

/**
 * One list_leases row: everything the lease store knows, plus what the browser
 * can add.
 *
 * `humanActiveMs` lives HERE and not on LeaseSummary because leases.ts is
 * deliberately free of any CDP or BiDi import ("it takes browser-derived input
 * as data", see its staleReason) and answering this needs a live driver. Keeping
 * the annotation in the tool layer is what preserves that, and it is the same
 * split shared-tools.ts uses for ListedPage's provenance fields.
 */
export interface LeaseRow extends LeaseSummary {
  /** Ms since a human last touched this tab (src/activity.ts). ABSENT — never
   *  null — when the tab has no beacon, when every timestamp on it was this
   *  server's own, when the row belongs to the other backend, or when the read
   *  failed. A diagnosis tool must not fail because one page would not answer. */
  humanActiveMs?: number;
}

/**
 * Enumerate active leases for diagnosis. Requires no token by design.
 *
 * The beacon annotation is per-row, best effort, and NEVER fatal: an evaluate
 * that throws, a tab that closed mid-listing, or a page with no beacon all leave
 * the field off that row and change nothing else. list_leases is what an
 * operator runs when tabs already look wrong, so it failing on a wrong-looking
 * tab would be exactly backwards.
 *
 * Only rows of THIS driver's backend are annotated, mirroring the liveBackend
 * scoping just below: a Chrome driver cannot read a Firefox context, and asking
 * it to would either error or, worse, resolve some unrelated id.
 */
export async function listLeasesTool(
  driver: BrowserDriver,
  _args: Record<string, never> = {} as Record<string, never>,
): Promise<{ leases: LeaseRow[]; count: number; reaped?: ReapedTab[] }> {
  const backend = backendOf(driver);
  // Same reap as list_pages, and for the same reason: this is the other tool an
  // operator runs when tabs look wrong, so it must not report a lease it is
  // about to delete. Strict mode only.
  const reaped = requireLease() ? await reapStaleAgentTabs(driver, backend) : [];
  const reapedIds = new Set(reaped.map((r) => r.targetId));
  const livePages = await driver.listPages();
  const liveIds = livePages.map((p) => p.id);
  // liveBackend scopes the target-gone test to the browser these ids came from,
  // so leases held on the OTHER backend are not mislabeled as reclaimable.
  const all = await listLeases({ liveIds, liveBackend: backend });
  const kept = all.filter((l) => !(l.backend === backend && reapedIds.has(l.targetId)));
  const liveSet = new Set(liveIds);
  const now = Date.now();
  const leases: LeaseRow[] = [];
  for (const row of kept) {
    // A row this driver cannot speak to at all: other backend, unreadable
    // record (its targetId came from a FILENAME, not from the browser), or a
    // tab that is simply not open any more.
    if (row.backend !== backend || row.unreadable !== undefined || !liveSet.has(row.targetId)) {
      leases.push(row);
      continue;
    }
    const humanMs = await readHumanActiveMs(driver, backend, row.targetId, now).catch(() => null);
    leases.push(humanMs === null ? row : { ...row, humanActiveMs: humanMs });
  }
  return { leases, count: leases.length, ...(reaped.length ? { reaped } : {}) };
}

export const LEASE_TOOLS = {
  claim_page: claimPage,
  release_page: releasePage,
  list_leases: listLeasesTool,
} satisfies Record<string, (driver: BrowserDriver, args: never) => Promise<unknown>>;
