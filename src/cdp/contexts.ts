/**
 * The CDP half of execution-context selection (issue #12; grammar and pick rules: ../contexts.ts).
 *
 * WHY A TRACKER AND NOT "enable, then read the replay". Runtime.enable replays every context that
 * exists at that moment as Runtime.executionContextCreated events before it replies, but a frame
 * that is still being created (an Electron webview's inner frame, a lazily inserted iframe) shows
 * up some hundreds of ms LATER. A one-shot read misses it and the element looks absent even when
 * it is there. So the listener goes on BEFORE Runtime.enable is sent (a listener attached after
 * would miss the replay), destroyed/cleared events are applied too, and callers then wait with
 * settle(): until nothing has appeared or gone for `quietMs`, capped at `capMs`, or until a
 * caller-supplied condition holds (context 'auto' waits for its selector to match).
 *
 * Ids are stable across connections for a context's lifetime (measured on Chromium 158: two
 * separate sessions on one target reported the same ids and uniqueIds), so an id from
 * list_contexts is valid in a later call until its frame navigates.
 */
import type { PageConnection } from "./session.ts";
import type { ExecutionContextInfo, SettleOptions } from "../contexts.ts";

interface RawContext {
  id: number;
  origin?: string;
  name?: string;
  uniqueId?: string;
  auxData?: { isDefault?: boolean; type?: string; frameId?: string };
}

interface FrameTreeNode {
  frame?: { id?: string; url?: string; name?: string };
  childFrames?: FrameTreeNode[];
}

const POLL_MS = 25;

export class ContextTracker {
  private readonly live = new Map<number, RawContext>();
  private lastChange = 0;
  private readonly offs: Array<() => void> = [];
  private started = false;

  constructor(private readonly conn: PageConnection) {}

  /**
   * Subscribe, then (re-)enable Runtime. `runtimeAlreadyEnabled` means this connection sent
   * Runtime.enable before tracking began, so its replay is gone: disable and enable again to get
   * a fresh one (cheap, and scoped to this connection only).
   */
  async start(runtimeAlreadyEnabled: boolean): Promise<void> {
    if (this.started) return;
    this.started = true;
    this.offs.push(
      this.conn.on("Runtime.executionContextCreated", (p) => {
        const ctx = (p as { context?: RawContext }).context;
        if (ctx && typeof ctx.id === "number") {
          this.live.set(ctx.id, ctx);
          this.lastChange = Date.now();
        }
      }),
      this.conn.on("Runtime.executionContextDestroyed", (p) => {
        const id = (p as { executionContextId?: number }).executionContextId;
        if (typeof id === "number" && this.live.delete(id)) this.lastChange = Date.now();
      }),
      this.conn.on("Runtime.executionContextsCleared", () => {
        this.live.clear();
        this.lastChange = Date.now();
      }),
    );
    if (runtimeAlreadyEnabled) await this.conn.send("Runtime.disable").catch(() => undefined);
    this.lastChange = Date.now();
    await this.conn.send("Runtime.enable");
  }

  /**
   * Wait for the context set to settle. Returns when `until` holds, else when nothing changed for
   * quietMs (unless `ignoreQuiet`), else at capMs. Never throws on its own.
   */
  async settle(opts: Required<SettleOptions>, until?: () => Promise<boolean>, ignoreQuiet = false): Promise<void> {
    const start = Date.now();
    for (;;) {
      if (until && (await until())) return;
      const now = Date.now();
      if (!ignoreQuiet && now - this.lastChange >= opts.quietMs) return;
      if (now - start >= opts.capMs) return;
      await new Promise((r) => setTimeout(r, Math.max(1, Math.min(POLL_MS, opts.capMs - (now - start)))));
    }
  }

  /** The live contexts, oldest first, enriched with frame url/name from Page.getFrameTree. */
  async contexts(): Promise<ExecutionContextInfo[]> {
    const frames = new Map<string, { url?: string; name?: string }>();
    let mainFrameId: string | undefined;
    const tree = await this.conn.send<{ frameTree?: FrameTreeNode }>("Page.getFrameTree").catch(() => undefined);
    const walk = (n: FrameTreeNode | undefined): void => {
      if (!n?.frame?.id) return;
      frames.set(n.frame.id, { url: n.frame.url, name: n.frame.name });
      for (const c of n.childFrames ?? []) walk(c);
    };
    walk(tree?.frameTree);
    mainFrameId = tree?.frameTree?.frame?.id;
    return [...this.live.values()]
      .sort((a, b) => a.id - b.id)
      .map((c) => {
        const frameId = c.auxData?.frameId;
        const f = frameId ? frames.get(frameId) : undefined;
        return {
          id: c.id,
          ...(c.uniqueId ? { uniqueId: c.uniqueId } : {}),
          ...(frameId ? { frameId } : {}),
          origin: c.origin ?? "",
          name: c.name ?? "",
          isDefault: c.auxData?.isDefault === true,
          type: c.auxData?.type ?? (c.auxData?.isDefault ? "default" : ""),
          ...(frameId && mainFrameId ? { isMainFrame: frameId === mainFrameId } : {}),
          ...(f?.url ? { frameUrl: f.url } : {}),
          ...(f?.name ? { frameName: f.name } : {}),
        };
      });
  }

  dispose(): void {
    for (const off of this.offs.splice(0)) off();
  }
}
