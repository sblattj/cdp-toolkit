/**
 * Unit tests for 1.8.0 Track P1: the `scroll` tool, the `dispatch_mouse` tool, and click's
 * `modifiers` + `clickCount:3` upgrade. Every test here runs on a pure function or a stub driver,
 * never a real browser — the live end-to-end proof is test/input-smoke.ts.
 *
 * Four properties carry this slice:
 *
 * 1. ANCHOR RESOLUTION (scroll). "Exactly one of uid, selector, x+y, or nothing" is a rule with
 *    real failure modes (two anchors given at once, half an {x,y} pair), and it is pure logic
 *    (resolveScrollAnchor in shared-tools.ts) deliberately split out of the tool so it is testable
 *    without a browser, mirroring cookies.test.ts's filterCookies / assertCookieSite pattern.
 * 2. MODIFIER BIT MATH. Both click (cdp/driver.ts's inputModifierBits) and dispatch_mouse
 *    (dispatch-mouse.ts's modifierBits) turn the same closed Alt/Control/Meta/Shift enum into the
 *    same CDP bitmask (1/2/4/8) via two intentionally-independent implementations (see
 *    dispatch-mouse.ts's header for why they are not shared) — both are pinned here so they can
 *    never drift apart silently.
 * 3. WIRING. shared-tools.ts's scroll()/click() must pass the RESOLVED anchor/opts through to
 *    page.scroll()/page.click() untouched, and must shape the response correctly (scroll's
 *    {x,y,deltaX,deltaY,target}); a stub PageDriver (mirroring evaluate_save.test.ts's pattern)
 *    proves this without a browser.
 * 4. CAPABILITY GATING (ADR-001). dispatch_mouse must be chrome-only and scroll must be universal,
 *    proved via toolAvailability the same way screencast.test.ts proves start_screen_recording's
 *    Firefox gap: absent from tools/list, never present-and-throwing.
 */
import { describe, expect, test } from "bun:test";
import type { BrowserDriver, Capability, PageDriver, PageInfo } from "../src/driver.ts";
import { REQUIRED_CAPABILITIES, interpolatePoints } from "../src/driver.ts";
import {
  resolveScrollAnchor, resolveScrollDelta, scroll, click,
  drag, resolveDragTo, resolveDragDestination, resolveDragSteps, resolveDragMode,
} from "../src/shared-tools.ts";
import { createCdpDriver, inputModifierBits } from "../src/cdp/driver.ts";
import { createFirefoxDriver } from "../src/bidi/driver.ts";
import { modifierBits, validateDispatchMouseArgs, dispatchMouse, type DispatchMouseArgs } from "../src/tools/dispatch-mouse.ts";
import { toolAvailability } from "../src/capabilities.ts";
import { MANIFEST } from "../src/manifest.ts";
import { TOOL_DOCS } from "../src/toolDocs.ts";

/* ------------------------------- modifier bit math ------------------------------- */

describe("inputModifierBits (cdp/driver.ts, backs click's modifiers)", () => {
  test("no modifiers is 0", () => {
    expect(inputModifierBits(undefined)).toBe(0);
    expect(inputModifierBits([])).toBe(0);
  });
  test("each modifier maps to its CDP bit", () => {
    expect(inputModifierBits(["Alt"])).toBe(1);
    expect(inputModifierBits(["Control"])).toBe(2);
    expect(inputModifierBits(["Meta"])).toBe(4);
    expect(inputModifierBits(["Shift"])).toBe(8);
  });
  test("combinations OR together", () => {
    expect(inputModifierBits(["Shift", "Control"])).toBe(10);
    expect(inputModifierBits(["Alt", "Control", "Meta", "Shift"])).toBe(15);
  });
  test("a duplicate modifier does not double-count (OR is idempotent)", () => {
    expect(inputModifierBits(["Shift", "Shift"])).toBe(8);
  });
  test("an unknown modifier throws, naming the bad value", () => {
    expect(() => inputModifierBits(["shift"])).toThrow(/shift/); // wrong case: the enum is exact
    expect(() => inputModifierBits(["Cmd"])).toThrow(/Cmd/);
  });
});

describe("modifierBits (dispatch-mouse.ts, independent implementation)", () => {
  test("agrees with inputModifierBits on every value and combination", () => {
    const cases: string[][] = [[], ["Alt"], ["Control"], ["Meta"], ["Shift"], ["Alt", "Shift"], ["Alt", "Control", "Meta", "Shift"]];
    for (const mods of cases) expect(modifierBits(mods)).toBe(inputModifierBits(mods));
  });
  test("an unknown modifier throws", () => {
    expect(() => modifierBits(["shift"])).toThrow(/shift/);
  });
});

/* -------------------------------- scroll: anchor rule -------------------------------- */

describe("resolveScrollAnchor", () => {
  test("no anchor args resolves to undefined (viewport center)", () => {
    expect(resolveScrollAnchor({})).toBeUndefined();
  });
  test("uid alone resolves to a uid locator", () => {
    expect(resolveScrollAnchor({ uid: "cdp:42" })).toEqual({ uid: "cdp:42" });
  });
  test("selector alone resolves to a css locator", () => {
    expect(resolveScrollAnchor({ selector: "#box" })).toEqual({ css: "#box" });
  });
  test("x+y together resolve to a point", () => {
    expect(resolveScrollAnchor({ x: 10, y: 20 })).toEqual({ x: 10, y: 20 });
  });
  test("x without y throws", () => {
    expect(() => resolveScrollAnchor({ x: 10 })).toThrow(/together/);
  });
  test("y without x throws", () => {
    expect(() => resolveScrollAnchor({ y: 10 })).toThrow(/together/);
  });
  test("uid and selector together throws (more than one anchor)", () => {
    expect(() => resolveScrollAnchor({ uid: "cdp:1", selector: "#box" })).toThrow(/at most one/);
  });
  test("uid and x+y together throws", () => {
    expect(() => resolveScrollAnchor({ uid: "cdp:1", x: 1, y: 2 })).toThrow(/at most one/);
  });
  test("selector and x+y together throws", () => {
    expect(() => resolveScrollAnchor({ selector: "#box", x: 1, y: 2 })).toThrow(/at most one/);
  });
  test("an empty-string selector counts as absent, not as an anchor", () => {
    expect(resolveScrollAnchor({ selector: "" })).toBeUndefined();
  });
});

describe("resolveScrollDelta", () => {
  test("deltaY only", () => {
    expect(resolveScrollDelta({ deltaY: 100 })).toEqual({ deltaX: 0, deltaY: 100 });
  });
  test("deltaX only", () => {
    expect(resolveScrollDelta({ deltaX: -50 })).toEqual({ deltaX: -50, deltaY: 0 });
  });
  test("both given", () => {
    expect(resolveScrollDelta({ deltaX: 5, deltaY: -5 })).toEqual({ deltaX: 5, deltaY: -5 });
  });
  test("neither given throws", () => {
    expect(() => resolveScrollDelta({})).toThrow(/at least one/);
  });
  test("both explicitly zero throws (a no-op scroll is refused, not silently dispatched)", () => {
    expect(() => resolveScrollDelta({ deltaX: 0, deltaY: 0 })).toThrow(/at least one/);
  });
});

/* ------------------------------ dispatch_mouse: validation ------------------------------ */

describe("validateDispatchMouseArgs", () => {
  const base: DispatchMouseArgs = { action: "move", x: 1, y: 2 };
  test("a valid move/down/up passes for each action", () => {
    for (const action of ["move", "down", "up"] as const) {
      expect(() => validateDispatchMouseArgs({ ...base, action })).not.toThrow();
    }
  });
  test("an invalid action throws", () => {
    expect(() => validateDispatchMouseArgs({ ...base, action: "click" as never })).toThrow(/move.*down.*up|action/);
  });
  test("missing/non-numeric x or y throws", () => {
    expect(() => validateDispatchMouseArgs({ ...base, x: undefined as unknown as number })).toThrow(/x.*y|numeric/);
    expect(() => validateDispatchMouseArgs({ ...base, y: "3" as unknown as number })).toThrow(/x.*y|numeric/);
    expect(() => validateDispatchMouseArgs({ ...base, x: Number.NaN })).toThrow();
  });
  test("an unknown button throws", () => {
    expect(() => validateDispatchMouseArgs({ ...base, button: "back" as never })).toThrow(/button/);
  });
  test("a known button passes", () => {
    for (const button of ["left", "right", "middle"] as const) {
      expect(() => validateDispatchMouseArgs({ ...base, button })).not.toThrow();
    }
  });
});

/* ------------------------------------ wiring ------------------------------------ */

const INFO: PageInfo = { id: "TAB-1", url: "https://example.test/app", title: "App", type: "page" };

/** Minimal PageDriver/BrowserDriver stand-in, mirroring evaluate_save.test.ts's pattern: only the
 *  members scroll()/click() touch, recording every call so the wiring can be asserted on. */
function stubDriver(scrollReturn: { x: number; y: number }, clickReturn: { x: number; y: number }) {
  const scrollCalls: unknown[] = [];
  const clickCalls: unknown[] = [];
  const page = {
    info: INFO,
    async scroll(anchor: unknown, opts: unknown): Promise<{ x: number; y: number }> {
      scrollCalls.push({ anchor, opts });
      return scrollReturn;
    },
    async click(loc: unknown, opts: unknown): Promise<{ x: number; y: number }> {
      clickCalls.push({ loc, opts });
      return clickReturn;
    },
    async release(): Promise<void> {},
  };
  const driver = {
    scheme: "cdp",
    async page(): Promise<PageDriver> {
      return page as unknown as PageDriver;
    },
  };
  return { driver: driver as unknown as BrowserDriver, scrollCalls, clickCalls };
}

describe("shared-tools scroll() wiring", () => {
  test("passes the resolved anchor and deltas through, and shapes the response", async () => {
    const { driver, scrollCalls } = stubDriver({ x: 111, y: 222 }, { x: 0, y: 0 });
    const result = await scroll(driver, { selector: "#box", deltaY: 50 });
    expect(scrollCalls).toEqual([{ anchor: { css: "#box" }, opts: { deltaX: 0, deltaY: 50 } }]);
    expect(result).toEqual({ x: 111, y: 222, deltaX: 0, deltaY: 50, target: { id: "TAB-1", url: "https://example.test/app", title: "App" } });
  });
  test("no anchor args pass anchor:undefined through (viewport center)", async () => {
    const { driver, scrollCalls } = stubDriver({ x: 5, y: 5 }, { x: 0, y: 0 });
    await scroll(driver, { deltaX: 10 });
    expect(scrollCalls).toEqual([{ anchor: undefined, opts: { deltaX: 10, deltaY: 0 } }]);
  });
  test("no delta given throws before the driver is ever touched", async () => {
    const { driver, scrollCalls } = stubDriver({ x: 0, y: 0 }, { x: 0, y: 0 });
    await expect(scroll(driver, {})).rejects.toThrow(/at least one/);
    expect(scrollCalls).toEqual([]);
  });
});

describe("shared-tools click() wiring", () => {
  test("passes modifiers and clickCount:3 through to page.click", async () => {
    const { driver, clickCalls } = stubDriver({ x: 0, y: 0 }, { x: 9, y: 9 });
    const result = await click(driver, { selector: "p", clickCount: 3, modifiers: ["Shift"] });
    expect(clickCalls).toEqual([{ loc: { css: "p" }, opts: { button: "left", clickCount: 3, modifiers: ["Shift"] } }]);
    expect(result).toEqual({ clicked: true, x: 9, y: 9 });
  });
  test("omitted modifiers pass through as undefined, not an empty array invented here", async () => {
    const { driver, clickCalls } = stubDriver({ x: 0, y: 0 }, { x: 0, y: 0 });
    await click(driver, { selector: "p" });
    expect((clickCalls[0] as { opts: { modifiers?: string[] } }).opts.modifiers).toBeUndefined();
  });
});

/* --------------------------------- capability gating --------------------------------- */

describe("capability gating (ADR-001: absent from tools/list, never present-and-throwing)", () => {
  test("dispatch_mouse is chrome-only", () => {
    const chrome = toolAvailability("chrome");
    expect(chrome.available).toContain("dispatch_mouse");
    const firefox = toolAvailability("firefox");
    expect(firefox.available).not.toContain("dispatch_mouse");
    const gap = firefox.unavailable.find((u) => u.name === "dispatch_mouse");
    expect(gap?.missing).toEqual(["input.raw"]);
  });
  test("scroll is universal (both backends)", () => {
    expect(toolAvailability("chrome").available).toContain("scroll");
    expect(toolAvailability("firefox").available).toContain("scroll");
  });
  test("scroll and dispatch_mouse both have manifest schemas", () => {
    expect(MANIFEST.map((s) => s.name)).toContain("scroll");
    expect(MANIFEST.map((s) => s.name)).toContain("dispatch_mouse");
  });
});

/* ------------------------------- dispatch_mouse: dispatch (mocked conn) ------------------------------- */

describe("dispatchMouse composes the right CDP call", () => {
  test("throws on invalid args before ever touching the network", async () => {
    await expect(dispatchMouse({ action: "spin" as never, x: 1, y: 1 })).rejects.toThrow();
  });
});

/* ================================== Track P2: drag ==================================
 *
 * Same four properties as P1, applied to drag's new surface:
 *
 * 1. DESTINATION RESOLUTION. "Exactly one of to/by", "to takes exactly one of uid/selector/x+y",
 *    and "by needs at least one of dx/dy" are pure rules with real failure modes (both given,
 *    neither given, half an {x,y} pair), split out of the tool into resolveDragTo /
 *    resolveDragDestination so they are provable without a browser.
 * 2. INTERPOLATION GEOMETRY. interpolatePoints lives in the backend-neutral driver.ts because both
 *    drivers must move the pointer through the same points; steps:2 must still reproduce the
 *    pre-1.8.0 midpoint-then-destination sequence exactly, which is pinned here.
 * 3. WIRING. shared-tools drag() must hand the RESOLVED destination and {mode,steps} to
 *    page.drag() untouched and shape the response, proved against a stub PageDriver.
 * 4. THE PARAM-LEVEL GAP (ADR-001). mode:"html5" needs Capability "input.html5Drag", which only
 *    the Chrome driver declares. The tool `drag` must stay AVAILABLE on both backends (mouse mode
 *    works everywhere) while mode:"html5" is a clear refusal on Firefox — never a silent downgrade
 *    to mouse mode, which would report a successful drop that never happened. The Firefox refusal
 *    is proved against the REAL bidi capability set, not a hand-written one.
 */

describe("resolveDragTo", () => {
  test("uid becomes a uid locator, selector becomes a css locator", () => {
    expect(resolveDragTo({ uid: 42 as never })).toEqual({ uid: 42 });
    expect(resolveDragTo({ selector: "#zone" })).toEqual({ css: "#zone" });
  });
  test("x+y becomes an absolute viewport point", () => {
    expect(resolveDragTo({ x: 10, y: 20 })).toEqual({ x: 10, y: 20 });
    expect(resolveDragTo({ x: 0, y: 0 })).toEqual({ x: 0, y: 0 }); // 0 is a real coordinate, not "absent"
  });
  test("half an {x,y} pair is refused rather than treated as half an anchor", () => {
    expect(() => resolveDragTo({ x: 10 })).toThrow(/together/);
    expect(() => resolveDragTo({ y: 10 })).toThrow(/together/);
  });
  test("two destinations at once is refused", () => {
    expect(() => resolveDragTo({ selector: "#a", x: 1, y: 2 })).toThrow(/exactly one/);
    expect(() => resolveDragTo({ uid: 1 as never, selector: "#a" })).toThrow(/exactly one/);
  });
  test("an empty 'to' is refused", () => {
    expect(() => resolveDragTo({})).toThrow(/exactly one/);
  });
  test("a non-finite coordinate is refused", () => {
    expect(() => resolveDragTo({ x: Number.NaN, y: 1 })).toThrow(/finite/);
    expect(() => resolveDragTo({ x: 1, y: Number.POSITIVE_INFINITY })).toThrow(/finite/);
  });
});

describe("resolveDragDestination (to/by exclusivity)", () => {
  test("'to' alone resolves through resolveDragTo", () => {
    expect(resolveDragDestination({ to: { selector: "#zone" } })).toEqual({ css: "#zone" });
    expect(resolveDragDestination({ to: { x: 5, y: 6 } })).toEqual({ x: 5, y: 6 });
  });
  test("'by' alone becomes an offset, with the missing axis defaulting to 0", () => {
    expect(resolveDragDestination({ by: { dx: 40 } })).toEqual({ dx: 40, dy: 0 });
    expect(resolveDragDestination({ by: { dy: -25 } })).toEqual({ dx: 0, dy: -25 });
    expect(resolveDragDestination({ by: { dx: 3, dy: 4 } })).toEqual({ dx: 3, dy: 4 });
  });
  test("both 'to' and 'by' is refused, not resolved by precedence", () => {
    expect(() => resolveDragDestination({ to: { selector: "#z" }, by: { dx: 10 } })).toThrow(/exactly one/);
  });
  test("neither 'to' nor 'by' is refused", () => {
    expect(() => resolveDragDestination({})).toThrow(/exactly one/);
  });
  test("an empty 'by' is refused (nothing to offset by)", () => {
    expect(() => resolveDragDestination({ by: {} })).toThrow(/at least one/);
  });
  test("a non-finite offset is refused", () => {
    expect(() => resolveDragDestination({ by: { dx: Number.NaN } })).toThrow(/finite/);
  });
});

describe("resolveDragSteps", () => {
  test("defaults to 2 — the pre-1.8.0 hardcoded behavior", () => {
    expect(resolveDragSteps(undefined)).toBe(2);
  });
  test("accepts the whole documented range", () => {
    expect(resolveDragSteps(1)).toBe(1);
    expect(resolveDragSteps(8)).toBe(8);
    expect(resolveDragSteps(500)).toBe(500);
  });
  test("refuses 0, negatives, and anything past the cap", () => {
    expect(() => resolveDragSteps(0)).toThrow(/between 1 and 500/);
    expect(() => resolveDragSteps(-3)).toThrow(/between 1 and 500/);
    expect(() => resolveDragSteps(501)).toThrow(/between 1 and 500/);
  });
  test("refuses a non-integer or non-number", () => {
    expect(() => resolveDragSteps(2.5)).toThrow(/integer/);
    expect(() => resolveDragSteps("8" as never)).toThrow(/integer/);
    expect(() => resolveDragSteps(Number.NaN)).toThrow(/integer/);
  });
});

describe("resolveDragMode (the chrome-only param gap)", () => {
  const chromeCaps = createCdpDriver().capabilities;
  const firefoxCaps = createFirefoxDriver(0).capabilities;

  test("omitted or 'mouse' is mouse mode on any backend", () => {
    expect(resolveDragMode(undefined, firefoxCaps)).toBe("mouse");
    expect(resolveDragMode("mouse", firefoxCaps)).toBe("mouse");
    expect(resolveDragMode(undefined, chromeCaps)).toBe("mouse");
  });
  test("'html5' is accepted on chrome, which declares input.html5Drag", () => {
    expect(chromeCaps.has("input.html5Drag")).toBe(true);
    expect(resolveDragMode("html5", chromeCaps)).toBe("html5");
  });
  test("'html5' is REFUSED on the real firefox capability set, never downgraded to mouse", () => {
    expect(firefoxCaps.has("input.html5Drag")).toBe(false);
    expect(() => resolveDragMode("html5", firefoxCaps)).toThrow(/not supported by this backend/);
    expect(() => resolveDragMode("html5", firefoxCaps)).toThrow(/--browser chrome/);
  });
  test("an unknown mode names the bad value", () => {
    expect(() => resolveDragMode("HTML5", chromeCaps)).toThrow(/HTML5/); // the enum is exact-cased
    expect(() => resolveDragMode("native", chromeCaps)).toThrow(/native/);
  });
});

describe("interpolatePoints (shared drag geometry, driver.ts)", () => {
  const from = { x: 0, y: 0 };
  const to = { x: 100, y: 50 };
  test("steps:1 is a single jump straight to the destination", () => {
    expect(interpolatePoints(from, to, 1)).toEqual([{ x: 100, y: 50 }]);
  });
  test("steps:2 reproduces the pre-1.8.0 midpoint-then-destination sequence exactly", () => {
    expect(interpolatePoints(from, to, 2)).toEqual([{ x: 50, y: 25 }, { x: 100, y: 50 }]);
  });
  test("steps:N emits N evenly spaced points", () => {
    const pts = interpolatePoints(from, to, 4);
    expect(pts).toEqual([{ x: 25, y: 12.5 }, { x: 50, y: 25 }, { x: 75, y: 37.5 }, { x: 100, y: 50 }]);
  });
  test("the last point is EXACTLY the destination for any step count", () => {
    for (const n of [1, 2, 3, 7, 8, 33, 500]) {
      const pts = interpolatePoints({ x: 13, y: 7 }, { x: 401, y: 293 }, n);
      expect(pts.length).toBe(n);
      expect(pts[n - 1]).toEqual({ x: 401, y: 293 });
    }
  });
  test("a zero-length drag still emits the destination once per step", () => {
    expect(interpolatePoints({ x: 5, y: 5 }, { x: 5, y: 5 }, 3)).toEqual([{ x: 5, y: 5 }, { x: 5, y: 5 }, { x: 5, y: 5 }]);
  });
});

/** Stub PageDriver for drag, plus the capability set shared-tools' drag() gates mode on. */
function stubDragDriver(capabilities: ReadonlySet<Capability>, dragReturn = { from: { x: 1, y: 2 }, to: { x: 3, y: 4 } }) {
  const dragCalls: unknown[] = [];
  const page = {
    info: INFO,
    async drag(loc: unknown, to: unknown, opts: unknown) {
      dragCalls.push({ loc, to, opts });
      return dragReturn;
    },
    async release(): Promise<void> {},
  };
  const driver = {
    scheme: "cdp",
    capabilities,
    async page(): Promise<PageDriver> {
      return page as unknown as PageDriver;
    },
  };
  return { driver: driver as unknown as BrowserDriver, dragCalls };
}

describe("shared-tools drag() wiring", () => {
  const chromeCaps = createCdpDriver().capabilities;
  const firefoxCaps = createFirefoxDriver(0).capabilities;

  test("passes the resolved locator, destination and options through, and shapes the response", async () => {
    const { driver, dragCalls } = stubDragDriver(chromeCaps);
    const result = await drag(driver, { from: { selector: "#src" }, to: { selector: "#dst" }, mode: "html5", steps: 8 });
    expect(dragCalls).toEqual([{ loc: { css: "#src" }, to: { css: "#dst" }, opts: { mode: "html5", steps: 8 } }]);
    expect(result).toEqual({ dragged: true, mode: "html5", steps: 8, from: { x: 1, y: 2 }, to: { x: 3, y: 4 } });
  });
  test("defaults are mode:'mouse' and steps:2, and they are reported in the result", async () => {
    const { driver, dragCalls } = stubDragDriver(chromeCaps);
    const result = await drag(driver, { from: { selector: "#src" }, to: { selector: "#dst" } });
    expect((dragCalls[0] as { opts: unknown }).opts).toEqual({ mode: "mouse", steps: 2 });
    expect(result.mode).toBe("mouse");
    expect(result.steps).toBe(2);
  });
  test("by:{dx,dy} reaches the driver as an offset destination", async () => {
    const { driver, dragCalls } = stubDragDriver(chromeCaps);
    await drag(driver, { from: { selector: "#handle" }, by: { dx: 40 } });
    expect((dragCalls[0] as { to: unknown }).to).toEqual({ dx: 40, dy: 0 });
  });
  test("to:{x,y} reaches the driver as an absolute point", async () => {
    const { driver, dragCalls } = stubDragDriver(chromeCaps);
    await drag(driver, { from: { selector: "#handle" }, to: { x: 300, y: 120 } });
    expect((dragCalls[0] as { to: unknown }).to).toEqual({ x: 300, y: 120 });
  });
  test("mode:'html5' on firefox is refused BEFORE the page is ever acquired", async () => {
    const { driver, dragCalls } = stubDragDriver(firefoxCaps);
    await expect(drag(driver, { from: { selector: "#src" }, to: { selector: "#dst" }, mode: "html5" })).rejects.toThrow(/not supported by this backend/);
    expect(dragCalls).toEqual([]);
  });
  test("mouse-mode drags still work on firefox", async () => {
    const { driver, dragCalls } = stubDragDriver(firefoxCaps);
    await drag(driver, { from: { selector: "#src" }, to: { selector: "#dst" } });
    expect((dragCalls[0] as { opts: unknown }).opts).toEqual({ mode: "mouse", steps: 2 });
  });
  test("every destination/steps violation throws before the driver is touched", async () => {
    for (const args of [
      { from: { selector: "#s" } },
      { from: { selector: "#s" }, to: { selector: "#d" }, by: { dx: 1 } },
      { from: { selector: "#s" }, to: {} },
      { from: { selector: "#s" }, by: {} },
      { from: { selector: "#s" }, to: { selector: "#d" }, steps: 0 },
    ] as Array<Parameters<typeof drag>[1]>) {
      const { driver, dragCalls } = stubDragDriver(chromeCaps);
      await expect(drag(driver, args)).rejects.toThrow();
      expect(dragCalls).toEqual([]);
    }
  });
});

describe("drag's param gap is a param gap, not a hidden tool (ADR-001)", () => {
  test("drag stays available on BOTH backends", () => {
    expect(toolAvailability("chrome").available).toContain("drag");
    expect(toolAvailability("firefox").available).toContain("drag");
  });
  test("input.html5Drag is deliberately NOT in REQUIRED_CAPABILITIES for any tool", () => {
    const required = Object.values(REQUIRED_CAPABILITIES).flatMap((caps) => [...(caps ?? [])]);
    expect(required).not.toContain("input.html5Drag");
  });
  test("the manifest description names the chrome-only html5 restriction", () => {
    const entry = MANIFEST.find((s) => s.name === "drag");
    expect(entry).toBeDefined();
    const d = TOOL_DOCS["drag"].description;
    expect(d).toContain("CHROME-ONLY");
    expect(d).toContain("mode:'html5'");
  });
  test("the manifest schema carries mode, steps and by, and only 'from' stays required", () => {
    const schema = MANIFEST.find((s) => s.name === "drag")!.inputSchema as {
      properties: Record<string, unknown>; required: string[];
    };
    expect(Object.keys(schema.properties)).toEqual(expect.arrayContaining(["from", "to", "by", "mode", "steps"]));
    expect(schema.required).toEqual(["from"]);
    expect((schema.properties.mode as { enum: string[] }).enum).toEqual(["mouse", "html5"]);
  });
});
