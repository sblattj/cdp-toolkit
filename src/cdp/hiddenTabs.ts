/**
 * Hidden tabs (CDP_HIDDEN_TABS=1, MCP server only): new_page without focus:true opens a
 * `Target.createTarget {background:true, hidden:true}` target that never becomes visible, so the
 * browser APP never comes to the front of the user's screen.
 *
 * WHY. Measured on Vivaldi (Chromium 156) by sampling `lsappinfo front` around raw CDP calls:
 * createTarget with {background:true}, {background:true, focus:false}, {newWindow:true,
 * background:true} and a minimized new window all bring the browser app to the front for a
 * moment (keepFrontApp in ../frontApp.ts puts the user's app back AFTER that flash). Only
 * {background:true, hidden:true} leaves the front app alone. Target.closeTarget and
 * Page.navigate on an existing tab are also clean.
 *
 * WHAT A HIDDEN TARGET IS, measured on the same browser:
 *   - It dies when the CDP connection that created it closes. So this module holds ONE owner
 *     browser connection per endpoint, for the life of the process. That is also why the feature
 *     is MCP-server only: under the one-shot CLI the tab would die at process exit, so the CLI
 *     keeps the visible path even with the env set (see hiddenTabsEnabled).
 *   - While the owner lives, the target is in /json/list and Target.getTargets, and any other
 *     connection can attach, evaluate, navigate and screenshot it. Its listing type is "other",
 *     not "page", so markHiddenTargets relabels the ids this process owns (see there).
 *   - Its viewport is 0x0: Page.captureScreenshot hangs and clicks land nowhere. The owner
 *     attaches (flatten), sets Emulation.setDeviceMetricsOverride and KEEPS that session, and then
 *     every other per-call connection sees the emulated viewport. A second connection that sets
 *     and clears its own override, or disconnects without clearing, leaves the owner's override
 *     in force once it is gone (measured). The device pixel ratio is read from the tab itself
 *     before the override: a hidden tab reports the real screen's devicePixelRatio (2 on a Retina
 *     Mac) even at 0x0.
 *   - It shares the default browser context, so cookies and logins carry over.
 *   - Target.activateTarget / Page.bringToFront return ok and show nothing, and window.open from
 *     it opens nothing. So a hidden tab cannot be revealed in place; see the driver's activatePage.
 *
 * OWNER LOSS (server restart, browser restart, socket drop) kills every hidden tab. The registry
 * notices on the next access (the owner's `isOpen` is false) and forgets them all, and the next
 * new_page reconnects lazily. A dead hidden id is then an ordinary missing target, so every tool
 * fails it with the existing `no-such-target` error from target resolution, never a hang.
 *
 * LEAK BOUND. The user can neither see nor close these tabs, so at most CDP_HIDDEN_TABS_MAX
 * (default 20) live at once per endpoint. At the cap new_page REFUSES with an error naming the
 * open hidden ids, rather than closing the oldest: silently closing a tab another call may still
 * be driving (or holds a lease on) is the one thing list_pages' reap is also never allowed to do
 * without saying so. dispose() (the MCP server's shutdown) closes them all.
 *
 * THIS MODULE IMPORTS NOTHING AT RUNTIME FROM ../client.ts: client.ts imports it (listTargets
 * calls markHiddenTargets), and the owner's connection factory is injected by ./driver.ts.
 */
import type { Target } from "../types.ts";

/** Default cap on live hidden tabs per endpoint. */
export const DEFAULT_HIDDEN_TABS_MAX = 20;
/** Emulated viewport for a hidden tab, in CSS px. */
export const HIDDEN_TAB_VIEWPORT = { width: 1280, height: 800 } as const;
/** Used when the tab cannot report its own devicePixelRatio. */
export const FALLBACK_DEVICE_SCALE_FACTOR = 2;
/** Bound on each owner-side command, so a wedged browser costs seconds, never a hang. */
const OWNER_COMMAND_TIMEOUT_MS = 5_000;

const TRUTHY = new Set(["1", "true", "yes", "on"]);

/** CDP_HIDDEN_TABS is set to a truthy value. Read per call, so a test can flip it. */
export function hiddenTabsRequested(): boolean {
  return TRUTHY.has((process.env.CDP_HIDDEN_TABS ?? "").trim().toLowerCase());
}

/** CDP_HIDDEN_TABS_MAX, else DEFAULT_HIDDEN_TABS_MAX. A non-positive or non-numeric value is ignored. */
export function hiddenTabsMax(): number {
  const raw = Number(process.env.CDP_HIDDEN_TABS_MAX);
  return Number.isFinite(raw) && raw >= 1 ? Math.floor(raw) : DEFAULT_HIDDEN_TABS_MAX;
}

/** The slice of CdpConnection the owner needs. */
export interface OwnerConnection {
  send<T = Record<string, unknown>>(method: string, params?: Record<string, unknown>, opts?: { timeoutMs?: number; sessionId?: string }): Promise<T>;
  on(method: string, handler: (params: Record<string, unknown>, sessionId?: string) => void): () => void;
  close(): void;
  readonly isOpen: boolean;
}

export interface HiddenTabOwnerDeps {
  /** Opens a fresh browser-endpoint connection (openBrowser in production). */
  connect(): Promise<OwnerConnection>;
  /** Creates the target with the settle wait (createSettledTarget in production). */
  createSettled(conn: OwnerConnection, url: string, opts: { hidden: true }): Promise<string>;
  /** Live cap; hiddenTabsMax by default. */
  max?: () => number;
}

/** Thrown at the cap. `code` makes it pass through noSuchTarget and the MCP error mapping typed. */
export class HiddenTabCapError extends Error {
  readonly code = "page-error" as const;
  constructor(readonly max: number, readonly openIds: string[]) {
    super(
      `hidden-tab cap reached: ${openIds.length} hidden tabs are open (CDP_HIDDEN_TABS_MAX=${max}). ` +
        `Close one with close_page (open hidden tabs, oldest first: ${openIds.join(", ")}), ` +
        `or pass focus:true to open a visible tab instead.`,
    );
    this.name = "HiddenTabCapError";
  }
}

/** One endpoint's owner connection and the hidden tabs it keeps alive. */
export class HiddenTabOwner {
  private conn: OwnerConnection | undefined;
  private connecting: Promise<OwnerConnection> | undefined;
  /** targetId -> the owner's session on it. Insertion order is age (oldest first). */
  private readonly tabs = new Map<string, string>();
  /** Creates in flight, counted against the cap so concurrent new_page calls cannot overshoot it. */
  private reserved = 0;

  constructor(private readonly deps: HiddenTabOwnerDeps) {}

  /** Forget everything if the owner socket died: its hidden tabs died with it. */
  private sweep(): void {
    if (this.conn && !this.conn.isOpen) {
      this.conn = undefined;
      this.tabs.clear();
    }
  }

  /** True when `id` is a live hidden tab this owner holds. */
  has(id: string): boolean {
    this.sweep();
    return this.tabs.has(id);
  }

  /** Live hidden ids, oldest first. */
  ids(): string[] {
    this.sweep();
    return [...this.tabs.keys()];
  }

  /** The owner connection, opened lazily and single-flight: concurrent callers share one connect. */
  private async owner(): Promise<OwnerConnection> {
    this.sweep();
    if (this.conn) return this.conn;
    if (!this.connecting) {
      this.connecting = (async () => {
        const conn = await this.deps.connect();
        // A hidden tab closed by anyone (another process's close_page, the browser itself) drops
        // out of the registry here; setDiscoverTargets is sent by createSettled.
        conn.on("Target.targetDestroyed", (params) => {
          const id = (params as { targetId?: unknown }).targetId;
          if (typeof id === "string") this.tabs.delete(id);
        });
        this.conn = conn;
        return conn;
      })().finally(() => {
        this.connecting = undefined;
      });
    }
    return this.connecting;
  }

  /** Create a hidden tab at `url`, attach the owner to it and give it a real viewport. */
  async create(url: string): Promise<string> {
    this.sweep();
    const max = (this.deps.max ?? hiddenTabsMax)();
    if (this.tabs.size + this.reserved >= max) throw new HiddenTabCapError(max, [...this.tabs.keys()]);
    this.reserved++;
    try {
      const conn = await this.owner();
      const id = await this.deps.createSettled(conn, url, { hidden: true });
      try {
        const { sessionId } = await conn.send<{ sessionId: string }>(
          "Target.attachToTarget",
          { targetId: id, flatten: true },
          { timeoutMs: OWNER_COMMAND_TIMEOUT_MS },
        );
        const dpr = await conn
          .send<{ result?: { value?: unknown } }>(
            "Runtime.evaluate",
            { expression: "devicePixelRatio", returnByValue: true },
            { sessionId, timeoutMs: OWNER_COMMAND_TIMEOUT_MS },
          )
          .then((r) => r.result?.value)
          .catch(() => undefined);
        await conn.send(
          "Emulation.setDeviceMetricsOverride",
          {
            width: HIDDEN_TAB_VIEWPORT.width,
            height: HIDDEN_TAB_VIEWPORT.height,
            deviceScaleFactor: typeof dpr === "number" && Number.isFinite(dpr) && dpr > 0 ? dpr : FALLBACK_DEVICE_SCALE_FACTOR,
            mobile: false,
          },
          { sessionId, timeoutMs: OWNER_COMMAND_TIMEOUT_MS },
        );
        this.tabs.set(id, sessionId);
        return id;
      } catch (e) {
        // A hidden tab without a viewport cannot be screenshotted or clicked: do not hand it out.
        await conn.send("Target.closeTarget", { targetId: id }, { timeoutMs: OWNER_COMMAND_TIMEOUT_MS }).catch(() => undefined);
        throw e;
      }
    } finally {
      this.reserved--;
    }
  }

  /**
   * Close a hidden tab over the owner. Closing the target ends the owner's session on it. When
   * the owner is already gone the tab is too, so this reports success:false like a close of any
   * missing target.
   */
  async close(id: string): Promise<{ success: boolean }> {
    this.sweep();
    const conn = this.conn;
    const held = this.tabs.delete(id);
    if (!conn || !held) return { success: false };
    const res = await conn.send<{ success?: boolean }>("Target.closeTarget", { targetId: id }, { timeoutMs: OWNER_COMMAND_TIMEOUT_MS });
    return { success: res.success ?? true };
  }

  /** Close every hidden tab, then the owner. Best effort and bounded; never throws. */
  async dispose(): Promise<void> {
    const conn = this.conn;
    const ids = [...this.tabs.keys()];
    this.tabs.clear();
    this.conn = undefined;
    if (!conn) return;
    if (conn.isOpen) {
      await Promise.all(ids.map((targetId) => conn.send("Target.closeTarget", { targetId }, { timeoutMs: OWNER_COMMAND_TIMEOUT_MS }).catch(() => undefined)));
    }
    conn.close();
  }
}

/* ------------------------------ process registry ------------------------------ */

/**
 * One owner per endpoint base, MODULE SCOPE like ./driver.ts's beaconSessions: the state belongs
 * to the process (the MCP server), and named endpoints are separate browsers whose target ids
 * mean nothing to each other.
 */
const owners = new Map<string, HiddenTabOwner>();

/** The owner for `base`, created on first use with `deps`. */
export function hiddenTabOwner(base: string, deps: () => HiddenTabOwnerDeps): HiddenTabOwner {
  let owner = owners.get(base);
  if (!owner) {
    owner = new HiddenTabOwner(deps());
    owners.set(base, owner);
  }
  return owner;
}

/** The owner for `base` if one was ever created. Never creates one. */
export function existingHiddenTabOwner(base: string): HiddenTabOwner | undefined {
  return owners.get(base);
}

/** True when `id` is a live hidden tab on endpoint `base`. */
export function isHiddenTab(base: string, id: string): boolean {
  return owners.get(base)?.has(id) ?? false;
}

/**
 * Relabel this process's hidden tabs in a target listing: type "other" becomes "page" with
 * `hidden: true`, so every selector arm (index, url, title, label, the default) and list_pages
 * see them as the pages they are. They move to the END of the listing, so the visible tabs keep
 * their indexes and a call with no target still lands on the same visible tab as before.
 *
 * Returns the SAME array when this process holds no hidden tab on `base`, so with the feature off
 * the listing is untouched. Only ids this process created are relabeled: another process's hidden
 * tabs, and Vivaldi's own "other" targets, are left alone.
 */
export function markHiddenTargets(base: string, targets: Target[]): Target[] {
  const owner = owners.get(base);
  if (!owner) return targets;
  const hidden = new Set(owner.ids());
  if (hidden.size === 0) return targets;
  const visible: Target[] = [];
  const marked: Target[] = [];
  for (const t of targets) {
    if (hidden.has(t.id)) marked.push({ ...t, type: "page", hidden: true });
    else visible.push(t);
  }
  return marked.length ? [...visible, ...marked] : targets;
}

/** Close every hidden tab on every endpoint and the owner connections. The MCP server's shutdown
 *  path (via the CDP driver's dispose). */
export async function disposeHiddenTabs(): Promise<void> {
  const all = [...owners.values()];
  owners.clear();
  await Promise.all(all.map((o) => o.dispose()));
}
