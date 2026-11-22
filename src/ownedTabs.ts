/**
 * The tabs THIS MCP server process opened: closed when it exits, and capped while it runs.
 *
 * WHY. An agent's MCP server is started and stopped with its session. Before this module only
 * hidden tabs (CDP_HIDDEN_TABS, ./cdp/hiddenTabs.ts) died with it; an ordinary background tab an
 * agent opened stayed in the user's browser forever unless the agent remembered close_page, and
 * reap.ts only closes a tab that was LEASED and then abandoned. Sessions that end by timeout,
 * kill or a closed terminal never call close_page, so tabs piled up.
 *
 * WHAT IS CLOSED ON EXIT. A tab qualifies only when ALL of these hold (exitVerdict):
 *   1. this process created it (it is in this registry, written by newTrackedPage, the one place a
 *      tab is created) and has not given it up since: close_page and release_page forget it, even
 *      release_page{close:false}, which is an agent deliberately leaving a tab open;
 *   2. it was not opened FOR THE HUMAN: new_page{focus:true} (or claim_page{focus:true}) opens a
 *      tab the person is meant to look at, for example a Teams draft they still have to Send, and
 *      select_page{focus:true} on a tab marks it the same way. Those survive exit;
 *   3. its origin record (origins.ts) is present and readable, i.e. list_pages shows origin
 *      'agent'. A tab of 'unknown' origin is never closed, whatever the registry says;
 *   4. no OTHER process holds a lease on it, and its lease row (if any) is readable;
 *   5. it is still open.
 * Another process's agent tab is never in this registry, so it is never considered.
 *
 * WHY A PROCESS-MEMORY REGISTRY AND NOT THE ON-DISK ORIGIN LEDGER. The ledger says "some agent
 * made this"; it is shared by every server on the box and outlives its writer on purpose. The
 * question here is "did THIS process make it", which only this process can answer, and the
 * answer is worthless after it exits, so module scope is the right lifetime (same reasoning as
 * leases.ts's longLived flag and hiddenTabs.ts's owners map).
 *
 * THE CAP (CDP_MAX_AGENT_TABS, default 20, 0 = no cap). Counts this process's live tabs that will
 * be closed on exit (so not the ones for the human, which the human can see and close). At the cap
 * new_page and claim_page REFUSE with AgentTabCapError naming the open tabs, oldest first. They do
 * not close the oldest one: an agent may still be driving it, or another call may hold its lease,
 * and silently closing a tab someone is using is the one failure this toolkit refuses everywhere
 * else (hiddenTabs.ts's cap and reap.ts make the same call). Refusing is recoverable: the agent
 * reads the error and closes what it no longer needs. Before refusing, ids the browser no longer
 * lists (closed by the human or the browser) are dropped, so a stale count never blocks.
 * Under CDP_HIDDEN_TABS both caps apply: CDP_HIDDEN_TABS_MAX bounds hidden tabs per endpoint, this
 * one bounds every background tab of this process; the smaller one wins.
 *
 * TABS OPENED BY AN OWNED TAB (window.open, a target=_blank link, a web app that hops to a copy of
 * itself and closes the original) are this process's too: the CDP driver's watchPopups reports
 * each new page with its opener (./cdp/popupWatch.ts), and adoptPopup records the popup with the
 * opener's keepOnExit and label and writes its origin record, so list_pages shows it as 'agent'.
 * So a popup of an agent tab closes on exit and counts toward the cap; a popup of a tab opened for
 * the human is kept, like its opener. A popup of any tab this process does not hold (the human's,
 * another process's) is not touched. The cap cannot refuse a popup (the page already made it), so
 * popups can take a process past the cap; the next new_page is then refused.
 *
 * CLI. Nothing is recorded under the one-shot CLI (isLongLivedProcess false): its whole point is
 * a tab that outlives the command that opened it. So the CLI has neither close-on-exit nor a cap.
 */
import type { BrowserDriver } from "./driver.ts";
import { currentEndpoint, withEndpointScope, type Endpoint } from "./endpoints.ts";
import { isLongLivedProcess, listLeases, releaseLeaseFor, type LeaseBackend, type LeaseSummary } from "./leases.ts";
import { originIndex, recordOrigin, type OriginSummary } from "./origins.ts";

export const DEFAULT_MAX_AGENT_TABS = 20;
/** Whole-shutdown budget for closing tabs, so a wedged browser cannot hold the process open. */
export const DEFAULT_CLOSE_ON_EXIT_TIMEOUT_MS = 5_000;

const FALSY = new Set(["0", "false", "no", "off"]);

/** CDP_MAX_AGENT_TABS: a positive integer, 0 for no cap; anything else means the default. Read per call. */
export function maxAgentTabs(): number {
  const raw = (process.env.CDP_MAX_AGENT_TABS ?? "").trim();
  if (raw === "") return DEFAULT_MAX_AGENT_TABS;
  const n = Number(raw);
  if (n === 0) return Infinity;
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : DEFAULT_MAX_AGENT_TABS;
}

/** On in the MCP server unless CDP_CLOSE_ON_EXIT is 0/false/no/off. Never under the CLI. */
export function closeOnExitEnabled(): boolean {
  return isLongLivedProcess() && !FALSY.has((process.env.CDP_CLOSE_ON_EXIT ?? "").trim().toLowerCase());
}

export interface OwnedTab {
  targetId: string;
  backend: LeaseBackend;
  /** Chrome only: the named endpoint it was opened on, so shutdown closes it on the right browser. */
  endpoint?: Endpoint;
  /** Opened or shown for the human: survives exit and is not counted against the cap. */
  keepOnExit: boolean;
  createdAt: number;
  /** The label its origin record carries, passed on to the tabs it opens. */
  label?: string;
  /** Set on a popup: the owned tab that opened it. */
  openedBy?: string;
}

/** Thrown at the cap. `code` makes it surface as a typed page error, like HiddenTabCapError. */
export class AgentTabCapError extends Error {
  readonly code = "page-error" as const;
  constructor(readonly max: number, readonly openIds: string[]) {
    super(
      `agent-tab cap reached: this server has ${openIds.length} agent tabs open (CDP_MAX_AGENT_TABS=${max}). ` +
        `Close one you no longer need with close_page (open, oldest first: ${openIds.join(", ")}), ` +
        `or pass focus:true if this tab is for the human (it is not counted and survives exit).`,
    );
    this.name = "AgentTabCapError";
  }
}

/* ------------------------------ registry ------------------------------ */

/** Insertion order is age, oldest first. Key: backend + NUL + targetId. */
const owned = new Map<string, OwnedTab>();
/** Creates in flight per backend, counted against the cap so concurrent calls cannot overshoot it. */
const reserved = new Map<LeaseBackend, number>();

const key = (backend: LeaseBackend, id: string) => `${backend}\u0000${id}`;

/** Popups whose opener is still being created (its commit has not landed), keyed by the opener. */
const earlyPopups = new Map<string, Array<{ childId: string; at: number }>>();
const EARLY_POPUP_TTL_MS = 60_000;
const EARLY_POPUP_MAX = 100;
/** Creates in flight (both kinds, for the human or not): early popups are buffered only then. */
let creating = 0;
/** Origin writes for adopted popups still in flight; see popupsSettled. */
const popupWrites = new Set<Promise<void>>();

/** Test hook: forget everything. */
export function resetOwnedTabs(): void {
  owned.clear();
  reserved.clear();
  earlyPopups.clear();
  creating = 0;
}

/** Resolves once every adopted popup's origin record is written. closeOwnedTabs waits on it. */
export async function popupsSettled(): Promise<void> {
  while (popupWrites.size) await Promise.all([...popupWrites]);
}

/**
 * A page `childId` was opened by `openerId` (from the CDP driver's watchPopups). When this process
 * holds the opener, the popup becomes this process's too: same keepOnExit, same label, agent
 * origin. When the opener is not held, nothing happens, unless a create is in flight, in which case
 * the popup waits (bounded) for that create to commit, since a page can open a popup before
 * new_page returns.
 */
export function adoptPopup(backend: LeaseBackend, childId: string, openerId: string): void {
  if (!isLongLivedProcess() || owned.has(key(backend, childId))) return;
  const opener = owned.get(key(backend, openerId));
  if (!opener) {
    if (creating === 0) return;
    const now = Date.now();
    for (const [k, list] of earlyPopups) {
      const fresh = list.filter((e) => now - e.at < EARLY_POPUP_TTL_MS);
      if (fresh.length) earlyPopups.set(k, fresh);
      else earlyPopups.delete(k);
    }
    let total = 0;
    for (const list of earlyPopups.values()) total += list.length;
    if (total >= EARLY_POPUP_MAX) return;
    const k = key(backend, openerId);
    earlyPopups.set(k, [...(earlyPopups.get(k) ?? []), { childId, at: now }]);
    return;
  }
  owned.set(key(backend, childId), {
    targetId: childId,
    backend,
    ...(opener.endpoint ? { endpoint: opener.endpoint } : {}),
    keepOnExit: opener.keepOnExit,
    createdAt: Date.now(),
    ...(opener.label !== undefined ? { label: opener.label } : {}),
    openedBy: openerId,
  });
  const write = (async () => {
    const run = () => recordOrigin(backend, childId, { label: opener.label });
    await (opener.endpoint ? withEndpointScope(opener.endpoint, run) : run());
  })()
    .catch(() => undefined)
    .finally(() => popupWrites.delete(write));
  popupWrites.add(write);
  adoptEarlyPopups(backend, childId);
}

function adoptEarlyPopups(backend: LeaseBackend, openerId: string): void {
  const k = key(backend, openerId);
  const list = earlyPopups.get(k);
  if (!list) return;
  earlyPopups.delete(k);
  for (const e of list) adoptPopup(backend, e.childId, openerId);
}

/** This process's recorded tab ids on `backend`, oldest first; closableOnly drops the human's. */
export function ownedTabIds(backend: LeaseBackend, opts: { closableOnly?: boolean } = {}): string[] {
  const out: string[] = [];
  for (const t of owned.values()) {
    if (t.backend !== backend) continue;
    if (opts.closableOnly && t.keepOnExit) continue;
    out.push(t.targetId);
  }
  return out;
}

/** close_page / release_page: this process gave the tab up. A no-op for a tab it never recorded. */
export function forgetOwnedTab(backend: LeaseBackend, id: string): void {
  owned.delete(key(backend, id));
}

/** select_page{focus:true}: the tab is now in front of the human, so it survives exit. */
export function markShownToHuman(backend: LeaseBackend, id: string): void {
  const t = owned.get(key(backend, id));
  if (t) t.keepOnExit = true;
}

/** A hidden tab revealed as a new visible one (select_page focus:true): carry ownership over, kept. */
export function moveOwnedTab(backend: LeaseBackend, fromId: string, toId: string): void {
  const t = owned.get(key(backend, fromId));
  if (!t) return;
  owned.delete(key(backend, fromId));
  owned.set(key(backend, toId), { ...t, targetId: toId, keepOnExit: true });
}

function endpointOf(driver: BrowserDriver): Endpoint | undefined {
  return driver.scheme === "bidi" ? undefined : currentEndpoint();
}

export interface AgentTabSlot {
  /** The tab was created: record it. */
  commit(targetId: string): void;
  /** Creation failed: give the slot back. */
  cancel(): void;
}

const NOOP_SLOT: AgentTabSlot = { commit() {}, cancel() {} };

/**
 * Called by newTrackedPage BEFORE it opens a tab. Throws AgentTabCapError at the cap (after
 * dropping ids the browser no longer lists); otherwise holds a slot until commit or cancel.
 */
export async function reserveAgentTab(
  driver: BrowserDriver,
  backend: LeaseBackend,
  opts: { forHuman: boolean; label?: string },
): Promise<AgentTabSlot> {
  if (!isLongLivedProcess()) return NOOP_SLOT;
  const endpoint = endpointOf(driver);
  // Up before the tab exists, so a popup the page opens while it loads is seen. Best effort.
  await driver.watchPopups?.((childId, openerId) => adoptPopup(backend, childId, openerId))?.catch(() => undefined);
  const label = opts.label;
  const record = (keepOnExit: boolean) => (targetId: string) => {
    owned.set(key(backend, targetId), {
      targetId, backend, ...(endpoint ? { endpoint } : {}), keepOnExit, createdAt: Date.now(), ...(label !== undefined ? { label } : {}),
    });
    adoptEarlyPopups(backend, targetId);
  };
  if (opts.forHuman) return inFlight({ commit: record(true), cancel() {} });

  const max = maxAgentTabs();
  const used = () => ownedTabIds(backend, { closableOnly: true }).length + (reserved.get(backend) ?? 0);
  if (used() >= max) {
    // Only ids recorded BEFORE the listing are judged by it: a concurrent call may commit a tab
    // while the listing is in flight, and that tab is live even though the listing predates it.
    const before = ownedTabIds(backend);
    const listed = await driver.listPages().catch(() => undefined);
    if (listed) {
      const live = new Set(listed.map((p) => p.id));
      for (const id of before) if (!live.has(id)) forgetOwnedTab(backend, id);
    }
  }
  // Re-checked after the await, synchronously with the increment below, so two concurrent calls
  // that both pruned cannot both take the last slot.
  if (used() >= max) throw new AgentTabCapError(max, ownedTabIds(backend, { closableOnly: true }));
  reserved.set(backend, (reserved.get(backend) ?? 0) + 1);
  let settled = false;
  const release = () => {
    if (settled) return;
    settled = true;
    reserved.set(backend, Math.max(0, (reserved.get(backend) ?? 0) - 1));
  };
  return inFlight({
    commit(targetId) {
      release();
      record(false)(targetId);
    },
    cancel: release,
  });
}

/** Count `slot` as a create in flight until it commits or cancels (see adoptPopup's early buffer). */
function inFlight(slot: AgentTabSlot): AgentTabSlot {
  creating++;
  let done = false;
  const end = () => {
    if (done) return;
    done = true;
    creating = Math.max(0, creating - 1);
  };
  return {
    commit(id) {
      slot.commit(id);
      end();
    },
    cancel() {
      slot.cancel();
      end();
    },
  };
}

/* ------------------------------ exit selection (pure) ------------------------------ */

export type ExitSkipReason = "for-human" | "gone" | "unknown-origin" | "held-by-other" | "lease-unreadable";

export interface ExitInput {
  owned: readonly OwnedTab[];
  livePageIds: readonly string[];
  origins: ReadonlyMap<string, OriginSummary>;
  leases: readonly LeaseSummary[];
  /** This process's pid: a lease row with any other pid is someone else's. */
  pid: number;
}

/** Why `tab` may or may not be closed at exit. PURE: see the header for the five conditions. */
export function exitVerdict(tab: OwnedTab, input: ExitInput, live = new Set(input.livePageIds)): "close" | ExitSkipReason {
  if (tab.keepOnExit) return "for-human";
  if (!live.has(tab.targetId)) return "gone";
  const origin = input.origins.get(tab.targetId);
  if (origin === undefined || origin.unreadable !== undefined) return "unknown-origin";
  for (const row of input.leases) {
    if (row.backend !== tab.backend || row.targetId !== tab.targetId) continue;
    if (row.unreadable !== undefined) return "lease-unreadable";
    if (row.pid !== input.pid) return "held-by-other";
  }
  return "close";
}

/** The owned tabs that may be closed at exit. PURE. */
export function exitClosable(input: ExitInput): OwnedTab[] {
  const live = new Set(input.livePageIds);
  return input.owned.filter((t) => exitVerdict(t, input, live) === "close");
}

/* ------------------------------ shutdown ------------------------------ */

export interface CloseOwnedResult {
  closed: string[];
  /** Tabs for the human, left open on purpose. */
  kept: string[];
  /** Tabs left open for any other reason. "gone" ones are not listed: there is nothing to report. */
  skipped: Array<{ targetId: string; reason: Exclude<ExitSkipReason, "for-human" | "gone"> | "close-failed" | "timeout" }>;
}

/**
 * The MCP server's shutdown path: close this process's agent tabs (see the header), release their
 * leases, then forget the registry so a second call is a no-op. Bounded by `timeoutMs` overall and
 * never throws: shutdown must finish even when the browser is wedged or gone.
 */
export async function closeOwnedTabs(driver: BrowserDriver, opts: { timeoutMs?: number } = {}): Promise<CloseOwnedResult> {
  const result: CloseOwnedResult = { closed: [], kept: [], skipped: [] };
  // A popup adopted just now must have its origin record on disk before exitVerdict reads it.
  await popupsSettled();
  const tabs = [...owned.values()];
  resetOwnedTabs();
  if (!closeOnExitEnabled() || tabs.length === 0) return result;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_CLOSE_ON_EXIT_TIMEOUT_MS;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<"timeout">((r) => {
    timer = setTimeout(() => r("timeout"), timeoutMs);
  });
  const pending = new Set(tabs.filter((t) => !t.keepOnExit).map((t) => t.targetId));
  for (const t of tabs) if (t.keepOnExit) result.kept.push(t.targetId);

  // One group per (backend, endpoint): each is a different browser or lease namespace.
  const groups = new Map<string, OwnedTab[]>();
  for (const t of tabs) {
    if (t.keepOnExit) continue;
    const g = `${t.backend}\u0000${t.endpoint?.name ?? ""}`;
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g)!.push(t);
  }

  const work = Promise.all(
    [...groups.values()].map((group) => {
      const run = async () => {
        const backend = group[0]!.backend;
        const livePageIds = (await driver.listPages()).map((p) => p.id);
        const [origins, leases] = await Promise.all([
          originIndex(backend, undefined),
          listLeases({ liveIds: livePageIds, liveBackend: backend }),
        ]);
        const input: ExitInput = { owned: group, livePageIds, origins, leases, pid: process.pid };
        await Promise.all(
          group.map(async (t) => {
            const v = exitVerdict(t, input);
            if (v === "gone" || v === "for-human") {
              pending.delete(t.targetId);
              return;
            }
            if (v !== "close") {
              pending.delete(t.targetId);
              result.skipped.push({ targetId: t.targetId, reason: v });
              return;
            }
            const res = await driver.closePage(t.targetId).catch(() => ({ success: false }));
            pending.delete(t.targetId);
            if (res.success !== true) {
              result.skipped.push({ targetId: t.targetId, reason: "close-failed" });
              return;
            }
            await releaseLeaseFor(backend, t.targetId).catch(() => undefined);
            result.closed.push(t.targetId);
          }),
        );
      };
      const ep = group[0]!.endpoint;
      return (ep ? withEndpointScope(ep, run) : run()).catch(() => undefined);
    }),
  );
  const outcome = await Promise.race([work.then(() => "done" as const), deadline]);
  clearTimeout(timer);
  if (outcome === "timeout") for (const id of pending) result.skipped.push({ targetId: id, reason: "timeout" });
  return result;
}

/* ------------------------------ parent watch ------------------------------ */

/**
 * Call `onGone` once when this process's parent goes away. A stdio MCP server normally sees stdin
 * close when its client exits, but a client that dies without closing the pipe (or leaves it held
 * by a grandchild) leaves the server orphaned and reparented, so process.ppid changes. Polled,
 * unref'd, so it never keeps the process alive. Returns a stop function.
 */
export function watchParent(onGone: () => void, opts: { intervalMs?: number; getPpid?: () => number } = {}): () => void {
  const getPpid = opts.getPpid ?? (() => process.ppid);
  const start = getPpid();
  const timer = setInterval(() => {
    if (getPpid() === start) return;
    clearInterval(timer);
    onGone();
  }, opts.intervalMs ?? 1_000);
  (timer as { unref?: () => void }).unref?.();
  return () => clearInterval(timer);
}
