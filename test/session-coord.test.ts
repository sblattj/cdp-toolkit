/**
 * Integration-of-modules tests for the cross-process Firefox BiDi SESSION
 * coordination wired into src/bidi/driver.ts's getConnection choke point
 * (session-lease.ts + marionette.ts). NO LIVE BROWSER: every case drives a real
 * BidiBrowserDriver but reaches only as far as getConnection's lease logic, which
 * is exercised deterministically by pre-seeding the on-disk slot lock and by
 * pointing the dial at an unreachable loopback port so it fails fast.
 *
 * What a live two-process integration test (a separate seat) still owns: the
 * Marionette force-clear of a real orphaned session (#4's "maximum number of
 * active sessions" → DeleteSession → retry), and two genuinely live processes
 * contending for one user-launched Firefox (#5 end to end).
 *
 * CDP_ARTIFACT_DIR is redirected to a per-run temp dir (leaseDir() reads it per
 * call) and CDP_FIREFOX_SESSION_WAIT_MS is kept tiny so the live-holder wait
 * times out fast. Each test uses a DISTINCT endpoint so driver.ts's module-scope
 * slotHandles/connections maps cannot carry state between cases.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readSessionSlot, sessionSlotFile, type SessionSlotRecord } from "../src/bidi/session-lease.ts";
import { createFirefoxDriverForEndpoint } from "../src/bidi/driver.ts";
import { createWsServer, type WsClient, type WsServer } from "../src/bidi/mux.ts";

let dir = "";
const originalArtifactDir = process.env.CDP_ARTIFACT_DIR;
const originalWaitEnv = process.env.CDP_FIREFOX_SESSION_WAIT_MS;
const originalMuxEnv = process.env.CDP_FIREFOX_MUX;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "cdp-session-coord-"));
  process.env.CDP_ARTIFACT_DIR = dir;
  process.env.CDP_FIREFOX_SESSION_WAIT_MS = "80"; // fail the live-holder wait in ~80ms, not 10s
});

afterAll(async () => {
  if (originalArtifactDir === undefined) delete process.env.CDP_ARTIFACT_DIR;
  else process.env.CDP_ARTIFACT_DIR = originalArtifactDir;
  if (originalWaitEnv === undefined) delete process.env.CDP_FIREFOX_SESSION_WAIT_MS;
  else process.env.CDP_FIREFOX_SESSION_WAIT_MS = originalWaitEnv;
  if (originalMuxEnv === undefined) delete process.env.CDP_FIREFOX_MUX;
  else process.env.CDP_FIREFOX_MUX = originalMuxEnv;
  await rm(dir, { recursive: true, force: true });
});

beforeEach(async () => {
  for (const f of await readdir(dir)) await rm(join(dir, f), { recursive: true, force: true });
});

/** Write a raw holder record straight to the slot file, bypassing acquire. */
async function writeHolder(rec: SessionSlotRecord): Promise<void> {
  await mkdir(dir, { recursive: true });
  await writeFile(sessionSlotFile(rec.endpoint), JSON.stringify(rec), "utf8");
}

describe("driver module load", () => {
  test("the driver module imports and constructs without a browser", () => {
    const driver = createFirefoxDriverForEndpoint("ws://127.0.0.1:59991/session");
    expect(driver.scheme).toBe("bidi");
    expect(driver.lifetime).toBe("session");
  });
});

describe("issue #5 — a LIVE lease holder is a distinguishable busy, not a wedge", () => {
  test("getConnection maps SessionSlotBusyError to a clean disconnected driverError naming the holder", async () => {
    const endpoint = "ws://127.0.0.1:59001/session";
    // A holder whose pid is THIS (alive) process → session-lease classifies it LIVE and, after the
    // tiny wait window, throws SessionSlotBusyError; getConnection must surface issue #5's message.
    await writeHolder({
      endpoint,
      pid: process.pid,
      label: "pid-live-holder",
      createdAt: Date.now(),
      marionettePort: 2828,
    });

    const driver = createFirefoxDriverForEndpoint(endpoint);
    let caught: unknown;
    try {
      await driver.listPages();
    } catch (e) {
      caught = e;
    }

    expect(caught).toBeInstanceOf(Error);
    const err = caught as Error & { code?: string };
    expect(err.code).toBe("disconnected");
    expect(err.message).toContain("LIVE process 'pid-live-holder' (pid " + process.pid + ")");
    expect(err.message).toContain("exactly ONE BiDi session per browser");
    expect(err.message).toMatch(/wait for it to release/i);
    // We never owned this slot, so the live holder's record is left untouched.
    expect(await readSessionSlot(endpoint)).toBeDefined();
  });
});

describe("terminal dial failure releases a slot we acquired this call", () => {
  test("an unreachable endpoint rejects cleanly AND leaves no leaked session-slot lock", async () => {
    const endpoint = "ws://127.0.0.1:59002/session"; // nothing listens → ECONNREFUSED, fast
    expect(await readSessionSlot(endpoint)).toBeUndefined(); // slot free at the start

    const driver = createFirefoxDriverForEndpoint(endpoint, { timeoutMs: 1500 });
    let caught: unknown;
    try {
      await driver.listPages();
    } catch (e) {
      caught = e;
    }

    // A clean rejection, not an unhandled throw / process crash.
    expect(caught).toBeInstanceOf(Error);
    // getConnection acquired the slot, the dial failed to establish any session, so the slot lock
    // it took THIS call was released — a later attempt re-acquires cleanly (no orphaned lock file).
    expect(await readSessionSlot(endpoint)).toBeUndefined();
  }, 10_000);
});

describe("the mux JOIN path is taken instead of the busy wait", () => {
  test("a live holder advertising a DEAD mux endpoint fails fast as a disconnected error naming both", async () => {
    const endpoint = "ws://127.0.0.1:59003/session";
    const muxEndpoint = "ws://127.0.0.1:59903/session"; // nothing listens → dial refused, fast
    // A LIVE holder (our own pid) that advertises a mux. If getConnection still took the BUSY path
    // it would poll to CDP_FIREFOX_SESSION_WAIT_MS and raise the issue-#5 "held by a LIVE process"
    // message; instead it must dial the mux, retry the acquire+dial once, and then give up naming
    // the holder AND the mux endpoint. That distinct message is the proof the join path ran.
    await writeHolder({
      endpoint,
      pid: process.pid,
      label: "mux-holder",
      createdAt: Date.now(),
      marionettePort: 2828,
      muxEndpoint,
    });

    const started = Date.now();
    const driver = createFirefoxDriverForEndpoint(endpoint, { timeoutMs: 1500 });
    let caught: unknown;
    try {
      await driver.listPages();
    } catch (e) {
      caught = e;
    }
    const elapsed = Date.now() - started;

    expect(caught).toBeInstanceOf(Error);
    const err = caught as Error & { code?: string };
    expect(err.code).toBe("disconnected");
    expect(err.message).toContain("'mux-holder' (pid " + process.pid + ")");
    expect(err.message).toContain(muxEndpoint);
    expect(err.message).toContain("multiplexer");
    // Two immediate acquires + two refused dials, with no polling: comfortably under the two
    // session-wait windows (2 x 80ms) the busy path would have burned, let alone the 10s default.
    expect(elapsed).toBeLessThan(5000);
    // We never held this slot, so the holder's record is untouched and carries its advertisement.
    expect((await readSessionSlot(endpoint))?.muxEndpoint).toBe(muxEndpoint);
  }, 15_000);
});

/* ==========================================================================================
 * DAEMON MODE — the default for ATTACH mode. The session must live in a DETACHED daemon, not in
 * this process, because Firefox regenerates every browsing-context id when its one BiDi session is
 * re-created: a holder that exits (even cleanly) invalidates every other process's ids. These two
 * cases pin the fork in getConnection: spawn-and-JOIN, and the fall back to hosting in-process when
 * no daemon can be started. "Firefox" is the same fake-upstream pattern test/bidi-mux.test.ts uses.
 * ========================================================================================== */
interface FakeFirefox {
  url: string;
  server: WsServer;
  seen: string[];
}
async function makeFakeFirefox(): Promise<FakeFirefox> {
  const seen: string[] = [];
  const server = await createWsServer({
    onConnection: (client: WsClient) => {
      client.onMessage = (raw) => {
        const msg = JSON.parse(raw) as { id: number; method: string };
        seen.push(msg.method);
        const ok = (result: unknown): void => client.send(JSON.stringify({ type: "success", id: msg.id, result }));
        if (msg.method === "session.new") return ok({ sessionId: "real", capabilities: { browserName: "firefox" } });
        if (msg.method === "browsingContext.getTree") return ok({ contexts: [] });
        return ok({});
      };
    },
  });
  return { url: `ws://127.0.0.1:${server.port}/session`, server, seen };
}
const fakeFirefoxes: FakeFirefox[] = [];
const daemonPids: number[] = [];
afterAll(async () => {
  for (const pid of daemonPids) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      /* already exited */
    }
  }
  await new Promise((r) => setTimeout(r, 300)); // let the kills land before the fakes close
  for (const f of fakeFirefoxes) await f.server.close().catch(() => undefined);
}, 20_000);

describe("daemon mode: the session lives in a detached daemon, and this process only JOINS", () => {
  test("getConnection spawns a daemon, joins its mux, and disposes without ending the real session", async () => {
    const fake = await makeFakeFirefox();
    fakeFirefoxes.push(fake);
    delete process.env.CDP_FIREFOX_MUX; // unset == daemon, in ATTACH mode
    process.env.CDP_FIREFOX_MUX_IDLE_MS = "1500";

    const driver = createFirefoxDriverForEndpoint(fake.url, { timeoutMs: 5000 });
    const pages = await driver.listPages(); // the real product path, through getConnection
    expect(pages).toEqual([]);

    const rec = await readSessionSlot(fake.url);
    expect(rec).toBeDefined();
    // THE POINT: the slot — and therefore Firefox's one session — is held by ANOTHER process.
    expect(rec!.pid).not.toBe(process.pid);
    expect(rec!.muxEndpoint).toBeTruthy();
    expect(rec!.label).toContain("mux-daemon");
    daemonPids.push(rec!.pid);

    // A joiner ends nothing and releases nothing: the daemon's session outlives us, which is what
    // keeps another agent's context ids, tab leases and origin records valid.
    await driver.dispose();
    expect(fake.seen).not.toContain("session.end");
    expect((await readSessionSlot(fake.url))?.pid).toBe(rec!.pid);

    delete process.env.CDP_FIREFOX_MUX_IDLE_MS;
  }, 30_000);

  test("when no daemon can be spawned, the driver falls back to hosting the session in-process", async () => {
    const fake = await makeFakeFirefox();
    fakeFirefoxes.push(fake);
    delete process.env.CDP_FIREFOX_MUX;
    process.env.CDP_FIREFOX_MUX_DAEMON = "/nonexistent/path/mux-daemon.js"; // spawn fails at once

    const driver = createFirefoxDriverForEndpoint(fake.url, { timeoutMs: 5000 });
    expect(await driver.listPages()).toEqual([]);

    const rec = await readSessionSlot(fake.url);
    expect(rec?.pid).toBe(process.pid); // WE are the holder now
    expect(rec?.muxEndpoint).toBeTruthy(); // and we still front it with a mux for anyone else
    expect(fake.seen).toContain("session.new");

    await driver.dispose();
    expect(fake.seen).toContain("session.end"); // a real holder DOES end the real session
    expect(await readSessionSlot(fake.url)).toBeUndefined();

    delete process.env.CDP_FIREFOX_MUX_DAEMON;
  }, 30_000);
});
