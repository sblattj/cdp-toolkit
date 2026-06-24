/**
 * Interaction tools: click, hover, drag, fill, fill_form, type_text,
 * press_key, upload_file.
 *
 * Every element-targeting tool accepts exactly one of `{ uid }` (a
 * backendDOMNodeId from take_snapshot) or `{ selector }` (a CSS selector).
 * uid resolves via resolveUid (DOM.resolveNode); selector resolves via
 * Runtime.evaluate(document.querySelector). Both end up as a JS object handle
 * (objectId), then Runtime.callFunctionOn scrolls it into view + reads its
 * bounding-rect center, and we dispatch real input events via
 * Input.dispatchMouseEvent / Input.dispatchKeyEvent. This drives the page the
 * same way a user would, so framework event handlers fire correctly.
 */
import type { CdpConnection } from "../client.ts";
import { CdpError, withPage } from "../client.ts";
import type { TargetSelector, Uid } from "../types.ts";
import { resolveUid } from "./snapshot.ts";

/* --------------------------------- targeting --------------------------------- */

interface ElementTarget {
  uid?: Uid;
  selector?: string;
}

/** Resolve {uid|selector} (exactly one) to a JS object handle on the page. */
async function resolveElement(conn: CdpConnection, t: ElementTarget): Promise<{ objectId: string }> {
  const hasUid = t.uid !== undefined && t.uid !== null;
  const hasSelector = typeof t.selector === "string" && t.selector.length > 0;
  if (hasUid === hasSelector) {
    throw new CdpError("provide exactly one of { uid } or { selector }");
  }
  if (hasUid) {
    return resolveUid(conn, t.uid as Uid);
  }
  // selector path
  const { result, exceptionDetails } = await conn.send<{
    result: { objectId?: string; subtype?: string };
    exceptionDetails?: { text?: string };
  }>("Runtime.evaluate", {
    expression: `document.querySelector(${JSON.stringify(t.selector)})`,
    returnByValue: false,
  });
  if (exceptionDetails) {
    throw new CdpError(`selector '${t.selector}' evaluation failed: ${exceptionDetails.text ?? "error"}`);
  }
  if (!result.objectId || result.subtype === "null") {
    throw new CdpError(`selector '${t.selector}' matched no element`);
  }
  return { objectId: result.objectId };
}

interface Point {
  x: number;
  y: number;
}

/** Scroll the element into view and return its viewport-space center point. */
async function centerOf(conn: CdpConnection, objectId: string): Promise<Point> {
  const { result, exceptionDetails } = await conn.send<{
    result: { value?: Point | null };
    exceptionDetails?: { text?: string };
  }>("Runtime.callFunctionOn", {
    objectId,
    functionDeclaration:
      "function(){this.scrollIntoView({block:'center',inline:'center'});const r=this.getBoundingClientRect();if(r.width===0&&r.height===0)return null;return {x:r.left+r.width/2,y:r.top+r.height/2};}",
    returnByValue: true,
  });
  if (exceptionDetails) {
    throw new CdpError(`could not measure element: ${exceptionDetails.text ?? "error"}`);
  }
  if (!result.value) {
    throw new CdpError("element has zero size / is not visible; cannot compute a click point");
  }
  return result.value;
}

/** Focus an element via its object handle (used by fill / type_text). */
async function focusElement(conn: CdpConnection, objectId: string): Promise<void> {
  await conn.send("Runtime.callFunctionOn", {
    objectId,
    functionDeclaration: "function(){this.focus&&this.focus();}",
    returnByValue: true,
  });
}

/* ----------------------------------- click ----------------------------------- */

export interface ClickArgs extends ElementTarget {
  target?: TargetSelector;
  /** "left" (default) | "right" | "middle". */
  button?: "left" | "right" | "middle";
  /** 1 = single (default), 2 = double-click. */
  clickCount?: number;
}

export async function click(args: ClickArgs): Promise<{ clicked: true; x: number; y: number }> {
  const button = args.button ?? "left";
  const clickCount = args.clickCount ?? 1;
  return withPage(args.target, async (conn) => {
    const { objectId } = await resolveElement(conn, args);
    const { x, y } = await centerOf(conn, objectId);
    await conn.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
    await conn.send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button, clickCount });
    await conn.send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button, clickCount });
    return { clicked: true as const, x, y };
  });
}

/* ----------------------------------- hover ----------------------------------- */

export interface HoverArgs extends ElementTarget {
  target?: TargetSelector;
}

export async function hover(args: HoverArgs): Promise<{ hovered: true; x: number; y: number }> {
  return withPage(args.target, async (conn) => {
    const { objectId } = await resolveElement(conn, args);
    const { x, y } = await centerOf(conn, objectId);
    await conn.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
    return { hovered: true as const, x, y };
  });
}

/* ----------------------------------- drag ------------------------------------ */

export interface DragArgs {
  target?: TargetSelector;
  /** Source element (exactly one of from.uid / from.selector). */
  from: ElementTarget;
  /** Destination element (exactly one of to.uid / to.selector). */
  to: ElementTarget;
}

export async function drag(args: DragArgs): Promise<{ dragged: true; from: Point; to: Point }> {
  if (!args.from || !args.to) throw new CdpError("drag requires { from } and { to }");
  return withPage(args.target, async (conn) => {
    const { objectId: srcId } = await resolveElement(conn, args.from);
    const from = await centerOf(conn, srcId);
    const { objectId: dstId } = await resolveElement(conn, args.to);
    const to = await centerOf(conn, dstId);

    await conn.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: from.x, y: from.y });
    await conn.send("Input.dispatchMouseEvent", {
      type: "mousePressed",
      x: from.x,
      y: from.y,
      button: "left",
      clickCount: 1,
    });
    // Intermediate move so dragstart/dragover fire on the page.
    await conn.send("Input.dispatchMouseEvent", {
      type: "mouseMoved",
      x: (from.x + to.x) / 2,
      y: (from.y + to.y) / 2,
      button: "left",
    });
    await conn.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: to.x, y: to.y, button: "left" });
    await conn.send("Input.dispatchMouseEvent", {
      type: "mouseReleased",
      x: to.x,
      y: to.y,
      button: "left",
      clickCount: 1,
    });
    return { dragged: true as const, from, to };
  });
}

/* ------------------------------ fill / type_text ------------------------------ */

/** Set an element's value by clearing it then inserting text (focus + insertText). */
async function setValue(conn: CdpConnection, objectId: string, value: string): Promise<void> {
  await focusElement(conn, objectId);
  // Clear existing content so fill is an overwrite, then insert the new text.
  await conn.send("Runtime.callFunctionOn", {
    objectId,
    functionDeclaration:
      "function(){if('value'in this){this.value='';this.dispatchEvent(new Event('input',{bubbles:true}));}else if(this.isContentEditable){this.textContent='';}}",
    returnByValue: true,
  });
  if (value.length) {
    await conn.send("Input.insertText", { text: value });
  }
}

export interface FillArgs extends ElementTarget {
  target?: TargetSelector;
  value: string;
}

export async function fill(args: FillArgs): Promise<{ filled: true; value: string }> {
  if (typeof args.value !== "string") throw new CdpError("fill requires a string { value }");
  return withPage(args.target, async (conn) => {
    const { objectId } = await resolveElement(conn, args);
    await setValue(conn, objectId, args.value);
    return { filled: true as const, value: args.value };
  });
}

export interface TypeTextArgs extends ElementTarget {
  target?: TargetSelector;
  text: string;
}

/**
 * type_text — focus then insert text. Unlike fill it does NOT clear first, so
 * it appends to whatever is already focused/present (closest to "typing").
 */
export async function typeText(args: TypeTextArgs): Promise<{ typed: true; text: string }> {
  if (typeof args.text !== "string") throw new CdpError("type_text requires a string { text }");
  return withPage(args.target, async (conn) => {
    const { objectId } = await resolveElement(conn, args);
    await focusElement(conn, objectId);
    if (args.text.length) await conn.send("Input.insertText", { text: args.text });
    return { typed: true as const, text: args.text };
  });
}

/* ---------------------------------- fill_form --------------------------------- */

export interface FillFormField extends ElementTarget {
  value: string;
}

export interface FillFormArgs {
  target?: TargetSelector;
  fields: FillFormField[];
}

export async function fillForm(args: FillFormArgs): Promise<{ filled: number; fields: number }> {
  if (!Array.isArray(args.fields) || args.fields.length === 0) {
    throw new CdpError("fill_form requires a non-empty { fields } array");
  }
  return withPage(args.target, async (conn) => {
    let filled = 0;
    for (const field of args.fields) {
      if (typeof field.value !== "string") {
        throw new CdpError("each fill_form field requires a string value");
      }
      const { objectId } = await resolveElement(conn, field);
      await setValue(conn, objectId, field.value);
      filled++;
    }
    return { filled, fields: args.fields.length };
  });
}

/* ---------------------------------- press_key --------------------------------- */

interface KeySpec {
  key: string;
  code: string;
  keyCode: number;
  /** text to commit (printable keys / Enter newline) */
  text?: string;
}

/** Named-key table: maps friendly names to CDP dispatchKeyEvent fields. */
const NAMED_KEYS: Record<string, KeySpec> = {
  enter: { key: "Enter", code: "Enter", keyCode: 13, text: "\r" },
  return: { key: "Enter", code: "Enter", keyCode: 13, text: "\r" },
  tab: { key: "Tab", code: "Tab", keyCode: 9 },
  escape: { key: "Escape", code: "Escape", keyCode: 27 },
  esc: { key: "Escape", code: "Escape", keyCode: 27 },
  backspace: { key: "Backspace", code: "Backspace", keyCode: 8 },
  delete: { key: "Delete", code: "Delete", keyCode: 46 },
  space: { key: " ", code: "Space", keyCode: 32, text: " " },
  arrowup: { key: "ArrowUp", code: "ArrowUp", keyCode: 38 },
  arrowdown: { key: "ArrowDown", code: "ArrowDown", keyCode: 40 },
  arrowleft: { key: "ArrowLeft", code: "ArrowLeft", keyCode: 37 },
  arrowright: { key: "ArrowRight", code: "ArrowRight", keyCode: 39 },
  up: { key: "ArrowUp", code: "ArrowUp", keyCode: 38 },
  down: { key: "ArrowDown", code: "ArrowDown", keyCode: 40 },
  left: { key: "ArrowLeft", code: "ArrowLeft", keyCode: 37 },
  right: { key: "ArrowRight", code: "ArrowRight", keyCode: 39 },
  home: { key: "Home", code: "Home", keyCode: 36 },
  end: { key: "End", code: "End", keyCode: 35 },
  pageup: { key: "PageUp", code: "PageUp", keyCode: 33 },
  pagedown: { key: "PageDown", code: "PageDown", keyCode: 34 },
};

const MODIFIER_BITS: Record<string, number> = {
  alt: 1,
  control: 2,
  ctrl: 2,
  meta: 4,
  cmd: 4,
  command: 4,
  shift: 8,
};

/** Resolve a key name (named or single printable char) to a KeySpec. */
function resolveKey(key: string): KeySpec {
  const named = NAMED_KEYS[key.toLowerCase()];
  if (named) return named;
  if (key.length === 1) {
    const upper = key.toUpperCase();
    const isLetter = upper >= "A" && upper <= "Z";
    const isDigit = key >= "0" && key <= "9";
    const code = isLetter ? `Key${upper}` : isDigit ? `Digit${key}` : `Key${upper}`;
    const keyCode = upper.charCodeAt(0);
    return { key, code, keyCode, text: key };
  }
  throw new CdpError(`unknown key '${key}' (use a named key like Enter/Tab/ArrowDown or a single character)`);
}

export interface PressKeyArgs {
  target?: TargetSelector;
  /** Key name: "Enter", "Tab", "a", "ArrowDown", etc. */
  key: string;
  /** Modifier names: "Control"/"Ctrl", "Shift", "Alt", "Meta"/"Cmd". */
  modifiers?: string[];
}

export async function pressKey(args: PressKeyArgs): Promise<{ pressed: string; modifiers: string[] }> {
  if (typeof args.key !== "string" || !args.key.length) {
    throw new CdpError("press_key requires a non-empty { key }");
  }
  const spec = resolveKey(args.key);
  let modBits = 0;
  const mods = args.modifiers ?? [];
  for (const m of mods) {
    const bit = MODIFIER_BITS[m.toLowerCase()];
    if (bit === undefined) throw new CdpError(`unknown modifier '${m}'`);
    modBits |= bit;
  }
  // When a modifier other than Shift is held, suppress text (it's a chord).
  const suppressText = (modBits & ~MODIFIER_BITS.shift!) !== 0;

  return withPage(args.target, async (conn) => {
    const down: Record<string, unknown> = {
      type: "keyDown",
      key: spec.key,
      code: spec.code,
      windowsVirtualKeyCode: spec.keyCode,
      nativeVirtualKeyCode: spec.keyCode,
      modifiers: modBits,
    };
    if (spec.text && !suppressText) {
      // A printable char dispatches as keyDown-with-text, which commits the
      // character (verified: x/y/space produce value "xy "). `type` is already
      // "keyDown" from construction above.
      down.text = spec.text;
    }
    await conn.send("Input.dispatchKeyEvent", down);
    await conn.send("Input.dispatchKeyEvent", {
      type: "keyUp",
      key: spec.key,
      code: spec.code,
      windowsVirtualKeyCode: spec.keyCode,
      nativeVirtualKeyCode: spec.keyCode,
      modifiers: modBits,
    });
    return { pressed: spec.key, modifiers: mods };
  });
}

/* --------------------------------- upload_file -------------------------------- */

export interface UploadFileArgs extends ElementTarget {
  target?: TargetSelector;
  /** Absolute path(s) to the file(s) to attach to the <input type=file>. */
  files: string | string[];
}

export async function uploadFile(args: UploadFileArgs): Promise<{ uploaded: string[] }> {
  const files = Array.isArray(args.files) ? args.files : [args.files];
  if (!files.length || files.some((f) => typeof f !== "string" || !f.length)) {
    throw new CdpError("upload_file requires { files } as a non-empty path or array of paths");
  }
  return withPage(args.target, async (conn) => {
    const { objectId } = await resolveElement(conn, args);
    // setFileInputFiles needs a backendNodeId/objectId reference to the <input>.
    await conn.send("DOM.setFileInputFiles", { files, objectId });
    return { uploaded: files };
  });
}

/* ------------------------------------------------------------------------------
 * CDP methods used:
 *   DOM.resolveNode (via resolveUid), Runtime.evaluate (selector resolution),
 *   Runtime.callFunctionOn (scrollIntoView + rect center, focus, clear value),
 *   Input.dispatchMouseEvent (click/hover/drag),
 *   Input.insertText (fill/type_text/fill_form),
 *   Input.dispatchKeyEvent (press_key, named keys + modifiers),
 *   DOM.setFileInputFiles (upload_file).
 * Parity gaps vs chrome-devtools-mcp interaction tools:
 *   - press_key supports a curated named-key table + single chars; it is not the
 *     full Puppeteer KeyInput enum (function keys F1-F12, numpad, IME, etc.).
 *   - fill/type_text use Input.insertText (atomic paste-like commit) rather than
 *     per-character keystrokes, so per-char keydown handlers / input masks that
 *     depend on individual keystrokes won't see each character.
 *   - drag is a synthetic mouse press/move/release; native HTML5 drag-and-drop
 *     (DataTransfer) is approximated, matching CDP's mouse-driven model but not
 *     guaranteed for every custom DnD library.
 *   - no implicit auto-wait/retry: tools resolve and act once. Callers re-snapshot
 *     between steps (MCP wraps each action in a Puppeteer locator auto-wait).
 * ---------------------------------------------------------------------------- */
