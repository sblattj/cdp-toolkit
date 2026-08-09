/**
 * Unit tests for release_page's two entry modes and its close-on-release rule.
 *
 * Kept in its own file rather than appended to leases.test.ts because this is a
 * TOOL test, not a store test: it drives leases-tools.ts through a stub driver
 * and asserts on what happened to the browser (which tabs got closed), where
 * leases.test.ts asserts on what happened to the lease directory.
 *
 * CDP_ARTIFACT_DIR is redirected to a per-run temp dir, the same way
 * leases.test.ts does it, because that one variable is the root of BOTH stores
 * this file touches: leaseFile() and originFile() are siblings in it. Clearing
 * it between tests is what keeps one test's origin record from deciding a later
 * test's close.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { releasePage } from "../src/leases-tools.ts";
import { newPage } from "../src/shared-tools.ts";
import {
  claimLease,
  LeaseConflictError,
  leaseFile,
  markLongLivedProcess,
  readLease,
  type LeaseRecord,
} from "../src/leases.ts";
import { page, stubDriver } from "./helpers/stub-driver.ts";

let dir = "";
const originalArtifactDir = process.env.CDP_ARTIFACT_DIR;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "cdp-release-"));
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

describe("release_page: argument validation", () => {
  test("neither lease nor target is refused", async () => {
    const { driver } = stubDriver();
    await expect(releasePage(driver, {})).rejects.toThrow(/exactly one/i);
  });

  test("both lease and target is refused", async () => {
    const { driver } = stubDriver({ pages: [page("REL-0")] });
    const { token } = await claimLease("chrome", "REL-0", { label: "x" });
    await expect(releasePage(driver, { lease: token, target: "REL-0" })).rejects.toThrow(/exactly one/i);
    // Refusing must be total: an ambiguous call releases nothing, so the lease
    // is still there afterwards for whoever actually holds it.
    expect(await readLease("chrome", "REL-0")).toBeDefined();
  });

  test("an empty-string lease is treated as absent, not as a malformed token", async () => {
    const { driver } = stubDriver();
    await expect(releasePage(driver, { lease: "" })).rejects.toThrow(/exactly one/i);
  });
});

describe("release_page: close-on-release", () => {
  test("closes a tab the toolkit opened", async () => {
    const { driver, closed } = stubDriver();
    const created = await newPage(driver, { claim: true }); // writes an origin record
    const res = await releasePage(driver, { lease: created.lease! });
    expect(res).toEqual({ released: true, closed: true, targetId: created.targetId });
    expect(closed).toContain(created.targetId);
    expect(await readLease("chrome", created.targetId)).toBeUndefined();
  });

  test("releases but does NOT close a tab the toolkit did not open", async () => {
    // No origin record: a tab the human already had open, which an agent claimed.
    const { driver, closed, pages } = stubDriver({ pages: [page("HUMAN-1")] });
    const { token } = await claimLease("chrome", "HUMAN-1", { label: "agent" });
    const res = await releasePage(driver, { lease: token });
    expect(res).toEqual({ released: true, closed: false, targetId: "HUMAN-1" });
    expect(closed).toEqual([]);
    // The tab is still open, which is the point of the whole provenance rule.
    expect(pages.map((p) => p.id)).toEqual(["HUMAN-1"]);
  });

  test("close:true forces a close on a tab with no origin record", async () => {
    const { driver, closed } = stubDriver({ pages: [page("HUMAN-2")] });
    const { token } = await claimLease("chrome", "HUMAN-2", { label: "agent" });
    const res = await releasePage(driver, { lease: token, close: true });
    expect(res).toEqual({ released: true, closed: true, targetId: "HUMAN-2" });
    expect(closed).toEqual(["HUMAN-2"]);
  });

  test("close:false keeps an agent-created tab open", async () => {
    const { driver, closed } = stubDriver();
    const created = await newPage(driver, { claim: true });
    const res = await releasePage(driver, { lease: created.lease!, close: false });
    expect(res).toEqual({ released: true, closed: false, targetId: created.targetId });
    expect(closed).toEqual([]);
  });

  test("a RECLAIMED lease releases nothing and closes nothing", async () => {
    // The tab may belong to someone else now. Closing it would kill their tab.
    const { driver, closed } = stubDriver();
    const created = await newPage(driver, { claim: true });
    await claimLease("chrome", created.targetId, { label: "new-owner", now: Date.now() + 10_000_000 });
    const res = await releasePage(driver, { lease: created.lease! });
    expect(res).toEqual({ released: false, closed: false });
    expect(closed).toEqual([]);
    // The new owner's lease survives untouched: a stale token must not be able
    // to delete a lease it no longer names.
    expect((await readLease("chrome", created.targetId))?.label).toBe("new-owner");
  });

  test("an already-released lease releases nothing and closes nothing", async () => {
    const { driver, closed } = stubDriver();
    const created = await newPage(driver, { claim: true });
    const first = await releasePage(driver, { lease: created.lease! });
    expect(first.released).toBe(true);
    const second = await releasePage(driver, { lease: created.lease! });
    expect(second).toEqual({ released: false, closed: false });
    // Exactly one close, from the first call. A second release must not close
    // again: by now the id could have been reused by another tab entirely.
    expect(closed).toEqual([created.targetId]);
  });

  test("a malformed token releases nothing and does not throw", async () => {
    const { driver, closed } = stubDriver();
    const res = await releasePage(driver, { lease: "not-a-token" });
    expect(res).toEqual({ released: false, closed: false });
    expect(closed).toEqual([]);
  });

  test("a failed close still reports the release as done", async () => {
    // failClose is a construction option, not a mutable flag: the stub mirrors
    // CdpDriver, where a refused close returns success:false AND leaves the page.
    const { driver, closed, pages } = stubDriver({ failClose: true });
    const created = await newPage(driver, { claim: true });
    const res = await releasePage(driver, { lease: created.lease! });
    expect(res).toEqual({ released: true, closed: false, targetId: created.targetId });
    expect(closed).toEqual([created.targetId]); // it was attempted
    expect(pages.map((p) => p.id)).toEqual([created.targetId]); // and it failed
    expect(await readLease("chrome", created.targetId)).toBeUndefined(); // still released
  });
});

describe("release_page: target mode", () => {
  const originalRequire = process.env.CDP_REQUIRE_LEASE;
  afterEach(() => {
    if (originalRequire === undefined) delete process.env.CDP_REQUIRE_LEASE;
    else process.env.CDP_REQUIRE_LEASE = originalRequire;
    markLongLivedProcess(false);
  });

  test("releases and closes an agent tab addressed by selector", async () => {
    markLongLivedProcess();
    process.env.CDP_REQUIRE_LEASE = "1";
    const { driver, closed } = stubDriver();
    // stubDriver.newPage already pushes the created page into `pages`, so the
    // selector below resolves without any extra setup.
    const created = await newPage(driver, {});
    const res = await releasePage(driver, { target: created.targetId });
    expect(res).toEqual({ released: true, closed: true, targetId: created.targetId });
    expect(closed).toEqual([created.targetId]);
  });

  test("target mode works with a non-id selector too", async () => {
    // The whole reason target mode exists is that an auto-acquired lease never
    // handed back a token, so it has to accept the same grammar every other
    // tool takes rather than only a raw target id.
    markLongLivedProcess();
    process.env.CDP_REQUIRE_LEASE = "1";
    const { driver, closed } = stubDriver();
    const created = await newPage(driver, { url: "https://example.test/pick-me" });
    const res = await releasePage(driver, { target: "url:pick-me" });
    expect(res).toEqual({ released: true, closed: true, targetId: created.targetId });
    expect(closed).toEqual([created.targetId]);
  });

  test("close:false in target mode releases without closing", async () => {
    markLongLivedProcess();
    process.env.CDP_REQUIRE_LEASE = "1";
    const { driver, closed } = stubDriver();
    const created = await newPage(driver, {});
    const res = await releasePage(driver, { target: created.targetId, close: false });
    expect(res).toEqual({ released: true, closed: false, targetId: created.targetId });
    expect(closed).toEqual([]);
    expect(await readLease("chrome", created.targetId)).toBeUndefined();
  });

  test("with the flag off, an unleased tab is a no-op, not a licence to close", async () => {
    const { driver, closed } = stubDriver({ pages: [page("FREE-1")] });
    const res = await releasePage(driver, { target: "FREE-1" });
    expect(res).toEqual({ released: false, closed: false, targetId: "FREE-1" });
    expect(closed).toEqual([]);
  });

  test("an unleased AGENT-CREATED tab is still a no-op with the flag off", async () => {
    // Provenance alone never authorizes a close: without a release there is
    // nothing to close on. This is the released:false rule, tested against the
    // one case where the origin record would otherwise say "yes, close it".
    const { driver, closed } = stubDriver();
    const created = await newPage(driver, {}); // origin record, no lease
    const res = await releasePage(driver, { target: created.targetId });
    expect(res).toEqual({ released: false, closed: false, targetId: created.targetId });
    expect(closed).toEqual([]);
  });

  test("a tab held by another live pid is refused", async () => {
    const rec: LeaseRecord = {
      backend: "chrome",
      targetId: "OTHER-1",
      nonce: "d".repeat(24),
      pid: 1,
      label: "other-agent",
      createdAt: Date.now(),
      lastUsedAt: Date.now(),
      ttlMs: 900_000,
      auto: true,
    };
    await writeFile(leaseFile("chrome", "OTHER-1"), JSON.stringify(rec));
    const { driver, closed } = stubDriver({ pages: [page("OTHER-1")] });
    await expect(releasePage(driver, { target: "OTHER-1" })).rejects.toThrow(LeaseConflictError);
    expect(closed).toEqual([]);
    // Refused means untouched: the other agent's lease is still exactly there.
    expect((await readLease("chrome", "OTHER-1"))?.nonce).toBe("d".repeat(24));
  });
});
