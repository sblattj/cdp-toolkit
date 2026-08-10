/**
 * Unit tests for the pure stale-agent-tab selector (src/reap.ts).
 *
 * Every one of these tests is a statement about when a browser tab gets
 * CLOSED, which is why the selector is a pure function in the first place: the
 * whole matrix of {provenance} x {lease state} x {liveness} is reachable here
 * with no browser, no filesystem and no clock, and a destructive operation is
 * the one place where cheap exhaustive coverage is worth the extra seam.
 *
 * The negative tests are the important ones. Each names a tab that a person
 * still wants open, and a bug that closed it would be data loss rather than a
 * failed cleanup.
 *
 * 1.8.0 adds the split reap horizon: `expired` alone (the reclaimability
 * signal, unchanged in leases.ts) no longer closes a tab. It only does once an
 * ADDITIONAL reapGraceMs has elapsed on top of the ttlMs that made it
 * reclaimable. `dead-pid` is unaffected — it stays immediate.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { DEFAULT_REAP_GRACE_MS, reapGraceMs, staleAgentTabs } from "../src/reap.ts";
import type { OriginSummary } from "../src/origins.ts";
import type { LeaseSummary } from "../src/leases.ts";

describe("staleAgentTabs", () => {
  const NOW = 10_000_000;
  // Spelled out rather than read from DEFAULT_REAP_GRACE_MS, so a future
  // change to the default cannot silently change what these fixtures mean.
  const GRACE = 2_700_000;
  const origin = (id: string): [string, OriginSummary] =>
    [id, { backend: "chrome", targetId: id, label: "agent-x", pid: 4242, createdAt: 1 }];
  const lease = (id: string, stale: LeaseSummary["stale"], over: Partial<LeaseSummary> = {}): LeaseSummary => ({
    backend: "chrome", targetId: id, label: "agent-x", pid: 4242, createdAt: 1,
    lastUsedAt: 1, ttlMs: 900_000, pidAlive: false, stale, ...over,
  });
  const run = (
    leases: LeaseSummary[],
    origins: [string, OriginSummary][],
    livePageIds: string[],
    over: { now?: number; reapGraceMs?: number } = {},
  ) =>
    staleAgentTabs({
      backend: "chrome",
      livePageIds,
      origins: new Map(origins),
      leases,
      now: over.now ?? NOW,
      reapGraceMs: over.reapGraceMs ?? GRACE,
    });

  test("reaps an agent tab whose owner died", () => {
    expect(run([lease("T1", "dead-pid")], [origin("T1")], ["T1"]))
      .toEqual([{ targetId: "T1", label: "agent-x", reason: "dead-pid" }]);
  });

  test("dead-pid is reaped immediately, ignoring grace entirely", () => {
    // lastUsedAt is effectively "now": if grace applied to dead-pid too, this
    // would be excluded, and it must not be — a dead process is never coming
    // back regardless of how recently it was used.
    const rec = lease("T1b", "dead-pid", { lastUsedAt: NOW });
    expect(run([rec], [origin("T1b")], ["T1b"])[0]?.reason).toBe("dead-pid");
  });

  test("an expired lease WITHIN the grace window is not yet reaped", () => {
    // ttlMs has elapsed (reclaimable — another agent may take it) but
    // ttlMs+reapGraceMs has not, so the tab must survive.
    const rec = lease("T2", "expired", { lastUsedAt: NOW - 900_000 - 1 });
    expect(run([rec], [origin("T2")], ["T2"])).toEqual([]);
  });

  test("an expired lease exactly AT ttlMs+grace is not yet reaped: the boundary is exclusive", () => {
    const rec = lease("T2b", "expired", { lastUsedAt: NOW - (900_000 + GRACE) });
    expect(run([rec], [origin("T2b")], ["T2b"])).toEqual([]);
  });

  test("reaps an agent tab whose lease expired PAST the grace window", () => {
    const rec = lease("T2c", "expired", { lastUsedAt: NOW - (900_000 + GRACE) - 1 });
    expect(run([rec], [origin("T2c")], ["T2c"])[0]?.reason).toBe("expired");
  });

  test("NEVER reaps an agent tab with no lease at all", () => {
    // This is what new_page produces for a user who never touches leases.
    // Closing these would be a data-loss bug, not a cleanup.
    expect(run([], [origin("T3")], ["T3"])).toEqual([]);
  });

  test("never reaps a healthy lease", () => {
    expect(run([lease("T4", false, { pidAlive: true })], [origin("T4")], ["T4"])).toEqual([]);
  });

  test("never reaps target-gone: there is no tab left to close", () => {
    expect(run([lease("T5", "target-gone")], [origin("T5")], ["T5"])).toEqual([]);
  });

  test("never reaps a tab with no origin record", () => {
    expect(run([lease("T6", "dead-pid")], [], ["T6"])).toEqual([]);
  });

  test("never reaps a target absent from the PAGE listing", () => {
    // Guards the page-only rule: a worker or iframe can carry a lease via
    // pickPage's bare-id branch, and "close the stale tab" is meaningless there.
    expect(run([lease("T7", "dead-pid")], [origin("T7")], [])).toEqual([]);
  });

  test("never reaps an unreadable lease row", () => {
    expect(run([lease("T8", "dead-pid", { unreadable: "EACCES" })], [origin("T8")], ["T8"])).toEqual([]);
  });

  test("ignores leases belonging to the other backend", () => {
    expect(run([lease("T9", "dead-pid", { backend: "firefox" })], [origin("T9")], ["T9"])).toEqual([]);
  });

  test("selects several tabs in one pass, respecting grace for the expired ones", () => {
    const out = run(
      [
        lease("A", "dead-pid"),
        lease("B", "expired", { lastUsedAt: NOW - (900_000 + GRACE) - 1 }), // past grace: reaped
        lease("C", false, { pidAlive: true }),
        lease("D", "expired", { lastUsedAt: NOW - 900_000 - 1 }), // within grace: not reaped
      ],
      [origin("A"), origin("B"), origin("C"), origin("D")],
      ["A", "B", "C", "D"],
    );
    expect(out.map((r) => r.targetId).sort()).toEqual(["A", "B"]);
  });

  test("a custom reapGraceMs moves the boundary", () => {
    const rec = lease("T10", "expired", { lastUsedAt: NOW - 900_000 - 500 });
    expect(run([rec], [origin("T10")], ["T10"], { reapGraceMs: 0 })[0]?.reason).toBe("expired");
    expect(run([rec], [origin("T10")], ["T10"], { reapGraceMs: 10_000 })).toEqual([]);
  });
});

describe("reapGraceMs", () => {
  const ORIGINAL = process.env.CDP_REAP_GRACE_MS;
  afterEach(() => {
    if (ORIGINAL === undefined) delete process.env.CDP_REAP_GRACE_MS;
    else process.env.CDP_REAP_GRACE_MS = ORIGINAL;
  });

  test("defaults to 45 minutes when unset", () => {
    delete process.env.CDP_REAP_GRACE_MS;
    expect(reapGraceMs()).toBe(DEFAULT_REAP_GRACE_MS);
    expect(DEFAULT_REAP_GRACE_MS).toBe(2_700_000);
  });

  test("reads a valid override", () => {
    process.env.CDP_REAP_GRACE_MS = "60000";
    expect(reapGraceMs()).toBe(60_000);
  });

  test("zero is a valid override: it disables the grace period", () => {
    process.env.CDP_REAP_GRACE_MS = "0";
    expect(reapGraceMs()).toBe(0);
  });

  test("falls back to the default on a non-finite or negative override", () => {
    process.env.CDP_REAP_GRACE_MS = "not-a-number";
    expect(reapGraceMs()).toBe(DEFAULT_REAP_GRACE_MS);
    process.env.CDP_REAP_GRACE_MS = "-1";
    expect(reapGraceMs()).toBe(DEFAULT_REAP_GRACE_MS);
  });
});
