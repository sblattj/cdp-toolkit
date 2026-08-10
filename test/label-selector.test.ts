/**
 * Unit tests for pickPage's "label:<name>" selector arm (src/shared-tools.ts).
 *
 * Resolution consults TWO independent stores: the origin ledger (agent-created
 * tabs, src/origins.ts) and live lease records (src/leases.ts). A tab taken
 * over via claim_page{target,label} gets a lease record but deliberately NO
 * origin record (see leases-tools.ts's claimPage), so the lease-only case here
 * is not a redundant variant of the origin case, it is the ONLY path that
 * exercises a takeover tab's label at all.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pickPage } from "../src/shared-tools.ts";
import { recordOrigin } from "../src/origins.ts";
import { claimLease } from "../src/leases.ts";
import { page, stubDriver } from "./helpers/stub-driver.ts";

let dir = "";
const originalArtifactDir = process.env.CDP_ARTIFACT_DIR;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "cdp-label-selector-"));
  process.env.CDP_ARTIFACT_DIR = dir;
});

afterAll(async () => {
  if (originalArtifactDir === undefined) delete process.env.CDP_ARTIFACT_DIR;
  else process.env.CDP_ARTIFACT_DIR = originalArtifactDir;
  await rm(dir, { recursive: true, force: true });
});

beforeEach(async () => {
  await mkdir(dir, { recursive: true });
  for (const f of await readdir(dir)) await rm(join(dir, f), { force: true });
});

describe("label: hits", () => {
  test("resolves via the origin ledger (agent-created tab)", async () => {
    await recordOrigin("chrome", "T1", { label: "w2-origin" });
    const { driver } = stubDriver({ pages: [page("T1"), page("T2")] });
    const hit = await pickPage(driver, [page("T1"), page("T2")], "label:w2-origin");
    expect(hit.id).toBe("T1");
  });

  test("resolves via a lease record alone (the taken-over-tab shape, no origin record)", async () => {
    await claimLease("chrome", "T2", { label: "w2-lease" });
    // Deliberately NOT calling recordOrigin: this is the claim_page{target,label}
    // shape, which never writes to the origin ledger.
    const { driver } = stubDriver({ pages: [page("T1"), page("T2")] });
    const hit = await pickPage(driver, [page("T1"), page("T2")], "label:w2-lease");
    expect(hit.id).toBe("T2");
  });

  test("is scoped to the resolving backend: a chrome lease is invisible to a firefox pickPage", async () => {
    await claimLease("chrome", "T1", { label: "cross-backend" });
    const { driver } = stubDriver({ scheme: "bidi", pages: [page("T1")] });
    await expect(pickPage(driver, [page("T1")], "label:cross-backend")).rejects.toThrow(/no live target with label 'cross-backend'/);
  });
});

describe("label: misses", () => {
  test("enumerates the labels that DO exist, from both sources, deduped", async () => {
    await recordOrigin("chrome", "T1", { label: "foo" });
    await claimLease("chrome", "T2", { label: "bar" });
    const pages = [page("T1"), page("T2")];
    const { driver } = stubDriver({ pages });
    await expect(pickPage(driver, pages, "label:nope")).rejects.toThrow(
      /no live target with label 'nope' \(labels currently in use: bar, foo\)/,
    );
  });

  test("with no labels recorded at all, says so rather than printing an empty list", async () => {
    const pages = [page("T1")];
    const { driver } = stubDriver({ pages });
    await expect(pickPage(driver, pages, "label:nope")).rejects.toThrow(
      /no live target with label 'nope' \(no labels are currently assigned to any open target\)/,
    );
  });

  test("a label whose tab is gone falls through to the normal no-match error, not a stale hit", async () => {
    // GONE has a real origin record, but it is not in the page listing this
    // call is resolving against, so it must not count as a match OR appear in
    // the "labels that do exist" list — both would mislead the caller into
    // retrying a label that can never resolve.
    await recordOrigin("chrome", "GONE", { label: "ghost" });
    const pages = [page("T1")];
    const { driver } = stubDriver({ pages });
    await expect(pickPage(driver, pages, "label:ghost")).rejects.toThrow(
      /no live target with label 'ghost' \(no labels are currently assigned to any open target\)/,
    );
  });
});

describe("label: ambiguity", () => {
  test("two live targets sharing a label error naming both ids, never a silent first-match", async () => {
    await recordOrigin("chrome", "T1", { label: "dup" });
    await claimLease("chrome", "T2", { label: "dup" });
    const pages = [page("T1"), page("T2")];
    const { driver } = stubDriver({ pages });
    await expect(pickPage(driver, pages, "label:dup")).rejects.toThrow(/matches more than one live target: T1, T2/);
  });

  test("the same target labeled in BOTH stores is one match, not an ambiguity", async () => {
    await recordOrigin("chrome", "T1", { label: "same-tab" });
    await claimLease("chrome", "T1", { label: "same-tab" });
    const pages = [page("T1")];
    const { driver } = stubDriver({ pages });
    const hit = await pickPage(driver, pages, "label:same-tab");
    expect(hit.id).toBe("T1");
  });
});
