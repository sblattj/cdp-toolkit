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

let dir = "";
const originalArtifactDir = process.env.CDP_ARTIFACT_DIR;
const originalWaitEnv = process.env.CDP_FIREFOX_SESSION_WAIT_MS;

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
