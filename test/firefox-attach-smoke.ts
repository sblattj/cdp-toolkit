/**
 * Firefox ATTACH-mode end-to-end smoke test for the WebDriver BiDi backend.
 *
 * The sibling test/firefox-smoke.ts proves the LAUNCH path, where the toolkit
 * spawns Firefox and owns its lifetime. This file proves the other mode, and the
 * only way to prove it honestly is to make the browser genuinely NOT ours: it
 * spawns Firefox itself with node:child_process — deliberately NOT via
 * src/bidi/launch.ts — on a freely-chosen ephemeral port with a throwaway
 * profile, exactly as a user would have started their own real logged-in Firefox
 * with --remote-debugging-port. Everything after the spawn is the REAL product
 * path: resolveFirefoxEndpoint() turns `--connect <port>` into a ws URL and
 * startFirefoxSession({ endpoint }) attaches over it.
 *
 * The load-bearing assertions are the two that no unit test can make:
 *   - dispose() leaves the externally-spawned Firefox process ALIVE. Attach mode
 *     does not own a process, and killing a user's real browser because a CLI
 *     invocation ended would be the worst bug this feature could have.
 *   - a SECOND attach cycle to the SAME Firefox succeeds. Firefox allows exactly
 *     one active BiDi session and closing the socket does NOT free the slot, so
 *     this passes only if dispose() actually sent session.end.
 *
 * Fixtures are served over real HTTP via Bun.serve. Never a data: URL: Firefox
 * blocks top-level data: navigation by policy ("Navigation to data:... is not
 * allowed in this context"), so a data: fixture would fail for a reason that has
 * nothing to do with what is under test. Never file://, and never a fixed debug
 * port — 9222 belongs to whatever Chrome the developer has running.
 *
 * Exits non-zero on any failed assertion. The spawned Firefox is SIGKILLed and
 * the temp profile removed in a `finally`, and a hard wall-clock cap does the
 * same and exits non-zero if something hangs, so this can never leak a browser
 * process or wedge CI. Run with `bun run firefox:attach:smoke`.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createConnection, createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveBackend, resolveFirefoxEndpoint, startFirefoxSession, type FirefoxSession } from "../src/backend.ts";

// Minimal ambient shape for the bit of the Bun global this file uses. Same
// reasoning as test/firefox-smoke.ts's header: no bun-types devDep (CONTRACT.md
// forbids adding one for a devDep-only need); this is the runtime-provided
// global under `tsc --noEmit`'s "node" + "DOM" libs.
declare const Bun: {
  serve(opts: {
    port: number;
    hostname: string;
    fetch(req: Request): Response | Promise<Response>;
  }): { port: number; stop(closeActiveConnections?: boolean): void };
};

const HERE = fileURLToPath(new URL(".", import.meta.url));
const FIXTURES_DIR = join(HERE, "fixtures");
const WALL_CLOCK_MS = 120_000;
const EXPECTED_TITLE = "form fixture"; // test/fixtures/form.html's <title>

type Check = { name: string; ok: boolean; detail: string };
const checks: Check[] = [];
function record(name: string, ok: boolean, detail: string): void {
  checks.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"} ${name}: ${detail}`);
}

/** Same candidate ladder as src/bidi/launch.ts's resolveBinary, kept local because this file must
 *  NOT go through the launcher — going through it is precisely what attach mode does not do. */
function resolveFirefoxBinary(): string {
  const fromEnv = process.env.FIREFOX_BIN;
  if (fromEnv) return fromEnv;
  const mac = "/Applications/Firefox.app/Contents/MacOS/firefox";
  if (existsSync(mac)) return mac;
  return "firefox"; // PATH
}

/** Bind an OS-assigned ephemeral port, read it, release it — launch.ts's pickPort, minus the
 *  explicit-port branch this file never needs. A fixed port would collide with a developer's own
 *  browser or with a concurrent run of this very test. */
function pickFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const addr = probe.address();
      if (addr === null || typeof addr === "string") {
        probe.close();
        reject(new Error("failed to allocate a port"));
        return;
      }
      const { port } = addr;
      probe.close(() => resolve(port));
    });
  });
}

/** Wait until the debug port actually accepts a TCP connection. Never a fixed sleep. */
function pollPort(port: number, deadlineMs: number): Promise<void> {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const attempt = (): void => {
      const sock = createConnection({ port, host: "127.0.0.1" });
      sock.once("connect", () => {
        sock.destroy();
        resolve();
      });
      sock.once("error", () => {
        sock.destroy();
        if (Date.now() - start >= deadlineMs) {
          reject(new Error(`spawned Firefox's debug port ${port} did not accept a connection within ${deadlineMs}ms`));
          return;
        }
        setTimeout(attempt, 100);
      });
    };
    attempt();
  });
}

/** Existence check on a pid: signal 0 sends nothing, it only asks the kernel whether the process is
 *  still there. This is how "attach dispose did NOT kill the user's browser" is observed. */
function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false; // ESRCH
  }
}

let firefox: ChildProcess | undefined;
let firefoxPid: number | undefined;
let profilePath: string | undefined;

const hardTimer: ReturnType<typeof setTimeout> = setTimeout(() => {
  console.error(`FAIL wall-clock cap: did not finish within ${WALL_CLOCK_MS}ms, killing Firefox and exiting`);
  if (firefoxPid !== undefined) {
    try {
      process.kill(firefoxPid, "SIGKILL");
    } catch {
      /* already gone */
    }
  }
  if (profilePath !== undefined) rmSync(profilePath, { recursive: true, force: true });
  process.exit(1);
}, WALL_CLOCK_MS);

// Serve the fixtures directory over HTTP on an ephemeral port. No file://, no data:.
const server = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  fetch(req) {
    const url = new URL(req.url);
    const name = url.pathname.replace(/^\//, "") || "form.html";
    if (!/^[a-zA-Z0-9_-]+\.html$/.test(name)) return new Response("not found", { status: 404 });
    try {
      const body = readFileSync(join(FIXTURES_DIR, name));
      return new Response(body, { headers: { "content-type": "text/html; charset=utf-8" } });
    } catch {
      return new Response("not found", { status: 404 });
    }
  },
});
const BASE_URL = `http://127.0.0.1:${server.port}`;

let session: FirefoxSession | undefined;
let secondSession: FirefoxSession | undefined;

try {
  // --- 0. stand up "the user's already-running Firefox", NOT via launchFirefox ---
  const port = await pickFreePort();
  profilePath = mkdtempSync(join(tmpdir(), "cdp-toolkit-ff-attach-profile-"));
  const binary = resolveFirefoxBinary();
  firefox = spawn(
    binary,
    ["--profile", profilePath, "--remote-debugging-port", String(port), "--no-remote", "--headless"],
    { stdio: "ignore", detached: false },
  );
  firefoxPid = firefox.pid;
  if (firefoxPid === undefined) throw new Error(`failed to spawn Firefox binary at ${binary}`);
  await pollPort(port, 30_000);

  // --- 1. the endpoint resolves and the attach establishes a real session ---
  // This is the product's own resolver, driven by the flag a user would type. It intentionally reads
  // the default process.env: the flag beats the env var, so an ambient CDP_FIREFOX_ENDPOINT cannot
  // redirect this at the machine we are testing on.
  const endpoint = resolveFirefoxEndpoint(["--connect", String(port)])!;
  session = await startFirefoxSession({ endpoint });
  const pages = await session.driver.listPages();
  record(
    "attach to a Firefox this toolkit did NOT launch establishes a BiDi session and lists pages",
    endpoint === `ws://127.0.0.1:${port}/session` && pages.length > 0,
    `endpoint=${endpoint} pid=${firefoxPid} pages=${pages.length}`,
  );

  // --- 2. the attached session can actually read a page (real HTTP, never data:) ---
  const page = await session.driver.page(undefined);
  const nav = await page.navigate({ url: `${BASE_URL}/form.html` });
  const title = await page.evaluate("document.title");
  record(
    "the attached session navigates and reads the page over the wire",
    nav.url.includes("form.html") && title === EXPECTED_TITLE,
    `url=${nav.url} document.title=${JSON.stringify(title)}`,
  );
  await page.release();

  // --- 3. dispose() must NOT kill the user's browser ---
  // The safety invariant of the whole feature. Launch mode's dispose kills the process it started;
  // attach mode's must only end the BiDi session and close the socket.
  await session.dispose();
  const aliveAfterDispose = pidAlive(firefoxPid) && firefox.exitCode === null && firefox.signalCode === null;
  record(
    "dispose() in attach mode leaves the externally-spawned Firefox process ALIVE",
    aliveAfterDispose,
    `pid=${firefoxPid} alive=${pidAlive(firefoxPid)} exitCode=${String(firefox.exitCode)} signal=${String(firefox.signalCode)}`,
  );

  // --- 4. a SECOND attach cycle to the SAME Firefox succeeds ---
  // Firefox permits exactly ONE active BiDi session and does not free the slot when the socket
  // closes, so this is the only observation that proves dispose() sent session.end. Without it the
  // second session.new fails with "Maximum number of active sessions" — which is why this assertion,
  // not a code read, is the evidence for that line in driver.dispose().
  secondSession = await startFirefoxSession({ endpoint });
  const page2 = await secondSession.driver.page(undefined);
  await page2.navigate({ url: `${BASE_URL}/form.html` });
  const title2 = await page2.evaluate("document.title");
  await page2.release();
  record(
    "a SECOND attach cycle to the same Firefox succeeds (dispose freed the single session slot)",
    title2 === EXPECTED_TITLE,
    `document.title=${JSON.stringify(title2)} on the re-attached session`,
  );

  await secondSession.dispose();
  secondSession = undefined;
  record(
    "and the browser is STILL alive after the second dispose",
    pidAlive(firefoxPid) && firefox.exitCode === null && firefox.signalCode === null,
    `pid=${firefoxPid} exitCode=${String(firefox.exitCode)} signal=${String(firefox.signalCode)}`,
  );

  // --- 5. an endpoint auto-implies the firefox backend ---
  // Asserted with an EXPLICIT empty env so the verdict cannot flip on whether this machine exports
  // CDP_BROWSER; the endpoint-implies-firefox rule is what is under test, not the local shell.
  const selection = resolveBackend(["--connect", String(port)], {});
  record(
    "resolveBackend: an endpoint implies the firefox backend and carries the ws url",
    selection.kind === "firefox" && selection.endpoint === `ws://127.0.0.1:${port}/session`,
    `kind=${selection.kind} endpoint=${String(selection.endpoint)}`,
  );
} catch (err) {
  record("FATAL", false, err instanceof Error ? (err.stack ?? err.message) : String(err));
} finally {
  clearTimeout(hardTimer);

  // Best-effort protocol-level teardown first, so a mid-test throw does not leave Firefox's single
  // session slot occupied for the next run of this file.
  for (const s of [session, secondSession]) {
    try {
      if (s) await s.dispose();
    } catch {
      /* best effort */
    }
  }

  // WE spawned this Firefox, so WE kill it — the product code deliberately does not. SIGKILL rather
  // than SIGTERM: nothing here needs a graceful browser shutdown, and a leaked headless Firefox
  // holding a debug port would poison every later run.
  if (firefoxPid !== undefined) {
    try {
      process.kill(firefoxPid, "SIGKILL");
    } catch {
      /* already gone */
    }
  }
  if (profilePath !== undefined) rmSync(profilePath, { recursive: true, force: true });
  server.stop(true);
}

const failed = checks.filter((c) => !c.ok);
console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`);
if (failed.length) {
  console.error(`FAILED: ${failed.map((c) => c.name).join(", ")}`);
  process.exit(1);
}
console.log("FIREFOX ATTACH SMOKE OK");
process.exit(0);
