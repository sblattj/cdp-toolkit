/**
 * Page-lifecycle tools — operate on the BROWSER endpoint (Target.* domain).
 *
 * These four tools mirror chrome-devtools-mcp's page management:
 *   list_pages  -> listPages   (enumerate page targets)
 *   new_page    -> newPage     (Target.createTarget)
 *   close_page  -> closePage   (Target.closeTarget)
 *   select_page -> selectPage  (Target.activateTarget + persist selected state)
 *
 * Unlike most modules these do NOT use withPage/openPage (which attach to a
 * single page target's WebSocket). They use openBrowser() to reach the
 * browser-level Target.* domain so we can create/close/activate any target.
 *
 * select_page persists the chosen targetId to the selected-state file
 * (CDP_STATE_DIR/selected) per CONTRACT.md so other tools can treat it as the
 * default active page if they choose.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { CdpError, listTargets, openBrowser, resolveTarget } from "../client.ts";
import type { Target, TargetSelector } from "../types.ts";

/** Selected-target state file: a bare targetId written by select_page. */
const STATE_DIR = process.env.CDP_STATE_DIR ?? "/tmp/cdp-toolkit";
const SELECTED_FILE = `${STATE_DIR}/selected`;

/** Compact page descriptor returned to callers. */
interface PageInfo {
  id: string;
  url: string;
  title: string;
  type: string;
}

function toPageInfo(t: Target): PageInfo {
  return { id: t.id, url: t.url, title: t.title, type: t.type };
}

/* --------------------------------- list_pages -------------------------------- */

export interface ListPagesArgs {
  /** include non-page targets (workers, background pages) when true */
  all?: boolean;
}

export interface ListPagesResult {
  pages: PageInfo[];
  count: number;
}

/** Enumerate page targets via GET /json/list. */
export async function listPages(args: ListPagesArgs = {}): Promise<ListPagesResult> {
  const targets = await listTargets();
  const filtered = args.all ? targets : targets.filter((t) => t.type === "page");
  const pages = filtered.map(toPageInfo);
  return { pages, count: pages.length };
}

/* ---------------------------------- new_page --------------------------------- */

export interface NewPageArgs {
  /** URL to open in the new tab; defaults to about:blank */
  url?: string;
}

export interface NewPageResult {
  targetId: string;
  url: string;
}

/** Create a new page target (Target.createTarget). */
export async function newPage(args: NewPageArgs = {}): Promise<NewPageResult> {
  const url = args.url ?? "about:blank";
  const conn = await openBrowser();
  try {
    const { targetId } = await conn.send<{ targetId: string }>("Target.createTarget", { url });
    if (!targetId) throw new CdpError("Target.createTarget returned no targetId");
    return { targetId, url };
  } finally {
    conn.close();
  }
}

/* --------------------------------- close_page -------------------------------- */

export interface ClosePageArgs {
  target: TargetSelector;
}

export interface ClosePageResult {
  closed: string;
  success: boolean;
}

/**
 * Close a page target (Target.closeTarget). Refuses with a clear error if the
 * selector cannot be resolved to a concrete target.
 */
export async function closePage(args: ClosePageArgs): Promise<ClosePageResult> {
  if (args.target === undefined || args.target === "") {
    throw new CdpError("close_page requires an explicit target; refusing to guess which page to close");
  }
  // resolveTarget throws a descriptive CdpError if the selector matches nothing.
  const target = await resolveTarget(args.target);
  const conn = await openBrowser();
  try {
    const res = await conn.send<{ success?: boolean }>("Target.closeTarget", { targetId: target.id });
    // Target.closeTarget returns { success: boolean } on older builds; newer
    // builds may return {}. Absence of an error means the close was accepted.
    return { closed: target.id, success: res.success ?? true };
  } finally {
    conn.close();
  }
}

/* -------------------------------- select_page -------------------------------- */

export interface SelectPageArgs {
  target: TargetSelector;
}

export interface SelectPageResult {
  selected: string;
}

/**
 * Activate (focus) a page target (Target.activateTarget) and persist its bare
 * targetId to the selected-state file so other tools can default to it.
 */
export async function selectPage(args: SelectPageArgs): Promise<SelectPageResult> {
  if (args.target === undefined || args.target === "") {
    throw new CdpError("select_page requires an explicit target");
  }
  const target = await resolveTarget(args.target);
  const conn = await openBrowser();
  try {
    await conn.send("Target.activateTarget", { targetId: target.id });
  } finally {
    conn.close();
  }
  await mkdir(dirname(SELECTED_FILE), { recursive: true });
  await writeFile(SELECTED_FILE, target.id, "utf8");
  return { selected: target.id };
}

/*
 * CDP methods/domains used:
 *   - GET /json/list                (via listTargets) — list_pages
 *   - Target.createTarget           — new_page
 *   - Target.closeTarget            — close_page
 *   - Target.activateTarget         — select_page
 *   - resolveTarget()               — selector resolution for close/select
 *
 * Parity gaps vs chrome-devtools-mcp:
 *   - new_page returns {targetId,url}; MCP returns the page's eventual title/URL after load. We do not await navigation here (navigate_page covers that).
 *   - select_page writes a flat-file selected target; the MCP keeps an in-process active-page handle. resolveTarget does NOT read this file, so "active" still means index:0 unless a tool opts in.
 *   - close_page reports success:true when newer Chromium returns an empty result (no explicit success field); it relies on the absence of a CDP error rather than the legacy boolean.
 *   - list_pages "all" flag exposes worker/background targets; the MCP only lists page-type tabs.
 */
