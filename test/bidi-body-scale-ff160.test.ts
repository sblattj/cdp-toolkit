/**
 * Firefox 160 parity: network.responseBodyPostHoc and screenshot.scale on the WebDriver BiDi backend.
 *
 * LIVE against a throwaway headless Firefox (launchFirefox: free port, temp profile, killed in
 * afterAll) with fixtures from Bun.serve on port 0. It never touches 9222/9223/9333. When no Firefox
 * binary can be launched the live block is skipped (not failed), the same way a CI box without one
 * has to behave; the stub block below needs no browser.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { launchFirefox, type LaunchedFirefox } from "../src/bidi/launch.ts";
import { BIDI_CAPABILITY_MIN_FIREFOX, BidiPageDriver, createFirefoxDriver } from "../src/bidi/driver.ts";
import type { BidiConnection } from "../src/bidi/client.ts";
import type { BrowserDriver, PageDriver } from "../src/driver.ts";
import { isDriverError } from "../src/driver.ts";
import { getNetworkRequest } from "../src/bidi-tools.ts";
import { imagePixelSize, takeScreenshot } from "../src/shared-tools.ts";

// Same gate as bidi-input-ff160: an explicit FIREFOX_BIN or the macOS app. A bare `firefox` on PATH (a CI
// runner's stub) can take longer than the launch timeout to open its debug port on a cold start.
const HAVE_FIREFOX = Boolean(process.env.FIREFOX_BIN) || existsSync("/Applications/Firefox.app/Contents/MacOS/firefox");
const live = HAVE_FIREFOX ? describe : describe.skip;

const BINARY = new Uint8Array([0, 1, 2, 255, 254, 128, 0, 200]);

const server = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  fetch(req) {
    const path = new URL(req.url).pathname;
    if (path === "/json") return new Response('{"body":"captured"}', { headers: { "content-type": "application/json" } });
    if (path === "/bin") return new Response(BINARY, { headers: { "content-type": "application/octet-stream" } });
    if (path === "/huge") return new Response("h".repeat(3 * 1024 * 1024), { headers: { "content-type": "text/plain" } });
    if (path.startsWith("/big")) return new Response("x".repeat(1_000_000), { headers: { "content-type": "text/plain" } });
    return new Response('<body style="margin:0"><div style="width:300px;height:200px;background:#c33">hello</div></body>', { headers: { "content-type": "text/html" } });
  },
});
const BASE = `http://127.0.0.1:${server.port}`;

let launched: LaunchedFirefox | undefined;
let driver: BrowserDriver | undefined;
let page: PageDriver;
const seen: Array<{ id: string; url: string }> = [];

/** Fire a fetch FROM THE PAGE and return the request id the browser minted for it. No tool call is
 *  involved in reading the body, which is the "not armed by the caller" case. */
async function pageFetch(path: string, as: "text" | "buffer" = "text"): Promise<string> {
  const before = seen.length;
  await page.evaluate(`fetch(${JSON.stringify(path)}).then(r => r.${as === "text" ? "text" : "arrayBuffer"}()).then(x => x.length ?? x.byteLength)`, { awaitPromise: true });
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const hit = seen.slice(before).find((s) => s.url.endsWith(path));
    if (hit) return hit.id;
    await Bun.sleep(25);
  }
  throw new Error(`no network.responseCompleted seen for ${path}`);
}

function pngWidth(b64OrBytes: Uint8Array): { width: number; height: number } {
  const d = imagePixelSize(b64OrBytes);
  if (!d) throw new Error("not a PNG");
  return d;
}

live("Firefox 160 live: post-hoc response bodies", () => {
  beforeAll(async () => {
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
    try { await driver?.dispose(); } catch { /* best effort */ }
    if (launched) { try { process.kill(launched.pid, "SIGKILL"); } catch { /* gone */ } }
    server.stop(true);
  });

  test("capability rows are declared for 160", () => {
    expect(BIDI_CAPABILITY_MIN_FIREFOX["network.responseBodyPostHoc"]).toBe(160);
    expect(BIDI_CAPABILITY_MIN_FIREFOX["screenshot.scale"]).toBe(160);
    expect(driver!.capabilities.has("network.responseBodyPostHoc")).toBe(true);
    expect(driver!.capabilities.has("screenshot.scale")).toBe(true);
  });

  test("a text body fetched before any body call is readable with no startBodyCapture", async () => {
    const id = await pageFetch("/json");
    const got = await page.getResponseBody(id);
    expect(got).toEqual({ body: '{"body":"captured"}', base64Encoded: false });
  });

  test("a binary body comes back as base64 and round-trips byte for byte", async () => {
    const id = await pageFetch("/bin", "buffer");
    const got = await page.getResponseBody(id);
    expect(got.base64Encoded).toBe(true);
    expect([...Buffer.from(got.body, "base64")]).toEqual([...BINARY]);
  });

  test("get_network_request includeBody:true returns the body for a request made before the call", async () => {
    const id = await pageFetch("/json");
    const out = await getNetworkRequest(driver!, { requestId: id, includeBody: true });
    expect(out.body).toBe('{"body":"captured"}');
    expect(out.bodyBase64Encoded).toBe(false);
  });

  test("an unknown id is a clear DriverError, not empty text", async () => {
    const err = await page.getResponseBody("no-such-request-id").catch((e: unknown) => e);
    expect(isDriverError(err)).toBe(true);
    expect((err as Error).message).toMatch(/no body is held for request no-such-request-id/);
    expect((err as Error).message).toMatch(/larger than 2097152 bytes/);
  });

  test("a body over the per-response cap is not retained and says so", async () => {
    const id = await pageFetch("/huge");
    const err = await page.getResponseBody(id).catch((e: unknown) => e);
    expect(isDriverError(err)).toBe(true);
    expect((err as Error).message).toMatch(/no body is held/);
  });

  test("an evicted body is a clear DriverError naming the eviction", async () => {
    const first = await pageFetch("/big0");
    // Firefox's own total budget (measured 100-200 MB) pushes the oldest out: 260 x 1 MB.
    await page.evaluate("(async()=>{for(let i=1;i<260;i++){await (await fetch('/big'+i)).text();}return 1})()", { awaitPromise: true });
    await Bun.sleep(500);
    const err = await page.getResponseBody(first).catch((e: unknown) => e);
    expect(isDriverError(err)).toBe(true);
    expect((err as Error).message).toMatch(/evicted/);
    // The newest one is still there.
    const newest = seen.filter((s) => s.url.endsWith("/big259")).at(-1)!;
    expect((await page.getResponseBody(newest.id)).body.length).toBe(1_000_000);
  }, 120_000);

  test("scale:2 is 2x the pixels of scale:1 and the device pixel ratio is back afterwards", async () => {
    await page.navigate({ url: `${BASE}/` });
    const dprBefore = (await page.evaluate("window.devicePixelRatio")) as number;
    const innerBefore = await page.evaluate("innerWidth + 'x' + innerHeight");
    const one = await page.screenshot({ scale: 1 });
    const two = await page.screenshot({ scale: 2 });
    if ("bands" in two) throw new Error("unexpected tiled capture");
    const a = pngWidth((one as { data: Uint8Array }).data);
    const b = pngWidth((two as { data: Uint8Array }).data);
    expect(b.width).toBe(a.width * 2);
    expect(b.height).toBe(a.height * 2);
    expect(await page.evaluate("window.devicePixelRatio")).toBe(dprBefore);
    expect(await page.evaluate("innerWidth + 'x' + innerHeight")).toBe(innerBefore);
    // full page at scale 2: the 200 css px body is 400 device px tall.
    const full = await page.screenshot({ scale: 2, fullPage: true });
    expect(pngWidth((full as { data: Uint8Array }).data).height).toBe(400);
    expect(await page.evaluate("window.devicePixelRatio")).toBe(dprBefore);
  }, 60_000);

  test("scale multiplies an emulated ratio and puts the emulated one back", async () => {
    await page.emulate({ width: 500, height: 400, deviceScaleFactor: 2 });
    try {
      const one = await page.screenshot({ scale: 1 });
      const two = await page.screenshot({ scale: 2 });
      expect(pngWidth((one as { data: Uint8Array }).data).width).toBe(1000);
      expect(pngWidth((two as { data: Uint8Array }).data).width).toBe(2000);
      expect(await page.evaluate("window.devicePixelRatio")).toBe(2);
      expect(await page.evaluate("innerWidth")).toBe(500);
    } finally {
      await page.emulate({ clearOverrides: true });
    }
  }, 60_000);

  test("take_screenshot scale:2 through the tool layer reports 2x", async () => {
    await page.navigate({ url: `${BASE}/` });
    const r1 = await takeScreenshot(driver!, { scale: 1, returnBase64: true });
    const r2 = await takeScreenshot(driver!, { scale: 2, returnBase64: true });
    expect(r2.width).toBe(r1.width! * 2);
    expect(r2.height).toBe(r1.height! * 2);
  }, 60_000);
});

describe("an older Firefox (stub session reporting 153.0) is refused as unsupported", () => {
  const conn = {
    capabilities: { browserVersion: "153.0" },
    send() { throw new Error("no BiDi command should be sent"); },
  } as unknown as BidiConnection;
  const info = { id: "ctx-1", url: "about:blank", title: "" };
  const mk = () => new BidiPageDriver(conn, "ctx-1", info, { scheme: "bidi" } as unknown as BrowserDriver);

  test("getResponseBody says unsupported and names the version", async () => {
    const err = await mk().getResponseBody("req-1").catch((e: unknown) => e);
    expect(isDriverError(err) && err.code).toBe("unsupported");
    expect((err as Error).message).toMatch(/Firefox 160 or newer; this Firefox is 153\.0/);
  });

  test("screenshot scale:2 says unsupported before any command is sent", async () => {
    const err = await mk().screenshot({ scale: 2 }).catch((e: unknown) => e);
    expect(isDriverError(err) && err.code).toBe("unsupported");
    expect((err as Error).message).toMatch(/screenshot\.scale needs Firefox 160/);
  });

  test("scale:1 still reaches the capture path (asks for nothing new)", async () => {
    // The stub throws on any send, so reaching it proves scale:1 was not gated.
    const err = await mk().screenshot({ scale: 1 }).catch((e: unknown) => e);
    expect((err as Error).message).toMatch(/no BiDi command should be sent/);
    expect(isDriverError(err) && err.code === "unsupported").toBe(false);
  });
});
