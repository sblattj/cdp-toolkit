/**
 * CDP implementation of the browser-neutral Driver contract in ../driver.ts (ADR-001). A thin
 * wrapper: every command goes over client.ts's CdpConnection, so the per-command timeout that
 * prevents a wedged-tab hang applies exactly as in tools/. lifetime is "per-call": page() opens
 * one connection via openPage and holds it for the PageDriver's life; release() closes it. Uid
 * codec (scheme "cdp"): `cdp:<backendDOMNodeId>`, or a bare legacy numeric uid, per THE UID CODEC block in ../driver.ts.
 */
import { type CdpConnection, CdpError, listTargets, openBrowser, openPage, resolveTarget } from "../client.ts";
import type { Target, TargetSelector } from "../types.ts";
import { resolveUid } from "../tools/snapshot.ts";
import { buildFulfillParams, effectiveAction, selectRule } from "../tools/network_mock.ts";
import {
  LEGACY_NUMERIC_UID, type BrowserDriver, type Capability, type DialogInfo, type DriverError, type DriverErrorCode, type DriverEvent,
  type DriverUid, type ElementLocator, type EmulationOptions, type InterceptRule, type KeyPress, type LifetimeModel, type MouseButtonOptions,
  type NavigateOptions, type NavigateResult, type PageDriver, type PageInfo, type ScreenshotOptions, type SnapshotNode, type UidStability,
} from "../driver.ts";
/* ------------------------------ error + uid codec ------------------------------ */
function driverError(code: DriverErrorCode, message: string, data?: unknown): DriverError {
  return Object.assign(new Error(message), { code, ...(data !== undefined ? { data } : {}) }) as DriverError;
}
function encodeUid(backendNodeId: number): DriverUid {
  return `cdp:${backendNodeId}`;
}
/** Accepts `cdp:<digits>` and, per the LEGACY rule, a bare numeric uid. */
function decodeUid(uid: DriverUid): number {
  if (LEGACY_NUMERIC_UID.test(uid)) return Number(uid);
  if (!uid.startsWith("cdp:")) throw driverError("foreign-uid", `uid is not owned by the cdp driver: ${uid}`);
  const n = Number(uid.slice(4));
  if (!Number.isSafeInteger(n) || n <= 0) throw driverError("foreign-uid", `malformed cdp uid payload: ${uid}`);
  return n;
}
/* ---------------------- copied helpers, see attributions below ---------------------- */
// Copied verbatim from src/tools/input.ts `centerOf`: scroll into view, read viewport-space center.
async function centerOf(conn: CdpConnection, objectId: string): Promise<{ x: number; y: number }> {
  const fn = "function(){this.scrollIntoView({block:'center',inline:'center'});const r=this.getBoundingClientRect();if(r.width===0&&r.height===0)return null;return {x:r.left+r.width/2,y:r.top+r.height/2};}";
  const { result, exceptionDetails } = await conn.send<{ result: { value?: { x: number; y: number } | null }; exceptionDetails?: { text?: string } }>(
    "Runtime.callFunctionOn", { objectId, functionDeclaration: fn, returnByValue: true },
  );
  if (exceptionDetails) throw driverError("page-error", `could not measure element: ${exceptionDetails.text ?? "error"}`);
  if (!result.value) throw driverError("page-error", "element has zero size / is not visible; cannot compute a click point");
  return result.value;
}
async function focusElement(conn: CdpConnection, objectId: string): Promise<void> {
  await conn.send("Runtime.callFunctionOn", { objectId, functionDeclaration: "function(){this.focus&&this.focus();}", returnByValue: true });
}
// Copied verbatim (behaviorally) from src/tools/input.ts `setValue`. CRITICAL: must stay
// byte-identical to input.ts; see the side-by-side quote in the driver report.
async function setValueOnObject(conn: CdpConnection, objectId: string, value: string): Promise<void> {
  await focusElement(conn, objectId);
  const fn = "function(){if('value'in this){this.value='';this.dispatchEvent(new Event('input',{bubbles:true}));}else if(this.isContentEditable){this.textContent='';}}";
  await conn.send("Runtime.callFunctionOn", { objectId, functionDeclaration: fn, returnByValue: true });
  if (value.length) await conn.send("Input.insertText", { text: value });
}
interface KeySpec { key: string; code: string; keyCode: number; text?: string }
// Copied verbatim from src/tools/input.ts `NAMED_KEYS`.
const NAMED_KEYS: Record<string, KeySpec> = {
  enter: { key: "Enter", code: "Enter", keyCode: 13, text: "\r" }, return: { key: "Enter", code: "Enter", keyCode: 13, text: "\r" },
  tab: { key: "Tab", code: "Tab", keyCode: 9 }, escape: { key: "Escape", code: "Escape", keyCode: 27 }, esc: { key: "Escape", code: "Escape", keyCode: 27 },
  backspace: { key: "Backspace", code: "Backspace", keyCode: 8 }, delete: { key: "Delete", code: "Delete", keyCode: 46 },
  space: { key: " ", code: "Space", keyCode: 32, text: " " },
  arrowup: { key: "ArrowUp", code: "ArrowUp", keyCode: 38 }, arrowdown: { key: "ArrowDown", code: "ArrowDown", keyCode: 40 },
  arrowleft: { key: "ArrowLeft", code: "ArrowLeft", keyCode: 37 }, arrowright: { key: "ArrowRight", code: "ArrowRight", keyCode: 39 },
  up: { key: "ArrowUp", code: "ArrowUp", keyCode: 38 }, down: { key: "ArrowDown", code: "ArrowDown", keyCode: 40 },
  left: { key: "ArrowLeft", code: "ArrowLeft", keyCode: 37 }, right: { key: "ArrowRight", code: "ArrowRight", keyCode: 39 },
  home: { key: "Home", code: "Home", keyCode: 36 }, end: { key: "End", code: "End", keyCode: 35 },
  pageup: { key: "PageUp", code: "PageUp", keyCode: 33 }, pagedown: { key: "PageDown", code: "PageDown", keyCode: 34 },
};
const MODIFIER_BITS: Record<string, number> = { alt: 1, control: 2, ctrl: 2, meta: 4, cmd: 4, command: 4, shift: 8 };
// Copied verbatim from src/tools/input.ts `resolveKey`.
function resolveKey(key: string): KeySpec {
  const named = NAMED_KEYS[key.toLowerCase()];
  if (named) return named;
  if (key.length === 1) {
    const upper = key.toUpperCase();
    const isLetter = upper >= "A" && upper <= "Z";
    const isDigit = key >= "0" && key <= "9";
    const code = isLetter ? `Key${upper}` : isDigit ? `Digit${key}` : `Key${upper}`;
    return { key, code, keyCode: upper.charCodeAt(0), text: key };
  }
  throw driverError("page-error", `unknown key '${key}' (use a named key like Enter/Tab/ArrowDown or a single character)`);
}
interface RemoteObject { type: string; value?: unknown; unserializableValue?: string; description?: string }
interface ExceptionDetails { text?: string; exception?: RemoteObject }
function unwrap(obj: RemoteObject): unknown {
  if (Object.prototype.hasOwnProperty.call(obj, "value")) return obj.value;
  if (obj.unserializableValue !== undefined) return obj.unserializableValue;
  return obj.type === "undefined" ? undefined : (obj.description ?? null);
}
function exceptionMessage(details: ExceptionDetails): string {
  const ex = details.exception;
  const fromObject = ex?.description ?? (typeof ex?.value === "string" ? ex.value : ex?.value !== undefined ? JSON.stringify(ex.value) : undefined);
  return fromObject ?? details.text ?? "evaluation threw";
}
/* -------------------------- AX-tree walk (snapshot) -------------------------- */
interface AxValue { type?: string; value?: unknown }
interface AxProperty { name: string; value?: AxValue }
interface AxNode {
  nodeId: string; ignored?: boolean; role?: AxValue; name?: AxValue; value?: AxValue;
  properties?: AxProperty[]; childIds?: string[]; backendDOMNodeId?: number; parentId?: string;
}
const INTERACTIVE_ROLES = new Set<string>([
  "button", "link", "textbox", "searchbox", "checkbox", "radio", "combobox",
  "listbox", "option", "menuitem", "menuitemcheckbox", "menuitemradio",
  "tab", "switch", "slider", "spinbutton", "textfield",
]);
function axString(v: AxValue | undefined): string | undefined {
  if (!v || v.value === undefined || v.value === null) return undefined;
  const s = String(v.value).trim();
  return s.length ? s : undefined;
}
function propValue(node: AxNode, name: string): string | undefined {
  return axString(node.properties?.find((p) => p.name === name)?.value);
}
function isInteractive(role: string | undefined): boolean {
  return !!role && (INTERACTIVE_ROLES.has(role) || INTERACTIVE_ROLES.has(role.toLowerCase()));
}
function axExtras(node: AxNode): Record<string, string> {
  const extras: Record<string, string> = {};
  const value = axString(node.value);
  if (value) extras.value = value;
  for (const k of ["checked", "expanded", "url"] as const) {
    const v = propValue(node, k);
    if (v && v !== "false") extras[k] = v;
  }
  if (propValue(node, "disabled") === "true") extras.disabled = "true";
  return extras;
}
/* ------------------------------- locator helpers ------------------------------- */
// css branch copied from src/tools/input.ts `resolveElement`; uid/text/xpath branches are new.
async function resolveElementLocator(conn: CdpConnection, loc: ElementLocator): Promise<{ objectId: string }> {
  if ("uid" in loc) {
    return resolveUid(conn, decodeUid(loc.uid)).catch(() => {
      throw driverError("stale-uid", `uid does not resolve: ${loc.uid}`);
    });
  }
  if ("css" in loc) {
    const { result, exceptionDetails } = await conn.send<{ result: { objectId?: string; subtype?: string }; exceptionDetails?: { text?: string } }>(
      "Runtime.evaluate", { expression: `document.querySelector(${JSON.stringify(loc.css)})`, returnByValue: false },
    );
    if (exceptionDetails) throw driverError("page-error", `css '${loc.css}' evaluation failed: ${exceptionDetails.text ?? "error"}`);
    if (!result.objectId || result.subtype === "null") throw driverError("no-such-element", `css '${loc.css}' matched no element`);
    return { objectId: result.objectId };
  }
  const backendNodeId = await searchLocate(conn, "xpath" in loc ? loc.xpath : loc.text);
  return resolveUid(conn, backendNodeId).catch(() => {
    throw driverError("stale-uid", "text/xpath match no longer resolves");
  });
}

/**
 * locate.text / locate.xpath: DOM.performSearch accepts plain text, a CSS selector, or an
 * XPath expression and disambiguates them itself. Not copied from any tools/ module (none
 * implement this); built only on the client primitives per CONTRACT.md rule 2.
 */
async function searchLocate(conn: CdpConnection, query: string): Promise<number> {
  await conn.send("DOM.getDocument", { depth: 0 }).catch(() => undefined);
  const { searchId, resultCount } = await conn.send<{ searchId: string; resultCount: number }>("DOM.performSearch", { query });
  try {
    if (!resultCount) throw driverError("no-such-element", `locator matched nothing: ${query}`);
    const { nodeIds } = await conn.send<{ nodeIds: number[] }>("DOM.getSearchResults", { searchId, fromIndex: 0, toIndex: 1 });
    const nodeId = nodeIds[0];
    if (nodeId === undefined) throw driverError("no-such-element", `locator matched nothing: ${query}`);
    const { node } = await conn.send<{ node: { backendNodeId: number } }>("DOM.describeNode", { nodeId });
    return node.backendNodeId;
  } finally {
    await conn.send("DOM.discardSearchResults", { searchId }).catch(() => undefined);
  }
}

async function backendNodeIdOf(conn: CdpConnection, loc: ElementLocator): Promise<number> {
  if ("uid" in loc) return decodeUid(loc.uid);
  if ("css" in loc) {
    const { objectId } = await resolveElementLocator(conn, loc);
    const { node } = await conn.send<{ node: { backendNodeId: number } }>("DOM.describeNode", { objectId });
    return node.backendNodeId;
  }
  return searchLocate(conn, "xpath" in loc ? loc.xpath : loc.text);
}
async function fullPageClip(conn: CdpConnection): Promise<{ x: number; y: number; width: number; height: number }> {
  const m = await conn.send<{ cssContentSize?: { width: number; height: number }; contentSize?: { width: number; height: number } }>("Page.getLayoutMetrics");
  const size = m.cssContentSize ?? m.contentSize;
  if (!size) throw driverError("page-error", "Page.getLayoutMetrics returned no content size");
  return { x: 0, y: 0, width: Math.ceil(size.width), height: Math.ceil(size.height) };
}
async function elementClip(conn: CdpConnection, loc: ElementLocator): Promise<{ x: number; y: number; width: number; height: number }> {
  const backendNodeId = await backendNodeIdOf(conn, loc);
  await conn.send("DOM.scrollIntoViewIfNeeded", { backendNodeId }).catch(() => undefined);
  const box = await conn.send<{ model: { content: number[] } }>("DOM.getBoxModel", { backendNodeId });
  const q = box.model.content;
  const xs = [q[0], q[2], q[4], q[6]].filter((n): n is number => n != null);
  const ys = [q[1], q[3], q[5], q[7]].filter((n): n is number => n != null);
  if (!xs.length || !ys.length) throw driverError("page-error", "DOM.getBoxModel returned an empty content quad");
  const minX = Math.min(...xs), minY = Math.min(...ys);
  const width = Math.ceil(Math.max(...xs) - minX), height = Math.ceil(Math.max(...ys) - minY);
  if (width <= 0 || height <= 0) throw driverError("page-error", "resolved element has zero area");
  return { x: minX, y: minY, width, height };
}
/**
 * Chrome capabilities. network.responseBodyPostHoc is deliberately NOT declared: the Network
 * domain is enabled lazily (only by startBodyCapture/intercept), so a body is only readable for
 * a request that occurred after something armed capture first. That is arming by another name,
 * not "not armed in advance", so an honest capability set omits it rather than reading true by
 * construction. locate.text/locate.xpath both ride DOM.performSearch (see searchLocate above),
 * which is a real Chrome capability, not a line-budget artifact, so both ARE declared.
 */
const CDP_CAPABILITIES: ReadonlySet<Capability> = new Set<Capability>([
  "trace.performance", "heap.snapshot", "audit.lighthouse", "emulate.cpuThrottling",
  "emulate.mediaFeatures", "emulate.deviceMetrics", "emulate.networkConditions",
  "screenshot.fullPage", "screenshot.element", "network.intercept",
  "snapshot.accessibilityTree", "input.insertTextAtomic", "locate.text", "locate.xpath",
]);
/* ---------------------------------- PageDriver ---------------------------------- */
class CdpPageDriver implements PageDriver {
  readonly info: PageInfo;
  private readonly enabledDomains = new Set<string>(["Page", "Runtime"]);
  private released = false;
  constructor(private readonly conn: CdpConnection, target: Target, readonly browser: BrowserDriver) {
    this.info = { id: target.id, url: target.url, title: target.title };
  }
  private async ensureDomain(name: string): Promise<void> {
    if (this.enabledDomains.has(name)) return;
    this.enabledDomains.add(name);
    await this.conn.send(`${name}.enable`);
  }
  async navigate(opts: NavigateOptions): Promise<NavigateResult> {
    const reload = opts.reload === true;
    if (!reload && !opts.url) throw driverError("page-error", "navigate: 'url' is required unless reload:true");
    const waitUntil = opts.waitUntil ?? "load";
    const milestoneMethod = waitUntil === "load" ? "Page.loadEventFired" : "Page.domContentEventFired";
    const milestone = this.conn.waitFor(milestoneMethod, undefined, opts.timeoutMs).then(() => waitUntil as NavigateResult["waitedFor"]).catch(() => undefined);
    const stopped = this.conn.waitFor("Page.frameStoppedLoading", undefined, opts.timeoutMs).then(() => "committed" as NavigateResult["waitedFor"]).catch(() => undefined);
    let url: string, contextId: string, reloaded: boolean | undefined;
    if (reload) {
      await this.conn.send("Page.reload", { ignoreCache: opts.ignoreCache === true }, opts.timeoutMs ? { timeoutMs: opts.timeoutMs } : {});
      const tree = await this.conn.send<{ frameTree?: { frame?: { id?: string; url?: string } } }>("Page.getFrameTree").catch(() => undefined);
      contextId = tree?.frameTree?.frame?.id ?? "";
      url = tree?.frameTree?.frame?.url ?? opts.url ?? "";
      reloaded = true;
    } else {
      const nav = await this.conn.send<{ frameId: string; errorText?: string }>("Page.navigate", { url: opts.url }, opts.timeoutMs ? { timeoutMs: opts.timeoutMs } : {});
      if (nav.errorText) throw driverError("page-error", `navigate: ${nav.errorText} (${opts.url})`);
      contextId = nav.frameId;
      url = opts.url as string;
    }
    const settled = await Promise.race([milestone, stopped]);
    // "timeout" here means the navigation already committed (Page.navigate/reload resolved) but
    // no load/domcontentloaded milestone arrived before opts.timeoutMs; it is NOT the navigate
    // call itself timing out. NavigateResult.waitedFor's vocabulary is BiDi-shaped (BiDi's
    // navigate takes an explicit readiness state) rather than CDP-native, so this is the
    // closest honest mapping onto CDP's milestone events.
    return { url, contextId, ...(reloaded ? { reloaded } : {}), waitedFor: settled ?? "timeout" };
  }
  async waitForText(text: string, timeoutMs = 15_000): Promise<{ found: true; elapsedMs: number }> {
    const start = Date.now();
    const expr = `(() => { const b = document.body; return !!b && typeof b.innerText === 'string' && b.innerText.includes(${JSON.stringify(text)}); })()`;
    for (;;) {
      const { result } = await this.conn.send<{ result: { value?: unknown } }>("Runtime.evaluate", { expression: expr, returnByValue: true });
      if (result?.value === true) return { found: true, elapsedMs: Date.now() - start };
      if (Date.now() - start >= timeoutMs) throw driverError("timeout", `waitForText: '${text}' not found within ${timeoutMs}ms`);
      await new Promise((r) => setTimeout(r, Math.min(250, Math.max(0, timeoutMs - (Date.now() - start)))));
    }
  }
  private async callFn(objectId: string, functionDeclaration: string, args: readonly unknown[], awaitPromise: boolean): Promise<unknown> {
    const res = await this.conn.send<{ result: RemoteObject; exceptionDetails?: ExceptionDetails }>(
      "Runtime.callFunctionOn", { objectId, functionDeclaration, arguments: args.map((value) => ({ value })), returnByValue: true, awaitPromise },
    );
    if (res.exceptionDetails) throw driverError("page-error", exceptionMessage(res.exceptionDetails));
    return unwrap(res.result);
  }
  async evaluate(expression: string, opts?: { args?: readonly unknown[]; awaitPromise?: boolean }): Promise<unknown> {
    const awaitPromise = opts?.awaitPromise ?? true;
    if (opts?.args && opts.args.length > 0) {
      const globalObj = await this.conn.send<{ result: { objectId?: string } }>("Runtime.evaluate", { expression: "globalThis", returnByValue: false });
      const objectId = globalObj.result.objectId;
      if (!objectId) throw driverError("page-error", "could not resolve global object for function call");
      return this.callFn(objectId, expression, opts.args, awaitPromise);
    }
    const res = await this.conn.send<{ result: RemoteObject; exceptionDetails?: ExceptionDetails }>("Runtime.evaluate", { expression, returnByValue: true, awaitPromise });
    if (res.exceptionDetails) throw driverError("page-error", exceptionMessage(res.exceptionDetails));
    return unwrap(res.result);
  }
  async callOnElement(loc: ElementLocator, functionDeclaration: string, args: readonly unknown[] = []): Promise<unknown> {
    const { objectId } = await resolveElementLocator(this.conn, loc);
    return this.callFn(objectId, functionDeclaration, args, true);
  }
  async snapshot(opts?: { interactiveOnly?: boolean }): Promise<SnapshotNode[]> {
    const interactiveOnly = opts?.interactiveOnly ?? false;
    await this.ensureDomain("Accessibility");
    const { nodes } = await this.conn.send<{ nodes: AxNode[] }>("Accessibility.getFullAXTree");
    const byId = new Map<string, AxNode>();
    for (const n of nodes) byId.set(n.nodeId, n);
    const roots = nodes.filter((n) => !n.parentId || !byId.has(n.parentId));
    const out: SnapshotNode[] = [];
    const walk = (node: AxNode, depth: number): void => {
      const role = axString(node.role);
      const name = axString(node.name);
      const backendNodeId = node.backendDOMNodeId;
      if (!node.ignored && backendNodeId !== undefined && (interactiveOnly ? isInteractive(role) : !!(role || name))) {
        const extras = axExtras(node);
        out.push({ uid: encodeUid(backendNodeId), role: role ?? "generic", depth, ...(name ? { name } : {}), ...(Object.keys(extras).length ? { extras } : {}) });
      }
      for (const childId of node.childIds ?? []) {
        const child = byId.get(childId);
        if (child) walk(child, depth + 1);
      }
    };
    for (const root of roots) walk(root, 0);
    return out;
  }
  async locate(loc: ElementLocator): Promise<DriverUid> {
    return encodeUid(await backendNodeIdOf(this.conn, loc));
  }
  async resolve(uid: DriverUid): Promise<void> {
    await resolveUid(this.conn, decodeUid(uid)).catch(() => {
      throw driverError("stale-uid", `uid does not resolve: ${uid}`);
    });
  }
  // Copied verbatim from src/tools/input.ts `hover`.
  async hover(loc: ElementLocator): Promise<{ x: number; y: number }> {
    const { objectId } = await resolveElementLocator(this.conn, loc);
    const { x, y } = await centerOf(this.conn, objectId);
    await this.conn.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
    return { x, y };
  }
  // Copied dispatch sequence verbatim from src/tools/input.ts `click` (its resolve+centerOf+mouseMoved prefix IS hover, reused here).
  async click(loc: ElementLocator, opts?: MouseButtonOptions): Promise<{ x: number; y: number }> {
    const button = opts?.button ?? "left";
    const clickCount = opts?.clickCount ?? 1;
    const { x, y } = await this.hover(loc);
    await this.conn.send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button, clickCount });
    await this.conn.send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button, clickCount });
    return { x, y };
  }
  // Copied dispatch sequence verbatim from src/tools/input.ts `drag` (its "from" prefix IS hover, reused here).
  async drag(from: ElementLocator, to: ElementLocator): Promise<{ from: { x: number; y: number }; to: { x: number; y: number } }> {
    const fromPt = await this.hover(from);
    const { objectId: dstId } = await resolveElementLocator(this.conn, to);
    const toPt = await centerOf(this.conn, dstId);
    await this.conn.send("Input.dispatchMouseEvent", { type: "mousePressed", x: fromPt.x, y: fromPt.y, button: "left", clickCount: 1 });
    await this.conn.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: (fromPt.x + toPt.x) / 2, y: (fromPt.y + toPt.y) / 2, button: "left" });
    await this.conn.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: toPt.x, y: toPt.y, button: "left" });
    await this.conn.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: toPt.x, y: toPt.y, button: "left", clickCount: 1 });
    return { from: fromPt, to: toPt };
  }
  async setValue(loc: ElementLocator, value: string): Promise<void> {
    const { objectId } = await resolveElementLocator(this.conn, loc);
    await setValueOnObject(this.conn, objectId, value);
  }
  async typeText(loc: ElementLocator, text: string): Promise<void> {
    const { objectId } = await resolveElementLocator(this.conn, loc);
    await focusElement(this.conn, objectId);
    if (text.length) await this.conn.send("Input.insertText", { text });
  }
  // Copied dispatch logic verbatim from src/tools/input.ts `pressKey`.
  async pressKey(press: KeyPress): Promise<void> {
    const spec = resolveKey(press.key);
    let modBits = 0;
    for (const m of press.modifiers ?? []) {
      const bit = MODIFIER_BITS[m.toLowerCase()];
      if (bit === undefined) throw driverError("page-error", `unknown modifier '${m}'`);
      modBits |= bit;
    }
    const suppressText = (modBits & ~(MODIFIER_BITS.shift as number)) !== 0;
    const down: Record<string, unknown> = { type: "keyDown", key: spec.key, code: spec.code, windowsVirtualKeyCode: spec.keyCode, nativeVirtualKeyCode: spec.keyCode, modifiers: modBits };
    if (spec.text && !suppressText) down.text = spec.text;
    await this.conn.send("Input.dispatchKeyEvent", down);
    await this.conn.send("Input.dispatchKeyEvent", { type: "keyUp", key: spec.key, code: spec.code, windowsVirtualKeyCode: spec.keyCode, nativeVirtualKeyCode: spec.keyCode, modifiers: modBits });
  }
  async setFiles(loc: ElementLocator, files: readonly string[]): Promise<void> {
    const { objectId } = await resolveElementLocator(this.conn, loc);
    await this.conn.send("DOM.setFileInputFiles", { files: [...files], objectId });
  }
  async screenshot(opts?: ScreenshotOptions): Promise<{ data: Uint8Array; format: "png" | "jpeg" }> {
    const format = opts?.format ?? "png";
    const quality = format === "jpeg" ? (opts?.quality ?? 80) : undefined;
    const params: Record<string, unknown> = { format, captureBeyondViewport: true };
    if (quality != null) params.quality = quality;
    if (opts?.clip) params.clip = { ...(await elementClip(this.conn, opts.clip)), scale: 1 };
    else if (opts?.fullPage) params.clip = { ...(await fullPageClip(this.conn)), scale: 1 };
    const { data } = await this.conn.send<{ data: string }>("Page.captureScreenshot", params);
    return { data: new Uint8Array(Buffer.from(data, "base64")), format };
  }
  // Adapted from src/tools/emulation.ts `emulate`.
  async emulate(opts: EmulationOptions): Promise<{ applied: string[] }> {
    if (opts.clearOverrides) {
      const c = () => undefined;
      await this.conn.send("Emulation.clearDeviceMetricsOverride").catch(c);
      await this.conn.send("Emulation.setUserAgentOverride", { userAgent: "" }).catch(c);
      await this.conn.send("Emulation.setCPUThrottlingRate", { rate: 1 }).catch(c);
      await this.conn.send("Emulation.setEmulatedMedia", { media: "", features: [] }).catch(c);
      await this.ensureDomain("Network").catch(c);
      await this.conn.send("Network.emulateNetworkConditions", { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 }).catch(c);
      return { applied: [] };
    }
    const applied: string[] = [];
    if (opts.width != null && opts.height != null) {
      await this.conn.send("Emulation.setDeviceMetricsOverride", {
        width: opts.width,
        height: opts.height,
        deviceScaleFactor: opts.deviceScaleFactor ?? 0,
        mobile: opts.mobile ?? false,
      });
      applied.push("deviceMetrics");
    }
    if (opts.userAgent != null) {
      await this.conn.send("Emulation.setUserAgentOverride", { userAgent: opts.userAgent });
      applied.push("userAgent");
    }
    if (opts.cpuThrottlingRate != null) {
      await this.conn.send("Emulation.setCPUThrottlingRate", { rate: opts.cpuThrottlingRate });
      applied.push("cpuThrottlingRate");
    }
    if (opts.media != null || opts.mediaFeatures != null) {
      await this.conn.send("Emulation.setEmulatedMedia", { media: opts.media ?? "", features: opts.mediaFeatures ?? [] });
      applied.push("mediaFeatures");
    }
    if (opts.networkConditions != null) {
      const n = opts.networkConditions;
      // Network domain must be enabled before emulateNetworkConditions; enabled lazily here,
      // not by page(), so a caller that never emulates network conditions never pays for it.
      await this.ensureDomain("Network");
      await this.conn.send("Network.emulateNetworkConditions", {
        offline: n.offline ?? false,
        latency: n.latency ?? 0,
        downloadThroughput: n.downloadThroughput ?? -1,
        uploadThroughput: n.uploadThroughput ?? -1,
      });
      applied.push("networkConditions");
    }
    return { applied };
  }
  private static readonly EVENT_MAP: Record<DriverEvent, { method: string; domain?: string }> = {
    navigated: { method: "Page.frameNavigated" }, console: { method: "Runtime.consoleAPICalled" },
    "network.request": { method: "Network.requestWillBeSent", domain: "Network" },
    "network.response": { method: "Network.responseReceived", domain: "Network" },
    dialog: { method: "Page.javascriptDialogOpening" }, "page.closed": { method: "Inspector.detached", domain: "Inspector" },
  };
  on(event: DriverEvent, handler: (payload: Record<string, unknown>) => void): () => void {
    const spec = CdpPageDriver.EVENT_MAP[event];
    if (spec.domain && !this.enabledDomains.has(spec.domain)) {
      this.enabledDomains.add(spec.domain);
      void this.conn.send(`${spec.domain}.enable`);
    }
    return this.conn.on(spec.method, (params) => handler(params));
  }
  async waitForEvent(event: DriverEvent, predicate?: (p: Record<string, unknown>) => boolean, timeoutMs?: number): Promise<Record<string, unknown>> {
    const spec = CdpPageDriver.EVENT_MAP[event];
    if (spec.domain) await this.ensureDomain(spec.domain);
    return this.conn.waitFor<Record<string, unknown>>(spec.method, predicate, timeoutMs);
  }
  // Adapted from src/tools/dialogs.ts `armDialogHandler` / `handleDialog`.
  async handleDialog(accept: boolean, promptText?: string): Promise<DialogInfo> {
    await this.ensureDomain("Page");
    return new Promise<DialogInfo>((resolve, reject) => {
      const timer = setTimeout(() => {
        off();
        reject(driverError("timeout", "handleDialog: no dialog opened within 15000ms"));
      }, 15_000);
      const off = this.conn.on("Page.javascriptDialogOpening", (params) => {
        const p = params as { type: string; message: string; url: string; defaultPrompt?: string };
        clearTimeout(timer);
        off();
        void this.conn.send("Page.handleJavaScriptDialog", { accept, ...(promptText !== undefined ? { promptText } : {}) })
          .then(() => resolve({ type: p.type, message: p.message, url: p.url, ...(p.defaultPrompt !== undefined ? { defaultPrompt: p.defaultPrompt } : {}) }))
          .catch(reject);
      });
    });
  }
  async startBodyCapture(): Promise<() => Promise<void>> {
    await this.ensureDomain("Network");
    return async () => {
      await this.conn.send("Network.disable").catch(() => undefined);
      this.enabledDomains.delete("Network");
    };
  }
  async getResponseBody(requestId: string): Promise<{ body: string; base64Encoded: boolean }> {
    return this.conn.send<{ body: string; base64Encoded: boolean }>("Network.getResponseBody", { requestId });
  }
  // Adapted from src/tools/network_mock.ts `registerHandler`, reusing its exported pure-logic layer.
  async intercept(rules: readonly InterceptRule[]): Promise<() => Promise<void>> {
    await this.conn.send("Fetch.enable", { patterns: rules.map((r) => ({ urlPattern: r.urlPattern })) });
    let chain = Promise.resolve();
    const off = this.conn.on("Fetch.requestPaused", (params) => {
      const p = params as { requestId: string; request: { url: string; method: string } };
      chain = chain
        .then(async () => {
          const rule = selectRule(rules as Array<InterceptRule & { urlPattern: string }>, p.request.url, p.request.method);
          if (!rule) {
            await this.conn.send("Fetch.continueRequest", { requestId: p.requestId });
            return;
          }
          if (rule.delayMs) await new Promise((r) => setTimeout(r, rule.delayMs));
          const act = effectiveAction(rule, Math.random());
          if (act === "fulfill") await this.conn.send("Fetch.fulfillRequest", { ...buildFulfillParams(p.requestId, rule) });
          else if (act === "fail") await this.conn.send("Fetch.failRequest", { requestId: p.requestId, errorReason: rule.errorReason ?? "Failed" });
          else await this.conn.send("Fetch.continueRequest", { requestId: p.requestId });
        })
        .catch(() => undefined);
    });
    return async () => {
      off();
      await this.conn.send("Fetch.disable").catch(() => undefined);
    };
  }
  async release(): Promise<void> {
    if (this.released) return;
    this.released = true;
    this.conn.close();
  }
}
/* --------------------------------- BrowserDriver --------------------------------- */
// Runs fn on a throwaway browser-endpoint connection, always closing it.
async function withBrowserConn<T>(fn: (conn: CdpConnection) => Promise<T>): Promise<T> {
  const conn = await openBrowser();
  try {
    return await fn(conn);
  } finally {
    conn.close();
  }
}
function noSuchTarget(e: unknown): never {
  throw driverError("no-such-target", e instanceof CdpError ? e.message : String(e));
}
class CdpBrowserDriver implements BrowserDriver {
  readonly scheme = "cdp";
  readonly lifetime: LifetimeModel = "per-call";
  readonly capabilities = CDP_CAPABILITIES;
  readonly uidStability: UidStability = "browser-node";
  readonly snapshotFidelity = "accessibility-tree" as const;
  async listPages(): Promise<PageInfo[]> {
    const targets = await listTargets();
    return targets.filter((t) => t.type === "page").map((t) => ({ id: t.id, url: t.url, title: t.title }));
  }
  async newPage(url?: string): Promise<PageInfo> {
    return withBrowserConn(async (conn) => {
      const { targetId } = await conn.send<{ targetId: string }>("Target.createTarget", { url: url ?? "about:blank" });
      if (!targetId) throw driverError("page-error", "Target.createTarget returned no targetId");
      return { id: targetId, url: url ?? "about:blank", title: "" };
    });
  }
  async closePage(id: string): Promise<void> {
    await withBrowserConn((conn) => conn.send("Target.closeTarget", { targetId: id }));
  }
  async activatePage(id: string): Promise<PageInfo> {
    const target = await resolveTarget(id).catch(noSuchTarget);
    await withBrowserConn((conn) => conn.send("Target.activateTarget", { targetId: target.id }));
    return { id: target.id, url: target.url, title: target.title };
  }
  async page(selector: TargetSelector): Promise<PageDriver> {
    const { conn, target } = await openPage(selector).catch(noSuchTarget);
    await conn.send("Page.enable");
    await conn.send("Runtime.enable");
    // Deliberately NOT enabling Network here: "no eager Network.enable hang" is a documented
    // design property of this toolkit, and enabling it on every page() acquisition would cost
    // every caller that never touches the network. Network is enabled lazily instead, only when
    // a Network-dependent path (startBodyCapture, emulate's networkConditions) is actually used.
    return new CdpPageDriver(conn, target, this);
  }
  async dispose(): Promise<void> {}
}
/** Construct the CDP implementation of the frozen Driver contract. */
export function createCdpDriver(): BrowserDriver { return new CdpBrowserDriver(); }
export { CdpBrowserDriver, CdpPageDriver };
/* ------------------------------------------------------------------------------
 * CDP methods/domains used: Target.createTarget/closeTarget/activateTarget; Page.enable/
 * navigate/reload/getFrameTree/loadEventFired/domContentEventFired/frameStoppedLoading/
 * captureScreenshot/getLayoutMetrics/javascriptDialogOpening/handleJavaScriptDialog;
 * Runtime.enable/evaluate/callFunctionOn/consoleAPICalled; Accessibility.enable/getFullAXTree;
 * DOM.resolveNode (via resolveUid)/describeNode/performSearch/getSearchResults/
 * discardSearchResults/scrollIntoViewIfNeeded/getBoxModel/setFileInputFiles/getDocument;
 * Input.dispatchMouseEvent/dispatchKeyEvent/insertText; Emulation.setDeviceMetricsOverride/
 * clearDeviceMetricsOverride/setUserAgentOverride/setCPUThrottlingRate/setEmulatedMedia;
 * Network.enable/disable/emulateNetworkConditions/getResponseBody/requestWillBeSent/
 * responseReceived; Fetch.enable/disable/requestPaused/fulfillRequest/failRequest/
 * continueRequest; Inspector.detached.
 * Parity/behavior notes:
 *   - locate.text/locate.xpath ARE implemented (searchLocate, via DOM.performSearch) and ARE
 *     declared in CDP_CAPABILITIES.
 *   - network.responseBodyPostHoc is NOT declared: Network is enabled lazily (only by
 *     startBodyCapture / emulate's networkConditions branch), never eagerly by page(), so a
 *     body is only readable for a request that occurred after something armed capture first.
 *     That is arming by another name, not "not armed in advance".
 * ---------------------------------------------------------------------------- */
