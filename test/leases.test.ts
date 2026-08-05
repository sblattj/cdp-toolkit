/**
 * Unit tests for src/leases.ts. The lease store is pure logic over the
 * filesystem, so every case here runs with no browser: claims, releases,
 * staleness, reclamation, and the three negative cases from the design's
 * section 9. CDP_ARTIFACT_DIR is redirected to a per-run temp dir, which is
 * why leaseDir() reads the env var per call instead of at module load.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  assertLeaseOk,
  claimLease,
  currentLease,
  leaseFromArgs,
  isPidAlive,
  leaseFile,
  readLease,
  releaseLease,
  staleReason,
  tokenParts,
  withLeaseScope,
  type LeaseRecord,
} from "../src/leases.ts";

let dir = "";
const originalArtifactDir = process.env.CDP_ARTIFACT_DIR;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "cdp-leases-"));
  process.env.CDP_ARTIFACT_DIR = dir;
});

afterAll(async () => {
  if (originalArtifactDir === undefined) delete process.env.CDP_ARTIFACT_DIR;
  else process.env.CDP_ARTIFACT_DIR = originalArtifactDir;
  await rm(dir, { recursive: true, force: true });
});

beforeEach(async () => {
  for (const f of await readdir(dir)) await rm(join(dir, f), { force: true });
});

describe("claimLease", () => {
  test("writes one file per backend+target and returns a parseable token", async () => {
    const { token, record } = await claimLease("chrome", "TARGET-A", { label: "agent-one" });
    expect(record.label).toBe("agent-one");
    expect(record.pid).toBe(process.pid);
    expect(record.ttlMs).toBe(900_000);
    expect(record.createdAt).toBe(record.lastUsedAt);
    expect(tokenParts(token)).toEqual({ backend: "chrome", targetId: "TARGET-A", nonce: record.nonce });
    expect(leaseFile("chrome", "TARGET-A")).toBe(join(dir, "lease-chrome-TARGET-A.json"));
    expect(await readLease("chrome", "TARGET-A")).toEqual(record);
  });

  test("a Chrome lease and a Firefox lease with the same id do not collide", async () => {
    const a = await claimLease("chrome", "SAME-ID", { label: "chrome-agent" });
    const b = await claimLease("firefox", "SAME-ID", { label: "firefox-agent" });
    expect(a.record.nonce).not.toBe(b.record.nonce);
    expect((await readLease("chrome", "SAME-ID"))?.label).toBe("chrome-agent");
    expect((await readLease("firefox", "SAME-ID"))?.label).toBe("firefox-agent");
  });

  test("two simultaneous claims against one tab: exactly one wins", async () => {
    const results = await Promise.allSettled([
      claimLease("chrome", "RACE", { label: "first" }),
      claimLease("chrome", "RACE", { label: "second" }),
      claimLease("chrome", "RACE", { label: "third" }),
    ]);
    const won = results.filter((r) => r.status === "fulfilled");
    const lost = results.filter((r) => r.status === "rejected");
    expect(won.length).toBe(1);
    expect(lost.length).toBe(2);
    for (const l of lost) {
      expect((l as PromiseRejectedResult).reason).toBeInstanceOf(Error);
      expect(String((l as PromiseRejectedResult).reason.message)).toContain("RACE");
    }
  });
});

describe("releaseLease", () => {
  test("releases a held lease and removes the file", async () => {
    const { token } = await claimLease("chrome", "REL", { label: "agent-one" });
    expect(await releaseLease(token)).toEqual({ released: true });
    expect(await readLease("chrome", "REL")).toBeUndefined();
  });

  test("is idempotent: releasing twice is not an error", async () => {
    const { token } = await claimLease("chrome", "REL2", { label: "agent-one" });
    expect(await releaseLease(token)).toEqual({ released: true });
    expect(await releaseLease(token)).toEqual({ released: false });
  });

  test("a malformed token releases nothing and does not throw", async () => {
    expect(await releaseLease("not-a-token")).toEqual({ released: false });
  });
});

function recordOf(over: Partial<LeaseRecord> = {}): LeaseRecord {
  return {
    backend: "chrome",
    targetId: "T",
    nonce: "0123456789abcdef01234567",
    pid: process.pid,
    label: "agent-one",
    createdAt: 1_000,
    lastUsedAt: 1_000,
    ttlMs: 900_000,
    ...over,
  };
}

describe("staleReason", () => {
  test("a live pid inside its TTL is not stale", () => {
    expect(staleReason(recordOf(), { now: 1_000 + 60_000 })).toBe(false);
  });

  test("a dead pid is stale regardless of lastUsedAt", () => {
    // pid 1 is init/launchd and always alive, so use an unallocatable pid instead.
    expect(isPidAlive(2 ** 31 - 1)).toBe(false);
    expect(staleReason(recordOf({ pid: 2 ** 31 - 1, lastUsedAt: 1_000 }), { now: 1_100 })).toBe("dead-pid");
  });

  test("lastUsedAt older than ttlMs is stale", () => {
    expect(staleReason(recordOf({ lastUsedAt: 1_000, ttlMs: 5_000 }), { now: 1_000 + 5_001 })).toBe("expired");
  });

  test("a target id missing from the live list is stale", () => {
    expect(staleReason(recordOf({ targetId: "GONE" }), { now: 1_100, liveIds: ["OTHER"] })).toBe("target-gone");
    expect(staleReason(recordOf({ targetId: "HERE" }), { now: 1_100, liveIds: ["HERE"] })).toBe(false);
  });

  test("liveIds is only consulted when supplied", () => {
    expect(staleReason(recordOf({ targetId: "GONE" }), { now: 1_100 })).toBe(false);
  });
});

describe("claimLease reclamation", () => {
  test("reclaims an expired lease and mints a different nonce", async () => {
    const first = await claimLease("chrome", "RECLAIM", { label: "stalled", ttlMs: 1, now: 1_000 });
    const second = await claimLease("chrome", "RECLAIM", { label: "fresh", now: 1_000_000 });
    expect(second.record.label).toBe("fresh");
    expect(second.record.nonce).not.toBe(first.record.nonce);
    expect(tokenParts(second.token)?.nonce).toBe(second.record.nonce);
  });

  test("reclaims a lease whose target has vanished from the browser", async () => {
    await claimLease("chrome", "VANISHED", { label: "ghost", now: 1_000 });
    const retaken = await claimLease("chrome", "VANISHED", { label: "fresh", now: 1_100, liveIds: ["SOMETHING-ELSE"] });
    expect(retaken.record.label).toBe("fresh");
  });

  test("does NOT reclaim a live lease inside its TTL", async () => {
    await claimLease("chrome", "HELD", { label: "working", now: 1_000 });
    await expect(claimLease("chrome", "HELD", { label: "intruder", now: 1_100 })).rejects.toThrow(/already leased by 'working'/);
  });

  test("the superseded token no longer releases the reclaimed lease", async () => {
    const first = await claimLease("chrome", "SUPERSEDED", { label: "stalled", ttlMs: 1, now: 1_000 });
    await claimLease("chrome", "SUPERSEDED", { label: "fresh", now: 1_000_000 });
    expect(await releaseLease(first.token)).toEqual({ released: false });
    expect((await readLease("chrome", "SUPERSEDED"))?.label).toBe("fresh");
  });
});

describe("assertLeaseOk (spec section 9 negative cases)", () => {
  test("NEGATIVE 1: a call with NO token against a leased tab is refused", async () => {
    await claimLease("chrome", "LEASED", { label: "agent-one" });
    await expect(
      assertLeaseOk("chrome", "LEASED", { url: "https://example.com/checkout", title: "Checkout" }),
    ).rejects.toThrow(/target 'LEASED'.*https:\/\/example\.com\/checkout.*agent-one/s);
  });

  test("an unleased tab with no token is untouched (today's behavior exactly)", async () => {
    await expect(assertLeaseOk("chrome", "FREE", {})).resolves.toBeUndefined();
  });

  test("the matching token passes and refreshes lastUsedAt", async () => {
    const { token, record } = await claimLease("chrome", "MINE", { label: "agent-one", now: 1_000 });
    await assertLeaseOk("chrome", "MINE", { lease: token, now: 2_000 });
    const after = await readLease("chrome", "MINE");
    expect(after?.nonce).toBe(record.nonce);
    expect(after?.lastUsedAt).toBe(2_000);
    expect(after?.createdAt).toBe(1_000);
  });

  test("NEGATIVE 2: a token from a released lease is refused, not silently accepted", async () => {
    const { token } = await claimLease("chrome", "GONE", { label: "agent-one" });
    await releaseLease(token);
    await expect(assertLeaseOk("chrome", "GONE", { lease: token })).rejects.toThrow(/released or reclaimed/);
  });

  test("NEGATIVE 3: reclamation invalidates the superseded token", async () => {
    const stalled = await claimLease("chrome", "TAKEN", { label: "stalled", ttlMs: 1, now: 1_000 });
    const fresh = await claimLease("chrome", "TAKEN", { label: "fresh", now: 1_000_000 });
    // `now` is pinned to the fresh claim's own clock: these records use synthetic
    // timestamps, so letting the assert calls fall back to Date.now() would age
    // the fresh lease past its TTL and it would be judged reclaimable, not held.
    // Pinning it keeps `held` live, which is what makes the second assertion a
    // test of the NONCE comparison specifically rather than of staleness.
    // The new owner drives the tab.
    await expect(assertLeaseOk("chrome", "TAKEN", { lease: fresh.token, now: 1_000_000 })).resolves.toBeUndefined();
    // The resurrected old owner must NOT, even though its token is well formed.
    await expect(assertLeaseOk("chrome", "TAKEN", { lease: stalled.token, now: 1_000_000 })).rejects.toThrow(/reclaimed and is now leased by 'fresh'/);
  });

  test("a token minted for another tab is refused", async () => {
    const a = await claimLease("chrome", "TAB-A", { label: "agent-one" });
    await claimLease("chrome", "TAB-B", { label: "agent-two" });
    await expect(assertLeaseOk("chrome", "TAB-B", { lease: a.token })).rejects.toThrow(/is for chrome target 'TAB-A'/);
  });

  test("a malformed token is refused rather than treated as absent", async () => {
    await claimLease("chrome", "MALFORMED", { label: "agent-one" });
    await expect(assertLeaseOk("chrome", "MALFORMED", { lease: "chrome:MALFORMED:zzz" })).rejects.toThrow(/malformed lease token/);
  });

  test("a stale lease does not brick the tab: no token still passes", async () => {
    await claimLease("chrome", "ABANDONED", { label: "dead", ttlMs: 1, now: 1_000 });
    await expect(assertLeaseOk("chrome", "ABANDONED", { now: 1_000_000 })).resolves.toBeUndefined();
  });
});

describe("withLeaseScope", () => {
  test("supplies the token to assertLeaseOk when no explicit lease is passed", async () => {
    const { token } = await claimLease("chrome", "AMBIENT", { label: "agent-one" });
    await expect(assertLeaseOk("chrome", "AMBIENT", {})).rejects.toThrow(/is leased by 'agent-one'/);
    await withLeaseScope(token, async () => {
      expect(currentLease()).toBe(token);
      await assertLeaseOk("chrome", "AMBIENT", {});
    });
  });
});

describe("leaseFromArgs (what the dispatch sites hand to withLeaseScope)", () => {
  test("reads a token off a tool args object", () => {
    expect(leaseFromArgs({ target: "index:0", lease: "chrome:T:0123456789abcdef01234567" })).toBe(
      "chrome:T:0123456789abcdef01234567",
    );
  });

  test("args with no lease key yield undefined, which is what keeps unleased calls unchanged", () => {
    expect(leaseFromArgs({ target: "index:0" })).toBeUndefined();
  });

  test("a non-object, null, or empty-string lease is absent rather than malformed", () => {
    expect(leaseFromArgs(undefined)).toBeUndefined();
    expect(leaseFromArgs(null)).toBeUndefined();
    expect(leaseFromArgs("chrome:T:abc")).toBeUndefined();
    expect(leaseFromArgs({ lease: "" })).toBeUndefined();
    expect(leaseFromArgs({ lease: 42 })).toBeUndefined();
  });

  test("end to end: args -> leaseFromArgs -> withLeaseScope -> assertLeaseOk", async () => {
    const { token } = await claimLease("chrome", "DISPATCH", { label: "agent-one" });
    const args = { target: "index:0", lease: token };
    await withLeaseScope(leaseFromArgs(args), async () => {
      await assertLeaseOk("chrome", "DISPATCH", {});
    });
    // The same tab without the token in scope is still refused.
    await withLeaseScope(leaseFromArgs({ target: "index:0" }), async () => {
      await expect(assertLeaseOk("chrome", "DISPATCH", {})).rejects.toThrow(/is leased by 'agent-one'/);
    });
  });
});
