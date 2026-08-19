/**
 * Unit tests for src/bidi/session-lease.ts. Pure logic over the filesystem plus
 * real pids where liveness matters, so every case runs with no browser.
 * CDP_ARTIFACT_DIR is redirected to a per-run temp dir (leaseDir() reads the env
 * var per call), and waitMs is kept tiny so the live-contention case times out
 * fast. A genuinely dead pid is produced by spawning a real child, letting it
 * exit, and polling until the OS has reaped it.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isPidAlive } from "../src/leases.ts";
import {
  acquireSessionSlot,
  readSessionSlot,
  releaseSessionSlot,
  SessionSlotBusyError,
  sessionSlotFile,
  sessionWaitMs,
  type SessionSlotRecord,
} from "../src/bidi/session-lease.ts";

let dir = "";
const originalArtifactDir = process.env.CDP_ARTIFACT_DIR;
const originalWaitEnv = process.env.CDP_FIREFOX_SESSION_WAIT_MS;

const ENDPOINT = "ws://127.0.0.1:9223/session";

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "cdp-session-lease-"));
  process.env.CDP_ARTIFACT_DIR = dir;
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

/** Spawn a real child, let it exit, and wait until the OS has reaped its pid so
 *  isPidAlive() reports it dead. Returns that genuinely-dead pid. */
async function makeDeadPid(): Promise<number> {
  const child = spawn("sleep", ["0.02"], { stdio: "ignore" });
  const pid = child.pid ?? -1;
  await new Promise<void>((resolve) => child.once("exit", () => resolve()));
  for (let i = 0; i < 200 && isPidAlive(pid); i++) {
    await new Promise((r) => setTimeout(r, 5));
  }
  return pid;
}

/** Write a raw holder record straight to the slot file, bypassing acquire. */
async function writeHolder(rec: SessionSlotRecord): Promise<void> {
  await mkdir(dir, { recursive: true });
  await writeFile(sessionSlotFile(rec.endpoint), JSON.stringify(rec), "utf8");
}

describe("sessionSlotFile", () => {
  test("keys by endpoint with the safeId substitution rule", () => {
    expect(sessionSlotFile(ENDPOINT)).toBe(join(dir, "ff-session-ws___127.0.0.1_9223_session.json"));
  });
});

describe("sessionWaitMs", () => {
  test("defaults to 10000 when unset", () => {
    delete process.env.CDP_FIREFOX_SESSION_WAIT_MS;
    expect(sessionWaitMs()).toBe(10_000);
  });

  test("reads a positive finite override", () => {
    process.env.CDP_FIREFOX_SESSION_WAIT_MS = "500";
    expect(sessionWaitMs()).toBe(500);
    delete process.env.CDP_FIREFOX_SESSION_WAIT_MS;
  });

  test("falls back to default on a non-positive or non-finite value", () => {
    process.env.CDP_FIREFOX_SESSION_WAIT_MS = "0";
    expect(sessionWaitMs()).toBe(10_000);
    process.env.CDP_FIREFOX_SESSION_WAIT_MS = "-1";
    expect(sessionWaitMs()).toBe(10_000);
    process.env.CDP_FIREFOX_SESSION_WAIT_MS = "nonsense";
    expect(sessionWaitMs()).toBe(10_000);
    delete process.env.CDP_FIREFOX_SESSION_WAIT_MS;
  });
});

describe("acquireSessionSlot", () => {
  test("a fresh acquire writes our record and returns no staleHolder", async () => {
    const { handle, staleHolder } = await acquireSessionSlot(ENDPOINT, {
      label: "agent-one",
      now: 111,
      marionettePort: 2828,
    });
    expect(staleHolder).toBeUndefined();
    expect(handle.endpoint).toBe(ENDPOINT);
    expect(handle.pid).toBe(process.pid);
    expect(handle.createdAt).toBe(111);

    const rec = await readSessionSlot(ENDPOINT);
    expect(rec).toEqual({ endpoint: ENDPOINT, pid: process.pid, label: "agent-one", createdAt: 111, marionettePort: 2828 });
  });

  test("a LIVE holder blocks: acquire times out fast and throws SessionSlotBusyError naming the holder", async () => {
    // process.pid is guaranteed alive; write it as the holder.
    await writeHolder({ endpoint: ENDPOINT, pid: process.pid, label: "live-agent", createdAt: 5 });

    const started = Date.now();
    let thrown: unknown;
    try {
      await acquireSessionSlot(ENDPOINT, { label: "loser", waitMs: 300, pollMs: 20 });
    } catch (err) {
      thrown = err;
    }
    const elapsed = Date.now() - started;

    expect(thrown).toBeInstanceOf(SessionSlotBusyError);
    const busy = thrown as SessionSlotBusyError;
    expect(busy.holderPid).toBe(process.pid);
    expect(busy.holderLabel).toBe("live-agent");
    expect(busy.message).toContain("live-agent");
    expect(busy.message).toContain(String(process.pid));
    expect(busy.message).toContain(ENDPOINT);
    expect(elapsed).toBeGreaterThanOrEqual(250);
    expect(elapsed).toBeLessThan(3000);

    // The live holder's record is untouched.
    expect((await readSessionSlot(ENDPOINT))?.label).toBe("live-agent");
  });

  test("a DEAD holder is stolen and returned as staleHolder", async () => {
    const deadPid = await makeDeadPid();
    expect(isPidAlive(deadPid)).toBe(false);
    const dead: SessionSlotRecord = { endpoint: ENDPOINT, pid: deadPid, label: "orphan", createdAt: 7, marionettePort: 2829 };
    await writeHolder(dead);

    const { handle, staleHolder } = await acquireSessionSlot(ENDPOINT, { label: "stealer", now: 999, waitMs: 300 });
    expect(staleHolder).toEqual(dead);
    expect(handle.pid).toBe(process.pid);
    expect(handle.createdAt).toBe(999);

    // Our record now owns the slot.
    const rec = await readSessionSlot(ENDPOINT);
    expect(rec?.pid).toBe(process.pid);
    expect(rec?.label).toBe("stealer");
    expect(rec?.createdAt).toBe(999);
  });
});

describe("releaseSessionSlot", () => {
  test("releases our own record and is idempotent", async () => {
    const { handle } = await acquireSessionSlot(ENDPOINT, { label: "me", now: 1 });
    expect(await readSessionSlot(ENDPOINT)).toBeDefined();

    expect(await releaseSessionSlot(handle)).toEqual({ released: true });
    expect(await readSessionSlot(ENDPOINT)).toBeUndefined();

    // Second release is a no-op, not an error.
    expect(await releaseSessionSlot(handle)).toEqual({ released: false });
  });

  test("does NOT release a record another process created after stealing from us", async () => {
    const { handle } = await acquireSessionSlot(ENDPOINT, { label: "me", now: 10 });

    // Simulate another process having stolen the slot: same endpoint, different
    // createdAt (and a different owner). Our handle must not unlink it.
    await writeHolder({ endpoint: ENDPOINT, pid: process.pid, label: "thief", createdAt: 20 });

    expect(await releaseSessionSlot(handle)).toEqual({ released: false });
    expect((await readSessionSlot(ENDPOINT))?.label).toBe("thief");
  });
});

describe("readSessionSlot", () => {
  test("ENOENT (no file) reads as undefined", async () => {
    expect(await readSessionSlot("ws://127.0.0.1:9999/session")).toBeUndefined();
  });

  test("an unparseable record reads as undefined", async () => {
    await mkdir(dir, { recursive: true });
    await writeFile(sessionSlotFile(ENDPOINT), "{ not json", "utf8");
    expect(await readSessionSlot(ENDPOINT)).toBeUndefined();
  });

  test("a well-formed-but-wrong-shape record reads as undefined", async () => {
    await mkdir(dir, { recursive: true });
    await writeFile(sessionSlotFile(ENDPOINT), JSON.stringify({ endpoint: ENDPOINT, label: "x" }), "utf8");
    expect(await readSessionSlot(ENDPOINT)).toBeUndefined();
  });

  test("an unreadable (non-ENOENT) path throws rather than reading as absent", async () => {
    // A directory at the slot path makes readFile fail with EISDIR, a non-ENOENT
    // errno, which must propagate (fail closed) rather than read as free.
    await mkdir(sessionSlotFile(ENDPOINT), { recursive: true });
    await expect(readSessionSlot(ENDPOINT)).rejects.toThrow();
  });
});
