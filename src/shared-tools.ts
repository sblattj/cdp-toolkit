/**
 * ONE implementation per tool, built only on the browser-neutral Driver contract in driver.ts
 * (ADR-001), used by BOTH Chrome (via cdp/driver.ts's createCdpDriver()) and Firefox (via
 * bidi/driver.ts's createFirefoxDriver()). This file replaces the split that used to exist
 * between src/tools/*.ts (raw CDP, Chrome only) and src/neutral.ts (Driver-based, Firefox only)
 * for the 20 tools below.
 *
 * THE HARD REQUIREMENT this file exists to satisfy: Chrome's return shape, timing, and quirks
 * stay byte-identical to what src/tools/*.ts produced before this migration: that already
 * shipped to npm. Where the clean Driver abstraction and that requirement conflicted, the
 * requirement won; every such place is called out in a comment at the call site. The most
 * significant ones:
 *   - take_snapshot's uid is rendered as a bare digit for the "cdp" scheme (matching the legacy
 *     backendDOMNodeId-as-uid contract) rather than the driver's own tagged "cdp:N" form, and its
 *     extras (checked/expanded/disabled/url/focused) keep the legacy per-key quoting AND the
 *     "expanded" quirk (included even when literally "false") rather than a clean uniform rule.
 *   - navigate_page's field names (frameId, not contextId) and waitedFor vocabulary (load /
 *     domcontentloaded / frameStoppedLoading / navigate-only) are the legacy CDP tool's, not the
 *     Driver's own (committed / timeout).
 *   - Every nested `target` object in a result is the legacy 3-field {id,url,title}: PageInfo's
 *     additive `type` field is deliberately dropped there (list_pages is the one place `type` is
 *     part of the contract).
 *
 * NOT here: list_console_messages / get_console_message / list_network_requests /
 * get_network_request / mock_request / list_mocks / clear_mocks. Chrome's versions of those 7
 * tools are built on src/tools/recorder.ts, a disk-persisted, cross-process capture keyed by
 * target id (rec-<targetId>.jsonl) with a materially richer shape (ConsoleEntry/NetworkRequest
 * correlation, per-rule hit counts, dedup-by-pattern+method). Firefox's existing implementation
 * (now in src/bidi-tools.ts) is a same-process, in-memory event buffer with a different shape.
 * Unifying them safely would mean either dropping Chrome's cross-process persistence (a real
 * behavior change to something that ships today) or teaching Firefox to write the same JSONL
 * format (new feature work, not a safety-preserving migration). Per the explicit instruction that
 * behavior outranks the abstraction, these 7 stay two implementations; see the migration report.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type {
  BrowserDriver, DriverUid, ElementLocator, NavigateResult, PageDriver, PageInfo, SnapshotNode,
} from "./driver.ts";
import type { TargetSelector } from "./types.ts";

const ARTIFACT_DIR = process.env.CDP_ARTIFACT_DIR ?? "/tmp/cdp-toolkit";
const STATE_DIR = process.env.CDP_STATE_DIR ?? "/tmp/cdp-toolkit";

class SharedToolError extends Error {}

/** Trim a PageInfo down to the legacy 3-field {id,url,title} target shape used everywhere except list_pages. */
function target3(p: PageInfo): { id: string; url: string; title: string } {
  return { id: p.id, url: p.url, title: p.title };
}

/* -------------------------------- page acquisition -------------------------------- */

/** Acquire, run, always release: the Driver counterpart of client.ts's withPage. */
async function withPage<T>(driver: BrowserDriver, target: TargetSelector | undefined, fn: (page: PageDriver) => Promise<T>): Promise<T> {
  const page = await driver.page(target);
  try {
    return await fn(page);
  } finally {
    await page.release();
  }
}

/**
 * Same TargetSelector grammar as client.ts's resolveTarget. Matches its one asymmetry exactly:
 * every branch resolves against page-type targets only EXCEPT a bare-id lookup, which (like
 * legacy resolveTarget's `targets.find`) searches the FULL unfiltered listing, so passing an
 * exact non-page targetId (a worker, an iframe) still resolves.
 */
async function resolvePage(driver: BrowserDriver, selector?: TargetSelector): Promise<PageInfo> {
  const pages = await driver.listPages();
  if (selector === undefined || selector === "active") {
    if (!pages.length) throw new SharedToolError("no page targets open");
    return pages[0]!;
  }
  if (selector.startsWith("index:")) {
    const p = pages[Number(selector.slice(6))];
    if (!p) throw new SharedToolError(`no page target at index ${selector.slice(6)} (have ${pages.length})`);
    return p;
  }
  if (selector.startsWith("url:")) {
    const needle = selector.slice(4);
    const p = pages.find((x) => x.url.includes(needle));
    if (!p) throw new SharedToolError(`no page url containing '${needle}'`);
    return p;
  }
  if (selector.startsWith("title:")) {
    const needle = selector.slice(6);
    const p = pages.find((x) => x.title.includes(needle));
    if (!p) throw new SharedToolError(`no page title containing '${needle}'`);
    return p;
  }
  const exactPage = pages.find((x) => x.id === selector);
  if (exactPage) return exactPage;
  const all = await driver.listPages({ all: true });
  const exact = all.find((x) => x.id === selector);
  if (exact) return exact;
  throw new SharedToolError(`no target with id '${selector}'`);
}

/* -------------------------------- element locators -------------------------------- */

function locatorOf(args: { uid?: DriverUid; selector?: string }): ElementLocator {
  const hasUid = args.uid !== undefined && args.uid !== null && args.uid !== ("" as unknown);
  const hasSelector = typeof args.selector === "string" && args.selector.length > 0;
  if (hasUid === hasSelector) throw new SharedToolError("provide exactly one of { uid } or { selector }");
  return hasUid ? { uid: args.uid as DriverUid } : { css: args.selector as string };
}

/* -------------------------------- pages (4) -------------------------------- */

export async function listPages(driver: BrowserDriver, args: { all?: boolean } = {}): Promise<{ pages: PageInfo[]; count: number }> {
  const pages = await driver.listPages({ all: args.all });
  return { pages, count: pages.length };
}

export async function newPage(driver: BrowserDriver, args: { url?: string } = {}): Promise<{ targetId: string; url: string }> {
  const p = await driver.newPage(args.url);
  return { targetId: p.id, url: p.url };
}

export async function closePage(driver: BrowserDriver, args: { target?: TargetSelector }): Promise<{ closed: string; success: boolean }> {
  if (args.target === undefined || args.target === "") throw new SharedToolError("close_page requires an explicit target; refusing to guess which page to close");
  const p = await resolvePage(driver, args.target);
  const res = await driver.closePage(p.id);
  return { closed: p.id, success: res.success };
}

async function writeSelectedFile(id: string): Promise<void> {
  await mkdir(STATE_DIR, { recursive: true });
  await writeFile(join(STATE_DIR, "selected"), id, "utf8");
}

export async function selectPage(driver: BrowserDriver, args: { target?: TargetSelector }): Promise<{ selected: string }> {
  if (args.target === undefined || args.target === "") throw new SharedToolError("select_page requires an explicit target");
  const p = await resolvePage(driver, args.target);
  const activated = await driver.activatePage(p.id);
  await writeSelectedFile(activated.id);
  return { selected: activated.id };
}

/* ------------------------------ navigation (2) ------------------------------ */

/** Legacy tools/navigation.ts vocabulary, not the Driver's own (see file header). */
function toLegacyWaitedFor(w: NavigateResult["waitedFor"]): "load" | "domcontentloaded" | "frameStoppedLoading" | "navigate-only" {
  if (w === "committed") return "frameStoppedLoading";
  if (w === "timeout") return "navigate-only";
  return w;
}

export interface LegacyNavigateResult {
  url: string;
  frameId: string;
  reloaded?: boolean;
  waitedFor: "load" | "domcontentloaded" | "frameStoppedLoading" | "navigate-only";
}

export async function navigatePage(
  driver: BrowserDriver,
  args: { target?: TargetSelector; url?: string; reload?: boolean; ignoreCache?: boolean; waitUntil?: "load" | "domcontentloaded"; timeoutMs?: number },
): Promise<LegacyNavigateResult> {
  const reload = args.reload === true;
  if (!reload && (!args.url || typeof args.url !== "string")) {
    throw new SharedToolError("navigate_page: 'url' is required (or pass reload:true to reload the current page)");
  }
  return withPage(driver, args.target, async (page) => {
    const r = await page.navigate(args);
    return {
      url: r.url,
      frameId: r.contextId,
      ...(r.reloaded ? { reloaded: r.reloaded } : {}),
      waitedFor: toLegacyWaitedFor(r.waitedFor),
    };
  });
}

export async function waitForText(driver: BrowserDriver, args: { target?: TargetSelector; text: string; timeoutMs?: number; pollMs?: number }): Promise<{ found: true; waitedMs: number }> {
  if (typeof args.text !== "string" || args.text.length === 0) throw new SharedToolError("wait_for: 'text' is required");
  return withPage(driver, args.target, async (page) => {
    const r = await page.waitForText(args.text, args.timeoutMs ?? 15_000, args.pollMs ?? 250);
    return { found: true, waitedMs: r.elapsedMs };
  });
}
/** Contract-mandated alias, matching tools/navigation.ts's exported `waitFor`. */
export const waitFor = waitForText;

/* ------------------------------- evaluate (1) ------------------------------- */

export async function evaluateScript(
  driver: BrowserDriver,
  args: { target?: TargetSelector; expression: string; awaitPromise?: boolean; args?: unknown[] },
): Promise<unknown> {
  if (typeof args.expression !== "string" || args.expression.length === 0) {
    throw new SharedToolError("evaluateScript: 'expression' must be a non-empty string");
  }
  return withPage(driver, args.target, (page) => page.evaluate(args.expression, { args: args.args, awaitPromise: args.awaitPromise ?? true }));
}

/* -------------------------------- snapshot (1) -------------------------------- */

/**
 * Legacy-faithful render, keyed by field name (see the file header's uid/extras note). The
 * "cdp" scheme strips its "cdp:" tag to reproduce the historical bare-backendDOMNodeId uid;
 * every other scheme keeps its tag (a tool must never guess at a foreign driver's uid grammar,
 * per driver.ts's THE UID CODEC block: this is a display choice made by the tool that already
 * knows its own driver's scheme, not a parse of a uid it didn't mint).
 */
const BARE_TOKEN_EXTRAS = new Set(["disabled", "focused"]);
const UNQUOTED_EXTRAS = new Set(["checked", "expanded", "url"]);

function renderSnapshotLine(n: SnapshotNode, scheme: string): string {
  const indent = "  ".repeat(n.depth);
  const uidText = scheme === "cdp" && n.uid.startsWith("cdp:") ? n.uid.slice(4) : n.uid;
  const name = n.name !== undefined ? ` ${JSON.stringify(n.name)}` : "";
  const extrasToks: string[] = [];
  if (n.extras) {
    for (const [k, v] of Object.entries(n.extras)) {
      if (BARE_TOKEN_EXTRAS.has(k)) extrasToks.push(k);
      else if (UNQUOTED_EXTRAS.has(k)) extrasToks.push(`${k}=${v}`);
      else extrasToks.push(`${k}=${JSON.stringify(v)}`);
    }
  }
  const extra = extrasToks.length ? ` [${extrasToks.join(" ")}]` : "";
  return `${indent}[${uidText}] ${n.role}${name}${extra}`;
}

export async function takeSnapshot(
  driver: BrowserDriver,
  args: { target?: TargetSelector; interactiveOnly?: boolean } = {},
): Promise<{ snapshot: string; target: { id: string; url: string; title: string }; nodeCount: number }> {
  return withPage(driver, args.target, async (page) => {
    const nodes = await page.snapshot({ interactiveOnly: args.interactiveOnly ?? false });
    const scheme = page.browser.scheme;
    return { snapshot: nodes.map((n) => renderSnapshotLine(n, scheme)).join("\n"), target: target3(page.info), nodeCount: nodes.length };
  });
}

/* ------------------------------ interaction (8) ------------------------------ */

export async function click(
  driver: BrowserDriver,
  args: { target?: TargetSelector; uid?: DriverUid; selector?: string; button?: "left" | "right" | "middle"; clickCount?: number },
): Promise<{ clicked: true; x: number; y: number }> {
  return withPage(driver, args.target, async (page) => {
    const { x, y } = await page.click(locatorOf(args), { button: args.button ?? "left", clickCount: args.clickCount ?? 1 });
    return { clicked: true, x, y };
  });
}

export async function hover(driver: BrowserDriver, args: { target?: TargetSelector; uid?: DriverUid; selector?: string }): Promise<{ hovered: true; x: number; y: number }> {
  return withPage(driver, args.target, async (page) => {
    const { x, y } = await page.hover(locatorOf(args));
    return { hovered: true, x, y };
  });
}

export async function drag(
  driver: BrowserDriver,
  args: { target?: TargetSelector; from: { uid?: DriverUid; selector?: string }; to: { uid?: DriverUid; selector?: string } },
): Promise<{ dragged: true; from: { x: number; y: number }; to: { x: number; y: number } }> {
  if (!args.from || !args.to) throw new SharedToolError("drag requires { from } and { to }");
  return withPage(driver, args.target, async (page) => {
    const { from, to } = await page.drag(locatorOf(args.from), locatorOf(args.to));
    return { dragged: true, from, to };
  });
}

export async function fill(driver: BrowserDriver, args: { target?: TargetSelector; uid?: DriverUid; selector?: string; value: string }): Promise<{ filled: true; value: string }> {
  if (typeof args.value !== "string") throw new SharedToolError("fill requires a string { value }");
  return withPage(driver, args.target, async (page) => {
    await page.setValue(locatorOf(args), args.value);
    return { filled: true, value: args.value };
  });
}

export async function fillForm(
  driver: BrowserDriver,
  args: { target?: TargetSelector; fields: Array<{ uid?: DriverUid; selector?: string; value: string }> },
): Promise<{ filled: number; fields: number }> {
  if (!Array.isArray(args.fields) || args.fields.length === 0) throw new SharedToolError("fill_form requires a non-empty { fields } array");
  return withPage(driver, args.target, async (page) => {
    let filled = 0;
    for (const f of args.fields) {
      if (typeof f.value !== "string") throw new SharedToolError("each fill_form field requires a string value");
      await page.setValue(locatorOf(f), f.value);
      filled++;
    }
    return { filled, fields: args.fields.length };
  });
}

export async function typeText(driver: BrowserDriver, args: { target?: TargetSelector; uid?: DriverUid; selector?: string; text: string }): Promise<{ typed: true; text: string }> {
  if (typeof args.text !== "string") throw new SharedToolError("type_text requires a string { text }");
  return withPage(driver, args.target, async (page) => {
    await page.typeText(locatorOf(args), args.text);
    return { typed: true, text: args.text };
  });
}

export async function pressKey(driver: BrowserDriver, args: { target?: TargetSelector; key: string; modifiers?: string[] }): Promise<{ pressed: string; modifiers: string[] }> {
  if (typeof args.key !== "string" || !args.key.length) throw new SharedToolError("press_key requires a non-empty { key }");
  const modifiers = args.modifiers ?? [];
  return withPage(driver, args.target, async (page) => {
    await page.pressKey({ key: args.key, modifiers });
    return { pressed: args.key, modifiers };
  });
}

export async function uploadFile(driver: BrowserDriver, args: { target?: TargetSelector; uid?: DriverUid; selector?: string; files: string | string[] }): Promise<{ uploaded: string[] }> {
  const files = Array.isArray(args.files) ? args.files : [args.files];
  if (!files.length || files.some((f) => typeof f !== "string" || !f.length)) {
    throw new SharedToolError("upload_file requires { files } as a non-empty path or array of paths");
  }
  return withPage(driver, args.target, async (page) => {
    await page.setFiles(locatorOf(args), files);
    return { uploaded: files };
  });
}

/* -------------------------- screenshot + emulation (3) -------------------------- */

function stamp(): string {
  return new Date(Date.now()).toISOString().replace(/[:.]/g, "-");
}

export async function takeScreenshot(
  driver: BrowserDriver,
  args: {
    target?: TargetSelector; format?: "png" | "jpeg"; quality?: number; fullPage?: boolean;
    uid?: DriverUid; selector?: string; savePath?: string; returnBase64?: boolean;
  } = {},
): Promise<{ path: string; bytes: number; format: "png" | "jpeg"; target: { id: string; url: string; title: string }; base64?: string }> {
  if ((args.uid !== undefined && args.uid !== "") && args.selector) throw new SharedToolError("provide exactly one of uid or selector, not both");
  const format = args.format ?? "png";
  return withPage(driver, args.target, async (page) => {
    const clip = args.uid !== undefined || args.selector ? locatorOf(args) : undefined;
    const { data, format: outFormat } = await page.screenshot({ format, quality: args.quality, fullPage: args.fullPage, ...(clip ? { clip } : {}) });
    if (data.byteLength === 0) throw new SharedToolError("captureScreenshot returned empty data");
    await mkdir(ARTIFACT_DIR, { recursive: true });
    const ext = outFormat === "jpeg" ? "jpg" : "png";
    const path = args.savePath ?? join(ARTIFACT_DIR, `screenshot-${page.info.id.slice(0, 8)}-${stamp()}.${ext}`);
    await writeFile(path, Buffer.from(data));
    const result: { path: string; bytes: number; format: "png" | "jpeg"; target: { id: string; url: string; title: string }; base64?: string } = {
      path, bytes: data.byteLength, format: outFormat, target: target3(page.info),
    };
    if (args.returnBase64) result.base64 = Buffer.from(data).toString("base64");
    return result;
  });
}

export async function emulate(
  driver: BrowserDriver,
  args: {
    target?: TargetSelector; width?: number; height?: number; deviceScaleFactor?: number; mobile?: boolean;
    userAgent?: string; cpuThrottlingRate?: number; media?: string; mediaFeatures?: Array<{ name: string; value: string }>;
    networkConditions?: { offline?: boolean; latency?: number; downloadThroughput?: number; uploadThroughput?: number; connectionType?: string };
    clearOverrides?: boolean;
  } = {},
): Promise<{ target: { id: string; url: string; title: string }; applied: string[]; cleared?: boolean }> {
  return withPage(driver, args.target, async (page) => {
    if (args.clearOverrides) {
      await page.emulate({ clearOverrides: true });
      return { target: target3(page.info), applied: [], cleared: true };
    }
    const { applied } = await page.emulate(args);
    if (applied.length === 0) throw new SharedToolError("emulate: no overrides specified (pass clearOverrides:true to reset)");
    return { target: target3(page.info), applied };
  });
}

export async function resizePage(
  driver: BrowserDriver,
  args: { target?: TargetSelector; width: number; height: number; deviceScaleFactor?: number; mobile?: boolean },
): Promise<{ target: { id: string; url: string; title: string }; width: number; height: number; innerWidth: number; innerHeight: number }> {
  if (!Number.isFinite(args.width) || !Number.isFinite(args.height) || args.width <= 0 || args.height <= 0) {
    throw new SharedToolError("resize_page requires positive numeric width and height");
  }
  return withPage(driver, args.target, async (page) => {
    await page.emulate({ width: args.width, height: args.height, deviceScaleFactor: args.deviceScaleFactor, mobile: args.mobile });
    const v = (await page.evaluate("({ w: window.innerWidth, h: window.innerHeight })")) as { w?: number; h?: number } | undefined;
    return { target: target3(page.info), width: args.width, height: args.height, innerWidth: v?.w ?? args.width, innerHeight: v?.h ?? args.height };
  });
}

/* ---------------------------------- dialogs (1) ---------------------------------- */

export async function handleDialog(
  driver: BrowserDriver,
  args: { target?: TargetSelector; accept: boolean; promptText?: string; timeoutMs?: number; autoMs?: number },
): Promise<unknown> {
  if (args.accept === undefined) throw new SharedToolError("handle_dialog requires { accept }");
  return withPage(driver, args.target, (page) => page.handleDialog(args.accept, args.promptText, { timeoutMs: args.timeoutMs, autoMs: args.autoMs }));
}

/* ------------------------------------- registry ------------------------------------- */

/** The 20 tools this file unifies, importable by both src/index.ts (Chrome) and
 *  src/firefox-tools.ts (Firefox). Each function is (driver, args) => Promise<result>. */
export const SHARED_TOOLS = {
  list_pages: listPages,
  new_page: newPage,
  close_page: closePage,
  select_page: selectPage,
  navigate_page: navigatePage,
  wait_for: waitForText,
  evaluate_script: evaluateScript,
  take_snapshot: takeSnapshot,
  click,
  hover,
  drag,
  fill,
  fill_form: fillForm,
  type_text: typeText,
  press_key: pressKey,
  upload_file: uploadFile,
  take_screenshot: takeScreenshot,
  emulate,
  resize_page: resizePage,
  handle_dialog: handleDialog,
} satisfies Record<string, (driver: BrowserDriver, args: never) => Promise<unknown>>;
