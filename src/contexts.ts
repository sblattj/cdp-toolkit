/**
 * Execution-context selection inside ONE target (issue #12). Backend-neutral and pure: no I/O,
 * so the grammar and the pick rules are unit-tested without a browser. The CDP half (collecting
 * contexts off a live connection, settling, evaluating in each) is src/cdp/contexts.ts.
 *
 * WHAT IT IS FOR. A target (a tab, an out-of-process iframe, an Electron webview) can hold many
 * documents that are NOT targets of their own: every same-process iframe is a frame inside its
 * parent's renderer, with its own JavaScript realm. CDP calls each realm an execution context,
 * and Runtime.evaluate without a contextId runs in the target's main frame only, so
 * `document.querySelector` cannot see an input that lives in a nested frame. The `frame:` target
 * arm (src/frames.ts) does not help: it picks out-of-process iframe TARGETS, and a same-process
 * frame is not one. This module names a context INSIDE whatever target was already resolved.
 *
 * THE `context` VALUE (a tool parameter, not a target-selector suffix, so none of the three target
 * resolvers, the endpoint prefix or the lease-key parsing change):
 *   <number> | 'id:<n>'   the executionContextId from list_contexts (stable across calls for
 *                         the context's life, measured on Chromium 158; a navigation makes a new one)
 *   'frame:<frameId>'     the frame's id, exact (survives nothing either, but reads better)
 *   'url:<substr>'        substring of the frame's url, else of the context's origin
 *   'name:<substr>'       substring of the frame's name (the <iframe name=...>), else the context name
 *   'auto'                element tools with a css `selector` only: the first context whose
 *                         document matches the selector, waiting for late contexts up to the cap
 *
 * ISOLATED WORLDS. Extensions (an ad blocker, a password manager) add an isolated world to most
 * frames. It shares the frame's DOM, so a url:/name: pick would match it twice per frame. The pick
 * therefore prefers the frame's DEFAULT (main-world) context, and only falls back to isolated ones
 * when no default context matches. An id: pick is exact and can name an isolated world on purpose.
 */

export interface ExecutionContextInfo {
  /** Runtime.ExecutionContextId: pass as `context`. */
  id: number;
  /** Runtime's globally unique id, when the browser reports one. */
  uniqueId?: string;
  /** The frame this context belongs to (absent for worker contexts). */
  frameId?: string;
  origin: string;
  /** The context's own name: empty for a main world, the extension's name for an isolated one. */
  name: string;
  /** True for a frame's main-world context. */
  isDefault: boolean;
  /** "default" | "isolated" | "worker" | whatever the browser reports. */
  type: string;
  /** True for the target's own top frame. */
  isMainFrame?: boolean;
  /** From the frame tree, when the frame is in it. */
  frameUrl?: string;
  frameName?: string;
}

export type ContextSelector =
  | { kind: "id"; id: number }
  | { kind: "frame"; frameId: string }
  | { kind: "url"; needle: string }
  | { kind: "name"; needle: string }
  | { kind: "auto" };

export const CONTEXT_GRAMMAR =
  "context is a number (an id from list_contexts), 'id:<n>', 'frame:<frameId>', 'url:<substring>', 'name:<substring>', or 'auto'";

export class ContextSelectorError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ContextSelectorError";
  }
}

/** Parse a `context` argument. Throws ContextSelectorError on anything outside the grammar. */
export function parseContextSelector(value: unknown): ContextSelector {
  if (typeof value === "number") {
    if (!Number.isInteger(value)) throw new ContextSelectorError(`context ${value} is not an integer id; ${CONTEXT_GRAMMAR}`);
    return { kind: "id", id: value };
  }
  if (typeof value !== "string" || value.length === 0) {
    throw new ContextSelectorError(`context must be a number or a non-empty string; ${CONTEXT_GRAMMAR}`);
  }
  if (value === "auto") return { kind: "auto" };
  if (/^-?\d+$/.test(value)) return { kind: "id", id: Number(value) };
  const m = /^(id|frame|url|name):(.*)$/s.exec(value);
  if (!m) throw new ContextSelectorError(`context '${value}' is not understood; ${CONTEXT_GRAMMAR}`);
  const [, kind, rest = ""] = m;
  if (rest === "") throw new ContextSelectorError(`context '${value}' needs a value after '${kind}:'; ${CONTEXT_GRAMMAR}`);
  if (kind === "id") {
    if (!/^-?\d+$/.test(rest)) throw new ContextSelectorError(`context '${value}': the id must be an integer`);
    return { kind: "id", id: Number(rest) };
  }
  if (kind === "frame") return { kind: "frame", frameId: rest };
  return kind === "url" ? { kind: "url", needle: rest } : { kind: "name", needle: rest };
}

/** One-line description of a context, for miss and ambiguity messages. */
export function describeContext(c: ExecutionContextInfo): string {
  const where = c.frameUrl ?? (c.origin || "(no origin)");
  const name = c.frameName ? ` name=${JSON.stringify(c.frameName)}` : "";
  const world = c.isDefault ? "" : ` ${c.type || "isolated"}${c.name ? ` ${JSON.stringify(c.name)}` : ""}`;
  return `${c.id} ${where}${name}${world}${c.frameId ? ` frame=${c.frameId}` : ""}`;
}

function matches(c: ExecutionContextInfo, sel: Exclude<ContextSelector, { kind: "auto" }>): boolean {
  switch (sel.kind) {
    case "id":
      return c.id === sel.id;
    case "frame":
      return c.frameId === sel.frameId;
    case "url":
      return (c.frameUrl ?? "").includes(sel.needle) || c.origin.includes(sel.needle);
    case "name":
      return (c.frameName ?? "").includes(sel.needle) || c.name.includes(sel.needle);
  }
}

export interface ContextPick {
  hit?: ExecutionContextInfo;
  /** Set when the pick failed: the message to raise, naming the live contexts. */
  error?: string;
}

/**
 * Resolve a non-auto selector against a context listing. Data, never a throw, so each backend
 * raises its own error class (the frames.ts rule). Default-world contexts win over isolated ones;
 * more than one FRAME matching is ambiguous and names every candidate rather than guessing.
 */
export function pickExecutionContext(list: readonly ExecutionContextInfo[], sel: Exclude<ContextSelector, { kind: "auto" }>): ContextPick {
  const all = list.filter((c) => matches(c, sel));
  if (sel.kind === "id") {
    return all[0] ? { hit: all[0] } : { error: contextMissMessage(`id ${sel.id}`, list) };
  }
  const preferred = all.some((c) => c.isDefault) ? all.filter((c) => c.isDefault) : all;
  if (preferred.length === 0) return { error: contextMissMessage(selectorText(sel), list) };
  const frames = new Set(preferred.map((c) => c.frameId ?? `ctx${c.id}`));
  if (frames.size > 1) {
    return {
      error:
        `context '${selectorText(sel)}' matches more than one frame: ${preferred.map(describeContext).join("; ")}. ` +
        "Narrow the substring, or pass one of these ids.",
    };
  }
  return { hit: preferred[0] };
}

function selectorText(sel: Exclude<ContextSelector, { kind: "auto" }>): string {
  switch (sel.kind) {
    case "id":
      return `id:${sel.id}`;
    case "frame":
      return `frame:${sel.frameId}`;
    case "url":
      return `url:${sel.needle}`;
    case "name":
      return `name:${sel.needle}`;
  }
}

export function contextMissMessage(what: string, list: readonly ExecutionContextInfo[]): string {
  const live = list.length ? list.map(describeContext).join("; ") : "none";
  return (
    `no execution context matches ${what} in this target (live contexts: ${live}). ` +
    "An id dies when its frame navigates or is removed: re-run list_contexts. A frame inside an out-of-process " +
    "iframe is not in its parent tab's contexts: target that iframe (frame:<url-substring>) first."
  );
}

/**
 * The order 'auto' tries contexts in: the target's top frame first, then other default worlds in
 * the order they appeared (roughly document order), isolated worlds never. An isolated world
 * shares its frame's DOM, so it can only ever duplicate a default world's answer.
 */
export function autoCandidates(list: readonly ExecutionContextInfo[]): ExecutionContextInfo[] {
  const defaults = list.filter((c) => c.isDefault);
  return [...defaults.filter((c) => c.isMainFrame), ...defaults.filter((c) => !c.isMainFrame)];
}

export const CONTEXT_AUTO_NEEDS_SELECTOR =
  "context 'auto' picks the frame whose document matches a css 'selector', so it needs one: pass selector, " +
  "or name the context (an id from list_contexts, 'url:<substring>', 'name:<substring>', 'frame:<frameId>')";

export const CONTEXT_AUTO_EVALUATE =
  "evaluate_script does not take context 'auto' (there is no selector to match): use allContexts:true to run " +
  "the expression in every context at once, or name one context (an id from list_contexts, 'url:<substring>', ...)";

/**
 * The Firefox refusal: a param-level gap, like frames.ts's FRAME_SELECTOR_UNSUPPORTED_MESSAGE.
 * WebDriver BiDi does have realms, but this toolkit's BiDi driver does not expose them yet, and
 * silently evaluating in the top document would be the exact bug this parameter exists to fix.
 */
export const CONTEXT_UNSUPPORTED_MESSAGE =
  "execution-context selection (context, allContexts, list_contexts) is Chrome-only (Capability 'runtime.contexts'); " +
  "this backend would evaluate in the top document only. Use --browser chrome.";

/** Defaults for the settle wait, overridable per process and per call. */
// 500, not less: the issue's Electron webview created its inner frame's context "a few hundred ms"
// after Runtime.enable, and a quiet window shorter than that gap returns before it.
export const DEFAULT_CONTEXT_QUIET_MS = 500;
export const DEFAULT_CONTEXT_CAP_MS = 2000;

export interface SettleOptions {
  /** Stop once no context has appeared or gone for this long. */
  quietMs?: number;
  /** Never wait longer than this in total. */
  capMs?: number;
}

function envMs(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

/** Per-call values win, then CDP_CONTEXT_QUIET_MS / CDP_CONTEXT_CAP_MS, then 500 / 2000. */
export function resolveSettle(opts: SettleOptions = {}): Required<SettleOptions> {
  const check = (v: unknown, key: string): number | undefined => {
    if (v === undefined) return undefined;
    if (typeof v !== "number" || !Number.isFinite(v) || v < 0) throw new ContextSelectorError(`${key} must be a non-negative number of ms`);
    return v;
  };
  const quietMs = check(opts.quietMs, "settleMs") ?? envMs("CDP_CONTEXT_QUIET_MS", DEFAULT_CONTEXT_QUIET_MS);
  const capMs = check(opts.capMs, "settleCapMs") ?? envMs("CDP_CONTEXT_CAP_MS", DEFAULT_CONTEXT_CAP_MS);
  return { quietMs, capMs: Math.max(capMs, 0) };
}

/** One row of evaluate_script{allContexts:true}. Exactly one of value / error is set. */
export interface ContextEvalRow {
  contextId: number;
  frameId?: string;
  origin: string;
  name: string;
  isDefault: boolean;
  type: string;
  frameUrl?: string;
  frameName?: string;
  value?: unknown;
  error?: string;
}
