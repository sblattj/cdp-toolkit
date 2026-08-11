/**
 * Backend selection + Firefox process/driver lifetime, shared by cli.ts and mcp.ts.
 *
 * Selection precedence: explicit `--browser chrome|firefox` flag, else the
 * `CDP_BROWSER` env var, else "chrome". Defaulting to chrome is REQUIRED: this
 * ships to npm and today's users must see zero behavior change unless they
 * opt in.
 *
 * Firefox runs in one of TWO modes, and the difference between them is process
 * ownership:
 *   - LAUNCH (default): this module spawns a throwaway-profile Firefox and OWNS
 *     it. dispose() closes the BiDi session THEN kills the spawned binary, in
 *     that order, so no invocation can leak a process.
 *   - ATTACH (`--connect` / CDP_FIREFOX_ENDPOINT): the user already started
 *     Firefox with --remote-debugging-port, so it carries their real logged-in
 *     profile and we merely connect to its BiDi endpoint. NOTHING on this path
 *     owns a process: dispose() ends the BiDi session (freeing Firefox's single
 *     session slot) and closes the socket, and MUST NEVER kill the browser.
 *     What is impossible is RELAUNCHING the binary to open a debug port on an
 *     already-running instance (bidi/launch.ts's header), not attaching to a
 *     port that is already open.
 * The Firefox driver is `lifetime: "session"` (ADR-001), so session ownership
 * also differs by entry point:
 *   - CLI: one process per invocation. startFirefoxSession() launches or
 *     attaches, the caller runs exactly one tool call, then
 *     disposeFirefoxSession() tears the session (and, in launch mode only, the
 *     spawned process) down before the process exits.
 *   - MCP: long-lived. getOrCreateFirefoxSession() launches/attaches at most
 *     once and memoizes the session at module scope; disposeFirefoxSession()
 *     runs on shutdown (SIGINT/SIGTERM/stdin close), never per tool call.
 * Both paths funnel through the same FirefoxSession, whose dispose() is
 * idempotent in either mode.
 */
import type { BrowserDriver, DriverKind } from "./driver.ts";
import { createFirefoxDriver, createFirefoxDriverForEndpoint } from "./bidi/driver.ts";
import { launchFirefox } from "./bidi/launch.ts";

/** Resolve the selected backend from argv (already flag-scanned) + env, defaulting to chrome.
 *  `env` is injectable ONLY so a test (and resolveBackend, which must read one consistent env)
 *  can pass a fixed object; every caller that omits it gets exactly today's process.env read. */
export function resolveBrowserKind(argv: readonly string[], env: NodeJS.ProcessEnv = process.env): DriverKind {
  const flagIdx = argv.indexOf("--browser");
  const flagVal = flagIdx !== -1 ? argv[flagIdx + 1] : undefined;
  const raw = flagVal ?? env.CDP_BROWSER ?? "chrome";
  if (raw !== "chrome" && raw !== "firefox") {
    throw new Error(`unknown --browser '${raw}': expected 'chrome' or 'firefox' (or set CDP_BROWSER)`);
  }
  return raw;
}

/** Strip a `--browser <value>` pair out of argv so it never reaches tool-arg parsing. */
export function stripBrowserFlag(argv: readonly string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--browser") { i++; continue; }
    out.push(argv[i]!);
  }
  return out;
}

/* ------------------------------- Firefox attach endpoint ------------------------------- */

/**
 * Normalize the three accepted spellings of a Firefox attach endpoint into the one thing the
 * transport takes, a ws URL:
 *   `9223`                          -> ws://127.0.0.1:9223/session
 *   `127.0.0.1:9223`                -> ws://127.0.0.1:9223/session
 *   `ws://host:9223/session`        -> verbatim (also wss://, also a non-default path)
 * The bare-port and host:port spellings exist because they are what the user typed into Firefox's
 * own `--remote-debugging-port`; the ws URL exists because BiDi's endpoint is not discoverable over
 * HTTP the way CDP's is (bidi/client.ts's footer), so a non-loopback or proxied setup has no other
 * way to say where the socket is. Throws with the accepted spellings on anything else, rather than
 * handing the transport a URL that will fail later as an opaque connect timeout.
 */
export function normalizeBidiEndpoint(raw: string): string {
  const value = raw.trim();
  if (/^wss?:\/\//i.test(value)) {
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      throw new Error(`invalid Firefox endpoint '${raw}': not a parseable ws:// URL`);
    }
    // Firefox serves BiDi at /session; a user who pasted just the origin means that path, and
    // silently connecting to "/" would fail as a bare handshake error with no hint why.
    if (url.pathname === "" || url.pathname === "/") url.pathname = "/session";
    return url.toString();
  }
  if (/^\d+$/.test(value)) return `ws://127.0.0.1:${assertPort(value, raw)}/session`;
  const hostPort = /^([^:/]+):(\d+)$/.exec(value);
  if (hostPort) return `ws://${hostPort[1]}:${assertPort(hostPort[2]!, raw)}/session`;
  throw new Error(`invalid Firefox endpoint '${raw}': expected a port (9223), host:port, or a ws:// URL`);
}

/** Port validation shared by the bare-port and host:port spellings. Rejects 0 as well as >65535:
 *  0 means "pick any free port" to a listener and nothing at all to a client dialing out. */
function assertPort(digits: string, raw: string): number {
  const port = Number(digits);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`invalid Firefox endpoint '${raw}': port must be 1-65535`);
  }
  return port;
}

/**
 * Resolve the attach endpoint, or undefined for launch mode. Flag beats env, mirroring
 * resolveBrowserKind's precedence: `--connect <port|host:port|ws-url>` then CDP_FIREFOX_ENDPOINT.
 * An empty value counts as unset so an exported-but-blank env var does not force attach mode.
 */
export function resolveFirefoxEndpoint(argv: readonly string[], env: NodeJS.ProcessEnv = process.env): string | undefined {
  const flagIdx = argv.indexOf("--connect");
  const raw = (flagIdx !== -1 ? argv[flagIdx + 1] : undefined) ?? env.CDP_FIREFOX_ENDPOINT;
  if (raw === undefined || raw === "") return undefined;
  return normalizeBidiEndpoint(raw);
}

/** Strip a `--connect <value>` pair out of argv so it never reaches tool-arg parsing, exactly as
 *  stripBrowserFlag does for --browser. */
export function stripConnectFlag(argv: readonly string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--connect") { i++; continue; }
    out.push(argv[i]!);
  }
  return out;
}

/** What one entry point needs to know about the backend: which driver, and (Firefox only) whether
 *  to attach to an existing endpoint instead of launching. */
export interface BackendSelection {
  kind: DriverKind;
  endpoint?: string;
}

/**
 * The single backend-selection entry point for cli.ts and mcp.ts: kind + optional attach endpoint.
 *
 * An endpoint IMPLIES Firefox, because there is nothing else it could mean — CDP has no such
 * option here (Chrome's attach is its own --remote-debugging-port convention on the CDP client) and
 * a user who passes one has already told us which browser they started. The one case that must
 * fail loudly rather than be silently overridden is an EXPLICIT `--browser chrome`/CDP_BROWSER=chrome
 * alongside an endpoint: honoring either half of that would silently ignore the other.
 */
export function resolveBackend(argv: readonly string[], env: NodeJS.ProcessEnv = process.env): BackendSelection {
  const endpoint = resolveFirefoxEndpoint(argv, env);
  let kind = resolveBrowserKind(argv, env);
  const explicitBrowser = argv.includes("--browser") || env.CDP_BROWSER !== undefined;
  if (endpoint !== undefined) {
    if (explicitBrowser && kind === "chrome") {
      throw new Error("--connect / CDP_FIREFOX_ENDPOINT is a Firefox attach option and is not valid with the chrome backend");
    }
    kind = "firefox";
  }
  return endpoint !== undefined ? { kind, endpoint } : { kind };
}

export interface FirefoxSession {
  driver: BrowserDriver;
  dispose(): Promise<void>;
}

/**
 * Start a Firefox session and construct its Driver. Caller owns dispose().
 * With `endpoint`, ATTACHES to the user's already-running Firefox; without it, LAUNCHES a fresh
 * throwaway-profile one. The two dispose() bodies differ in exactly one way, and it is the safety
 * invariant of this whole feature: only the launch path closes a process.
 */
export async function startFirefoxSession(opts?: { headless?: boolean; endpoint?: string }): Promise<FirefoxSession> {
  if (opts?.endpoint !== undefined) {
    const driver = createFirefoxDriverForEndpoint(opts.endpoint);
    let disposed = false;
    return {
      driver,
      async dispose(): Promise<void> {
        if (disposed) return;
        disposed = true;
        // The ONLY teardown in attach mode. driver.dispose() sends session.end (so Firefox frees
        // its single session slot for the next attach) and closes the socket. There is deliberately
        // no process close here: we did not start this browser, and killing a user's real
        // logged-in Firefox because a CLI invocation ended would be unforgivable.
        await driver.dispose().catch(() => undefined);
      },
    };
  }
  const launched = await launchFirefox({ headless: opts?.headless });
  const driver = createFirefoxDriver(launched.port);
  let disposed = false;
  return {
    driver,
    async dispose(): Promise<void> {
      if (disposed) return;
      disposed = true;
      // Close the BiDi session before killing the process: dispose() is a clean
      // protocol-level teardown, close() is the fallback that guarantees no
      // process survives even if the session was already dead.
      await driver.dispose().catch(() => undefined);
      await launched.close();
    },
  };
}

/* -------------------------- MCP-only: one memoized session -------------------------- */

let sessionPromise: Promise<FirefoxSession> | undefined;

/** Lazily start the Firefox session at most once per server process; every caller shares it.
 *  `endpoint` is read only on the first call, which is correct: the backend selection is fixed at
 *  server startup (mcp.ts resolves it from argv/env once), never per tool call. */
export function getOrCreateFirefoxSession(opts?: { endpoint?: string }): Promise<FirefoxSession> {
  if (!sessionPromise) sessionPromise = startFirefoxSession({ endpoint: opts?.endpoint });
  return sessionPromise;
}

/** Idempotent shutdown hook: no-op if no Firefox session was ever started this process. Covers both
 *  modes — in attach mode it ends the BiDi session without touching the user's browser process. */
export async function disposeFirefoxSession(): Promise<void> {
  if (!sessionPromise) return;
  const p = sessionPromise;
  sessionPromise = undefined;
  await p.then((s) => s.dispose()).catch(() => undefined);
}
