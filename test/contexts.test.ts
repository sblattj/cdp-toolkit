// Execution-context selection inside one target (issue #12). Pure half: the `context` grammar and
// pick rules (src/contexts.ts). Driver half: the real CdpBrowserDriver + shared tools against
// FakeCdpServer modelling the issue's failure case: a target whose chat input lives in a NESTED
// same-process frame whose execution context appears ~400ms AFTER Runtime.enable, next to an
// extension isolated world on the top frame.
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CdpBrowserDriver } from "../src/cdp/driver.ts";
import { createFirefoxDriver } from "../src/bidi/driver.ts";
import { toolAvailability } from "../src/capabilities.ts";
import {
  autoCandidates, ContextSelectorError, parseContextSelector, pickExecutionContext, resolveSettle, type ExecutionContextInfo,
} from "../src/contexts.ts";
import { withEndpointScope, type Endpoint } from "../src/endpoints.ts";
import { click, evaluateScript, fill, fillForm, hover, listContexts, takeSnapshot, typeText } from "../src/shared-tools.ts";
import { FakeCdpServer } from "./helpers/fake-cdp-server.ts";

/* ------------------------------------ pure: grammar ------------------------------------ */

describe("parseContextSelector", () => {
  test("numbers and id forms", () => {
    expect(parseContextSelector(7)).toEqual({ kind: "id", id: 7 });
    expect(parseContextSelector("7")).toEqual({ kind: "id", id: 7 });
    expect(parseContextSelector("id:12")).toEqual({ kind: "id", id: 12 });
  });
  test("frame/url/name/auto", () => {
    expect(parseContextSelector("frame:ABC")).toEqual({ kind: "frame", frameId: "ABC" });
    expect(parseContextSelector("url:/inner")).toEqual({ kind: "url", needle: "/inner" });
    expect(parseContextSelector("name:active-frame")).toEqual({ kind: "name", needle: "active-frame" });
    expect(parseContextSelector("auto")).toEqual({ kind: "auto" });
  });
  test("refuses empty needles, unknown prefixes, non-integers", () => {
    for (const bad of ["", "url:", "name:", "frame:", "id:x", "bogus:1", 1.5, null, {}]) {
      expect(() => parseContextSelector(bad)).toThrow(ContextSelectorError);
    }
  });
});

const C = (o: Partial<ExecutionContextInfo> & { id: number }): ExecutionContextInfo => ({ origin: "", name: "", isDefault: true, type: "default", ...o });
const LIST: ExecutionContextInfo[] = [
  C({ id: 1, frameId: "TOP", origin: "http://host", frameUrl: "http://host/webview", isMainFrame: true }),
  C({ id: 2, frameId: "TOP", origin: "chrome-extension://abc", name: "uBlock", isDefault: false, type: "isolated", isMainFrame: true }),
  C({ id: 3, frameId: "INNER", origin: "http://host", frameUrl: "http://host/inner", frameName: "active-frame", isMainFrame: false }),
  C({ id: 4, frameId: "INNER", origin: "chrome-extension://abc", name: "uBlock", isDefault: false, type: "isolated", isMainFrame: false }),
];

describe("pickExecutionContext", () => {
  test("url/name prefer the default world over an isolated one on the same frame", () => {
    expect(pickExecutionContext(LIST, { kind: "url", needle: "/inner" }).hit?.id).toBe(3);
    expect(pickExecutionContext(LIST, { kind: "name", needle: "active" }).hit?.id).toBe(3);
    expect(pickExecutionContext(LIST, { kind: "frame", frameId: "INNER" }).hit?.id).toBe(3);
  });
  test("an id is exact and can name an isolated world", () => {
    expect(pickExecutionContext(LIST, { kind: "id", id: 4 }).hit?.id).toBe(4);
  });
  test("only isolated worlds match: falls back to them", () => {
    expect(pickExecutionContext(LIST, { kind: "name", needle: "uBlock" }).error).toContain("more than one frame");
    expect(pickExecutionContext(LIST.slice(0, 3), { kind: "name", needle: "uBlock" }).hit?.id).toBe(2);
  });
  test("a substring matching two frames is an error naming both, never a guess", () => {
    const r = pickExecutionContext(LIST, { kind: "url", needle: "http://host" });
    expect(r.hit).toBeUndefined();
    expect(r.error).toContain("1 http://host/webview");
    expect(r.error).toContain("3 http://host/inner");
  });
  test("a miss lists the live contexts", () => {
    const r = pickExecutionContext(LIST, { kind: "id", id: 99 });
    expect(r.error).toContain("no execution context matches id 99");
    expect(r.error).toContain("3 http://host/inner");
  });
  test("auto tries the top frame first and never isolated worlds", () => {
    expect(autoCandidates(LIST).map((c) => c.id)).toEqual([1, 3]);
  });
});

describe("resolveSettle", () => {
  const saved = { q: process.env.CDP_CONTEXT_QUIET_MS, c: process.env.CDP_CONTEXT_CAP_MS };
  afterAll(() => {
    if (saved.q === undefined) delete process.env.CDP_CONTEXT_QUIET_MS; else process.env.CDP_CONTEXT_QUIET_MS = saved.q;
    if (saved.c === undefined) delete process.env.CDP_CONTEXT_CAP_MS; else process.env.CDP_CONTEXT_CAP_MS = saved.c;
  });
  test("defaults, env, per-call precedence", () => {
    delete process.env.CDP_CONTEXT_QUIET_MS;
    delete process.env.CDP_CONTEXT_CAP_MS;
    expect(resolveSettle()).toEqual({ quietMs: 500, capMs: 2000 });
    process.env.CDP_CONTEXT_QUIET_MS = "50";
    process.env.CDP_CONTEXT_CAP_MS = "900";
    expect(resolveSettle()).toEqual({ quietMs: 50, capMs: 900 });
    expect(resolveSettle({ quietMs: 10, capMs: 20 })).toEqual({ quietMs: 10, capMs: 20 });
    expect(() => resolveSettle({ quietMs: -1 })).toThrow("settleMs");
  });
});

/* ----------------------------- driver against a fake CDP target ----------------------------- */

// Well inside the 500ms default quiet window, so the settle cannot end before it on a slow runner.
const LATE_MS = 200;
const TOP_CTX = { id: 1, origin: "http://host", name: "", uniqueId: "u1", auxData: { isDefault: true, type: "default", frameId: "TOP" } };
const ISO_CTX = { id: 2, origin: "chrome-extension://abc", name: "uBlock", uniqueId: "u2", auxData: { isDefault: false, type: "isolated", frameId: "TOP" } };
const INNER_CTX = { id: 3, origin: "http://host", name: "", uniqueId: "u3", auxData: { isDefault: true, type: "default", frameId: "INNER" } };

/** Install the issue's failure case on `fake`: the input exists only in context 3, which appears late. */
function armNestedFrame(fake: FakeCdpServer): void {
  fake.handlers["Runtime.enable"] = (_p, { emit }) => {
    emit("Runtime.executionContextCreated", { context: TOP_CTX });
    emit("Runtime.executionContextCreated", { context: ISO_CTX });
    setTimeout(() => emit("Runtime.executionContextCreated", { context: INNER_CTX }), LATE_MS);
    return {};
  };
  fake.handlers["Page.getFrameTree"] = () => ({
    frameTree: {
      frame: { id: "TOP", url: "http://host/webview" },
      childFrames: [{ frame: { id: "INNER", url: "http://host/inner", name: "active-frame" } }],
    },
  });
  fake.handlers["Runtime.evaluate"] = (p: { expression: string; contextId?: number; returnByValue?: boolean }) => {
    const ctx = p.contextId ?? 1;
    const inInner = ctx === 3;
    if (p.expression === 'document.querySelector("#chat-input") !== null') return { result: { type: "boolean", value: inInner } };
    if (p.expression === 'document.querySelector("#chat-input")') {
      return inInner ? { result: { type: "object", objectId: "el-chat" } } : { result: { type: "object", subtype: "null", value: null } };
    }
    if (p.expression === "boom") {
      return ctx === 2 ? { result: { type: "object" }, exceptionDetails: { text: "Uncaught", exception: { description: "Error: isolated says no" } } } : { result: { type: "string", value: `ctx${ctx}` } };
    }
    if (p.expression === "globalThis") return { result: { type: "object", objectId: `global-${ctx}` } };
    return { result: { type: "string", value: `ctx${ctx}` } };
  };
  fake.handlers["Runtime.callFunctionOn"] = (p: { functionDeclaration: string; objectId: string }) => {
    if (p.functionDeclaration.includes("getBoundingClientRect")) {
      // Frame-local center; the frame itself sits at an offset in the root viewport.
      return { result: { type: "object", value: { x: 30, y: 93.5, nested: p.objectId === "el-chat" } } };
    }
    if (p.functionDeclaration.includes("this.disabled")) return { result: { type: "string", value: "ok" } };
    return { result: { type: "boolean", value: true } };
  };
  fake.handlers["DOM.getContentQuads"] = () => ({ quads: [[100, 190, 118, 190, 118, 218, 100, 218]] });
}

describe("execution contexts against FakeCdpServer (issue #12 failure case)", () => {
  const fake = new FakeCdpServer();
  let ep: Endpoint;
  let dir = "";
  const saved = { artifact: process.env.CDP_ARTIFACT_DIR, state: process.env.CDP_STATE_DIR, strict: process.env.CDP_REQUIRE_LEASE };
  const driver = new CdpBrowserDriver();
  const inEp = <T>(fn: () => Promise<T>) => withEndpointScope(ep, fn);
  const sent = (method: string) => fake.messagesFor("PAGE1").filter((m) => m.method === method);

  beforeAll(async () => {
    await fake.start();
    ep = { name: "ctxtest", base: fake.base, readOnly: false };
    dir = await mkdtemp(join(tmpdir(), "cdp-contexts-"));
    process.env.CDP_ARTIFACT_DIR = join(dir, "artifacts");
    process.env.CDP_STATE_DIR = join(dir, "state");
    delete process.env.CDP_REQUIRE_LEASE;
  });
  beforeEach(() => {
    fake.reset();
    armNestedFrame(fake);
  });
  afterAll(async () => {
    await fake.stop();
    await rm(dir, { recursive: true, force: true });
    for (const [k, v] of [["CDP_ARTIFACT_DIR", saved.artifact], ["CDP_STATE_DIR", saved.state], ["CDP_REQUIRE_LEASE", saved.strict]] as const) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  });

  test("CONTROL (the bug): without context, fill finds nothing in the top document", async () => {
    await expect(inEp(() => fill(driver, { selector: "#chat-input", value: "hi" }))).rejects.toThrow("css '#chat-input' matched no element");
  });

  test("fill {context:'auto'} waits for the late frame and fills the nested input", async () => {
    const t0 = Date.now();
    const r = await inEp(() => fill(driver, { selector: "#chat-input", value: "hi", context: "auto" }));
    expect(Date.now() - t0).toBeGreaterThanOrEqual(LATE_MS - 50);
    expect(r).toMatchObject({ filled: true, value: "hi", context: { id: 3, frameId: "INNER", frameUrl: "http://host/inner" } });
    // The locate ran in context 3, and the text was committed.
    expect(sent("Runtime.evaluate").some((m) => (m.params as { contextId?: number }).contextId === 3 && (m.params as { expression: string }).expression === 'document.querySelector("#chat-input")')).toBe(true);
    expect(sent("Input.insertText").map((m) => (m.params as { text: string }).text)).toEqual(["hi"]);
  });

  test("fill {context:'name:active-frame'} waits for that context by name", async () => {
    const r = await inEp(() => fill(driver, { selector: "#chat-input", value: "x", context: "name:active-frame" }));
    expect(r.context?.id).toBe(3);
  });

  test("auto gives up at the cap with a message naming the searched frames", async () => {
    fake.handlers["Runtime.enable"] = (_p, { emit }) => {
      emit("Runtime.executionContextCreated", { context: TOP_CTX });
      return {};
    };
    const t0 = Date.now();
    await expect(inEp(() => fill(driver, { selector: "#chat-input", value: "x", context: "auto", settleCapMs: 250 }))).rejects.toThrow(
      /matched no element in any frame of this target within 250ms \(searched 1 frame context\(s\): 1 http:\/\/host\/webview/,
    );
    expect(Date.now() - t0).toBeLessThan(2000);
  });

  test("click in a nested frame uses root-relative quads, not the frame-local rect", async () => {
    const r = await inEp(() => click(driver, { selector: "#chat-input", context: "auto" }));
    expect(r).toMatchObject({ clicked: true, x: 109, y: 204, context: { id: 3 } });
    const press = sent("Input.dispatchMouseEvent").find((m) => (m.params as { type: string }).type === "mousePressed");
    expect(press?.params).toMatchObject({ x: 109, y: 204 });
  });

  test("hover, type_text and fill_form take context too", async () => {
    const h = await inEp(() => hover(driver, { selector: "#chat-input", context: "auto" }));
    expect(h).toMatchObject({ hovered: true, x: 109, y: 204, context: { id: 3 } });
    expect(sent("Input.dispatchMouseEvent").at(-1)?.params).toMatchObject({ type: "mouseMoved", x: 109, y: 204 });

    const t = await inEp(() => typeText(driver, { selector: "#chat-input", text: "typed", context: "url:/inner" }));
    expect(t).toMatchObject({ typed: true, text: "typed", context: { id: 3 } });

    // One context for the whole form; 'auto' matches on the FIRST field's selector.
    const f = await inEp(() => fillForm(driver, { fields: [{ selector: "#chat-input", value: "a" }, { selector: "#chat-input", value: "b" }], context: "auto" }));
    expect(f).toMatchObject({ filled: 2, context: { id: 3 } });
    expect(sent("Input.insertText").map((m) => (m.params as { text: string }).text)).toEqual(["typed", "a", "b"]);
    // A first field without a selector gives 'auto' nothing to match: refused, not guessed.
    await expect(inEp(() => fillForm(driver, { fields: [{ uid: "1", value: "a" }], context: "auto" }))).rejects.toThrow("needs one");
  });

  test("evaluate_script {allContexts:true} reports every context, the late one included, errors as data", async () => {
    const rows = (await inEp(() => evaluateScript(driver, { expression: "boom", allContexts: true }))) as Array<Record<string, unknown>>;
    expect(rows.map((r) => r.contextId)).toEqual([1, 2, 3]);
    expect(rows[2]).toMatchObject({ contextId: 3, frameId: "INNER", isDefault: true, frameUrl: "http://host/inner", frameName: "active-frame", value: "ctx3" });
    expect(rows[1]!.error).toContain("isolated says no");
    expect(rows[1]!.value).toBeUndefined();
  });

  test("allContexts finds which frame holds the selector", async () => {
    const rows = (await inEp(() => evaluateScript(driver, { expression: 'document.querySelector("#chat-input") !== null', allContexts: true }))) as Array<{ contextId: number; value: unknown }>;
    expect(rows.filter((r) => r.value === true).map((r) => r.contextId)).toEqual([3]);
  });

  test("allContexts + savePath writes the rows and returns no value", async () => {
    const r = (await inEp(() => evaluateScript(driver, { expression: "x", allContexts: true, savePath: join(dir, "rows.json") }))) as Record<string, unknown>;
    expect(r.type).toBe("object");
    expect(JSON.stringify(r)).not.toContain("ctx3");
    expect(JSON.parse(await readFile(join(dir, "rows.json"), "utf8")).length).toBe(3);
  });

  test("evaluate_script {context} returns the raw value from that context", async () => {
    expect(await inEp(() => evaluateScript(driver, { expression: "x", context: "url:/inner" }))).toBe("ctx3");
    expect(await inEp(() => evaluateScript(driver, { expression: "x", context: 3 }))).toBe("ctx3");
    // The args/function form resolves globalThis in the pinned context too.
    await inEp(() => evaluateScript(driver, { expression: "(a) => a", args: [1], context: 3 }));
    expect(sent("Runtime.evaluate").some((m) => (m.params as { expression: string; contextId?: number }).expression === "globalThis" && (m.params as { contextId?: number }).contextId === 3)).toBe(true);
    // Without context: unchanged, no contextId on the wire.
    fake.reset();
    armNestedFrame(fake);
    expect(await inEp(() => evaluateScript(driver, { expression: "x" }))).toBe("ctx1");
    expect(sent("Runtime.evaluate").every((m) => (m.params as { contextId?: number }).contextId === undefined)).toBe(true);
    // Exactly the one Runtime.enable evaluate always sent, and no context-tracking extras.
    expect(sent("Runtime.enable").length).toBe(1);
    expect(sent("Page.getFrameTree").length).toBe(0);
  });

  test("evaluate_script refuses auto, context+allContexts, and an ambiguous substring", async () => {
    await expect(inEp(() => evaluateScript(driver, { expression: "x", context: "auto" }))).rejects.toThrow("allContexts:true");
    await expect(inEp(() => evaluateScript(driver, { expression: "x", context: 3, allContexts: true }))).rejects.toThrow("not both");
    // All three contexts present at enable: a named pick returns as soon as it resolves, so the
    // ambiguity is only visible once both frames exist.
    fake.handlers["Runtime.enable"] = (_p, { emit }) => {
      for (const context of [TOP_CTX, ISO_CTX, INNER_CTX]) emit("Runtime.executionContextCreated", { context });
      return {};
    };
    await expect(inEp(() => evaluateScript(driver, { expression: "x", context: "url:http://host" }))).rejects.toThrow("matches more than one frame");
    await expect(inEp(() => evaluateScript(driver, { expression: "x", context: "url:" }))).rejects.toThrow("needs a value");
  });

  test("list_contexts waits out the late context and enriches from the frame tree", async () => {
    const r = await inEp(() => listContexts(driver, {}));
    expect(r.count).toBe(3);
    expect(r.contexts[2]).toEqual({
      id: 3, uniqueId: "u3", frameId: "INNER", origin: "http://host", name: "", isDefault: true, type: "default",
      isMainFrame: false, frameUrl: "http://host/inner", frameName: "active-frame",
    });
    expect(r.contexts[0]!.isMainFrame).toBe(true);
    // A settle shorter than the late context's delay returns without it: the knob is real.
    const quick = await inEp(() => listContexts(driver, { settleMs: 20, settleCapMs: 60 }));
    expect(quick.contexts.map((c) => c.id)).toEqual([1, 2]);
  });

  test("take_snapshot {context} asks for that frame's own AX tree", async () => {
    const r = await inEp(() => takeSnapshot(driver, { context: "name:active-frame" }));
    expect(r.context?.frameId).toBe("INNER");
    expect(sent("Accessibility.getFullAXTree").map((m) => m.params)).toEqual([{ frameId: "INNER" }]);
    fake.reset();
    armNestedFrame(fake);
    await inEp(() => takeSnapshot(driver, {}));
    expect(sent("Accessibility.getFullAXTree").map((m) => (m.params as Record<string, unknown> | undefined)?.frameId)).toEqual([undefined]);
    await expect(inEp(() => takeSnapshot(driver, { context: "auto" }))).rejects.toThrow("needs one");
  });

  test("a context that never appears fails with the live list after the cap", async () => {
    await expect(inEp(() => fill(driver, { selector: "#chat-input", value: "x", context: 42, settleCapMs: 100 }))).rejects.toThrow(
      /no execution context matches id 42 in this target \(live contexts: 1 http:\/\/host\/webview/,
    );
  });

  test("the real Firefox driver refuses every context param before touching a browser", async () => {
    // Port 0: nothing listens. A refusal that came after a connect attempt would be a connection
    // error, not this message, so the message itself proves the gate runs first.
    const ff = createFirefoxDriver(0);
    expect(ff.capabilities.has("runtime.contexts")).toBe(false);
    const chromeOnly = "Chrome-only (Capability 'runtime.contexts')";
    await expect(fill(ff, { selector: "#a", value: "x", context: 3 })).rejects.toThrow(chromeOnly);
    await expect(click(ff, { selector: "#a", context: "auto" })).rejects.toThrow(chromeOnly);
    await expect(takeSnapshot(ff, { context: "name:x" })).rejects.toThrow(chromeOnly);
    await expect(evaluateScript(ff, { expression: "x", allContexts: true })).rejects.toThrow(chromeOnly);
    await expect(evaluateScript(ff, { expression: "x", context: 1 })).rejects.toThrow(chromeOnly);
    await expect(listContexts(ff, {})).rejects.toThrow(chromeOnly);
  });

  test("list_contexts is listed for chrome and absent for firefox", () => {
    expect(toolAvailability("chrome").available).toContain("list_contexts");
    expect(toolAvailability("firefox").unavailable).toContainEqual({ name: "list_contexts", missing: ["runtime.contexts"] });
  });
});
