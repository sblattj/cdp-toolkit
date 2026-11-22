/**
 * Tabs opened BY an agent tab (window.open, a target=_blank link, a web app that hops to a copy of
 * itself) inherit the opener's ownership and its agent origin (src/ownedTabs.ts adoptPopup, fed by
 * the CDP driver's watchPopups over Target.targetCreated's openerId).
 *
 * Why it matters: without this a popup is origin 'unknown', so it is never closed on exit, never
 * counted against CDP_MAX_AGENT_TABS, and to every other agent it looks like a tab the human
 * opened. The negative tests name the tabs that must still be left alone.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AgentTabCapError,
  closeOwnedTabs,
  ownedTabIds,
  popupsSettled,
  resetOwnedTabs,
} from "../src/ownedTabs.ts";
import { markLongLivedProcess } from "../src/leases.ts";
import { originIndex, recordOrigin } from "../src/origins.ts";
import { newPage } from "../src/shared-tools.ts";
import { PopupWatcher } from "../src/cdp/popupWatch.ts";
import type { PageInfo } from "../src/driver.ts";
import { page, stubDriver } from "./helpers/stub-driver.ts";

let dir = "";
const saved = { artifact: process.env.CDP_ARTIFACT_DIR, state: process.env.CDP_STATE_DIR, max: process.env.CDP_MAX_AGENT_TABS };
function restore(key: string, value: string | undefined) {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "cdp-popup-"));
  process.env.CDP_ARTIFACT_DIR = dir;
  process.env.CDP_STATE_DIR = join(dir, "state");
});
afterAll(async () => {
  restore("CDP_ARTIFACT_DIR", saved.artifact);
  restore("CDP_STATE_DIR", saved.state);
  markLongLivedProcess(false);
  await rm(dir, { recursive: true, force: true });
});
beforeEach(async () => {
  for (const f of await readdir(dir)) await rm(join(dir, f), { recursive: true, force: true });
  resetOwnedTabs();
  markLongLivedProcess(true);
  delete process.env.CDP_MAX_AGENT_TABS;
});
afterEach(() => {
  restore("CDP_MAX_AGENT_TABS", saved.max);
  markLongLivedProcess(false);
  resetOwnedTabs();
});

describe("a tab opened by this process's agent tab", () => {
  test("is owned, closable on exit, and gets agent origin with the opener's label", async () => {
    const { driver, firePopup } = stubDriver({ popups: true });
    const a = await newPage(driver, { label: "lane-x" });
    firePopup("POP-1", a.targetId);
    await popupsSettled();
    expect(ownedTabIds("chrome", { closableOnly: true })).toEqual([a.targetId, "POP-1"]);
    const origin = (await originIndex("chrome")).get("POP-1");
    expect(origin?.label).toBe("lane-x");
    expect(origin?.pid).toBe(process.pid);
  });

  test("closes on exit with its opener", async () => {
    const { driver, firePopup, closed } = stubDriver({ popups: true });
    const a = await newPage(driver, {});
    firePopup("POP-1", a.targetId);
    const res = await closeOwnedTabs(driver);
    expect(closed.sort()).toEqual([a.targetId, "POP-1"].sort());
    expect(res.closed.sort()).toEqual([a.targetId, "POP-1"].sort());
  });

  test("still closes on exit after its opener was closed (the hop: a web app moves to a copy)", async () => {
    const { driver, firePopup, closed, pages } = stubDriver({ popups: true });
    const a = await newPage(driver, {});
    firePopup("POP-1", a.targetId);
    pages.splice(pages.findIndex((p) => p.id === a.targetId), 1);
    await closeOwnedTabs(driver);
    expect(closed).toEqual(["POP-1"]);
  });

  test("a popup of a popup inherits too", async () => {
    const { driver, firePopup } = stubDriver({ popups: true });
    const a = await newPage(driver, {});
    firePopup("POP-1", a.targetId);
    firePopup("POP-2", "POP-1");
    await popupsSettled();
    expect(ownedTabIds("chrome", { closableOnly: true })).toEqual([a.targetId, "POP-1", "POP-2"]);
    expect((await originIndex("chrome")).has("POP-2")).toBe(true);
  });

  test("a popup that appears while its opener is still being created is adopted when the opener lands", async () => {
    const { driver, firePopup } = stubDriver({ popups: true });
    const inner = driver.newPage.bind(driver);
    (driver as { newPage: typeof driver.newPage }).newPage = async (url, o) => {
      const p: PageInfo = await inner(url, o);
      firePopup("EARLY-POP", p.id);
      return p;
    };
    const a = await newPage(driver, {});
    await popupsSettled();
    expect(ownedTabIds("chrome", { closableOnly: true })).toEqual([a.targetId, "EARLY-POP"]);
  });

  test("counts toward CDP_MAX_AGENT_TABS", async () => {
    process.env.CDP_MAX_AGENT_TABS = "2";
    const { driver, firePopup } = stubDriver({ popups: true });
    const a = await newPage(driver, {});
    firePopup("POP-1", a.targetId);
    const err = await newPage(driver, {}).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AgentTabCapError);
    expect((err as Error).message).toContain("POP-1");
  });

  test("the watch is started before the first tab is created, once", async () => {
    const { driver, watchCalls } = stubDriver({ popups: true });
    await newPage(driver, {});
    await newPage(driver, {});
    expect(watchCalls()).toBeGreaterThanOrEqual(1);
  });
});

describe("tabs that must NOT inherit, or must survive exit", () => {
  test("a copy of a tab opened for the human (focus:true) is kept on exit and not counted", async () => {
    const { driver, firePopup, closed } = stubDriver({ popups: true });
    const h = await newPage(driver, { focus: true });
    firePopup("HUMAN-COPY", h.targetId);
    await popupsSettled();
    expect(ownedTabIds("chrome", { closableOnly: true })).toEqual([]);
    expect((await originIndex("chrome")).has("HUMAN-COPY")).toBe(true);
    const res = await closeOwnedTabs(driver);
    expect(closed).toEqual([]);
    expect(res.kept.sort()).toEqual([h.targetId, "HUMAN-COPY"].sort());
  });

  test("a popup of a tab this process did not open (origin unknown) is not recorded", async () => {
    const { driver, firePopup, closed } = stubDriver({ popups: true, pages: [page("HUMAN")] });
    await newPage(driver, {});
    firePopup("HUMAN-POP", "HUMAN");
    await popupsSettled();
    expect(ownedTabIds("chrome")).not.toContain("HUMAN-POP");
    expect((await originIndex("chrome")).has("HUMAN-POP")).toBe(false);
    await closeOwnedTabs(driver);
    expect(closed).not.toContain("HUMAN-POP");
  });

  test("a popup of another process's agent tab is not recorded here", async () => {
    const { driver, firePopup } = stubDriver({ popups: true, pages: [page("PEER")] });
    await recordOrigin("chrome", "PEER", { label: "peer-lane" });
    await newPage(driver, {});
    firePopup("PEER-POP", "PEER");
    await popupsSettled();
    expect(ownedTabIds("chrome")).not.toContain("PEER-POP");
    expect((await originIndex("chrome")).has("PEER-POP")).toBe(false);
  });

  test("a tab this process gave up (close_page / release_page) passes nothing on", async () => {
    const { driver, firePopup } = stubDriver({ popups: true });
    const a = await newPage(driver, {});
    const { forgetOwnedTab } = await import("../src/ownedTabs.ts");
    forgetOwnedTab("chrome", a.targetId);
    firePopup("LATE-POP", a.targetId);
    await popupsSettled();
    expect(ownedTabIds("chrome")).toEqual([]);
  });

  test("under the CLI no watch is started and nothing is recorded", async () => {
    markLongLivedProcess(false);
    const { driver, firePopup, watchCalls } = stubDriver({ popups: true });
    const a = await newPage(driver, {});
    firePopup("CLI-POP", a.targetId);
    await popupsSettled();
    expect(watchCalls()).toBe(0);
    expect(ownedTabIds("chrome")).toEqual([]);
  });
});

/* ------------------------------ the CDP watcher ------------------------------ */

type Handler = (params: Record<string, unknown>) => void;
function fakeConn() {
  const handlers = new Map<string, Handler[]>();
  const sent: string[] = [];
  const conn = {
    isOpen: true,
    closed: false,
    async send(method: string) {
      sent.push(method);
      return {};
    },
    on(method: string, h: Handler) {
      handlers.set(method, [...(handlers.get(method) ?? []), h]);
      return () => handlers.set(method, (handlers.get(method) ?? []).filter((x) => x !== h));
    },
    close() {
      conn.isOpen = false;
      conn.closed = true;
    },
    emit(method: string, params: Record<string, unknown>) {
      for (const h of handlers.get(method) ?? []) h(params);
    },
  };
  return { conn, sent };
}

describe("PopupWatcher (Target.targetCreated with an openerId)", () => {
  test("connects once, turns discovery on, and reports only pages that have an opener", async () => {
    const { conn, sent } = fakeConn();
    let connects = 0;
    const seen: Array<[string, string]> = [];
    const w = new PopupWatcher({ connect: async () => (connects++, conn) });
    await Promise.all([w.start((c, o) => seen.push([c, o])), w.start((c, o) => seen.push([c, o]))]);
    expect(connects).toBe(1);
    expect(sent).toContain("Target.setDiscoverTargets");
    conn.emit("Target.targetCreated", { targetInfo: { targetId: "C1", type: "page", openerId: "O1" } });
    conn.emit("Target.targetCreated", { targetInfo: { targetId: "C2", type: "page" } });
    conn.emit("Target.targetCreated", { targetInfo: { targetId: "W1", type: "service_worker", openerId: "O1" } });
    expect(seen).toEqual([["C1", "O1"]]);
  });

  test("reconnects on the next start after its socket died", async () => {
    const first = fakeConn();
    const second = fakeConn();
    const conns = [first.conn, second.conn];
    const w = new PopupWatcher({ connect: async () => conns.shift()! });
    const seen: string[] = [];
    await w.start((c) => seen.push(c));
    first.conn.isOpen = false;
    await w.start((c) => seen.push(c));
    second.conn.emit("Target.targetCreated", { targetInfo: { targetId: "C9", type: "page", openerId: "O" } });
    expect(seen).toEqual(["C9"]);
  });

  test("a failed connect does not throw (a popup watch is best effort) and is retried later", async () => {
    const { conn } = fakeConn();
    let n = 0;
    const w = new PopupWatcher({ connect: async () => { if (n++ === 0) throw new Error("refused"); return conn; } });
    await w.start(() => undefined);
    await w.start(() => undefined);
    expect(n).toBe(2);
  });

  test("dispose closes the socket", async () => {
    const { conn } = fakeConn();
    const w = new PopupWatcher({ connect: async () => conn });
    await w.start(() => undefined);
    w.dispose();
    expect(conn.closed).toBe(true);
  });
});
