/**
 * Where the DevTools endpoint is, and which of its two transports this Chrome
 * actually serves.
 *
 * THE FACT THIS MODULE EXISTS FOR. Chrome has always had two ways in, and
 * until recently every build served both:
 *
 *   A. the HTTP discovery endpoints — `/json/version`, `/json/list` — plus a
 *      per-target socket at `/devtools/page/<targetId>`;
 *   B. one browser-level socket at `/devtools/browser/<uuid>`, over which
 *      `Target.getTargets` lists and `Target.attachToTarget` reaches a page.
 *
 * A Chrome started with `--remote-debugging-port` serves both. A Chrome that
 * had debugging turned on at RUNTIME, through the toggle on
 * `chrome://inspect/#remote-debugging`, serves only (B) — measured on Chrome
 * 153 (the same handshake on a `--remote-debugging-port` instance returns 101
 * for all three):
 *
 *   ws://127.0.0.1:<port>/devtools/browser/<uuid>   -> HTTP 101
 *   ws://127.0.0.1:<port>/devtools/page/<targetId>  -> HTTP 403
 *   http://127.0.0.1:<port>/json/version, /json/list -> HTTP 404
 *
 * That is not a degraded mode to work around, it is the transport a user gets
 * when they attach to the browser they were already using rather than
 * relaunching it. Everything the toolkit needs is reachable over (B).
 *
 * WHY DETECTED AND NOT CONFIGURED. Making the user declare the transport would
 * make them diagnose a 404 first. The detection is cached per process.
 *
 * WHY THE FALLBACK IS DRIVEN BY A FAILED OPERATION, not by a probe that runs
 * first. `listTargets` still issues its original `/json/list` request before
 * anything here is consulted, and only a request that did NOT answer reaches
 * the fallback. So on a Chrome that serves (A) the code path is the one that
 * shipped, byte for byte, and the new transport cannot regress it — there is
 * no added round-trip, no added failure mode, and no ordering question. The
 * cost of (B) is one 404 on the first listing, then the decision is cached.
 *
 * WHY THE PORT FILE. The browser socket's URL contains a uuid that is minted
 * fresh on every Chrome start, so it cannot be written into a config once. The
 * uuid and the port are the two lines of `DevToolsActivePort` in the profile
 * directory, which is where `/json/version` would otherwise have supplied it.
 * Resolved at connect time for that reason, never memoized across a restart.
 */
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

/** Base HTTP origin of the DevTools endpoint. Override with CDP_BASE. */
export const BASE = process.env.CDP_BASE ?? "http://127.0.0.1:9222";

/**
 * Which transport this endpoint serves.
 *   "http"       — `/json/*` answers; per-target sockets exist. The original path.
 *   "browser-ws" — only the browser socket answers; pages are reached by session.
 */
export type CdpTransport = "http" | "browser-ws";

export interface EndpointInfo {
  transport: CdpTransport;
  /** The browser-level WebSocket URL. Always present: both transports have one. */
  browserWsUrl: string;
}

/**
 * The browser socket URL from a profile's `DevToolsActivePort`.
 *
 * The file is exactly two lines — port, then the path component including the
 * uuid — and Chrome rewrites it on every start. A profile that is not running
 * leaves a STALE file behind rather than deleting it, so a URL from here is a
 * candidate to be handshaked, never a fact; `detectEndpoint` treats a failed
 * connect as "not this profile" and moves on.
 */
async function browserWsFromPortFile(dir: string): Promise<string | undefined> {
  const raw = await readFile(join(dir, "DevToolsActivePort"), "utf8").catch(() => undefined);
  if (!raw) return undefined;
  const [port, path] = raw.split("\n");
  if (!port?.trim() || !path?.trim()) return undefined;
  const host = new URL(BASE).hostname;
  return `ws://${host}:${port.trim()}${path.trim()}`;
}

/**
 * The browser socket for an explicitly named profile, and ONLY an explicitly
 * named one.
 *
 * NEVER SCANS THE DEFAULT PROFILE, and that restraint is the point rather than
 * an omission. Connecting to a DevTools endpoint is not a neutral act: a Chrome
 * with runtime debugging enabled raises a modal "Allow remote debugging?"
 * consent prompt on the user's screen for each new client, and that prompt
 * grants full access to a logged-in browsing session. A library that guesses
 * its way to a browser nobody named would raise that prompt from a unit-test
 * run — which is exactly how this restriction was found, by doing it.
 *
 * So the profile is opt-in: `CDP_USER_DATA_DIR` names it, or nothing is tried.
 * Pointing this toolkit at a browser stays a decision the user makes.
 */
async function discoverBrowserWs(): Promise<string | undefined> {
  const dir = process.env.CDP_USER_DATA_DIR;
  return dir ? browserWsFromPortFile(dir) : undefined;
}

/**
 * A bounded WebSocket handshake. The port file can name a Chrome that exited,
 * and a dead port would otherwise stall the whole detection on a connect that
 * never resolves.
 */
function handshake(url: string, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    const done = (ok: boolean) => {
      if (settled) return;
      settled = true;
      try {
        ws.close();
      } catch {
        /* ignore */
      }
      resolve(ok);
    };
    const ws = new WebSocket(url);
    ws.onopen = () => done(true);
    ws.onerror = () => done(false);
    setTimeout(() => done(false), timeoutMs);
  });
}

let cached: Promise<EndpointInfo> | undefined;

/**
 * Locate the browser socket for an endpoint that serves no `/json`.
 *
 * Called only after an HTTP request has already failed, so it never runs at all
 * against a Chrome started with `--remote-debugging-port`. `CDP_BROWSER_WS`
 * short-circuits the profile lookup, for an endpoint the port file cannot name
 * (a container, a forwarded port, a profile outside the defaults).
 */
export function detectEndpoint(): Promise<EndpointInfo> {
  // Only a resolved detection is worth keeping. A failure here is usually
  // transient — Chrome still starting, a port file mid-rewrite — and caching
  // the rejection would make the first unlucky call poison every later one.
  return (cached ??= (async (): Promise<EndpointInfo> => {
    const forced = process.env.CDP_BROWSER_WS;
    if (forced) return { transport: "browser-ws", browserWsUrl: forced };

    const discovered = await discoverBrowserWs();
    if (discovered && (await handshake(discovered, 5_000))) {
      return { transport: "browser-ws", browserWsUrl: discovered };
    }

    const version = await fetch(`${BASE}/json/version`)
      .then((r) => (r.ok ? (r.json() as Promise<{ webSocketDebuggerUrl?: string }>) : undefined))
      .catch(() => undefined);
    if (version?.webSocketDebuggerUrl) {
      return { transport: "http", browserWsUrl: version.webSocketDebuggerUrl };
    }

    throw new Error(
      `no DevTools endpoint at ${BASE}: GET /json/version did not answer and ` +
        `no live browser socket was found in ${process.env.CDP_USER_DATA_DIR ?? "the default Chrome profile(s)"}. ` +
        `Set CDP_BROWSER_WS to the ws://.../devtools/browser/<uuid> URL, or CDP_USER_DATA_DIR to the profile in use.`,
    );
  })().catch((error: unknown) => {
    cached = undefined;
    throw error;
  }));
}

/** Test seam: drop the per-process detection cache. */
export function resetEndpointCache(): void {
  cached = undefined;
}
