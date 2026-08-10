/**
 * Chrome-only: resolving a "worker:<substring>" selector, including WAKING an
 * idle-evicted MV3 service worker so there is something to resolve.
 *
 * EVERY PROTOCOL CHOICE BELOW WAS MEASURED against Chrome 151.0.7922.109 for
 * 1.9.0, because the obvious ones are wrong:
 *
 *  1. `ServiceWorker.enable` and `ServiceWorker.startWorker` DO NOT EXIST on the
 *     browser endpoint — both answer `-32601 wasn't found` there. The domain is
 *     reachable only over a session attached to a PAGE target. Any page works;
 *     a plain `about:blank` tab hosted the wake in the probe, so no page on the
 *     extension's own origin is needed. That is why this opens a browser
 *     connection and then attaches a flattened session to some page, rather
 *     than talking to the browser endpoint directly.
 *
 *  2. A STOPPED worker is not a target. It is absent from `/json/list` and from
 *     `Target.getTargets` under every filter tried (including an explicit
 *     all-types filter, and after `Target.setDiscoverTargets`). The ONLY place a
 *     stopped worker is visible is the registration inventory that
 *     `ServiceWorker.enable` pushes as `workerRegistrationUpdated` /
 *     `workerVersionUpdated`. So matching a substring against a sleeping worker
 *     means matching against those events, not against a target list.
 *
 *  3. `ServiceWorker.startWorker` RETURNS EMPTY SUCCESS FOR A SCOPE THAT DOES
 *     NOT EXIST — a completely invented `chrome-extension://aaaa.../` scope
 *     answers `{}` exactly like a real one. Its result is therefore worthless as
 *     evidence, and nothing here reports a wake on the strength of it: the
 *     caller re-reads the target list and only a worker that actually shows up
 *     counts. This is the one dishonesty the feature could most easily ship.
 *
 * WHY THE CONNECTION IS ALWAYS CLOSED IN A `finally`. Two reasons, and the
 * second is not obvious: a leaked socket keeps the process alive (the standing
 * harness rule), AND an attached CDP session KEEPS A SERVICE WORKER FROM BEING
 * EVICTED. A connection left open here would suppress the very eviction this
 * module exists to recover from, so the leak would hide itself.
 */
import { CdpError, listTargets, openBrowser } from "../client.ts";
import type { Target } from "../types.ts";
import {
  resolveWorkerTargets,
  workerAmbiguityMessage,
  workerMissMessage,
  workerNeedle,
  WORKER_EMPTY_NEEDLE_MESSAGE,
} from "../workers.ts";

/** Bounded wait for the first inventory event after ServiceWorker.enable. A
 *  browser with no registrations at all never sends one, so this must time out
 *  rather than hang; the settle that follows collects the rest of the batch. */
const INVENTORY_FIRST_EVENT_MS = 1_500;
const INVENTORY_SETTLE_MS = 250;
/** Wake poll budget: 30 x 300ms = 9s. The probe saw a worker reappear in well
 *  under 2s; the headroom is for a cold worker whose top-level code does work. */
const WAKE_POLL_MS = 300;
const WAKE_POLL_ATTEMPTS = 30;

const NO_HOST_PAGE_MESSAGE =
  "cannot start a service worker: the ServiceWorker CDP domain is only reachable over a page session, " +
  "and this browser has no page target open. Open any tab (new_page) and retry — the tab does not have " +
  "to belong to the extension.";

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

interface RegistrationEvent {
  registrationId?: unknown;
  scopeURL?: unknown;
  isDeleted?: unknown;
}
interface VersionEvent {
  registrationId?: unknown;
  scriptURL?: unknown;
  runningStatus?: unknown;
}

export interface WorkerStartAttempt {
  /** True only when a matching registration was found AND a start was issued.
   *  Says nothing about whether the worker actually came up: see fact 3. */
  startRequested: boolean;
  /** Every registered scope this browser reported, for the miss message. */
  scopes: string[];
}

/**
 * Read the service-worker registration inventory and, when exactly one
 * registration matches `needle`, ask Chrome to start it.
 *
 * Matching is against the version's scriptURL OR the registration's scopeURL,
 * so both `worker:<extension-id>` (which appears in both) and
 * `worker:background.js` (which appears only in the scriptURL) resolve.
 */
export async function requestWorkerStart(needle: string): Promise<WorkerStartAttempt> {
  const conn = await openBrowser();
  try {
    const host = (await listTargets()).find((t) => t.type === "page");
    if (!host) throw new CdpError(NO_HOST_PAGE_MESSAGE);
    const { sessionId } = await conn.send<{ sessionId?: string }>("Target.attachToTarget", {
      targetId: host.id,
      flatten: true,
    });
    if (!sessionId) throw new CdpError("could not attach a session to host the ServiceWorker domain");

    const scopeById = new Map<string, string>();
    const versions: Array<{ registrationId: string; scriptURL: string }> = [];
    conn.on("ServiceWorker.workerRegistrationUpdated", (params) => {
      for (const r of (params.registrations as RegistrationEvent[] | undefined) ?? []) {
        if (r.isDeleted === true) continue;
        scopeById.set(String(r.registrationId), String(r.scopeURL ?? ""));
      }
    });
    conn.on("ServiceWorker.workerVersionUpdated", (params) => {
      for (const v of (params.versions as VersionEvent[] | undefined) ?? []) {
        versions.push({ registrationId: String(v.registrationId), scriptURL: String(v.scriptURL ?? "") });
      }
    });

    await conn.send("ServiceWorker.enable", {}, { sessionId });
    // The inventory arrives as events AFTER the enable response, so waiting on
    // the response alone would read an empty map every time.
    await conn.waitFor("ServiceWorker.workerVersionUpdated", undefined, INVENTORY_FIRST_EVENT_MS).catch(() => undefined);
    await sleep(INVENTORY_SETTLE_MS);

    const scopes = [...new Set(scopeById.values())].filter((s) => s.length > 0).sort();
    const matched = new Set<string>();
    for (const v of versions) {
      const scope = scopeById.get(v.registrationId);
      if (scope === undefined) continue;
      if (v.scriptURL.includes(needle) || scope.includes(needle)) matched.add(scope);
    }
    if (matched.size === 0) return { startRequested: false, scopes };
    if (matched.size > 1) {
      throw new CdpError(
        `'worker:${needle}' matches more than one registered service-worker scope: ${[...matched].sort().join(", ")}. ` +
          "Narrow the substring.",
      );
    }
    await conn.send("ServiceWorker.startWorker", { scopeURL: [...matched][0]! }, { sessionId });
    return { startRequested: true, scopes };
  } finally {
    // See the header: a held session also suppresses eviction.
    conn.close();
  }
}

/**
 * Resolve a `worker:<substring>` selector to a live worker target, waking an
 * evicted worker first when `wake` is true (the default at the tool surface).
 *
 * The wake path is: match running targets -> nothing -> ask for a start ->
 * RE-READ THE TARGET LIST until the worker appears or the budget runs out.
 * The re-read is the only evidence accepted that a wake happened.
 */
export async function resolveWorkerSelector(selector: string, opts: { wake: boolean }): Promise<Target> {
  const needle = workerNeedle(selector);
  if (needle === "") throw new CdpError(WORKER_EMPTY_NEEDLE_MESSAGE);

  const first = resolveWorkerTargets(await listTargets(), needle);
  if (first.matches.length > 1) throw new CdpError(workerAmbiguityMessage(needle, first.matches));
  if (first.matches.length === 1) return first.matches[0]!;

  if (!opts.wake) {
    throw new CdpError(workerMissMessage(needle, { wakeAttempted: false, liveWorkers: first.liveWorkers }));
  }

  const { startRequested, scopes } = await requestWorkerStart(needle);
  if (startRequested) {
    for (let i = 0; i < WAKE_POLL_ATTEMPTS; i++) {
      await sleep(WAKE_POLL_MS);
      const again = resolveWorkerTargets(await listTargets(), needle);
      if (again.matches.length > 1) throw new CdpError(workerAmbiguityMessage(needle, again.matches));
      if (again.matches.length === 1) return again.matches[0]!;
    }
  }
  const final = resolveWorkerTargets(await listTargets(), needle);
  throw new CdpError(
    workerMissMessage(needle, { wakeAttempted: true, liveWorkers: final.liveWorkers, registeredScopes: scopes }),
  );
}
