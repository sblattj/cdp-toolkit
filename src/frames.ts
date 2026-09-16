/**
 * The "frame:<url-substring>" arm of the TargetSelector grammar (issue #7).
 *
 * WHAT IT IS FOR. Chrome site isolation gives a CROSS-ORIGIN iframe its own
 * process, and with it its own CDP target that shows up in /json/list with
 * type "iframe" and its own webSocketDebuggerUrl. Until now the only way to
 * name one was its 32-hex targetId, discovered by reading list_pages{all:true}
 * output by eye. This arm names it by a substring of its url — `frame:ads.example.com`,
 * `frame:player.html` — exactly the way `url:` names a tab.
 *
 * THE OOPIF FACT, which is what the miss message below exists to teach: only
 * OUT-OF-PROCESS iframes appear as targets at all. A SAME-ORIGIN iframe runs
 * inside its parent page's process and has no target, no id, no listing entry —
 * no substring can ever select it, and a caller who does not know that goes
 * hunting for a typo that is not there. This is the frame arm's counterpart of
 * the MV3-eviction fact the worker messages teach (see workers.ts).
 *
 * WHY DATA, NEVER THROWS (the resolveLiveLabel precedent in origins.ts, and
 * workers.ts's copy of this rule). The grammar has three independent resolver
 * copies — `pickTarget` in client.ts, `pickPage` in shared-tools.ts,
 * `pickContext` in bidi/driver.ts — each with its own error class (CdpError /
 * SharedToolError / DriverError). A shared resolver that threw would force one
 * class on all three, so this returns the facts and each caller raises its own
 * error. What IS shared is the message TEXT below, because the teaching in it
 * is the point of the feature and three hand-written variants of it would drift
 * apart within one release.
 *
 * WHY THE ALL-TARGETS LISTING. An iframe is not a page target, so the page-only
 * listing the other url:/title: arms resolve against never contains one. This
 * arm reads the unfiltered listing, same as the worker: arm. That does NOT
 * merge the id sets that reap and leases keep apart: see ReapInput.livePageIds's
 * header. Unlike a worker, an iframe hit is NOT exempted from the lease gate in
 * client.ts's resolveTarget — a bare iframe id goes through that gate today, and
 * `frame:` is a way of NAMING the same target, not a new permission for it.
 */

/** Selector prefix owned by this arm. */
export const FRAME_SELECTOR_PREFIX = "frame:";

/**
 * The page-only tools that REFUSE this arm, and the single source of truth for
 * it: the page-only refusal message below is built from this list.
 *
 * WHY A REFUSAL LIST AND NOT workers.ts's WORKER_CAPABLE_TOOLS allowlist: the
 * worker arm is resolved per-tool (evaluate_script and the three recorders route
 * it through resolveWorkerSelectorFor), so which tools accept it is a finite,
 * deliberate list. The frame arm instead lives in client.ts's pickTarget, the
 * ONE resolver every Chrome tool's `target` argument already flows through, so
 * every target-taking tool accepts it with no per-tool work — the finite,
 * deliberate list is the four that must NOT (closing, selecting, releasing or
 * claiming an iframe is meaningless; those act on the embedder TAB).
 */
export const FRAME_PAGE_ONLY_TOOLS = ["close_page", "select_page", "release_page", "claim_page"] as const;

/**
 * The CDP target type this arm resolves: "iframe". /json/list reports an
 * out-of-process iframe under exactly this type (a same-origin one is absent
 * entirely, which is the OOPIF fact the miss message teaches).
 */
export const FRAME_TARGET_TYPE = "iframe";

/** The two fields every listing shape (CDP Target, PageInfo) already carries. */
export interface FrameTargetLike {
  id: string;
  url: string;
  type?: string;
}

export function isFrameSelector(selector: string | undefined): selector is string {
  return typeof selector === "string" && selector.startsWith(FRAME_SELECTOR_PREFIX);
}

/** The substring half of "frame:<substring>". May be empty; callers reject that. */
export function frameNeedle(selector: string): string {
  return selector.slice(FRAME_SELECTOR_PREFIX.length);
}

export function isFrameTargetType(type: string | undefined): boolean {
  return type === FRAME_TARGET_TYPE;
}

export interface FrameResolution<T> {
  /** Out-of-process iframe targets whose url contains the needle. */
  matches: T[];
  /** Every live iframe target, for a miss message that lists the alternatives. */
  liveFrames: T[];
}

/**
 * Pure: split a target listing into "iframes matching the needle" and "all live
 * iframes". An EMPTY needle matches nothing here rather than matching
 * everything, because `"anything".includes("")` is true and a bare `frame:`
 * would otherwise silently mean "whichever iframe happens to be first".
 * Callers reject the empty needle outright with FRAME_EMPTY_NEEDLE_MESSAGE.
 */
export function resolveFrameTargets<T extends FrameTargetLike>(targets: readonly T[], needle: string): FrameResolution<T> {
  const liveFrames = targets.filter((t) => isFrameTargetType(t.type));
  return {
    matches: needle === "" ? [] : liveFrames.filter((t) => t.url.includes(needle)),
    liveFrames,
  };
}

/* -------------------------------- shared message text -------------------------------- */

export const FRAME_EMPTY_NEEDLE_MESSAGE =
  "'frame:' needs a substring of the iframe's url, e.g. frame:ads.example.com or frame:player.html";

/**
 * The Firefox refusal. A PARAM-level gap, exactly like drag's mode:'html5' and
 * the worker arm's WORKER_SELECTOR_UNSUPPORTED_MESSAGE: the target-taking tools
 * stay in tools/list on Firefox because every tab selector still works there,
 * and only this one arm is refused. Naming the reason matters — WebDriver BiDi
 * has no iframe TARGET: iframes are realms inside a browsing context, and a
 * context IS a tab, so there is nothing for a target selector to resolve to.
 * This is a protocol-model gap, not an unimplemented to-do.
 */
export const FRAME_SELECTOR_UNSUPPORTED_MESSAGE =
  "target 'frame:<substring>' selects an out-of-process iframe, which this backend cannot address " +
  "(WebDriver BiDi has no iframe target — an iframe is a realm inside its tab's browsing context, not a " +
  "selectable target; Capability 'frame.targets' is Chrome-only). Use --browser chrome to act on a cross-origin iframe.";

/**
 * Refusal from the page-only resolvers (close_page / select_page /
 * release_page / claim_page): those act on the embedder TAB, and an iframe has
 * no independent existence to close, select, release or claim. Because the arm
 * is accepted by every OTHER target-taking tool (it resolves inside the shared
 * pickTarget), the message names the refusing minority rather than an allowlist
 * of the accepting majority.
 */
export const FRAME_SELECTOR_PAGE_ONLY_MESSAGE =
  "target 'frame:<substring>' selects an out-of-process iframe, and this tool is page-only " +
  "(closing, selecting, releasing or claiming an iframe is meaningless; these act on the embedder tab). " +
  `The page-only tools are ${FRAME_PAGE_ONLY_TOOLS.join(", ")}; every other tool that takes a 'target' ` +
  "accepts a frame: selector.";

/** Ambiguity never resolves to a silent first match: name every candidate. */
export function frameAmbiguityMessage(needle: string, matches: readonly FrameTargetLike[]): string {
  return (
    `'frame:${needle}' matches more than one out-of-process iframe: ` +
    matches.map((m) => `${m.url} (${m.id})`).join(", ") +
    ". Narrow the substring, or pass the iframe's target id directly."
  );
}

/**
 * The miss message, and the whole reason this module owns its text. A miss
 * here is usually NOT a typo, for one of two reasons the caller can act on:
 *   - the iframe is SAME-ORIGIN: it runs inside its parent page's process, has
 *     no target at all, and can never be selected by any substring. The fix is
 *     to go through the parent page (evaluate_script on the page, then
 *     contentDocument through the iframe element).
 *   - the frame navigated away or was removed: an OOPIF target is as
 *     short-lived as the document inside it, so the id seen a moment ago is
 *     simply gone. The fix is to re-list.
 */
export function frameMissMessage(needle: string, liveFrames: readonly FrameTargetLike[]): string {
  const live = liveFrames.length
    ? ` (out-of-process iframes: ${liveFrames.map((f) => f.url).join(", ")})`
    : " (no out-of-process iframes are live)";
  return (
    `no out-of-process iframe whose url contains '${needle}'${live}. ` +
    "Only a CROSS-ORIGIN iframe gets its own process and therefore its own target; a same-origin iframe " +
    "runs inside its parent page and is NOT a target at all, so no substring can ever select it — reach a " +
    "same-origin iframe through its parent page instead (evaluate_script on the page, then the iframe " +
    "element's contentDocument). An out-of-process iframe whose document navigated away is likewise gone " +
    "from the listing: re-list with list_pages{all:true} and pass the new target id."
  );
}
