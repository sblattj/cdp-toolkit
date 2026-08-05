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
import { TOOL_NAMES } from "../src/index.ts";
import { MANIFEST } from "../src/manifest.ts";
import {
  assertLeaseOk,
  claimLease,
  currentLease,
  leaseFromArgs,
  isPidAlive,
  leaseFile,
  listLeases,
  readLease,
  releaseLease,
  staleReason,
  tokenParts,
  touchLease,
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

describe("assertLeaseOk branch order (fix round 1, Important 1)", () => {
  test("a token for TAB-A does not poison an UNRELATED unleased tab", async () => {
    const a = await claimLease("chrome", "HOLD-A", { label: "agent-one" });
    // TAB-C has no lease at all. Today anyone may resolve it; holding a token
    // for a different tab must not change that. Under the ambient dispatch
    // scope this is the common case, not an edge case: any agent holding one
    // tab that touches a second unleased tab in the same call lands here.
    await expect(assertLeaseOk("chrome", "FREE-C", { lease: a.token })).resolves.toBeUndefined();
  });

  test("the unrelated-tab pass-through does not depend on the tab being a page we own", async () => {
    const a = await claimLease("chrome", "HOLD-A2", { label: "agent-one" });
    // Same shape across backends: a chrome token against an unleased firefox id.
    await expect(assertLeaseOk("firefox", "FREE-FF", { lease: a.token })).resolves.toBeUndefined();
  });

  test("but a token for TAB-A against a tab someone ELSE holds is still refused", async () => {
    const a = await claimLease("chrome", "HOLD-A3", { label: "agent-one" });
    await claimLease("chrome", "HELD-B3", { label: "agent-two" });
    await expect(assertLeaseOk("chrome", "HELD-B3", { lease: a.token })).rejects.toThrow(
      /is for chrome target 'HOLD-A3'/,
    );
  });

  test("REGRESSION GUARD for NEGATIVE 2: same targetId with no live lease still errors", async () => {
    // This is the case the reorder must NOT hollow out. It differs from the
    // pass-through above by exactly one thing: the token's targetId matches the
    // tab being resolved, so the caller believes it holds THIS tab and is wrong.
    const { token } = await claimLease("chrome", "GONE-2", { label: "agent-one" });
    await releaseLease(token);
    await expect(assertLeaseOk("chrome", "GONE-2", { lease: token })).rejects.toThrow(/released or reclaimed/);
  });
});

describe("touchLease (fix round 1, Important 2)", () => {
  test("refreshes lastUsedAt for the record it still owns", async () => {
    const { record } = await claimLease("chrome", "TOUCH-OK", { label: "agent-one", now: 1_000 });
    await touchLease(record, 5_000);
    const after = await readLease("chrome", "TOUCH-OK");
    expect(after?.lastUsedAt).toBe(5_000);
    expect(after?.nonce).toBe(record.nonce);
    expect(after?.createdAt).toBe(1_000);
  });

  test("CANNOT resurrect a superseded lease it no longer owns", async () => {
    const first = await claimLease("chrome", "TOUCH-RACE", { label: "stalled", ttlMs: 1, now: 1_000 });
    const second = await claimLease("chrome", "TOUCH-RACE", { label: "fresh", now: 1_000_000 });
    // The stalled owner's in-flight heartbeat lands AFTER the reclamation.
    await touchLease(first.record, 2_000_000);
    const after = await readLease("chrome", "TOUCH-RACE");
    // The new owner's record must survive intact: nonce, label, and lastUsedAt.
    expect(after?.nonce).toBe(second.record.nonce);
    expect(after?.label).toBe("fresh");
    expect(after?.lastUsedAt).toBe(second.record.lastUsedAt);
    // And the new owner's token must still pass the gate.
    await expect(assertLeaseOk("chrome", "TOUCH-RACE", { lease: second.token, now: 1_000_000 })).resolves.toBeUndefined();
  });

  test("a lease released underneath a heartbeat is not recreated by it", async () => {
    const { token, record } = await claimLease("chrome", "TOUCH-REL", { label: "agent-one" });
    await releaseLease(token);
    await touchLease(record, 9_000);
    expect(await readLease("chrome", "TOUCH-REL")).toBeUndefined();
  });
});

describe("withLeaseScope concurrency", () => {
  test("two concurrent scopes stay isolated across awaits", async () => {
    const one = await claimLease("chrome", "CONC-1", { label: "agent-one" });
    const two = await claimLease("chrome", "CONC-2", { label: "agent-two" });
    const seen: string[] = [];
    await Promise.all([
      withLeaseScope(one.token, async () => {
        await new Promise((r) => setTimeout(r, 5));
        seen.push(`one:${currentLease() === one.token}`);
        await assertLeaseOk("chrome", "CONC-1", {});
        // The other agent's tab must still be refused from inside this scope.
        await expect(assertLeaseOk("chrome", "CONC-2", {})).rejects.toThrow(/is leased by 'agent-two'/);
      }),
      withLeaseScope(two.token, async () => {
        await new Promise((r) => setTimeout(r, 1));
        seen.push(`two:${currentLease() === two.token}`);
        await assertLeaseOk("chrome", "CONC-2", {});
        await expect(assertLeaseOk("chrome", "CONC-1", {})).rejects.toThrow(/is leased by 'agent-one'/);
      }),
    ]);
    expect(seen.sort()).toEqual(["one:true", "two:true"]);
  });

  test("a scope does not leak out of its own callback", async () => {
    const { token } = await claimLease("chrome", "NOLEAK", { label: "agent-one" });
    await withLeaseScope(token, async () => {
      expect(currentLease()).toBe(token);
    });
    expect(currentLease()).toBeUndefined();
    await expect(assertLeaseOk("chrome", "NOLEAK", {})).rejects.toThrow(/is leased by 'agent-one'/);
  });
});

describe("backend keying (spec section 8)", () => {
  test("a Firefox context id and a Chrome target id that match do not share a lease", async () => {
    const chrome = await claimLease("chrome", "COLLIDE", { label: "chrome-agent" });
    const firefox = await claimLease("firefox", "COLLIDE", { label: "firefox-agent" });
    // Each token works only against its own backend.
    await expect(assertLeaseOk("chrome", "COLLIDE", { lease: chrome.token })).resolves.toBeUndefined();
    await expect(assertLeaseOk("firefox", "COLLIDE", { lease: firefox.token })).resolves.toBeUndefined();
    await expect(assertLeaseOk("firefox", "COLLIDE", { lease: chrome.token })).rejects.toThrow(/is for chrome target 'COLLIDE'/);
    await expect(assertLeaseOk("chrome", "COLLIDE", { lease: firefox.token })).rejects.toThrow(/is for firefox target 'COLLIDE'/);
  });

  test("releasing the Chrome lease leaves the Firefox lease held", async () => {
    const chrome = await claimLease("chrome", "PAIRED", { label: "chrome-agent" });
    await claimLease("firefox", "PAIRED", { label: "firefox-agent" });
    await releaseLease(chrome.token);
    expect(await readLease("chrome", "PAIRED")).toBeUndefined();
    expect((await readLease("firefox", "PAIRED"))?.label).toBe("firefox-agent");
  });
});

describe("listLeases", () => {
  test("reports every lease with its liveness and staleness", async () => {
    await claimLease("chrome", "ALIVE", { label: "agent-one", now: 1_000 });
    await claimLease("firefox", "STALE", { label: "agent-two", ttlMs: 1, now: 1_000 });
    const rows = (await listLeases({ now: 1_000_000 })).sort((a, b) => a.targetId.localeCompare(b.targetId));
    expect(rows.length).toBe(2);
    expect(rows[0]).toMatchObject({ backend: "chrome", targetId: "ALIVE", label: "agent-one", pidAlive: true, stale: "expired" });
    expect(rows[1]).toMatchObject({ backend: "firefox", targetId: "STALE", label: "agent-two", pidAlive: true, stale: "expired" });
    expect(rows[0]?.createdAt).toBe(1_000);
    expect(rows[0]?.ttlMs).toBe(900_000);
  });

  test("returns an empty list when nothing is leased", async () => {
    expect(await listLeases({ now: 1_000 })).toEqual([]);
  });
});

describe("registry and manifest wiring", () => {
  test("the three lease tools are registered", () => {
    expect(TOOL_NAMES).toContain("claim_page");
    expect(TOOL_NAMES).toContain("release_page");
    expect(TOOL_NAMES).toContain("list_leases");
    expect(TOOL_NAMES.length).toBe(36);
  });

  test("every tool has a manifest schema and vice versa", () => {
    expect(MANIFEST.map((s) => s.name).sort()).toEqual([...TOOL_NAMES].sort());
  });

  test("every tool that resolves a target accepts an optional lease", () => {
    for (const spec of MANIFEST) {
      if (spec.name === "claim_page" || spec.name === "list_leases") continue;
      expect(spec.inputSchema.properties?.lease, `${spec.name} is missing the lease property`).toBeDefined();
    }
  });

  test("only release_page requires a lease", () => {
    for (const spec of MANIFEST) {
      const required = spec.inputSchema.required ?? [];
      expect(required.includes("lease"), spec.name).toBe(spec.name === "release_page");
    }
  });
});
