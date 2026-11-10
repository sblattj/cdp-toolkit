/**
 * Test preload (bunfig.toml): no test may reach a real browser.
 *
 * The default DevTools endpoint (127.0.0.1:9222, or CDP_BASE from the shell) is
 * usually the developer's own logged-in browser. A test that stubs fetch for one
 * path and lets the rest through, or one whose stub fails on purpose, could
 * otherwise fall back to that browser's real socket, and a transport learned
 * there would be cached for every later test in the process. So:
 *   1. any fetch or WebSocket to the default endpoint's port throws, and
 *   2. the learned-transport and detection caches are cleared before each test.
 * Fakes and disposable browsers listen on ephemeral ports and are unaffected.
 */
import { beforeEach } from "bun:test";
import { resetTransportCache } from "../../src/client.ts";

// They name a live browser profile or socket; a test that needs one sets it itself.
delete process.env.CDP_BROWSER_WS;
delete process.env.CDP_USER_DATA_DIR;

const blockedPorts = new Set(["9222"]);
if (process.env.CDP_BASE) {
  try {
    blockedPorts.add(new URL(process.env.CDP_BASE).port || "80");
  } catch {
    /* a malformed CDP_BASE reaches nothing anyway */
  }
}

function refuse(kind: string, raw: string): void {
  let port: string;
  try {
    port = new URL(raw).port;
  } catch {
    return;
  }
  if (blockedPorts.has(port)) {
    throw new Error(`test reached the default DevTools endpoint (${kind} ${raw}); stub it or use a fake server`);
  }
}

const realFetch = globalThis.fetch;
globalThis.fetch = Object.assign(
  async (input: RequestInfo | URL, init?: RequestInit) => {
    refuse("fetch", typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    return realFetch(input, init);
  },
  realFetch,
) as typeof fetch;

const RealWebSocket = globalThis.WebSocket;
globalThis.WebSocket = class extends RealWebSocket {
  constructor(url: string | URL, protocols?: string | string[]) {
    refuse("WebSocket", String(url));
    super(url, protocols);
  }
} as typeof WebSocket;

beforeEach(() => {
  resetTransportCache();
});
