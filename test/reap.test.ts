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
 */
import { describe, expect, test } from "bun:test";
import { staleAgentTabs } from "../src/reap.ts";
import type { OriginSummary } from "../src/origins.ts";
import type { LeaseSummary } from "../src/leases.ts";

describe("staleAgentTabs", () => {
  const origin = (id: string): [string, OriginSummary] =>
    [id, { backend: "chrome", targetId: id, label: "agent-x", pid: 4242, createdAt: 1 }];
  const lease = (id: string, stale: LeaseSummary["stale"], over: Partial<LeaseSummary> = {}): LeaseSummary => ({
    backend: "chrome", targetId: id, label: "agent-x", pid: 4242, createdAt: 1,
    lastUsedAt: 1, ttlMs: 900_000, pidAlive: false, stale, ...over,
  });
  const run = (leases: LeaseSummary[], origins: [string, OriginSummary][], livePageIds: string[]) =>
    staleAgentTabs({ backend: "chrome", livePageIds, origins: new Map(origins), leases });

  test("reaps an agent tab whose owner died", () => {
    expect(run([lease("T1", "dead-pid")], [origin("T1")], ["T1"]))
      .toEqual([{ targetId: "T1", label: "agent-x", reason: "dead-pid" }]);
  });

  test("reaps an agent tab whose lease expired", () => {
    expect(run([lease("T2", "expired")], [origin("T2")], ["T2"])[0]?.reason).toBe("expired");
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

  test("selects several tabs in one pass", () => {
    const out = run(
      [lease("A", "dead-pid"), lease("B", "expired"), lease("C", false, { pidAlive: true })],
      [origin("A"), origin("B"), origin("C")],
      ["A", "B", "C"],
    );
    expect(out.map((r) => r.targetId).sort()).toEqual(["A", "B"]);
  });
});
