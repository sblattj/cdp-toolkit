/**
 * dispatch-mouse.ts: `dispatch_mouse` over raw CDP, the toolkit's raw mouse-event primitive.
 *
 * WHY THIS IS CHROME-ONLY (capability "input.raw", declared in ../driver.ts /
 * ../cdp/driver.ts), NOT a PageDriver method
 * ============================================================================
 * Every other interaction (click/hover/drag/scroll) is a Driver-neutral, multi-event SEQUENCE:
 * "resolve an element, then press-and-release". dispatch_mouse is the opposite by design — ONE
 * raw event per call, composed by the CALLER into whatever sequence a real mouse could produce
 * (move/down/move/up reaches canvas drag-painting, marquee selection, custom widgets that
 * click/drag's fixed sequences cannot). CDP's Input.dispatchMouseEvent is a natural fit: it is
 * genuinely stateless, so "one event, one call" costs nothing extra.
 *
 * WebDriver BiDi's input.performActions is a worse fit for this SPECIFIC primitive: it models a
 * virtual input DEVICE with session-lifetime state (a pointerDown from one call leaves the button
 * "held" for a later call), not a raw event dispatch, and per the 1.8.0 spec (Track P1 §2) that
 * mismatch — plus this driver not having been verified against real Firefox for the raw primitive
 * this pass — earns the explicit "Chrome-only capability... unless bidi is trivial" fallback,
 * exactly like start_screen_recording. tools/list omits dispatch_mouse under --browser firefox
 * (ADR-001: absent, never present-and-throwing); nothing in this file runs under that backend.
 *
 * Lease gate: `withPage` (client.ts) resolves through `resolveTarget`, which calls
 * `assertLeaseOk("chrome", ...)` — the same choke point click/hover/drag/scroll go through via
 * resolvePage (shared-tools.ts). No tool here bypasses it.
 */
import { sendInput } from "../activity.ts";
import { withPage } from "../client.ts";
import type { TargetSelector } from "../types.ts";

const CLICK_MODIFIER_BITS: Record<string, number> = { Alt: 1, Control: 2, Meta: 4, Shift: 8 };
const BUTTONS = new Set(["left", "right", "middle"]);
const CDP_EVENT_TYPE: Record<"move" | "down" | "up", string> = {
  move: "mouseMoved",
  down: "mousePressed",
  up: "mouseReleased",
};

export interface DispatchMouseArgs {
  target?: TargetSelector;
  /** "move" (mouseMoved), "down" (mousePressed), or "up" (mouseReleased). */
  action: "move" | "down" | "up";
  /** Viewport-space coordinates. Required on every event: CDP has no notion of "current pointer
   *  position" to default from. */
  x: number;
  y: number;
  /** Mouse button: 'left' (default), 'right', or 'middle'. */
  button?: "left" | "right" | "middle";
  /** Click-run length for a down/up pair (2 = the second half of a double-click). Ignored for 'move'. */
  clickCount?: number;
  /** "Alt" | "Control" | "Meta" | "Shift", held for this one event. Same bit values as click's
   *  modifiers (cdp/driver.ts's inputModifierBits): Alt=1, Control=2, Meta=4, Shift=8. */
  modifiers?: string[];
}

export interface DispatchMouseResult {
  dispatched: "move" | "down" | "up";
  x: number;
  y: number;
}

/** CDP modifier-bit math for the closed Alt/Control/Meta/Shift enum. Exported for the unit tests;
 *  intentionally duplicated from (not imported from) cdp/driver.ts's identically-named constant,
 *  so this chrome-only tool module has no dependency on the Driver-abstraction layer it sits
 *  beside, matching heap.ts/screencast.ts's existing raw-CDP module boundary. */
export function modifierBits(mods?: readonly string[]): number {
  let bits = 0;
  for (const m of mods ?? []) {
    const bit = CLICK_MODIFIER_BITS[m];
    if (bit === undefined) throw new Error(`dispatch_mouse: unknown modifier '${m}' (use Alt, Control, Meta, or Shift)`);
    bits |= bit;
  }
  return bits;
}

/** Argument validation, split out and exported so the unit tests can pin every refusal without a
 *  browser. Throws on the first violation; returns nothing (the caller re-reads `args`). */
export function validateDispatchMouseArgs(args: DispatchMouseArgs): void {
  if (args.action !== "move" && args.action !== "down" && args.action !== "up") {
    throw new Error("dispatch_mouse requires { action } of 'move', 'down', or 'up'");
  }
  if (typeof args.x !== "number" || typeof args.y !== "number" || !Number.isFinite(args.x) || !Number.isFinite(args.y)) {
    throw new Error("dispatch_mouse requires numeric { x } and { y } on every call");
  }
  const button = args.button ?? "left";
  if (!BUTTONS.has(button)) throw new Error(`dispatch_mouse: unknown button '${button}' (use left, right, or middle)`);
}

/**
 * Dispatch exactly one raw mouse event. Composability is the point: a caller reaches anything a
 * physical mouse can by sequencing move/down/move/up calls itself (canvas drag-painting, marquee
 * selection, a custom widget that click/drag's fixed sequences cannot drive).
 */
export async function dispatchMouse(args: DispatchMouseArgs): Promise<DispatchMouseResult> {
  validateDispatchMouseArgs(args);
  const button = args.button ?? "left";
  const modifiers = modifierBits(args.modifiers);
  return withPage(args.target, async (conn, target) => {
    const params: Record<string, unknown> = { type: CDP_EVENT_TYPE[args.action], x: args.x, y: args.y, button, modifiers };
    if (args.action !== "move") params.clickCount = args.clickCount ?? 1;
    // Through activity.ts's sendInput, NOT conn.send: this event has to land in the dispatch log or
    // the activity beacon reads the toolkit's own mouse as a human's and warns about contention with
    // itself. sendInput is the shared writer CdpPageDriver.dispatchInput also delegates to — the one
    // import this module takes from outside its own raw-CDP boundary, and the reason the file header's
    // "not a PageDriver method" argument costs nothing in bookkeeping.
    await sendInput(conn, "chrome", target.id, "Input.dispatchMouseEvent", params);
    return { dispatched: args.action, x: args.x, y: args.y };
  });
}
