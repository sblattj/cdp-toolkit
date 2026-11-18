import { describe, expect, test } from "bun:test";
import { keepFrontApp, restoreFrontAppEnabled, type FrontAppOps } from "../src/frontApp.ts";

function fakeOps(seq: number[]) {
  const calls: number[] = [];
  let i = 0;
  const ops: FrontAppOps = {
    front: async () => seq[Math.min(i++, seq.length - 1)] ?? null,
    setFront: async (pid) => { calls.push(pid); },
  };
  return { ops, calls };
}

describe("keepFrontApp", () => {
  test("puts the prior app back when the browser took the front", async () => {
    const { ops, calls } = fakeOps([100, 200, 100]);
    expect(await keepFrontApp(async () => "ok", { ops, enabled: true, recheckMs: 1 })).toBe("ok");
    expect(calls).toEqual([100]);
  });
  test("catches a raise that lands after the CDP reply", async () => {
    const { ops, calls } = fakeOps([100, 100, 200]);
    await keepFrontApp(async () => 1, { ops, enabled: true, recheckMs: 1 });
    expect(calls).toEqual([100]);
  });
  test("does nothing when the front app did not change", async () => {
    const { ops, calls } = fakeOps([100, 100, 100]);
    await keepFrontApp(async () => 1, { ops, enabled: true, recheckMs: 1 });
    expect(calls).toEqual([]);
  });
  test("disabled: never reads or sets the front app", async () => {
    const { ops, calls } = fakeOps([100, 200]);
    let reads = 0; const o = { ...ops, front: async () => { reads++; return 200; } };
    await keepFrontApp(async () => 1, { ops: o, enabled: false });
    expect([reads, calls.length]).toEqual([0, 0]);
  });
  test("unknown prior front: leaves things alone", async () => {
    const { ops, calls } = fakeOps([]);
    await keepFrontApp(async () => 1, { ops: { ...ops, front: async () => null }, enabled: true, recheckMs: 1 });
    expect(calls).toEqual([]);
  });
  test("on by default only on macOS; CDP_RESTORE_FRONT_APP=0 turns it off", () => {
    const prev = process.env.CDP_RESTORE_FRONT_APP;
    try {
      delete process.env.CDP_RESTORE_FRONT_APP;
      expect(restoreFrontAppEnabled("darwin")).toBe(true);
      expect(restoreFrontAppEnabled("linux")).toBe(false);
      process.env.CDP_RESTORE_FRONT_APP = "0";
      expect(restoreFrontAppEnabled("darwin")).toBe(false);
    } finally {
      if (prev === undefined) delete process.env.CDP_RESTORE_FRONT_APP; else process.env.CDP_RESTORE_FRONT_APP = prev;
    }
  });
});
