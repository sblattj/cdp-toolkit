/**
 * Unit tests for src/leases.ts. The lease store is pure logic over the
 * filesystem, so every case here runs with no browser: claims, releases,
 * staleness, reclamation, and the three negative cases from the design's
 * section 9. CDP_ARTIFACT_DIR is redirected to a per-run temp dir, which is
 * why leaseDir() reads the env var per call instead of at module load.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { chmod, mkdtemp, rm, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TOOL_NAMES } from "../src/index.ts";
import { MANIFEST } from "../src/manifest.ts";
import type { Target } from "../src/types.ts";
import type { BrowsingContextInfo } from "../src/bidi/protocol.ts";
import { resolveTarget } from "../src/client.ts";
import { resolveContext } from "../src/bidi/driver.ts";
import { createCdpDriver } from "../src/cdp/driver.ts";
import { closePage, newPage, selectPage } from "../src/shared-tools.ts";
import {
  assertLeaseOk,
  claimLease,
  LeaseConflictError,
  releaseLeaseFor,
  currentLease,
  leaseFromArgs,
  isPidAlive,
  leaseFile,
  listLeases,
  markLongLivedProcess,
  readLease,
  releaseLease,
  requireLease,
  staleReason,
  tokenParts,
  touchLease,
  withLeaseScope,
  type LeaseRecord,
} from "../src/leases.ts";
import { page, stubDriver } from "./helpers/stub-driver.ts";

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

  test("a healthy, unexpired, live-pid lease reports stale:false and hides the nonce", async () => {
    const { record } = await claimLease("chrome", "HEALTHY", { label: "agent-one", now: 1_000 });
    const rows = await listLeases({ now: 1_000 + 60_000 });
    expect(rows.length).toBe(1);
    expect(rows[0]).toMatchObject({ backend: "chrome", targetId: "HEALTHY", label: "agent-one", pidAlive: true, stale: false });
    expect(rows[0]?.createdAt).toBe(record.createdAt);
    expect(Object.keys(rows[0]!)).not.toContain("nonce");
  });

  test("liveBackend scopes the target-gone test to the matching backend only", async () => {
    await claimLease("chrome", "GONE", { label: "a" });
    await claimLease("firefox", "FFX", { label: "b" });
    const rows = (await listLeases({ liveIds: ["OTHER"], liveBackend: "chrome" })).sort((a, b) =>
      a.targetId.localeCompare(b.targetId),
    );
    expect(rows.length).toBe(2);
    // the chrome record's target is not in liveIds, so it is still reported target-gone
    expect(rows.find((r) => r.targetId === "GONE")?.stale).toBe("target-gone");
    // the firefox record is a different backend, so the same liveIds do not apply to it
    expect(rows.find((r) => r.targetId === "FFX")?.stale).toBe(false);
  });

  test("with no liveBackend, liveIds applies to every record regardless of backend", async () => {
    await claimLease("chrome", "GONE2", { label: "a" });
    await claimLease("firefox", "FFX2", { label: "b" });
    const rows = (await listLeases({ liveIds: ["OTHER"] })).sort((a, b) => a.targetId.localeCompare(b.targetId));
    expect(rows.length).toBe(2);
    expect(rows.find((r) => r.targetId === "GONE2")?.stale).toBe("target-gone");
    expect(rows.find((r) => r.targetId === "FFX2")?.stale).toBe("target-gone");
  });
});

/**
 * An unreadable lease file must not read as an unleased tab. Reproduced the way
 * the review reproduced it: chmod 000 a live, healthy, in-TTL lease held by an
 * alive pid, then check both directions at once. Before the fix this admitted a
 * stranger, refused the true owner with "not leased any more", and reported
 * zero leases from the diagnostic tool.
 *
 * root ignores the permission bits, so these skip rather than pass vacuously
 * there. Every mode is restored in a finally so beforeEach's cleanup works.
 */
const asRoot = typeof process.getuid === "function" && process.getuid() === 0;
async function withUnreadable<T>(file: string, fn: () => Promise<T>): Promise<T> {
  await chmod(file, 0o000);
  try {
    return await fn();
  } finally {
    await chmod(file, 0o600);
  }
}

describe("an unreadable lease file is not an unleased tab (fix round 2, Important 1)", () => {
  test.skipIf(asRoot)("readLease throws instead of reporting the tab free", async () => {
    await claimLease("chrome", "TAB-P", { label: "agent-one" });
    await withUnreadable(leaseFile("chrome", "TAB-P"), async () => {
      await expect(readLease("chrome", "TAB-P")).rejects.toThrow(/EACCES|permission denied/i);
    });
    // And it is readable again afterwards, so nothing was destroyed.
    expect((await readLease("chrome", "TAB-P"))?.label).toBe("agent-one");
  });

  test.skipIf(asRoot)("a stranger with no token is REFUSED, not admitted", async () => {
    await claimLease("chrome", "TAB-P", { label: "agent-one" });
    await withUnreadable(leaseFile("chrome", "TAB-P"), async () => {
      await expect(assertLeaseOk("chrome", "TAB-P", {})).rejects.toThrow(/EACCES|permission denied/i);
    });
  });

  test.skipIf(asRoot)("the true owner is not told its lease was released or reclaimed", async () => {
    const { token } = await claimLease("chrome", "TAB-P", { label: "agent-one" });
    await withUnreadable(leaseFile("chrome", "TAB-P"), async () => {
      // The owner still fails, which is correct: we cannot verify the nonce.
      // What must NOT happen is the false explanation, which tells a healthy
      // owner to re-claim a tab it already holds.
      const err = await assertLeaseOk("chrome", "TAB-P", { lease: token }).then(
        () => undefined,
        (e: unknown) => e as Error,
      );
      expect(err).toBeDefined();
      expect(err?.message ?? "").not.toMatch(/not leased any more/);
      expect(err).not.toBeInstanceOf(LeaseConflictError);
    });
    // Once readable again the owner sails through: no state was lost.
    await expect(assertLeaseOk("chrome", "TAB-P", { lease: token })).resolves.toBeUndefined();
  });

  test.skipIf(asRoot)("list_leases surfaces the entry instead of reporting zero leases", async () => {
    await claimLease("chrome", "TAB-P", { label: "agent-one" });
    await withUnreadable(leaseFile("chrome", "TAB-P"), async () => {
      const rows = await listLeases({ now: 1_000 });
      expect(rows.length).toBe(1);
      expect(rows[0]?.unreadable).toBe("EACCES");
      expect(rows[0]?.backend).toBe("chrome");
      expect(rows[0]?.targetId).toBe("TAB-P");
      // Never reported as reclaimable, and never leaking a nonce.
      expect(rows[0]?.stale).toBe(false);
      expect(Object.keys(rows[0]!)).not.toContain("nonce");
    });
  });

  test("a file that reads fine but does not parse is reported, not skipped", async () => {
    await writeFile(leaseFile("chrome", "GARBAGE"), "{ not json", "utf8");
    const rows = await listLeases({ now: 1_000 });
    expect(rows.length).toBe(1);
    expect(rows[0]).toMatchObject({ backend: "chrome", targetId: "GARBAGE", unreadable: "unparseable", stale: false });
    // A corrupt record stays "absent" at the gate on purpose: unlike an errno it
    // can never heal, so failing closed would brick the tab with no recovery.
    await expect(readLease("chrome", "GARBAGE")).resolves.toBeUndefined();
    await expect(assertLeaseOk("chrome", "GARBAGE", {})).resolves.toBeUndefined();
  });

  test.skipIf(asRoot)("a heartbeat does not fail the call it rides on", async () => {
    // touchLease is the one reader that must still swallow the error: a tool
    // call that did real work must not fail because lastUsedAt could not be
    // refreshed. It leaves the record alone rather than throwing.
    const { record } = await claimLease("chrome", "TAB-T", { label: "agent-one", now: 1_000 });
    await withUnreadable(leaseFile("chrome", "TAB-T"), async () => {
      await expect(touchLease(record, 9_000)).resolves.toBeUndefined();
    });
    expect((await readLease("chrome", "TAB-T"))?.lastUsedAt).toBe(1_000);
  });

  test("an absent lease directory is still an empty list, not an error", async () => {
    const missing = join(dir, "does-not-exist");
    process.env.CDP_ARTIFACT_DIR = missing;
    try {
      expect(await listLeases({ now: 1_000 })).toEqual([]);
      await expect(readLease("chrome", "ANY")).resolves.toBeUndefined();
      await expect(assertLeaseOk("chrome", "ANY", {})).resolves.toBeUndefined();
    } finally {
      process.env.CDP_ARTIFACT_DIR = dir;
    }
  });
});

/**
 * The two gates that cover 36 of the 39 tools (everything but the lease group itself). Both were deletable with a green
 * suite: removing the assertLeaseOk call from resolveTarget or from
 * resolveContext left 102 pass / 0 fail, so a later refactor could drop lease
 * enforcement from Chrome or Firefox entirely and CI would approve it. These
 * two tests exist so that deletion fails, in the shape of the resolvePage tests
 * above: a stub target list plus a held lease, asserting the resolver refuses.
 *
 * Each drives its resolver through the cheapest seam that reaches the gate:
 * resolveTarget over a stubbed GET /json/list, resolveContext over a stub
 * connection answering browsingContext.getTree. Neither needs a browser.
 */
describe("resolveTarget is the Chrome choke point (fix round 2, Important 3)", () => {
  const realFetch = globalThis.fetch;
  const targets: Target[] = [
    { id: "CT-A", type: "page", title: "A", url: "https://example.test/a", webSocketDebuggerUrl: "ws://x/a" },
    { id: "CT-B", type: "page", title: "B", url: "https://example.test/b", webSocketDebuggerUrl: "ws://x/b" },
  ];
  beforeEach(() => {
    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = String(typeof input === "object" && "url" in input ? input.url : input);
      if (url.endsWith("/json/list")) return new Response(JSON.stringify(targets), { headers: { "content-type": "application/json" } });
      throw new Error(`unexpected fetch in test: ${url}`);
    }) as typeof fetch;
  });
  afterAll(() => {
    globalThis.fetch = realFetch;
  });

  test("an unleased target resolves exactly as before", async () => {
    expect((await resolveTarget("CT-A")).id).toBe("CT-A");
  });

  test("a target another agent holds is REFUSED, by every selector form", async () => {
    await claimLease("chrome", "CT-A", { label: "agent-one" });
    for (const selector of ["CT-A", undefined, "active", "index:0", "url:/a", "title:A"] as const) {
      await expect(resolveTarget(selector)).rejects.toThrow(LeaseConflictError);
    }
    // The other tab is untouched: this is a lease check, not a lockout.
    expect((await resolveTarget("CT-B")).id).toBe("CT-B");
  });

  test("the holder's own token resolves it and refreshes the lease", async () => {
    const { token, record } = await claimLease("chrome", "CT-A", { label: "agent-one" });
    // Age the record by a minute, in place and nonce intact, so the refresh is
    // observable without pinning `now` (the gate uses the real clock here).
    const aged = record.lastUsedAt - 60_000;
    await writeFile(leaseFile("chrome", "CT-A"), JSON.stringify({ ...record, lastUsedAt: aged }), "utf8");
    expect((await resolveTarget("CT-A", { lease: token })).id).toBe("CT-A");
    expect((await readLease("chrome", "CT-A"))?.lastUsedAt).toBeGreaterThan(aged);
  });

  test("the ambient dispatch scope supplies the token too", async () => {
    const { token } = await claimLease("chrome", "CT-A", { label: "agent-one" });
    await withLeaseScope(token, async () => {
      expect((await resolveTarget("active")).id).toBe("CT-A");
    });
  });

  test("a stale lease does not brick the target", async () => {
    // claimLease always records the live process, so age the record instead:
    // an elapsed TTL is the staleness rule a real abandonment hits.
    await claimLease("chrome", "CT-A", { label: "ghost", ttlMs: 1, now: 1_000 });
    expect((await resolveTarget("CT-A")).id).toBe("CT-A");
  });
});

describe("resolveContext is the Firefox choke point (fix round 2, Important 3)", () => {
  // Only browsingContext.getTree is ever sent: a bare-id selector needs no
  // title lookup, so the stub can answer one method and nothing else.
  const context = (id: string, url: string) =>
    ({ children: null, clientWindow: "w", context: id, originalOpener: null, url, userContext: "default" }) as unknown as BrowsingContextInfo;
  function stubConn(contexts: BrowsingContextInfo[]) {
    const sent: string[] = [];
    const conn = {
      async send(method: string) {
        sent.push(method);
        if (method === "browsingContext.getTree") return { contexts };
        throw new Error(`unexpected BiDi command in test: ${method}`);
      },
    };
    return { conn: conn as unknown as Parameters<typeof resolveContext>[0], sent };
  }
  const contexts = [context("FF-A", "https://example.test/a"), context("FF-B", "https://example.test/b")];

  test("an unleased context resolves exactly as before", async () => {
    const { conn } = stubConn(contexts);
    expect((await resolveContext(conn, "FF-A")).context).toBe("FF-A");
  });

  test("a context another agent holds is REFUSED", async () => {
    await claimLease("firefox", "FF-A", { label: "agent-one" });
    const { conn } = stubConn(contexts);
    for (const selector of ["FF-A", undefined, "active", "index:0", "url:/a"] as const) {
      await expect(resolveContext(conn, selector)).rejects.toThrow(LeaseConflictError);
    }
    expect((await resolveContext(conn, "FF-B")).context).toBe("FF-B");
  });

  test("a Chrome lease on the same id does not refuse the Firefox context", async () => {
    // The gate is keyed "firefox", so a colliding CDP targetId must not bleed
    // across. Deleting the backend argument would show up here.
    await claimLease("chrome", "FF-A", { label: "chrome-agent" });
    const { conn } = stubConn(contexts);
    expect((await resolveContext(conn, "FF-A")).context).toBe("FF-A");
  });

  test("the holder's own token resolves it", async () => {
    const { token } = await claimLease("firefox", "FF-A", { label: "agent-one" });
    const { conn } = stubConn(contexts);
    expect((await resolveContext(conn, "FF-A", { lease: token })).context).toBe("FF-A");
    await withLeaseScope(token, async () => {
      expect((await resolveContext(conn, "FF-A")).context).toBe("FF-A");
    });
  });
});

/**
 * The Chrome driver's acquisition path must not launder the gate's error.
 *
 * cdp/driver.ts caught everything out of resolveTarget / openPage and rethrew
 * it as `no-such-target`. The 118 tests that shipped alongside that catch all
 * passed, because they assert on message text and on the MCP text surface, and
 * the message text is the one thing the rewrap preserved. So these assert on
 * IDENTITY instead: the class, the targetId, the holder, and the absence of a
 * code that tells a caller to give up. `no-such-target` means the selector
 * matched nothing, which is the one instruction a lease conflict must never
 * carry: a conflict is exactly the case where retrying, or going to fetch the
 * token, is right. Revert the pass-through in noSuchTarget and these fail.
 */
describe("the Chrome driver does not launder a lease conflict into no-such-target", () => {
  const realFetch = globalThis.fetch;
  const targets: Target[] = [
    { id: "DT-A", type: "page", title: "A", url: "https://example.test/a", webSocketDebuggerUrl: "ws://x/a" },
    { id: "DT-B", type: "page", title: "B", url: "https://example.test/b", webSocketDebuggerUrl: "ws://x/b" },
  ];
  beforeEach(() => {
    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = String(typeof input === "object" && "url" in input ? input.url : input);
      if (url.endsWith("/json/list")) return new Response(JSON.stringify(targets), { headers: { "content-type": "application/json" } });
      throw new Error(`unexpected fetch in test: ${url}`);
    }) as typeof fetch;
  });
  afterAll(() => {
    globalThis.fetch = realFetch;
  });
  // Both paths reject before any websocket is opened, so no browser is needed.
  const failure = (p: Promise<unknown>) => p.then(() => undefined, (e: unknown) => e as Error & { code?: unknown; targetId?: string; holder?: string });

  test("page() keeps the conflict's type, targetId and holder", async () => {
    await claimLease("chrome", "DT-A", { label: "agent-one" });
    const driver = createCdpDriver();
    for (const selector of ["DT-A", undefined, "active", "index:0", "url:/a", "title:A"] as const) {
      const err = await failure(driver.page(selector));
      expect(err).toBeInstanceOf(LeaseConflictError);
      expect(err?.targetId).toBe("DT-A");
      expect(err?.holder).toBe("agent-one");
      expect(err?.code).not.toBe("no-such-target");
    }
  });

  test("activatePage() keeps the conflict's type, targetId and holder", async () => {
    await claimLease("chrome", "DT-A", { label: "agent-one" });
    const err = await failure(createCdpDriver().activatePage("DT-A"));
    expect(err).toBeInstanceOf(LeaseConflictError);
    expect(err?.targetId).toBe("DT-A");
    expect(err?.holder).toBe("agent-one");
    expect(err?.code).not.toBe("no-such-target");
  });

  test("a genuinely missing target is still no-such-target (the fix does not over-correct)", async () => {
    const driver = createCdpDriver();
    for (const selector of ["DT-NOPE", "index:9", "url:/nowhere", "title:nothing"] as const) {
      expect((await failure(driver.page(selector)))?.code).toBe("no-such-target");
      expect((await failure(driver.activatePage(selector)))?.code).toBe("no-such-target");
    }
    // And an unleased tab still resolves through the gate untouched.
    expect((await resolveTarget("DT-A")).id).toBe("DT-A");
  });

  test("Chrome and Firefox report the same conflict identically", async () => {
    await claimLease("chrome", "SAME-ID", { label: "agent-one" });
    await claimLease("firefox", "SAME-ID", { label: "agent-one" });
    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = String(typeof input === "object" && "url" in input ? input.url : input);
      if (url.endsWith("/json/list"))
        return new Response(JSON.stringify([{ id: "SAME-ID", type: "page", title: "S", url: "https://example.test/s", webSocketDebuggerUrl: "ws://x/s" }]), {
          headers: { "content-type": "application/json" },
        });
      throw new Error(`unexpected fetch in test: ${url}`);
    }) as typeof fetch;
    const chrome = await failure(createCdpDriver().page("SAME-ID"));
    const conn = {
      async send(method: string) {
        if (method === "browsingContext.getTree")
          return {
            contexts: [
              { children: null, clientWindow: "w", context: "SAME-ID", originalOpener: null, url: "https://example.test/s", userContext: "default" },
            ] as unknown as BrowsingContextInfo[],
          };
        throw new Error(`unexpected BiDi command in test: ${method}`);
      },
    } as unknown as Parameters<typeof resolveContext>[0];
    const firefox = await failure(resolveContext(conn, "SAME-ID"));
    for (const err of [chrome, firefox]) {
      expect(err).toBeInstanceOf(LeaseConflictError);
      expect(err?.targetId).toBe("SAME-ID");
      expect(err?.holder).toBe("agent-one");
      expect(err?.code).toBeUndefined();
    }
  });

  test.skipIf(asRoot)("an unreadable lease file is not reported as a missing target either", async () => {
    await claimLease("chrome", "DT-A", { label: "agent-one" });
    await withUnreadable(leaseFile("chrome", "DT-A"), async () => {
      const err = await failure(createCdpDriver().page("DT-A"));
      expect(err?.message ?? "").toMatch(/EACCES|permission denied/i);
      expect(err?.code).not.toBe("no-such-target");
    });
  });
});

describe("registry and manifest wiring", () => {
  test("the three lease tools are registered", () => {
    expect(TOOL_NAMES).toContain("claim_page");
    expect(TOOL_NAMES).toContain("release_page");
    expect(TOOL_NAMES).toContain("list_leases");
    // 36 before list_cookies was added, 37 before set_cookie and delete_cookies.
    expect(TOOL_NAMES.length).toBe(39);
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

describe("close_page clears the lease (spec section 6)", () => {
  test("releaseLeaseFor drops a lease without needing its token", async () => {
    await claimLease("chrome", "CLOSING", { label: "agent-one" });
    expect(await releaseLeaseFor("chrome", "CLOSING")).toEqual({ released: true });
    expect(await readLease("chrome", "CLOSING")).toBeUndefined();
  });

  test("releaseLeaseFor on an unleased tab is not an error", async () => {
    expect(await releaseLeaseFor("chrome", "NEVER-LEASED")).toEqual({ released: false });
  });

  test("a tab closed out of band is reclaimable via the live-id list", async () => {
    await claimLease("chrome", "CLOSED-BY-HUMAN", { label: "agent-one", now: 1_000 });
    // The tab is gone from the browser but the file survives: the third
    // staleness condition, not the TTL, is what frees it.
    const retaken = await claimLease("chrome", "CLOSED-BY-HUMAN", { label: "agent-two", now: 1_100, liveIds: [] });
    expect(retaken.record.label).toBe("agent-two");
  });
});

/* ------------------------- the tab lifecycle, end to end ------------------------- */

describe("new_page claims the tab it opens", () => {
  test("claim:true returns a token that is a real, readable lease on the new tab", async () => {
    const { driver } = stubDriver();
    const res = await newPage(driver, { claim: true, label: "agent-one" });
    expect(res.lease).toBeDefined();
    expect(tokenParts(res.lease!)).toMatchObject({ backend: "chrome", targetId: res.targetId });
    const rec = await readLease("chrome", res.targetId);
    expect(rec?.label).toBe("agent-one");
    expect(tokenParts(res.lease!)?.nonce).toBe(rec!.nonce);
    expect(res.label).toBe("agent-one");
    expect(res.expiresAt).toBe(rec!.lastUsedAt + rec!.ttlMs);
  });

  test("the claimed tab is then closed to everyone else", async () => {
    const { driver, closed } = stubDriver();
    const res = await newPage(driver, { claim: true, label: "agent-one" });
    await expect(closePage(driver, { target: res.targetId })).rejects.toThrow(LeaseConflictError);
    expect(closed).toEqual([]);
  });

  test("no claim means no lease and the pre-1.2 return shape, byte for byte", async () => {
    const { driver } = stubDriver();
    const res = await newPage(driver, { url: "https://example.test/x" });
    expect(res).toEqual({ targetId: "NEW-1", url: "https://example.test/x" });
    expect(await readLease("chrome", "NEW-1")).toBeUndefined();
  });

  test("claim:true with no label records pid-<pid>", async () => {
    const { driver } = stubDriver();
    const res = await newPage(driver, { claim: true });
    expect((await readLease("chrome", res.targetId))?.label).toBe(`pid-${process.pid}`);
  });

  test("ttlMs is honoured on the claim", async () => {
    const { driver } = stubDriver();
    const res = await newPage(driver, { claim: true, ttlMs: 5_000 });
    expect((await readLease("chrome", res.targetId))?.ttlMs).toBe(5_000);
  });

  test("a bidi driver claims under the firefox backend, not chrome", async () => {
    const { driver } = stubDriver({ scheme: "bidi" });
    const res = await newPage(driver, { claim: true, label: "ffx" });
    expect(await readLease("firefox", res.targetId)).toBeDefined();
    expect(await readLease("chrome", res.targetId)).toBeUndefined();
    expect(tokenParts(res.lease!)?.backend).toBe("firefox");
  });
});

describe("close_page and select_page are the third choke point", () => {
  test("close_page frees the lease of the tab it closed", async () => {
    const { driver, closed } = stubDriver({ pages: [page("A")] });
    const { token } = await claimLease("chrome", "A", { label: "agent-one" });
    const res = await withLeaseScope(token, () => closePage(driver, { target: "A" }));
    expect(res).toEqual({ closed: "A", success: true, leaseReleased: true });
    expect(closed).toEqual(["A"]);
    expect(await readLease("chrome", "A")).toBeUndefined();
  });

  test("a failed close (driver returns success:false) does not release the lease", async () => {
    const { driver, closed } = stubDriver({ pages: [page("A")], failClose: true });
    const { token } = await claimLease("chrome", "A", { label: "agent-one" });
    const res = await withLeaseScope(token, () => closePage(driver, { target: "A" }));
    expect(res).toEqual({ closed: "A", success: false, leaseReleased: false });
    expect(closed).toEqual(["A"]);
    expect(await readLease("chrome", "A")).toBeDefined();
  });

  test("closing an unleased tab reports no release and is otherwise unchanged", async () => {
    const { driver, closed } = stubDriver({ pages: [page("A")] });
    const res = await closePage(driver, { target: "A" });
    expect(res).toEqual({ closed: "A", success: true });
    expect(closed).toEqual(["A"]);
  });

  test("an unleased caller cannot close a tab another agent holds, and the lease survives", async () => {
    const { driver, closed } = stubDriver({ pages: [page("A")] });
    await claimLease("chrome", "A", { label: "agent-one" });
    await expect(closePage(driver, { target: "A" })).rejects.toThrow(/leased by 'agent-one'/);
    expect(closed).toEqual([]);
    expect(await readLease("chrome", "A")).toBeDefined();
  });

  test("holding tab A's token does not license closing tab B", async () => {
    const { driver, closed } = stubDriver({ pages: [page("A"), page("B")] });
    const { token } = await claimLease("chrome", "A", { label: "agent-one" });
    await claimLease("chrome", "B", { label: "agent-two" });
    await expect(withLeaseScope(token, () => closePage(driver, { target: "B" }))).rejects.toThrow(LeaseConflictError);
    expect(closed).toEqual([]);
    expect(await readLease("chrome", "B")).toBeDefined();
  });

  test("every selector form reaches the gate, not just a bare id", async () => {
    const { driver } = stubDriver({ pages: [page("A", "https://example.test/only")] });
    await claimLease("chrome", "A", { label: "agent-one" });
    for (const target of ["A", "active", "index:0", "url:only", "title:A"]) {
      await expect(closePage(driver, { target })).rejects.toThrow(LeaseConflictError);
    }
  });

  test("a leased NON-page target resolved off the all:true listing is protected too", async () => {
    // The one resolvePage branch whose hit is absent from the page list. Passing
    // the page ids as liveIds here would classify this healthy lease as
    // target-gone and let the call through.
    const { driver, closed } = stubDriver({ pages: [page("A")], hidden: [{ id: "WORKER-1", url: "about:blank", title: "w", type: "worker" }] });
    await claimLease("chrome", "WORKER-1", { label: "agent-one" });
    await expect(closePage(driver, { target: "WORKER-1" })).rejects.toThrow(LeaseConflictError);
    expect(closed).toEqual([]);
  });

  test("a stale lease never blocks a close, and closing clears the file", async () => {
    const { driver, closed } = stubDriver({ pages: [page("A")] });
    await claimLease("chrome", "A", { label: "ghost", ttlMs: 1, now: 1_000 });
    const res = await closePage(driver, { target: "A" });
    expect(closed).toEqual(["A"]);
    expect(res.leaseReleased).toBe(true);
    expect(await readLease("chrome", "A")).toBeUndefined();
  });

  test("select_page refuses a tab another agent holds and never activates it", async () => {
    const { driver, activated } = stubDriver({ pages: [page("A")] });
    await claimLease("chrome", "A", { label: "agent-one" });
    await expect(selectPage(driver, { target: "A" })).rejects.toThrow(LeaseConflictError);
    expect(activated).toEqual([]);
  });
});

describe("requireLease (the strict-mode switch)", () => {
  const originalRequire = process.env.CDP_REQUIRE_LEASE;
  afterEach(() => {
    if (originalRequire === undefined) delete process.env.CDP_REQUIRE_LEASE;
    else process.env.CDP_REQUIRE_LEASE = originalRequire;
    markLongLivedProcess(false);
  });

  test("is false in a CLI process no matter what the env says", () => {
    process.env.CDP_REQUIRE_LEASE = "1";
    // markLongLivedProcess deliberately NOT called: this is cli.ts's state.
    expect(requireLease()).toBe(false);
  });

  test("accepts 1, true, yes, on, case-insensitively, in a long-lived process", () => {
    markLongLivedProcess();
    for (const raw of ["1", "true", "TRUE", " True ", "yes", "on"]) {
      process.env.CDP_REQUIRE_LEASE = raw;
      expect(requireLease()).toBe(true);
    }
  });

  test("rejects unset, 0, false, and garbage", () => {
    markLongLivedProcess();
    delete process.env.CDP_REQUIRE_LEASE;
    expect(requireLease()).toBe(false);
    for (const raw of ["0", "false", "no", "off", "", "maybe"]) {
      process.env.CDP_REQUIRE_LEASE = raw;
      expect(requireLease()).toBe(false);
    }
  });
});

describe("LeaseRecord.auto", () => {
  test("claimLease defaults to an explicit (auto:false) lease", async () => {
    await claimLease("chrome", "TIER-A", { label: "a" });
    expect((await readLease("chrome", "TIER-A"))?.auto).toBe(false);
  });

  test("claimLease records auto:true when asked", async () => {
    await claimLease("chrome", "TIER-B", { label: "b", auto: true });
    expect((await readLease("chrome", "TIER-B"))?.auto).toBe(true);
  });

  test("a 1.4.0 record with no auto key reads as explicit, not auto", async () => {
    // Exactly what <=1.4.0 wrote: no auto key at all. It must NOT be treated as
    // an auto lease, or upgrading would silently downgrade a held lease's
    // protection from token-required to pid-only.
    const rec: LeaseRecord = {
      backend: "chrome", targetId: "TIER-C", nonce: "a".repeat(24),
      pid: process.pid, label: "legacy", createdAt: 1, lastUsedAt: 1, ttlMs: 900_000,
    };
    await writeFile(leaseFile("chrome", "TIER-C"), JSON.stringify(rec));
    expect((await readLease("chrome", "TIER-C"))?.auto ?? false).toBe(false);
  });
});

describe("assertLeaseOk auto-acquire (strict mode)", () => {
  const originalRequire = process.env.CDP_REQUIRE_LEASE;
  beforeEach(() => {
    markLongLivedProcess();
    process.env.CDP_REQUIRE_LEASE = "1";
  });
  afterEach(() => {
    if (originalRequire === undefined) delete process.env.CDP_REQUIRE_LEASE;
    else process.env.CDP_REQUIRE_LEASE = originalRequire;
    markLongLivedProcess(false);
  });

  test("an unleased tab with no token is ACQUIRED, not waved through", async () => {
    await assertLeaseOk("chrome", "AUTO-1");
    const rec = await readLease("chrome", "AUTO-1");
    expect(rec?.auto).toBe(true);
    expect(rec?.pid).toBe(process.pid);
    expect(rec?.label).toBe(`pid-${process.pid}`);
  });

  test("our own auto lease passes without a token and refreshes lastUsedAt", async () => {
    await claimLease("chrome", "AUTO-2", { label: "x", auto: true, now: 1000 });
    await assertLeaseOk("chrome", "AUTO-2", { now: 5000 });
    expect((await readLease("chrome", "AUTO-2"))?.lastUsedAt).toBe(5000);
  });

  test("our own EXPLICIT lease still demands its token, even same-process", async () => {
    // The whole point of the two tiers: a subagent that claimed explicitly is
    // protected from its siblings, which share this pid.
    await claimLease("chrome", "AUTO-3", { label: "sibling" });
    await expect(assertLeaseOk("chrome", "AUTO-3")).rejects.toThrow(LeaseConflictError);
  });

  test("another live pid's auto lease is refused", async () => {
    // pid 1 is alive on every platform this runs on, so isPidAlive is true and
    // the record is not stale for the dead-pid reason.
    const rec: LeaseRecord = {
      backend: "chrome", targetId: "AUTO-4", nonce: "b".repeat(24),
      pid: 1, label: "other-agent", createdAt: Date.now(), lastUsedAt: Date.now(),
      ttlMs: 900_000, auto: true,
    };
    await writeFile(leaseFile("chrome", "AUTO-4"), JSON.stringify(rec));
    await expect(assertLeaseOk("chrome", "AUTO-4")).rejects.toThrow(LeaseConflictError);
  });

  test("a token for TAB-A causes an unrelated unleased TAB-C to be acquired", async () => {
    const { token } = await claimLease("chrome", "AUTO-5-A", { label: "holder" });
    await assertLeaseOk("chrome", "AUTO-5-C", { lease: token });
    expect((await readLease("chrome", "AUTO-5-C"))?.auto).toBe(true);
  });

  test("a token naming THIS tab, when the tab is unleased, still throws and mints nothing", async () => {
    // The caller asserted it holds a specific lease and is wrong. Minting one
    // here would turn a real error into a silent success.
    const { token } = await claimLease("chrome", "AUTO-6", { label: "gone" });
    await releaseLease(token);
    await expect(assertLeaseOk("chrome", "AUTO-6", { lease: token })).rejects.toThrow(LeaseConflictError);
    expect(await readLease("chrome", "AUTO-6")).toBeUndefined();
  });

  test("a malformed token throws and mints nothing", async () => {
    await expect(assertLeaseOk("chrome", "AUTO-7", { lease: "not-a-token" })).rejects.toThrow(LeaseConflictError);
    expect(await readLease("chrome", "AUTO-7")).toBeUndefined();
  });

  test("an auto lease from a DEAD pid is reclaimed, not inherited", async () => {
    const rec: LeaseRecord = {
      backend: "chrome", targetId: "AUTO-8", nonce: "c".repeat(24),
      pid: 999_999, label: "dead-agent", createdAt: 1, lastUsedAt: 1,
      ttlMs: 900_000, auto: true,
    };
    await writeFile(leaseFile("chrome", "AUTO-8"), JSON.stringify(rec));
    await assertLeaseOk("chrome", "AUTO-8");
    const after = await readLease("chrome", "AUTO-8");
    expect(after?.pid).toBe(process.pid);
    expect(after?.nonce).not.toBe("c".repeat(24));
  });
});

describe("assertLeaseOk with strict mode OFF (1.4.0 regression guard)", () => {
  test("an unleased tab with no token is left completely untouched", async () => {
    // markLongLivedProcess is not called, so requireLease() is false.
    await assertLeaseOk("chrome", "OFF-1");
    expect(await readLease("chrome", "OFF-1")).toBeUndefined();
  });

  test("our own auto lease still passes with the flag off", async () => {
    // Line 2 of the gate is deliberately NOT flag-gated: turning strict off
    // must not lock this process out of leases it is still holding.
    markLongLivedProcess();
    process.env.CDP_REQUIRE_LEASE = "1";
    await assertLeaseOk("chrome", "OFF-2");
    markLongLivedProcess(false);
    delete process.env.CDP_REQUIRE_LEASE;
    await assertLeaseOk("chrome", "OFF-2");  // must not throw
    expect((await readLease("chrome", "OFF-2"))?.auto).toBe(true);
  });
});
