// A background tab gets no trusted keyboard input (measured on Vivaldi): the
// trusted Input.insertText commit stays first, is verified, and an in-page
// commit runs only when it did not land. press_key reports a definite miss.
import { expect, test } from "bun:test";
import { insertTextVerified, pressKeyObserved, setValueOnObject } from "../src/cdp/driver.ts";
import { fill, fillForm, pressKey, typeText } from "../src/shared-tools.ts";
import type { BrowserDriver, PageDriver, TextInputPath } from "../src/driver.ts";

/** Fake page connection: answers the three in-page functions by which source they carry. */
function fakeConn(o: { landed: boolean; fallback?: string; probeThrows?: boolean }) {
  const calls: string[] = [];
  const conn = {
    calls,
    async send<T>(method: string, params?: Record<string, unknown>): Promise<T> {
      if (method !== "Runtime.callFunctionOn") { calls.push(method); return {} as T; }
      const fn = String(params?.functionDeclaration);
      if (fn.includes("__cdpSawInput=false")) { calls.push("snapshot"); return { result: { value: "" } } as T; }
      if (fn.includes("function(before)")) { calls.push("landed?"); return { result: { value: o.landed } } as T; }
      if (fn.includes("execCommand")) {
        calls.push(`fallback(${JSON.stringify((params?.arguments as Array<{ value: unknown }>)[0]?.value)})`);
        return { result: { value: o.fallback ?? "execCommand" } } as T;
      }
      calls.push("other");
      return {} as T;
    },
  };
  const sendInput = async (method: string, params: Record<string, unknown>) => { calls.push(`${method}:${String(params.text)}`); return {}; };
  return { conn, sendInput, calls };
}

test("trusted commit landed: no fallback runs", async () => {
  const f = fakeConn({ landed: true });
  expect(await insertTextVerified(f.conn as never, "OBJ", "hello", f.sendInput)).toBe("trusted");
  expect(f.calls).toEqual(["snapshot", "Input.insertText:hello", "landed?"]);
});

test("trusted commit did not land: the in-page fallback runs once, after it", async () => {
  const f = fakeConn({ landed: false, fallback: "execCommand" });
  expect(await insertTextVerified(f.conn as never, "OBJ", "hello", f.sendInput)).toBe("execCommand");
  expect(f.calls).toEqual(["snapshot", "Input.insertText:hello", "landed?", 'fallback("hello")']);
});

test("the setter and skipped outcomes pass through", async () => {
  for (const via of ["setter", "skipped"] as const) {
    const f = fakeConn({ landed: false, fallback: via });
    expect(await insertTextVerified(f.conn as never, "OBJ", "x", f.sendInput)).toBe(via);
  }
});

test("a fallback that changed nothing is an error, not a silent success", async () => {
  const f = fakeConn({ landed: false, fallback: "failed" });
  await expect(insertTextVerified(f.conn as never, "OBJ", "x", f.sendInput)).rejects.toThrow("text did not land");
});

function keyConn(seen: boolean | "throws" | "unarmed") {
  const calls: string[] = [];
  return {
    calls,
    async send<T>(_m: string, params?: Record<string, unknown>): Promise<T> {
      const expr = String(params?.expression);
      if (expr.includes("addEventListener('keydown'")) {
        calls.push("arm");
        if (seen === "unarmed") throw new Error("no renderer");
        return { result: { value: true } } as T;
      }
      calls.push("read");
      if (seen === "throws") throw new Error("navigated away");
      return { result: { value: seen } } as T;
    },
  };
}

test("press_key witness: arm, dispatch, read; a miss reports delivered:false", async () => {
  const c = keyConn(false);
  const res = await pressKeyObserved(c as never, async () => { c.calls.push("dispatch"); });
  expect(c.calls).toEqual(["arm", "dispatch", "read"]);
  expect(res).toEqual({ delivered: false });
});

test("press_key witness: seen is delivered:true; unknown reports nothing", async () => {
  expect(await pressKeyObserved(keyConn(true) as never, async () => {})).toEqual({ delivered: true });
  expect(await pressKeyObserved(keyConn("throws") as never, async () => {})).toBeUndefined();
  const unarmed = keyConn("unarmed");
  expect(await pressKeyObserved(unarmed as never, async () => {})).toBeUndefined();
  expect(unarmed.calls).toEqual(["arm"]);
});

/** Shared-tool layer: inputPath / delivered ride the result only off the trusted path. */
function pageDriver(path: void | TextInputPath, key?: { delivered: boolean }): BrowserDriver {
  const page = {
    async evaluate() { return { value: null }; },
    async setValue() { return path; },
    async typeText() { return path; },
    async pressKey() { return key; },
    release() {},
  } as unknown as PageDriver;
  return { scheme: "cdp", async page() { return page; } } as unknown as BrowserDriver;
}

test("fill / type_text: trusted keeps the old shape, a fallback adds inputPath", async () => {
  expect(await fill(pageDriver("trusted"), { selector: "#i", value: "v" })).not.toHaveProperty("inputPath");
  expect(await fill(pageDriver(undefined), { selector: "#i", value: "v" })).not.toHaveProperty("inputPath");
  expect((await fill(pageDriver("execCommand"), { selector: "#i", value: "v" })).inputPath).toBe("execCommand");
  expect((await typeText(pageDriver("setter"), { selector: "#i", text: "v" })).inputPath).toBe("setter");
});

test("fill_form lists inputPaths only when some field fell back", async () => {
  const fields = [{ selector: "#a", value: "1" }, { selector: "#b", value: "2" }];
  expect(await fillForm(pageDriver("trusted"), { fields })).not.toHaveProperty("inputPaths");
  expect((await fillForm(pageDriver("execCommand"), { fields })).inputPaths).toEqual(["execCommand", "execCommand"]);
});

test("press_key reports delivered:false with a note only on a definite miss", async () => {
  expect(await pressKey(pageDriver(undefined, { delivered: true }), { key: "Enter" })).toEqual({ pressed: "Enter", modifiers: [] });
  expect(await pressKey(pageDriver(undefined), { key: "Enter" })).toEqual({ pressed: "Enter", modifiers: [] });
  const miss = await pressKey(pageDriver(undefined, { delivered: false }), { key: "Enter" });
  expect(miss.delivered).toBe(false);
  expect(miss.note).toContain("background tab");
});

// fill / fill_form must never clear a field the user could not edit either.
function clearConn(state: "ok" | "readonly" | "disabled") {
  const calls: string[] = [];
  const conn = {
    calls,
    async send<T>(_m: string, params?: Record<string, unknown>): Promise<T> {
      const fn = String(params?.functionDeclaration);
      if (fn.includes("this.focus&&this.focus()")) { calls.push("focus"); return {} as T; }
      if (fn.includes("this.readOnly)return")) { calls.push("clear?"); return { result: { value: state } } as T; }
      if (fn.includes("__cdpSawInput=false")) { calls.push("snapshot"); return { result: { value: "" } } as T; }
      if (fn.includes("function(before)")) { calls.push("landed?"); return { result: { value: true } } as T; }
      calls.push("other");
      return {} as T;
    },
  };
  const sendInput = async (method: string) => { calls.push(method); return {}; };
  return { conn, sendInput, calls };
}

test("setValue refuses a readonly or disabled field before clearing it, and inserts nothing", async () => {
  for (const state of ["readonly", "disabled"] as const) {
    const c = clearConn(state);
    await expect(setValueOnObject(c.conn as never, "OBJ", "nope", c.sendInput)).rejects.toThrow(`cannot fill a ${state} field`);
    expect(c.calls).toEqual(["focus", "clear?"]);
  }
});

test("setValue on an editable field clears, then commits", async () => {
  const c = clearConn("ok");
  expect(await setValueOnObject(c.conn as never, "OBJ", "v", c.sendInput)).toBe("trusted");
  expect(c.calls).toEqual(["focus", "clear?", "snapshot", "Input.insertText", "landed?"]);
});
