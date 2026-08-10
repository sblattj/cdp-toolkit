/**
 * The "worker:<substring>" arm of the TargetSelector grammar.
 *
 * WHAT IT IS FOR. An MV3 extension keeps its logic in a background SERVICE
 * WORKER, not in a page, so `chrome.storage.local` and everything else an
 * extension owns is unreachable through a page-typed selector. This arm names
 * that worker by a substring of its url, which for an extension is
 * `chrome-extension://<id>/<script>` — so `worker:<extension-id>` and
 * `worker:background.js` both work.
 *
 * WHY DATA, NEVER THROWS (the resolveLiveLabel precedent in origins.ts). The
 * grammar has three independent resolver copies — `pickTarget` in client.ts,
 * `pickPage` in shared-tools.ts, `pickContext` in bidi/driver.ts — each with its
 * own error class (CdpError / SharedToolError / DriverError). A shared resolver
 * that threw would force one class on all three, so this returns the facts and
 * each caller raises its own error. What IS shared is the message TEXT below,
 * because the teaching in it (MV3 eviction) is the point of the feature and
 * three hand-written variants of it would drift apart within one release.
 *
 * WHY THE ALL-TARGETS LISTING. Chrome's `/json/list` only reports a worker that
 * is currently RUNNING, and the page-only listing that the other arms resolve
 * against never contains one at all. So this arm reads the unfiltered listing.
 * That does NOT merge the two id sets that reap and leases keep apart: see
 * ReapInput.livePageIds's header, and the lease bypass in client.ts's
 * resolveTarget.
 *
 * THE MEASURED FACT THE MESSAGES TEACH (Chrome 151.0.7922.109, probed live for
 * 1.9.0, transcript in the release evidence): an idle MV3 service worker is
 * evicted within seconds of its last activity, and once evicted it is absent
 * from `/json/list` AND from `Target.getTargets` under every filter — it is not
 * a target at all. "No such worker" therefore almost never means "wrong id"; it
 * means "asleep". A miss message that did not say so would send a caller
 * hunting for a typo that is not there.
 */

/** Selector prefix owned by this arm. */
export const WORKER_SELECTOR_PREFIX = "worker:";

/**
 * CDP target types this arm resolves. `service_worker` is the MV3 case that
 * motivated the feature; `shared_worker` is included because it presents the
 * same way (own target, own webSocketDebuggerUrl, evaluable over Runtime) and
 * excluding it would be an arbitrary gap. A DEDICATED (per-page) worker is NOT
 * here: it has no independent existence to select by url.
 */
export const WORKER_TARGET_TYPES: ReadonlySet<string> = new Set(["service_worker", "shared_worker"]);

/** The three fields every listing shape (CDP Target, PageInfo) already carries. */
export interface WorkerTargetLike {
  id: string;
  url: string;
  type?: string;
}

export function isWorkerSelector(selector: string | undefined): selector is string {
  return typeof selector === "string" && selector.startsWith(WORKER_SELECTOR_PREFIX);
}

/** The substring half of "worker:<substring>". May be empty; callers reject that. */
export function workerNeedle(selector: string): string {
  return selector.slice(WORKER_SELECTOR_PREFIX.length);
}

export function isWorkerTargetType(type: string | undefined): boolean {
  return type !== undefined && WORKER_TARGET_TYPES.has(type);
}

export interface WorkerResolution<T> {
  /** Running worker targets whose url contains the needle. */
  matches: T[];
  /** Every running worker target, for a miss message that lists the alternatives. */
  liveWorkers: T[];
}

/**
 * Pure: split a target listing into "workers matching the needle" and "all
 * running workers". An EMPTY needle matches nothing here rather than matching
 * everything, because `"anything".includes("")` is true and a bare `worker:`
 * would otherwise silently mean "whichever worker happens to be first".
 * Callers reject the empty needle outright with WORKER_EMPTY_NEEDLE_MESSAGE.
 */
export function resolveWorkerTargets<T extends WorkerTargetLike>(targets: readonly T[], needle: string): WorkerResolution<T> {
  const liveWorkers = targets.filter((t) => isWorkerTargetType(t.type));
  return {
    matches: needle === "" ? [] : liveWorkers.filter((t) => t.url.includes(needle)),
    liveWorkers,
  };
}

/* -------------------------------- shared message text -------------------------------- */

export const WORKER_EMPTY_NEEDLE_MESSAGE =
  "'worker:' needs a substring of the worker's url, e.g. worker:<extension-id> or worker:background.js";

/**
 * The Firefox refusal. A PARAM-level gap, exactly like drag's mode:'html5'
 * (see resolveDragMode): evaluate_script stays in tools/list on Firefox because
 * every page selector still works there, and only this one arm is refused.
 * Naming the reason matters — WebDriver BiDi has no extension-worker target
 * concept to map onto, so this is a protocol gap, not an unimplemented to-do.
 */
export const WORKER_SELECTOR_UNSUPPORTED_MESSAGE =
  "target 'worker:<substring>' selects a service/shared worker, which this backend cannot address " +
  "(WebDriver BiDi has no extension service-worker target; Capability 'worker.targets' is Chrome-only). " +
  "Use --browser chrome to evaluate in an extension's background worker.";

/** Refusal from the page-only resolvers (close_page / select_page / release_page). */
export const WORKER_SELECTOR_PAGE_ONLY_MESSAGE =
  "target 'worker:<substring>' selects a service/shared worker, and this tool is page-only " +
  "(closing, selecting or releasing a worker is meaningless). evaluate_script is the one tool that " +
  "accepts a worker: target.";

function urlList(workers: readonly WorkerTargetLike[]): string {
  return workers.map((w) => w.url).join(", ");
}

/** Ambiguity never resolves to a silent first match: name every candidate. */
export function workerAmbiguityMessage(needle: string, matches: readonly WorkerTargetLike[]): string {
  return (
    `'worker:${needle}' matches more than one running worker: ` +
    matches.map((m) => `${m.url} (${m.id})`).join(", ") +
    ". Narrow the substring, or pass the worker's target id directly."
  );
}

/**
 * The miss message, and the whole reason this module owns its text.
 *
 * `wakeAttempted` distinguishes the two genuinely different failures, which a
 * single message could only blur:
 *   - wake:false — the worker may exist and simply be asleep. Say so, and say
 *     what would have been done about it.
 *   - wake:true and it still did not appear — a start was actually requested
 *     and Chrome produced no worker. `registeredScopes` is what separates
 *     "nothing by that name is installed" from "installed but it would not
 *     start", so it is included when the inventory could be read.
 */
export function workerMissMessage(
  needle: string,
  opts: { wakeAttempted: boolean; liveWorkers?: readonly WorkerTargetLike[]; registeredScopes?: readonly string[] },
): string {
  const running = opts.liveWorkers?.length ? ` (running workers: ${urlList(opts.liveWorkers)})` : " (no workers are running)";
  if (!opts.wakeAttempted) {
    return (
      `no running worker whose url contains '${needle}'${running}. ` +
      "An MV3 extension service worker is idle-evicted after seconds of inactivity and then appears in NO target " +
      "listing, so this is usually a sleeping worker rather than a wrong substring. You passed wake:false; " +
      "wake:true (the default) asks Chrome to start it first."
    );
  }
  const scopes = opts.registeredScopes?.length
    ? ` Registered service-worker scopes in this browser: ${opts.registeredScopes.join(", ")}.`
    : " No service-worker registrations were reported by this browser at all.";
  return (
    `no worker whose url contains '${needle}' could be reached${running}. ` +
    `A start was requested (wake:true) and no matching worker appeared.${scopes} ` +
    "If the extension is installed but its worker never starts, check the worker script for a top-level throw."
  );
}
