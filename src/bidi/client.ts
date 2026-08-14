/**
 * WebDriver BiDi transport for the Firefox backend, the counterpart to
 * src/client.ts's raw CDP transport. Zero runtime dependencies, uses
 * Node's global WebSocket (Node >= 22; verified on Node 25.9). See
 * CONTRACT.md and driver.ts's ADR-001 for the session lifetime this
 * transport exists to support.
 */
import type { BidiCommands, BidiErrorCode, BidiEventName, BidiEvents, BidiMethod } from "./protocol.ts";

/** Default per-command timeout (ms). Override with BIDI_TIMEOUT_MS. */
export const DEFAULT_TIMEOUT_MS = Number(process.env.BIDI_TIMEOUT_MS ?? 15_000);

export class BidiError extends Error {
  constructor(
    message: string,
    readonly code?: BidiErrorCode,
    readonly data?: unknown,
  ) {
    super(message);
    this.name = "BidiError";
  }
}

type BidiEventHandler = (params: never) => void;

interface RawSuccess { type: "success"; id: number; result: unknown }
interface RawErrorMsg { type: "error"; id: number | null; error: BidiErrorCode; message: string }
interface RawEvent { type: "event"; method: string; params: unknown }
type RawMessage = RawSuccess | RawErrorMsg | RawEvent;

interface PendingCall {
  method: string;
  start: number;
  timer: ReturnType<typeof setTimeout>;
  resolve: (raw: RawSuccess | RawErrorMsg) => void;
  reject: (e: Error) => void;
}

/**
 * A single WebDriver BiDi WebSocket connection.
 *
 * THE STRUCTURAL DIFFERENCE FROM CDP: a BiDi session is bound to exactly one
 * socket. Dropping this connection and re-dialing does not resume the
 * session, a fresh socket sending any command with the old sessionId gets
 * "invalid session id" (verified against Firefox 153.0.3). So this class,
 * once its session is established, IS the session: there is no reconnect
 * path, only retain()/release() bookkeeping around one long-lived socket
 * that closes exclusively via dispose(). ADR-001 (driver.ts) calls this the
 * "session" LifetimeModel and depends on exactly this property: tool calls
 * retain()/release() a shared connection instead of opening and closing
 * their own.
 *
 * Event subscription bookkeeping lives entirely inside on()/waitFor(): BiDi
 * has no per-domain "enable" the way CDP has Network.enable, only explicit
 * session.subscribe / session.unsubscribe by event name. CALLERS NEVER
 * SUBSCRIBE BY HAND. Each event name is refcounted here: the first listener
 * added triggers session.subscribe, the last one removed triggers
 * session.unsubscribe.
 */
export class BidiConnection {
  private ws?: WebSocket;
  private nextId = 0;
  private sessId?: string;
  private caps?: unknown;
  private closed = false;
  private refCount = 0;

  private readonly pending = new Map<number, PendingCall>();
  private readonly listeners = new Map<string, Set<BidiEventHandler>>();

  constructor(
    readonly wsUrl: string,
    private readonly opts: { timeoutMs?: number } = {},
  ) {}

  /** The session id from session.new. Undefined until newSession() resolves. */
  get sessionId(): string | undefined {
    return this.sessId;
  }

  /** The capabilities object returned by session.new. */
  get capabilities(): unknown {
    return this.caps;
  }

  /** Current holder count, see retain()/release(). */
  get holders(): number {
    return this.refCount;
  }

  /**
   * True while this connection still has a live socket. Goes false once the
   * socket closes (ws.onclose) or dispose() runs — both set `closed` and
   * reject all in-flight calls. getConnection uses this to skip and evict a
   * dead cached connection so the next call re-dials a fresh session instead
   * of reusing a socket that can only reject with "connection not open".
   */
  get isOpen(): boolean {
    return !this.closed && this.ws !== undefined;
  }

  connect(): Promise<this> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(this.wsUrl);
      this.ws = ws;
      const openTimer = setTimeout(
        () => reject(new BidiError(`connect timeout: ${this.wsUrl}`)),
        this.opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      );
      ws.onopen = () => {
        clearTimeout(openTimer);
        resolve(this);
      };
      ws.onerror = (e: Event) => {
        clearTimeout(openTimer);
        const msg = (e as ErrorEvent)?.message ?? "websocket error";
        if (this.pending.size === 0) reject(new BidiError(msg));
        this.rejectAll(new BidiError(msg));
      };
      ws.onclose = () => {
        this.closed = true;
        this.rejectAll(new BidiError("connection closed"));
      };
      ws.onmessage = (ev: MessageEvent) => this.onMessage(String(ev.data));
    });
  }

  /**
   * Create the BiDi session on this socket (session.new). Call once,
   * immediately after connect(); everything else on this connection assumes
   * a session already exists. Stores the returned sessionId/capabilities.
   */
  async newSession(
    capabilities: BidiCommands["session.new"]["params"]["capabilities"] = {},
  ): Promise<string> {
    const result = await this.send("session.new", { capabilities });
    this.sessId = result.sessionId;
    this.caps = result.capabilities;
    return result.sessionId;
  }

  private onMessage(raw: string): void {
    let msg: RawMessage;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    if (msg.type === "success" || msg.type === "error") {
      const id = msg.id;
      if (typeof id !== "number" || !this.pending.has(id)) return;
      const p = this.pending.get(id)!;
      clearTimeout(p.timer);
      this.pending.delete(id);
      p.resolve(msg);
      return;
    }
    if (msg.type === "event") {
      const set = this.listeners.get(msg.method);
      if (set) for (const h of set) h(msg.params as never);
    }
  }

  /** Every in-flight promise rejects, never hangs, when the socket dies. */
  private rejectAll(err: Error): void {
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(err);
    }
    this.pending.clear();
  }

  /**
   * Send a BiDi command and await its result. Generic over `method` alone:
   * params and result both come from BidiCommands[M], so a caller gets full
   * inference from just the method-name string literal. Rejects on a BiDi
   * error response (typed BidiError carrying the wire code) or on timeout.
   */
  send<M extends BidiMethod>(
    method: M,
    params: BidiCommands[M]["params"],
    opts: { timeoutMs?: number } = {},
  ): Promise<BidiCommands[M]["result"]> {
    if (this.closed || !this.ws) return Promise.reject(new BidiError("connection not open"));
    const id = ++this.nextId;
    const timeoutMs = opts.timeoutMs ?? this.opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const payload = { id, method, params };
    return new Promise((resolve, reject) => {
      const start = Date.now();
      const timer = setTimeout(() => {
        this.pending.delete(id);
        const elapsed = Date.now() - start;
        reject(new BidiError(`'${method}' timed out after ${elapsed}ms`));
      }, timeoutMs);
      this.pending.set(id, {
        method,
        start,
        timer,
        resolve: (raw) => {
          if (raw.type === "error") reject(new BidiError(`${method}: ${raw.message}`, raw.error));
          else resolve(raw.result as BidiCommands[M]["result"]);
        },
        reject,
      });
      this.ws!.send(JSON.stringify(payload));
    });
  }

  /**
   * Subscribe to a BiDi event. Handles session.subscribe / session.unsubscribe
   * bookkeeping internally: refcounted per event name, subscribes on the
   * first listener, unsubscribes when the last one is removed. Returns an
   * unsubscribe function; callers never call session.subscribe themselves.
   */
  on<E extends BidiEventName>(event: E, handler: (params: BidiEvents[E]) => void): () => void {
    let set = this.listeners.get(event);
    if (!set) {
      set = new Set();
      this.listeners.set(event, set);
    }
    const first = set.size === 0;
    set.add(handler as BidiEventHandler);
    if (first) {
      this.send("session.subscribe", { events: [event] }).catch(() => {
        /* best effort: a failed subscribe surfaces as missing events, not a thrown error here */
      });
    }

    let removed = false;
    return () => {
      if (removed) return;
      removed = true;
      const s = this.listeners.get(event);
      s?.delete(handler as BidiEventHandler);
      if (s && s.size === 0) {
        this.send("session.unsubscribe", { events: [event] }).catch(() => {
          /* best effort on teardown */
        });
      }
    };
  }

  /**
   * Resolve when an event matching `event` (and optional predicate) fires,
   * or reject on timeout. Subscribes via on(), so the refcounting above
   * applies here too, an unmatched waitFor still unsubscribes cleanly.
   */
  waitFor<E extends BidiEventName>(
    event: E,
    predicate?: (params: BidiEvents[E]) => boolean,
    timeoutMs = this.opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  ): Promise<BidiEvents[E]> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        off();
        reject(new BidiError(`waitFor('${event}') timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      const off = this.on(event, (params) => {
        if (!predicate || predicate(params)) {
          clearTimeout(timer);
          off();
          resolve(params);
        }
      });
    });
  }

  /**
   * Add a holder. Under the "session" LifetimeModel (driver.ts) the socket
   * outlives individual tool calls, so acquiring a page handle retains this
   * connection instead of opening a new one.
   */
  retain(): void {
    this.refCount++;
  }

  /** Remove a holder. Does NOT close the socket, only dispose() does that. */
  release(): void {
    if (this.refCount > 0) this.refCount--;
  }

  /**
   * Close the socket. Idempotent. Every in-flight send()/waitFor() and any
   * future call rejects with a clear "disposed" BidiError rather than
   * hanging, which is the whole point of this transport.
   */
  dispose(): void {
    if (this.closed) return;
    this.closed = true;
    this.rejectAll(new BidiError("connection disposed"));
    try {
      this.ws?.close();
    } catch {
      /* ignore */
    }
  }
}

/**
 * Open a BiDi connection to an explicit WebSocket endpoint and create its
 * session in one step. THE URL IS THE IDENTITY: a Firefox this toolkit
 * launched is ws://127.0.0.1:<port>/session, but attach mode (backend.ts's
 * normalizeBidiEndpoint) may hand over any host/port/path the user's own
 * Firefox is listening on, so nothing here reconstructs a URL from a port.
 * This module never launches Firefox; the endpoint must already be listening.
 * The returned connection is retained once (holders === 1): the caller owns
 * that first retain and must release() or dispose() it.
 *
 * NOTE for attach callers: Firefox permits exactly ONE active BiDi session, and
 * closing a socket does NOT free that slot (verified on 153.0.3) — only
 * session.end does. A second session.new against a Firefox that still holds an
 * abandoned session fails with "Maximum number of active sessions"; driver.ts
 * turns that into an actionable "disconnected" DriverError.
 */
export async function connectBidiSessionUrl(
  wsUrl: string,
  opts: {
    timeoutMs?: number;
    capabilities?: BidiCommands["session.new"]["params"]["capabilities"];
  } = {},
): Promise<BidiConnection> {
  const conn = new BidiConnection(wsUrl, { timeoutMs: opts.timeoutMs });
  await conn.connect();
  try {
    await conn.newSession(opts.capabilities ?? {});
  } catch (e) {
    // A REJECTED session.new still leaves an OPEN socket, and an open WebSocket is a live handle
    // that keeps the event loop alive: without this the CLI printed "Maximum number of active
    // sessions" and then hung forever instead of exiting (measured against Firefox 153.0.3 while
    // a second client held the one session slot). Close it before rethrowing so a failed connect
    // costs an error and nothing else.
    conn.dispose();
    throw e;
  }
  conn.retain();
  return conn;
}

/**
 * Port-shaped convenience wrapper over connectBidiSessionUrl, for the launched
 * Firefox whose endpoint is always the loopback shape ws://127.0.0.1:<port>/session.
 * Pass a port from launch.ts's launchFirefox() or any other running Firefox with
 * the debug port open on loopback. Kept exported for back-compat with callers
 * that only ever hold a port.
 */
export async function connectBidiSession(
  port: number,
  opts: {
    timeoutMs?: number;
    capabilities?: BidiCommands["session.new"]["params"]["capabilities"];
  } = {},
): Promise<BidiConnection> {
  return connectBidiSessionUrl(`ws://127.0.0.1:${port}/session`, opts);
}

/*
 * BiDi modules/commands used: session (session.new, session.subscribe,
 * session.unsubscribe). All other modules (browsingContext, script, input,
 * network, storage, log, emulation) are exercised generically through the
 * typed send()/on()/waitFor() surface above but this file itself calls none
 * of their commands directly, that is left to the driver and tool layers
 * built on top. Parity gap vs client.ts: there is no browserWsUrl/listTargets
 * equivalent here and no HTTP discovery step at all — the ws URL IS the
 * endpoint identity. For a Firefox this toolkit launched that URL is derived
 * from a port (the fixed loopback shape ws://127.0.0.1:<port>/session); for an
 * attached one it is whatever the user configured, so it may carry a different
 * host, port, or path and must be passed through verbatim.
 */
