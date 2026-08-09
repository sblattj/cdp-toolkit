/**
 * Tests for Task 3 of the lease-required-and-close-on-release plan: new_page
 * auto-claiming its tab under strict mode (CDP_REQUIRE_LEASE=1 in a long-lived
 * process). Kept in its own file rather than appended to test/leases.test.ts
 * because other concurrent work is editing that file's own copy in parallel;
 * appending here would guarantee a merge conflict on integration.
 *
 * Setup mirrors test/leases.test.ts: CDP_ARTIFACT_DIR is redirected to a
 * per-run temp dir (claimLease/readLease read it per call, not at module
 * load) and cleared between tests so lease files from one test never leak
 * into the next.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { markLongLivedProcess, readLease } from "../src/leases.ts";
import { newPage } from "../src/shared-tools.ts";
import { stubDriver } from "./helpers/stub-driver.ts";

let dir = "";
const originalArtifactDir = process.env.CDP_ARTIFACT_DIR;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "cdp-new-page-strict-"));
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

describe("new_page under strict mode", () => {
  const originalRequire = process.env.CDP_REQUIRE_LEASE;
  afterEach(() => {
    if (originalRequire === undefined) delete process.env.CDP_REQUIRE_LEASE;
    else process.env.CDP_REQUIRE_LEASE = originalRequire;
    markLongLivedProcess(false);
  });

  test("claims the tab and returns a token even without claim:true", async () => {
    markLongLivedProcess();
    process.env.CDP_REQUIRE_LEASE = "1";
    // stubDriver() starts with zero pages, so the target this asserts against
    // is the one newPage itself creates via driver.newPage(), not a
    // pre-existing stub fixture -- the assertion genuinely exercises the
    // auto-claim path rather than something the stub set up for free.
    const { driver } = stubDriver();
    const res = await newPage(driver, {});
    expect(res.lease).toBeTypeOf("string");
    const rec = await readLease("chrome", res.targetId);
    expect(rec?.auto).toBe(true);
    expect(rec?.pid).toBe(process.pid);
  });

  test("claim:true stays EXPLICIT under strict mode", async () => {
    // The whole point of the two tiers: an explicit claim must not be
    // silently downgraded to pid-only just because strict mode is on.
    markLongLivedProcess();
    process.env.CDP_REQUIRE_LEASE = "1";
    const { driver } = stubDriver();
    const res = await newPage(driver, { claim: true });
    expect(res.lease).toBeTypeOf("string");
    expect((await readLease("chrome", res.targetId))?.auto).toBe(false);
  });

  test("with the flag off, no claim and no lease field (1.4.0 shape)", async () => {
    // markLongLivedProcess is not called, so requireLease() is false: this is
    // the byte-identical-to-1.4.0 regression guard for the common case.
    const { driver } = stubDriver();
    const res = await newPage(driver, {});
    expect(res.lease).toBeUndefined();
    expect(await readLease("chrome", res.targetId)).toBeUndefined();
  });

  test("with the flag off, claim:true still claims explicitly (pre-existing path, unaffected)", async () => {
    const { driver } = stubDriver();
    const res = await newPage(driver, { claim: true });
    expect(res.lease).toBeTypeOf("string");
    expect((await readLease("chrome", res.targetId))?.auto).toBe(false);
  });
});
