// Keyboard input (fill / fill_form / type_text / press_key) must land on a
// background tab without raising it: withInputFocus turns focus emulation on
// around the input only when the page reports no focus, and restores it.
import { expect, test } from "bun:test";
import { withInputFocus } from "../src/cdp/driver.ts";

function fakeConn(hasFocus: boolean | "throws") {
  const calls: string[] = [];
  return {
    calls,
    async send<T>(method: string, params?: Record<string, unknown>): Promise<T> {
      if (method === "Runtime.evaluate") {
        calls.push("probe");
        if (hasFocus === "throws") throw new Error("renderer gone");
        return { result: { value: hasFocus } } as T;
      }
      calls.push(method === "Emulation.setFocusEmulationEnabled" ? `emulation:${String(params?.enabled)}` : method);
      return {} as T;
    },
  };
}

const insert = (conn: ReturnType<typeof fakeConn>) => async () => {
  await conn.send("Input.insertText", { text: "hello" });
  return "done";
};

test("unfocused page: emulation on, insertText, emulation off", async () => {
  const conn = fakeConn(false);
  expect(await withInputFocus(conn as never, insert(conn))).toBe("done");
  expect(conn.calls).toEqual(["probe", "emulation:true", "Input.insertText", "emulation:false"]);
});

test("already focused (real focus or caller's focus_emulation): no emulation toggle", async () => {
  const conn = fakeConn(true);
  await withInputFocus(conn as never, insert(conn));
  expect(conn.calls).toEqual(["probe", "Input.insertText"]);
});

test("a failed probe leaves the page alone", async () => {
  const conn = fakeConn("throws");
  await withInputFocus(conn as never, insert(conn));
  expect(conn.calls).toEqual(["probe", "Input.insertText"]);
});

test("a failed input still restores emulation, and the input's error surfaces", async () => {
  const conn = fakeConn(false);
  const boom = async () => {
    await conn.send("Input.dispatchKeyEvent", { type: "keyDown" });
    throw new Error("key failed");
  };
  await expect(withInputFocus(conn as never, boom)).rejects.toThrow("key failed");
  expect(conn.calls).toEqual(["probe", "emulation:true", "Input.dispatchKeyEvent", "emulation:false"]);
});
