/**
 * The activity beacon: what tells an agent that a HUMAN is still using the tab
 * it is about to take over.
 *
 * WHY THIS EXISTS. Since 1.5.0 claim_page{target} can take over a tab that is
 * already open, and the tab that feature exists for is a human's. Nothing until
 * now could detect the human still using it: a lease's lastUsedAt measures
 * TOOLKIT calls, so a tab a person has been typing in for ten minutes and no
 * agent has touched looks perfectly idle. This module measures the other side.
 *
 * THE HONEST SIGNAL IS A CORRELATION, NOT A FLAG. The obvious approach —
 * listen for input events and trust `isTrusted` — does not work, and it fails
 * in the direction that matters: CDP-dispatched input (Input.dispatchMouseEvent,
 * Input.dispatchKeyEvent) arrives at the page as `isTrusted: true`, byte for
 * byte indistinguishable from a real finger. So an in-page listener alone can
 * only say "input happened", never "a person did it". What makes the answer
 * honest is correlating the in-page timestamp with THIS PROCESS'S OWN log of
 * every input it dispatched: input this process cannot account for is input it
 * did not cause. See isHumanAttributed.
 *
 * THE CAVEAT THAT CANNOT BE ENGINEERED AWAY, stated plainly because a reader
 * will otherwise assume it was overlooked: the dispatch log is IN-PROCESS. Two
 * MCP server processes drive one Chrome (see backend.ts and leases.ts), so a
 * SECOND server's clicks are not in this one's log and read as human here. That
 * is the wrong answer in the safe direction — it reports contention that is
 * really another agent, rather than reporting a human as idle — and the tool
 * surface never refuses a claim on it, so the cost is a spurious warning rather
 * than a blocked call. Do not "fix" it by writing the dispatch log to disk
 * beside the lease files without also solving clock skew and write amplification
 * on every single click; that trade was considered and declined.
 *
 * A SECOND, NARROWER GAP: the beacon listens on the TOP-LEVEL window only.
 * Events do not cross document boundaries, so a person clicking inside a
 * cross-origin iframe moves no timestamp this module can see. Same direction of
 * error (reads as idle), same non-fix (a per-frame beacon would need a
 * frame-tree walk on every install and still miss an OOPIF that navigates).
 *
 * AND A THIRD: the beacon only answers for a tab something INSTALLED it into.
 * A human's tab that no agent has ever claimed carries no beacon at all, so the
 * first claim_page{target} against it reports humanActiveMs null — "no data",
 * never "no human". Every consumer must read null as unknown. The value shows
 * up on the second claim, on any tab an agent claimed and released, and on any
 * tab listed by list_leases, which is exactly the population where two parties
 * are most likely to be fighting over one tab.
 */
import type { BrowserDriver } from "./driver.ts";
import type { LeaseBackend } from "./leases.ts";

/* ------------------------------- the in-page beacon ------------------------------- */

/** Where the beacon parks its timestamp. Read by this module, by list_leases,
 *  and (from 1.8.0's renderer ping) by list_pages. Never change this string:
 *  a page carrying a beacon installed by an older server must stay readable. */
export const BEACON_DATA_GLOBAL = "__cdpToolkitLastInput";

/**
 * The idempotence guard, deliberately a DIFFERENT global from the data one.
 *
 * Guarding on BEACON_DATA_GLOBAL itself would be the obvious one-global design
 * and it is broken: that global does not exist until the first input arrives,
 * so on a tab nobody has touched yet every re-install would see `undefined`,
 * conclude "not installed", and add another full set of listeners. The beacon is
 * re-installed on every claim, so that leak is not hypothetical.
 */
export const BEACON_INSTALLED_GLOBAL = "__cdpToolkitBeacon";

/**
 * The events that count as input.
 *
 * `pointerdown` and `mousedown` are both listed on purpose rather than as a
 * belt-and-braces reflex: a page that calls preventDefault() on pointerdown
 * suppresses the compatibility mousedown, and a page using a pointer-events
 * polyfill can fire mousedown with no pointerdown at all. `wheel` is what makes
 * plain reading register — scrolling an article is the most common thing a
 * person does in a tab without ever clicking. Deliberately NOT here: mousemove
 * (fires continuously and would report "active" for a cursor resting over the
 * window), focus/blur (fire on tab switching, i.e. on someone leaving), and
 * keyup (redundant with keydown and doubles the event volume).
 */
export const BEACON_EVENTS = ["pointerdown", "mousedown", "keydown", "wheel", "touchstart"] as const;

/**
 * Capture phase and passive, both load-bearing.
 *
 * CAPTURE: a page that stops propagation on a bubbling handler (drag surfaces,
 * canvas editors and modal overlays all do) would hide the input from a bubble-
 * phase listener entirely. Capture runs before the page's own handlers, so no
 * page can suppress the beacon.
 *
 * PASSIVE: promises the browser this listener will never call preventDefault(),
 * which is what keeps a `wheel` listener off the scrolling critical path. A
 * non-passive wheel listener on window measurably janks scrolling, and a
 * diagnostic that makes the page it is diagnosing feel slower is not acceptable.
 */
const BEACON_BODY = `
  if (!window.${BEACON_INSTALLED_GLOBAL}) {
    window.${BEACON_INSTALLED_GLOBAL} = true;
    var mark = function () { window.${BEACON_DATA_GLOBAL} = Date.now(); };
    var events = ${JSON.stringify([...BEACON_EVENTS])};
    for (var i = 0; i < events.length; i++) {
      window.addEventListener(events[i], mark, { capture: true, passive: true });
    }
  }`;

/** The beacon as a PROGRAM, for CDP (Page.addScriptToEvaluateOnNewDocument and
 *  Runtime.evaluate both take a source string). */
export const BEACON_SOURCE = `(function () {${BEACON_BODY}\n})();`;

/** The same beacon as a FUNCTION DECLARATION, for BiDi, whose
 *  script.addPreloadScript takes a functionDeclaration rather than a program. */
export const BEACON_FUNCTION_DECLARATION = `function () {${BEACON_BODY}\n}`;

/** Reads the beacon timestamp, or null on a document that has no beacon. Never
 *  throws in-page: an unknown global is `undefined`, not a ReferenceError, when
 *  reached through `window`. */
export const BEACON_READ_EXPRESSION = `(typeof window.${BEACON_DATA_GLOBAL} === "number" ? window.${BEACON_DATA_GLOBAL} : null)`;

/* -------------------------------- the dispatch log -------------------------------- */

/**
 * How long after one of OUR dispatches a beacon timestamp is still attributed
 * to us rather than to a human.
 *
 * A single toolkit click produces a burst: pointerdown, mousedown, and on a
 * page with its own synthesized follow-ups possibly more, all after the CDP
 * command was sent and all landing on the beacon. The window has to cover that
 * burst plus the round trip. 1500ms is generous for the burst and short enough
 * that a person who reaches for the mouse right after an agent acted is still
 * seen: the failure it trades away (a human input inside 1.5s of our own click
 * read as ours) is a false NEGATIVE on contention, which is the direction that
 * merely under-warns rather than the direction that cries wolf.
 */
export const DISPATCH_ATTRIBUTION_WINDOW_MS = 1500;

/**
 * Keyed by backend AND target id, exactly as leases.ts keys its records, and
 * for the same stated reason: a CDP targetId and a BiDi context id are not
 * guaranteed disjoint, so a bare id could let a Chrome tab's dispatch suppress
 * a Firefox context's beacon.
 */
function dispatchKey(backend: LeaseBackend, targetId: string): string {
  return `${backend}:${targetId}`;
}

/**
 * targetId -> when this process last dispatched input into it.
 *
 * MODULE STATE, WHICH leases.ts's HEADER OTHERWISE FORBIDS, and the exception is
 * the same one leases.ts carves out for `longLived`: that prohibition is about
 * state describing OTHER processes, which must live on disk because two MCP
 * servers drive one browser. This describes what THIS process did, which no
 * other process can observe and none should — the whole discrimination rule is
 * "input this process cannot account for". Putting it on disk would not make it
 * more correct, it would make it a different and worse signal (see the header's
 * caveat).
 */
const dispatchLog = new Map<string, number>();

/**
 * Bound on the log, because an MCP server can outlive thousands of tabs.
 * Eviction is oldest-write-first, and evicting is SAFE in the only direction
 * that matters: a forgotten dispatch makes a later beacon read as human, which
 * over-warns rather than under-warns.
 */
const DISPATCH_LOG_LIMIT = 512;

/**
 * THE CHOKE POINT. Every driver method that dispatches synthesized input calls
 * this, and it is called from exactly one place per driver (cdp/driver.ts's
 * dispatchInput, bidi/driver.ts's performActions) so a NEW input tool inherits
 * the bookkeeping by construction instead of by its author remembering.
 *
 * If you are adding an input tool: do not call this directly. Route the protocol
 * command through the driver's own input choke point and this comes for free.
 */
export function recordDispatch(backend: LeaseBackend, targetId: string, now: number = Date.now()): void {
  const key = dispatchKey(backend, targetId);
  // Delete-then-set so the Map's insertion order is genuinely last-write order,
  // which is what makes the eviction below oldest-first rather than arbitrary.
  dispatchLog.delete(key);
  dispatchLog.set(key, now);
  while (dispatchLog.size > DISPATCH_LOG_LIMIT) {
    const oldest = dispatchLog.keys().next();
    if (oldest.done) break;
    dispatchLog.delete(oldest.value);
  }
}

/** When this process last dispatched input into a target, or undefined if never. */
export function lastDispatchAt(backend: LeaseBackend, targetId: string): number | undefined {
  return dispatchLog.get(dispatchKey(backend, targetId));
}

/** Drop one target's dispatch record. For a tab that has been closed, and for
 *  tests that need a clean slate for one target. */
export function forgetDispatch(backend: LeaseBackend, targetId: string): void {
  dispatchLog.delete(dispatchKey(backend, targetId));
}

/** Empty the log. Tests only: no product path wants to forget what it did. */
export function clearDispatchLog(): void {
  dispatchLog.clear();
}

/* ------------------------------- discrimination ------------------------------- */

/**
 * THE RULE: a beacon timestamp is a HUMAN's iff it is newer than this process's
 * last dispatch into that tab by more than the attribution window.
 *
 * `dispatchAt` undefined means this process has never driven the tab, so every
 * real timestamp is unaccounted-for and therefore human. That falls out of the
 * `?? 0` rather than needing its own branch, and it is the correct reading: a
 * tab we have never touched cannot have been moved by us.
 *
 * A non-finite or absent beacon value is NOT human — it is NO DATA. The two are
 * different answers and every caller has to keep them apart, which is why the
 * surfaced field is `number | null` and never a boolean.
 */
export function isHumanAttributed(
  beaconTs: number | null | undefined,
  dispatchAt: number | undefined,
  windowMs: number = DISPATCH_ATTRIBUTION_WINDOW_MS,
): boolean {
  if (typeof beaconTs !== "number" || !Number.isFinite(beaconTs)) return false;
  return beaconTs > (dispatchAt ?? 0) + windowMs;
}

/**
 * Milliseconds since the last HUMAN-attributed input, or null when there is no
 * human-attributed input to measure (no beacon, no data, or every timestamp
 * accounted for by our own dispatches).
 *
 * Clamped at zero. The beacon's clock is the page's `Date.now()` and this
 * function's is the server's; they are the same machine's wall clock, but a
 * beacon read that races a millisecond forward would otherwise produce a
 * negative "ms ago", which reads as a corrupt field rather than as the rounding
 * artifact it is.
 */
export function humanActiveMs(
  beaconTs: number | null | undefined,
  dispatchAt: number | undefined,
  now: number = Date.now(),
  windowMs: number = DISPATCH_ATTRIBUTION_WINDOW_MS,
): number | null {
  if (!isHumanAttributed(beaconTs, dispatchAt, windowMs)) return null;
  return Math.max(0, now - (beaconTs as number));
}

/* --------------------------------- contention --------------------------------- */

/**
 * How recent a human input has to be for a takeover to be worth warning about.
 * 30s is "they are still in this tab", not "they used it this session".
 */
export const CONTENTION_WINDOW_MS = 30_000;

/**
 * The warning claim_page attaches to a takeover of a tab a human is still using.
 *
 * IT IS A WARNING AND NEVER A REFUSAL, and that is a product decision, not an
 * oversight: taking over a human's tab IS the feature (see leases-tools.ts's
 * header), a caller asked for this specific tab, and a tool that refused on
 * detected activity would break the exact workflow the takeover mode exists to
 * serve. The claim has already succeeded by the time this string is built. The
 * warning informs; the caller decides.
 *
 * Returns undefined — the field is then omitted entirely — for a fresh tab this
 * call opened (nobody can be contending for a tab that did not exist a moment
 * ago), for no data, and for a human who has been idle past the window.
 */
export function contentionWarning(ms: number | null, opts: { takeover: boolean }): string | undefined {
  if (!opts.takeover) return undefined;
  if (ms === null || ms >= CONTENTION_WINDOW_MS) return undefined;
  return (
    `a person appears to be using this tab right now: input not dispatched by this server landed ${ms}ms ago. ` +
    `The claim SUCCEEDED and you hold the lease — this is a warning, not a refusal. ` +
    `Driving the tab now will fight them for the keyboard and mouse. ` +
    `Consider claim_page with no target to work in your own tab instead, or ask before continuing.`
  );
}

/* ---------------------------- driver-facing helpers ---------------------------- */

/**
 * Whether this backend can answer beacon questions at all.
 *
 * The two members are optional on BrowserDriver rather than universal because
 * ADR-001's rule for a capability one backend lacks is "absent, never present
 * and throwing". They are NOT in the `Capability` union, deliberately: that
 * union gates whole TOOLS out of tools/list, and no tool here is gated — the
 * beacon is an additive FIELD on two tools that both work fine without it. So
 * the honest expression of the gap is an absent optional method and an absent
 * field, which is what a caller sees on a backend with no beacon.
 */
export function beaconSupported(driver: BrowserDriver): boolean {
  return typeof driver.installActivityBeacon === "function" && typeof driver.readActivityBeacon === "function";
}

/**
 * Install the beacon into a target, best effort.
 *
 * NEVER THROWS, and never fails the caller's real work. This is an annotation,
 * exactly like origins.ts's ledger write: claim_page's job is to hand back a
 * lease, and a claim that failed because a diagnostic script could not be
 * injected would be a worse tool than one with a missing field. The cost, stated
 * plainly: a tab whose injection silently failed reports humanActiveMs null
 * forever, indistinguishable from a tab nobody has touched.
 */
export async function installBeacon(driver: BrowserDriver, targetId: string): Promise<boolean> {
  if (typeof driver.installActivityBeacon !== "function") return false;
  return driver.installActivityBeacon(targetId).catch(() => false);
}

/**
 * Read a target's human-activity age, gate-free, best effort.
 *
 * GATE-FREE IS REQUIRED, NOT CONVENIENT, on the claim_page{target} path, and
 * for exactly the reason pickPage is gate-free (see leases-tools.ts's header):
 * under CDP_REQUIRE_LEASE the lease gate AUTO-ACQUIRES a lease on an unleased
 * tab, so reading through a gated path before claiming would claim the tab
 * once implicitly and then collide with itself on the explicit claim. The
 * driver members this calls therefore bypass the gate — and the bypass is safe
 * to hand out because it is not general: `readActivityBeacon` can return one
 * number and cannot drive, mutate, or even read anything else from the page.
 *
 * Returns null both for "no beacon" and for "every timestamp was ours". A
 * caller that must distinguish "this backend has no beacon at all" checks
 * beaconSupported first, and omits the field entirely in that case.
 */
export async function readHumanActiveMs(
  driver: BrowserDriver,
  backend: LeaseBackend,
  targetId: string,
  now: number = Date.now(),
): Promise<number | null> {
  if (typeof driver.readActivityBeacon !== "function") return null;
  const beaconTs = await driver.readActivityBeacon(targetId).catch(() => null);
  return humanActiveMs(beaconTs, lastDispatchAt(backend, targetId), now);
}

/* ------------------------------- the renderer ping ------------------------------- */

/**
 * How long list_pages{probe:true} waits for one target's renderer to answer
 * before calling it unresponsive. Bounded so ONE wedged tab cannot stall the
 * whole listing beyond its own budget; see BrowserDriver.probeRenderer.
 */
export const RENDERER_PROBE_TIMEOUT_MS = 500;

/**
 * Evaluated in-page by the bounded probe. The leading `1` is a liveness
 * marker, not a beacon reading: it is what lets a caller distinguish "the
 * renderer executed this and came back with genuinely no beacon data"
 * (`[1, null]`) from a probe that never got a value back at all, which the
 * driver reports as a rejection — see probeRenderer — rather than as this
 * expression evaluating to something falsy. `window.X ?? null` is safe on a
 * document with no beacon: property access through `window` never throws for
 * an unset global, unlike a bare identifier reference.
 */
export const RENDERER_PROBE_EXPRESSION = `[1, window.${BEACON_DATA_GLOBAL} ?? null]`;

/**
 * Whether this backend can answer the renderer ping at all.
 *
 * Same rule as beaconSupported and the same reason: not a `Capability`,
 * because no whole TOOL is gated here, only an additive field on list_pages
 * that works fine (simply absent) without it.
 */
export function rendererProbeSupported(driver: BrowserDriver): boolean {
  return typeof driver.probeRenderer === "function";
}

export interface RendererProbeResult {
  responsive: boolean;
  /** Same rule as everywhere else in this module: present only where the
   *  same round trip found beacon data AND that data is human-attributed. */
  humanActiveMs?: number;
}

/**
 * Probe one target and fold the answer through the SAME discrimination rule as
 * every other beacon read (isHumanAttributed via humanActiveMs, keyed by this
 * process's own dispatch log), so probe:true can never disagree with
 * claim_page or list_leases about what counts as human.
 *
 * NEVER THROWS. driver.probeRenderer is documented to never reject, but this
 * defends anyway (matching readHumanActiveMs's own defensive `.catch`) rather
 * than trust every implementer to honor that. A driver with no probeRenderer
 * at all degrades to `{responsive:false}` with no humanActiveMs — the same
 * shape as a backend that answered and found nothing, which is deliberate:
 * the caller that needs to tell "cannot answer" from "answered, no data" is
 * list_pages itself, via rendererProbeSupported, not this function.
 */
export async function probeRendererActivity(
  driver: BrowserDriver,
  backend: LeaseBackend,
  targetId: string,
  now: number = Date.now(),
): Promise<RendererProbeResult> {
  if (typeof driver.probeRenderer !== "function") return { responsive: false };
  const { responsive, beaconTs } = await driver
    .probeRenderer(targetId, RENDERER_PROBE_TIMEOUT_MS)
    .catch(() => ({ responsive: false, beaconTs: null as number | null }));
  const ms = humanActiveMs(beaconTs, lastDispatchAt(backend, targetId), now);
  return ms === null ? { responsive } : { responsive, humanActiveMs: ms };
}

/* ------------------------- keep-alive session bookkeeping ------------------------- */

/**
 * A bounded registry of the live connections that keep a beacon re-arming
 * across navigation. Both drivers own one; the eviction policy lives here once
 * rather than twice.
 *
 * WHY A HELD CONNECTION IS NECESSARY AT ALL, since it is the one expensive thing
 * in this module and a reader will reasonably ask. Chrome's
 * Page.addScriptToEvaluateOnNewDocument is SESSION-SCOPED: the registration is
 * cleared when the client that made it disconnects. Verified against Chrome
 * 151.0.7922.109 — install, disconnect, reconnect, navigate, and the script does
 * not run; install and navigate on ONE connection and it runs on every
 * navigation. This toolkit's CDP lifetime is "per-call" (driver.ts), so the
 * naive install would cover the current document only and would be silently
 * lost the moment the person navigated, which is the single most common thing
 * a person does in a tab. Holding one socket per beaconed tab is what makes
 * "survives navigation" a true statement instead of an aspiration.
 *
 * EVICTION DEGRADES, IT DOES NOT BREAK. Past the limit the oldest socket is
 * closed; the listeners already installed in that tab's CURRENT document keep
 * working and keep answering reads, so the tab loses only the re-arm on its
 * NEXT navigation. That is the same state as a tab beaconed by a CLI process,
 * which cannot hold anything at all.
 */
export class BeaconSessions<T> {
  private readonly live = new Map<string, T>();
  constructor(
    private readonly close: (value: T) => void,
    private readonly limit = 32,
  ) {}

  get(key: string): T | undefined {
    return this.live.get(key);
  }

  /** Adopt a handle for `key`, closing any handle it displaces and evicting the
   *  oldest once over the limit. */
  set(key: string, value: T): void {
    const previous = this.live.get(key);
    if (previous !== undefined) {
      this.live.delete(key);
      this.safeClose(previous);
    }
    this.live.set(key, value);
    while (this.live.size > this.limit) {
      const oldest = this.live.keys().next();
      if (oldest.done) break;
      this.drop(oldest.value);
    }
  }

  drop(key: string): void {
    const value = this.live.get(key);
    if (value === undefined) return;
    this.live.delete(key);
    this.safeClose(value);
  }

  clear(): void {
    for (const key of [...this.live.keys()]) this.drop(key);
  }

  get size(): number {
    return this.live.size;
  }

  private safeClose(value: T): void {
    try {
      this.close(value);
    } catch {
      /* a socket that is already gone is exactly the state we wanted */
    }
  }
}
