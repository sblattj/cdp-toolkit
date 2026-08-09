/**
 * Tests for the IMPURE half of reap: reapStaleAgentTabs and the two read tools
 * that call it (list_pages, list_leases).
 *
 * Kept out of reap.test.ts on purpose. That file covers the pure selector with
 * no browser and no filesystem; this one is about what the wiring does to the
 * real world — which tabs the driver was actually told to close, which lease
 * files are gone afterwards, and what the tool reported. Those are different
 * failure modes: a perfect selector wired to the wrong id set still closes the
 * wrong tab.
 *
 * CDP_ARTIFACT_DIR is redirected to a per-run temp dir, as in leases.test.ts
 * and release-page.test.ts, because leaseFile() and originFile() are siblings
 * in it and BOTH stores decide whether a tab gets closed. Clearing it between
 * tests is what keeps one test's abandoned tab from being reaped by the next.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listLeasesTool } from "../src/leases-tools.ts";
import { listPages } from "../src/shared-tools.ts";
import { listOrigins, recordOrigin } from "../src/origins.ts";
import { leaseFile, markLongLivedProcess, readLease, type LeaseRecord } from "../src/leases.ts";
import { page, stubDriver } from "./helpers/stub-driver.ts";

let dir = "";
const originalArtifactDir = process.env.CDP_ARTIFACT_DIR;
const originalRequire = process.env.CDP_REQUIRE_LEASE;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "cdp-reap-wiring-"));
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

afterEach(() => {
  if (originalRequire === undefined) delete process.env.CDP_REQUIRE_LEASE;
  else process.env.CDP_REQUIRE_LEASE = originalRequire;
  markLongLivedProcess(false);
});

/** Strict mode is two conditions, not one: the env var AND being the long-lived
 *  MCP process. Setting only the env var leaves requireLease() false. */
function strictOn(): void {
  markLongLivedProcess();
  process.env.CDP_REQUIRE_LEASE = "1";
}

/**
 * An agent tab whose owning process is gone: a real origin record, a lease held
 * by a pid that cannot be alive, and a live page in the stub's listing. This is
 * the exact shape reap exists for, and every condition below is load-bearing —
 * drop the origin record and it must not be reaped, drop the page and there is
 * nothing to close.
 */
async function abandonedAgentTab(stub: ReturnType<typeof stubDriver>, id: string): Promise<void> {
  await recordOrigin("chrome", id, { label: "dead-agent" });
  const rec: LeaseRecord = {
    backend: "chrome",
    targetId: id,
    nonce: "e".repeat(24),
    pid: 999_999,
    label: "dead-agent",
    createdAt: 1,
    lastUsedAt: 1,
    ttlMs: 900_000,
    auto: true,
  };
  await writeFile(leaseFile("chrome", id), JSON.stringify(rec));
  stub.pages.push(page(id));
}

describe("reap wiring: list_pages", () => {
  test("closes the abandoned tab, reports it, omits it from pages, and drops its lease", async () => {
    strictOn();
    const stub = stubDriver();
    await abandonedAgentTab(stub, "REAP-1");
    const res = await listPages(stub.driver, {});
    // (a) actually closed: the driver was told to, and the stub dropped the page.
    expect(stub.closed).toEqual(["REAP-1"]);
    expect(stub.pages.map((p) => p.id)).not.toContain("REAP-1");
    // (b) absent from the listing this very call returned.
    expect(res.pages.map((p) => p.id)).not.toContain("REAP-1");
    expect(res.count).toBe(res.pages.length);
    // (c) reported, never silent.
    expect(res.reaped).toEqual([{ targetId: "REAP-1", label: "dead-agent", reason: "dead-pid" }]);
    // The lease file is unlinked, so the tab is not re-selected on every read.
    expect(await readLease("chrome", "REAP-1")).toBeUndefined();
  });

  test("omits the reaped key entirely when nothing was reaped", async () => {
    strictOn();
    const stub = stubDriver({ pages: [page("KEEP-1")] });
    const res = await listPages(stub.driver, {});
    expect("reaped" in res).toBe(false);
    expect(res.pages.map((p) => p.id)).toEqual(["KEEP-1"]);
  });

  test("with the flag off, nothing is reaped", async () => {
    const stub = stubDriver();
    await abandonedAgentTab(stub, "REAP-2");
    const res = await listPages(stub.driver, {});
    expect(stub.closed).toEqual([]);
    expect(res.pages.map((p) => p.id)).toContain("REAP-2");
    expect("reaped" in res).toBe(false);
    expect(await readLease("chrome", "REAP-2")).toBeDefined();
  });

  test("a tab whose close FAILS is not reported as reaped and is not hidden", async () => {
    strictOn();
    const stub = stubDriver({ failClose: true });
    await abandonedAgentTab(stub, "REAP-4");
    const res = await listPages(stub.driver, {});
    // The close was attempted...
    expect(stub.closed).toEqual(["REAP-4"]);
    // ...and refused, so the tab is STILL OPEN. Reporting it as reaped would
    // make the caller filter a live tab out of its own listing.
    expect(res.reaped).toBeUndefined();
    expect(res.pages.map((p) => p.id)).toContain("REAP-4");
    // Lease kept, so the next read tries again rather than orphaning the tab.
    expect(await readLease("chrome", "REAP-4")).toBeDefined();
  });

  test("never reaps a target that only the all:true listing has", async () => {
    // The page-only rule, at the wiring level: a worker or iframe can carry a
    // lease via pickPage's bare-id branch, and closing it is meaningless. The
    // pure selector cannot catch this — it is entirely a question of which
    // listing the wrapper feeds it.
    strictOn();
    const stub = stubDriver({ pages: [page("PAGE-1")], hidden: [page("WORKER-1")] });
    await abandonedAgentTab(stub, "WORKER-1");
    // abandonedAgentTab pushes into the visible list; move it back to hidden.
    stub.pages.splice(stub.pages.findIndex((p) => p.id === "WORKER-1"), 1);
    const res = await listPages(stub.driver, { all: true });
    expect(stub.closed).toEqual([]);
    expect(res.reaped).toBeUndefined();
    expect(res.pages.map((p) => p.id)).toContain("WORKER-1");
  });

  test("the reap does not delete origin records for live but filtered-out targets", async () => {
    // reapStaleAgentTabs passes undefined liveIds to originIndex on purpose:
    // reaping the LEDGER is list_pages' job and uses the unfiltered listing.
    // Passing the page-only ids here instead would silently delete the
    // provenance record of every worker and iframe on the first strict read.
    strictOn();
    const stub = stubDriver({ pages: [page("PAGE-2")], hidden: [page("WORKER-2")] });
    await recordOrigin("chrome", "WORKER-2", { label: "agent-x" });
    await listPages(stub.driver, {});
    expect((await listOrigins()).map((o) => o.targetId)).toContain("WORKER-2");
  });
});

describe("reap wiring: list_leases", () => {
  test("reaps too, drops the reaped row, and reports it", async () => {
    strictOn();
    const stub = stubDriver();
    await abandonedAgentTab(stub, "REAP-3");
    const res = await listLeasesTool(stub.driver);
    expect(stub.closed).toEqual(["REAP-3"]);
    expect(res.leases.map((l) => l.targetId)).not.toContain("REAP-3");
    expect(res.count).toBe(res.leases.length);
    expect(res.reaped).toEqual([{ targetId: "REAP-3", label: "dead-agent", reason: "dead-pid" }]);
  });

  test("omits the reaped key entirely when nothing was reaped", async () => {
    strictOn();
    const stub = stubDriver({ pages: [page("KEEP-2")] });
    const res = await listLeasesTool(stub.driver);
    expect("reaped" in res).toBe(false);
  });

  test("with the flag off, nothing is reaped and the stale row is still reported", async () => {
    const stub = stubDriver();
    await abandonedAgentTab(stub, "REAP-5");
    const res = await listLeasesTool(stub.driver);
    expect(stub.closed).toEqual([]);
    expect(res.leases.map((l) => l.targetId)).toContain("REAP-5");
  });
});
