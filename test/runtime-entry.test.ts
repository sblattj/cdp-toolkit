/**
 * Issue #8 runtime tests: the MCP server must run under BOTH Bun and Node, and
 * importing the built entrypoints (dist/mcp.js, dist/cli.js) must be SILENT —
 * no server start, no stdout, no stderr. Everything here spawns real
 * subprocesses against the BUILT dist/ artifacts (not src/), because that is
 * what npx/bunx consumers execute and what the bin shims point at.
 *
 * The stdio handshake is hand-rolled (node:child_process + newline-delimited
 * JSON on stdin/stdout) on purpose: it proves the wire contract without
 * importing the MCP client SDK, so this file cannot pass because the SDK
 * papers over a broken server, and it works identically under the `bun test`
 * runner while exercising a `node`-spawned server.
 *
 * The streamable-http case is skipped with a logged note until dist/mcp.js
 * advertises "streamable-http" (the src-side half of issue #8); once it lands,
 * the same binary greps it back into existence.
 */
import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const distMcp = join(repoRoot, "dist", "mcp.js");
const distCli = join(repoRoot, "dist", "cli.js");

/** Every spawn gets a hard timeout so a hung server fails THIS test, not the suite. */
const SPAWN_TIMEOUT_MS = 15_000;

const nodeAvailable = spawnSync("node", ["--version"], { timeout: 5_000 }).status === 0;
if (!nodeAvailable) console.log("[runtime-entry] node is not on PATH — skipping the node cases");

/** Live children spawned by this file; afterEach SIGKILLs any stragglers. */
const liveChildren = new Set<ChildProcess>();
function track(child: ChildProcess): ChildProcess {
  liveChildren.add(child);
  child.once("exit", () => liveChildren.delete(child));
  return child;
}

interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

/**
 * Spawn to completion with a hard timeout. stdin is "ignore" so that even a
 * misbehaving entry that starts a server on import still sees stdin EOF
 * immediately and shuts down — the test then fails on the noisy-stderr
 * assertion instead of hanging until the timeout.
 */
function run(cmd: string, args: string[], timeoutMs = SPAWN_TIMEOUT_MS): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = track(spawn(cmd, args, { cwd: repoRoot, stdio: ["ignore", "pipe", "pipe"] }));
    let stdout = "";
    let stderr = "";
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (d: string) => {
      stdout += d;
    });
    child.stderr?.on("data", (d: string) => {
      stderr += d;
    });
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`spawn timed out after ${timeoutMs}ms: ${cmd} ${args.join(" ")}`));
    }, timeoutMs);
    child.once("exit", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
    child.once("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

interface HandshakeResult {
  serverName: string;
  toolCount: number;
  stderr: string;
  exitCode: number | null;
}

/**
 * Minimal dependency-free stdio exchange, exactly the frames the MCP SDK
 * writes: initialize (protocolVersion 2025-06-18) → notifications/initialized
 * → tools/list, newline-delimited JSON both ways. After tools/list responds,
 * stdin is closed (the normal MCP shutdown gesture) and the server must exit 0
 * on its own — no SIGKILL rescue.
 */
function stdioHandshake(cmd: string, args: string[], timeoutMs = SPAWN_TIMEOUT_MS): Promise<HandshakeResult> {
  return new Promise((resolve, reject) => {
    const child = track(spawn(cmd, args, { cwd: repoRoot, stdio: ["pipe", "pipe", "pipe"] }));
    let stderr = "";
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (d: string) => {
      stderr += d;
    });

    let buffer = "";
    let serverName = "";
    let toolCount = 0;

    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`stdio handshake timed out after ${timeoutMs}ms (${cmd})\n--- child stderr ---\n${stderr.slice(0, 2000)}`));
    }, timeoutMs);

    const send = (msg: unknown): void => {
      child.stdin?.write(`${JSON.stringify(msg)}\n`);
    };

    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      buffer += chunk;
      for (;;) {
        const nl = buffer.indexOf("\n");
        if (nl < 0) break;
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (!line) continue;
        let msg: { id?: number; result?: { serverInfo?: { name?: unknown }; tools?: unknown } };
        try {
          msg = JSON.parse(line) as typeof msg;
        } catch {
          continue; // not a JSON-RPC frame; ignore
        }
        if (msg.id === 1 && msg.result) {
          serverName = String(msg.result.serverInfo?.name ?? "");
          send({ jsonrpc: "2.0", method: "notifications/initialized" });
          send({ jsonrpc: "2.0", id: 2, method: "tools/list" });
        } else if (msg.id === 2 && msg.result) {
          toolCount = Array.isArray(msg.result.tools) ? msg.result.tools.length : 0;
          child.stdin?.end(); // the client closing the stdio pipe is the shutdown signal
        }
      }
    });

    child.once("exit", (code) => {
      clearTimeout(timer);
      if (serverName !== "" && toolCount > 0) {
        resolve({ serverName, toolCount, stderr, exitCode: code });
      } else {
        reject(new Error(`server exited before the handshake completed (name=${serverName || "?"}, tools=${toolCount}, code=${code})\n--- child stderr ---\n${stderr.slice(0, 2000)}`));
      }
    });
    child.once("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });

    // The opening frame: a 2025-06-18 initialize pins the legacy protocol era,
    // exactly what an ordinary 2025-era MCP client sends first.
    send({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "runtime-entry-test", version: "0.0.0" },
      },
    });
  });
}

describe("issue #8: runtime entrypoints (bun + node)", () => {
  beforeAll(async () => {
    if (existsSync(distMcp)) return;
    console.log("[runtime-entry] dist/mcp.js missing — running `bun run build` first");
    const built = await run("bun", ["run", "build"], 90_000);
    if (built.code !== 0 || !existsSync(distMcp)) {
      throw new Error(`build failed (exit ${built.code}):\n${built.stderr.slice(0, 2000)}`);
    }
  }, 90_000);

  afterEach(() => {
    for (const child of liveChildren) {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    }
    liveChildren.clear();
  });

  describe("silent import of built entrypoints", () => {
    const importArgs = (runtime: "node" | "bun", target: string): string[] =>
      runtime === "node"
        ? ["--input-type=module", "-e", `await import(${JSON.stringify(target)})`]
        : ["-e", `await import(${JSON.stringify(target)})`];

    const runtimes: Array<"node" | "bun"> = nodeAvailable ? ["node", "bun"] : ["bun"];
    const targets: Array<[label: string, path: string]> = [
      ["dist/mcp.js", distMcp],
      ["dist/cli.js", distCli],
    ];
    for (const runtime of runtimes) {
      for (const [label, target] of targets) {
        test(`${runtime} -e: importing ${label} is silent (exit 0, empty stdout, empty stderr)`, async () => {
          const res = await run(runtime, importArgs(runtime, target), 20_000);
          expect(res.code).toBe(0);
          expect(res.stdout).toBe("");
          expect(res.stderr).toBe("");
        }, 25_000);
      }
    }
    if (!nodeAvailable) {
      for (const [label] of targets) {
        test.skip(`node -e: importing ${label} is silent (node not on PATH)`, () => {});
      }
    }
  });

  describe("stdio JSON-RPC handshake (hand-rolled, no SDK client)", () => {
    const expectHandshake = async (cmd: string, args: string[]): Promise<HandshakeResult> => {
      const res = await stdioHandshake(cmd, args);
      expect(res.serverName).toBe("cdp-toolkit");
      expect(res.toolCount).toBeGreaterThan(40);
      expect(res.stderr).toContain("ready");
      expect(res.exitCode).toBe(0);
      return res;
    };

    if (nodeAvailable) {
      test("node dist/mcp.js: initialize 2025-06-18 + tools/list, then clean exit after stdin closes", () => expectHandshake("node", [distMcp]), 25_000);
    } else {
      test.skip("node dist/mcp.js handshake (node not on PATH)", () => {});
    }
    test("bun dist/mcp.js: initialize 2025-06-18 + tools/list, then clean exit after stdin closes", () => expectHandshake(process.execPath, [distMcp]), 25_000);
  });

  describe("streamable-http transport under bun", () => {
    const distSource = existsSync(distMcp) ? readFileSync(distMcp, "utf8") : "";
    const supportsHttp = distSource.includes("streamable-http");
    if (!supportsHttp) {
      console.log("[runtime-entry] dist/mcp.js has no streamable-http support yet — skipping http transport test (issue #8 src change not landed)");
    }

    (supportsHttp ? test : test.skip)("bun dist/mcp.js --transport streamable-http: HTTP initialize names cdp-toolkit, then exits cleanly", async () => {
      const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

      // Prefer a port the server announces on stderr (port 0 support); fall
      // back to a known high port, retrying +1 on EADDRINUSE / early exit.
      let child: ChildProcess | undefined;
      let port = 0;
      let allStderr = "";
      for (let attempt = 0; attempt < 5 && !child; attempt++) {
        const candidate = 3778 + attempt;
        const c = track(spawn(process.execPath, [distMcp, "--transport", "streamable-http", "--port", String(candidate)], { cwd: repoRoot, stdio: ["ignore", "pipe", "pipe"] }));
        let attemptStderr = "";
        let exited: number | null | undefined;
        c.stderr?.setEncoding("utf8");
        c.stderr?.on("data", (d: string) => {
          attemptStderr += d;
        });
        c.once("exit", (code) => {
          exited = code;
        });

        const deadline = Date.now() + 8_000;
        let announced = 0;
        while (Date.now() < deadline) {
          if (/EADDRINUSE|EACCES/.test(attemptStderr) || exited !== undefined) break;
          // Prefer an explicit URL (host:port) over a bare "port NNNN" word; a
          // bare-word match would happily capture "127" out of "127.0.0.1".
          const m = /https?:\/\/[^\s:]+:(\d{2,5})/.exec(attemptStderr) ?? /(?:port|listening?)[^\d\n]{0,20}(\d{4,5})/i.exec(attemptStderr);
          if (m?.[1]) {
            announced = Number(m[1]);
            break;
          }
          await wait(100);
        }
        allStderr += attemptStderr;
        if (/EADDRINUSE/.test(attemptStderr) || (exited !== undefined && !announced)) continue; // retry on the next port up
        if (exited !== undefined && exited !== 0) {
          throw new Error(`streamable-http server exited ${exited} at startup\n--- stderr ---\n${allStderr.slice(0, 2000)}`);
        }
        port = announced || candidate;
        child = c;
      }
      if (!child || port <= 0) {
        throw new Error(`could not start streamable-http server (5 attempts)\n--- stderr ---\n${allStderr.slice(0, 2000)}`);
      }

      // POST a 2025-06-18 initialize with streamable-http's required headers.
      // The response may be plain JSON or SSE-framed, so read the body until
      // serverInfo shows up rather than assuming one framing.
      const initializeBody = JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: { name: "runtime-entry-test", version: "0.0.0" },
        },
      });
      const postInitialize = async (portNumber: number, path: string): Promise<{ status: number; text: string; failed?: string }> => {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 8_000);
        let text = "";
        try {
          const res = await fetch(`http://127.0.0.1:${portNumber}${path}`, {
            method: "POST",
            headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
            body: initializeBody,
            signal: controller.signal,
          });
          if (res.body) {
            const decoder = new TextDecoder();
            for await (const chunk of res.body) {
              text += decoder.decode(chunk);
              if (text.includes("cdp-toolkit")) break; // SSE streams stay open; we have what we came for
            }
          }
          return { status: res.status, text };
        } catch (err) {
          return { status: 0, text, failed: err instanceof Error ? err.message : String(err) };
        } finally {
          clearTimeout(timer);
          controller.abort(); // close any held-open SSE stream; body is already captured
        }
      };

      let response: { status: number; text: string } | undefined;
      let lastProbe = "";
      const httpDeadline = Date.now() + 12_000;
      while (Date.now() < httpDeadline) {
        for (const path of ["/", "/mcp"]) {
          const r = await postInitialize(port, path);
          lastProbe = `POST ${path} -> ${r.status}${r.failed ? ` (${r.failed})` : ""} ${r.text.slice(0, 300)}`;
          if (r.status === 200 && r.text.includes("cdp-toolkit")) {
            response = r;
            break;
          }
        }
        if (response) break;
        await wait(300);
      }
      if (!response) {
        throw new Error(`no HTTP initialize response containing serverInfo within 12s; last probe: ${lastProbe}\n--- stderr ---\n${allStderr.slice(0, 2000)}`);
      }
      expect(response.status).toBe(200);
      expect(response.text).toContain("cdp-toolkit");

      // SIGTERM is the supervising-client shutdown path; a clean exit is exit 0
      // (shutdown handler) or the default SIGTERM disposition — never a hang,
      // crash, or unhandled-error exit.
      const exitInfo = await new Promise<{ code: number | null; signal: string | null }>((resolve) => {
        const killTimer = setTimeout(() => {
          child.kill("SIGKILL");
          resolve({ code: null, signal: null });
        }, 8_000);
        child.once("exit", (code, signal) => {
          clearTimeout(killTimer);
          resolve({ code, signal: signal ?? null });
        });
        child.kill("SIGTERM");
      });
      expect(exitInfo.code === 0 || exitInfo.signal === "SIGTERM").toBe(true);
    }, 60_000);
  });
});
