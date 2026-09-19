/**
 * A page connection carried by a flat `Target.attachToTarget` session on the
 * browser socket, for the endpoints that serve no per-target socket (see
 * ./endpoint.ts for why those exist).
 *
 * WHAT THIS IS. `SessionConnection` presents the same surface as
 * `CdpConnection` — `send`, `on`, `waitFor`, `close`, with the same
 * per-command timeout — but instead of owning a socket it owns a sessionId and
 * borrows the shared browser socket. Every tool module in the toolkit is typed
 * against that surface, so none of them has to know which one it holds. The
 * one-target-per-call guarantee is unchanged: a call attaches to the ONE
 * target it named and detaches when it is done.
 *
 * WHY FLAT SESSIONS. With `flatten: true` every message for an attached target
 * carries its `sessionId` on the same socket, so routing is a map lookup and
 * two sessions never see each other's events. The nested alternative wraps
 * each message in `Target.receivedMessageFromTarget`, which would mean
 * re-implementing correlation a second time.
 *
 * WHY THE SOCKET IS SHARED AND REFERENCE-COUNTED. Chrome mints a NEW session
 * per attach, and sessions on one socket are independent — measured: attaching
 * twice to one target yields two distinct ids, and detaching one leaves the
 * other working. So concurrent calls can and should share a single browser
 * socket. What they must not do is close it while another call is still using
 * it, hence the refcount: the socket opens on the first borrower and closes
 * after the last one releases.
 *
 * THE WEDGED-TAB PROPERTY IS PRESERVED, and it is the reason the toolkit is
 * worth pointing at a browser with a wedged tab in it. A command to a hung
 * renderer times out in `CdpConnection.send` exactly as before — the timer is
 * per command id, not per socket — and because this transport never attaches
 * to a target it was not asked for, a wedged tab is only ever reached by a
 * call that named it.
 */
import { CdpConnection, CdpError, DEFAULT_TIMEOUT_MS } from "../client.ts";
import { detectEndpoint } from "./endpoint.ts";

type EventHandler = (params: Record<string, unknown>, sessionId?: string) => void;

/* ----------------------------- shared browser socket ----------------------------- */

let shared: { conn: CdpConnection; refs: number; url: string } | undefined;
let opening: Promise<CdpConnection> | undefined;

/**
 * Borrow the shared browser socket, opening it if nobody holds one.
 *
 * `opening` deduplicates a concurrent first borrow: two calls that arrive
 * together must end up on ONE socket, not race to open two and leak the loser.
 */
async function acquireBrowserConn(): Promise<CdpConnection> {
  if (shared) {
    shared.refs++;
    return shared.conn;
  }
  if (!opening) {
    opening = (async () => {
      const { browserWsUrl } = await detectEndpoint();
      const conn = await new CdpConnection(browserWsUrl).connect();
      shared = { conn, refs: 0, url: browserWsUrl };
      return conn;
    })().finally(() => {
      opening = undefined;
    });
  }
  const conn = await opening;
  // `shared` is set by the block above before it resolves; a concurrent
  // release cannot have run in between, because releasing requires a ref and
  // this borrower has not taken one yet.
  shared!.refs++;
  return conn;
}

/** Return a borrow. The socket closes when the last holder lets go. */
function releaseBrowserConn(): void {
  if (!shared) return;
  shared.refs--;
  if (shared.refs <= 0) {
    const { conn } = shared;
    shared = undefined;
    conn.close();
  }
}

/**
 * Run `fn` on the shared browser socket. The browser-domain counterpart of
 * client.ts's `withPage`, and the only way this module opens a socket.
 */
export async function withBrowserSocket<T>(fn: (conn: CdpConnection) => Promise<T>): Promise<T> {
  const conn = await acquireBrowserConn();
  try {
    return await fn(conn);
  } finally {
    releaseBrowserConn();
  }
}

/* -------------------------------- page sessions -------------------------------- */

/**
 * One attached target, shaped like a `CdpConnection`.
 *
 * Structural, not a subclass: `CdpConnection` owns a socket in its constructor
 * and this owns a sessionId, so there is no state to inherit. Callers hold
 * them through the shared `PageConnection` type below.
 */
export class SessionConnection {
  private detached = false;
  private readonly offs: Array<() => void> = [];

  constructor(
    private readonly browser: CdpConnection,
    readonly sessionId: string,
    private readonly opts: { timeoutMs?: number } = {},
  ) {}

  /** Send over this session. Same timeout semantics as CdpConnection.send. */
  send<T = Record<string, unknown>>(
    method: string,
    params: Record<string, unknown> = {},
    opts: { timeoutMs?: number; sessionId?: string } = {},
  ): Promise<T> {
    if (this.detached) return Promise.reject(new CdpError("connection not open"));
    // An explicit sessionId wins, so a caller that attached a NESTED session of
    // its own (cdp/workers.ts does this for ServiceWorker) still addresses it.
    return this.browser.send<T>(method, params, {
      timeoutMs: opts.timeoutMs ?? this.opts.timeoutMs,
      sessionId: opts.sessionId ?? this.sessionId,
    });
  }

  /**
   * Subscribe, filtered to THIS session.
   *
   * The filter is what makes one socket behave like many: the browser socket
   * carries every attached target's events, and a handler registered here must
   * see only its own. An event with no sessionId is browser-level (a
   * `Target.*` notification) and is delivered too, matching what a per-target
   * socket shows.
   */
  on(method: string, handler: EventHandler): () => void {
    const off = this.browser.on(method, (params, sessionId) => {
      if (sessionId && sessionId !== this.sessionId) return;
      handler(params, sessionId);
    });
    this.offs.push(off);
    return off;
  }

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

  /**
   * Detach and return the socket borrow.
   *
   * Named `close` because that is the method every tool module already calls in
   * its `finally`. The detach is fire-and-forget: the borrow must be returned
   * even when the target died first, and a failed detach on a target that is
   * already gone is not a caller's problem.
   */
  close(): void {
    if (this.detached) return;
    this.detached = true;
    for (const off of this.offs) off();
    this.offs.length = 0;
    void this.browser.send("Target.detachFromTarget", { sessionId: this.sessionId }).catch(() => {
      /* target already gone */
    });
    releaseBrowserConn();
  }
}

/**
 * What every tool module actually holds: a `CdpConnection` when the endpoint
 * serves per-target sockets, a `SessionConnection` when it does not.
 *
 * AN INTERFACE, NOT A UNION, on purpose. A union of the two classes would make
 * every tool module narrow before it could send, for a distinction none of them
 * cares about. This is the surface they were already using — four methods —
 * so both implementations satisfy it structurally and `withPage` hands over
 * whichever one the transport produced.
 */
export interface PageConnection {
  send<T = Record<string, unknown>>(
    method: string,
    params?: Record<string, unknown>,
    opts?: { timeoutMs?: number; sessionId?: string },
  ): Promise<T>;
  on(method: string, handler: EventHandler): () => void;
  waitFor<P = Record<string, unknown>>(
    method: string,
    predicate?: (params: P) => boolean,
    timeoutMs?: number,
  ): Promise<P>;
  close(): void;
}

/** Attach to one target and wrap the session. The caller closes it. */
export async function openSession(
  targetId: string,
  opts: { timeoutMs?: number } = {},
): Promise<SessionConnection> {
  const browser = await acquireBrowserConn();
  try {
    const { sessionId } = await browser.send<{ sessionId?: string }>(
      "Target.attachToTarget",
      { targetId, flatten: true },
      { timeoutMs: opts.timeoutMs },
    );
    if (!sessionId) throw new CdpError(`Target.attachToTarget returned no sessionId for ${targetId}`);
    return new SessionConnection(browser, sessionId, opts);
  } catch (e) {
    releaseBrowserConn();
    throw e;
  }
}
