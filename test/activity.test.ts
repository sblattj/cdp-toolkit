/**
 * Unit tests for src/activity.ts and the two tool surfaces that carry its
 * answer, claim_page and list_leases.
 *
 * NO BROWSER IS NEEDED FOR ANY OF THIS, which is the point of splitting the
 * module the way it is split: the discrimination rule is a pure function of two
 * timestamps, the beacon is a string of JavaScript that can be run against a
 * fake window, and both tools take a driver as a parameter. What genuinely
 * cannot be tested here — that Chrome's own dispatched input is isTrusted and
 * therefore indistinguishable in-page, and that a held connection is what keeps
 * an init script armed across navigation — is proved in test/staleness-smoke.ts
 * against a real browser, because neither claim is checkable without one.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MANIFEST } from "../src/manifest.ts";
import { claimPage, listLeasesTool, type ClaimPageResult, type LeaseRow } from "../src/leases-tools.ts";
import { claimLease, leaseFile, releaseLeaseFor } from "../src/leases.ts";
import { listPages, newPage } from "../src/shared-tools.ts";
import { page, stubDriver } from "./helpers/stub-driver.ts";
import {
  BEACON_DATA_GLOBAL,
  BEACON_EVENTS,
  BEACON_FUNCTION_DECLARATION,
  BEACON_INSTALLED_GLOBAL,
  BEACON_READ_EXPRESSION,
  BEACON_SOURCE,
  BeaconSessions,
  CONTENTION_WINDOW_MS,
  DISPATCH_ATTRIBUTION_WINDOW_MS,
  RENDERER_PROBE_TIMEOUT_MS,
  beaconSupported,
  clearDispatchLog,
  contentionWarning,
  forgetDispatch,
  humanActiveMs,
  installBeacon,
  isHumanAttributed,
  lastDispatchAt,
  probeRendererActivity,
  readHumanActiveMs,
  recordDispatch,
  rendererProbeSupported,
} from "../src/activity.ts";

const ORIGINAL_ARTIFACT_DIR = process.env.CDP_ARTIFACT_DIR;
let artifactDir = "";

beforeAll(async () => {
  artifactDir = await mkdtemp(join(tmpdir(), "cdp-activity-test-"));
  process.env.CDP_ARTIFACT_DIR = artifactDir;
});

afterAll(async () => {
  if (ORIGINAL_ARTIFACT_DIR === undefined) delete process.env.CDP_ARTIFACT_DIR;
  else process.env.CDP_ARTIFACT_DIR = ORIGINAL_ARTIFACT_DIR;
  await rm(artifactDir, { recursive: true, force: true });
});

// The dispatch log is module state shared by every test in this process, so a
// leftover entry from one case would silently change another's verdict.
beforeEach(() => clearDispatchLog());
afterEach(() => clearDispatchLog());

/* ------------------------------ the in-page beacon ------------------------------ */

/** A window just real enough to run the beacon against. Records every listener
 *  registration so the capture/passive options can be asserted rather than
 *  eyeballed in the source string. */
function fakeWindow() {
  const listeners: Array<{ type: string; options: unknown }> = [];
  const win: Record<string, unknown> = {
    addEventListener(type: string, _handler: unknown, options: unknown) {
      listeners.push({ type, options });
    },
  };
  return { win, listeners };
}

/** Run BEACON_SOURCE with `window` bound to a fake. The beacon only ever touches
 *  `window` and `Date`, so a Function with one parameter is a faithful host. */
function runBeacon(win: Record<string, unknown>): void {
  new Function("window", BEACON_SOURCE)(win);
}

describe("the in-page beacon script", () => {
  test("registers one capture-phase passive listener per input event", () => {
    const { win, listeners } = fakeWindow();
    runBeacon(win);
    expect(listeners.map((l) => l.type)).toEqual([...BEACON_EVENTS]);
    for (const l of listeners) expect(l.options).toEqual({ capture: true, passive: true });
  });

  test("listens for exactly the five input events, wheel included", () => {
    // wheel is what makes plain reading register: someone scrolling an article
    // never clicks. Pinned here so a future edit cannot quietly drop it.
    expect([...BEACON_EVENTS]).toEqual(["pointerdown", "mousedown", "keydown", "wheel", "touchstart"]);
  });

  test("is idempotent: re-running adds no second set of listeners", () => {
    const { win, listeners } = fakeWindow();
    runBeacon(win);
    runBeacon(win);
    runBeacon(win);
    expect(listeners.length).toBe(BEACON_EVENTS.length);
  });

  test("guards on a DIFFERENT global than the one it writes", () => {
    // The bug this pins: guarding on the DATA global would re-install on every
    // claim of a tab nobody has touched yet, because that global does not exist
    // until the first input arrives. Re-run on a window that has been installed
    // into but never had input, and assert no listener is added.
    const { win, listeners } = fakeWindow();
    runBeacon(win);
    expect(win[BEACON_INSTALLED_GLOBAL]).toBe(true);
    expect(win[BEACON_DATA_GLOBAL]).toBeUndefined();
    runBeacon(win);
    expect(listeners.length).toBe(BEACON_EVENTS.length);
  });

  test("a fired listener writes a timestamp to the data global", () => {
    const captured: Array<(e?: unknown) => void> = [];
    const win: Record<string, unknown> = {
      addEventListener(_type: string, handler: (e?: unknown) => void) {
        captured.push(handler);
      },
    };
    runBeacon(win);
    const before = Date.now();
    captured[0]!();
    const after = Date.now();
    const stamped = win[BEACON_DATA_GLOBAL] as number;
    expect(typeof stamped).toBe("number");
    expect(stamped).toBeGreaterThanOrEqual(before);
    expect(stamped).toBeLessThanOrEqual(after);
  });

  test("the function-declaration form is the same beacon, for BiDi", () => {
    const { win, listeners } = fakeWindow();
    // script.addPreloadScript takes a functionDeclaration, not a program, so the
    // two forms have to stay the same script or Firefox would install something
    // Chrome never sees.
    new Function("window", `(${BEACON_FUNCTION_DECLARATION})();`)(win);
    expect(listeners.map((l) => l.type)).toEqual([...BEACON_EVENTS]);
    expect(win[BEACON_INSTALLED_GLOBAL]).toBe(true);
  });

  test("the read expression yields null on a document with no beacon", () => {
    const read = (win: Record<string, unknown>) => new Function("window", `return ${BEACON_READ_EXPRESSION};`)(win);
    expect(read({})).toBe(null);
    expect(read({ [BEACON_DATA_GLOBAL]: "not-a-number" })).toBe(null);
    expect(read({ [BEACON_DATA_GLOBAL]: 1234 })).toBe(1234);
  });
});

/* -------------------------------- the dispatch log -------------------------------- */

describe("the dispatch log", () => {
  test("records and reads back per backend and target", () => {
    recordDispatch("chrome", "T1", 1000);
    expect(lastDispatchAt("chrome", "T1")).toBe(1000);
    expect(lastDispatchAt("chrome", "T2")).toBeUndefined();
  });

  test("a chrome target and a firefox context with the SAME id do not collide", () => {
    // leases.ts refuses to assume the two id spaces are disjoint; so does this.
    recordDispatch("chrome", "SAME", 1000);
    expect(lastDispatchAt("firefox", "SAME")).toBeUndefined();
    recordDispatch("firefox", "SAME", 2000);
    expect(lastDispatchAt("chrome", "SAME")).toBe(1000);
    expect(lastDispatchAt("firefox", "SAME")).toBe(2000);
  });

  test("a later dispatch overwrites an earlier one", () => {
    recordDispatch("chrome", "T1", 1000);
    recordDispatch("chrome", "T1", 5000);
    expect(lastDispatchAt("chrome", "T1")).toBe(5000);
  });

  test("forgetDispatch drops one target and leaves the rest", () => {
    recordDispatch("chrome", "T1", 1000);
    recordDispatch("chrome", "T2", 1000);
    forgetDispatch("chrome", "T1");
    expect(lastDispatchAt("chrome", "T1")).toBeUndefined();
    expect(lastDispatchAt("chrome", "T2")).toBe(1000);
  });

  test("the log is bounded, evicting oldest-write-first", () => {
    // 512 is the cap. Write 600 and assert the oldest are gone, the newest are
    // kept, and the size is the cap exactly — computed, not eyeballed.
    for (let i = 0; i < 600; i++) recordDispatch("chrome", `T${i}`, 1000 + i);
    const present = Array.from({ length: 600 }, (_, i) => lastDispatchAt("chrome", `T${i}`) !== undefined);
    const kept = present.filter(Boolean).length;
    expect(kept).toBe(512);
    expect(present.slice(0, 88).some(Boolean)).toBe(false);
    expect(present.slice(88).every(Boolean)).toBe(true);
  });

  test("re-recording an existing target refreshes its eviction order", () => {
    recordDispatch("chrome", "OLD", 1);
    for (let i = 0; i < 400; i++) recordDispatch("chrome", `F${i}`, 2);
    recordDispatch("chrome", "OLD", 3); // moves it to the back of the queue
    for (let i = 0; i < 400; i++) recordDispatch("chrome", `G${i}`, 4);
    expect(lastDispatchAt("chrome", "OLD")).toBe(3);
  });
});

/* -------------------------------- discrimination -------------------------------- */

describe("human-vs-agent discrimination", () => {
  test("no beacon data is NOT human", () => {
    expect(isHumanAttributed(null, undefined)).toBe(false);
    expect(isHumanAttributed(undefined, undefined)).toBe(false);
    expect(isHumanAttributed(Number.NaN, undefined)).toBe(false);
    expect(isHumanAttributed(Number.POSITIVE_INFINITY, undefined)).toBe(false);
  });

  test("a beacon on a tab this process never drove is human", () => {
    expect(isHumanAttributed(1_700_000_000_000, undefined)).toBe(true);
  });

  test("a beacon INSIDE the attribution window after our dispatch is ours", () => {
    const dispatched = 1_700_000_000_000;
    expect(isHumanAttributed(dispatched, dispatched)).toBe(false);
    expect(isHumanAttributed(dispatched + 1, dispatched)).toBe(false);
    expect(isHumanAttributed(dispatched + DISPATCH_ATTRIBUTION_WINDOW_MS, dispatched)).toBe(false);
  });

  test("the window is exclusive: one ms past it is human", () => {
    const dispatched = 1_700_000_000_000;
    expect(isHumanAttributed(dispatched + DISPATCH_ATTRIBUTION_WINDOW_MS + 1, dispatched)).toBe(true);
  });

  test("a beacon OLDER than our dispatch is ours, not a human's", () => {
    // The tab was touched by a person, then we clicked. The freshest thing that
    // happened is ours, so there is nothing unaccounted-for to report.
    const dispatched = 1_700_000_000_000;
    expect(isHumanAttributed(dispatched - 60_000, dispatched)).toBe(false);
  });

  test("the window is 1500ms", () => {
    expect(DISPATCH_ATTRIBUTION_WINDOW_MS).toBe(1500);
  });

  test("humanActiveMs measures from the beacon, and is null when not human", () => {
    const now = 1_700_000_100_000;
    expect(humanActiveMs(now - 4_000, undefined, now)).toBe(4_000);
    expect(humanActiveMs(null, undefined, now)).toBe(null);
    expect(humanActiveMs(now - 100, now - 200, now)).toBe(null); // inside our window
  });

  test("humanActiveMs clamps a beacon from the page's future to zero", () => {
    // The page's Date.now() and the server's are the same wall clock, but a read
    // that races forward must not surface as a negative "ms ago".
    const now = 1_700_000_100_000;
    expect(humanActiveMs(now + 25, undefined, now)).toBe(0);
  });
});

/* --------------------------------- contention --------------------------------- */

describe("the contention warning", () => {
  test("is present on a takeover of a tab used inside the window", () => {
    const warning = contentionWarning(1_000, { takeover: true });
    expect(typeof warning).toBe("string");
    expect(warning).toContain("1000ms ago");
    // It must be unmistakable that the claim WORKED: a caller reading a warning
    // as a failure is the one misreading that would break the takeover feature.
    expect(warning).toContain("SUCCEEDED");
  });

  test("is absent past the window, on no data, and on a fresh tab", () => {
    expect(contentionWarning(CONTENTION_WINDOW_MS, { takeover: true })).toBeUndefined();
    expect(contentionWarning(CONTENTION_WINDOW_MS + 1, { takeover: true })).toBeUndefined();
    expect(contentionWarning(null, { takeover: true })).toBeUndefined();
    // opened:true — nobody can be contending for a tab that did not exist.
    expect(contentionWarning(0, { takeover: false })).toBeUndefined();
  });

  test("the window is 30s", () => {
    expect(CONTENTION_WINDOW_MS).toBe(30_000);
  });
});

/* ------------------------------ driver-facing helpers ------------------------------ */

describe("driver-facing helpers", () => {
  test("beaconSupported is false for a driver with neither member", () => {
    const { driver } = stubDriver({ pages: [page("A")] });
    expect(beaconSupported(driver)).toBe(false);
  });

  test("beaconSupported is true for a driver with both", () => {
    const { driver } = stubDriver({ pages: [page("A")], beacon: {} });
    expect(beaconSupported(driver)).toBe(true);
  });

  test("installBeacon on an unsupported driver is false, not a throw", () => {
    const { driver } = stubDriver({ pages: [page("A")] });
    return expect(installBeacon(driver, "A")).resolves.toBe(false);
  });

  test("installBeacon swallows a driver failure", async () => {
    const { driver, beaconInstalls } = stubDriver({ pages: [page("A")], beacon: { installThrows: true } });
    expect(await installBeacon(driver, "A")).toBe(false);
    expect(beaconInstalls).toEqual(["A"]);
  });

  test("readHumanActiveMs subtracts our own dispatch", async () => {
    const now = Date.now();
    const { driver } = stubDriver({ pages: [page("A")], beacon: { reads: { A: now - 5_000 } } });
    expect(await readHumanActiveMs(driver, "chrome", "A", now)).toBe(5_000);
    // Now claim that same input as ours, and it stops counting.
    recordDispatch("chrome", "A", now - 5_000);
    expect(await readHumanActiveMs(driver, "chrome", "A", now)).toBe(null);
  });

  test("readHumanActiveMs is null, never a throw, when the read fails", async () => {
    const { driver } = stubDriver({ pages: [page("A")], beacon: { readThrows: true } });
    expect(await readHumanActiveMs(driver, "chrome", "A")).toBe(null);
  });
});

/* -------------------------------- the renderer ping -------------------------------- */

describe("the renderer probe (list_pages{probe:true})", () => {
  test("RENDERER_PROBE_TIMEOUT_MS is 500ms", () => {
    expect(RENDERER_PROBE_TIMEOUT_MS).toBe(500);
  });

  test("rendererProbeSupported is false for a driver with no probeRenderer", () => {
    const { driver } = stubDriver({ pages: [page("A")] });
    expect(rendererProbeSupported(driver)).toBe(false);
  });

  test("rendererProbeSupported is true for a driver that has it", () => {
    const { driver } = stubDriver({ pages: [page("A")], probe: {} });
    expect(rendererProbeSupported(driver)).toBe(true);
  });

  test("probeRendererActivity on an unsupported driver degrades to unresponsive, never a throw", async () => {
    const { driver } = stubDriver({ pages: [page("A")] });
    expect(await probeRendererActivity(driver, "chrome", "A")).toEqual({ responsive: false });
  });

  test("a responsive probe with no beacon data reports responsive:true and no humanActiveMs", async () => {
    const { driver, probeCalls } = stubDriver({
      pages: [page("A")],
      probe: { responses: { A: { responsive: true, beaconTs: null } } },
    });
    expect(await probeRendererActivity(driver, "chrome", "A")).toEqual({ responsive: true });
    expect(probeCalls).toEqual(["A"]);
  });

  test("a responsive probe with human-attributed beacon data reports humanActiveMs", async () => {
    const now = Date.now();
    const { driver } = stubDriver({
      pages: [page("A")],
      probe: { responses: { A: { responsive: true, beaconTs: now - 3_000 } } },
    });
    const res = await probeRendererActivity(driver, "chrome", "A", now);
    expect(res.responsive).toBe(true);
    expect(res.humanActiveMs).toBeGreaterThanOrEqual(3_000);
  });

  test("a beacon timestamp inside our own dispatch window is not human, even though the probe was responsive", async () => {
    const now = Date.now();
    recordDispatch("chrome", "A", now - 100);
    const { driver } = stubDriver({
      pages: [page("A")],
      probe: { responses: { A: { responsive: true, beaconTs: now } } },
    });
    const res = await probeRendererActivity(driver, "chrome", "A", now);
    expect(res.responsive).toBe(true);
    expect("humanActiveMs" in res).toBe(false);
  });

  test("a wedged/unresponsive probe never throws and carries no humanActiveMs", async () => {
    const { driver } = stubDriver({
      pages: [page("A")],
      probe: { responses: { A: { responsive: false, beaconTs: null } } },
    });
    expect(await probeRendererActivity(driver, "chrome", "A")).toEqual({ responsive: false });
  });

  test("a driver whose probeRenderer rejects still degrades to unresponsive rather than throwing", async () => {
    const { driver } = stubDriver({ pages: [page("A")], probe: { throws: true } });
    expect(await probeRendererActivity(driver, "chrome", "A")).toEqual({ responsive: false });
  });
});

describe("list_pages{probe:true} wiring", () => {
  test("annotates a page-type entry with responsive:true when the probe answers", async () => {
    const stub = stubDriver({ pages: [page("P1")], probe: { responses: { P1: { responsive: true, beaconTs: null } } } });
    const res = await listPages(stub.driver, { probe: true });
    const entry = res.pages.find((p) => p.id === "P1")!;
    expect(entry.responsive).toBe(true);
    expect("humanActiveMs" in entry).toBe(false);
    expect(stub.probeCalls).toEqual(["P1"]);
  });

  test("a wedged tab reports responsive:false without failing the call", async () => {
    const stub = stubDriver({ pages: [page("P2")], probe: { responses: { P2: { responsive: false, beaconTs: null } } } });
    const res = await listPages(stub.driver, { probe: true });
    const entry = res.pages.find((p) => p.id === "P2")!;
    expect(entry.responsive).toBe(false);
  });

  test("a responsive probe with human-attributed data surfaces humanActiveMs on the entry", async () => {
    const stub = stubDriver({
      pages: [page("P3")],
      probe: { responses: { P3: { responsive: true, beaconTs: Date.now() - 4_000 } } },
    });
    const res = await listPages(stub.driver, { probe: true });
    const entry = res.pages.find((p) => p.id === "P3")!;
    expect(entry.responsive).toBe(true);
    expect(entry.humanActiveMs).toBeGreaterThanOrEqual(4_000);
  });

  test("without probe:true, no responsive field is added even on a driver that supports it", async () => {
    const stub = stubDriver({ pages: [page("P4")], probe: { responses: { P4: { responsive: true, beaconTs: null } } } });
    const res = await listPages(stub.driver, {});
    const entry = res.pages.find((p) => p.id === "P4")!;
    expect("responsive" in entry).toBe(false);
    expect(stub.probeCalls).toEqual([]);
  });

  test("on a driver with no probe support, probe:true adds nothing and never throws", async () => {
    const stub = stubDriver({ pages: [page("P5")] });
    const res = await listPages(stub.driver, { probe: true });
    const entry = res.pages.find((p) => p.id === "P5")!;
    expect("responsive" in entry).toBe(false);
  });
});

/* --------------------------- the keep-alive session registry --------------------------- */

describe("BeaconSessions", () => {
  test("closes a handle it displaces", () => {
    const closed: string[] = [];
    const sessions = new BeaconSessions<string>((v) => closed.push(v));
    sessions.set("k", "first");
    sessions.set("k", "second");
    expect(closed).toEqual(["first"]);
    expect(sessions.get("k")).toBe("second");
    expect(sessions.size).toBe(1);
  });

  test("evicts oldest-first past the limit, closing what it evicts", () => {
    const closed: string[] = [];
    const sessions = new BeaconSessions<string>((v) => closed.push(v), 3);
    for (const k of ["a", "b", "c", "d", "e"]) sessions.set(k, k);
    expect(sessions.size).toBe(3);
    expect(closed).toEqual(["a", "b"]);
    expect(sessions.get("a")).toBeUndefined();
    expect(sessions.get("e")).toBe("e");
  });

  test("drop and clear close everything they remove", () => {
    const closed: string[] = [];
    const sessions = new BeaconSessions<string>((v) => closed.push(v));
    sessions.set("a", "a");
    sessions.set("b", "b");
    sessions.drop("a");
    sessions.drop("missing"); // idempotent, closes nothing
    sessions.clear();
    expect(closed).toEqual(["a", "b"]);
    expect(sessions.size).toBe(0);
  });

  test("a close that throws does not escape", () => {
    const sessions = new BeaconSessions<string>(() => {
      throw new Error("socket already gone");
    });
    sessions.set("a", "a");
    expect(() => sessions.clear()).not.toThrow();
  });
});

/* ------------------------------ claim_page surfacing ------------------------------ */

describe("claim_page surfaces the beacon answer", () => {
  afterEach(async () => {
    // claimLease writes a real file per claim; leaving them behind would make a
    // later claim in this file collide with a lease held by this same live pid.
    for (const id of ["OPEN", "HUMAN", "AGENT", "QUIET", "NEW-1"]) {
      await releaseLeaseFor("chrome", id).catch(() => undefined);
    }
  });

  test("a takeover of a tab a human just used carries humanActiveMs AND contention", async () => {
    const now = Date.now();
    const { driver, beaconReads, beaconInstalls } = stubDriver({
      pages: [page("HUMAN")],
      beacon: { reads: { HUMAN: now - 2_000 } },
    });
    const res = (await claimPage(driver, { target: "HUMAN", label: "taker" })) as ClaimPageResult;
    expect(res.opened).toBe(false);
    expect(res.humanActiveMs).toBeGreaterThanOrEqual(2_000);
    expect(res.humanActiveMs).toBeLessThan(CONTENTION_WINDOW_MS);
    expect(res.contention).toContain("SUCCEEDED");
    // Read BEFORE the claim, installed AFTER it: both happened, exactly once.
    expect(beaconReads).toEqual(["HUMAN"]);
    expect(beaconInstalls).toEqual(["HUMAN"]);
  });

  test("THE CLAIM IS NOT REFUSED: contention still returns a working lease", async () => {
    const now = Date.now();
    const { driver } = stubDriver({ pages: [page("HUMAN")], beacon: { reads: { HUMAN: now } } });
    const res = (await claimPage(driver, { target: "HUMAN", label: "taker" })) as ClaimPageResult;
    expect(res.contention).toBeDefined();
    expect(typeof res.lease).toBe("string");
    expect(res.targetId).toBe("HUMAN");
    expect(leaseFile("chrome", "HUMAN")).toContain(artifactDir);
  });

  test("input this server dispatched reads as ours: no contention", async () => {
    const now = Date.now();
    recordDispatch("chrome", "AGENT", now - 100);
    const { driver } = stubDriver({ pages: [page("AGENT")], beacon: { reads: { AGENT: now } } });
    const res = (await claimPage(driver, { target: "AGENT", label: "taker" })) as ClaimPageResult;
    expect(res.humanActiveMs).toBe(null);
    expect(res.contention).toBeUndefined();
  });

  test("a human idle past the window is reported without a warning", async () => {
    const now = Date.now();
    const { driver } = stubDriver({
      pages: [page("QUIET")],
      beacon: { reads: { QUIET: now - (CONTENTION_WINDOW_MS + 5_000) } },
    });
    const res = (await claimPage(driver, { target: "QUIET", label: "taker" })) as ClaimPageResult;
    expect(res.humanActiveMs).toBeGreaterThan(CONTENTION_WINDOW_MS);
    expect(res.contention).toBeUndefined();
  });

  test("targetId mode is a takeover too, and reads the beacon", async () => {
    const now = Date.now();
    const { driver, beaconReads } = stubDriver({ pages: [page("HUMAN")], beacon: { reads: { HUMAN: now } } });
    const res = (await claimPage(driver, { targetId: "HUMAN", label: "taker" })) as ClaimPageResult;
    expect(res.opened).toBe(false);
    expect(res.contention).toBeDefined();
    expect(beaconReads).toEqual(["HUMAN"]);
  });

  test("opening a fresh tab installs the beacon but never reads one", async () => {
    const { driver, beaconReads, beaconInstalls } = stubDriver({ pages: [], beacon: {} });
    const res = (await claimPage(driver, { label: "opener" })) as ClaimPageResult;
    expect(res.opened).toBe(true);
    expect(res.humanActiveMs).toBe(null);
    expect(res.contention).toBeUndefined();
    // Asking a tab that did not exist a moment ago whether a person is in it
    // would be theatre; installing so it can answer LATER is the real work.
    expect(beaconReads).toEqual([]);
    expect(beaconInstalls).toEqual([res.targetId]);
  });

  test("a backend with no beacon omits the field entirely rather than nulling it", async () => {
    const { driver } = stubDriver({ pages: [page("HUMAN")] });
    const res = (await claimPage(driver, { target: "HUMAN", label: "taker" })) as ClaimPageResult;
    expect("humanActiveMs" in res).toBe(false);
    expect(res.contention).toBeUndefined();
    // Everything the tool promised before the beacon existed is unchanged.
    expect(res.targetId).toBe("HUMAN");
    expect(res.opened).toBe(false);
  });

  test("an install failure does not fail the claim", async () => {
    const { driver } = stubDriver({ pages: [page("HUMAN")], beacon: { installThrows: true } });
    const res = (await claimPage(driver, { target: "HUMAN", label: "taker" })) as ClaimPageResult;
    expect(typeof res.lease).toBe("string");
  });

  test("new_page{claim:true} installs the beacon on the tab it creates", async () => {
    const { driver, beaconInstalls } = stubDriver({ pages: [], beacon: {} });
    const created = (await newPage(driver, { claim: true, label: "maker" })) as { targetId: string };
    expect(beaconInstalls).toEqual([created.targetId]);
    await releaseLeaseFor("chrome", created.targetId);
  });
});

/* ------------------------------ list_leases surfacing ------------------------------ */

describe("list_leases annotates rows with human activity", () => {
  const ids = ["L1", "L2"];
  afterEach(async () => {
    for (const id of ids) await releaseLeaseFor("chrome", id).catch(() => undefined);
    await releaseLeaseFor("firefox", "FF1").catch(() => undefined);
  });

  test("a row whose tab a human just used carries humanActiveMs", async () => {
    const now = Date.now();
    await claimLease("chrome", "L1", { label: "a" });
    const { driver } = stubDriver({ pages: [page("L1")], beacon: { reads: { L1: now - 3_000 } } });
    const { leases } = await listLeasesTool(driver);
    const row = leases.find((l: LeaseRow) => l.targetId === "L1");
    expect(row?.humanActiveMs).toBeGreaterThanOrEqual(3_000);
  });

  test("a tab with no beacon data leaves the field ABSENT, not null", async () => {
    await claimLease("chrome", "L1", { label: "a" });
    const { driver } = stubDriver({ pages: [page("L1")], beacon: {} });
    const { leases } = await listLeasesTool(driver);
    const row = leases.find((l: LeaseRow) => l.targetId === "L1");
    expect(row).toBeDefined();
    expect("humanActiveMs" in (row as object)).toBe(false);
  });

  test("a read that throws leaves the field absent and the call successful", async () => {
    await claimLease("chrome", "L1", { label: "a" });
    await claimLease("chrome", "L2", { label: "b" });
    const { driver } = stubDriver({ pages: [page("L1"), page("L2")], beacon: { readThrows: true } });
    const { leases, count } = await listLeasesTool(driver);
    expect(count).toBe(leases.length);
    expect(leases.length).toBeGreaterThanOrEqual(2);
    for (const row of leases) expect("humanActiveMs" in (row as object)).toBe(false);
  });

  test("a lease whose tab is no longer open is never probed", async () => {
    await claimLease("chrome", "L1", { label: "a" });
    // The tab is gone from the browser: reading it would either error or, worse,
    // resolve onto whatever now holds that id.
    const { driver, beaconReads } = stubDriver({ pages: [], beacon: { reads: { L1: Date.now() } } });
    const { leases } = await listLeasesTool(driver);
    expect(leases.some((l: LeaseRow) => l.targetId === "L1")).toBe(true);
    expect(beaconReads).toEqual([]);
  });

  test("a row from the OTHER backend is never probed by this driver", async () => {
    await claimLease("firefox", "FF1", { label: "ff" });
    const { driver, beaconReads } = stubDriver({ pages: [], beacon: { reads: { FF1: Date.now() } } });
    const { leases } = await listLeasesTool(driver);
    expect(leases.some((l: LeaseRow) => l.targetId === "FF1")).toBe(true);
    expect(beaconReads).toEqual([]);
  });

  test("a backend with no beacon at all still lists leases unchanged", async () => {
    await claimLease("chrome", "L1", { label: "a" });
    const { driver } = stubDriver({ pages: [page("L1")] });
    const { leases, count } = await listLeasesTool(driver);
    expect(count).toBe(leases.length);
    const row = leases.find((l: LeaseRow) => l.targetId === "L1");
    expect(row?.label).toBe("a");
    expect("humanActiveMs" in (row as object)).toBe(false);
  });
});

/* --------------------------------- the manifest --------------------------------- */

describe("the manifest describes the new fields", () => {
  const spec = (name: string) => MANIFEST.find((s) => s.name === name)!;

  test("claim_page documents humanActiveMs, contention, and that it never refuses", () => {
    const d = spec("claim_page").description;
    expect(d).toContain("humanActiveMs");
    expect(d).toContain("contention");
    // The single most important sentence in the description: an agent that read
    // the warning as a refusal would stop doing the thing that just succeeded.
    expect(d).toContain("NEVER REFUSED");
  });

  test("claim_page states that null means no data, not no human", () => {
    const d = spec("claim_page").description;
    expect(d).toContain("never means 'no human'");
  });

  test("claim_page discloses the second-server and iframe blind spots", () => {
    const d = spec("claim_page").description;
    expect(d).toContain("cross-origin iframe");
    expect(d).toContain("second MCP server");
  });

  test("list_leases documents humanActiveMs and that absence is 'no answer'", () => {
    const d = spec("list_leases").description;
    expect(d).toContain("humanActiveMs");
    expect(d).toContain("never 'nobody is there'");
  });

  test("neither description gained an argument the schema does not have", () => {
    // The fields are on the RESULT, not the input: a schema that grew a
    // humanActiveMs property would be advertising an argument nobody accepts.
    for (const name of ["claim_page", "list_leases"]) {
      const props = Object.keys(spec(name).inputSchema.properties ?? {});
      expect(props).not.toContain("humanActiveMs");
      expect(props).not.toContain("contention");
    }
  });

  test("list_pages documents the split reap horizon, the lease field, and probe", () => {
    const d = spec("list_pages").description;
    expect(d).toContain("CDP_REAP_GRACE_MS");
    expect(d).toContain("'lease'");
    expect(d).toContain("idleMs");
    expect(d).toContain("expiresAt");
    expect(d).toContain("'responsive'");
  });

  test("list_pages advertises 'probe' as an input, and it defaults to false", () => {
    const props = spec("list_pages").inputSchema.properties as Record<string, { type?: string; description?: string }>;
    expect(props.probe?.type).toBe("boolean");
    expect(props.probe?.description).toContain("500ms");
  });

  test("list_leases documents the computed idleMs/expiresAt fields", () => {
    const d = spec("list_leases").description;
    expect(d).toContain("idleMs");
    expect(d).toContain("expiresAt");
  });
});
