/**
 * Unit + in-process integration tests for src/bidi/marionette.ts — the orphan
 * BiDi-session recovery client (issue #4).
 *
 * No real Firefox here: encodeFrame and FrameDecoder are pure and tested against
 * known byte vectors, and forceClearOrphanSession is driven against a tiny
 * in-process TCP server that speaks the Marionette "packet" dialect (handshake
 * push + one reply). A full live test needs Firefox launched with --marionette
 * and is a later integration step.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { createServer, type Server, type Socket } from "node:net";
import {
  FrameDecoder,
  MarionetteProtocolError,
  defaultMarionettePort,
  encodeFrame,
  forceClearOrphanSession,
} from "../src/bidi/marionette.ts";

// ---------------------------------------------------------------------------
// encodeFrame — known wire vectors
// ---------------------------------------------------------------------------

describe("encodeFrame", () => {
  test("frames the DeleteSession command as exactly 34:[...]", () => {
    const frame = encodeFrame([0, 1, "WebDriver:DeleteSession", {}]);
    expect(frame.toString("utf8")).toBe('34:[0,1,"WebDriver:DeleteSession",{}]');
    // And byte-for-byte, so no charset ambiguity slips through.
    expect(frame.equals(Buffer.from('34:[0,1,"WebDriver:DeleteSession",{}]', "utf8"))).toBe(true);
  });

  test("frames the canonical handshake object as 50:{...}", () => {
    const frame = encodeFrame({ applicationType: "gecko", marionetteProtocol: 3 });
    expect(frame.toString("utf8")).toBe('50:{"applicationType":"gecko","marionetteProtocol":3}');
  });

  test("length prefix is the UTF-8 BYTE count, not the character count", () => {
    // "é" is one JS char but two UTF-8 bytes; JSON.stringify → `"é"` = 4 bytes.
    const frame = encodeFrame("é");
    expect(frame.toString("utf8")).toBe('4:"é"');
    const colon = frame.indexOf(0x3a);
    const declaredLen = Number.parseInt(frame.toString("ascii", 0, colon), 10);
    expect(frame.length - (colon + 1)).toBe(declaredLen); // body byte count matches prefix
  });
});

// ---------------------------------------------------------------------------
// FrameDecoder — partial reads, coalesced frames, malformed framing
// ---------------------------------------------------------------------------

const HANDSHAKE = { applicationType: "gecko", marionetteProtocol: 3 };
const HANDSHAKE_BYTES = encodeFrame(HANDSHAKE); // "50:{...}"

describe("FrameDecoder", () => {
  test("decodes a single whole frame fed in one push", () => {
    const d = new FrameDecoder();
    d.push(HANDSHAKE_BYTES);
    expect(d.next()).toEqual(HANDSHAKE);
    expect(d.next()).toBeUndefined(); // buffer drained
  });

  test("returns undefined until a body split across two pushes completes (partial read)", () => {
    const d = new FrameDecoder();
    // Split mid-body so both the prefix and part of the JSON are in the first chunk.
    const cut = HANDSHAKE_BYTES.length - 10;
    d.push(HANDSHAKE_BYTES.subarray(0, cut));
    expect(d.next()).toBeUndefined(); // body not fully arrived
    d.push(HANDSHAKE_BYTES.subarray(cut));
    expect(d.next()).toEqual(HANDSHAKE);
    expect(d.next()).toBeUndefined();
  });

  test("returns undefined when the length prefix itself is split across pushes", () => {
    const d = new FrameDecoder();
    d.push(Buffer.from("5", "ascii")); // first digit of "50:", no colon yet
    expect(d.next()).toBeUndefined();
    d.push(HANDSHAKE_BYTES.subarray(1)); // the rest: "0:{...}"
    expect(d.next()).toEqual(HANDSHAKE);
  });

  test("drains multiple frames coalesced into one push, one per next()", () => {
    const reply = [1, 1, null, { value: null }];
    const replyBytes = encodeFrame(reply);
    const d = new FrameDecoder();
    d.push(Buffer.concat([HANDSHAKE_BYTES, replyBytes]));
    expect(d.next()).toEqual(HANDSHAKE);
    expect(d.next()).toEqual(reply);
    expect(d.next()).toBeUndefined();
  });

  test("handles a partial second frame after a whole first frame", () => {
    const reply = [1, 1, null, { value: null }];
    const replyBytes = encodeFrame(reply);
    const d = new FrameDecoder();
    // Whole handshake + only the first 3 bytes of the reply frame.
    d.push(Buffer.concat([HANDSHAKE_BYTES, replyBytes.subarray(0, 3)]));
    expect(d.next()).toEqual(HANDSHAKE); // first frame yields
    expect(d.next()).toBeUndefined(); // second frame incomplete
    d.push(replyBytes.subarray(3));
    expect(d.next()).toEqual(reply);
  });

  test("throws MarionetteProtocolError on a non-digit length prefix", () => {
    const d = new FrameDecoder();
    d.push(Buffer.from("x:whoops", "ascii"));
    expect(() => d.next()).toThrow(MarionetteProtocolError);
  });

  test("fails fast on a non-digit even before any colon has arrived", () => {
    const d = new FrameDecoder();
    d.push(Buffer.from("{not-a-length", "ascii")); // no colon, but clearly not framing
    expect(() => d.next()).toThrow(MarionetteProtocolError);
  });

  test("throws MarionetteProtocolError when a complete body is not valid JSON", () => {
    const d = new FrameDecoder();
    d.push(Buffer.from("3:{ x", "ascii")); // 3 bytes "{ x" — complete but unparseable
    expect(() => d.next()).toThrow(MarionetteProtocolError);
  });
});

// ---------------------------------------------------------------------------
// defaultMarionettePort — env override + default
// ---------------------------------------------------------------------------

describe("defaultMarionettePort", () => {
  const KEY = "CDP_FIREFOX_MARIONETTE_PORT";
  const original = process.env[KEY];
  afterEach(() => {
    if (original === undefined) delete process.env[KEY];
    else process.env[KEY] = original;
  });

  test("defaults to 2828 when unset", () => {
    delete process.env[KEY];
    expect(defaultMarionettePort()).toBe(2828);
  });

  test("honors a valid env override", () => {
    process.env[KEY] = "12345";
    expect(defaultMarionettePort()).toBe(12345);
  });

  test("falls back to the default on a non-finite or non-positive value", () => {
    for (const bad of ["", "not-a-number", "0", "-5"]) {
      process.env[KEY] = bad;
      expect(defaultMarionettePort()).toBe(2828);
    }
  });
});

// ---------------------------------------------------------------------------
// forceClearOrphanSession — refused port, invalid port, and the live exchange
// against an in-process fake Marionette server
// ---------------------------------------------------------------------------

/** Pick a free loopback port by binding :0, then hand it back closed. */
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      if (addr === null || typeof addr === "string") {
        srv.close();
        reject(new Error("no port"));
        return;
      }
      const { port } = addr;
      srv.close(() => resolve(port));
    });
  });
}

type FakeOptions = {
  /** Reply frame value to send after the command arrives. */
  reply?: unknown;
  /** If true, push the handshake then close without ever replying. */
  dropAfterReply?: boolean;
  /** If true, write the handshake split into two TCP writes. */
  splitHandshake?: boolean;
};

/**
 * A minimal in-process Marionette server: on connect it pushes the handshake,
 * then on receiving a complete command frame it writes back `opts.reply`.
 * Returns the bound port and a close() that tears the server down.
 */
function startFakeMarionette(opts: FakeOptions = {}): Promise<{ port: number; close: () => Promise<void> }> {
  const server: Server = createServer((sock: Socket) => {
    if (opts.splitHandshake) {
      const mid = Math.floor(HANDSHAKE_BYTES.length / 2);
      sock.write(HANDSHAKE_BYTES.subarray(0, mid));
      // Nudge the second half onto a separate TCP read.
      setTimeout(() => sock.write(HANDSHAKE_BYTES.subarray(mid)), 5);
    } else {
      sock.write(HANDSHAKE_BYTES);
    }
    const dec = new FrameDecoder();
    sock.on("data", (chunk: Buffer) => {
      dec.push(chunk);
      const cmd = dec.next();
      if (cmd === undefined) return; // wait for the whole command frame
      if (opts.dropAfterReply) {
        sock.destroy(); // command seen, but hang up without replying
        return;
      }
      sock.write(encodeFrame(opts.reply ?? [1, 1, null, { value: null }]));
    });
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (addr === null || typeof addr === "string") {
        server.close();
        reject(new Error("no port"));
        return;
      }
      const { port } = addr;
      const close = () => new Promise<void>((res) => server.close(() => res()));
      resolve({ port, close });
    });
  });
}

describe("forceClearOrphanSession", () => {
  let cleanup: (() => Promise<void>) | undefined;
  afterEach(async () => {
    if (cleanup) await cleanup();
    cleanup = undefined;
  });

  test("returns false FAST on a closed port (Marionette not running), no throw, no hang", async () => {
    const port = await freePort(); // bound then released: nothing listening now
    const started = Date.now();
    const result = await forceClearOrphanSession(port, { timeoutMs: 2000 });
    const elapsed = Date.now() - started;
    expect(result).toBe(false);
    expect(elapsed).toBeLessThan(1500); // ECONNREFUSED is effectively immediate, well under timeout
  });

  test("returns false on an invalid port without throwing", async () => {
    expect(await forceClearOrphanSession(0)).toBe(false);
    expect(await forceClearOrphanSession(Number.NaN)).toBe(false);
    expect(await forceClearOrphanSession(70000)).toBe(false);
  });

  test("returns true when the reply clears an active session (error === null)", async () => {
    const fake = await startFakeMarionette({ reply: [1, 1, null, { value: null }] });
    cleanup = fake.close;
    expect(await forceClearOrphanSession(fake.port, { timeoutMs: 2000 })).toBe(true);
  });

  test("returns true when the slot was already empty (invalid session id)", async () => {
    const fake = await startFakeMarionette({
      reply: [1, 1, { error: "invalid session id", message: "no session" }, null],
    });
    cleanup = fake.close;
    expect(await forceClearOrphanSession(fake.port, { timeoutMs: 2000 })).toBe(true);
  });

  test("returns false on any other error reply (cannot confirm)", async () => {
    const fake = await startFakeMarionette({
      reply: [1, 1, { error: "unknown error", message: "boom" }, null],
    });
    cleanup = fake.close;
    expect(await forceClearOrphanSession(fake.port, { timeoutMs: 2000 })).toBe(false);
  });

  test("tolerates a handshake split across two TCP writes", async () => {
    const fake = await startFakeMarionette({ splitHandshake: true, reply: [1, 1, null, { value: null }] });
    cleanup = fake.close;
    expect(await forceClearOrphanSession(fake.port, { timeoutMs: 2000 })).toBe(true);
  });

  test("returns false when the peer closes after the command without replying", async () => {
    const fake = await startFakeMarionette({ dropAfterReply: true });
    cleanup = fake.close;
    expect(await forceClearOrphanSession(fake.port, { timeoutMs: 2000 })).toBe(false);
  });

  test("returns false on timeout when the peer accepts but never speaks", async () => {
    // A server that accepts the socket and stays mute — no handshake, no reply.
    const server = createServer(() => {
      /* hold the socket open, say nothing */
    });
    await new Promise<void>((res) => server.listen(0, "127.0.0.1", () => res()));
    const addr = server.address();
    const port = typeof addr === "object" && addr ? addr.port : 0;
    cleanup = () => new Promise<void>((res) => server.close(() => res()));

    const started = Date.now();
    const result = await forceClearOrphanSession(port, { timeoutMs: 300 });
    const elapsed = Date.now() - started;
    expect(result).toBe(false);
    expect(elapsed).toBeGreaterThanOrEqual(250); // waited out the timeout
    expect(elapsed).toBeLessThan(2000);
  });
});
