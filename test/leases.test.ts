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
  claimLease,
  leaseFile,
  readLease,
  releaseLease,
  tokenParts,
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
