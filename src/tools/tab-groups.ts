/**
 * tab-groups.ts: `list_tab_groups`, `group_tabs`, `ungroup_tabs` (#17) — Chromium tab groups.
 *
 * WHY A HELPER EXTENSION, NOT CDP
 * ===============================
 * CDP has no tab-group domain: no Target/Browser command lists, creates, or names a group. The only
 * API that does is the extension API (chrome.tabGroups + chrome.tabs.group), which runs in an
 * extension context. So this module ships a tiny MV3 extension (HELPER_MANIFEST + HELPER_SW_SOURCE,
 * embedded as strings so nothing extra has to survive the build), writes it under the artifact dir,
 * installs it with the browser-endpoint command `Extensions.loadUnpacked`, and evaluates in its
 * service worker over the worker's own CDP target — the same route `evaluate_script` takes for a
 * 'worker:<substr>' selector.
 *
 * MEASURED, not assumed (Helium on Chromium 158 and Vivaldi on Chromium 156, macOS, 2026-11-20):
 *   - Extensions.loadUnpacked is accepted over a plain --remote-debugging-port WebSocket, without
 *     --enable-unsafe-extension-debugging, and the extension stays installed after the issuing
 *     connection closes (unlike Browser.grantPermissions, see browser-session.ts).
 *   - The manifest `key` fixes the extension id: two install directories gave the same id, so the
 *     worker's target is found by URL prefix without remembering anything between calls.
 *   - The worker is idle-evicted after ~30 s (its target disappears from /json/list). Re-issuing
 *     loadUnpacked on the same directory reloads the extension and the worker is back in ~5 ms, so
 *     every call checks for a live worker running THIS helper version and reloads only when needed.
 *   - chrome.debugger.getTargets() maps chrome tab ids to CDP target ids without attaching, so no
 *     "is debugging this browser" infobar appears; that is why the helper asks for "debugger".
 *   - chrome.tabs.group over tabs from SEVERAL windows, with no createProperties.windowId, silently
 *     moves them all into the LAST-FOCUSED window — not the window of any selected tab. The helper
 *     therefore always passes the window explicitly and refuses a multi-window selection unless the
 *     caller names the destination with `windowId`.
 *   - None of the calls raised or focused a window (frontmost app unchanged before/after).
 *
 * LIMITS, stated rather than hidden:
 *   - The helper directory must exist on the BROWSER's machine (loadUnpacked takes a local path),
 *     so a CDP endpoint on another host cannot run these tools.
 *   - The helper stays installed in the profile after the server exits (it holds no state and
 *     shows no UI); remove it from the browser's extensions page if unwanted.
 *   - These tools do not consult tab leases: grouping changes a tab's place in the tab strip, not
 *     the page, so a tab another agent holds can still be grouped.
 *   - Chrome backend only (capability "browser.tabGroups"). WebDriver BiDi has no way to evaluate
 *     in an extension's background context, so the tools are absent under Firefox.
 */
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { CdpError, listTargets, openBrowser, withPage } from "../client.ts";

/** Artifact root, captured at import like every other module here (screencast, heap, ...). */
const ARTIFACT_DIR = process.env.CDP_ARTIFACT_DIR ?? "/tmp/cdp-toolkit";

/** Where the helper extension is written before Extensions.loadUnpacked reads it. */
export const HELPER_DIR = join(ARTIFACT_DIR, "tab-groups-helper");


/** Chrome's nine tab-group colors (chrome.tabGroups.Color). */
export const TAB_GROUP_COLORS = ["grey", "blue", "red", "yellow", "green", "pink", "purple", "cyan", "orange"] as const;
export type TabGroupColor = (typeof TAB_GROUP_COLORS)[number];

/** Public key only: it exists to pin the extension id. It authorizes nothing. */
const HELPER_KEY =
  "MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAqesYyi7LmBxzWP7VFJGlH2khinCz0uU2z3KNDvZ3Kb8gTLPpthgRWp27pu5/Wk2nvQJdcrunf6u5vqomH2xhvXIqjgXtth2o1GrE6oJMWRUqEoC7I4YUXdSieRpxAxtG37KiSFOyFOU59Som3gGOM2j1qlQIsID0QwRCeRs095SLoTtkA6YwZxtOETgvZAhbbpkmYwkXjTzgY85sS1JfMYj67cmfyz/Nt6yfORSJYEmWAfGCjQnvtOn9TjCazZvmoASUhsKZNZVWckAg+Md+ZKBPbl14/UUwLmWHQ7SDcJozHZtFeLFXySwvmBm3NhP1rK5vd/v+modsQY3M3DbqLQIDAQAB";

export const HELPER_MANIFEST = {
  manifest_version: 3,
  name: "cdp-toolkit tab groups",
  description: "Helper installed by cdp-toolkit's tab-group tools (list_tab_groups, group_tabs, ungroup_tabs). No UI, no state.",
  version: "1.0.0",
  key: HELPER_KEY,
  permissions: ["tabs", "tabGroups", "debugger"],
  background: { service_worker: "sw.js" },
} as const;

/**
 * Chrome's extension id for a manifest key: the first 128 bits of SHA-256 over the DER public key,
 * each hex digit mapped 0-f to a-p. Pure; pinned by a test against the id Chrome returned.
 */
export function extensionIdFromKey(keyBase64: string): string {
  const hex = createHash("sha256").update(Buffer.from(keyBase64, "base64")).digest("hex").slice(0, 32);
  return [...hex].map((c) => String.fromCharCode(97 + parseInt(c, 16))).join("");
}

export const HELPER_EXTENSION_ID = extensionIdFromKey(HELPER_KEY);

/**
 * The helper's service worker. Plain JS (it runs in the browser), loaded by the unit tests against
 * a fake `chrome` through `new Function("self", "chrome", src)`, so its logic is tested without a
 * browser. Every entry point takes ONE JSON-serializable object: callHelper passes it as a JSON
 * literal, never by splicing strings into code.
 */
const HELPER_SW_BODY = String.raw`
const NONE = -1;

async function targetIdsByTab() {
  const m = new Map();
  try {
    for (const t of await chrome.debugger.getTargets()) {
      if (t.type === "page" && typeof t.tabId === "number") m.set(t.tabId, t.id);
    }
  } catch (e) {
    // No mapping is a degraded answer (rows lack targetId), not a failure of the listing.
  }
  return m;
}

function row(t, m) {
  return { tabId: t.id, targetId: m.get(t.id), index: t.index, url: t.url || t.pendingUrl || "", title: t.title || "" };
}

const byPlace = (a, b) => a.windowId - b.windowId || a.index - b.index;

async function list(args) {
  const q = args && args.windowId !== undefined ? { windowId: args.windowId } : {};
  const [tabs, groups, m] = await Promise.all([chrome.tabs.query(q), chrome.tabGroups.query(q), targetIdsByTab()]);
  const wins = new Map();
  for (const t of tabs.slice().sort(byPlace)) {
    let w = wins.get(t.windowId);
    if (!w) wins.set(t.windowId, (w = { windowId: t.windowId, tabCount: 0, ungrouped: 0, groups: [] }));
    w.tabCount++;
    if (t.groupId === NONE || t.groupId === undefined) {
      w.ungrouped++;
      if (args && args.includeUngrouped) (w.ungroupedTabs || (w.ungroupedTabs = [])).push(row(t, m));
      continue;
    }
    let g = w.groups.find((x) => x.groupId === t.groupId);
    if (!g) {
      const info = groups.find((x) => x.id === t.groupId) || {};
      g = { groupId: t.groupId, title: info.title || "", color: info.color, collapsed: !!info.collapsed, tabs: [] };
      w.groups.push(g);
    }
    g.tabs.push(row(t, m));
  }
  const windows = [...wins.values()];
  return {
    windows,
    groupCount: windows.reduce((n, w) => n + w.groups.length, 0),
    tabCount: tabs.length,
  };
}

async function selectTabs(args, m) {
  if (Array.isArray(args.tabIds)) {
    const out = [];
    for (const id of args.tabIds) {
      try { out.push(await chrome.tabs.get(id)); }
      catch (e) { throw new Error("no tab with tabId " + id + " (tab ids come from list_tab_groups)"); }
    }
    return out;
  }
  if (Array.isArray(args.targetIds)) {
    const byTarget = new Map([...m].map(([tabId, targetId]) => [targetId, tabId]));
    const out = [];
    for (const tid of args.targetIds) {
      const id = byTarget.get(tid);
      if (id === undefined) throw new Error("no tab with targetId " + tid + " (a page's CDP target id, as list_pages shows it)");
      out.push(await chrome.tabs.get(id));
    }
    return out;
  }
  const all = (await chrome.tabs.query({})).sort(byPlace);
  if (typeof args.urlMatch === "string") {
    const hit = all.filter((t) => (t.url || "").includes(args.urlMatch) || (t.pendingUrl || "").includes(args.urlMatch));
    if (!hit.length) throw new Error("urlMatch " + JSON.stringify(args.urlMatch) + " matched no tab");
    return hit;
  }
  if (typeof args.groupId === "number") {
    await chrome.tabGroups.get(args.groupId).catch(() => { throw new Error("no tab group with groupId " + args.groupId); });
    return all.filter((t) => t.groupId === args.groupId);
  }
  throw new Error("no tab selector given");
}

async function group(args) {
  const m = await targetIdsByTab();
  const tabs = await selectTabs(args, m);
  let win;
  if (args.groupId !== undefined) {
    win = (await chrome.tabGroups.get(args.groupId).catch(() => { throw new Error("no tab group with groupId " + args.groupId); })).windowId;
  } else if (args.windowId !== undefined) {
    win = args.windowId;
  } else {
    const ws = [...new Set(tabs.map((t) => t.windowId))];
    if (ws.length > 1) {
      throw new Error(
        "the selected tabs are in " + ws.length + " windows (" + ws.join(", ") + "); pass windowId to name the window the group goes in " +
        "(tabs from other windows are moved there). Without it Chrome would move them all into the last-focused window.",
      );
    }
    win = ws[0];
  }
  const moved = tabs.filter((t) => t.windowId !== win).map((t) => ({ tabId: t.id, fromWindowId: t.windowId }));
  const opts = { tabIds: tabs.map((t) => t.id) };
  if (args.groupId !== undefined) opts.groupId = args.groupId;
  else opts.createProperties = { windowId: win };
  const gid = await chrome.tabs.group(opts);
  const upd = {};
  if (args.title !== undefined) upd.title = args.title;
  if (args.color !== undefined) upd.color = args.color;
  if (args.collapsed !== undefined) upd.collapsed = args.collapsed;
  const g = Object.keys(upd).length ? await chrome.tabGroups.update(gid, upd) : await chrome.tabGroups.get(gid);
  const members = g.windowId > 0 ? (await chrome.tabs.query({ windowId: g.windowId })).filter((t) => t.groupId === gid).sort(byPlace) : [];
  if (members.length === 0) {
    // Vivaldi answers chrome.tabs.group with an id but keeps its own tab stacks: the "group" has
    // windowId -1 and no tabs. Fail loudly rather than report a group that does not exist.
    throw new Error("the browser accepted chrome.tabs.group but created no visible group (windowId " + g.windowId + ", 0 tabs); this browser does not support Chrome tab groups (Vivaldi uses its own tab stacks)");
  }
  return { groupId: gid, windowId: g.windowId, title: g.title || "", color: g.color, collapsed: !!g.collapsed, tabs: members.map((t) => row(t, m)), moved };
}

async function ungroup(args) {
  const m = await targetIdsByTab();
  const tabs = await selectTabs(args, m);
  const grouped = tabs.filter((t) => t.groupId !== NONE && t.groupId !== undefined);
  if (grouped.length) await chrome.tabs.ungroup(grouped.map((t) => t.id));
  return {
    ungrouped: grouped.map((t) => Object.assign(row(t, m), { fromGroupId: t.groupId })),
    alreadyUngrouped: tabs.filter((t) => !grouped.includes(t)).map((t) => t.id),
  };
}

self.cdpToolkitTabGroups = { version: VERSION, list, group, ungroup };
`;

/**
 * Content hash of the worker body. A live worker reporting any other version (an older toolkit's
 * helper) is reloaded, so a changed helper can never be skipped by a forgotten manual bump.
 */
export const HELPER_VERSION = createHash("sha256").update(HELPER_SW_BODY).digest("hex").slice(0, 12);

export const HELPER_SW_SOURCE = `"use strict";\nconst VERSION = ${JSON.stringify(HELPER_VERSION)};\n${HELPER_SW_BODY}`;

/* -------------------------------- arguments -------------------------------- */

export interface ListTabGroupsArgs {
  /** Only this window (a chrome window id from a previous listing). */
  windowId?: number;
  /** Also list each window's ungrouped tabs (rows), not just their count. */
  includeUngrouped?: boolean;
}

interface TabSelector {
  /** Chrome tab ids, as list_tab_groups reports them. */
  tabIds?: number[];
  /** CDP target ids (list_pages ids). */
  targetIds?: string[];
  /** Substring of the tab URL; matches across every window. */
  urlMatch?: string;
}

export interface GroupTabsArgs extends TabSelector {
  title?: string;
  color?: TabGroupColor;
  collapsed?: boolean;
  /** Add to this existing group instead of creating one. */
  groupId?: number;
  /** Window the new group goes in; tabs from other windows are moved there. */
  windowId?: number;
}

export interface UngroupTabsArgs extends TabSelector {
  /** Ungroup every tab of this group. */
  groupId?: number;
}

const isInt = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v);

function checkInt(tool: string, name: string, v: unknown): void {
  if (v !== undefined && !isInt(v)) throw new Error(`${tool}: '${name}' must be an integer (got ${JSON.stringify(v)})`);
}

/** Exactly one selector, each non-empty and well typed. `extra` adds ungroup's groupId selector. */
function checkSelector(tool: string, a: TabSelector & { groupId?: number }, withGroupId: boolean): void {
  const given = [
    a.tabIds !== undefined && "tabIds",
    a.targetIds !== undefined && "targetIds",
    typeof a.urlMatch === "string" && a.urlMatch !== "" && "urlMatch",
    withGroupId && a.groupId !== undefined && "groupId",
  ].filter(Boolean);
  const names = withGroupId ? "tabIds, targetIds, urlMatch or groupId" : "tabIds, targetIds or urlMatch";
  if (given.length !== 1) throw new Error(`${tool}: give exactly one of ${names} (got ${given.length ? given.join(" + ") : "none"})`);
  if (a.tabIds !== undefined) {
    if (!Array.isArray(a.tabIds) || a.tabIds.length === 0 || !a.tabIds.every(isInt)) {
      throw new Error(`${tool}: 'tabIds' must be a non-empty array of integer chrome tab ids (got ${JSON.stringify(a.tabIds)})`);
    }
  }
  if (a.targetIds !== undefined) {
    if (!Array.isArray(a.targetIds) || a.targetIds.length === 0 || !a.targetIds.every((t) => typeof t === "string" && t !== "")) {
      throw new Error(`${tool}: 'targetIds' must be a non-empty array of CDP target id strings (got ${JSON.stringify(a.targetIds)})`);
    }
  }
}

export function validateListTabGroupsArgs(a: ListTabGroupsArgs): void {
  checkInt("list_tab_groups", "windowId", a.windowId);
  if (a.includeUngrouped !== undefined && typeof a.includeUngrouped !== "boolean") {
    throw new Error("list_tab_groups: 'includeUngrouped' must be a boolean");
  }
}

export function validateGroupTabsArgs(a: GroupTabsArgs): void {
  const tool = "group_tabs";
  checkSelector(tool, a, false);
  checkInt(tool, "groupId", a.groupId);
  checkInt(tool, "windowId", a.windowId);
  if (a.groupId !== undefined && a.windowId !== undefined) {
    throw new Error(`${tool}: give groupId (add to that group, in its window) or windowId (new group in that window), not both`);
  }
  if (a.title !== undefined && typeof a.title !== "string") throw new Error(`${tool}: 'title' must be a string`);
  if (a.collapsed !== undefined && typeof a.collapsed !== "boolean") throw new Error(`${tool}: 'collapsed' must be a boolean`);
  if (a.color !== undefined && !(TAB_GROUP_COLORS as readonly string[]).includes(a.color)) {
    throw new Error(`${tool}: 'color' must be one of ${TAB_GROUP_COLORS.join(", ")} (got ${JSON.stringify(a.color)})`);
  }
}

export function validateUngroupTabsArgs(a: UngroupTabsArgs): void {
  checkSelector("ungroup_tabs", a, true);
  checkInt("ungroup_tabs", "groupId", a.groupId);
}

/* ------------------------------ helper plumbing ------------------------------ */

const SW_URL_PREFIX = `chrome-extension://${HELPER_EXTENSION_ID}/`;
const WORKER_WAIT_MS = 5_000;

async function helperWorker(): Promise<{ id: string } | undefined> {
  return (await listTargets()).find((t) => t.type === "service_worker" && t.url.startsWith(SW_URL_PREFIX));
}

/** Write the helper files, rewriting only what differs (a stale helper from an older toolkit is replaced). */
async function writeHelper(): Promise<void> {
  await mkdir(HELPER_DIR, { recursive: true });
  const files: Record<string, string> = {
    "manifest.json": JSON.stringify(HELPER_MANIFEST, null, 2),
    "sw.js": HELPER_SW_SOURCE,
  };
  for (const [name, body] of Object.entries(files)) {
    const path = join(HELPER_DIR, name);
    const current = await readFile(path, "utf8").catch(() => undefined);
    if (current !== body) await writeFile(path, body);
  }
}

async function evalIn(workerId: string, expression: string): Promise<unknown> {
  return withPage(workerId, async (conn) => {
    const r = await conn.send<{
      result?: { value?: unknown };
      exceptionDetails?: { text?: string; exception?: { description?: string } };
    }>("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) {
      const d = r.exceptionDetails.exception?.description ?? r.exceptionDetails.text ?? "error";
      // "Error: msg\n    at ..." -> "msg"
      throw new Error(d.split("\n")[0]!.replace(/^Error: /, ""));
    }
    return r.result?.value;
  });
}

/**
 * A live helper worker running this HELPER_VERSION: the existing one when it is current, else a
 * fresh install (or reload) through Extensions.loadUnpacked.
 */
async function currentHelperWorker(): Promise<string | undefined> {
  const w = await helperWorker();
  if (!w) return undefined;
  const v = await evalIn(w.id, "self.cdpToolkitTabGroups && self.cdpToolkitTabGroups.version").catch(() => undefined);
  return v === HELPER_VERSION ? w.id : undefined;
}

async function ensureHelper(): Promise<string> {
  const existing = await currentHelperWorker();
  if (existing) return existing;
  await writeHelper();
  const conn = await openBrowser();
  try {
    await conn.send("Extensions.loadUnpacked", { path: HELPER_DIR });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new CdpError(
      `tab-group tools could not install their helper extension (Extensions.loadUnpacked: ${msg}). ` +
        `They need a Chromium that allows loadUnpacked over CDP, with ${HELPER_DIR} on the browser's own machine.`,
    );
  } finally {
    conn.close();
  }
  // Wait for a worker that reports THIS version: right after a reload over an older helper (or a
  // foreign extension pinned to the same key), /json/list can still show the outgoing worker,
  // whose script never defined the current API (seen live as "reading 'list' of undefined").
  const deadline = Date.now() + WORKER_WAIT_MS;
  while (Date.now() < deadline) {
    const id = await currentHelperWorker();
    if (id) return id;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new CdpError(`the tab-groups helper extension installed but its service worker did not start within ${WORKER_WAIT_MS} ms`);
}

async function callHelper<T>(op: "list" | "group" | "ungroup", args: object): Promise<T> {
  const id = await ensureHelper();
  return (await evalIn(id, `self.cdpToolkitTabGroups.${op}(${JSON.stringify(args)})`)) as T;
}

/* ---------------------------------- tools ---------------------------------- */

export interface TabRow { tabId: number; targetId?: string; index: number; url: string; title: string }
export interface TabGroupRow { groupId: number; title: string; color: TabGroupColor; collapsed: boolean; tabs: TabRow[] }
export interface ListTabGroupsResult {
  windows: Array<{ windowId: number; tabCount: number; ungrouped: number; groups: TabGroupRow[]; ungroupedTabs?: TabRow[] }>;
  groupCount: number;
  tabCount: number;
}
export interface GroupTabsResult extends TabGroupRow {
  windowId: number;
  /** Tabs that were moved from another window into windowId. */
  moved: Array<{ tabId: number; fromWindowId: number }>;
}
export interface UngroupTabsResult {
  ungrouped: Array<TabRow & { fromGroupId: number }>;
  /** Selected tabs that were in no group (nothing to do for them). */
  alreadyUngrouped: number[];
}

/** Every tab group, per window, with member tabs (tab id, CDP target id, url, title). */
export async function listTabGroups(args: ListTabGroupsArgs = {}): Promise<ListTabGroupsResult> {
  validateListTabGroupsArgs(args);
  return callHelper("list", { windowId: args.windowId, includeUngrouped: args.includeUngrouped });
}

/** Create a tab group (or add to one) from the selected tabs, then set title / color / collapsed. */
export async function groupTabs(args: GroupTabsArgs = {}): Promise<GroupTabsResult> {
  validateGroupTabsArgs(args);
  return callHelper("group", args);
}

/** Remove the selected tabs from their groups; a group left empty disappears. */
export async function ungroupTabs(args: UngroupTabsArgs = {}): Promise<UngroupTabsResult> {
  validateUngroupTabsArgs(args);
  return callHelper("ungroup", args);
}
