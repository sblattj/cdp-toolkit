/**
 * The holder-hosted BiDi session multiplexer (design brief
 * docs/design/2026-09-04-firefox-multi-agent-session-mux.md §2.1).
 *
 * WHY THIS EXISTS: Firefox serves exactly ONE WebDriver BiDi session, bound to
 * exactly one socket — a second socket is refused at the HTTP upgrade, and a
 * second session.new is refused with "Maximum number of active sessions". So a
 * second cdp-toolkit PROCESS pointed at the same Firefox cannot drive it at
 * all. The fix is that the process which wins the session slot (the "holder")
 * also hosts a loopback WebSocket server that itself speaks BiDi, and every
 * other process dials THAT with the same connectBidiSessionUrl it would use
 * against Firefox. From a joiner's point of view a joined connection is
 * indistinguishable from a real one: it does session.new, gets capabilities
 * back, sends commands, receives events.
 *
 * WHY HAND-ROLLED RFC 6455: CONTRACT.md rule 1 — zero runtime dependencies.
 * Node's global WebSocket is a CLIENT only; there is no server in the standard
 * library, so the server half is `node:http` + the 'upgrade' event + about a
 * hundred lines of framing here. It only ever binds loopback, and it only ever
 * speaks text frames, which keeps the surface small enough to hand-verify.
 *
 * WHAT IS LOCAL AND WHAT IS FORWARDED: session.new/end/subscribe/unsubscribe/
 * status are answered HERE (forwarding session.new would have Firefox refuse
 * it, and forwarding session.end would kill everyone's session). Every other
 * command is forwarded on the single upstream connection with the client's id
 * mapped back onto the reply, so ids from different joiners never collide.
 */
import { createServer, type Server, type Socket } from "node:net";
import { createHash } from "node:crypto";
import { BidiError, type BidiConnection } from "./client.ts";
import type { BidiEventName } from "./protocol.ts";

/** RFC 6455 §1.3: the fixed GUID concatenated with Sec-WebSocket-Key. */
const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
/** A single BiDi message larger than this is a bug or an attack, not a payload. */
const MAX_MESSAGE_BYTES = 64 * 1024 * 1024;
/** Deliberately far longer than a joiner's own 15 s send timer: the joiner's
 *  timeout must win the race, the mux must never be the thing that gives up. */
const FORWARD_TIMEOUT_MS = 120_000;

export interface BidiMux {
  /** ws://127.0.0.1:<ephemeral>/session — what joiners dial. */
  endpoint: string;
  /** Live joined client sockets. */
  clients(): number;
  /** Close every client socket (code 1001 "holder closing") and stop listening. Idempotent. */
  close(): Promise<void>;
}

/* ------------------------------------------------------------------ */
/* Minimal RFC 6455 server                                             */
/* ------------------------------------------------------------------ */

/** One accepted client socket, framing hidden behind send/close callbacks. */
export interface WsClient {
  /** Send one unmasked text frame. No-op once the socket is gone. */
  send(text: string): void;
  /** Start the close handshake with `code`, then drop the socket. Idempotent. */
  close(code: number, reason?: string): void;
  /** Set by the owner before any data can arrive (assigned in onConnection). */
  onMessage?: (message: string) => void;
  onClose?: () => void;
}

export interface WsServer {
  port: number;
  clients: Set<WsClient>;
  /** Destroy every client socket and stop listening. Resolves on 'close'. */
  close(): Promise<void>;
}

function acceptKey(key: string): string {
  return createHash("sha1").update(key + WS_GUID).digest("base64");
}

/** Build one unmasked server frame. Server frames are never masked (RFC 6455 §5.1). */
function encodeFrame(opcode: number, payload: Buffer): Buffer {
  const len = payload.length;
  let header: Buffer;
  if (len < 126) {
    header = Buffer.alloc(2);
    header[1] = len;
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  header[0] = 0x80 | opcode; // FIN + opcode
  return Buffer.concat([header, payload]);
}

function encodeClose(code: number, reason: string): Buffer {
  const r = Buffer.from(reason, "utf8");
  const body = Buffer.alloc(2 + r.length);
  body.writeUInt16BE(code, 0);
  r.copy(body, 2);
  return encodeFrame(0x8, body);
}


/**
 * Bind a loopback WebSocket server. `onConnection` receives each accepted
 * client BEFORE any message is dispatched, so assigning onMessage there can
 * never miss a frame (dispatch only happens on a later pass through the frame
 * loop, after the handshake response has been written).
 *
 * WHY node:net AND A HAND-PARSED HANDSHAKE, not node:http's 'upgrade' event:
 * under Bun 1.3.14 the Duplex handed to an 'upgrade' listener silently
 * swallows writes — the 101 response never reaches the wire and every client
 * hangs at connect (the same code works on Node 24). Measured 2026-09-04 with
 * a raw net client on both runtimes. The handshake is one request line plus
 * headers, so parsing it here costs ~25 lines and removes a whole runtime
 * dependency's worth of behavioral difference.
 */
export function createWsServer(opts: {
  host?: string;
  port?: number;
  path?: string;
  onConnection: (client: WsClient) => void;
}): Promise<WsServer> {
  const host = opts.host ?? "127.0.0.1";
  const path = opts.path ?? "/session";
  const clients = new Set<WsClient>();
  const sockets = new Set<Socket>();

  const server: Server = createServer((socket: Socket) => {
    sockets.add(socket);
    socket.setNoDelay(true);

    let buf: Buffer = Buffer.alloc(0);
    let upgraded = false;
    let fragments: Buffer[] = [];
    let fragmentOpcode = -1;
    let dead = false;
    let client: WsClient | undefined;

    const drop = (): void => {
      if (dead) return;
      dead = true;
      sockets.delete(socket);
      if (client) {
        clients.delete(client);
        try {
          client.onClose?.();
        } catch {
          /* a handler must never take down the socket layer */
        }
      }
    };

    const dispatch = (payload: Buffer): void => {
      try {
        client?.onMessage?.(payload.toString("utf8"));
      } catch {
        /* a message handler's failure must not kill the connection */
      }
    };

    /** Returns false when the socket has been closed and parsing must stop. */
    function handshake(): boolean {
      const end = buf.indexOf("\r\n\r\n");
      if (end === -1) {
        // A client that never finishes its request line is not a WebSocket.
        if (buf.length > 16 * 1024) {
          socket.end("HTTP/1.1 431 Request Header Fields Too Large\r\nConnection: close\r\n\r\n");
          drop();
          return false;
        }
        return false;
      }
      const header = buf.subarray(0, end).toString("latin1");
      buf = buf.subarray(end + 4);
      const lines = header.split("\r\n");
      const reqPath = (lines[0] ?? "").split(" ")[1]?.split("?")[0] ?? "";
      const headers = new Map<string, string>();
      for (const line of lines.slice(1)) {
        const i = line.indexOf(":");
        if (i > 0) headers.set(line.slice(0, i).trim().toLowerCase(), line.slice(i + 1).trim());
      }
      if (reqPath !== path) {
        socket.end("HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n");
        drop();
        return false;
      }
      const key = headers.get("sec-websocket-key");
      if (!key || (headers.get("upgrade") ?? "").toLowerCase() !== "websocket") {
        socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
        drop();
        return false;
      }
      socket.write(
        "HTTP/1.1 101 Switching Protocols\r\n" +
          "Upgrade: websocket\r\n" +
          "Connection: Upgrade\r\n" +
          `Sec-WebSocket-Accept: ${acceptKey(key)}\r\n\r\n`,
      );
      upgraded = true;
      const c: WsClient = {
        send(text: string): void {
          if (dead || socket.destroyed) return;
          try {
            socket.write(encodeFrame(0x1, Buffer.from(text, "utf8")));
          } catch {
            /* peer vanished mid-write; the 'close' event will clean up */
          }
        },
        close(code: number, reason = ""): void {
          if (dead || socket.destroyed) {
            drop();
            return;
          }
          try {
            socket.write(encodeClose(code, reason));
          } catch {
            /* ignore */
          }
          drop();
          try {
            socket.end();
          } catch {
            /* ignore */
          }
        },
      };
      client = c;
      clients.add(c);
      opts.onConnection(c);
      return true;
    }

    socket.on("data", (chunk: Buffer) => {
      // NEVER throw out of a socket handler: an uncaught throw here is an
      // unhandled 'error' on the process, not a failed request.
      try {
        buf = buf.length === 0 ? chunk : Buffer.concat([buf, chunk]);
        if (!upgraded && !handshake()) return;
        const c = client;
        if (!c) return;
        for (;;) {
          if (dead) return;
          if (buf.length < 2) return;
          const b0 = buf[0]!;
          const b1 = buf[1]!;
          const fin = (b0 & 0x80) !== 0;
          const opcode = b0 & 0x0f;
          const masked = (b1 & 0x80) !== 0;
          let len = b1 & 0x7f;
          let off = 2;
          if (len === 126) {
            if (buf.length < off + 2) return;
            len = buf.readUInt16BE(off);
            off += 2;
          } else if (len === 127) {
            if (buf.length < off + 8) return;
            const big = buf.readBigUInt64BE(off);
            if (big > BigInt(MAX_MESSAGE_BYTES)) {
              c.close(1009, "message too big");
              return;
            }
            len = Number(big);
            off += 8;
          }
          if (len > MAX_MESSAGE_BYTES) {
            c.close(1009, "message too big");
            return;
          }
          let maskKey: Buffer | undefined;
          if (masked) {
            if (buf.length < off + 4) return;
            maskKey = buf.subarray(off, off + 4);
            off += 4;
          }
          if (buf.length < off + len) return;
          const payload = Buffer.from(buf.subarray(off, off + len));
          buf = buf.subarray(off + len);
          if (maskKey) {
            for (let i = 0; i < payload.length; i++) payload[i] = payload[i]! ^ maskKey[i % 4]!;
          }

          if (opcode === 0x8) {
            // Close handshake: echo the close, then let go of the socket.
            const code = payload.length >= 2 ? payload.readUInt16BE(0) : 1000;
            c.close(code === 1005 ? 1000 : code, "");
            return;
          }
          if (opcode === 0x9) {
            if (!socket.destroyed) socket.write(encodeFrame(0xa, payload));
            continue;
          }
          if (opcode === 0xa) continue; // unsolicited pong: ignore
          if (opcode === 0x2) {
            c.close(1003, "binary frames unsupported");
            return;
          }
          if (opcode === 0x1 || opcode === 0x0) {
            if (opcode === 0x1) {
              if (fragmentOpcode !== -1) {
                c.close(1002, "interleaved fragments");
                return;
              }
              if (fin) {
                dispatch(payload);
                continue;
              }
              fragmentOpcode = 0x1;
              fragments = [payload];
              continue;
            }
            if (fragmentOpcode === -1) {
              c.close(1002, "continuation without start");
              return;
            }
            fragments.push(payload);
            const total = fragments.reduce((n, f) => n + f.length, 0);
            if (total > MAX_MESSAGE_BYTES) {
              c.close(1009, "message too big");
              return;
            }
            if (fin) {
              const whole = Buffer.concat(fragments);
              fragments = [];
              fragmentOpcode = -1;
              dispatch(whole);
            }
            continue;
          }
          c.close(1002, "unsupported opcode");
          return;
        }
      } catch {
        try {
          client?.close(1002, "protocol error");
        } catch {
          /* ignore */
        }
        drop();
      }
    });

    socket.on("error", () => drop());
    socket.on("close", () => drop());
  });
  return new Promise<WsServer>((resolve, reject) => {
    server.once("error", reject);
    server.listen(opts.port ?? 0, host, () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      let closing: Promise<void> | undefined;
      resolve({
        port,
        clients,
        close(): Promise<void> {
          if (closing) return closing;
          closing = new Promise<void>((res) => {
            let done = false;
            const finish = (): void => {
              if (done) return;
              done = true;
              clearInterval(poll);
              res();
            };
            // WHY THE POLL AND NOT JUST THE CALLBACK. Measured on Bun 1.3.14 (2026-09-04): once
            // this server has accepted and lost a WebSocket client, neither server.close()'s
            // callback nor the 'close' event ever fires, even with zero live clients and every
            // tracked socket destroyed — a close() that hangs forever. `server.listening` DOES flip
            // to false, and the listener really is shut, so that is the observable we resolve on.
            // The callback/event paths are kept first because on Node they fire immediately.
            const poll = setInterval(() => {
              if (!server.listening) finish();
            }, 20);
            poll.unref?.();
            server.close(finish);
            server.once("close", finish);
            for (const s of sockets) {
              try {
                s.destroy();
              } catch {
                /* ignore */
              }
            }
            sockets.clear();
          });
          return closing;
        },
      });
    });
  });
}

/* ------------------------------------------------------------------ */
/* The multiplexer                                                     */
/* ------------------------------------------------------------------ */

interface IncomingCommand {
  id?: unknown;
  method?: unknown;
  params?: unknown;
}

interface MuxClientState {
  sessionId: string;
  subscribed: Set<string>;
}

/**
 * Host a BiDi multiplexer over ONE established upstream BidiConnection (the
 * real Firefox session). Loopback only. Zero runtime deps: RFC 6455 server
 * over node:http upgrade + hand framing.
 */
export async function startBidiMux(
  upstream: BidiConnection,
  opts: { host?: string; port?: number } = {},
): Promise<BidiMux> {
  const host = opts.host ?? "127.0.0.1";
  const states = new Map<WsClient, MuxClientState>();
  /** event name -> { count, off } — the REAL upstream subscription is
   *  refcounted across joiners, so Firefox sees one subscribe and one
   *  unsubscribe no matter how many joiners want the event. */
  const subs = new Map<string, { count: number; off: () => void }>();
  let sessionSeq = 0;
  let closed = false;
  let closing: Promise<void> | undefined;

  const server = await createWsServer({
    host,
    port: opts.port ?? 0,
    path: "/session",
    onConnection: (client) => {
      states.set(client, { sessionId: `mux-${++sessionSeq}`, subscribed: new Set() });
      client.onMessage = (raw) => void handleMessage(client, raw);
      client.onClose = () => releaseClient(client);
    },
  });

  const endpoint = `ws://${host}:${server.port}/session`;

  function send(client: WsClient, obj: unknown): void {
    client.send(JSON.stringify(obj));
  }

  function fanOut(event: string, params: unknown): void {
    for (const [client, state] of states) {
      if (state.subscribed.has(event)) send(client, { type: "event", method: event, params });
    }
  }

  function subscribeOne(client: WsClient, event: string): void {
    const state = states.get(client);
    if (!state || state.subscribed.has(event)) return;
    state.subscribed.add(event);
    const existing = subs.get(event);
    if (existing) {
      existing.count++;
      return;
    }
    const off = upstream.on(event as BidiEventName, (params: unknown) => fanOut(event, params));
    subs.set(event, { count: 1, off });
  }

  function unsubscribeOne(client: WsClient, event: string): void {
    const state = states.get(client);
    if (!state || !state.subscribed.has(event)) return;
    state.subscribed.delete(event);
    const entry = subs.get(event);
    if (!entry) return;
    entry.count--;
    if (entry.count <= 0) {
      subs.delete(event);
      try {
        entry.off();
      } catch {
        /* teardown is best effort */
      }
    }
  }

  function releaseClient(client: WsClient): void {
    const state = states.get(client);
    if (!state) return;
    for (const event of [...state.subscribed]) unsubscribeOne(client, event);
    states.delete(client);
  }

  function eventsOf(params: unknown): string[] {
    const raw = (params as { events?: unknown } | undefined)?.events;
    return Array.isArray(raw) ? raw.filter((e): e is string => typeof e === "string") : [];
  }

  async function handleMessage(client: WsClient, raw: string): Promise<void> {
    let msg: IncomingCommand;
    try {
      msg = JSON.parse(raw) as IncomingCommand;
    } catch {
      client.close(1002, "invalid JSON");
      return;
    }
    const id = msg.id;
    const method = msg.method;
    if (typeof id !== "number" || typeof method !== "string") {
      // Not a command we can answer, and answering the wrong id is worse than
      // silence: a joiner's own send() timer will surface the loss.
      return;
    }
    const params = msg.params;
    // A joiner that skipped session.new still gets a state (created on
    // connect), so every local command is answerable at any time.
    const state = states.get(client);

    if (method === "session.new") {
      send(client, {
        type: "success",
        id,
        result: { sessionId: state?.sessionId ?? `mux-${++sessionSeq}`, capabilities: upstream.capabilities },
      });
      return;
    }
    if (method === "session.end") {
      // Local ONLY: ending the real session would take every other joiner
      // down with it, and the joiner's tabs are browser state, not session
      // state, so they survive untouched.
      releaseClient(client);
      if (state) states.set(client, { sessionId: state.sessionId, subscribed: new Set() });
      send(client, { type: "success", id, result: {} });
      return;
    }
    if (method === "session.subscribe" || method === "session.unsubscribe") {
      // A `contexts` argument is accepted and treated as global: this
      // toolkit's BidiConnection.on() only ever subscribes by event name.
      for (const event of eventsOf(params)) {
        if (method === "session.subscribe") subscribeOne(client, event);
        else unsubscribeOne(client, event);
      }
      send(client, { type: "success", id, result: {} });
      return;
    }
    if (method === "session.status") {
      send(client, { type: "success", id, result: { ready: false, message: "multiplexed" } });
      return;
    }

    try {
      const result = await upstream.send(method as never, params as never, {
        timeoutMs: FORWARD_TIMEOUT_MS,
      });
      send(client, { type: "success", id, result });
    } catch (e) {
      const err = e as BidiError;
      const message = err?.message ?? String(e);
      send(client, {
        type: "error",
        id,
        error: (err instanceof BidiError ? err.code : undefined) ?? "unknown error",
        message,
      });
      // A forward that failed because the upstream socket is gone is the
      // earliest signal we get — BidiConnection exposes no onclose hook.
      if (/connection closed|connection disposed|connection not open/.test(message)) {
        void closeAll();
      }
    }
  }

  // The forwarded-rejection path above only fires when someone sends a
  // command; an IDLE joiner would never learn the holder died. This unref'd
  // poll is the other half — it costs nothing and never keeps a process alive.
  const watchdog = setInterval(() => {
    if (!upstream.isOpen) void closeAll();
  }, 250);
  watchdog.unref?.();

  function closeAll(): Promise<void> {
    if (closing) return closing;
    closed = true;
    clearInterval(watchdog);
    closing = (async () => {
      for (const [client] of [...states]) {
        try {
          client.close(1001, "holder closing");
        } catch {
          /* ignore */
        }
      }
      states.clear();
      for (const [, entry] of subs) {
        try {
          entry.off();
        } catch {
          /* ignore */
        }
      }
      subs.clear();
      await server.close();
    })();
    return closing;
  }

  return {
    endpoint,
    clients(): number {
      return closed ? 0 : server.clients.size;
    },
    close(): Promise<void> {
      return closeAll();
    },
  };
}
