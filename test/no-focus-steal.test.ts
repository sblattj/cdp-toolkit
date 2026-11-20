// Nothing the toolkit does implicitly may take keyboard focus or switch the
// user's visible tab. new_page / claim_page open background tabs, select_page
// only persists the selection, and each raises a tab only on focus:true.
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { newPage, selectPage } from "../src/shared-tools.ts";
import { claimPage } from "../src/leases-tools.ts";
import { bidiCreateTabParams } from "../src/bidi/driver.ts";
import { page, stubDriver } from "./helpers/stub-driver.ts";

let dir = "";
const saved = { artifact: process.env.CDP_ARTIFACT_DIR, state: process.env.CDP_STATE_DIR, strict: process.env.CDP_REQUIRE_LEASE };

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "cdp-no-focus-"));
  process.env.CDP_ARTIFACT_DIR = join(dir, "artifacts");
  process.env.CDP_STATE_DIR = join(dir, "state");
});

beforeEach(async () => {
  delete process.env.CDP_REQUIRE_LEASE;
  // Stub ids restart at NEW-1 per driver, so a lease left by the last test would collide.
  await rm(join(dir, "artifacts"), { recursive: true, force: true });
});

afterAll(async () => {
  for (const [k, v] of [["CDP_ARTIFACT_DIR", saved.artifact], ["CDP_STATE_DIR", saved.state], ["CDP_REQUIRE_LEASE", saved.strict]] as const) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  await rm(dir, { recursive: true, force: true });
});

describe("select_page", () => {
  test("default: persists the selection and never activates the tab", async () => {
    const { driver, activated } = stubDriver({ pages: [page("A"), page("B")] });
    const res = await selectPage(driver, { target: "B" });
    expect(res).toEqual({ selected: "B", focused: false });
    expect(activated).toEqual([]);
    expect(await readFile(join(dir, "state", "selected"), "utf8")).toBe("B");
  });

  test("focus:false is the same as the default", async () => {
    const { driver, activated } = stubDriver({ pages: [page("A")] });
    await selectPage(driver, { target: "A", focus: false });
    expect(activated).toEqual([]);
  });

  test("focus:true activates the tab and still persists it", async () => {
    const { driver, activated } = stubDriver({ pages: [page("A"), page("B")] });
    const res = await selectPage(driver, { target: "A", focus: true });
    expect(res).toEqual({ selected: "A", focused: true });
    expect(activated).toEqual(["A"]);
    expect(await readFile(join(dir, "state", "selected"), "utf8")).toBe("A");
  });
});

describe("new_page", () => {
  test("default opens in the background (focus false reaches the driver)", async () => {
    const { driver, newPageOpts, activated } = stubDriver();
    await newPage(driver, { url: "https://example.test/x" });
    expect(newPageOpts).toEqual([{ focus: false }]);
    expect(activated).toEqual([]);
  });

  test("focus:true reaches the driver", async () => {
    const { driver, newPageOpts } = stubDriver();
    await newPage(driver, { focus: true });
    expect(newPageOpts).toEqual([{ focus: true }]);
  });
});

describe("claim_page", () => {
  test("a fresh tab opens in the background by default", async () => {
    const { driver, newPageOpts } = stubDriver();
    const res = await claimPage(driver, { label: "bg" });
    expect(res.opened).toBe(true);
    expect(newPageOpts).toEqual([{ focus: false }]);
  });

  test("focus:true opens the fresh tab in the foreground", async () => {
    const { driver, newPageOpts } = stubDriver();
    await claimPage(driver, { label: "fg", focus: true });
    expect(newPageOpts).toEqual([{ focus: true }]);
  });

  test("takeover ignores focus: no tab is created or activated", async () => {
    const { driver, newPageOpts, activated } = stubDriver({ pages: [page("A")] });
    const res = await claimPage(driver, { target: "A", label: "take", focus: true });
    expect(res.opened).toBe(false);
    expect(newPageOpts).toEqual([]);
    expect(activated).toEqual([]);
  });
});

describe("BiDi browsingContext.create params", () => {
  test("background:true by default", () => {
    expect(bidiCreateTabParams()).toEqual({ type: "tab", background: true });
    expect(bidiCreateTabParams({ focus: false })).toEqual({ type: "tab", background: true });
  });

  test("focus:true creates a foreground tab", () => {
    expect(bidiCreateTabParams({ focus: true })).toEqual({ type: "tab", background: false });
  });
});

describe("CDP_DENY_FOCUS refuses even an explicit raise", () => {
  const prev = process.env.CDP_DENY_FOCUS;
  beforeEach(() => { process.env.CDP_DENY_FOCUS = "1"; });
  afterAll(() => {
    if (prev === undefined) delete process.env.CDP_DENY_FOCUS;
    else process.env.CDP_DENY_FOCUS = prev;
  });

  test("new_page focus:true opens in the background and says focusDenied", async () => {
    const { driver, newPageOpts, activated } = stubDriver();
    const res = await newPage(driver, { focus: true });
    expect(newPageOpts).toEqual([{ focus: false }]);
    expect(activated).toEqual([]);
    expect(res.focusDenied).toBe(true);
  });

  test("new_page without focus keeps the default shape (no focusDenied)", async () => {
    const { driver } = stubDriver();
    const res = await newPage(driver, {});
    expect("focusDenied" in res).toBe(false);
  });

  test("claim_page focus:true opens the fresh tab in the background", async () => {
    const { driver, newPageOpts } = stubDriver();
    await claimPage(driver, { label: "deny", focus: true });
    expect(newPageOpts).toEqual([{ focus: false }]);
  });

  test("select_page focus:true only selects and says focusDenied", async () => {
    const { driver, activated } = stubDriver({ pages: [page("A"), page("B")] });
    const res = await selectPage(driver, { target: "B", focus: true });
    expect(res).toEqual({ selected: "B", focused: false, focusDenied: true });
    expect(activated).toEqual([]);
    expect(await readFile(join(dir, "state", "selected"), "utf8")).toBe("B");
  });

  test("select_page without focus is unchanged under the switch", async () => {
    const { driver } = stubDriver({ pages: [page("A")] });
    expect(await selectPage(driver, { target: "A" })).toEqual({ selected: "A", focused: false });
  });

  test("falsy values leave explicit focus working", async () => {
    for (const v of ["0", "", "false", "off"]) {
      process.env.CDP_DENY_FOCUS = v;
      const { driver, activated } = stubDriver({ pages: [page("A")] });
      expect(await selectPage(driver, { target: "A", focus: true })).toEqual({ selected: "A", focused: true });
      expect(activated).toEqual(["A"]);
    }
  });
});
