/**
 * Unit tests for src/bidi/mux.ts — the holder-hosted BiDi session multiplexer.
 *
 * NO BROWSER IS INVOLVED. The "real Firefox" is a FAKE UPSTREAM: a second
 * WebSocket server built from the mux's own createWsServer helper (reusing the
 * framing code rather than duplicating it), which answers session.new, echoes
 * commands after a caller-chosen delay, records every session.subscribe /
 * unsubscribe / end it sees, and can push events on demand. The system under
 * test is therefore the whole path a joiner actually walks: real
 * BidiConnection -> real RFC 6455 frames -> mux -> real BidiConnection -> fake.
 *
 * Recording subscribe/unsubscribe at the fake is the point of the refcount
 * cases: the only way to prove Firefox saw exactly one subscribe for two
 * joiners is to count what arrived at the far end.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { BidiError, connectBidiSessionUrl, type BidiConnection } from "../src/bidi/client.ts";
import { createWsServer, startBidiMux, type BidiMux, type WsClient, type WsServer } from "../src/bidi/mux.ts";

interface Fake {
  url: string;
  server: WsServer;
  /** Every method the fake was asked to run, in arrival order. */
  seen: string[];
  subscribes: string[][];
  unsubscribes: string[][];
  emit(method: string, params: unknown): void;
  /** Hard-close every upstream socket, simulating Firefox dying. */
  killSockets(): void;
}

async function makeFake(): Promise<Fake> {
  const sockets = new Set<WsClient>();
  const seen: string[] = [];
  const subscribes: string[][] = [];
  const unsubscribes: string[][] = [];
  let seq = 0;

  const server = await createWsServer({
    onConnection: (client) => {
      sockets.add(client);
      client.onClose = () => sockets.delete(client);
      client.onMessage = (raw) => {
        const msg = JSON.parse(raw) as { id: number; method: string; params?: Record<string, unknown> };
        const { id, method, params } = msg;
        seen.push(method);
        const ok = (result: unknown): void => client.send(JSON.stringify({ type: "success", id, result }));
        if (method === "session.new") {
          ok({ sessionId: "real", capabilities: { browserName: "firefox" } });
          return;
        }
        if (method === "session.subscribe") {
          subscribes.push((params?.events as string[]) ?? []);
          ok({});
          return;
        }
        if (method === "session.unsubscribe") {
          unsubscribes.push((params?.events as string[]) ?? []);
          ok({});
          return;
        }
        if (method === "echo.cmd") {
          const n = ++seq;
          const delayMs = Number(params?.delayMs ?? 0);
          setTimeout(() => ok({ echo: params, seq: n }), delayMs);
          return;
        }
        if (method === "boom") {
          client.send(JSON.stringify({ type: "error", id, error: "unknown error", message: "kaboom" }));
          return;
        }
        ok({});
      };
    },
  });

  return {
    url: `ws://127.0.0.1:${server.port}/session`,
    server,
    seen,
    subscribes,
    unsubscribes,
    emit(method, params) {
      for (const c of sockets) c.send(JSON.stringify({ type: "event", method, params }));
    },
    killSockets() {
      for (const c of sockets) c.close(1001, "firefox died");
      sockets.clear();
    },
  };
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

let fake: Fake;
let upstream: BidiConnection;
let mux: BidiMux;
let j1: BidiConnection;
let j2: BidiConnection;

beforeAll(async () => {
  fake = await makeFake();
  upstream = await connectBidiSessionUrl(fake.url);
  mux = await startBidiMux(upstream);
  j1 = await connectBidiSessionUrl(mux.endpoint);
  j2 = await connectBidiSessionUrl(mux.endpoint);
}, 20_000); // bun's default 5s hook timeout is tight when the whole suite is competing for CPU

afterAll(async () => {
  try {
    await mux.close();
  } catch {
    /* ignore */
  }
  upstream.dispose();
  await fake.server.close();
});

test("(a) each joiner gets a distinct virtual sessionId and the REAL capabilities", () => {
  expect(j1.sessionId).toBeDefined();
  expect(j2.sessionId).toBeDefined();
  expect(j1.sessionId).not.toBe(j2.sessionId);
  expect(j1.sessionId).not.toBe("real");
  expect(j1.capabilities).toEqual({ browserName: "firefox" });
  expect(j2.capabilities).toEqual({ browserName: "firefox" });
  expect(mux.clients()).toBe(2);
  // The fake saw exactly ONE session.new: the holder's. Joiners are answered locally.
  expect(fake.seen.filter((m) => m === "session.new").length).toBe(1);
});

test("(b) 20 interleaved sends with random delays each get their OWN reply back", async () => {
  const calls = Array.from({ length: 20 }, (_, i) => {
    const conn = i % 2 === 0 ? j1 : j2;
    const tag = `call-${i}`;
    const delayMs = Math.floor(Math.random() * 40);
    return (conn.send as unknown as (m: string, p: unknown) => Promise<{ echo: { tag: string } }>)(
      "echo.cmd",
      { tag, delayMs },
    ).then((r) => ({ want: tag, got: r.echo.tag }));
  });
  const results = await Promise.all(calls);
  expect(results.length).toBe(20);
  for (const r of results) expect(r.got).toBe(r.want);
});

test("(c) an upstream error surfaces as a BidiError on the RIGHT joiner only", async () => {
  let other: unknown = "not-rejected";
  const otherCall = (j2.send as unknown as (m: string, p: unknown) => Promise<unknown>)("echo.cmd", {
    tag: "fine",
  }).catch((e) => {
    other = e;
    return null;
  });
  const err = await (j1.send as unknown as (m: string, p: unknown) => Promise<unknown>)("boom", {}).then(
    () => null,
    (e: unknown) => e,
  );
  await otherCall;
  expect(err).toBeInstanceOf(BidiError);
  expect((err as BidiError).code).toBe("unknown error");
  expect((err as BidiError).message).toContain("kaboom");
  expect(other).toBe("not-rejected");
});

test("(d) subscriptions are refcounted: one real subscribe, one real unsubscribe", async () => {
  const before = fake.subscribes.length;
  const beforeUn = fake.unsubscribes.length;
  const hits1: unknown[] = [];
  const hits2: unknown[] = [];

  const off1 = j1.on("log.entryAdded" as never, ((p: unknown) => hits1.push(p)) as never);
  await sleep(80);
  expect(fake.subscribes.length - before).toBe(1);

  const off2 = j2.on("log.entryAdded" as never, ((p: unknown) => hits2.push(p)) as never);
  await sleep(80);
  expect(fake.subscribes.length - before).toBe(1); // still ONE real subscribe

  fake.emit("log.entryAdded", { text: "hello" });
  await sleep(80);
  expect(hits1).toEqual([{ text: "hello" }]);
  expect(hits2).toEqual([{ text: "hello" }]);

  off1();
  await sleep(80);
  expect(fake.unsubscribes.length - beforeUn).toBe(0); // j2 still wants it

  off2();
  await sleep(80);
  expect(fake.unsubscribes.length - beforeUn).toBe(1);
  expect(fake.unsubscribes.at(-1)).toEqual(["log.entryAdded"]);
});

test("(e) session.end is answered locally and never reaches the real session", async () => {
  const result = await (j1.send as unknown as (m: string, p: unknown) => Promise<unknown>)("session.end", {});
  expect(result).toEqual({});
  expect(fake.seen).not.toContain("session.end");
  // j2 is unaffected.
  const r2 = await (j2.send as unknown as (m: string, p: unknown) => Promise<{ echo: unknown }>)("echo.cmd", {
    tag: "after-end",
  });
  expect(r2.echo).toEqual({ tag: "after-end" });
});

test("(f) a client socket closing releases that client's subscriptions", async () => {
  const beforeUn = fake.unsubscribes.length;
  const beforeSub = fake.subscribes.length;
  const offA = j1.on("network.responseCompleted" as never, (() => {}) as never);
  const offB = j2.on("network.responseCompleted" as never, (() => {}) as never);
  await sleep(80);
  expect(fake.subscribes.length - beforeSub).toBe(1);

  j2.dispose(); // socket close, NOT an off() call
  await sleep(150);
  expect(fake.unsubscribes.length - beforeUn).toBe(0); // j1 still holds it
  expect(mux.clients()).toBe(1);

  offA();
  await sleep(120);
  expect(fake.unsubscribes.length - beforeUn).toBe(1);
  expect(fake.unsubscribes.at(-1)).toEqual(["network.responseCompleted"]);
  offB();
});

test("(g) mux.close() rejects pending sends and drops the joiner's socket", async () => {
  const f = await makeFake();
  const up = await connectBidiSessionUrl(f.url);
  const m = await startBidiMux(up);
  const j = await connectBidiSessionUrl(m.endpoint);
  const pending = (j.send as unknown as (me: string, p: unknown) => Promise<unknown>)("echo.cmd", {
    tag: "slow",
    delayMs: 3000,
  }).then(
    () => null,
    (e: unknown) => e,
  );
  await sleep(50);
  await m.close();
  const err = await pending;
  expect(err).toBeInstanceOf(BidiError);
  expect(j.isOpen).toBe(false);
  expect(m.clients()).toBe(0);
  up.dispose();
  await f.server.close();
});

test("(h) upstream dying closes every joiner within ~1s", async () => {
  const f = await makeFake();
  const up = await connectBidiSessionUrl(f.url);
  const m = await startBidiMux(up);
  const ja = await connectBidiSessionUrl(m.endpoint);
  const jb = await connectBidiSessionUrl(m.endpoint);
  expect(ja.isOpen).toBe(true);

  f.killSockets();
  const deadline = Date.now() + 1500;
  while (Date.now() < deadline && (ja.isOpen || jb.isOpen)) await sleep(25);
  expect(ja.isOpen).toBe(false);
  expect(jb.isOpen).toBe(false);
  await m.close();
  await f.server.close();
});

test("(raw framing) a fragmented text message round-trips and a ping gets a pong", async () => {
  const received: string[] = [];
  const server = await createWsServer({
    path: "/session",
    onConnection: (client) => {
      client.onMessage = (msg) => {
        received.push(msg);
        client.send(`echo:${msg}`);
      };
    },
  });
  const { connect } = await import("node:net");
  const sock = connect(server.port, "127.0.0.1");
  await new Promise<void>((r) => sock.once("connect", () => r()));

  const inbound: Buffer[] = [];
  sock.on("data", (c: Buffer) => inbound.push(c));
  sock.write(
    "GET /session HTTP/1.1\r\nHost: 127.0.0.1\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n" +
      "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n",
  );
  await sleep(100);
  expect(Buffer.concat(inbound).toString("latin1")).toContain("101 Switching Protocols");
  // RFC 6455 §1.3 fixed example: this key MUST hash to this accept value.
  expect(Buffer.concat(inbound).toString("latin1")).toContain("s3pPLMBiTxaQ9kYGzzhZRbK+xOo=");
  inbound.length = 0;

  const maskedFrame = (fin: boolean, opcode: number, body: string): Buffer => {
    const payload = Buffer.from(body, "utf8");
    const mask = Buffer.from([1, 2, 3, 4]);
    const masked = Buffer.from(payload);
    for (let i = 0; i < masked.length; i++) masked[i] = masked[i]! ^ mask[i % 4]!;
    const head = Buffer.from([(fin ? 0x80 : 0) | opcode, 0x80 | payload.length]);
    return Buffer.concat([head, mask, masked]);
  };

  sock.write(maskedFrame(false, 0x1, '{"a":1,')); // first fragment, no FIN
  sock.write(maskedFrame(true, 0x0, '"b":2}')); // continuation with FIN
  await sleep(120);
  expect(received).toEqual(['{"a":1,"b":2}']);

  const reply = Buffer.concat(inbound);
  expect(reply[0]! & 0x0f).toBe(0x1); // a text frame came back
  expect(reply.subarray(2).toString("utf8")).toBe('echo:{"a":1,"b":2}');
  inbound.length = 0;

  sock.write(maskedFrame(true, 0x9, "hi")); // ping
  await sleep(120);
  const pong = Buffer.concat(inbound);
  expect(pong[0]! & 0x0f).toBe(0xa);
  expect(pong.subarray(2).toString("utf8")).toBe("hi");

  sock.destroy();
  await server.close();
});
