/**
 * When `listTargets` may switch an endpoint to the browser-ws transport, and
 * when it must not. Fake-backed: every endpoint here is a FakeCdpServer on an
 * ephemeral port.
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeCdpServer } from "./helpers/fake-cdp-server.ts";
import { browserWsUrl, listTargets } from "../src/client.ts";
import { resetEndpointCache, withEndpointScope, type Endpoint } from "../src/endpoints.ts";

const fake = new FakeCdpServer();
let ep: Endpoint;
const saved = { CDP_BASE: process.env.CDP_BASE, CDP_BROWSER_WS: process.env.CDP_BROWSER_WS, CDP_USER_DATA_DIR: process.env.CDP_USER_DATA_DIR };

beforeAll(async () => {
  await fake.start();
  ep = { name: "ide", base: fake.base, readOnly: false };
});
afterEach(() => {
  fake.reset();
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  resetEndpointCache();
});
afterAll(() => fake.stop());

const listings = () => fake.requests.filter((r) => r.path === "/json/list").length;
const getTargetsCalls = () => fake.messagesFor("browser").filter((m) => m.method === "Target.getTargets").length;

describe("listTargets transport fallback", () => {
  test("a transient /json/list failure on a Chrome that serves /json does NOT pin browser-ws", async () => {
    fake.failHttp["/json/list"] = 1;
    await withEndpointScope(ep, async () => {
      await expect(listTargets()).rejects.toThrow("/json/list -> HTTP 404");
      const ids = (await listTargets()).map((t) => t.id);
      expect(ids).toEqual(["PAGE1"]);
      expect((await listTargets())[0]!.webSocketDebuggerUrl).toContain("/devtools/page/PAGE1");
    });
    expect(listings()).toBe(3); // every call went to HTTP, including the two after the failure
    expect(getTargetsCalls()).toBe(0);
  });

  test("control: a Chrome that serves no /json DOES switch to Target.getTargets, and stays switched", async () => {
    fake.failHttp["/json/list"] = Infinity;
    fake.failHttp["/json/version"] = Infinity;
    process.env.CDP_BASE = fake.base;
    process.env.CDP_BROWSER_WS = `ws://127.0.0.1:${new URL(fake.base).port}/devtools/browser/fake-browser`;
    resetEndpointCache();
    const first = await listTargets();
    expect(first.map((t) => t.id)).toEqual(["PAGE1"]);
    expect(first[0]!.webSocketDebuggerUrl).toBe("");
    await listTargets();
    expect(listings()).toBe(1); // the 404 is paid once, then the transport is cached
    expect(getTargetsCalls()).toBe(2);
  });
});

describe("browserWsUrl", () => {
  test("asks /json/version on every call, so a Chrome restart's new uuid is picked up", async () => {
    await withEndpointScope(ep, async () => {
      expect(await browserWsUrl()).toContain("/devtools/browser/fake-browser");
      expect(await browserWsUrl()).toContain("/devtools/browser/fake-browser");
    });
    expect(fake.requests.filter((r) => r.path === "/json/version").length).toBe(2);
  });
});

describe("browser socket after a Chrome restart", () => {
  test("a cached browser-ws URL that stopped answering is re-detected from the port file", async () => {
    // `old` is the Chrome before the restart; `fake` (serving no /json) is the one after it.
    const old = new FakeCdpServer();
    await old.start();
    const profile = mkdtempSync(join(tmpdir(), "cdp-bws-restart-"));
    const portFile = (port: string, uuid: string) => writeFileSync(join(profile, "DevToolsActivePort"), `${port}\n/devtools/browser/${uuid}`);
    try {
      fake.failHttp["/json/list"] = Infinity;
      fake.failHttp["/json/version"] = Infinity;
      process.env.CDP_BASE = fake.base;
      process.env.CDP_USER_DATA_DIR = profile;
      resetEndpointCache();

      portFile(new URL(old.base).port, "before-restart");
      expect((await listTargets()).map((t) => t.id)).toEqual(["PAGE1"]);
      expect(old.messagesFor("browser").some((m) => m.method === "Target.getTargets")).toBe(true);

      await old.stop();
      portFile(new URL(fake.base).port, "after-restart");
      expect((await listTargets()).map((t) => t.id)).toEqual(["PAGE1"]);
      expect(getTargetsCalls()).toBe(1); // reached the restarted browser, not the stale socket
    } finally {
      await old.stop();
      rmSync(profile, { recursive: true, force: true });
    }
  });
});
