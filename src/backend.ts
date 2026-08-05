/**
 * Backend selection + Firefox process/driver lifetime, shared by cli.ts and mcp.ts.
 *
 * Selection precedence: explicit `--browser chrome|firefox` flag, else the
 * `CDP_BROWSER` env var, else "chrome". Defaulting to chrome is REQUIRED: this
 * ships to npm and today's users must see zero behavior change unless they
 * opt in.
 *
 * Firefox cannot be attached to (see bidi/launch.ts's header) and its driver
 * is `lifetime: "session"` (ADR-001), so ownership differs by entry point:
 *   - CLI: one process per invocation. startFirefoxSession() launches, the
 *     caller runs exactly one tool call, then disposeFirefoxSession() tears
 *     the session AND the spawned process down before the process exits.
 *   - MCP: long-lived. getOrCreateFirefoxSession() launches at most once and
 *     memoizes the session at module scope; disposeFirefoxSession() runs on
 *     shutdown (SIGINT/SIGTERM/stdin close), never per tool call.
 * Both paths funnel through the same FirefoxSession so neither can leak a
 * Firefox process: dispose() always closes the BiDi session THEN kills the
 * spawned binary, in that order, and is idempotent.
 */
import type { BrowserDriver, DriverKind } from "./driver.ts";
import { createFirefoxDriver } from "./bidi/driver.ts";
import { launchFirefox } from "./bidi/launch.ts";

/** Resolve the selected backend from argv (already flag-scanned) + env, defaulting to chrome. */
export function resolveBrowserKind(argv: readonly string[]): DriverKind {
  const flagIdx = argv.indexOf("--browser");
  const flagVal = flagIdx !== -1 ? argv[flagIdx + 1] : undefined;
  const raw = flagVal ?? process.env.CDP_BROWSER ?? "chrome";
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

export interface FirefoxSession {
  driver: BrowserDriver;
  dispose(): Promise<void>;
}

/** Launch a fresh Firefox process and construct its Driver. Caller owns dispose(). */
export async function startFirefoxSession(opts?: { headless?: boolean }): Promise<FirefoxSession> {
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

/** Lazily launch Firefox at most once per server process; every caller shares it. */
export function getOrCreateFirefoxSession(): Promise<FirefoxSession> {
  if (!sessionPromise) sessionPromise = startFirefoxSession();
  return sessionPromise;
}

/** Idempotent shutdown hook: no-op if Firefox was never launched this process. */
export async function disposeFirefoxSession(): Promise<void> {
  if (!sessionPromise) return;
  const p = sessionPromise;
  sessionPromise = undefined;
  await p.then((s) => s.dispose()).catch(() => undefined);
}
