/**
 * Core raw-CDP client. Zero runtime dependencies — uses Node's global
 * WebSocket (Node >= 22; verified on Node 25.9). Every tool module is built on
 * the primitives exported here. See CONTRACT.md.
 */
import type { CdpResponse, Target, TargetSelector } from "./types.ts";

/** Base HTTP origin of the DevTools endpoint. Override with CDP_BASE. */
export const BASE = process.env.CDP_BASE ?? "http://127.0.0.1:9222";

/** Default per-command timeout (ms). Override with CDP_TIMEOUT_MS. */
export const DEFAULT_TIMEOUT_MS = Number(process.env.CDP_TIMEOUT_MS ?? 15_000);

export class CdpError extends Error {
  constructor(
    message: string,
    readonly code?: number,
    readonly data?: unknown,
  ) {
    super(message);
    this.name = "CdpError";
  }
}

type EventHandler = (params: Record<string, unknown>, sessionId?: string) => void;

/**
 * A single CDP WebSocket connection (to either the browser endpoint or a page
 * target endpoint). Correlates id->response, fans out events to subscribers,
 * and enforces a per-command timeout so a wedged renderer can never hang a
 * caller indefinitely (the exact failure mode that breaks the MCP layer).
 */
export class CdpConnection {
  private ws?: WebSocket;
  private nextId = 0;
  private readonly pending = new Map<
    number,
    { resolve: (r: CdpResponse) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }
  >();
  private readonly listeners = new Map<string, Set<EventHandler>>();
  private closed = false;

  constructor(
    readonly wsUrl: string,
    private readonly opts: { timeoutMs?: number } = {},
  ) {}

  connect(): Promise<this> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(this.wsUrl);
      this.ws = ws;
      const openTimer = setTimeout(() => reject(new CdpError(`connect timeout: ${this.wsUrl}`)), this.opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);
      ws.onopen = () => {
        clearTimeout(openTimer);
        resolve(this);
      };
      ws.onerror = (e: Event) => {
        clearTimeout(openTimer);
        const msg = (e as ErrorEvent)?.message ?? "websocket error";
        if (this.pending.size === 0) reject(new CdpError(msg));
        this.rejectAll(new CdpError(msg));
      };
      ws.onclose = () => {
        this.closed = true;
        this.rejectAll(new CdpError("connection closed"));
      };
      ws.onmessage = (ev: MessageEvent) => this.onMessage(String(ev.data));
    });
  }

  private onMessage(raw: string): void {
    let msg: CdpResponse & { method?: string; params?: Record<string, unknown>; sessionId?: string };
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    if (typeof msg.id === "number" && this.pending.has(msg.id)) {
      const p = this.pending.get(msg.id)!;
      clearTimeout(p.timer);
      this.pending.delete(msg.id);
      p.resolve(msg);
      return;
    }
    if (msg.method) {
      const set = this.listeners.get(msg.method);
      if (set) for (const h of set) h(msg.params ?? {}, msg.sessionId);
      const star = this.listeners.get("*");
      if (star) for (const h of star) h({ method: msg.method, ...(msg.params ?? {}) }, msg.sessionId);
    }
  }

  private rejectAll(err: Error): void {
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(err);
    }
    this.pending.clear();
  }

  /** Send a CDP command and await its result. Rejects on CDP error or timeout. */
  send<T = Record<string, unknown>>(
    method: string,
    params: Record<string, unknown> = {},
    opts: { timeoutMs?: number; sessionId?: string } = {},
  ): Promise<T> {
    if (this.closed || !this.ws) return Promise.reject(new CdpError("connection not open"));
    const id = ++this.nextId;
    const timeoutMs = opts.timeoutMs ?? this.opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const payload: Record<string, unknown> = { id, method, params };
    if (opts.sessionId) payload.sessionId = opts.sessionId;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new CdpError(`'${method}' timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (r) => {
          if (r.error) reject(new CdpError(`${method}: ${r.error.message}`, r.error.code, r.error.data));
          else resolve((r.result ?? {}) as T);
        },
        reject,
        timer,
      });
      this.ws!.send(JSON.stringify(payload));
    });
  }

  /** Subscribe to a CDP event method (or "*" for all). Returns an unsubscribe fn. */
  on(method: string, handler: EventHandler): () => void {
    let set = this.listeners.get(method);
    if (!set) {
      set = new Set();
      this.listeners.set(method, set);
    }
    set.add(handler);
    return () => set!.delete(handler);
  }

  /**
   * Resolve when an event matching `method` (and optional predicate) fires, or
   * reject on timeout. Useful for navigation/dialog/load synchronization.
   */
  waitFor<P = Record<string, unknown>>(
    method: string,
    predicate?: (params: P) => boolean,
    timeoutMs = this.opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  ): Promise<P> {
    return new Promise<P>((resolve, reject) => {
      const timer = setTimeout(() => {
        off();
        reject(new CdpError(`waitFor('${method}') timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      const off = this.on(method, (params) => {
        if (!predicate || predicate(params as P)) {
          clearTimeout(timer);
          off();
          resolve(params as P);
        }
      });
    });
  }

  close(): void {
    this.closed = true;
    this.rejectAll(new CdpError("closed by caller"));
    try {
      this.ws?.close();
    } catch {
      /* ignore */
    }
  }
}

/* ----------------------------- endpoint discovery ----------------------------- */

async function httpJson<T>(path: string): Promise<T> {
  const res = await fetch(`${BASE}${path}`);
  if (!res.ok) throw new CdpError(`${path} -> HTTP ${res.status}`);
  return (await res.json()) as T;
}

/** All targets (GET /json/list). */
export function listTargets(): Promise<Target[]> {
  return httpJson<Target[]>("/json/list");
}

/** Browser-level WebSocket URL (GET /json/version) — for Target.* / Browser.*. */
export async function browserWsUrl(): Promise<string> {
  const v = await httpJson<{ webSocketDebuggerUrl: string }>("/json/version");
  return v.webSocketDebuggerUrl;
}

/** Resolve a TargetSelector to a concrete page target. See types.ts for grammar. */
export async function resolveTarget(selector: TargetSelector): Promise<Target> {
  const targets = await listTargets();
  const pages = targets.filter((t) => t.type === "page");
  if (!selector || selector === "active") {
    if (!pages.length) throw new CdpError("no page targets open");
    return pages[0]!;
  }
  if (selector.startsWith("index:")) {
    const i = Number(selector.slice(6));
    if (!pages[i]) throw new CdpError(`no page target at index ${i} (have ${pages.length})`);
    return pages[i]!;
  }
  if (selector.startsWith("url:")) {
    const needle = selector.slice(4);
    const hit = pages.find((t) => t.url.includes(needle));
    if (!hit) throw new CdpError(`no page url containing '${needle}'`);
    return hit;
  }
  if (selector.startsWith("title:")) {
    const needle = selector.slice(6);
    const hit = pages.find((t) => t.title.includes(needle));
    if (!hit) throw new CdpError(`no page title containing '${needle}'`);
    return hit;
  }
  // bare id
  const byId = targets.find((t) => t.id === selector);
  if (!byId) throw new CdpError(`no target with id '${selector}'`);
  return byId;
}

/** Open a connection to the browser endpoint (Target.* / Browser.* domains). */
export async function openBrowser(opts: { timeoutMs?: number } = {}): Promise<CdpConnection> {
  return new CdpConnection(await browserWsUrl(), opts).connect();
}

/** Open a connection to a page target. Returns the connection and the target. */
export async function openPage(
  selector: TargetSelector,
  opts: { timeoutMs?: number } = {},
): Promise<{ conn: CdpConnection; target: Target }> {
  const target = await resolveTarget(selector);
  const conn = await new CdpConnection(target.webSocketDebuggerUrl, opts).connect();
  return { conn, target };
}

/**
 * Convenience: open a page, run `fn`, and always close the connection.
 * The standard wrapper for stateless one-shot tools.
 */
export async function withPage<T>(
  selector: TargetSelector,
  fn: (conn: CdpConnection, target: Target) => Promise<T>,
  opts: { timeoutMs?: number } = {},
): Promise<T> {
  const { conn, target } = await openPage(selector, opts);
  try {
    return await fn(conn, target);
  } finally {
    conn.close();
  }
}
