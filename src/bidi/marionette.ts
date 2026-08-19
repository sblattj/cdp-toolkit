/**
 * Minimal Firefox Marionette client — orphan BiDi-session recovery, issue #4.
 *
 * WHAT THIS IS FOR, AND NOTHING ELSE. Firefox serves exactly ONE
 * WebDriver-BiDi session per browser instance, and Marionette and BiDi SHARE
 * that one global session slot. When a cdp-toolkit process dies mid-drive it can
 * leave Firefox believing a BiDi session is still active; the next `session.new`
 * then fails with "Maximum number of active sessions" even though no live
 * process holds it. `session-lease.ts` detects that a dead process left the slot
 * occupied (its `staleHolder`); THIS module is the mechanism that then frees the
 * slot inside Firefox itself, WITHOUT killing the browser — so a user's real,
 * logged-in Firefox keeps running and only the orphaned session is cleared.
 *
 * WHY MARIONETTE AND NOT BIDI. The BiDi endpoint is what's wedged: it refuses a
 * new session while the orphan is "active", and it exposes no cross-session
 * teardown. Marionette is Firefox's OTHER, older remote-control channel (a raw
 * TCP port, `--marionette`, default 2828). Because the two dialects share the
 * one session slot, a single Marionette `WebDriver:DeleteSession` tears down
 * whatever occupies that slot — the orphaned BiDi session included — as a blind
 * cross-dialect teardown. No `WebDriver:NewSession` is needed first: DeleteSession
 * against an empty slot is a harmless no-op ("invalid session id").
 *
 * THE WIRE PROTOCOL ("packet" dialect, marionetteProtocol 3), proven against
 * Firefox 153.0.3:
 *   - Framing, both directions: `<utf8-byte-length>:<json>` — the ASCII decimal
 *     byte count of the JSON body, a literal ':', then exactly that many bytes of
 *     UTF-8 JSON. Frames coalesce and split across TCP reads; the decoder handles
 *     both (see FrameDecoder).
 *   - On connect, Firefox immediately PUSHES a handshake frame (a bare object,
 *     e.g. `50:{"applicationType":"gecko","marionetteProtocol":3}`) that a client
 *     must consume before anything else.
 *   - Command frame:  `[0, msgId, "Command:Name", params]`.
 *   - Response frame: `[1, msgId, error_or_null, result_or_null]`.
 *
 * ZERO RUNTIME DEPENDENCIES: only `node:net`.
 */
import { Socket } from "node:net";

/** Firefox's default Marionette control port. */
const DEFAULT_MARIONETTE_PORT = 2828;
/** Whole-exchange budget: connect + handshake + command + reply. */
const DEFAULT_TIMEOUT_MS = 4000;
/** Marionette listens on loopback only; never dial anything else. */
const HOST = "127.0.0.1";
/** ASCII ':' — the length/body delimiter in the packet framing. */
const COLON = 0x3a;

/**
 * The one command we ever send. Marionette + BiDi share the single session slot,
 * so this blindly tears down whatever occupies it (the orphaned BiDi session)
 * with no NewSession first. Precomputed once: `34:[0,1,"WebDriver:DeleteSession",{}]`.
 */
const DELETE_SESSION_FRAME = encodeFrame([0, 1, "WebDriver:DeleteSession", {}]);

/**
 * The Marionette control port to target. Reads `CDP_FIREFOX_MARIONETTE_PORT`
 * per call (like session-lease.ts's env getters, so a test can redirect it); a
 * value that is not a finite number > 0 falls back to Firefox's 2828 default.
 */
export function defaultMarionettePort(): number {
  const raw = Number(process.env.CDP_FIREFOX_MARIONETTE_PORT);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_MARIONETTE_PORT;
}

/**
 * Encode one value as a Marionette wire frame: `<utf8-byte-length>:<utf8-json>`.
 * The length prefix is the BYTE count of the JSON body (not its character
 * count), so multi-byte UTF-8 payloads frame correctly. Pure; exported for tests.
 */
export function encodeFrame(json: unknown): Buffer {
  const body = Buffer.from(JSON.stringify(json), "utf8");
  const prefix = Buffer.from(`${body.length}:`, "ascii");
  return Buffer.concat([prefix, body]);
}

/**
 * Raised when the byte stream is not valid Marionette framing — a non-digit in
 * the length prefix, or a frame body that is complete but not parseable JSON.
 * FrameDecoder.next() throws this; forceClearOrphanSession catches it and
 * degrades to `false` (a wedged/unparseable channel cannot confirm a free slot).
 */
export class MarionetteProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MarionetteProtocolError";
  }
}

/**
 * Incremental decoder for the `<byte-length>:<json>` framing. Feed raw TCP
 * chunks with push(); pull one complete, parsed frame per next() call.
 *
 * Handles the two things naive framing gets wrong on a real socket: a single
 * frame SPLIT across several reads (next() returns undefined until the whole
 * body has arrived) and several frames COALESCED into one read (repeated next()
 * calls drain them one at a time). Exported for unit testing against known
 * byte vectors.
 */
export class FrameDecoder {
  private buf: Buffer = Buffer.alloc(0);

  /** Append a chunk of bytes. Cheap: no scan happens here. */
  push(chunk: Buffer): void {
    this.buf = this.buf.length === 0 ? chunk : Buffer.concat([this.buf, chunk]);
  }

  /**
   * Return the next complete frame as its parsed value, or undefined when more
   * bytes are still needed to complete the frame currently at the front of the
   * buffer. Throws MarionetteProtocolError on malformed framing/JSON.
   */
  next(): unknown | undefined {
    const colon = this.buf.indexOf(COLON);
    if (colon === -1) {
      // No delimiter yet. Everything buffered so far must be ASCII digits, or
      // this is not Marionette framing and never will be — fail fast instead of
      // buffering garbage until the caller's timeout.
      this.assertDigitsPrefix(this.buf.length);
      return undefined;
    }
    if (colon === 0) throw new MarionetteProtocolError("empty frame length prefix");
    this.assertDigitsPrefix(colon);

    const len = Number.parseInt(this.buf.toString("ascii", 0, colon), 10);
    const start = colon + 1;
    const end = start + len;
    if (this.buf.length < end) return undefined; // body not fully arrived yet

    const payload = this.buf.toString("utf8", start, end);
    this.buf = this.buf.subarray(end); // keep any trailing bytes for the next frame
    try {
      return JSON.parse(payload);
    } catch {
      throw new MarionetteProtocolError(
        `frame body was not valid JSON (${len} bytes): ${payload.slice(0, 80)}`,
      );
    }
  }

  /** Every byte in buf[0, upTo) must be an ASCII digit, or the framing is bad. */
  private assertDigitsPrefix(upTo: number): void {
    for (let i = 0; i < upTo; i++) {
      const b = this.buf[i]!;
      if (b < 0x30 || b > 0x39) {
        throw new MarionetteProtocolError(
          `non-digit byte 0x${b.toString(16)} in frame length prefix`,
        );
      }
    }
  }
}

/**
 * Interpret a `WebDriver:DeleteSession` reply frame `[1, msgId, error, result]`.
 * The slot is FREE (return true) in exactly two shapes:
 *   - error === null (result `{"value":null}`): an active session existed and
 *     was cleared.
 *   - error is an object with error === "invalid session id": the slot was
 *     already empty — DeleteSession was a no-op.
 * Any other shape (a different error, a non-response, a malformed frame) cannot
 * confirm the slot is free, so it returns false.
 */
function isSlotFreedReply(frame: unknown): boolean {
  if (!Array.isArray(frame)) return false;
  const err: unknown = frame[2];
  if (err === null) return true; // session existed and was cleared
  if (typeof err === "object" && err !== null && (err as { error?: unknown }).error === "invalid session id") {
    return true; // slot was already empty
  }
  return false; // any other error: cannot confirm
}

/**
 * Force-clear an orphaned WebDriver-BiDi session so a subsequent BiDi
 * `session.new` succeeds, WITHOUT killing Firefox.
 *
 * Connects to Marionette on `127.0.0.1:<marionettePort>`, drains the pushed
 * handshake frame, sends exactly one `WebDriver:DeleteSession`, reads exactly one
 * reply, and returns whether the session slot is now free.
 *
 * NEVER THROWS and NEVER LEAKS THE SOCKET. Every terminal path — success, a
 * refused connection (Marionette not running because Firefox was not launched
 * with --marionette; the NORMAL degrade case, not a loud error), a connect/read
 * timeout, any socket error, a premature close, or an unexpected/unparseable
 * reply — routes through a single settle() that destroys the socket exactly once
 * and resolves the promise. Returns true only when the slot is confirmed free.
 *
 * @param marionettePort  TCP port Firefox's Marionette server listens on.
 * @param opts.timeoutMs  Whole-exchange budget (connect+handshake+command+reply).
 *                        Default 4000ms. On timeout the socket is destroyed and
 *                        the result is false.
 */
export function forceClearOrphanSession(
  marionettePort: number,
  opts: { timeoutMs?: number } = {},
): Promise<boolean> {
  const timeoutMs =
    opts.timeoutMs !== undefined && Number.isFinite(opts.timeoutMs) && opts.timeoutMs > 0
      ? opts.timeoutMs
      : DEFAULT_TIMEOUT_MS;

  return new Promise<boolean>((resolve) => {
    // Guard a nonsense port up front: net.Socket.connect throws synchronously on
    // an out-of-range/NaN port, and that throw must not escape as a rejection.
    if (!Number.isFinite(marionettePort) || marionettePort <= 0 || marionettePort > 65535) {
      resolve(false);
      return;
    }

    const sock = new Socket();
    const decoder = new FrameDecoder();
    let settled = false;
    let handshakeSeen = false;
    let commandSent = false;

    // One-shot terminal path. Idempotent (settled guard), removes listeners so a
    // close/error triggered by our own destroy() can't re-enter, and ALWAYS
    // destroys the socket — this is the single place the socket is torn down, so
    // no code path can return without freeing it.
    const settle = (value: boolean): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      sock.removeAllListeners();
      sock.destroy();
      resolve(value);
    };

    // The timeout covers the WHOLE exchange, including connect. unref() so a
    // hosting process is never held open by this timer alone.
    const timer = setTimeout(() => settle(false), timeoutMs);
    if (typeof timer.unref === "function") timer.unref();

    // ECONNREFUSED (no Marionette on the port) and every other socket error are
    // the normal degrade to false — quiet, not logged.
    sock.on("error", () => settle(false));
    // Peer closed before we got a reply: can't confirm, degrade to false.
    sock.on("close", () => settle(false));

    sock.on("data", (chunk: Buffer) => {
      if (settled) return;
      try {
        decoder.push(chunk);
        for (;;) {
          const frame = decoder.next();
          if (frame === undefined) break; // need more bytes for the front frame
          if (!handshakeSeen) {
            // First frame is Firefox's handshake (a bare object). Consume and
            // discard it, then keep draining in case a later frame coalesced.
            handshakeSeen = true;
            continue;
          }
          // First post-handshake frame is our DeleteSession reply. Done.
          settle(isSlotFreedReply(frame));
          return;
        }
        // Handshake in hand and command not yet on the wire → send it once.
        if (handshakeSeen && !commandSent) {
          commandSent = true;
          sock.write(DELETE_SESSION_FRAME);
        }
      } catch {
        // Malformed framing/JSON: the channel can't confirm a free slot.
        settle(false);
      }
    });

    // connect() can still throw synchronously (e.g. a mid-range but invalid
    // arg); route that through settle so nothing escapes as a rejection.
    try {
      sock.connect(marionettePort, HOST);
    } catch {
      settle(false);
    }
  });
}
