/**
 * Proves the recording fake CDP server is a usable control: the real CLI, pointed at it with
 * CDP_BASE in a subprocess, succeeds on take_snapshot / take_screenshot and leaves a trail, and a
 * click leaves CDP messages. Seat C3's "read-only click sends zero messages" needs exactly this:
 * a recorder that is known to see clicks.
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { FakeCdpServer, PNG_1X1_BASE64 } from "./helpers/fake-cdp-server.ts";

const cliPath = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
const repoRoot = dirname(dirname(cliPath));

let fake: FakeCdpServer;
let base: string;
let stateDir: string;

async function runCli(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v;
  Object.assign(env, { CDP_BASE: base, CDP_ARTIFACT_DIR: stateDir, CDP_STATE_DIR: stateDir });
  delete env.CDP_REQUIRE_LEASE;
  const proc = Bun.spawn(["bun", "run", cliPath, ...args], {
    cwd: repoRoot,
    env,
    stdout: "pipe",
    stderr: "pipe",
    signal: AbortSignal.timeout(30_000),
  });
  const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  return { code: await proc.exited, stdout, stderr };
}

beforeAll(async () => {
  stateDir = await mkdtemp(join(tmpdir(), "fake-cdp-"));
  fake = new FakeCdpServer({ browser: "Edg/156.0.0.0 (fake)" });
  base = (await fake.start()).base;
});

afterAll(async () => {
  await fake.stop();
  await rm(stateDir, { recursive: true, force: true });
});

afterEach(() => fake.reset());

describe("fake CDP server", () => {
  test("serves /json/version, /json/list and /json, and records each request", async () => {
    const v = (await (await fetch(`${base}/json/version`)).json()) as { Browser: string; webSocketDebuggerUrl: string };
    expect(v.Browser).toBe("Edg/156.0.0.0 (fake)");
    expect(v.webSocketDebuggerUrl).toStartWith(`ws://${new URL(base).host}/devtools/browser/`);
    const list = (await (await fetch(`${base}/json/list`)).json()) as { id: string; webSocketDebuggerUrl: string }[];
    expect(list.map((t) => t.id)).toEqual(["PAGE1"]);
    expect(list[0]!.webSocketDebuggerUrl).toBe(`ws://${new URL(base).host}/devtools/page/PAGE1`);
    expect(((await (await fetch(`${base}/json`)).json()) as unknown[]).length).toBe(1);
    expect(fake.requests.map((r) => r.path)).toEqual(["/json/version", "/json/list", "/json"]);
    fake.reset();
    expect(fake.requests).toEqual([]);
  });

  test("answers CDP over a page socket: default {} for unknown methods, per-method override, recording", async () => {
    fake.handlers["Custom.thing"] = () => ({ answered: true });
    const ws = new WebSocket(`ws://${new URL(base).host}/devtools/page/PAGE1`);
    await new Promise<void>((res, rej) => {
      ws.onopen = () => res();
      ws.onerror = () => rej(new Error("ws error"));
    });
    const ask = (id: number, method: string) =>
      new Promise<any>((res) => {
        const on = (ev: MessageEvent) => {
          const m = JSON.parse(String(ev.data));
          if (m.id === id) {
            ws.removeEventListener("message", on);
            res(m);
          }
        };
        ws.addEventListener("message", on);
        ws.send(JSON.stringify({ id, method, params: { n: id } }));
      });
    expect((await ask(1, "Unknown.method")).result).toEqual({});
    expect((await ask(2, "Custom.thing")).result).toEqual({ answered: true });
    expect((await ask(3, "Page.captureScreenshot")).result.data).toBe(PNG_1X1_BASE64);
    ws.close();
    expect(fake.messages.map((m) => [m.targetId, m.method])).toEqual([
      ["PAGE1", "Unknown.method"],
      ["PAGE1", "Custom.thing"],
      ["PAGE1", "Page.captureScreenshot"],
    ]);
  });

  test("take_snapshot through the real CLI succeeds and leaves a trail", async () => {
    const res = await runCli(["take_snapshot"]);
    expect({ code: res.code, stderr: res.stderr }).toEqual({ code: 0, stderr: "" });
    expect(res.stdout).toContain("heading");
    expect(res.stdout).toContain("Hello");
    expect(res.stdout).toContain("button");
    expect(fake.requests.some((r) => r.path === "/json/list")).toBe(true);
    const methods = fake.messagesFor("PAGE1").map((m) => m.method);
    expect(methods).toContain("Accessibility.getFullAXTree");
  });

  test("take_screenshot through the real CLI succeeds and writes the canned PNG", async () => {
    const out = join(stateDir, "shot.png");
    const res = await runCli(["take_screenshot", "--savePath", out]);
    expect({ code: res.code, stderr: res.stderr }).toEqual({ code: 0, stderr: "" });
    expect(fake.messagesFor("PAGE1").map((m) => m.method)).toContain("Page.captureScreenshot");
    expect((await readFile(out)).toString("base64")).toBe(PNG_1X1_BASE64);
  });

  test("CONTROL: a click leaves recorded CDP messages (an Input.dispatchMouseEvent among them)", async () => {
    const res = await runCli(["click", "--uid", "3"]);
    expect({ code: res.code, stderr: res.stderr }).toEqual({ code: 0, stderr: "" });
    const methods = fake.messagesFor("PAGE1").map((m) => m.method);
    expect(methods.length).toBeGreaterThan(0);
    expect(methods).toContain("Input.dispatchMouseEvent");
  });

  test("reset clears the recordings", async () => {
    await runCli(["take_snapshot"]);
    expect(fake.messages.length).toBeGreaterThan(0);
    fake.reset();
    expect(fake.messages).toEqual([]);
    expect(fake.requests).toEqual([]);
  });
});
