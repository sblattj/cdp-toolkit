/**
 * Unit tests for take_screenshot's `scale`. Everything here runs on a pure function or a stub
 * driver, never a real browser — the live proof (a viewport at 3x, a fullPage at 2x, an element
 * clip at 4x, and the oversize refusal) is in the branch's commit message, measured against
 * Chrome/151.0.7922.76.
 *
 * Three properties carry this slice:
 *
 * 1. THE DECODER IS HONEST. take_screenshot reports the output size by DECODING the bytes it just
 *    wrote, because the size a caller could compute (clip x scale) is wrong the moment the device
 *    pixel ratio multiplies in. So imagePixelSize must read real headers — a PNG IHDR, and a JPEG
 *    SOF reached by WALKING the marker segments, proved here with a decoy SOF0 buried inside a
 *    skipped APP0 that a fixed-offset reader would return instead — and must return undefined,
 *    never a guess, on anything it cannot parse.
 * 2. THE RANGE IS REFUSED, NOT CLAMPED. scale is a browser-side multiplier on a real render, so a
 *    fat-fingered value must fail before a socket is opened (resolveScreenshotScale, mirroring
 *    resolveDragSteps/resolveDragMode).
 * 3. THE PARAM-LEVEL GAP (ADR-001). `scale` needs Capability "screenshot.scale", which only the
 *    Chrome driver declares. take_screenshot must stay AVAILABLE on both backends (every other
 *    argument works on Firefox) while a scale on Firefox is a clear refusal — never a silent 1x
 *    capture, which would return an image the caller never asked for and cannot tell apart from
 *    the one they wanted. Proved against the REAL bidi capability set, not a hand-written one.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { deflateSync } from "node:zlib";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BrowserDriver, Capability, PageDriver, PageInfo, ScreenshotOptions, ScreenshotResult } from "../src/driver.ts";
import {
  REQUIRED_CAPABILITIES, clearViewportRecord, isDriverError, isTiledCapture, readViewportRecord, renderRestoreFailureNote, viewportRecordFile, writeViewportRecord,
} from "../src/driver.ts";
import { imagePixelSize, resolveRenderSize, resolveScreenshotScale, resolveTileMode, takeScreenshot } from "../src/shared-tools.ts";
import { CdpPageDriver, createCdpDriver, planTiledCapture } from "../src/cdp/driver.ts";
import { BidiPageDriver, createFirefoxDriver } from "../src/bidi/driver.ts";
import type { BidiConnection } from "../src/bidi/client.ts";
import { crc32 } from "../src/png.ts";
import { toolAvailability } from "../src/capabilities.ts";
import type { CdpConnection } from "../src/client.ts";
import type { Target } from "../src/types.ts";

/* --------------------------------- image builders --------------------------------- */

/** The first 24 bytes of a PNG: signature, IHDR chunk length + type, then width and height. */
function pngHeader(width: number, height: number): Uint8Array {
  const b = new Uint8Array(24);
  const v = new DataView(b.buffer);
  b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0); // \x89PNG\r\n\x1a\n
  v.setUint32(8, 13); // IHDR payload length
  b.set([0x49, 0x48, 0x44, 0x52], 12); // "IHDR"
  v.setUint32(16, width);
  v.setUint32(20, height);
  return b;
}

/**
 * SOI, then an APP0 segment the walk must SKIP, then the real SOF0. The APP0 payload deliberately
 * contains a decoy `FF C0 ... 2x1` frame header: a decoder reading a fixed offset, or one that
 * resynced byte-by-byte instead of honouring the segment length, returns 2x1 instead of w x h.
 */
function jpegHeader(width: number, height: number): Uint8Array {
  const decoySof = [0xff, 0xc0, 0x00, 0x11, 0x08, 0x00, 0x01, 0x00, 0x02, 0x03];
  const app0Payload = [...decoySof, 0x00, 0x00, 0x00, 0x00]; // 14 bytes = segment length 16 minus its own 2
  const sof0 = [0xff, 0xc0, 0x00, 0x11, 0x08, (height >> 8) & 0xff, height & 0xff, (width >> 8) & 0xff, width & 0xff, 0x03];
  return new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, ...app0Payload, ...sof0]);
}

describe("imagePixelSize", () => {
  test("reads width and height out of a PNG IHDR", () => {
    expect(imagePixelSize(pngHeader(2780, 2128))).toEqual({ width: 2780, height: 2128 });
    expect(imagePixelSize(pngHeader(1, 1))).toEqual({ width: 1, height: 1 });
    expect(imagePixelSize(pngHeader(16384, 16384))).toEqual({ width: 16384, height: 16384 });
  });
  test("walks JPEG marker segments to the real SOF0, skipping APP0 and its decoy frame header", () => {
    expect(imagePixelSize(jpegHeader(1920, 1080))).toEqual({ width: 1920, height: 1080 });
  });
  test("a PNG with a corrupt signature is not read as a PNG", () => {
    const bad = pngHeader(100, 200);
    bad[1] = 0x00;
    expect(imagePixelSize(bad)).toBeUndefined();
  });
  test("a PNG-signed buffer whose 4-byte chunk type is not IHDR is refused", () => {
    const bad = pngHeader(100, 200);
    bad.set([0x49, 0x44, 0x41, 0x54], 12); // "IDAT"
    expect(imagePixelSize(bad)).toBeUndefined();
  });
  test("a JPEG that ends before any SOF returns undefined rather than a partial read", () => {
    expect(imagePixelSize(new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46]))).toBeUndefined();
  });
  test("garbage and empty bytes return undefined, never a guess", () => {
    expect(imagePixelSize(new Uint8Array(0))).toBeUndefined();
    expect(imagePixelSize(new Uint8Array([0xff, 0xd8]))).toBeUndefined();
    expect(imagePixelSize(new TextEncoder().encode("not an image at all, just text"))).toBeUndefined();
  });
  test("reads a Uint8Array VIEW into a larger buffer, not the whole buffer", () => {
    // A driver hands over `new Uint8Array(Buffer.from(data, "base64"))`; Buffer instances are
    // views into a shared pool, so byteOffset is routinely non-zero.
    const backing = new Uint8Array(64);
    backing.set(pngHeader(640, 480), 32);
    expect(imagePixelSize(backing.subarray(32))).toEqual({ width: 640, height: 480 });
  });
});

/* ------------------------------------ scale range ------------------------------------ */

const CHROME_CAPS = createCdpDriver().capabilities;
const FIREFOX_CAPS = createFirefoxDriver(0).capabilities;

describe("resolveScreenshotScale", () => {
  test("omitted is 1 on any backend, and costs no capability", () => {
    expect(resolveScreenshotScale(undefined, FIREFOX_CAPS)).toBe(1);
    expect(resolveScreenshotScale(undefined, CHROME_CAPS)).toBe(1);
  });
  test("an explicit 1 is allowed even where scale is unsupported: it asks for nothing", () => {
    expect(resolveScreenshotScale(1, FIREFOX_CAPS)).toBe(1);
  });
  test("valid scales pass through untouched, fractions included", () => {
    expect(resolveScreenshotScale(2, CHROME_CAPS)).toBe(2);
    expect(resolveScreenshotScale(0.5, CHROME_CAPS)).toBe(0.5);
    expect(resolveScreenshotScale(8, CHROME_CAPS)).toBe(8);
  });
  test("out-of-range and non-finite values are refused, naming the accepted range", () => {
    for (const bad of [0, -1, -0.5, Number.NaN, Number.POSITIVE_INFINITY, 8.5, 9, 800]) {
      expect(() => resolveScreenshotScale(bad, CHROME_CAPS)).toThrow(/greater than 0 and at most 8/);
    }
  });
  test("a scale other than 1 without the capability is refused, naming the workaround", () => {
    expect(() => resolveScreenshotScale(2, FIREFOX_CAPS)).toThrow(/deviceScaleFactor:2/);
    expect(() => resolveScreenshotScale(2, FIREFOX_CAPS)).toThrow(/not supported by this backend/);
  });
});

/* -------------------------------------- wiring -------------------------------------- */

const INFO: PageInfo = { id: "TAB-SCALE-1", url: "https://example.test/shot", title: "Shot", type: "page" };

/** Minimal PageDriver/BrowserDriver stand-in, mirroring input-parity.test.ts's stubDriver: only
 *  the members takeScreenshot() touches, recording the options it passed down. */
function stubDriver(capabilities: ReadonlySet<Capability>, data: Uint8Array, extra: Partial<ScreenshotResult> = {}) {
  const shotCalls: ScreenshotOptions[] = [];
  const page = {
    info: INFO,
    async screenshot(opts?: ScreenshotOptions): Promise<ScreenshotResult> {
      shotCalls.push(opts ?? {});
      // A real driver echoes the render size back only when it applied one; `extra` lets a test
      // stand in for any of the four outcomes (no render size / restored / failed restore).
      return { data, format: "png", ...extra };
    },
    async release(): Promise<void> {},
  };
  const driver = {
    scheme: "cdp",
    capabilities,
    async page(): Promise<PageDriver> {
      return page as unknown as PageDriver;
    },
  };
  return { driver: driver as unknown as BrowserDriver, shotCalls };
}

const SAVE_PATH = join(tmpdir(), "cdp-toolkit-screenshot-scale.test.png");
async function shoot(driver: BrowserDriver, args: Record<string, unknown> = {}) {
  try {
    return await takeScreenshot(driver, { savePath: SAVE_PATH, ...args });
  } finally {
    await rm(SAVE_PATH, { force: true });
  }
}

describe("takeScreenshot() wiring", () => {
  test("passes scale through to page.screenshot and reports the MEASURED output size", async () => {
    const { driver, shotCalls } = stubDriver(CHROME_CAPS, pngHeader(4170, 3192));
    const result = await shoot(driver, { scale: 3 });
    expect(shotCalls).toEqual([{ format: "png", quality: undefined, fullPage: undefined, scale: 3 }]);
    expect(result.scale).toBe(3);
    // 4170x3192 comes off the BYTES, not from 1390x1064 x 3: the device pixel ratio the driver
    // captured at is invisible here, which is exactly why this number is decoded, not computed.
    expect(result.width).toBe(4170);
    expect(result.height).toBe(3192);
    expect(result.path).toBe(SAVE_PATH);
  });
  test("an omitted scale still reaches the driver as 1 and is echoed back as 1", async () => {
    const { driver, shotCalls } = stubDriver(CHROME_CAPS, pngHeader(2780, 2128));
    const result = await shoot(driver);
    expect(shotCalls[0]?.scale).toBe(1);
    expect(result.scale).toBe(1);
    expect({ width: result.width, height: result.height }).toEqual({ width: 2780, height: 2128 });
  });
  test("undecodable bytes OMIT width/height entirely rather than reporting a guess", async () => {
    const { driver } = stubDriver(CHROME_CAPS, new TextEncoder().encode("this is not an image"));
    const result = await shoot(driver, { scale: 2 });
    expect("width" in result).toBe(false);
    expect("height" in result).toBe(false);
    expect(result.scale).toBe(2); // the scale APPLIED is still known, so it is still reported
  });
  test("an out-of-range scale throws before the driver is ever touched", async () => {
    for (const bad of [0, -2, Number.NaN, 9]) {
      const { driver, shotCalls } = stubDriver(CHROME_CAPS, pngHeader(10, 10));
      await expect(shoot(driver, { scale: bad })).rejects.toThrow(/greater than 0 and at most 8/);
      expect(shotCalls).toEqual([]);
    }
  });
  test("the refusals are SharedToolErrors, the class the dispatcher wraps", async () => {
    const { driver } = stubDriver(CHROME_CAPS, pngHeader(10, 10));
    const err = await shoot(driver, { scale: 0 }).catch((e: unknown) => e);
    expect((err as Error).constructor.name).toBe("SharedToolError");
  });
  test("a scale on a backend without screenshot.scale is refused before a socket is opened", async () => {
    const { driver, shotCalls } = stubDriver(FIREFOX_CAPS, pngHeader(10, 10));
    await expect(shoot(driver, { scale: 2 })).rejects.toThrow(/no scale parameter/);
    expect(shotCalls).toEqual([]);
  });
  test("scale:1 is fine on that same backend: it asks the backend for nothing new", async () => {
    const { driver, shotCalls } = stubDriver(FIREFOX_CAPS, pngHeader(800, 600));
    const result = await shoot(driver, { scale: 1 });
    expect(shotCalls[0]?.scale).toBe(1);
    expect(result.width).toBe(800);
  });
});

/* ------------------------------------ render size ------------------------------------ */

/**
 * take_screenshot's renderWidth/renderHeight: emulate a viewport for ONE capture, then put the
 * previous one back. Three properties carry this slice, and they are not the same three as `scale`.
 *
 * 1. A VIEWPORT IS TWO NUMBERS. Honouring one side and inventing the other renders at a size the
 *    caller never named, so the pair is required together — the same rule emulate() has always had
 *    for device metrics, enforced here BEFORE a socket is opened so a rejected call cannot be the
 *    one that leaves a page mutated.
 * 2. THE RECORD IS LOAD-BEARING, not bookkeeping. Restore re-applies the override this toolkit last
 *    applied, because clearing does something different and destructive: measured on
 *    Chrome/151.0.7922.76, Emulation.clearDeviceMetricsOverride reverts to the REAL device, so
 *    restoring by clearing silently destroys an `emulate` the caller made earlier and still
 *    believes is in force. Live-fire confirmed both directions — with the record, a prior 777x555
 *    emulate came back after a 1920x1080 render capture; with the record deleted, the same call
 *    left the tab at the real 1390x1064.
 * 3. A FAILED RESTORE IS NEVER SWALLOWED. It means the caller's page is still emulated after the
 *    call returned, so it rides back on the result (renderRestored:false) rather than being dropped
 *    because the image itself came out fine.
 */
describe("resolveRenderSize", () => {
  test("omitted on both sides is undefined, and costs no capability", () => {
    expect(resolveRenderSize(undefined, undefined, FIREFOX_CAPS)).toBeUndefined();
    expect(resolveRenderSize(undefined, undefined, CHROME_CAPS)).toBeUndefined();
  });
  test("a valid pair passes through as a viewport", () => {
    expect(resolveRenderSize(1920, 1080, CHROME_CAPS)).toEqual({ width: 1920, height: 1080 });
    expect(resolveRenderSize(1, 1, CHROME_CAPS)).toEqual({ width: 1, height: 1 });
    expect(resolveRenderSize(16384, 16384, CHROME_CAPS)).toEqual({ width: 16384, height: 16384 });
  });
  test("one side without the other is refused, naming which side was given", () => {
    expect(() => resolveRenderSize(1920, undefined, CHROME_CAPS)).toThrow(/required together/);
    expect(() => resolveRenderSize(1920, undefined, CHROME_CAPS)).toThrow(/only renderWidth/);
    expect(() => resolveRenderSize(undefined, 1080, CHROME_CAPS)).toThrow(/only renderHeight/);
  });
  test("non-integer, non-positive and oversize sides are refused, naming the accepted range", () => {
    for (const bad of [0, -5, 1920.5, Number.NaN, Number.POSITIVE_INFINITY, 16385, 99999]) {
      expect(() => resolveRenderSize(bad, 1080, CHROME_CAPS)).toThrow(/'renderWidth' must be an integer between 1 and 16384/);
      expect(() => resolveRenderSize(1920, bad, CHROME_CAPS)).toThrow(/'renderHeight' must be an integer between 1 and 16384/);
    }
  });
  test("a backend without screenshot.renderSize is refused, naming the manual workaround", () => {
    // Neither shipping driver lacks it, so this arm needs a synthetic set — the point is that a
    // future backend refuses out loud instead of capturing at the tab's real size, which would
    // return a picture the caller cannot tell apart from the one they asked for.
    const noRenderSize: ReadonlySet<Capability> = new Set<Capability>(["screenshot.fullPage"]);
    expect(() => resolveRenderSize(1920, 1080, noRenderSize)).toThrow(/not supported by this backend/);
    expect(() => resolveRenderSize(1920, 1080, noRenderSize)).toThrow(/width:1920, height:1080/);
  });
  test("the range check runs BEFORE the capability check: a typo reads as a typo on any backend", () => {
    const noRenderSize: ReadonlySet<Capability> = new Set<Capability>([]);
    expect(() => resolveRenderSize(0, 1080, noRenderSize)).toThrow(/must be an integer/);
  });
});

describe("takeScreenshot() render-size wiring", () => {
  const RENDER = { width: 1920, height: 1080 };
  test("passes renderWidth/renderHeight down and reports the size that was applied", async () => {
    const { driver, shotCalls } = stubDriver(CHROME_CAPS, pngHeader(3840, 2160), { renderSize: RENDER, renderRestored: true });
    const result = await shoot(driver, { renderWidth: 1920, renderHeight: 1080 });
    expect(shotCalls[0]?.renderWidth).toBe(1920);
    expect(shotCalls[0]?.renderHeight).toBe(1080);
    expect(result.renderSize).toEqual(RENDER);
    expect(result.renderRestored).toBe(true);
    // Still decoded from the bytes, not computed: 1920 css x device pixel ratio 2 = 3840.
    expect({ width: result.width, height: result.height }).toEqual({ width: 3840, height: 2160 });
  });
  test("a FAILED restore is reported on the result, not swallowed because the image came out fine", async () => {
    const { driver } = stubDriver(CHROME_CAPS, pngHeader(3840, 2160), {
      renderSize: RENDER, renderRestored: false, renderRestoreError: "socket closed",
    });
    const result = await shoot(driver, { renderWidth: 1920, renderHeight: 1080 });
    expect(result.renderRestored).toBe(false);
    expect(result.renderRestoreError).toBe("socket closed");
  });
  test("a driver that reports no renderSize leaves all three fields OFF the result", async () => {
    const { driver, shotCalls } = stubDriver(CHROME_CAPS, pngHeader(2780, 2128));
    const result = await shoot(driver);
    expect(shotCalls[0]?.renderWidth).toBeUndefined();
    expect(shotCalls[0]?.renderHeight).toBeUndefined();
    expect("renderSize" in result).toBe(false);
    expect("renderRestored" in result).toBe(false);
    expect("renderRestoreError" in result).toBe(false);
  });
  test("a half-given or out-of-range pair throws before the driver is ever touched", async () => {
    for (const bad of [{ renderWidth: 1920 }, { renderHeight: 1080 }, { renderWidth: 0, renderHeight: 1080 }]) {
      const { driver, shotCalls } = stubDriver(CHROME_CAPS, pngHeader(10, 10));
      await expect(shoot(driver, bad)).rejects.toThrow(/renderWidth|renderHeight/);
      expect(shotCalls).toEqual([]);
    }
  });
  test("the refusals are SharedToolErrors, the class the dispatcher wraps", async () => {
    const { driver } = stubDriver(CHROME_CAPS, pngHeader(10, 10));
    const err = await shoot(driver, { renderWidth: 1920 }).catch((e: unknown) => e);
    expect((err as Error).constructor.name).toBe("SharedToolError");
  });
  test("composes with scale: both reach the driver in one capture", async () => {
    const { driver, shotCalls } = stubDriver(CHROME_CAPS, pngHeader(7680, 4320), { renderSize: RENDER, renderRestored: true });
    const result = await shoot(driver, { renderWidth: 1920, renderHeight: 1080, scale: 2, fullPage: true });
    expect(shotCalls).toEqual([{ format: "png", quality: undefined, fullPage: true, scale: 2, renderWidth: 1920, renderHeight: 1080 }]);
    expect(result.scale).toBe(2);
    expect(result.renderSize).toEqual(RENDER);
  });
});

/* ----------------------------- the viewport-override record ----------------------------- */

describe("viewport record (what restore puts back)", () => {
  let dir = "";
  const previous = process.env.CDP_ARTIFACT_DIR;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "cdp-viewport-rec-"));
    process.env.CDP_ARTIFACT_DIR = dir;
  });
  afterAll(async () => {
    if (previous === undefined) delete process.env.CDP_ARTIFACT_DIR;
    else process.env.CDP_ARTIFACT_DIR = previous;
    await rm(dir, { recursive: true, force: true });
  });

  test("a target with no record reads undefined — which is what makes restore CLEAR rather than guess", async () => {
    expect(await readViewportRecord("cdp", "NEVER-EMULATED")).toBeUndefined();
  });
  test("a written record round-trips every field restore needs to re-apply the override", async () => {
    await writeViewportRecord("cdp", "TAB-A", { width: 777, height: 555, deviceScaleFactor: 0, mobile: false });
    expect(await readViewportRecord("cdp", "TAB-A")).toEqual({ width: 777, height: 555, deviceScaleFactor: 0, mobile: false });
  });
  test("the newest write wins: emulate twice and restore owes the SECOND size", async () => {
    await writeViewportRecord("cdp", "TAB-B", { width: 800, height: 600 });
    await writeViewportRecord("cdp", "TAB-B", { width: 390, height: 844, deviceScaleFactor: 3, mobile: true });
    expect(await readViewportRecord("cdp", "TAB-B")).toEqual({ width: 390, height: 844, deviceScaleFactor: 3, mobile: true });
  });
  test("clearing forgets it, and clearing twice is not an error", async () => {
    await writeViewportRecord("cdp", "TAB-C", { width: 1024, height: 768 });
    await clearViewportRecord("cdp", "TAB-C");
    expect(await readViewportRecord("cdp", "TAB-C")).toBeUndefined();
    await clearViewportRecord("cdp", "TAB-C"); // a missing file is success, not a throw
  });
  test("the two backends never collide: a CDP targetId and a BiDi context id are not disjoint", async () => {
    await writeViewportRecord("cdp", "SAME-ID", { width: 100, height: 200 });
    await writeViewportRecord("bidi", "SAME-ID", { width: 300, height: 400 });
    expect(await readViewportRecord("cdp", "SAME-ID")).toEqual({ width: 100, height: 200 });
    expect(await readViewportRecord("bidi", "SAME-ID")).toEqual({ width: 300, height: 400 });
    expect(viewportRecordFile("cdp", "SAME-ID")).not.toBe(viewportRecordFile("bidi", "SAME-ID"));
  });
  test("a filename-hostile target id cannot escape the lease directory", () => {
    expect(viewportRecordFile("cdp", "../../etc/passwd")).toBe(join(dir, "viewport-cdp-.._.._etc_passwd.json"));
  });
  test("a corrupt or half-written record reads as undefined, never as a partial viewport", async () => {
    await writeFile(viewportRecordFile("cdp", "TAB-BAD"), "{not json", "utf8");
    expect(await readViewportRecord("cdp", "TAB-BAD")).toBeUndefined();
    // Present but missing a side: a viewport is two numbers, so half of one is not a viewport.
    await writeFile(viewportRecordFile("cdp", "TAB-HALF"), JSON.stringify({ width: 800 }), "utf8");
    expect(await readViewportRecord("cdp", "TAB-HALF")).toBeUndefined();
  });
});

/**
 * emulate({clearOverrides:true}) — the MEASURED cross-process no-op fix.
 *
 * Live-fire (two real CLI processes against Chrome/151.0.7922.76, pasted in the commit message)
 * proved the bug: process A sets a distinctive 802x601 override, a FRESH process B runs
 * clearOverrides, and the tab stays at 802x601 while the result reports `"cleared": true`. Root
 * cause: Emulation.clearDeviceMetricsOverride is a no-op unless the CLEARING connection is also
 * the SETTING connection, and this toolkit's per-call driver lifetime means those are essentially
 * never the same connection. Live-fire also proved the remedy — set an override on the clearing
 * connection first, then clear it — reliably lands on the real device every time.
 *
 * These tests stub CdpConnection.send to pin down what the driver-level unit test above cannot:
 * the exact CALL ORDER (set before clear, not the reverse, and not clear-only), and the HONESTY
 * property that a clear the driver could not verify throws rather than returning `{applied: []}`
 * for the caller (shared-tools.ts's emulate()) to relabel as `cleared: true`.
 */
function stubCdpConn(onSend?: (method: string, params?: Record<string, unknown>) => unknown): { conn: CdpConnection; calls: Array<{ method: string; params?: Record<string, unknown> }> } {
  const calls: Array<{ method: string; params?: Record<string, unknown> }> = [];
  const conn = {
    async send(method: string, params?: Record<string, unknown>) {
      calls.push({ method, params });
      return onSend ? onSend(method, params) : {};
    },
  } as unknown as CdpConnection;
  return { conn, calls };
}
function fakeTarget(id: string): Target {
  return { id, type: "page", title: "t", url: "about:blank", webSocketDebuggerUrl: "ws://x" };
}
const FAKE_CDP_BROWSER = { scheme: "cdp" } as unknown as BrowserDriver;
const METRICS_1390x1064 = { cssVisualViewport: { clientWidth: 1390, clientHeight: 1064 } };

describe("CdpPageDriver.emulate({clearOverrides:true})", () => {
  let dir = "";
  const previous = process.env.CDP_ARTIFACT_DIR;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "cdp-clear-fix-"));
    process.env.CDP_ARTIFACT_DIR = dir;
  });
  afterAll(async () => {
    if (previous === undefined) delete process.env.CDP_ARTIFACT_DIR;
    else process.env.CDP_ARTIFACT_DIR = previous;
    await rm(dir, { recursive: true, force: true });
  });

  test("sets a device-metrics override on THIS connection BEFORE clearing it, reusing the size it just read", async () => {
    const { conn, calls } = stubCdpConn((method) => (method === "Page.getLayoutMetrics" ? METRICS_1390x1064 : {}));
    const driver = new CdpPageDriver(conn, fakeTarget("T-order"), FAKE_CDP_BROWSER);
    await expect(driver.emulate({ clearOverrides: true })).resolves.toEqual({ applied: [] });
    const setIdx = calls.findIndex((c) => c.method === "Emulation.setDeviceMetricsOverride");
    const clearIdx = calls.findIndex((c) => c.method === "Emulation.clearDeviceMetricsOverride");
    expect(setIdx).toBeGreaterThanOrEqual(0);
    expect(clearIdx).toBeGreaterThan(setIdx);
    // Reused exactly what Page.getLayoutMetrics just reported: nothing a caller could observe moves.
    expect(calls[setIdx]?.params).toEqual({ width: 1390, height: 1064, deviceScaleFactor: 0, mobile: false });
  });

  test("a record from a DIFFERENT process is forgotten only once the clear is confirmed to have run", async () => {
    const { conn } = stubCdpConn((method) => (method === "Page.getLayoutMetrics" ? METRICS_1390x1064 : {}));
    await writeViewportRecord("cdp", "T-record", { width: 802, height: 601, deviceScaleFactor: 0, mobile: false });
    const driver = new CdpPageDriver(conn, fakeTarget("T-record"), FAKE_CDP_BROWSER);
    await driver.emulate({ clearOverrides: true });
    expect(await readViewportRecord("cdp", "T-record")).toBeUndefined();
  });

  test("HONESTY: a clear that could not be verified THROWS rather than reporting success", async () => {
    const { conn } = stubCdpConn((method) => {
      if (method === "Page.getLayoutMetrics") return METRICS_1390x1064;
      if (method === "Emulation.clearDeviceMetricsOverride") throw new Error("target closed");
      return {};
    });
    const driver = new CdpPageDriver(conn, fakeTarget("T-fail"), FAKE_CDP_BROWSER);
    await expect(driver.emulate({ clearOverrides: true })).rejects.toThrow(/could not verify.*cleared/i);
  });

  test("HONESTY: on that failure the record is LEFT IN PLACE, not silently dropped", async () => {
    const { conn } = stubCdpConn((method) => {
      if (method === "Page.getLayoutMetrics") return METRICS_1390x1064;
      if (method === "Emulation.setDeviceMetricsOverride") throw new Error("detached");
      return {};
    });
    await writeViewportRecord("cdp", "T-fail-record", { width: 777, height: 555, deviceScaleFactor: 0, mobile: false });
    const driver = new CdpPageDriver(conn, fakeTarget("T-fail-record"), FAKE_CDP_BROWSER);
    await expect(driver.emulate({ clearOverrides: true })).rejects.toThrow();
    expect(await readViewportRecord("cdp", "T-fail-record")).toEqual({ width: 777, height: 555, deviceScaleFactor: 0, mobile: false });
  });

  test("even on failure, the OTHER overrides (userAgent/cpu/media/network) are still attempted best-effort", async () => {
    const { conn, calls } = stubCdpConn((method) => {
      if (method === "Page.getLayoutMetrics") return METRICS_1390x1064;
      if (method === "Emulation.clearDeviceMetricsOverride") throw new Error("boom");
      return {};
    });
    const driver = new CdpPageDriver(conn, fakeTarget("T-besteffort"), FAKE_CDP_BROWSER);
    await driver.emulate({ clearOverrides: true }).catch(() => undefined);
    const methods = calls.map((c) => c.method);
    expect(methods).toContain("Emulation.setUserAgentOverride");
    expect(methods).toContain("Emulation.setCPUThrottlingRate");
    expect(methods).toContain("Emulation.setEmulatedMedia");
    expect(methods).toContain("Network.emulateNetworkConditions");
  });
});

describe("renderRestoreFailureNote", () => {
  test("names the size the page is stuck at AND how to undo it by hand", () => {
    const note = renderRestoreFailureNote({ width: 1920, height: 1080 }, "socket closed");
    expect(note).toContain("1920x1080");
    expect(note).toContain("socket closed");
    // At this point the toolkit has already failed to restore, so the caller needs the manual fix.
    expect(note).toContain("clearOverrides");
  });
});

/* --------------------------------- capability gating --------------------------------- */

describe("screenshot.renderSize capability (a PARAM gap, and NOT a Chrome-only one)", () => {
  test("BOTH backends declare it: each has its own viewport-emulation primitive", () => {
    // Emulation.setDeviceMetricsOverride on Chrome, browsingContext.setViewport on Firefox — the
    // same commands both already declare emulate.deviceMetrics on. Refusing it on either would
    // claim a missing primitive the driver demonstrably has.
    expect(CHROME_CAPS.has("screenshot.renderSize")).toBe(true);
    expect(FIREFOX_CAPS.has("screenshot.renderSize")).toBe(true);
    expect(CHROME_CAPS.has("emulate.deviceMetrics")).toBe(true);
    expect(FIREFOX_CAPS.has("emulate.deviceMetrics")).toBe(true);
  });
  test("it gates no whole tool: take_screenshot stays universal", () => {
    expect(REQUIRED_CAPABILITIES.take_screenshot).toBeUndefined();
  });
});

describe("screenshot.scale capability (ADR-001: a PARAM gap, not a whole-tool one)", () => {
  test("only Chrome declares it", () => {
    expect(CHROME_CAPS.has("screenshot.scale")).toBe(true);
    expect(FIREFOX_CAPS.has("screenshot.scale")).toBe(false);
  });
  test("take_screenshot itself stays available on BOTH backends", () => {
    expect(toolAvailability("chrome").available).toContain("take_screenshot");
    expect(toolAvailability("firefox").available).toContain("take_screenshot");
    // A whole-tool requirement here would delete a working tool from Firefox.
    expect(REQUIRED_CAPABILITIES.take_screenshot).toBeUndefined();
  });
});

/* ------------------------------------- tiling ------------------------------------- */

/**
 * take_screenshot's `tile`: a capture too big for one image, taken as vertical bands and stitched.
 * Four properties carry this slice, and none of them is "the option is plumbed through".
 *
 * 1. THE BAND ARITHMETIC IS THE WHOLE FEATURE, and it is invisible in a small test. clip.y advances
 *    in CSS PX while the encode limit is in DEVICE px — measured: a marker at css y=4000-4008 lands
 *    at the same css position at scale 1 and at scale 2, only at twice the resolution. So the band
 *    height is floor(cap / (scale x devicePixelRatio)) and the offset is NOT multiplied by either.
 *    Multiply the offset by the device pixel ratio and every seam skips a screenful; forget the
 *    ratio in the height and every band is over the cap and hangs. planTiledCapture is pure so both
 *    mistakes are caught here rather than on a 140,000 px page.
 * 2. WIDTH IS REFUSED, NOT TRUNCATED. Bands stack vertically because PNG concatenates scanlines;
 *    there is no horizontal join. A projection too wide has to say so and name the knobs that fix
 *    it, because a silently 16384-px-wide capture of a wider page is a wrong picture that looks
 *    exactly like a right one.
 * 3. THE DEFAULT PATH IS GUARDED NOW. The plain capture (no fullPage, no scale, no render size) used
 *    to skip Page.getLayoutMetrics, so the encode guard could not run — and that path already
 *    captures the FULL document, because captureBeyondViewport is hardcoded true. Live-fired against
 *    Chrome/151.0.7922.76 on HEAD: a plain take_screenshot of a 9000 css px page timed out and left
 *    the tab reporting innerWidth/innerHeight 1390x9000, with no flags passed at all.
 * 4. TWO COMBINATIONS CANNOT BE SERVED, and they refuse before a band is captured: JPEG (there is no
 *    lossless JPEG concatenation) and returnBase64 (base64 of a hundreds-of-MB image, into the
 *    caller's response).
 *
 * The live proof — 2780x281964 from 18 bands in 18s, byte-identical common-path captures, and a
 * 2-band stitch that decodes to the same RGBA sha256 as the single shot it replaced — is in this
 * branch's commit message.
 */

describe("planTiledCapture (the band arithmetic, pure)", () => {
  const CAP = 16384;
  test("auto leaves a capture that FITS alone: one shot, no bands", () => {
    expect(planTiledCapture({ width: 1390, height: 3000 }, 1, 2, undefined)).toEqual({ tiled: false, bandCount: 1, bandHeightCss: 3000 });
    // Exactly at the cap is still a fit: 8192 x 2 = 16384, and 16384 encodes in ~1s (measured).
    expect(planTiledCapture({ width: 1390, height: 8192 }, 1, 2, undefined).tiled).toBe(false);
  });
  test("one css px past the cap is banded", () => {
    const plan = planTiledCapture({ width: 1390, height: 8193 }, 1, 2, undefined);
    expect(plan).toEqual({ tiled: true, bandCount: 2, bandHeightCss: 8192 });
  });
  test("the live-fired case: 1390x140982 css at scale 1, ratio 2 -> 18 bands of 8192", () => {
    expect(planTiledCapture({ width: 1390, height: 140982 }, 1, 2, undefined)).toEqual({
      tiled: true, bandCount: 18, bandHeightCss: 8192,
    });
  });
  test("band height tracks scale AND the device pixel ratio, never just one of them", () => {
    expect(planTiledCapture({ width: 100, height: 99999 }, 1, 1, undefined).bandHeightCss).toBe(16384);
    expect(planTiledCapture({ width: 100, height: 99999 }, 1, 2, undefined).bandHeightCss).toBe(8192);
    expect(planTiledCapture({ width: 100, height: 99999 }, 2, 2, undefined).bandHeightCss).toBe(4096);
    expect(planTiledCapture({ width: 100, height: 99999 }, 4, 2, undefined).bandHeightCss).toBe(2048);
    // scale below 1 is legal and shrinks the projection, so bands get TALLER, not shorter.
    expect(planTiledCapture({ width: 100, height: 999999 }, 0.5, 2, undefined).bandHeightCss).toBe(16384);
  });
  test("every band, including the last, projects to at most the cap", () => {
    for (const [scale, devicePx, height] of [[1, 2, 140982], [3, 2, 9000], [1, 1, 40000], [1.1, 3, 50000], [0.5, 2, 999999]] as const) {
      const plan = planTiledCapture({ width: 10, height }, scale, devicePx, undefined);
      expect(Math.ceil(plan.bandHeightCss * scale * devicePx)).toBeLessThanOrEqual(CAP);
      const last = height - (plan.bandCount - 1) * plan.bandHeightCss;
      expect(Math.ceil(last * scale * devicePx)).toBeLessThanOrEqual(CAP);
      // The bands must cover the region EXACTLY: a short last band leaves the page's tail off the
      // image, a full-height one clips past the document.
      expect((plan.bandCount - 1) * plan.bandHeightCss + last).toBe(height);
      expect(last).toBeGreaterThan(0);
      expect(last).toBeLessThanOrEqual(plan.bandHeightCss);
    }
  });
  test("tile:false never bands, however far past the cap the projection is", () => {
    expect(planTiledCapture({ width: 1390, height: 140982 }, 1, 2, false).tiled).toBe(false);
    // ... including a width that tiling itself would refuse: at tile:false the encode guard owns
    // the refusal, so this must not throw a second, different message from here.
    expect(() => planTiledCapture({ width: 9000, height: 100 }, 8, 2, false)).not.toThrow();
  });
  test("tile:true splits a region that would have fitted — one band is not a tiling", () => {
    // The flag exists so the banded path is testable on an ordinary page. Returning bandCount 1
    // here would make tile:true a no-op on exactly the pages someone would use it to check seams.
    expect(planTiledCapture({ width: 1390, height: 3000 }, 1, 2, true)).toEqual({ tiled: true, bandCount: 2, bandHeightCss: 1500 });
    expect(planTiledCapture({ width: 1390, height: 3001 }, 1, 2, true)).toEqual({ tiled: true, bandCount: 2, bandHeightCss: 1501 });
    // A region already past the cap is split at the cap, not halved: tile:true is not "split more".
    expect(planTiledCapture({ width: 1390, height: 140982 }, 1, 2, true).bandHeightCss).toBe(8192);
    // A 1 css px region cannot be halved into two whole pixels, and says so by staying at one band.
    expect(planTiledCapture({ width: 10, height: 1 }, 1, 2, true)).toEqual({ tiled: true, bandCount: 1, bandHeightCss: 1 });
  });
  test("a projection too WIDE is refused by name: width cannot be tiled", () => {
    const tooWide = () => planTiledCapture({ width: 1390, height: 140982 }, 8, 2, undefined);
    expect(tooWide).toThrow(/22240 px WIDE/);
    expect(tooWide).toThrow(/width cannot be tiled/);
    // Both real fixes, with numbers a caller can act on rather than "try something smaller".
    expect(tooWide).toThrow(/Lower scale \(at most 5\.89\)/);
    expect(tooWide).toThrow(/renderWidth at most 1024 css px/);
  });
  test("the width refusal is a DriverError with a code, not a bare Error", () => {
    const err = (() => {
      try {
        planTiledCapture({ width: 9000, height: 100 }, 4, 2, undefined);
        return undefined;
      } catch (e) {
        return e;
      }
    })();
    expect(isDriverError(err)).toBe(true);
    expect((err as { code?: string }).code).toBe("page-error");
  });
  test("a scale so large that ONE css px is past the cap is caught by the WIDTH check first", () => {
    // Which is why the driver's own sub-1-band-height guard is documented as unreachable rather
    // than tested as a live branch: any clip is at least 1 css px wide (both clip builders ceil,
    // and a zero-area element is already refused), so scale x ratio past the cap fails the width
    // check before a band height is ever computed. Asserting the unreachability is honest; a test
    // pretending to reach it would not be.
    expect(() => planTiledCapture({ width: 1, height: 100 }, 20000, 2, true)).toThrow(/40000 px WIDE/);
  });
});

/* ---------------------- the CDP driver's own banding, on the wire ---------------------- */

/** A tall document: 1390x140982 css px at device pixel ratio 2, the live-fired case. */
const METRICS_TALL = {
  cssVisualViewport: { clientWidth: 1390, clientHeight: 1064 },
  visualViewport: { clientWidth: 2780, clientHeight: 2128 },
  cssContentSize: { width: 1390, height: 140982 },
};
/** A short document: same viewport, 3000 css px of content. Fits at scale 1 on a ratio-2 display. */
const METRICS_SHORT = {
  cssVisualViewport: { clientWidth: 1390, clientHeight: 1064 },
  visualViewport: { clientWidth: 2780, clientHeight: 2128 },
  cssContentSize: { width: 1390, height: 3000 },
};
function tilingConn(metrics: object) {
  return stubCdpConn((method) => (method === "Page.getLayoutMetrics" ? metrics : { data: "" }));
}
/** Pull every band and count them, the way the real consumer (the stitcher) does. */
async function drainBands(capture: { bands: AsyncIterable<Uint8Array> }): Promise<number> {
  let n = 0;
  for await (const _ of capture.bands) n += 1;
  return n;
}

describe("CdpPageDriver.screenshot: banding on the wire", () => {
  test("a tall document is captured as 18 bands whose clip.y walks the document in CSS px", async () => {
    const { conn, calls } = tilingConn(METRICS_TALL);
    const driver = new CdpPageDriver(conn, fakeTarget("T-tile"), FAKE_CDP_BROWSER);
    const result = await driver.screenshot({}, async (capture) => {
      expect(capture.bandCount).toBe(18);
      expect(capture.bandHeightCss).toBe(8192);
      expect(capture.format).toBe("png");
      return drainBands(capture);
    });
    expect(isTiledCapture(result)).toBe(true);
    const shots = calls.filter((c) => c.method === "Page.captureScreenshot");
    expect(shots.length).toBe(18);
    // CSS px, unmultiplied: 0, 8192, 16384 ... A ratio-2 multiplication here would put band 2 at
    // 16384 and skip 8192 css px of page on every seam.
    expect(shots.map((c) => (c.params?.clip as { y: number }).y).slice(0, 4)).toEqual([0, 8192, 16384, 24576]);
    const heights = shots.map((c) => (c.params?.clip as { height: number }).height);
    expect(heights.slice(0, 17)).toEqual(Array(17).fill(8192));
    // The LAST band is the remainder, and the bands sum to the document exactly.
    expect(heights[17]).toBe(140982 - 17 * 8192);
    expect(heights.reduce((a, b) => a + b, 0)).toBe(140982);
    // Every band is a full-width PNG at the same x and width, or the stitcher refuses them.
    for (const c of shots) {
      expect(c.params?.format).toBe("png");
      expect(c.params?.captureBeyondViewport).toBe(true);
      expect(c.params?.clip).toMatchObject({ x: 0, width: 1390, scale: 1 });
    }
  });
  test("bands are LAZY: nothing is captured until the consumer pulls, and stopping early stops Chrome", async () => {
    const { conn, calls } = tilingConn(METRICS_TALL);
    const driver = new CdpPageDriver(conn, fakeTarget("T-lazy"), FAKE_CDP_BROWSER);
    await driver.screenshot({}, async (capture) => {
      // Accumulating all 18 first would work here and blow up on a 1.4 GB image; the streaming
      // stitcher only helps if the driver is streaming too.
      expect(calls.filter((c) => c.method === "Page.captureScreenshot").length).toBe(0);
      let seen = 0;
      for await (const _ of capture.bands) {
        seen += 1;
        expect(calls.filter((c) => c.method === "Page.captureScreenshot").length).toBe(seen);
        if (seen === 3) break;
      }
      return seen;
    });
    expect(calls.filter((c) => c.method === "Page.captureScreenshot").length).toBe(3);
  });
  test("scale multiplies the band height down, and rides clip.scale on every band", async () => {
    const { conn, calls } = tilingConn(METRICS_SHORT);
    const driver = new CdpPageDriver(conn, fakeTarget("T-tile-scale"), FAKE_CDP_BROWSER);
    await driver.screenshot({ scale: 3 }, drainBands);
    const shots = calls.filter((c) => c.method === "Page.captureScreenshot");
    // 16384 / (3 x 2) = 2730 css px per band; 3000 css px of document is 2 bands.
    expect(shots.length).toBe(2);
    expect(shots.map((c) => c.params?.clip)).toEqual([
      { x: 0, y: 0, width: 1390, height: 2730, scale: 3 },
      { x: 0, y: 2730, width: 1390, height: 270, scale: 3 },
    ]);
  });
  test("a capture that FITS is byte-for-byte the old call: one shot, and NO clip key at all", async () => {
    const { conn, calls } = tilingConn(METRICS_SHORT);
    const driver = new CdpPageDriver(conn, fakeTarget("T-plain"), FAKE_CDP_BROWSER);
    const result = await driver.screenshot({}, async () => "must not be called");
    expect(isTiledCapture(result)).toBe(false);
    const shots = calls.filter((c) => c.method === "Page.captureScreenshot");
    expect(shots.length).toBe(1);
    expect(shots[0]?.params).toEqual({ format: "png", captureBeyondViewport: true });
    expect("clip" in (shots[0]?.params ?? {})).toBe(false);
  });
  test("but the metrics ARE fetched now, on that same plain path — this is the closed wedge gap", async () => {
    const { conn, calls } = tilingConn(METRICS_SHORT);
    const driver = new CdpPageDriver(conn, fakeTarget("T-plain-metrics"), FAKE_CDP_BROWSER);
    await driver.screenshot({}, async () => 0);
    expect(calls.filter((c) => c.method === "Page.getLayoutMetrics").length).toBe(1);
  });
  test("tile:false on an over-cap page refuses BEFORE any capture, with the encode guard's message", async () => {
    const { conn, calls } = tilingConn(METRICS_TALL);
    const driver = new CdpPageDriver(conn, fakeTarget("T-notile"), FAKE_CDP_BROWSER);
    await expect(driver.screenshot({ tile: false }, async () => 0)).rejects.toThrow(/2780x281964 px .*past Chrome's 16384 px per-side limit/);
    expect(calls.filter((c) => c.method === "Page.captureScreenshot").length).toBe(0);
  });
  test("a caller that cannot take bands gets that same refusal, never a capture Chrome would hang on", async () => {
    const { conn, calls } = tilingConn(METRICS_TALL);
    const driver = new CdpPageDriver(conn, fakeTarget("T-noconsumer"), FAKE_CDP_BROWSER);
    await expect(driver.screenshot({})).rejects.toThrow(/past Chrome's 16384 px per-side limit/);
    expect(calls.filter((c) => c.method === "Page.captureScreenshot").length).toBe(0);
  });
  test("tile:true with no band consumer is a caller mistake, and says which", async () => {
    const { conn } = tilingConn(METRICS_SHORT);
    const driver = new CdpPageDriver(conn, fakeTarget("T-noconsumer-true"), FAKE_CDP_BROWSER);
    await expect(driver.screenshot({ tile: true })).rejects.toThrow(/needs a caller that can consume bands/);
  });
  test("an element clip taller than the cap is tiled too, from the element's own x/y", async () => {
    const { conn, calls } = stubCdpConn((method) => {
      if (method === "Page.getLayoutMetrics") return METRICS_TALL;
      if (method === "Runtime.evaluate") return { result: { objectId: "obj-1" } };
      if (method === "DOM.describeNode") return { node: { backendNodeId: 99 } };
      // A 1200x40000 css px element at (40,12) — taller than the cap on its own.
      if (method === "DOM.getBoxModel") return { model: { content: [40, 12, 1240, 12, 1240, 40012, 40, 40012] } };
      return { data: "" };
    });
    const driver = new CdpPageDriver(conn, fakeTarget("T-el"), FAKE_CDP_BROWSER);
    await driver.screenshot({ clip: { css: "#c" } }, drainBands);
    const shots = calls.filter((c) => c.method === "Page.captureScreenshot");
    // 40000 css px tall / 8192 = 5 bands, starting at the element's own y (12), not at 0.
    expect(shots.length).toBe(5);
    expect(shots.map((c) => (c.params?.clip as { y: number }).y)).toEqual([12, 8204, 16396, 24588, 32780]);
    expect(shots.map((c) => (c.params?.clip as { x: number }).x)).toEqual(Array(5).fill(40));
    const heights = shots.map((c) => (c.params?.clip as { height: number }).height);
    expect(heights.reduce((a, b) => a + b, 0)).toBe(40000);
  });
  test("a JPEG banded capture is refused by the driver too, but only once a band is actually pulled", async () => {
    // The user-facing refusal is shared-tools.ts's (it names the fix); this backstop must not
    // pre-empt it, which it did when the check ran before the consumer — live-fired, and the
    // caller saw 'got format "jpeg"' with no advice.
    const { conn } = tilingConn(METRICS_TALL);
    const driver = new CdpPageDriver(conn, fakeTarget("T-jpeg"), FAKE_CDP_BROWSER);
    await expect(driver.screenshot({ format: "jpeg" }, async (capture) => {
      throw new Error(`consumer ran first, ${capture.bandCount} bands offered`);
    })).rejects.toThrow(/consumer ran first, 18 bands offered/);
    await expect(driver.screenshot({ format: "jpeg" }, drainBands)).rejects.toThrow(/PNG-only/);
  });
});

/* ------- element clip: the viewport-frame -> document-frame correction (the scroll bug) ------- */

/**
 * A connection that models the ONE thing the old element-clip path got wrong, and nothing else.
 *
 * Every number is off Chrome/151.0.7922.76 (2026-08-10), a 1390x1064 css viewport on a ratio-2
 * display, `#target` sitting at document y=5000 of a 10,000 css px page:
 *   - DOM.getBoxModel answers in the VIEWPORT frame — the quad came back at y=407, matching
 *     getBoundingClientRect().top, NOT the element's document y of 5000.
 *   - DOM.scrollIntoViewIfNeeded is what put it at 407: it moved the page to scrollY 4593, so the
 *     metrics before and after that call are DIFFERENT. Hence `scrolled`: read the offset before
 *     the scroll and you correct by 0; read it after and you correct by 4593.
 * 700 is used for the x offset (also measured, by scrolling that page horizontally) so a fix that
 * only ever adds the y offset cannot pass.
 */
function scrolledElementConn(box: { x: number; y: number; w: number; h: number }, opts?: { legacyOnly?: boolean; noScroll?: boolean }) {
  let scrolled = false;
  return stubCdpConn((method) => {
    if (method === "DOM.scrollIntoViewIfNeeded") {
      scrolled = true;
      return {};
    }
    if (method === "Page.getLayoutMetrics") {
      const pageX = scrolled && !opts?.noScroll ? 700 : 0;
      const pageY = scrolled && !opts?.noScroll ? 4593 : 0;
      if (opts?.legacyOnly) {
        return {
          layoutViewport: { pageX: pageX * 2, pageY: pageY * 2, clientWidth: 2780, clientHeight: 2128 },
          visualViewport: { pageX, pageY, clientWidth: 2780, clientHeight: 2128 },
          contentSize: { width: 2780, height: 20000 },
        };
      }
      return {
        cssVisualViewport: { pageX, pageY, clientWidth: 1390, clientHeight: 1064 },
        cssLayoutViewport: { pageX, pageY, clientWidth: 1390, clientHeight: 1064 },
        // Deliberately CSS px on visualViewport's offsets and device px on its client size: that is
        // what Chrome really sends, and a fix reading THIS rect and dividing would halve the offset.
        visualViewport: { pageX, pageY, clientWidth: 2780, clientHeight: 2128 },
        layoutViewport: { pageX: pageX * 2, pageY: pageY * 2, clientWidth: 2780, clientHeight: 2128 },
        cssContentSize: { width: 1390, height: 10000 },
        contentSize: { width: 2780, height: 20000 },
      };
    }
    if (method === "Runtime.evaluate") return { result: { objectId: "obj-1" } };
    if (method === "DOM.describeNode") return { node: { backendNodeId: 99 } };
    if (method === "DOM.getBoxModel") {
      const { x, y, w, h } = box;
      return { model: { content: [x, y, x + w, y, x + w, y + h, x, y + h] } };
    }
    return { data: "" };
  });
}
/** The clip that went on the wire for a single (non-banded) capture. */
function sentClip(calls: Array<{ method: string; params?: Record<string, unknown> }>): unknown {
  const shots = calls.filter((c) => c.method === "Page.captureScreenshot");
  expect(shots.length).toBe(1);
  return shots[0]?.params?.clip;
}

describe("CdpPageDriver.screenshot: an element clip is DOCUMENT-absolute, not viewport-relative", () => {
  test("the scroll offset is added to the box model, on both axes", async () => {
    // THE REGRESSION. Before the fix this sent {x:40,y:407} — the element's post-scroll ON-SCREEN
    // position handed to a captureBeyondViewport capture, which reads clip x/y as document
    // coordinates. Live-fired at three page heights (10,000 / 16,578 / 140,982 css px): every one
    // returned a flat slab of page background with no part of the element in it.
    const { conn, calls } = scrolledElementConn({ x: 40, y: 407, w: 1200, h: 250 });
    const driver = new CdpPageDriver(conn, fakeTarget("T-elclip"), FAKE_CDP_BROWSER);
    await driver.screenshot({ clip: { css: "#target" } });
    expect(sentClip(calls)).toEqual({ x: 740, y: 5000, width: 1200, height: 250, scale: 1 });
  });
  test("the offset is read AFTER the scroll settles, and still costs only ONE getLayoutMetrics", async () => {
    // The near-miss fix: correct by an offset read BEFORE DOM.scrollIntoViewIfNeeded moved the
    // page. On a freshly navigated tab that offset is 0, so the clip stays at the broken y=407 and
    // the bug survives its own fix. Ordering is the assertion; the count is the "no extra round
    // trip" half of the same requirement.
    const { conn, calls } = scrolledElementConn({ x: 40, y: 407, w: 1200, h: 250 });
    const driver = new CdpPageDriver(conn, fakeTarget("T-elorder"), FAKE_CDP_BROWSER);
    await driver.screenshot({ clip: { css: "#target" } });
    const scrollIdx = calls.findIndex((c) => c.method === "DOM.scrollIntoViewIfNeeded");
    const metricsIdx = calls.findIndex((c) => c.method === "Page.getLayoutMetrics");
    expect(scrollIdx).toBeGreaterThanOrEqual(0);
    expect(metricsIdx).toBeGreaterThan(scrollIdx);
    expect(calls.filter((c) => c.method === "Page.getLayoutMetrics").length).toBe(1);
  });
  test("an element already in view (offset 0) is untouched — the short-page control", async () => {
    // The case that always worked, and must keep working byte-for-byte: no scroll, no offset, so
    // the box model's own coordinates already ARE document coordinates.
    const { conn, calls } = scrolledElementConn({ x: 0, y: 500, w: 1390, h: 250 }, { noScroll: true });
    const driver = new CdpPageDriver(conn, fakeTarget("T-elshort"), FAKE_CDP_BROWSER);
    await driver.screenshot({ clip: { css: "#target" } });
    expect(sentClip(calls)).toEqual({ x: 0, y: 500, width: 1390, height: 250, scale: 1 });
  });
  test("scale rides the CORRECTED clip, never the viewport one", async () => {
    const { conn, calls } = scrolledElementConn({ x: 40, y: 407, w: 1200, h: 250 });
    const driver = new CdpPageDriver(conn, fakeTarget("T-elscale"), FAKE_CDP_BROWSER);
    await driver.screenshot({ clip: { css: "#target" }, scale: 3 });
    expect(sentClip(calls)).toEqual({ x: 740, y: 5000, width: 1200, height: 250, scale: 3 });
  });
  test("a BANDED element clip walks from the corrected y, not from the on-screen one", async () => {
    // Bands are the one place the error compounds: every band inherits clip.y, so an uncorrected
    // start puts all five of them in the wrong part of the document.
    const { conn, calls } = scrolledElementConn({ x: 40, y: 407, w: 1200, h: 40000 });
    const driver = new CdpPageDriver(conn, fakeTarget("T-elband"), FAKE_CDP_BROWSER);
    await driver.screenshot({ clip: { css: "#target" } }, drainBands);
    const shots = calls.filter((c) => c.method === "Page.captureScreenshot");
    expect(shots.map((c) => (c.params?.clip as { y: number }).y)).toEqual([5000, 13192, 21384, 29576, 37768]);
    expect(shots.map((c) => (c.params?.clip as { x: number }).x)).toEqual(Array(5).fill(740));
  });
  test("on a metrics reply with no css-prefixed rects, the offset stays in the SAME frame as the rest", async () => {
    // The legacy branch. devicePixelsPerCssPx already answers 1 for such a reply (no css rect to
    // form a ratio with) and contentClip already hands Chrome the device-px contentSize, so the
    // offset has to come back in device px too — 9186, not 4593. Correcting into a frame nothing
    // else in the file is using would be a second bug, not a fix.
    const { conn, calls } = scrolledElementConn({ x: 80, y: 814, w: 2400, h: 500 }, { legacyOnly: true });
    const driver = new CdpPageDriver(conn, fakeTarget("T-ellegacy"), FAKE_CDP_BROWSER);
    await driver.screenshot({ clip: { css: "#target" } });
    expect(sentClip(calls)).toEqual({ x: 1480, y: 10000, width: 2400, height: 500, scale: 1 });
  });
});

/* ------------------------ the tool layer: bands in, one file out ------------------------ */

/** A real, complete, decodable PNG: filter-0 rows of a deterministic pattern. Small enough to
 *  build inline, real enough that src/png.ts's stitcher accepts it and produces a valid file. */
function realPng(width: number, height: number, seed: number): Uint8Array {
  const bpr = width * 3;
  const raw = Buffer.alloc(height * (1 + bpr));
  for (let y = 0; y < height; y++) {
    const off = y * (1 + bpr);
    raw[off] = 0; // filter type None
    for (let x = 0; x < width; x++) {
      raw[off + 1 + x * 3] = (seed * 40 + y * 3) & 0xff;
      raw[off + 2 + x * 3] = (x * 17) & 0xff;
      raw[off + 3 + x * 3] = (seed + x + y) & 0xff;
    }
  }
  const chunk = (type: string, data: Buffer): Buffer => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, "latin1"), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body) >>> 0);
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // colour type: truecolour RGB
  return new Uint8Array(Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]));
}

/** A driver whose capture always bands, handing the tool layer real PNGs to stitch. */
function stubTilingDriver(capabilities: ReadonlySet<Capability>, bandHeights: number[], width = 40) {
  const shotCalls: ScreenshotOptions[] = [];
  const pulled: number[] = [];
  const page = {
    info: INFO,
    async screenshot(opts: ScreenshotOptions | undefined, consume: (c: unknown) => Promise<unknown>) {
      shotCalls.push(opts ?? {});
      const total = bandHeights.reduce((a, b) => a + b, 0);
      async function* gen(): AsyncGenerator<Uint8Array> {
        for (const [i, h] of bandHeights.entries()) {
          pulled.push(i);
          yield realPng(width, h, i + 1);
        }
      }
      const consumed = await consume({
        bands: gen(), bandCount: bandHeights.length, bandHeightCss: bandHeights[0],
        clip: { x: 0, y: 0, width, height: total }, format: "png",
      });
      return { tiled: true, format: "png", bandCount: bandHeights.length, bandHeightCss: bandHeights[0], consumed };
    },
    async release(): Promise<void> {},
  };
  const driver = { scheme: "cdp", capabilities, async page(): Promise<PageDriver> { return page as unknown as PageDriver; } };
  return { driver: driver as unknown as BrowserDriver, shotCalls, pulled };
}

describe("resolveTileMode", () => {
  test("omitted is AUTO, and costs no capability on any backend", () => {
    expect(resolveTileMode(undefined, FIREFOX_CAPS, "png", undefined)).toBeUndefined();
    expect(resolveTileMode(undefined, CHROME_CAPS, "png", undefined)).toBeUndefined();
    // Auto with jpeg/base64 is legal: they only collide if the projection actually needs bands,
    // and that is not known until the driver has measured the page.
    expect(resolveTileMode(undefined, CHROME_CAPS, "jpeg", true)).toBeUndefined();
  });
  test("false passes through everywhere, and never asks for a capability", () => {
    expect(resolveTileMode(false, FIREFOX_CAPS, "jpeg", true)).toBe(false);
    expect(resolveTileMode(false, CHROME_CAPS, "png", undefined)).toBe(false);
  });
  test("true needs screenshot.tile, and names the workaround when the backend lacks it", () => {
    expect(resolveTileMode(true, CHROME_CAPS, "png", undefined)).toBe(true);
    expect(() => resolveTileMode(true, FIREFOX_CAPS, "png", undefined)).toThrow(/not supported by this backend/);
    expect(() => resolveTileMode(true, FIREFOX_CAPS, "png", undefined)).toThrow(/--browser chrome/);
  });
  test("true + jpeg and true + returnBase64 are refused, each naming its own fix", () => {
    expect(() => resolveTileMode(true, CHROME_CAPS, "jpeg", undefined)).toThrow(/PNG-only/);
    expect(() => resolveTileMode(true, CHROME_CAPS, "jpeg", undefined)).toThrow(/format:"png"/);
    expect(() => resolveTileMode(true, CHROME_CAPS, "png", true)).toThrow(/'returnBase64' cannot be combined/);
    expect(() => resolveTileMode(true, CHROME_CAPS, "png", true)).toThrow(/Read the file at the returned path/);
  });
  test("a non-boolean is refused rather than coerced", () => {
    expect(() => resolveTileMode("yes" as unknown as boolean, CHROME_CAPS, "png", undefined)).toThrow(/must be true, false, or omitted/);
  });
});

describe("takeScreenshot() tiled wiring", () => {
  const TILE_PATH = join(tmpdir(), "cdp-toolkit-tile.test.png");
  async function shootTiled(driver: BrowserDriver, args: Record<string, unknown> = {}) {
    return takeScreenshot(driver, { savePath: TILE_PATH, ...args });
  }
  afterAll(async () => {
    await rm(TILE_PATH, { force: true });
  });

  test("pipes the driver's bands into the stitcher and reports the STITCHER's measured size", async () => {
    const { driver, pulled } = stubTilingDriver(CHROME_CAPS, [30, 30, 7]);
    const result = await shootTiled(driver, { tile: true });
    expect(result.tiled).toBe(true);
    expect(result.bands).toBe(3);
    expect(pulled).toEqual([0, 1, 2]); // every band captured, in order
    // 30 + 30 + 7: the height is the one the stitcher actually wrote, not 3 x the band height.
    expect({ width: result.width, height: result.height }).toEqual({ width: 40, height: 67 });
    expect(result.format).toBe("png");
    expect(result.path).toBe(TILE_PATH);
    // The file on disk really is that image — read back with the SAME decoder the one-shot path uses.
    const onDisk = new Uint8Array(await readFile(TILE_PATH));
    expect(imagePixelSize(onDisk)).toEqual({ width: 40, height: 67 });
    expect(result.bytes).toBe(onDisk.byteLength);
  });
  test("a one-shot capture carries NEITHER new field: absent means not tiled", async () => {
    const { driver } = stubDriver(CHROME_CAPS, pngHeader(2780, 2128));
    const result = await shoot(driver);
    expect("tiled" in result).toBe(false);
    expect("bands" in result).toBe(false);
  });
  test("tile reaches the driver only when it was given, so the default call is unchanged", async () => {
    const { driver: autoDriver, shotCalls: autoCalls } = stubDriver(CHROME_CAPS, pngHeader(10, 10));
    await shoot(autoDriver);
    expect("tile" in (autoCalls[0] ?? {})).toBe(false);
    const { driver: offDriver, shotCalls: offCalls } = stubDriver(CHROME_CAPS, pngHeader(10, 10));
    await shoot(offDriver, { tile: false });
    expect(offCalls[0]?.tile).toBe(false);
  });
  test("AUTO + jpeg refuses from the consumer, before a single band is captured", async () => {
    const { driver, pulled } = stubTilingDriver(CHROME_CAPS, [30, 30]);
    await expect(shootTiled(driver, { format: "jpeg" })).rejects.toThrow(/PNG-only/);
    // The count and the region ride along, so the refusal explains WHY this capture needed bands.
    await expect(shootTiled(driver, { format: "jpeg" })).rejects.toThrow(/needs 2 bands \(40x60 css px/);
    expect(pulled).toEqual([]);
  });
  test("AUTO + returnBase64 refuses the same way, for the size reason rather than the format one", async () => {
    const { driver, pulled } = stubTilingDriver(CHROME_CAPS, [30, 30]);
    await expect(shootTiled(driver, { returnBase64: true })).rejects.toThrow(/'returnBase64' cannot be combined with a tiled capture/);
    expect(pulled).toEqual([]);
  });
  test("a render size applied around a tiled capture still rides back on the result", async () => {
    const { driver } = stubTilingDriver(CHROME_CAPS, [20, 20]);
    // The stub's screenshot() echoes no render fields, so this pins the tool layer's own guard:
    // renderSize is reported from the DRIVER's answer, never from what was asked for.
    const result = await shootTiled(driver, { tile: true, renderWidth: 900, renderHeight: 700 });
    expect(result.tiled).toBe(true);
    expect("renderSize" in result).toBe(false);
  });
});

describe("screenshot.tile capability (ADR-001: a PARAM gap, and an UNMEASURED one)", () => {
  test("only Chrome declares it, and take_screenshot stays available on both backends", () => {
    expect(CHROME_CAPS.has("screenshot.tile")).toBe(true);
    expect(FIREFOX_CAPS.has("screenshot.tile")).toBe(false);
    expect(toolAvailability("chrome").available).toContain("take_screenshot");
    expect(toolAvailability("firefox").available).toContain("take_screenshot");
    expect(REQUIRED_CAPABILITIES.take_screenshot).toBeUndefined();
  });
  test("the BiDi driver refuses tile:true itself, saying it is unmeasured rather than impossible", async () => {
    // A real BidiPageDriver over a connection that would throw if touched: the refusal has to
    // happen before any browsingContext.captureScreenshot is attempted.
    const conn = { send() { throw new Error("no BiDi command should be sent"); } } as unknown as BidiConnection;
    const page = new BidiPageDriver(conn, "ctx-1", INFO, { scheme: "bidi" } as unknown as BrowserDriver);
    await expect(page.screenshot({ tile: true })).rejects.toThrow(/not supported by this backend/);
    await expect(page.screenshot({ tile: true })).rejects.toThrow(/was not driven for it/);
    await expect(page.screenshot({ tile: true })).rejects.toThrow(/--browser chrome/);
  });
});
