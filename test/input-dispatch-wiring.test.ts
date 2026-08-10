/**
 * Unit tests for the 1.8.0 MERGE contract between Track S (the activity beacon) and Track P (the
 * new input tools): every synthesized input, from either track, lands in the dispatch log.
 *
 * WHY THIS FILE EXISTS SEPARATELY from activity.test.ts and input-parity.test.ts. Neither branch
 * could have written these tests: Track S's dispatch log was complete for the tools that existed
 * when it was written, and Track P's scroll/dispatch_mouse/html5-drag were correct as input tools
 * and simply predated the log. The bug this file guards against is only reachable once BOTH exist —
 * a toolkit scroll that the beacon then reports as a HUMAN scrolling, i.e. the toolkit warning an
 * agent about contention with itself. That failure is invisible to every test either branch shipped.
 *
 * The source-level invariant at the bottom is the one that keeps this true for tools nobody has
 * written yet, which is the only version of "complete" a log like this can actually hold.
 */
import { beforeEach, describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { clearDispatchLog, lastDispatchAt, recordDispatch, sendInput } from "../src/activity.ts";

/** The minimum of a CDP connection sendInput uses, plus a record of what it was asked to send. */
function fakeConn(result: Record<string, unknown> = {}) {
  const sent: Array<{ method: string; params: Record<string, unknown> }> = [];
  return {
    sent,
    send<T = Record<string, unknown>>(method: string, params: Record<string, unknown> = {}): Promise<T> {
      sent.push({ method, params });
      return Promise.resolve(result as T);
    },
  };
}

describe("sendInput: the single writer of Input.* commands", () => {
  beforeEach(() => clearDispatchLog());

  test("forwards the command untouched and returns the connection's answer", async () => {
    const conn = fakeConn({ ok: 1 });
    const out = await sendInput(conn, "chrome", "T1", "Input.dispatchMouseEvent", { type: "mouseWheel", deltaY: 120 });
    expect(conn.sent).toEqual([{ method: "Input.dispatchMouseEvent", params: { type: "mouseWheel", deltaY: 120 } }]);
    expect(out).toEqual({ ok: 1 });
  });

  test("records the dispatch, so the beacon can subtract it from what a human did", async () => {
    const conn = fakeConn();
    expect(lastDispatchAt("chrome", "T1")).toBeUndefined();
    await sendInput(conn, "chrome", "T1", "Input.dispatchMouseEvent", { type: "mouseWheel", deltaY: 120 });
    expect(lastDispatchAt("chrome", "T1")).toBeGreaterThan(0);
  });

  test("keys the record by backend AND target, like every other reader of the log", async () => {
    const conn = fakeConn();
    await sendInput(conn, "chrome", "SAME", "Input.dispatchMouseEvent", {});
    expect(lastDispatchAt("firefox", "SAME")).toBeUndefined();
    expect(lastDispatchAt("chrome", "OTHER")).toBeUndefined();
  });

  test("records BEFORE the send resolves, because the page sees the input first", async () => {
    // The beacon's timestamp is written in-page the moment the event lands, which can be before the
    // command's own ack comes back. Recording after the await would leave a window where the input
    // is in the page but not in the log — and a beacon read inside it attributes our own input to a
    // human. Proved by reading the log from inside the send.
    let seenDuringSend: number | undefined;
    const conn = {
      send<T = Record<string, unknown>>(): Promise<T> {
        seenDuringSend = lastDispatchAt("chrome", "T1");
        return Promise.resolve({} as T);
      },
    };
    await sendInput(conn, "chrome", "T1", "Input.dispatchMouseEvent", {});
    expect(seenDuringSend).toBeGreaterThan(0);
  });

  test("a mode toggle is sent but NOT recorded: html5 drag's finally must not stamp a phantom input", async () => {
    // Input.setInterceptDrags synthesizes nothing in the page. Logging it would write a dispatch
    // with no input behind it, and a dispatch we did not make suppresses a REAL human input landing
    // inside the 1500ms attribution window — the under-warning direction this module refuses.
    const conn = fakeConn();
    await sendInput(conn, "chrome", "T1", "Input.setInterceptDrags", { enabled: false });
    expect(conn.sent).toHaveLength(1);
    expect(lastDispatchAt("chrome", "T1")).toBeUndefined();
  });

  test("an Input.* method nobody classified is recorded by default (fail toward over-warning)", async () => {
    // The classification is a DENYLIST on purpose. A future Input.* command that genuinely
    // synthesizes input and that nobody remembered to classify must default to being logged:
    // over-warning about contention is recoverable, silently attributing our own input to a human
    // is the bug the beacon exists to prevent.
    const conn = fakeConn();
    await sendInput(conn, "chrome", "T1", "Input.someCommandFromAFutureChrome", {});
    expect(lastDispatchAt("chrome", "T1")).toBeGreaterThan(0);
  });

  test("does not disturb another target's record", async () => {
    recordDispatch("chrome", "OTHER", 1000);
    await sendInput(fakeConn(), "chrome", "T1", "Input.dispatchMouseEvent", {});
    expect(lastDispatchAt("chrome", "OTHER")).toBe(1000);
  });
});

/* --------------------------- the structural invariant --------------------------- */

/** Every .ts file under src/, recursively. */
function srcFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) srcFiles(full, out);
    else if (entry.name.endsWith(".ts")) out.push(full);
  }
  return out;
}

/** Drop comment-only lines. Crude by design: it only has to keep PROSE about the invariant (which
 *  necessarily quotes the forbidden call) from reading as a violation of it. Code that dispatches
 *  input is never on a line beginning with * or //. */
function codeLines(source: string): Array<{ n: number; text: string }> {
  return source
    .split("\n")
    .map((text, i) => ({ n: i + 1, text }))
    .filter(({ text }) => {
      const t = text.trim();
      return !t.startsWith("*") && !t.startsWith("//") && !t.startsWith("/*");
    });
}

describe("the post-merge invariant: nothing in src/ sends Input.* except sendInput", () => {
  const ROOT = join(import.meta.dir, "..", "src");

  test("a raw conn.send of an Input.* command exists nowhere in src/", () => {
    // THE regression this guards: Track P's scroll, dispatch_mouse and html5 drag all shipped as
    // `conn.send("Input.…")` on a branch cut before the dispatch log existed. Merging the two
    // branches compiles, typechecks and passes both suites with those calls unrouted — and the
    // beacon then reports the toolkit's own scroll as a human's. A grep is the only thing that
    // catches it, so the grep is a test.
    const offenders: string[] = [];
    for (const file of srcFiles(ROOT)) {
      for (const { n, text } of codeLines(readFileSync(file, "utf8"))) {
        if (/\.send[<(]/.test(text) && /"Input\./.test(text)) {
          offenders.push(`${file.slice(ROOT.length + 1)}:${n}: ${text.trim()}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  test("the chrome-only raw mouse tool dispatches through sendInput, not its own connection", () => {
    // dispatch_mouse lives outside the Driver abstraction (no PageDriver to route through), so it
    // is the one input path that could plausibly reacquire a raw send without looking wrong.
    const source = readFileSync(join(ROOT, "tools", "dispatch-mouse.ts"), "utf8");
    expect(source).toContain('from "../activity.ts"');
    expect(source).toMatch(/sendInput\(\s*conn\s*,\s*"chrome"/);
  });

  test("both drivers still hold exactly one input choke point each", () => {
    // The Chrome side funnels into dispatchInput; the Firefox side into performActions. If either
    // disappears, the tests above would keep passing while the log quietly lost a backend.
    expect(readFileSync(join(ROOT, "cdp", "driver.ts"), "utf8")).toMatch(/private async dispatchInput</);
    expect(readFileSync(join(ROOT, "bidi", "driver.ts"), "utf8")).toMatch(/private async performActions\(/);
  });
});
