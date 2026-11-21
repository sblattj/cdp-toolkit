/**
 * Live smoke for the tab-group tools (#17) against a real Chromium. NOT part of `bun test`.
 *
 *   CDP_BASE=http://127.0.0.1:9566 bun run tab-groups:smoke
 *
 * Use a scratch browser (its own --user-data-dir): the run installs the helper extension and opens
 * and closes its own tabs, two background windows included, but touches no tab it did not open.
 * Prints one labeled verdict per assertion and exits non-zero on any FAIL.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { listTabGroups, groupTabs, ungroupTabs, HELPER_EXTENSION_ID } from "../src/tools/tab-groups.ts";
import { openBrowser, listTargets } from "../src/client.ts";

let failed = 0;
function verdict(label: string, ok: boolean, detail?: unknown): void {
  if (!ok) failed++;
  console.log(`${ok ? "PASS" : "FAIL"} ${label}${detail === undefined ? "" : ` :: ${JSON.stringify(detail)}`}`);
}

async function frontmostApp(): Promise<string | undefined> {
  if (process.platform !== "darwin") return undefined;
  const { stdout } = await promisify(execFile)("osascript", ["-e", 'tell application "System Events" to get name of first process whose frontmost is true']);
  return stdout.trim();
}

const tag = `tgsmoke${Date.now()}`;
const urls = [`data:text/html,<title>${tag}-a</title>a`, `data:text/html,<title>${tag}-b</title>b`, `data:text/html,<title>${tag}-c</title>c`];
const opened: string[] = [];
const browser = await openBrowser();
const front0 = await frontmostApp();
try {
  // Each tab in its own new background window: three windows, so the cross-window rules are exercised.
  for (const url of urls) {
    const r = await browser.send<{ targetId: string }>("Target.createTarget", { url, newWindow: true, background: true });
    opened.push(r.targetId);
  }
  await new Promise((r) => setTimeout(r, 800));

  const before = await listTabGroups({ includeUngrouped: true });
  const rowA = before.windows.flatMap((w) => (w.ungroupedTabs ?? []).map((t) => ({ ...t, windowId: w.windowId }))).find((t) => t.targetId === opened[0]);
  verdict("includeUngrouped lists our new tab with its targetId", rowA !== undefined, rowA && { tabId: rowA.tabId, windowId: rowA.windowId });
  verdict("list_tab_groups answers with windows", Array.isArray(before.windows) && before.windows.length > 0, { windows: before.windows.length, groups: before.groupCount });
  const workers = (await listTargets()).filter((t) => t.url.startsWith(`chrome-extension://${HELPER_EXTENSION_ID}/`));
  verdict("helper worker is live under the pinned extension id", workers.length === 1, workers.map((w) => w.url));

  let refused = "";
  try { await groupTabs({ urlMatch: tag, title: "x" }); } catch (e) { refused = String(e); }
  verdict("a selection spanning three windows is refused without windowId", /3 windows.*windowId/.test(refused), refused.slice(0, 120));

  const ab = await groupTabs({ targetIds: [opened[0]!, opened[1]!], windowId: rowA!.windowId, title: `${tag} AB`, color: "orange" });
  verdict("group_tabs by targetIds + windowId creates a titled orange group in that window", ab.title === `${tag} AB` && ab.color === "orange" && ab.tabs.length === 2 && ab.windowId === rowA!.windowId, { groupId: ab.groupId, windowId: ab.windowId, tabs: ab.tabs.length });
  verdict("the tab from the other window is reported as moved", ab.moved.length === 1 && ab.moved[0]!.fromWindowId !== ab.windowId, ab.moved);
  verdict("rows carry the CDP targetId", ab.tabs.every((t) => opened.includes(t.targetId ?? "")), ab.tabs.map((t) => t.targetId));

  const all = await groupTabs({ urlMatch: tag, groupId: ab.groupId });
  verdict("group_tabs with groupId pulls the other window's tab in", all.tabs.length === 3 && all.windowId === ab.windowId && all.moved.length === 1, { tabs: all.tabs.length, moved: all.moved });

  const listed = await listTabGroups({ windowId: ab.windowId });
  const g = listed.windows[0]?.groups.find((x) => x.groupId === ab.groupId);
  verdict("list_tab_groups shows the group with its title and 3 tabs", g?.title === `${tag} AB` && g?.tabs.length === 3, g && { title: g.title, n: g.tabs.length });

  const un = await ungroupTabs({ groupId: ab.groupId });
  verdict("ungroup_tabs by groupId ungroups all 3", un.ungrouped.length === 3 && un.alreadyUngrouped.length === 0, { ungrouped: un.ungrouped.length });
  const after = await listTabGroups({ windowId: ab.windowId });
  verdict("the emptied group is gone", !after.windows.some((w) => w.groups.some((x) => x.groupId === ab.groupId)));

  const front1 = await frontmostApp();
  verdict("frontmost app unchanged (no focus stealing)", front0 === front1, { before: front0, after: front1 });
} finally {
  for (const id of opened) await browser.send("Target.closeTarget", { targetId: id }).catch(() => {});
  browser.close();
}
console.log(failed ? `${failed} FAILED` : "ALL PASS");
process.exit(failed ? 1 : 0);
