/**
 * Report page targets opened BY another page (window.open, a target=_blank link, a web app that
 * hops to a copy of itself), with the opener's id, so ../ownedTabs.ts can pass the opener's
 * ownership and agent origin on to them.
 *
 * WHY AN EVENT ON A HELD SOCKET AND NOT A LOOK AT THE LISTING. Measured on Chrome 158:
 * Target.targetCreated carries `openerId` the moment the popup exists, but Target.getTargets
 * reports `openerId` only while the opener is still open, and GET /json/list never reports it.
 * The case this exists for is exactly the one where the opener goes away (an app moves itself to
 * a new tab and closes the old one), so a lazy look at the listing would miss it every time.
 *
 * One watcher per endpoint (a named endpoint is a different browser), opened lazily the first
 * time this process is about to create a tab, and only in the MCP server (the caller checks).
 * Best effort: a failed connect is swallowed and retried on the next start, and a dead socket is
 * replaced on the next start. A popup opened while no socket was up is simply not inherited,
 * which is what happened before this file existed.
 */
import type { OwnerConnection } from "./hiddenTabs.ts";

export type PopupHandler = (childId: string, openerId: string) => void;

export interface PopupWatcherDeps {
  /** Opens a fresh browser-endpoint connection (openBrowser in production). */
  connect(): Promise<Pick<OwnerConnection, "send" | "on" | "close" | "isOpen">>;
}

export class PopupWatcher {
  private conn: Pick<OwnerConnection, "send" | "on" | "close" | "isOpen"> | undefined;
  private connecting: Promise<void> | undefined;
  private handler: PopupHandler | undefined;

  constructor(private readonly deps: PopupWatcherDeps) {}

  /** Make sure the watch is up. Idempotent and single-flight; never throws. The first handler wins. */
  async start(onPopup: PopupHandler): Promise<void> {
    this.handler ??= onPopup;
    if (this.conn && !this.conn.isOpen) this.conn = undefined;
    if (this.conn) return;
    if (!this.connecting) {
      this.connecting = (async () => {
        const conn = await this.deps.connect();
        conn.on("Target.targetCreated", (params) => {
          const info = (params as { targetInfo?: { targetId?: unknown; type?: unknown; openerId?: unknown } }).targetInfo;
          if (info?.type !== "page" || typeof info.targetId !== "string" || typeof info.openerId !== "string" || !info.openerId) return;
          this.handler?.(info.targetId, info.openerId);
        });
        await conn.send("Target.setDiscoverTargets", { discover: true });
        this.conn = conn;
      })()
        .catch(() => undefined)
        .finally(() => {
          this.connecting = undefined;
        });
    }
    await this.connecting;
  }

  dispose(): void {
    this.conn?.close();
    this.conn = undefined;
    this.handler = undefined;
  }
}

const watchers = new Map<string, PopupWatcher>();

/** The watcher for endpoint `base`, created on first use. */
export function popupWatcher(base: string, deps: () => PopupWatcherDeps): PopupWatcher {
  let w = watchers.get(base);
  if (!w) {
    w = new PopupWatcher(deps());
    watchers.set(base, w);
  }
  return w;
}

/** Close every watcher socket. The MCP server's shutdown path (via the CDP driver's dispose). */
export function disposePopupWatchers(): void {
  for (const w of watchers.values()) w.dispose();
  watchers.clear();
}
