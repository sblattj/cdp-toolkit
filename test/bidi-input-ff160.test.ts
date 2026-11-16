/**
 * Firefox 160 input parity: modifier clicks, dispatch_mouse (capability "input.raw"), and the
 * recorded finding on real HTML5 drag ("input.html5Drag" stays undeclared).
 *
 * Two layers. The stub layer needs no browser and pins the version gate (a Firefox that reports
 * browserVersion "153.0" gets "unsupported" and nothing is sent) and the exact performActions shape
 * (the tick-aligned key + pointer sources measured on 160). The live layer launches a THROWAWAY
 * headless Firefox (never a fixed debug port) and checks what the PAGE observed.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { launchFirefox, type LaunchedFirefox } from "../src/bidi/launch.ts";
import { BidiPageDriver, createFirefoxDriver, BIDI_CAPABILITY_MIN_FIREFOX } from "../src/bidi/driver.ts";
import { dispatchMouse } from "../src/bidi-tools.ts";
import { FIREFOX_TOOLS } from "../src/firefox-tools.ts";
import { resolveDragMode } from "../src/shared-tools.ts";
import { toolAvailability } from "../src/capabilities.ts";
import type { BrowserDriver, PageInfo } from "../src/driver.ts";

/* ------------------------------------ stub layer ------------------------------------ */

function stubPage(browserVersion: string) {
  const sent: Array<{ method: string; params: any }> = [];
  const conn = {
    capabilities: { browserVersion },
    send: async (method: string, params: unknown) => {
      sent.push({ method, params });
      return {};
    },
  };
  const info = { id: "ctx1", url: "about:blank", title: "" } as unknown as PageInfo;
  const page = new BidiPageDriver(conn as never, "ctx1", info, {} as BrowserDriver);
  return { page, sent };
}

describe("version gate: an older Firefox is refused with 'unsupported', before anything is sent", () => {
  test("dispatchMouse on a 153.0 stub", async () => {
    const { page, sent } = stubPage("153.0");
    await expect(page.dispatchMouse({ action: "down", x: 1, y: 2 })).rejects.toMatchObject({ code: "unsupported" });
    await expect(page.dispatchMouse({ action: "down", x: 1, y: 2 })).rejects.toThrow(/input\.raw needs Firefox 160 or newer; this Firefox is 153\.0/);
    expect(sent).toEqual([]);
  });
  test("click with modifiers on a 153.0 stub", async () => {
    const { page, sent } = stubPage("153.0");
    await expect(page.click({ css: "#b" }, { modifiers: ["Shift"] })).rejects.toMatchObject({ code: "unsupported" });
    await expect(page.click({ css: "#b" }, { modifiers: ["Shift"] })).rejects.toThrow(/input\.modifierClick needs Firefox 160/);
    expect(sent).toEqual([]);
  });
  test("CONTROL: the same call on a 160.0 stub is accepted and sends input.performActions", async () => {
    const { page, sent } = stubPage("160.0");
    await page.dispatchMouse({ action: "down", x: 1, y: 2 });
    expect(sent.map((s) => s.method)).toEqual(["input.performActions"]);
  });
});

describe("performActions shape", () => {
  test("dispatchMouse 'down' with no modifiers: one pointer source on the stable raw id", async () => {
    const { page, sent } = stubPage("160.0");
    await page.dispatchMouse({ action: "down", x: 10, y: 20, button: "right" });
    expect(sent[0]!.params.actions).toEqual([
      { type: "pointer", id: "cdp-raw-mouse", actions: [{ type: "pointerMove", x: 10, y: 20, duration: 0 }, { type: "pointerDown", button: 2 }] },
    ]);
  });
  test("dispatchMouse 'up' with Shift: key source tick-aligned with the pointer source", async () => {
    const { page, sent } = stubPage("160.0");
    await page.dispatchMouse({ action: "up", x: 5, y: 6, modifiers: ["Shift"] });
    const [key, pointer] = sent[0]!.params.actions;
    expect(key).toEqual({ type: "key", id: "cdp-keyboard", actions: [{ type: "keyDown", value: "" }, { type: "pause" }, { type: "pause" }, { type: "keyUp", value: "" }] });
    expect(pointer.id).toBe("cdp-raw-mouse");
    expect(pointer.actions).toEqual([{ type: "pause" }, { type: "pointerMove", x: 5, y: 6, duration: 0 }, { type: "pointerUp", button: 0 }, { type: "pause" }]);
    expect(key.actions.length).toBe(pointer.actions.length);
  });
  test("an unknown modifier is refused, not skipped", async () => {
    const { page, sent } = stubPage("160.0");
    await expect(page.dispatchMouse({ action: "move", x: 1, y: 1, modifiers: ["Hyper"] })).rejects.toThrow(/unknown modifier 'Hyper'/);
    expect(sent).toEqual([]);
  });
});

describe("registry and capabilities", () => {
  test("Firefox declares input.raw and input.modifierClick at 160, lists dispatch_mouse, and routes it", () => {
    const caps = createFirefoxDriver(0).capabilities;
    expect(caps.has("input.raw")).toBe(true);
    expect(caps.has("input.modifierClick")).toBe(true);
    expect(BIDI_CAPABILITY_MIN_FIREFOX["input.raw"]).toBe(160);
    expect(toolAvailability("firefox").available).toContain("dispatch_mouse");
    expect((FIREFOX_TOOLS as Record<string, unknown>).dispatch_mouse).toBe(dispatchMouse);
  });
  test("the Firefox handler reuses Chrome's argument validation", async () => {
    const driver = {} as BrowserDriver;
    await expect(dispatchMouse(driver, { action: "spin" as never, x: 1, y: 1 })).rejects.toThrow(/requires \{ action \}/);
    await expect(dispatchMouse(driver, { action: "move", x: "a" as never, y: 1 })).rejects.toThrow(/numeric/);
    await expect(dispatchMouse(driver, { action: "move", x: 1, y: 1, button: "side" as never })).rejects.toThrow(/unknown button/);
    await expect(dispatchMouse(driver, { action: "move", x: 1, y: 1, modifiers: ["Hyper"] })).rejects.toThrow(/unknown modifier/);
  });
  test("input.html5Drag is NOT declared on Firefox: drag mode:'html5' is still refused", () => {
    const caps = createFirefoxDriver(0).capabilities;
    expect(caps.has("input.html5Drag")).toBe(false);
    expect(() => resolveDragMode("html5", caps)).toThrow(/not supported by this backend/);
  });
});

/* ------------------------------------ live layer ------------------------------------ */

const HAVE_FIREFOX = Boolean(process.env.FIREFOX_BIN) || existsSync("/Applications/Firefox.app/Contents/MacOS/firefox");
const live = HAVE_FIREFOX ? describe : describe.skip;

const PAGE = `<!doctype html><body style="margin:0">
<button id=b style="position:absolute;left:20px;top:20px;width:120px;height:40px">b</button>
<div id=pad style="position:absolute;left:20px;top:100px;width:200px;height:100px;background:#ddd"></div>
<div id=src draggable=true style="position:absolute;left:20px;top:240px;width:80px;height:60px;background:#fa0">s</div>
<div id=dst style="position:absolute;left:260px;top:240px;width:120px;height:80px;background:#0af">d</div>
<script>
window.C=[]; window.M=[]; window.D=[];
const fl=e=>({shift:e.shiftKey,ctrl:e.ctrlKey,meta:e.metaKey,alt:e.altKey});
window.DOWN=[]; window.CTX=[];
document.getElementById('b').addEventListener('click',e=>C.push(fl(e)));
document.getElementById('b').addEventListener('mousedown',e=>DOWN.push(fl(e)));
document.getElementById('b').addEventListener('contextmenu',e=>{CTX.push(fl(e));e.preventDefault();});
for (const t of ['mousedown','mouseup','click']) document.getElementById('pad').addEventListener(t,e=>M.push(t));
for (const t of ['dragstart','dragenter','dragover','drop','dragend']) document.addEventListener(t,e=>{ if(t==='dragover'||t==='dragenter') e.preventDefault(); if(t==='dragstart') e.dataTransfer.setData('text/plain','x'); if(D[D.length-1]!==t) D.push(t); },true);
</script></body>`;

live("real Firefox 160", () => {
  let ff: LaunchedFirefox;
  let srv: ReturnType<typeof Bun.serve>;
  let driver: BrowserDriver;
  let version = "";

  beforeAll(async () => {
    srv = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response(PAGE, { headers: { "content-type": "text/html" } }) });
    ff = await launchFirefox({ headless: true });
    driver = createFirefoxDriver(ff.port);
    const page = await driver.page(undefined);
    await page.navigate({ url: `http://127.0.0.1:${srv.port}/` });
    version = String(await page.evaluate("navigator.userAgent"));
    await page.release();
  }, 60_000);
  afterAll(async () => {
    try {
      await ff?.close();
    } finally {
      srv?.stop(true);
    }
  });

  async function evalPage<T>(expr: string): Promise<T> {
    const page = await driver.page(undefined);
    try {
      return (await page.evaluate(expr)) as T;
    } finally {
      await page.release();
    }
  }
  /** The flags the page saw on the press (mousedown, which fires for every click), plus the click
   *  events seen. A Control+click on macOS is a context-menu gesture: Firefox fires mousedown and
   *  contextmenu but no click, so mousedown is the event every modifier has in common. */
  async function clickWith(modifiers?: string[]): Promise<Record<string, boolean>[]> {
    await evalPage("window.C.length = 0; window.DOWN.length = 0; window.CTX.length = 0");
    const page = await driver.page(undefined);
    try {
      await page.click({ css: "#b" }, { modifiers });
    } finally {
      await page.release();
    }
    const down = await evalPage<Record<string, boolean>[]>("window.DOWN.slice()");
    const clicks = await evalPage<Record<string, boolean>[]>("window.C.slice()");
    const ctx = await evalPage<Record<string, boolean>[]>("window.CTX.slice()");
    console.log(`click ${JSON.stringify(modifiers ?? [])}: mousedown=${JSON.stringify(down)} click=${JSON.stringify(clicks)} contextmenu=${JSON.stringify(ctx)}`);
    // Every click must reach the page as exactly one mousedown; any click event must agree with it.
    expect(down.length).toBe(1);
    for (const c of clicks) expect(c).toEqual(down[0]!);
    return down;
  }

  test("runs on Firefox 160 or newer", () => {
    const major = Number(/Firefox\/(\d+)/.exec(version)?.[1]);
    expect(major).toBeGreaterThanOrEqual(160);
  });

  test("CONTROL: a click without modifiers shows every flag false", async () => {
    expect(await clickWith()).toEqual([{ shift: false, ctrl: false, meta: false, alt: false }]);
  });
  for (const [name, flag] of [["Shift", "shift"], ["Alt", "alt"], ["Meta", "meta"], ["Control", "ctrl"]] as const) {
    test(`${name}+click is seen by the page with only ${flag} set`, async () => {
      const seen = await clickWith([name]);
      expect(seen).toEqual([{ shift: flag === "shift", ctrl: flag === "ctrl", meta: flag === "meta", alt: flag === "alt" }]);
    });
  }
  test("Shift+Control chord sets both flags, and a following plain click shows none (modifiers released)", async () => {
    expect(await clickWith(["Shift", "Control"])).toEqual([{ shift: true, ctrl: true, meta: false, alt: false }]);
    expect(await clickWith()).toEqual([{ shift: false, ctrl: false, meta: false, alt: false }]);
  });

  test("dispatch_mouse: 'down' in one tool call, 'up' in a later call on a fresh driver instance, yields a page click", async () => {
    await evalPage("window.M.length = 0");
    const first = await dispatchMouse(driver, { action: "down", x: 60, y: 140 });
    expect(first).toEqual({ dispatched: "down", x: 60, y: 140 });
    // Mid-press: the page has seen mousedown only (no mouseup, no click yet).
    expect(await evalPage<string[]>("window.M.slice()")).toEqual(["mousedown"]);
    const second = createFirefoxDriver(ff.port); // a separate driver instance, same BiDi session via the mux
    const result = await dispatchMouse(second, { action: "up", x: 60, y: 140 });
    expect(result).toEqual({ dispatched: "up", x: 60, y: 140 });
    expect(await evalPage<string[]>("window.M.slice()")).toEqual(["mousedown", "mouseup", "click"]);
  }, 30_000);

  test("dispatch_mouse with Shift on 'down' and 'up' is seen as shiftKey by the page", async () => {
    await evalPage("window.__f = []; document.getElementById('pad').addEventListener('mousedown', e => window.__f.push(['down', e.shiftKey])); document.getElementById('pad').addEventListener('mouseup', e => window.__f.push(['up', e.shiftKey]));");
    await dispatchMouse(driver, { action: "down", x: 70, y: 150, modifiers: ["Shift"] });
    await dispatchMouse(driver, { action: "up", x: 70, y: 150, modifiers: ["Shift"] });
    expect(await evalPage("JSON.stringify(window.__f)")).toBe('[["down",true],["up",true]]');
  }, 30_000);

  test("html5 drag (measured on 160.0): the drag session starts but never completes, so 'input.html5Drag' stays undeclared", async () => {
    await evalPage("window.D.length = 0");
    await dispatchMouse(driver, { action: "move", x: 60, y: 270 });
    await dispatchMouse(driver, { action: "down", x: 60, y: 270 });
    for (const x of [90, 160, 300]) await dispatchMouse(driver, { action: "move", x, y: 280 });
    await dispatchMouse(driver, { action: "up", x: 300, y: 280 });
    await Bun.sleep(1000);
    const seen = await evalPage<string[]>("window.D.slice()");
    console.log(`html5 drag events seen on ${version}: ${JSON.stringify(seen)}`);
    // The evidence: dragstart and dragenter/dragover arrive, but no drop and no dragend.
    expect(seen).toContain("dragstart");
    expect(seen).not.toContain("drop");
    expect(seen).not.toContain("dragend");
    expect(createFirefoxDriver(0).capabilities.has("input.html5Drag")).toBe(false);
  }, 30_000);
});
