/**
 * Firefox 160 parity for `wait_for_download` (browser.downloads) and `grant_permissions`
 * (browser.permissions): src/bidi-browser-tools.ts.
 *
 * Unit half (no browser): the Chrome-name -> W3C-descriptor map, the by-name "unsupported" refusal
 * (made before any page is acquired, so nothing is half-applied), and the version gate against a
 * stub connection reporting Firefox 153.0 (refused before a single BiDi command is sent).
 *
 * Live half: a THROWAWAY headless Firefox from launchFirefox() on a free port with its own temp
 * profile (never 9222/9223/9333), fixtures from Bun.serve on port 0, driven through the TOOL
 * functions — not raw BiDi. The profile's own download dir is pointed at a temp folder so the
 * "back to normal behavior" download is observable and never lands in the real ~/Downloads.
 */
import { HAVE_FIREFOX_160 } from "./helpers/firefox160.ts";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { launchFirefox, writeLaunchUserJs, type LaunchedFirefox } from "../src/bidi/launch.ts";
import { createFirefoxDriver } from "../src/bidi/driver.ts";
import type { BrowserDriver } from "../src/driver.ts";
import {
  FIREFOX_DOWNLOAD_STAGING_DIR, FIREFOX_PERMISSION_DESCRIPTORS, grantPermissionsFirefox, mapFirefoxPermissions, waitForDownloadFirefox,
} from "../src/bidi-browser-tools.ts";
import { DOWNLOADS_DIR } from "../src/tools/browser-session.ts";
import { FIREFOX_TOOLS } from "../src/firefox-tools.ts";

const FIREFOX_BIN = [process.env.FIREFOX_BIN, "/Applications/Firefox.app/Contents/MacOS/firefox"].find((p) => p && existsSync(p));

/* ------------------------------------ unit ------------------------------------ */

function stubDriver(browserVersion: string) {
  const sent: string[] = [];
  let pageCalls = 0;
  const conn = {
    capabilities: { browserVersion },
    send: async (method: string) => { sent.push(method); return {}; },
    on: () => () => undefined,
  };
  const driver = {
    page: async () => {
      pageCalls++;
      return { info: { id: "ctx-1", url: "https://example.test/", title: "t" }, release: async () => undefined, evaluate: async () => "prompt" };
    },
    withBrowserConnection: (fn: (c: typeof conn) => Promise<unknown>) => fn(conn),
    setDisposeHook: () => undefined,
  } as unknown as BrowserDriver;
  return { driver, sent, pageCalls: () => pageCalls };
}

describe("Firefox permission-name mapping", () => {
  test("Chrome PermissionType names map to the measured W3C descriptors", () => {
    expect(mapFirefoxPermissions(["geolocation", "audioCapture", "videoCapture", "durableStorage", "midiSysex", "wakeLockScreen"])).toEqual([
      { name: "geolocation" }, { name: "microphone" }, { name: "camera" }, { name: "persistent-storage" }, { name: "midi", sysex: true }, { name: "screen-wake-lock" },
    ]);
  });
  test("an unmappable name is refused as 'unsupported', naming the name", () => {
    for (const bad of ["clipboardReadWrite", "storageAccess", "bogusPermission", "toString"]) {
      let err: unknown;
      try { mapFirefoxPermissions(["geolocation", bad]); } catch (e) { err = e; }
      expect((err as { code?: string }).code).toBe("unsupported");
      expect((err as Error).message).toContain(`'${bad}'`);
    }
  });
  test("the map holds only Chrome PermissionType names (no W3C spellings slipped in)", () => {
    expect(Object.keys(FIREFOX_PERMISSION_DESCRIPTORS).sort()).toEqual(
      ["audioCapture", "durableStorage", "geolocation", "midi", "midiSysex", "notifications", "videoCapture", "wakeLockScreen"],
    );
  });
  test("an unmappable name is refused before the page (lease gate) or the browser is touched", async () => {
    const s = stubDriver("160.0");
    await expect(grantPermissionsFirefox(s.driver, { permissions: ["clipboardReadWrite"] })).rejects.toThrow(/clipboardReadWrite/);
    expect(s.pageCalls()).toBe(0);
    expect(s.sent).toEqual([]);
  });
});

describe("Firefox version gate (BIDI_CAPABILITY_MIN_FIREFOX = 160)", () => {
  test("wait_for_download on Firefox 153.0 is 'unsupported' and sends nothing", async () => {
    const s = stubDriver("153.0");
    let err: unknown;
    try { await waitForDownloadFirefox(s.driver, { arm: true }); } catch (e) { err = e; }
    expect((err as { code?: string }).code).toBe("unsupported");
    expect((err as Error).message).toContain("browser.downloads needs Firefox 160");
    expect((err as Error).message).toContain("153.0");
    expect(s.sent).toEqual([]);
  });
  test("grant_permissions on Firefox 153.0 is 'unsupported' and sends nothing", async () => {
    const s = stubDriver("153.0");
    let err: unknown;
    try { await grantPermissionsFirefox(s.driver, { permissions: ["geolocation"] }); } catch (e) { err = e; }
    expect((err as { code?: string }).code).toBe("unsupported");
    expect((err as Error).message).toContain("browser.permissions needs Firefox 160");
    expect(s.sent).toEqual([]);
  });
  test("both tools are registered in the Firefox registry", () => {
    expect(FIREFOX_TOOLS.wait_for_download).toBe(waitForDownloadFirefox);
    expect(FIREFOX_TOOLS.grant_permissions).toBe(grantPermissionsFirefox);
  });
});

/* ------------------------------------ live ------------------------------------ */

describe.skipIf(!FIREFOX_BIN || !HAVE_FIREFOX_160)("live headless Firefox 160: tool functions", () => {
  let ff: LaunchedFirefox | undefined;
  let driver: BrowserDriver | undefined;
  let srv: ReturnType<typeof Bun.serve> | undefined;
  let root = "";
  let normalDir = "";
  let base = "";
  let targetId = "";
  const tag = `ff160-${process.pid}-${Date.now()}`;

  const evalIn = async (expr: string): Promise<unknown> => {
    const p = await driver!.page(targetId);
    try { return await p.evaluate(expr, { awaitPromise: true }); } finally { await p.release(); }
  };
  const clickDownload = (name: string) =>
    evalIn(`(()=>{const a=document.createElement('a');a.href='/file?n=${encodeURIComponent(name)}';document.body.append(a);a.click();a.remove();return 1})()`);
  const geoState = () => evalIn("navigator.permissions.query({name:'geolocation'}).then(p=>p.state)");
  const waitForFile = async (path: string, ms = 5000): Promise<boolean> => {
    const end = Date.now() + ms;
    while (Date.now() < end) { if (existsSync(path)) return true; await Bun.sleep(100); }
    return existsSync(path);
  };

  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), "cdp-ff160-dlperm-"));
    const profile = join(root, "profile");
    normalDir = join(root, "normal-downloads");
    mkdirSync(profile); mkdirSync(normalDir);
    writeLaunchUserJs(profile);
    writeFileSync(join(profile, "user.js"), readFileSync(join(profile, "user.js"), "utf8")
      + `user_pref("browser.download.dir", ${JSON.stringify(normalDir)});\nuser_pref("browser.download.folderList", 2);\nuser_pref("browser.download.useDownloadDir", true);\n`);
    srv = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch(req) {
      const u = new URL(req.url);
      if (u.pathname === "/file") {
        const n = u.searchParams.get("n") ?? "x.txt";
        return new Response(`body-of-${n}`, { headers: { "content-disposition": `attachment; filename=${n}`, "content-type": "application/octet-stream" } });
      }
      return new Response("<title>dl</title><p>fixture</p>", { headers: { "content-type": "text/html" } });
    } });
    base = `http://127.0.0.1:${srv.port}`;
    ff = await launchFirefox({ headless: true, profilePath: profile });
    if ([9222, 9223, 9333].includes(ff.port)) throw new Error(`refusing a real-browser port ${ff.port}`);
    driver = createFirefoxDriver(ff.port);
    targetId = (await driver.newPage(`${base}/`)).id;
  }, 60_000);

  afterAll(async () => {
    try { await driver?.dispose(); } catch { /* best effort */ }
    try { await ff?.close(); } catch { /* best effort */ }
    srv?.stop(true);
    for (const f of readdirSync(DOWNLOADS_DIR).filter((f) => f.startsWith(tag))) rmSync(join(DOWNLOADS_DIR, f), { force: true });
    rmSync(root, { recursive: true, force: true });
  }, 60_000);

  test("arm -> click -> collect saves the file under DOWNLOADS_DIR with Chrome's result shape", async () => {
    const name = `${tag}-a.txt`;
    const armed = await waitForDownloadFirefox(driver!, { target: targetId, arm: true });
    expect(armed).toEqual({ armed: true, downloadPath: DOWNLOADS_DIR, pending: 0, target: { id: targetId, url: `${base}/`, title: "dl" } });
    await clickDownload(name);
    const r = await waitForDownloadFirefox(driver!, { target: targetId, timeoutMs: 10_000 }) as Record<string, unknown>;
    expect(Object.keys(r).sort()).toEqual(["bytes", "path", "suggestedFilename", "target", "url"]);
    expect(r.path).toBe(join(DOWNLOADS_DIR, name));
    expect(r.suggestedFilename).toBe(name);
    expect(r.bytes).toBe(`body-of-${name}`.length);
    expect(r.url).toBe(`${base}/file?n=${name}`);
    expect(readFileSync(r.path as string, "utf8")).toBe(`body-of-${name}`);
    expect(readdirSync(FIREFOX_DOWNLOAD_STAGING_DIR).filter((f) => f.endsWith(".download"))).toEqual([]);
  }, 30_000);

  test("after the collecting call returns, a later download goes back to Firefox's normal behavior", async () => {
    const name = `${tag}-later.txt`;
    await clickDownload(name);
    expect(await waitForFile(join(normalDir, name))).toBe(true);
    expect(existsSync(join(DOWNLOADS_DIR, name))).toBe(false);
    expect(readdirSync(FIREFOX_DOWNLOAD_STAGING_DIR)).not.toContain(name);
  }, 15_000);

  test("a same-named second capture gets Chrome's name-1.ext, not Firefox's name(1).ext", async () => {
    const name = `${tag}-a.txt`; // already collected once above
    await waitForDownloadFirefox(driver!, { target: targetId, arm: true });
    await clickDownload(name);
    const r = await waitForDownloadFirefox(driver!, { target: targetId, timeoutMs: 10_000 }) as Record<string, unknown>;
    expect(r.path).toBe(join(DOWNLOADS_DIR, `${tag}-a-1.txt`));
    expect(r.suggestedFilename).toBe(name);
  }, 30_000);

  test("a timed-out wait also restores normal downloads", async () => {
    await expect(waitForDownloadFirefox(driver!, { target: targetId, timeoutMs: 300 })).rejects.toThrow(/no download completed within 300ms/);
    const name = `${tag}-after-timeout.txt`;
    await clickDownload(name);
    expect(await waitForFile(join(normalDir, name))).toBe(true);
  }, 15_000);

  test("grant -> page sees 'granted'; reset -> page sees 'prompt'", async () => {
    expect(await geoState()).toBe("prompt");
    const g = await grantPermissionsFirefox(driver!, { target: targetId, permissions: ["geolocation"] });
    expect(g).toEqual({ granted: ["geolocation"], origin: base, target: { id: targetId, url: `${base}/`, title: "dl" } });
    expect(await geoState()).toBe("granted");
    const r = await grantPermissionsFirefox(driver!, { target: targetId, reset: true });
    expect(r).toEqual({ reset: true, target: { id: targetId, url: `${base}/`, title: "dl" } });
    expect(await geoState()).toBe("prompt");
  }, 20_000);

  test("an unknown permission name through the real driver is 'unsupported' and grants nothing", async () => {
    let err: unknown;
    try { await grantPermissionsFirefox(driver!, { target: targetId, permissions: ["geolocation", "clipboardReadWrite"] }); } catch (e) { err = e; }
    expect((err as { code?: string }).code).toBe("unsupported");
    expect((err as Error).message).toContain("'clipboardReadWrite'");
    expect(await geoState()).toBe("prompt");
  }, 15_000);

  test("disposing the session undoes outstanding grants (Firefox persists them across session.end)", async () => {
    await grantPermissionsFirefox(driver!, { target: targetId, permissions: ["geolocation"] });
    expect(await geoState()).toBe("granted");
    await driver!.dispose();
    driver = createFirefoxDriver(ff!.port);
    const pages = await driver.listPages();
    targetId = pages.find((p) => p.url.startsWith(base))!.id;
    expect(await geoState()).toBe("prompt");
  }, 30_000);
});
