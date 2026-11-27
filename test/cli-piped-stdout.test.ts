/**
 * Regression test for #23: the CLI cut its stdout off when stdout was a pipe.
 *
 * main() wrote the JSON result with process.stdout.write and then called process.exit at once.
 * For a pipe that write is asynchronous (node on macOS, and bun), so whatever the pipe had not
 * taken yet was dropped: piped output stopped at 64 KiB under node and 128 KiB under bun, while a
 * redirect to a file was complete.
 *
 * The result here is about 400 KB (1500 long-titled targets through list_pages, against the fake
 * CDP server), well past both cut-offs. Each case runs the CLI through `sh -c '... | cat > file'`
 * so the reader is a real pipe to another process (a reader inside this test process drains too
 * fast to show the bug), and compares the piped bytes with a run redirected to a file. A last case
 * closes the reader after 10 bytes (`| head -c 10`) and expects a prompt exit with no stack trace.
 *
 * node runs the built dist/cli.js (what the bin shim points at); dist is rebuilt when it is missing
 * or older than src/cli.ts. bun runs both src/cli.ts and dist/cli.js.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { startFakeCdp, type FakeCdpServer } from "./helpers/fake-cdp-server.ts";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const srcCli = join(repoRoot, "src", "cli.ts");
const distCli = join(repoRoot, "dist", "cli.js");
const nodeAvailable = spawnSync("node", ["--version"], { timeout: 5_000 }).status === 0;
if (!nodeAvailable) console.log("[cli-piped-stdout] node is not on PATH, skipping the node case");

const TARGETS = Array.from({ length: 1500 }, (_, i) => ({
  id: `PAGE${i}`.padEnd(32, "0"),
  type: "page",
  title: `${"t".repeat(100)}${i}`,
  url: `https://fake.test/${i}`,
}));

let fake: FakeCdpServer;
let base = "";
let dir = "";

/** Run `cmd` under sh with the fake endpoint, asynchronously so the in-process fake can answer. */
async function sh(cmd: string, timeoutMs = 30_000): Promise<{ code: number; stderr: string }> {
  const proc = Bun.spawn(["sh", "-c", cmd], {
    cwd: repoRoot,
    env: { ...process.env, CDP_BASE: base } as Record<string, string>,
    stdout: "ignore",
    stderr: "pipe",
  });
  const timer = setTimeout(() => proc.kill("SIGKILL"), timeoutMs);
  const stderr = await new Response(proc.stderr).text();
  const code = await proc.exited;
  clearTimeout(timer);
  return { code, stderr };
}

beforeAll(async () => {
  const fresh = existsSync(distCli) && statSync(distCli).mtimeMs >= statSync(srcCli).mtimeMs;
  if (!fresh) {
    console.log("[cli-piped-stdout] dist/cli.js missing or older than src/cli.ts, running `bun run build`");
    const built = spawnSync("bun", ["run", "build"], { cwd: repoRoot, timeout: 90_000, encoding: "utf8" });
    if (built.status !== 0 || !existsSync(distCli)) throw new Error(`build failed (exit ${built.status}):\n${built.stderr}`);
  }
  ({ fake, base } = await startFakeCdp({ targets: TARGETS }));
  dir = mkdtempSync(join(tmpdir(), "cdp-piped-"));
}, 120_000);

afterAll(async () => {
  await fake?.stop();
  if (dir) rmSync(dir, { recursive: true, force: true });
});

const CASES: Array<{ name: string; runtime: string; entry: () => string; skip?: boolean }> = [
  { name: "bun src/cli.ts", runtime: "bun", entry: () => srcCli },
  { name: "bun dist/cli.js", runtime: "bun", entry: () => distCli },
  { name: "node dist/cli.js", runtime: "node", entry: () => distCli, skip: !nodeAvailable },
];

describe("CLI stdout through a pipe (#23)", () => {
  for (const c of CASES) {
    test.skipIf(Boolean(c.skip))(`${c.name}: a ~400 KB result arrives whole through a pipe`, async () => {
      const tag = c.name.replace(/\W+/g, "-");
      const toFile = join(dir, `${tag}.file.json`);
      const piped = join(dir, `${tag}.piped.json`);
      const direct = await sh(`${c.runtime} '${c.entry()}' list_pages > '${toFile}'`);
      expect(direct.code).toBe(0);
      const viaPipe = await sh(`${c.runtime} '${c.entry()}' list_pages | cat > '${piped}'`);
      expect(viaPipe.code).toBe(0);

      const want = readFileSync(toFile);
      const got = readFileSync(piped);
      expect(want.length).toBeGreaterThan(256 * 1024); // past both the 64 KiB and 128 KiB cut-offs
      expect(got.length).toBe(want.length);
      expect(got.equals(want)).toBe(true);
      expect(() => JSON.parse(got.toString("utf8"))).not.toThrow();
    }, 60_000);

    test.skipIf(Boolean(c.skip))(`${c.name}: a reader that closes early ends the CLI promptly and quietly`, async () => {
      const started = Date.now();
      const res = await sh(`${c.runtime} '${c.entry()}' list_pages | head -c 10 > /dev/null`, 20_000);
      expect(res.code).toBe(0);
      expect(Date.now() - started).toBeLessThan(15_000);
      expect(res.stderr).toBe("");
    }, 30_000);
  }
});
