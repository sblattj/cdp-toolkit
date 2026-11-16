/**
 * CDP_FIREFOX_BODY_COLLECTOR=off: the session-wide response-body collector is not armed, so a body
 * the page fetched before any capture call is NOT readable, while startBodyCapture still works.
 *
 * LIVE against a throwaway headless Firefox (launchFirefox: free port, temp profile, killed in
 * afterAll). It never touches 9222/9223/9333. Skipped when no Firefox binary is installed.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { launchFirefox, type LaunchedFirefox } from "../src/bidi/launch.ts";
import { createFirefoxDriver } from "../src/bidi/driver.ts";
import type { BrowserDriver, PageDriver } from "../src/driver.ts";
import { isDriverError } from "../src/driver.ts";

const HAVE_FIREFOX = existsSync("/Applications/Firefox.app/Contents/MacOS/firefox") || !!Bun.which("firefox");
const live = HAVE_FIREFOX ? describe : describe.skip;

const server = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  fetch(req) {
    if (new URL(req.url).pathname === "/json") return new Response('{"body":"captured"}', { headers: { "content-type": "application/json" } });
    return new Response("<body>hi</body>", { headers: { "content-type": "text/html" } });
  },
});
const BASE = `http://127.0.0.1:${server.port}`;

let launched: LaunchedFirefox | undefined;
let driver: BrowserDriver | undefined;
let page: PageDriver;
const seen: Array<{ id: string; url: string }> = [];
const prior = process.env.CDP_FIREFOX_BODY_COLLECTOR;

async function pageFetch(path: string): Promise<string> {
  const before = seen.length;
  await page.evaluate(`fetch(${JSON.stringify(path)}).then(r => r.text()).then(x => x.length)`, { awaitPromise: true });
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const hit = seen.slice(before).find((s) => s.url.endsWith(path));
    if (hit) return hit.id;
    await Bun.sleep(25);
  }
  throw new Error(`no network.response seen for ${path}`);
}

live("CDP_FIREFOX_BODY_COLLECTOR=off", () => {
  beforeAll(async () => {
    process.env.CDP_FIREFOX_BODY_COLLECTOR = "off";
    launched = await launchFirefox({ headless: true });
    driver = createFirefoxDriver(launched.port);
    page = await driver.page(undefined);
    page.on("network.response", (p) => {
      const req = p.request as { request: string; url: string };
      seen.push({ id: req.request, url: req.url });
    });
    await page.navigate({ url: `${BASE}/` });
  }, 60_000);

  afterAll(async () => {
    if (prior === undefined) delete process.env.CDP_FIREFOX_BODY_COLLECTOR;
    else process.env.CDP_FIREFOX_BODY_COLLECTOR = prior;
    try { await driver?.dispose(); } catch { /* best effort */ }
    if (launched) { try { process.kill(launched.pid, "SIGKILL"); } catch { /* gone */ } }
    server.stop(true);
  });

  test("an unarmed body is not retained: a clear page-error, never empty text", async () => {
    const id = await pageFetch("/json");
    let err: unknown;
    try { await page.getResponseBody(id); } catch (e) { err = e; }
    expect(isDriverError(err)).toBe(true);
    expect((err as { code: string }).code).toBe("page-error");
    expect((err as Error).message).toContain("no body is held");
  });

  test("startBodyCapture still makes a body readable (control)", async () => {
    const stop = await page.startBodyCapture();
    try {
      const id = await pageFetch("/json");
      const got = await page.getResponseBody(id);
      expect(got).toEqual({ body: '{"body":"captured"}', base64Encoded: false });
    } finally {
      await stop();
    }
  });
});
