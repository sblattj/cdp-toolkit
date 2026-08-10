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
import type { BrowserDriver, PageDriver, PageInfo } from "../src/driver.ts";
import { resolveScrollAnchor, resolveScrollDelta, scroll, click } from "../src/shared-tools.ts";
import { inputModifierBits } from "../src/cdp/driver.ts";
import { modifierBits, validateDispatchMouseArgs, dispatchMouse, type DispatchMouseArgs } from "../src/tools/dispatch-mouse.ts";
import { toolAvailability } from "../src/capabilities.ts";
import { MANIFEST } from "../src/manifest.ts";

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
