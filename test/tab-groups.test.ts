/**
 * Unit tests for the tab-group tools (src/tools/tab-groups.ts): list_tab_groups, group_tabs,
 * ungroup_tabs (#17).
 *
 * CDP has no tab-group domain, so the tools drive chrome.tabGroups / chrome.tabs.group through a
 * small MV3 helper extension the toolkit installs with Extensions.loadUnpacked and evaluates in
 * through its service worker. What is pinned here WITHOUT a browser:
 *   - argument validation (exactly one tab selector, color enum, groupId vs windowId),
 *   - the helper's stable extension id (derived from the manifest key, not the install path),
 *   - the helper service worker's own logic, run against a fake `chrome` object: listing, the
 *     cross-window refusal, moving into a named window, adding to an existing group, ungrouping,
 *     targetId mapping, and the empty-match refusal,
 *   - registry wiring: manifest, docs, groups, capability gating (absent under firefox), policy.
 * The live path (a real Chromium) is test/tab-groups-smoke.ts.
 */
import { describe, expect, test } from "bun:test";
import {
  HELPER_EXTENSION_ID,
  HELPER_MANIFEST,
  HELPER_SW_SOURCE,
  TAB_GROUP_COLORS,
  extensionIdFromKey,
  validateGroupTabsArgs,
  validateListTabGroupsArgs,
  validateUngroupTabsArgs,
} from "../src/tools/tab-groups.ts";
import { REQUIRED_CAPABILITIES } from "../src/driver.ts";
import { createCdpDriver } from "../src/cdp/driver.ts";
import { createFirefoxDriver } from "../src/bidi/driver.ts";
import { toolAvailability } from "../src/capabilities.ts";
import { MANIFEST } from "../src/manifest.ts";
import { TOOL_DOCS } from "../src/toolDocs.ts";
import { GROUP_TOOLS } from "../src/toolGroups.ts";
import { TOOLS, TOOL_NAMES } from "../src/index.ts";
import { MUTATING_TOOLS, READ_TOOLS } from "../src/policy.ts";

const NAMES = ["list_tab_groups", "group_tabs", "ungroup_tabs"] as const;

/* =============================== validation =============================== */

describe("validateGroupTabsArgs", () => {
  test("accepts each tab selector alone", () => {
    expect(() => validateGroupTabsArgs({ tabIds: [1, 2] })).not.toThrow();
    expect(() => validateGroupTabsArgs({ targetIds: ["ABC"] })).not.toThrow();
    expect(() => validateGroupTabsArgs({ urlMatch: "example.com" })).not.toThrow();
  });
  test("refuses no selector and more than one", () => {
    expect(() => validateGroupTabsArgs({})).toThrow(/exactly one of/);
    expect(() => validateGroupTabsArgs({ tabIds: [1], urlMatch: "x" })).toThrow(/exactly one of/);
  });
  test("refuses empty selectors rather than reporting success for nothing", () => {
    expect(() => validateGroupTabsArgs({ tabIds: [] })).toThrow(/tabIds/);
    expect(() => validateGroupTabsArgs({ targetIds: [] })).toThrow(/targetIds/);
    expect(() => validateGroupTabsArgs({ urlMatch: "" })).toThrow(/exactly one of/);
  });
  test("refuses non-integer tab ids and non-string target ids", () => {
    expect(() => validateGroupTabsArgs({ tabIds: [1.5] })).toThrow(/tabIds/);
    expect(() => validateGroupTabsArgs({ tabIds: ["1"] } as never)).toThrow(/tabIds/);
    expect(() => validateGroupTabsArgs({ targetIds: [3] } as never)).toThrow(/targetIds/);
  });
  test("color must be one of Chrome's nine", () => {
    for (const c of TAB_GROUP_COLORS) expect(() => validateGroupTabsArgs({ tabIds: [1], color: c })).not.toThrow();
    expect(() => validateGroupTabsArgs({ tabIds: [1], color: "magenta" } as never)).toThrow(/color/);
    expect(TAB_GROUP_COLORS).toEqual(["grey", "blue", "red", "yellow", "green", "pink", "purple", "cyan", "orange"]);
  });
  test("groupId and windowId are mutually exclusive (Chrome refuses both)", () => {
    expect(() => validateGroupTabsArgs({ tabIds: [1], groupId: 5, windowId: 9 })).toThrow(/groupId.*windowId|windowId.*groupId/);
  });
  test("type checks on title and collapsed", () => {
    expect(() => validateGroupTabsArgs({ tabIds: [1], title: 3 } as never)).toThrow(/title/);
    expect(() => validateGroupTabsArgs({ tabIds: [1], collapsed: "yes" } as never)).toThrow(/collapsed/);
  });
});

describe("validateUngroupTabsArgs", () => {
  test("accepts groupId as a fourth selector", () => {
    expect(() => validateUngroupTabsArgs({ groupId: 7 })).not.toThrow();
    expect(() => validateUngroupTabsArgs({ urlMatch: "x" })).not.toThrow();
  });
  test("refuses none and two", () => {
    expect(() => validateUngroupTabsArgs({})).toThrow(/exactly one of/);
    expect(() => validateUngroupTabsArgs({ groupId: 7, tabIds: [1] })).toThrow(/exactly one of/);
  });
});

describe("validateListTabGroupsArgs", () => {
  test("windowId must be an integer when given", () => {
    expect(() => validateListTabGroupsArgs({})).not.toThrow();
    expect(() => validateListTabGroupsArgs({ windowId: 3 })).not.toThrow();
    expect(() => validateListTabGroupsArgs({ windowId: "3" } as never)).toThrow(/windowId/);
    expect(() => validateListTabGroupsArgs({ includeUngrouped: 1 } as never)).toThrow(/includeUngrouped/);
  });
});

/* ============================ helper extension ============================ */

describe("helper extension identity", () => {
  test("the id is derived from the manifest key, so any install path gives the same id", () => {
    expect(extensionIdFromKey(HELPER_MANIFEST.key)).toBe(HELPER_EXTENSION_ID);
    expect(HELPER_EXTENSION_ID).toMatch(/^[a-p]{32}$/);
  });
  test("extensionIdFromKey matches Chrome's algorithm on a measured key", () => {
    // Measured on Helium (Chromium 158): Extensions.loadUnpacked of a manifest carrying this key
    // returned {id:"fnoambimeopboidifdmagpjfihclpilo"} from two different directories.
    expect(extensionIdFromKey(HELPER_MANIFEST.key)).toBe("fnoambimeopboidifdmagpjfihclpilo");
  });
  test("the manifest asks for exactly what the worker uses", () => {
    expect(HELPER_MANIFEST.manifest_version).toBe(3);
    expect([...HELPER_MANIFEST.permissions].sort()).toEqual(["debugger", "tabGroups", "tabs"]);
    expect(HELPER_MANIFEST.background.service_worker).toBe("sw.js");
  });
});

/* ================= helper service worker, against a fake chrome ================= */

interface FakeTab { id: number; windowId: number; index: number; url: string; title: string; groupId: number }
interface FakeGroup { id: number; windowId: number; title: string; color: string; collapsed: boolean }

/** A tiny in-memory model of chrome.tabs / chrome.tabGroups / chrome.debugger with Chrome's real
 *  cross-window behavior: tabs.group without createProperties.windowId moves every tab into the
 *  LAST-FOCUSED window (measured on Helium 158), which is the surprise the helper must not hide. */
function fakeChrome(tabs: FakeTab[], groups: FakeGroup[] = [], lastFocused = 1) {
  let nextGroup = 100;
  const reindex = () => {
    const byWin = new Map<number, FakeTab[]>();
    for (const t of tabs) byWin.set(t.windowId, [...(byWin.get(t.windowId) ?? []), t]);
    for (const list of byWin.values()) list.sort((a, b) => a.index - b.index).forEach((t, i) => (t.index = i));
  };
  const dropEmptyGroups = () => {
    for (let i = groups.length - 1; i >= 0; i--) if (!tabs.some((t) => t.groupId === groups[i]!.id)) groups.splice(i, 1);
  };
  const calls: Array<{ fn: string; arg: unknown }> = [];
  const chrome = {
    tabs: {
      query: async (q: { windowId?: number }) => tabs.filter((t) => q.windowId === undefined || t.windowId === q.windowId).map((t) => ({ ...t })),
      get: async (id: number) => {
        const t = tabs.find((x) => x.id === id);
        if (!t) throw new Error(`No tab with id: ${id}.`);
        return { ...t };
      },
      group: async (o: { tabIds: number[]; groupId?: number; createProperties?: { windowId?: number } }) => {
        calls.push({ fn: "tabs.group", arg: o });
        let gid = o.groupId;
        let win: number;
        if (gid !== undefined) {
          const g = groups.find((x) => x.id === gid);
          if (!g) throw new Error(`No group with id: ${gid}.`);
          win = g.windowId;
        } else {
          win = o.createProperties?.windowId ?? lastFocused;
          gid = nextGroup++;
          groups.push({ id: gid, windowId: win, title: "", color: "grey", collapsed: false });
        }
        for (const id of o.tabIds) {
          const t = tabs.find((x) => x.id === id)!;
          if (t.windowId !== win) t.index = 1e6;
          t.windowId = win;
          t.groupId = gid;
        }
        reindex();
        dropEmptyGroups();
        return gid;
      },
      ungroup: async (ids: number[]) => {
        calls.push({ fn: "tabs.ungroup", arg: ids });
        for (const id of ids) tabs.find((t) => t.id === id)!.groupId = -1;
        dropEmptyGroups();
      },
    },
    tabGroups: {
      TAB_GROUP_ID_NONE: -1,
      query: async (q: { windowId?: number }) => groups.filter((g) => q.windowId === undefined || g.windowId === q.windowId).map((g) => ({ ...g })),
      get: async (id: number) => {
        const g = groups.find((x) => x.id === id);
        if (!g) throw new Error(`No group with id: ${id}.`);
        return { ...g };
      },
      update: async (id: number, p: Partial<FakeGroup>) => {
        calls.push({ fn: "tabGroups.update", arg: { id, ...p } });
        const g = groups.find((x) => x.id === id)!;
        Object.assign(g, p);
        return { ...g };
      },
    },
    debugger: {
      getTargets: async () => tabs.map((t) => ({ type: "page", tabId: t.id, id: `T${t.id}`, url: t.url })),
    },
  };
  return { chrome, tabs, groups, calls };
}

/** Load HELPER_SW_SOURCE the way the service worker does, against a fake chrome. */
function loadHelper(chrome: unknown): { list: Function; group: Function; ungroup: Function; version: string } {
  const self: Record<string, unknown> = {};
  new Function("self", "chrome", HELPER_SW_SOURCE)(self, chrome);
  return self.cdpToolkitTabGroups as never;
}

const tab = (id: number, windowId: number, index: number, url: string, groupId = -1): FakeTab => ({ id, windowId, index, url, title: `t${id}`, groupId });

describe("helper: list", () => {
  test("reports every group per window with member tabs and their CDP targetIds", async () => {
    const f = fakeChrome(
      [tab(1, 1, 0, "https://a.test/", 50), tab(2, 1, 1, "https://b.test/"), tab(3, 2, 0, "https://c.test/", 51)],
      [{ id: 50, windowId: 1, title: "Work", color: "blue", collapsed: false }, { id: 51, windowId: 2, title: "Fun", color: "red", collapsed: true }],
    );
    const r = await loadHelper(f.chrome).list({});
    expect(r.windows).toHaveLength(2);
    const w1 = r.windows.find((w: { windowId: number }) => w.windowId === 1);
    expect(w1.tabCount).toBe(2);
    expect(w1.ungrouped).toBe(1);
    expect(w1.groups).toEqual([
      { groupId: 50, title: "Work", color: "blue", collapsed: false, tabs: [{ tabId: 1, targetId: "T1", index: 0, url: "https://a.test/", title: "t1" }] },
    ]);
    expect(r.groupCount).toBe(2);
  });
  test("includeUngrouped adds ungroupedTabs rows; without it only the count", async () => {
    const f = fakeChrome([tab(1, 1, 0, "https://a.test/", 50), tab(2, 1, 1, "https://b.test/")], [{ id: 50, windowId: 1, title: "W", color: "blue", collapsed: false }]);
    const h = loadHelper(f.chrome);
    expect((await h.list({})).windows[0].ungroupedTabs).toBeUndefined();
    const r = await h.list({ includeUngrouped: true });
    expect(r.windows[0].ungroupedTabs).toEqual([{ tabId: 2, targetId: "T2", index: 1, url: "https://b.test/", title: "t2" }]);
  });
  test("windowId narrows to one window", async () => {
    const f = fakeChrome([tab(1, 1, 0, "https://a.test/"), tab(3, 2, 0, "https://c.test/")]);
    const r = await loadHelper(f.chrome).list({ windowId: 2 });
    expect(r.windows.map((w: { windowId: number }) => w.windowId)).toEqual([2]);
  });
});

describe("helper: group", () => {
  test("creates a titled, colored group in the tabs' own window", async () => {
    const f = fakeChrome([tab(1, 3, 0, "https://a.test/x"), tab(2, 3, 1, "https://a.test/y"), tab(3, 3, 2, "https://b.test/")], [], 1);
    const r = await loadHelper(f.chrome).group({ urlMatch: "a.test", title: "A", color: "green", collapsed: false });
    expect(r.windowId).toBe(3);
    expect(r.title).toBe("A");
    expect(r.color).toBe("green");
    expect(r.tabs.map((t: { tabId: number }) => t.tabId)).toEqual([1, 2]);
    expect(r.moved).toEqual([]);
    // The window is passed explicitly, so Chrome never falls back to the last-focused window (1).
    expect(f.calls[0]).toEqual({ fn: "tabs.group", arg: { tabIds: [1, 2], createProperties: { windowId: 3 } } });
    expect(f.tabs.filter((t) => t.windowId === 1)).toHaveLength(0);
  });
  test("refuses a selection spanning windows unless windowId names the destination", async () => {
    const f = fakeChrome([tab(1, 3, 0, "https://a.test/x"), tab(2, 4, 0, "https://a.test/y")]);
    await expect(loadHelper(f.chrome).group({ urlMatch: "a.test" })).rejects.toThrow(/2 windows.*windowId/);
    expect(f.calls).toHaveLength(0);
  });
  test("with windowId, tabs from other windows are moved there and reported", async () => {
    const f = fakeChrome([tab(1, 3, 0, "https://a.test/x"), tab(2, 4, 0, "https://a.test/y")]);
    const r = await loadHelper(f.chrome).group({ urlMatch: "a.test", windowId: 3, title: "A" });
    expect(r.windowId).toBe(3);
    expect(r.moved).toEqual([{ tabId: 2, fromWindowId: 4 }]);
    expect(f.tabs.every((t) => t.windowId === 3)).toBe(true);
  });
  test("groupId adds to an existing group and keeps its title unless one is given", async () => {
    const f = fakeChrome([tab(1, 3, 0, "https://a.test/", 50), tab(2, 3, 1, "https://b.test/")], [{ id: 50, windowId: 3, title: "Keep", color: "red", collapsed: false }]);
    const r = await loadHelper(f.chrome).group({ tabIds: [2], groupId: 50 });
    expect(r.groupId).toBe(50);
    expect(r.title).toBe("Keep");
    expect(r.tabs.map((t: { tabId: number }) => t.tabId)).toEqual([1, 2]);
    expect(f.calls.find((c) => c.fn === "tabGroups.update")).toBeUndefined();
  });
  test("targetIds resolve through chrome.debugger.getTargets", async () => {
    const f = fakeChrome([tab(1, 3, 0, "https://a.test/"), tab(2, 3, 1, "https://b.test/")]);
    const r = await loadHelper(f.chrome).group({ targetIds: ["T2"], title: "B" });
    expect(r.tabs.map((t: { tabId: number; targetId: string }) => [t.tabId, t.targetId])).toEqual([[2, "T2"]]);
  });
  test("an unknown targetId or tabId is an error naming it, and nothing is grouped", async () => {
    const f = fakeChrome([tab(1, 3, 0, "https://a.test/")]);
    await expect(loadHelper(f.chrome).group({ targetIds: ["NOPE"] })).rejects.toThrow(/NOPE/);
    await expect(loadHelper(f.chrome).group({ tabIds: [99] })).rejects.toThrow(/99/);
    expect(f.calls).toHaveLength(0);
  });
  test("a urlMatch that matches nothing is an error, not an empty success", async () => {
    const f = fakeChrome([tab(1, 3, 0, "https://a.test/")]);
    await expect(loadHelper(f.chrome).group({ urlMatch: "zzz" })).rejects.toThrow(/matched no tab/);
  });
  test("a browser that answers tabs.group but creates no real group (Vivaldi) is an error", async () => {
    // Measured on Vivaldi 7 (Chromium 156): tabs.group returns an id, tabGroups.get says windowId -1, no tab joins.
    const f = fakeChrome([tab(1, 3, 0, "https://a.test/")]);
    f.chrome.tabs.group = async () => 777;
    f.chrome.tabGroups.get = async (id: number) => ({ id, windowId: -1, title: "", color: "grey", collapsed: true });
    f.chrome.tabGroups.update = async (id: number) => ({ id, windowId: -1, title: "", color: "grey", collapsed: true });
    await expect(loadHelper(f.chrome).group({ tabIds: [1], title: "X" })).rejects.toThrow(/does not support Chrome tab groups/);
  });
});

describe("helper: ungroup", () => {
  test("ungroups by groupId and reports the tabs", async () => {
    const f = fakeChrome([tab(1, 3, 0, "https://a.test/", 50), tab(2, 3, 1, "https://b.test/", 50)], [{ id: 50, windowId: 3, title: "G", color: "red", collapsed: false }]);
    const r = await loadHelper(f.chrome).ungroup({ groupId: 50 });
    expect(r.ungrouped.map((t: { tabId: number }) => t.tabId)).toEqual([1, 2]);
    expect(r.alreadyUngrouped).toEqual([]);
    expect(f.groups).toHaveLength(0);
  });
  test("tabs not in a group are reported, not passed to chrome", async () => {
    const f = fakeChrome([tab(1, 3, 0, "https://a.test/", 50), tab(2, 3, 1, "https://a.test/b")], [{ id: 50, windowId: 3, title: "G", color: "red", collapsed: false }]);
    const r = await loadHelper(f.chrome).ungroup({ urlMatch: "a.test" });
    expect(r.ungrouped.map((t: { tabId: number }) => t.tabId)).toEqual([1]);
    expect(r.alreadyUngrouped).toEqual([2]);
    expect(f.calls).toEqual([{ fn: "tabs.ungroup", arg: [1] }]);
  });
});

/* ============================== registry wiring ============================== */

describe("capability gating (chrome-only, absent under firefox)", () => {
  test("all three require browser.tabGroups", () => {
    for (const n of NAMES) expect(REQUIRED_CAPABILITIES[n]).toEqual(["browser.tabGroups"]);
  });
  test("the CDP driver declares it and the Firefox driver does not", () => {
    expect(createCdpDriver().capabilities.has("browser.tabGroups")).toBe(true);
    expect(createFirefoxDriver(0).capabilities.has("browser.tabGroups")).toBe(false);
  });
  test("available on chrome, absent on firefox", () => {
    const chrome = toolAvailability("chrome");
    const firefox = toolAvailability("firefox");
    for (const n of NAMES) {
      expect(chrome.available).toContain(n);
      expect(firefox.available).not.toContain(n);
    }
  });
});

describe("registration: manifest, docs, groups, registry, policy", () => {
  test("in the TOOLS registry", () => {
    for (const n of NAMES) {
      expect(typeof TOOLS[n]).toBe("function");
      expect(TOOL_NAMES).toContain(n);
    }
  });
  test("manifest schemas forbid unknown params and accept endpoint (these tools take no target)", () => {
    for (const n of NAMES) {
      const entry = MANIFEST.find((m) => m.name === n);
      expect(entry, `${n} manifest entry`).toBeDefined();
      expect(entry!.inputSchema.additionalProperties).toBe(false);
      expect(Object.keys(entry!.inputSchema.properties ?? {})).toContain("endpoint");
      expect(Object.keys(entry!.inputSchema.properties ?? {})).not.toContain("target");
    }
  });
  test("group_tabs advertises the color enum", () => {
    const props = MANIFEST.find((m) => m.name === "group_tabs")!.inputSchema.properties as Record<string, { enum?: string[] }>;
    expect(props.color?.enum).toEqual([...TAB_GROUP_COLORS]);
    for (const k of ["tabIds", "targetIds", "urlMatch", "title", "collapsed", "groupId", "windowId"]) expect(Object.keys(props)).toContain(k);
  });
  test("docs exist", () => {
    for (const n of NAMES) expect(TOOL_DOCS[n]?.description.length ?? 0).toBeGreaterThan(40);
  });
  test("in the tabs tool group", () => {
    expect([...GROUP_TOOLS.tabs]).toEqual([...NAMES]);
  });
  test("all three are MUTATING: even the listing installs the helper extension", () => {
    for (const n of NAMES) {
      expect(MUTATING_TOOLS.has(n)).toBe(true);
      expect(READ_TOOLS.has(n)).toBe(false);
    }
  });
});
