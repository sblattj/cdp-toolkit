/**
 * Regression test for the 1.9.3 CLI --help fix.
 *
 * Before this release, cli.ts had NO --help/-h handling at all: `--help` fell
 * through parseArgv's generic "--key value" branch and became an ordinary tool
 * argument (args.help = true), and `-h` doesn't even start with "--" so it fell
 * all the way to the positional-token branch, where it was silently dropped if
 * a tool name was already set. Either way the TOOL RAN. For `take_screenshot`
 * that meant a real screenshot of whatever tab happened to be active, written
 * to disk — a privacy footgun triggered by the universal "tell me, don't do
 * it" discovery gesture.
 *
 * These tests spawn the real CLI as a subprocess (not a direct function call)
 * so they exercise the actual argv-parsing path a caller hits, with CDP_BASE
 * pointed at a port nothing listens on. That is the whole point: if --help is
 * ever again swallowed as a tool argument, the tool dispatch underneath it
 * will try to reach the browser, fail to connect, and the process will exit
 * non-zero with a connection error instead of printing help and exiting 0 —
 * exactly the failure mode measured against the pre-fix code (see the report).
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer, type Server } from "node:net";

const cliPath = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
const repoRoot = dirname(dirname(cliPath));

/** Grab an ephemeral port and immediately release it: nothing is listening there,
 *  so any real connection attempt gets ECONNREFUSED right away (fast, no hang),
 *  proving a --help invocation that reaches this point is a bug, not a fluke of
 *  a slow timeout. */
async function deadPort(): Promise<number> {
  const srv: Server = createServer();
  const port = await new Promise<number>((resolve, reject) => {
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      resolve(typeof addr === "object" && addr ? addr.port : 0);
    });
  });
  await new Promise<void>((resolve) => srv.close(() => resolve()));
  return port;
}

interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

async function runCli(args: string[], extraEnv: Record<string, string>): Promise<RunResult> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v;
  Object.assign(env, extraEnv);
  const proc = Bun.spawn(["bun", "run", cliPath, ...args], {
    cwd: repoRoot,
    env,
    stdout: "pipe",
    stderr: "pipe",
    signal: AbortSignal.timeout(10_000),
  });
  const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  const code = await proc.exited;
  return { code, stdout, stderr };
}

describe("cli --help / -h", () => {
  let base = 0;
  let artifactDir = "";

  beforeAll(async () => {
    base = await deadPort();
    artifactDir = await mkdtemp(join(tmpdir(), "cdp-cli-help-"));
  });

  afterAll(async () => {
    await rm(artifactDir, { recursive: true, force: true });
  });

  function deadEnv(): Record<string, string> {
    return { CDP_BASE: `http://127.0.0.1:${base}`, CDP_ARTIFACT_DIR: artifactDir };
  }

  test("bare --help prints the top-level usage, exits 0, touches no browser", async () => {
    const res = await runCli(["--help"], deadEnv());
    expect(res.code).toBe(0);
    expect(res.stdout).toContain("Usage:");
    expect(res.stdout).toContain("bun run src/cli.ts <tool>");
    expect(res.stderr).toBe("");
  });

  test("bare -h behaves identically to --help", async () => {
    const res = await runCli(["-h"], deadEnv());
    expect(res.code).toBe(0);
    expect(res.stdout).toContain("Usage:");
    expect(res.stderr).toBe("");
  });

  test("`take_screenshot --help` prints that tool's schema instead of running it, and writes no file", async () => {
    const before = await readdir(artifactDir);
    const res = await runCli(["take_screenshot", "--help"], deadEnv());
    expect(res.code).toBe(0);
    expect(res.stdout).toContain("take_screenshot");
    // Argument names/required-ness sourced from MANIFEST's inputSchema, not a hand
    // duplicated list — pin a couple of the real ones so drift would fail this.
    expect(res.stdout).toContain("--scale <number> (optional)");
    expect(res.stdout).toContain("--format <png|jpeg> (optional)");
    // The bug signature: a connection failure to CDP_BASE, or the raw {"error":...}
    // envelope cli.ts writes on a thrown tool call. Neither may appear.
    expect(res.stdout).not.toContain("Unable to connect");
    expect(res.stderr).toBe("");
    const after = await readdir(artifactDir);
    expect(after).toEqual(before);
  });

  test("`list_pages --help` prints that tool's schema instead of running it", async () => {
    const res = await runCli(["list_pages", "--help"], deadEnv());
    expect(res.code).toBe(0);
    expect(res.stdout).toContain("list_pages");
    expect(res.stdout).toContain("--probe <boolean> (optional)");
    expect(res.stdout).not.toContain("Unable to connect");
    expect(res.stderr).toBe("");
  });

  test("-h after the tool name is not silently dropped into a live dispatch", async () => {
    const res = await runCli(["list_pages", "-h"], deadEnv());
    expect(res.code).toBe(0);
    expect(res.stdout).toContain("list_pages");
    expect(res.stdout).not.toContain("Unable to connect");
  });

  test("an unknown tool name alongside --help is reported as an error, not silently accepted", async () => {
    const res = await runCli(["not_a_real_tool", "--help"], deadEnv());
    expect(res.code).toBe(1);
    expect(res.stderr).toContain("unknown tool 'not_a_real_tool'");
    expect(res.stdout).toBe("");
  });
});
