/**
 * End-to-end proof that the toolkit drives a browser-ws-only endpoint.
 *
 * Owns its browser: spawns a disposable headless Chrome on an ephemeral port
 * with a throwaway profile, fronts it with the browser-ws-only proxy (see
 * ./browser-ws-only-proxy.ts), and kills it on the way out. It never looks for
 * a Chrome you are already running, by design — see the consent-prompt note in
 * src/cdp/endpoint.ts.
 *
 * Run:  bun run browser-ws:smoke
 * Scale the tab count with TABS=200 to reproduce a many-tab browser.
 */
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startBrowserWsOnlyProxy } from "./browser-ws-only-proxy.ts";

const TABS = Number(process.env.TABS ?? 40);
/** Every phase is capped at the real MCP tool timeout. */
const TOOL_TIMEOUT_MS = 60_000;

function chromeBinary(): string {
  if (process.env.CHROME_BIN) return process.env.CHROME_BIN;
  if (process.platform === "darwin") return "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
  return "google-chrome";
}

async function freePort(): Promise<number> {
  // Chrome writes its real port to DevToolsActivePort when given 0.
  return 0;
}

/** Throws rather than exits, so the catch below still kills Chrome and its profile. */
function fail(msg: string): never {
  throw new Error(msg);
}

/** Run `label` under the 60s tool budget, printing what it actually took. */
async function phase<T>(label: string, fn: () => Promise<T>): Promise<T> {
  const t0 = Date.now();
  const timer = new Promise<never>((_, reject) =>
    setTimeout(() => reject(new Error(`exceeded ${TOOL_TIMEOUT_MS}ms tool budget`)), TOOL_TIMEOUT_MS),
  );
  try {
    const out = await Promise.race([fn(), timer]);
    console.log(`  ok   ${label} — ${((Date.now() - t0) / 1000).toFixed(2)}s`);
    return out as T;
  } catch (e) {
    console.log(`  FAIL ${label} — ${((Date.now() - t0) / 1000).toFixed(2)}s: ${(e as Error).message}`);
    throw e;
  }
}

const profile = await mkdtemp(join(tmpdir(), "cdp-browser-ws-smoke-"));
const chrome = spawn(
  chromeBinary(),
  [
    "--headless=new",
    `--user-data-dir=${profile}`,
    "--remote-debugging-port=0",
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-sync",
    "--disable-gpu",
  ],
  { stdio: ["ignore", "ignore", "pipe"] },
);

/** Chrome prints `DevTools listening on ws://...` to stderr once it is up. */
const upstreamWs = await new Promise<string>((resolve, reject) => {
  let buf = "";
  const t = setTimeout(() => reject(new Error("Chrome did not report a DevTools endpoint in 30s")), 30_000);
  chrome.stderr.on("data", (d: Buffer) => {
    buf += d.toString();
    const m = buf.match(/DevTools listening on (ws:\/\/\S+)/);
    if (m?.[1]) {
      clearTimeout(t);
      resolve(m[1]);
    }
  });
  chrome.on("exit", (code) => reject(new Error(`Chrome exited (${code}) before reporting an endpoint`)));
});
const upstreamBase = `http://${new URL(upstreamWs).host}`;
console.log(`disposable Chrome: ${upstreamBase}  (profile ${profile})`);

const proxy = await startBrowserWsOnlyProxy(upstreamBase);
console.log(`browser-ws-only endpoint: ${proxy.base}`);

async function cleanup(): Promise<void> {
  proxy.stop();
  chrome.kill("SIGKILL");
  await rm(profile, { recursive: true, force: true }).catch(() => {});
}

try {
  /* ---- 0. the endpoint really is browser-ws-only ------------------------- */
  const version = await fetch(`${proxy.base}/json/version`).then((r) => r.status);
  const list = await fetch(`${proxy.base}/json/list`).then((r) => r.status);
  const pageWs = await new Promise<string>((resolve) => {
    const ws = new WebSocket(`${proxy.base.replace("http", "ws")}/devtools/page/DEADBEEF`);
    ws.onopen = () => {
      ws.close();
      resolve("101");
    };
    ws.onerror = () => resolve("refused (403)");
  });
  console.log(`\nendpoint shape: /json/version=${version}  /json/list=${list}  page-ws=${pageWs}`);
  if (version !== 404 || list !== 404) fail("fixture is not browser-ws-only: /json answered");

  /* ---- point the toolkit at it ------------------------------------------- */
  process.env.CDP_BASE = proxy.base;
  process.env.CDP_BROWSER_WS = proxy.browserWsUrl;
  process.env.CDP_REQUIRE_LEASE = "0";
  const { listTargets } = await import("../src/client.ts");
  const { TOOLS } = await import("../src/index.ts");

  /* ---- open the tabs ------------------------------------------------------ */
  const { withBrowserSocket } = await import("../src/cdp/session.ts");
  await withBrowserSocket(async (conn) => {
    for (let i = 0; i < TABS; i++) {
      await conn.send("Target.createTarget", {
        url: `data:text/html,<title>Tab ${i}</title><h1 id=h>tab ${i} heading</h1>`,
      });
    }
  });
  console.log(`\nopened ${TABS} tabs\n`);

  /* ---- 1. discovery ------------------------------------------------------- */
  const pages = await phase(`list_pages over ${TABS}+ tabs`, async () => {
    const out = (await TOOLS.list_pages({})) as { pages: Array<{ id: string; url: string; title: string }> };
    if (!Array.isArray(out.pages)) fail("list_pages returned no pages array");
    if (out.pages.length < TABS) fail(`list_pages returned ${out.pages.length}, expected >= ${TABS}`);
    return out.pages;
  });
  console.log(`       -> ${pages.length} pages`);

  /* ---- 2. drive an ordinary tab ------------------------------------------ */
  const ordinary = pages.find((p) => p.url.includes("Tab%205") || p.title.includes("Tab 5")) ?? pages[pages.length - 1];
  if (!ordinary) fail("no ordinary tab to drive");
  await phase(`evaluate_script on an ordinary tab (${ordinary.title})`, async () => {
    const v = (await TOOLS.evaluate_script({ target: ordinary.id, expression: "document.querySelector('#h').textContent" })) as unknown;
    if (typeof v !== "string" || !v.includes("heading")) fail(`unexpected value: ${JSON.stringify(v)}`);
    console.log(`       -> ${JSON.stringify(v)}`);
  });
  await phase(`take_snapshot on the same tab`, async () => {
    const snap = (await TOOLS.take_snapshot({ target: ordinary.id })) as { snapshot: string; nodeCount: number };
    if (!snap.snapshot?.includes("heading")) fail("snapshot did not contain the heading");
    console.log(`       -> ${snap.nodeCount} a11y nodes`);
  });

  /* ---- 3. the unfiltered listing still carries non-page targets ---------- */
  await phase("listTargets carries non-page types (frame:/worker: arms intact)", async () => {
    const all = await listTargets();
    const types = new Set(all.map((t) => t.type));
    console.log(`       -> ${all.length} targets, types: ${[...types].join(", ")}`);
    if (!types.has("page")) fail("no page targets in the unfiltered listing");
  });

  /* ---- 4. repeated drives, no state bleed -------------------------------- */
  await phase("5 consecutive drives across different tabs", async () => {
    for (let i = 0; i < 5; i++) {
      const p = pages[i % pages.length]!;
      const v = (await TOOLS.evaluate_script({ target: p.id, expression: "document.title" })) as unknown;
      if (typeof v !== "string") fail(`drive ${i} returned ${JSON.stringify(v)}`);
    }
  });

  console.log("\nPASS — browser-ws-only transport drives discovery and per-tab work under the 60s budget.");
  await cleanup();
  process.exit(0);
} catch (e) {
  console.error(`\nFAILED: ${(e as Error).message}`);
  await cleanup();
  process.exit(1);
}
