/**
 * Firefox launcher for the WebDriver BiDi backend.
 *
 * What THIS module does: it owns full process lifetime for the Firefox instances it starts —
 * launches the binary, holds its pid, and reaps it. That is required because there is no live
 * handoff for the debug port: you cannot RELAUNCH an already-running Firefox with
 * --remote-debugging-port and have it take effect — the relaunch hands off to the running
 * instance and exits silently, opening no port. The flag only takes effect on the ORIGINAL
 * launch of a process, which is why this launcher must be the one to start it. Do not
 * "simplify" this into a relaunch-to-open-a-port helper; that shape cannot work on Firefox and
 * was verified against Firefox 153.0.3.
 *
 * What this does NOT mean: that Firefox "cannot be attached to" at all. A Firefox that was
 * ORIGINALLY launched with --remote-debugging-port — by this module, or by hand by the user —
 * exposes a plain BiDi ws endpoint that a fresh client CAN connect to later, any number of
 * times. That attach path is real, supported, and separate from this file: see backend.ts's
 * `startFirefoxSession({ endpoint })` and `createFirefoxDriverForEndpoint` (bidi/driver.ts),
 * which is exactly how cdp-toolkit connects to a user-launched Firefox to see their real
 * logged-in profile instead of a throwaway one.
 *
 * Zero runtime dependencies: only node:child_process, node:fs, node:net,
 * node:os and node:path.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createConnection, createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface LaunchFirefoxOptions {
  /**
   * Explicit debug port. Otherwise a genuinely free ephemeral port is picked.
   * 9222 is the conventional CDP debug port; nothing here defaults to it or
   * treats it specially. If the requested port is already bound, launch
   * fails with a clear "already in use" error rather than silently reusing
   * whatever is listening there.
   */
  port?: number;
  /** Explicit profile directory. Otherwise a fresh throwaway profile is created and deleted on close(). */
  profilePath?: string;
  /** Launch headless. Default false. */
  headless?: boolean;
  /** How long to wait for the debug port to accept a connection, in ms. Default 15000. */
  timeoutMs?: number;
}

export interface LaunchedFirefox {
  port: number;
  pid: number;
  profilePath: string;
  close(): Promise<void>;
}

function resolveBinary(): string {
  const candidates = [
    process.env.FIREFOX_BIN,
    "/Applications/Firefox.app/Contents/MacOS/firefox",
    "firefox",
  ];
  for (const c of candidates) {
    if (!c) continue;
    // An ABSOLUTE candidate (FIREFOX_BIN, the macOS app path) is only usable if it exists on this
    // box — otherwise the hardcoded macOS path would win on Linux and shadow the "firefox" PATH
    // fallback, yielding ENOENT at spawn. A bare name like "firefox" is not a filesystem path, so
    // let spawn resolve it against PATH.
    const isAbsolute = c.startsWith("/");
    if (isAbsolute && !existsSync(c)) continue;
    return c;
  }
  throw new Error(
    "Firefox binary not found. Tried FIREFOX_BIN env var, " +
      "/Applications/Firefox.app/Contents/MacOS/firefox, and 'firefox' on PATH.",
  );
}

/**
 * Bind the requested port (0 = OS-assigned ephemeral), read it, release it.
 * Small TOCTOU window between release and Firefox's own bind is acceptable
 * for a test launcher. When a specific port is requested and it is already
 * bound, this surfaces that as a clear "already in use" error instead of
 * silently falling back to something else.
 */
function pickPort(requested: number | undefined): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", (err: NodeJS.ErrnoException) => {
      if (requested !== undefined && err.code === "EADDRINUSE") {
        reject(new Error(`port ${requested} is already in use`));
        return;
      }
      reject(err);
    });
    server.listen(requested ?? 0, "127.0.0.1", () => {
      const addr = server.address();
      if (addr === null || typeof addr === "string") {
        server.close();
        reject(new Error("failed to allocate a port"));
        return;
      }
      const { port } = addr;
      server.close(() => resolve(port));
    });
  });
}

function pollPort(port: number, deadlineMs: number): Promise<void> {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const attempt = () => {
      const sock = createConnection({ port, host: "127.0.0.1" });
      const onFail = () => {
        sock.destroy();
        if (Date.now() - start >= deadlineMs) {
          reject(
            new Error(
              `Firefox debug port ${port} did not accept a connection within ${deadlineMs}ms`,
            ),
          );
          return;
        }
        setTimeout(attempt, 100);
      };
      sock.once("connect", () => {
        sock.destroy();
        resolve();
      });
      sock.once("error", onFail);
    };
    attempt();
  });
}

/** Wait for the child process to actually exit, not merely for kill() to return. */
function waitForExit(proc: ChildProcess, deadlineMs: number): Promise<void> {
  return new Promise((resolve) => {
    if (proc.exitCode !== null || proc.signalCode !== null) {
      resolve();
      return;
    }
    const timer = setTimeout(() => resolve(), deadlineMs);
    proc.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

/**
 * Automation prefs seeded into every THROWAWAY profile this toolkit launches (#6).
 *
 * Firefox's Remote Agent has its own recommended automation-pref bundle, but it is gated on
 * `remote.prefs.recommended`, which DEFAULTS TO FALSE — a bare `--remote-debugging-port`
 * launch therefore runs with consumer prefs (verified in mozilla-central's
 * remote/shared/RecommendedPreferences.sys.mjs; `defineLazyPreferenceGetter(..., "remote.prefs.recommended", false)`).
 * The two file://-relevant consequences, and the reason each pref is here:
 *
 * - `remote.prefs.recommended: true` — flips on Firefox's own bundle at BiDi session start. This
 *   is the same mechanism geckodriver/Marionette automation leans on.
 * - `security.fileuri.strict_origin_policy: false` — a member of that bundle, also set explicitly
 *   so the behavior does not depend on the bundle's exact contents per Firefox version. Without
 *   it, file:// documents get unique opaque origins and sibling file:// subresources fail.
 * - `dom.file.createInChild: true` — the bundle's file-API automation companion pref.
 *
 * Only the throwaway profile is seeded. An explicit `profilePath` belongs to its owner: writing
 * prefs into someone's real profile (where `security.fileuri.strict_origin_policy: false` would
 * persist as a security relaxation of their daily browsing) is not this toolkit's call to make.
 */
const LAUNCH_USER_JS_PREFS: Record<string, boolean> = {
  "remote.prefs.recommended": true,
  "security.fileuri.strict_origin_policy": false,
  "dom.file.createInChild": true,
};

/**
 * Seed `user.js` in a profile directory with the toolkit's automation prefs. Firefox reads
 * user.js exactly once, at profile startup — which is why this runs BEFORE spawn, never after.
 * Merges with an existing user.js (never rewrites a pref that file already sets, never drops a
 * line it did not write) so the function is idempotent and safe on a reused profile dir.
 * Exported for unit tests; returns the file's final content.
 */
export function writeLaunchUserJs(profilePath: string): string {
  const target = join(profilePath, "user.js");
  const existing = existsSync(target) ? readFileSync(target, "utf8") : "";
  const present = new Set<string>();
  for (const line of existing.split("\n")) {
    const m = /^user_pref\("([^"]+)"\s*,/.exec(line.trim());
    if (m) present.add(m[1]!);
  }
  const additions = Object.entries(LAUNCH_USER_JS_PREFS)
    .filter(([k]) => !present.has(k))
    .map(([k, v]) => `user_pref("${k}", ${JSON.stringify(v)});`);
  const content = (existing.length > 0 ? existing.replace(/\n*$/, "\n") : "") + additions.join("\n") + (additions.length > 0 ? "\n" : "");
  if (content !== existing) writeFileSync(target, content, "utf-8");
  return content;
}

/**
 * Launch Firefox with the BiDi debug port enabled and resolve once the port
 * actually accepts a TCP connection. Never resolves on a fixed sleep.
 */
export async function launchFirefox(opts: LaunchFirefoxOptions = {}): Promise<LaunchedFirefox> {
  const binary = resolveBinary();

  const port = await pickPort(opts.port);

  const isThrowaway = opts.profilePath === undefined;
  const profilePath = opts.profilePath ?? mkdtempSync(join(tmpdir(), "cdp-toolkit-ff-profile-"));
  if (isThrowaway) writeLaunchUserJs(profilePath);

  const args = ["--profile", profilePath, "--remote-debugging-port", String(port), "--no-remote"];
  if (opts.headless) args.push("--headless");

  const proc = spawn(binary, args, { stdio: "ignore", detached: false });

  let closed = false;
  const close = async (): Promise<void> => {
    if (closed) return;
    closed = true;
    if (proc.exitCode === null && proc.signalCode === null) {
      proc.kill("SIGTERM");
      await waitForExit(proc, 5000);
      if (proc.exitCode === null && proc.signalCode === null) {
        proc.kill("SIGKILL");
        await waitForExit(proc, 5000);
      }
    }
    if (isThrowaway) {
      rmSync(profilePath, { recursive: true, force: true });
    }
  };

  const pid = proc.pid;
  if (pid === undefined) {
    await close();
    throw new Error(`failed to spawn Firefox binary at ${binary}`);
  }

  const timeoutMs = opts.timeoutMs ?? 15_000;
  try {
    await pollPort(port, timeoutMs);
  } catch (err) {
    await close();
    throw err;
  }

  return { port, pid, profilePath, close };
}

/*
 * CDP methods/domains used: none, this module speaks no browser protocol,
 * it only launches the process and confirms the debug port is listening.
 * This launcher itself has no attach story — it only ever starts fresh processes — but that is
 * a scope limit of THIS FILE, not a Firefox limit: see backend.ts's `startFirefoxSession({
 * endpoint })` / `createFirefoxDriverForEndpoint` (bidi/driver.ts) for the supported attach path,
 * which connects to the ws endpoint of a Firefox that was launched (by this module or by hand)
 * with --remote-debugging-port. Still unsupported, and unsupportable on Firefox, is relaunching
 * the binary against an already-running instance to open a port after the fact (header above) —
 * that is a different operation from attaching to a port that is already open.
 */
