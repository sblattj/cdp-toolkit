/**
 * The wedged-tab claim, over the browser-ws-only transport.
 *
 * WHY THIS IS A SEPARATE CHECK from scripts/wedge-bench.ts. That benchmark
 * proves the timeout bound holds when every page has its own socket, where a
 * hung renderer can only ever block the one socket dialed into it. This
 * transport puts every page on ONE shared socket, which is exactly the
 * arrangement where a naive implementation would let one stuck tab block all
 * the others — so the property has to be re-proven, not inherited.
 *
 * What it measures, against a disposable Chrome fronted by the browser-ws-only
 * proxy (see ./browser-ws-only-proxy.ts):
 *
 *   1. a tab navigated to a socket that accepts and never answers is driven
 *      anyway, and the call REJECTS at the bound instead of hanging;
 *   2. while that tab is stuck, a witness tab stays fast — the shared socket
 *      is not head-of-line blocked;
 *   3. discovery (list_pages) still answers fast with the stuck tab open,
 *      which is the whole point: a wedged tab must not cost you the listing.
 *
 * Run:  bun run browser-ws:wedge
 */
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startBrowserWsOnlyProxy } from "./browser-ws-only-proxy.ts";

const BOUND_MS = Number(process.env.CDP_TIMEOUT_MS ?? 5_000);
const SLACK_MS = 2_000;
const FAST_BUDGET_MS = 1_500;

process.env.CDP_TIMEOUT_MS = String(BOUND_MS);

function chromeBinary(): string {
  if (process.env.CHROME_BIN) return process.env.CHROME_BIN;
  if (process.platform === "darwin") return "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
  return "google-chrome";
}

async function timed<T>(fn: () => Promise<T>): Promise<{ ms: number; result?: T; error?: Error }> {
  const t0 = performance.now();
  try {
    return { ms: performance.now() - t0, result: await fn() };
  } catch (error) {
    return { ms: performance.now() - t0, error: error as Error };
  }
}
const fmt = (n: number): string => (n >= 1000 ? `${(n / 1000).toFixed(2)}s` : `${n.toFixed(0)}ms`);

/** A server that completes the TCP accept and then never writes a byte. */
const blackhole = createServer((socket) => {
  socket.on("error", () => {});
  // deliberately no response, ever
});
await new Promise<void>((resolve) => blackhole.listen(0, "127.0.0.1", resolve));
const blackholeUrl = `http://127.0.0.1:${(blackhole.address() as { port: number }).port}/hang`;

const profile = await mkdtemp(join(tmpdir(), "cdp-ws-wedge-"));
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
const upstreamWs = await new Promise<string>((resolve, reject) => {
  let buf = "";
  const t = setTimeout(() => reject(new Error("Chrome did not report an endpoint in 30s")), 30_000);
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
const proxy = await startBrowserWsOnlyProxy(`http://${new URL(upstreamWs).host}`);

process.env.CDP_BASE = proxy.base;
process.env.CDP_BROWSER_WS = proxy.browserWsUrl;
process.env.CDP_REQUIRE_LEASE = "0";

let failures = 0;
const check = (ok: boolean, label: string, detail: string): void => {
  if (!ok) failures++;
  console.log(`  ${ok ? "ok  " : "FAIL"} ${label} — ${detail}`);
};

try {
  const { TOOLS } = await import("../src/index.ts");
  console.log(`browser-ws-only endpoint ${proxy.base}, bound ${BOUND_MS}ms\n`);

  const witness = (await TOOLS.new_page({ url: "data:text/html,<title>witness</title>" })) as { targetId: string };
  const stuck = (await TOOLS.new_page({ url: "about:blank" })) as { targetId: string };

  // Navigate the victim into the blackhole. The navigate itself is expected to
  // reject at the bound; what matters is everything after it.
  const nav = await timed(() => TOOLS.navigate_page({ target: stuck.targetId, url: blackholeUrl }));
  console.log(`  (victim navigate returned in ${fmt(nav.ms)}${nav.error ? ` — ${nav.error.message}` : ""})\n`);

  // 1. driving the stuck tab rejects at the bound, never hangs.
  const drive = await timed(() => TOOLS.evaluate_script({ target: stuck.targetId, expression: "1+1" }));
  check(
    !!drive.error && drive.ms < BOUND_MS + SLACK_MS,
    "stuck tab rejects at the bound (no hang)",
    `${fmt(drive.ms)}, ${drive.error ? `rejected: ${drive.error.message.slice(0, 60)}` : "RESOLVED — expected a rejection"}`,
  );

  // 2. the witness tab is unaffected: the shared socket is not head-of-line blocked.
  const w = await timed(() => TOOLS.evaluate_script({ target: witness.targetId, expression: "document.title" }));
  check(
    !w.error && w.result === "witness" && w.ms < FAST_BUDGET_MS,
    "witness tab stays fast while the other is stuck",
    `${fmt(w.ms)}, value=${JSON.stringify(w.result)}`,
  );

  // 3. discovery still answers fast.
  const l = await timed(() => TOOLS.list_pages({}));
  const pageCount = (l.result as { pages: unknown[] } | undefined)?.pages.length ?? 0;
  check(!l.error && l.ms < FAST_BUDGET_MS, "list_pages stays fast with a stuck tab open", `${fmt(l.ms)}, ${pageCount} pages`);

  // 4. recovery: close the bricked tab, drive a fresh one at healthy latency.
  await TOOLS.close_page({ target: stuck.targetId }).catch(() => {});
  const fresh = (await TOOLS.new_page({ url: "data:text/html,<title>fresh</title>" })) as { targetId: string };
  const r = await timed(() => TOOLS.evaluate_script({ target: fresh.targetId, expression: "document.title" }));
  check(!r.error && r.result === "fresh" && r.ms < FAST_BUDGET_MS, "recovery after closing the bricked tab", `${fmt(r.ms)}`);

  console.log(failures === 0 ? "\nPASS — one stuck tab does not wedge the shared browser socket." : `\nFAILED (${failures})`);
} finally {
  proxy.stop();
  chrome.kill("SIGKILL");
  blackhole.close();
  await rm(profile, { recursive: true, force: true }).catch(() => {});
}
process.exit(failures === 0 ? 0 : 1);
