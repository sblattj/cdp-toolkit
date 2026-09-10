/**
 * focus-emulation.ts: `focus_emulation` + `click_focus_gated` — the Chrome CDP primitive behind
 * driving a focus-gated page (a button the site disables unless the tab is focused) WITHOUT
 * stealing OS window focus.
 *
 * WHY THIS EXISTS (the mechanism it ports)
 * ========================================
 * Anthropic's Claude Code OAuth page (claude.ai/oauth/*) gates its Authorize button behind
 * document.hasFocus()/visibilitychange: a background tab reports hasFocus()===false and the
 * button stays disabled, so an agent driving claude -p's login has to keep a human clicking.
 * The danbuhler/claude-code-auto-authorize Chrome extension defeats it with two CDP primitives:
 *   1. Emulation.setFocusEmulationEnabled {enabled:true} — the page BELIEVES it is focused
 *      (hasFocus()→true, visibilitychange stays "visible", focus events fire) while the real
 *      OS window stays put; and
 *   2. Input.dispatchMouseEvent — a TRUSTED click (isTrusted:true) on that background tab,
 *      which a content script's synthesized events (isTrusted:false) can never produce.
 * This module is that pair as toolkit tools: focus_emulation is the raw toggle;
 * click_focus_gated composes toggle → locate-button → trusted-click → restore.
 *
 * WHY CHROME-ONLY (capability "emulate.focus", declared in ../driver.ts /
 * ../cdp/driver.ts): WebDriver BiDi has no focus-emulation module (the emulation module covers
 * geolocation/timezone/locale/scripting only), so under --browser firefox BOTH tools are absent
 * from tools/list (ADR-001: absent, never present-and-throwing) — like dispatch_mouse and
 * start_screen_recording.
 *
 * Lease gate: withPage (client.ts) → resolveTarget → assertLeaseOk("chrome", ...), the same
 * choke point as every input tool.
 */
import { sendInput } from "../activity.ts";
import { withPage } from "../client.ts";
import type { TargetSelector } from "../types.ts";

export interface FocusEmulationArgs {
  target?: TargetSelector;
  lease?: string;
  /** true → the page reports focused; false → restore real focus state. */
  enabled: boolean;
}

export interface FocusEmulationResult {
  enabled: boolean;
}

export interface ClickFocusGatedArgs {
  target?: TargetSelector;
  lease?: string;
  /** CSS selector of the button to click once focus is emulated. Exactly one of selector/text. */
  selector?: string;
  /** Visible-text match for the button (e.g. "Authorize"); exact-trim match, case-sensitive. */
  text?: string;
  /** Max ms to poll for the button to exist AND become enabled. Default 30000. */
  timeoutMs?: number;
  /** Poll interval ms. Default 500. */
  pollMs?: number;
  /** Leave focus emulation ON after the click (default false — always restored). */
  keepFocus?: boolean;
}

export interface ClickFocusGatedResult {
  clicked: boolean;
  x: number;
  y: number;
  /** How the button was located. */
  matchedBy: "selector" | "text";
  /** ms from call to click. */
  elapsedMs: number;
}

export function validateFocusEmulationArgs(args: FocusEmulationArgs): void {
  if (typeof args.enabled !== "boolean") {
    throw new Error("focus_emulation requires { enabled } of true or false");
  }
}

export function validateClickFocusGatedArgs(args: ClickFocusGatedArgs): void {
  const hasSel = typeof args.selector === "string" && args.selector.length > 0;
  const hasText = typeof args.text === "string" && args.text.length > 0;
  if (hasSel === hasText) {
    throw new Error("click_focus_gated requires exactly one of { selector } or { text }");
  }
  if (args.timeoutMs !== undefined && (!Number.isFinite(args.timeoutMs) || args.timeoutMs <= 0)) {
    throw new Error("click_focus_gated: timeoutMs must be a positive number");
  }
  if (args.pollMs !== undefined && (!Number.isFinite(args.pollMs) || args.pollMs <= 0)) {
    throw new Error("click_focus_gated: pollMs must be a positive number");
  }
}

const FIND_BUTTON = `(() => {
  const SEL = %SEL%;
  const TEXT = %TEXT%;
  let btn = null;
  let matchedBy = null;
  if (SEL) {
    btn = document.querySelector(SEL);
    if (btn) matchedBy = "selector";
  }
  if (!btn && TEXT) {
    btn = Array.from(document.querySelectorAll("button,[role=button],input[type=submit]"))
      .find((b) => (b.textContent || b.value || "").trim() === TEXT);
    if (btn) matchedBy = "text";
  }
  if (!btn) return null;
  const r = btn.getBoundingClientRect();
  if (r.width === 0 || r.height === 0) return null;
  return { x: r.left + r.width / 2, y: r.top + r.height / 2,
           disabled: !!btn.disabled || btn.getAttribute("aria-disabled") === "true",
           matchedBy, hasFocus: document.hasFocus(), visibility: document.visibilityState };
})()`;

function findButtonExpression(selector: string | undefined, text: string | undefined): string {
  return FIND_BUTTON.replace("%SEL%", JSON.stringify(selector ?? null)).replace(
    "%TEXT%",
    JSON.stringify(text ?? null),
  );
}

/** Toggle page focus emulation. The page reports focused/visible without the OS window moving. */
export async function focusEmulation(args: FocusEmulationArgs): Promise<FocusEmulationResult> {
  validateFocusEmulationArgs(args);
  return withPage(
    args.target,
    async (conn) => {
      await conn.send("Emulation.setFocusEmulationEnabled", { enabled: args.enabled });
      return { enabled: args.enabled };
    },
    { lease: args.lease },
  );
}

/**
 * Emulate focus, poll for a focus-gated button to become enabled, trusted-click it, restore.
 * The restore runs in `finally` unless keepFocus — a thrown click never strands the page in a
 * fake-focused state.
 */
export async function clickFocusGated(args: ClickFocusGatedArgs): Promise<ClickFocusGatedResult> {
  validateClickFocusGatedArgs(args);
  const timeoutMs = args.timeoutMs ?? 30_000;
  const pollMs = args.pollMs ?? 500;
  const start = Date.now();
  return withPage(
    args.target,
    async (conn, target) => {
      await conn.send("Emulation.setFocusEmulationEnabled", { enabled: true });
      try {
        const expression = findButtonExpression(args.selector, args.text);
        for (;;) {
          const { result } = await conn.send<{ result: { value?: unknown } }>("Runtime.evaluate", {
            expression,
            returnByValue: true,
          });
          const btn = (result as { value?: unknown } | undefined)?.value as
            | { x: number; y: number; disabled: boolean; matchedBy: "selector" | "text" }
            | null
            | undefined;
          if (btn && !btn.disabled) {
            const base = { x: btn.x, y: btn.y, button: "left", buttons: 1, clickCount: 1 };
            await sendInput(conn, "chrome", target.id, "Input.dispatchMouseEvent", { type: "mouseMoved", x: btn.x, y: btn.y });
            await sendInput(conn, "chrome", target.id, "Input.dispatchMouseEvent", { ...base, type: "mousePressed" });
            await sendInput(conn, "chrome", target.id, "Input.dispatchMouseEvent", { ...base, type: "mouseReleased" });
            return {
              clicked: true,
              x: btn.x,
              y: btn.y,
              matchedBy: btn.matchedBy,
              elapsedMs: Date.now() - start,
            };
          }
          if (Date.now() - start >= timeoutMs) {
            throw new Error(
              `click_focus_gated: button never became clickable within ${timeoutMs}ms` +
                (btn ? " (found but stayed disabled — focus emulation may not satisfy this gate)" : " (never located)"),
            );
          }
          await new Promise((r) => setTimeout(r, pollMs));
        }
      } finally {
        if (!args.keepFocus) {
          await conn.send("Emulation.setFocusEmulationEnabled", { enabled: false }).catch(() => {});
        }
      }
    },
    { lease: args.lease, timeoutMs: timeoutMs + 5_000 },
  );
}
