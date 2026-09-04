/**
 * Unit tests for src/bidi/mux-daemon.ts — the detached process that OWNS Firefox's one BiDi
 * session so no client's lifetime is the session's lifetime.
 *
 * NO BROWSER. "Firefox" is the same FAKE UPSTREAM pattern test/bidi-mux.test.ts uses: a WebSocket
 * server built from the mux's own createWsServer, answering session.new/session.end and echoing
 * everything else while recording what it saw. The daemon is spawned as a REAL child process
 * (process.execPath), because its whole contract — the slot record names ITS pid, it exits on idle,
 * a loser exits non-zero — is only observable across a process boundary.
 *
 * CDP_ARTIFACT_DIR is a per-run temp dir (leaseDir() reads it per call, and the daemon inherits it),
 * and CDP_FIREFOX_MUX_IDLE_MS is tiny so the idle exit is observed in seconds rather than 15.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { connectBidiSessionUrl } from "../src/bidi/client.ts";
import { createWsServer, type WsClient, type WsServer } from "../src/bidi/mux.ts";
import { readSessionSlot } from "../src/bidi/session-lease.ts";

const DAEMON = fileURLToPath(new URL("../src/bidi/mux-daemon.ts", import.meta.url));

interface Fake {
  url: string;
  server: WsServer;
  seen: string[];
}

async function makeFake(): Promise<Fake> {
  const seen: string[] = [];
  const server = await createWsServer({
    onConnection: (client: WsClient) => {
      client.onMessage = (raw) => {
        const msg = JSON.parse(raw) as { id: number; method: string; params?: Record<string, unknown> };
        seen.push(msg.method);
        const ok = (result: unknown): void => client.send(JSON.stringify({ type: "success", id: msg.id, result }));
        if (msg.method === "session.new") {
          ok({ sessionId: "real", capabilities: { browserName: "firefox" } });
          return;
        }
        if (msg.method === "echo.cmd") {
          ok({ echo: msg.params });
          return;
        }
        ok({});
      };
    },
  });
  return { url: `ws://127.0.0.1:${server.port}/session`, server, seen };
}

let dir = "";
const originalArtifactDir = process.env.CDP_ARTIFACT_DIR;
const fakes: Fake[] = [];
const children = new Set<ChildProcess>();

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "cdp-mux-daemon-"));
  process.env.CDP_ARTIFACT_DIR = dir;
}, 20_000);

afterAll(async () => {
  for (const c of children) {
    try {
      c.kill("SIGKILL");
    } catch {
      /* already gone */
    }
  }
  // A daemon socket still attached to a fake would keep its server.close() callback from ever
  // firing, so give the kills a beat to land before we close the fakes.
  await new Promise((r) => setTimeout(r, 300));
  for (const f of fakes) await f.server.close().catch(() => undefined);
  if (originalArtifactDir === undefined) delete process.env.CDP_ARTIFACT_DIR;
  else process.env.CDP_ARTIFACT_DIR = originalArtifactDir;
  await rm(dir, { recursive: true, force: true });
}, 20_000);

/** Spawn a daemon the way src/bidi/driver.ts spawns it (detached, no stdio, its own env). */
function spawnDaemon(endpoint: string, env: Record<string, string> = {}): ChildProcess {
  const child = spawn(process.execPath, [DAEMON, endpoint, String(process.pid)], {
    detached: true,
    stdio: "ignore",
    env: { ...process.env, CDP_ARTIFACT_DIR: dir, CDP_FIREFOX_MUX_IDLE_MS: "400", CDP_FIREFOX_SESSION_WAIT_MS: "600", ...env },
  });
  children.add(child);
  child.once("exit", () => children.delete(child));
  return child;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Poll until `f` returns something truthy, or the deadline passes (then undefined). */
async function until<T>(f: () => Promise<T | undefined>, ms: number): Promise<T | undefined> {
  const deadline = Date.now() + ms;
  for (;;) {
    const hit = await f();
    if (hit) return hit;
    if (Date.now() >= deadline) return undefined;
    await sleep(50);
  }
}

function exitOf(child: ChildProcess, ms: number): Promise<number | null | "timeout"> {
  if (child.exitCode !== null) return Promise.resolve(child.exitCode);
  return new Promise((resolve) => {
    const t = setTimeout(() => resolve("timeout"), ms);
    child.once("exit", (code) => {
      clearTimeout(t);
      resolve(code);
    });
  });
}

test("(a) the daemon becomes the holder, serves a joiner, then exits on idle — freeing the slot and ending the session exactly once", async () => {
  const fake = await makeFake();
  fakes.push(fake);
  // A 2s idle window for THIS case: long enough that the joiner below is connected before the
  // daemon could ever go idle, so the exit we observe afterwards is caused by the client LEAVING
  // and not by a daemon that had already given up before anyone arrived.
  const child = spawnDaemon(fake.url, { CDP_FIREFOX_MUX_IDLE_MS: "2000" });

  const rec = await until(async () => {
    const r = await readSessionSlot(fake.url);
    return r?.muxEndpoint ? r : undefined;
  }, 8_000);

  expect(rec).toBeDefined();
  expect(rec!.pid).toBe(child.pid!); // the SESSION lives in the daemon, not in any client
  expect(rec!.pid).not.toBe(process.pid);
  expect(rec!.label).toContain("mux-daemon");

  // A client joins through the advertised mux and a forwarded command reaches the fake.
  const joiner = await connectBidiSessionUrl(rec!.muxEndpoint!);
  const echoed = await (joiner.send as unknown as (m: string, p: unknown) => Promise<{ echo: { hello: string } }>)("echo.cmd", { hello: "world" });
  expect(echoed.echo.hello).toBe("world");
  expect(fake.seen).toContain("echo.cmd");

  // Client leaves → the daemon is idle → it exits by itself within its idle window.
  joiner.dispose();
  const code = await exitOf(child, 6_000);
  expect(code).toBe(0);

  // One real session, opened once and ended once: the mux never opened a second one per joiner.
  expect(fake.seen.filter((m) => m === "session.new").length).toBe(1);
  expect(fake.seen.filter((m) => m === "session.end").length).toBe(1);
  // And the slot is released, so the next process can bring up a fresh daemon cleanly.
  expect(await readSessionSlot(fake.url)).toBeUndefined();
}, 30_000);

test("(b) two daemons racing for one endpoint: exactly one advertises, the other exits non-zero (never joins)", async () => {
  const fake = await makeFake();
  fakes.push(fake);
  // A long idle window here: the winner must still be alive when we assert, so the assertion is
  // about the RACE and not about a timing coincidence with the idle exit.
  const a = spawnDaemon(fake.url, { CDP_FIREFOX_MUX_IDLE_MS: "6000" });
  const b = spawnDaemon(fake.url, { CDP_FIREFOX_MUX_IDLE_MS: "6000" });

  const rec = await until(async () => {
    const r = await readSessionSlot(fake.url);
    return r?.muxEndpoint ? r : undefined;
  }, 8_000);
  expect(rec).toBeDefined();
  expect([a.pid, b.pid]).toContain(rec!.pid);

  const loser = rec!.pid === a.pid ? b : a;
  const loserCode = await exitOf(loser, 10_000);
  expect(loserCode).not.toBe("timeout");
  expect(loserCode).not.toBe(0); // refusing is the contract: a daemon must never join another one

  // The winner still holds the one real session; Firefox saw a single session.new.
  expect(await readSessionSlot(fake.url)).toBeDefined();
  expect(fake.seen.filter((m) => m === "session.new").length).toBe(1);

  const winner = rec!.pid === a.pid ? a : b;
  expect(await exitOf(winner, 15_000)).toBe(0); // and it too exits on idle
}, 40_000);

test("(c) a daemon pointed at a dead port exits non-zero fast and leaves no slot record behind", async () => {
  const endpoint = "ws://127.0.0.1:59117/session"; // nothing listens → ECONNREFUSED
  const child = spawnDaemon(endpoint);
  const code = await exitOf(child, 15_000);
  expect(code).not.toBe("timeout");
  expect(code).not.toBe(0);
  expect(await readSessionSlot(endpoint)).toBeUndefined();
}, 30_000);
