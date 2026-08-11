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
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BrowserDriver, Capability, PageDriver, PageInfo, ScreenshotOptions, ScreenshotResult } from "../src/driver.ts";
import {
  REQUIRED_CAPABILITIES, clearViewportRecord, readViewportRecord, renderRestoreFailureNote, viewportRecordFile, writeViewportRecord,
} from "../src/driver.ts";
import { imagePixelSize, resolveRenderSize, resolveScreenshotScale, takeScreenshot } from "../src/shared-tools.ts";
import { CdpPageDriver, createCdpDriver } from "../src/cdp/driver.ts";
import { createFirefoxDriver } from "../src/bidi/driver.ts";
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
