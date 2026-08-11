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
import { describe, expect, test } from "bun:test";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BrowserDriver, Capability, PageDriver, PageInfo, ScreenshotOptions } from "../src/driver.ts";
import { REQUIRED_CAPABILITIES } from "../src/driver.ts";
import { imagePixelSize, resolveScreenshotScale, takeScreenshot } from "../src/shared-tools.ts";
import { createCdpDriver } from "../src/cdp/driver.ts";
import { createFirefoxDriver } from "../src/bidi/driver.ts";
import { toolAvailability } from "../src/capabilities.ts";

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
function stubDriver(capabilities: ReadonlySet<Capability>, data: Uint8Array) {
  const shotCalls: ScreenshotOptions[] = [];
  const page = {
    info: INFO,
    async screenshot(opts?: ScreenshotOptions): Promise<{ data: Uint8Array; format: "png" | "jpeg" }> {
      shotCalls.push(opts ?? {});
      return { data, format: "png" };
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

/* --------------------------------- capability gating --------------------------------- */

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
