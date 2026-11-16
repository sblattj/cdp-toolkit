/**
 * Firefox 160 emulate (media features, offline network) against a REAL throwaway headless Firefox.
 * Launches its own browser on a free port with a temp profile (never 9222/9223/9333) and kills it
 * in afterAll. The machine's default color scheme may itself be dark, so every assertion is
 * relative to a measured baseline: emulate the OPPOSITE scheme, then clear and expect the baseline.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { launchFirefox, type LaunchedFirefox } from "../src/bidi/launch.ts";
import { BIDI_CAPABILITY_MIN_FIREFOX, createFirefoxDriver } from "../src/bidi/driver.ts";
import type { BrowserDriver, PageDriver } from "../src/driver.ts";

declare const Bun: {
  serve(opts: { port: number; hostname: string; fetch(req: Request): Response }): { port: number; stop(close?: boolean): void };
};

const DARK = "matchMedia('(prefers-color-scheme: dark)').matches";
const FETCH = "fetch('/ping').then(() => 'ok', () => 'err')";

let ff: LaunchedFirefox;
let server: { port: number; stop(close?: boolean): void };
let driver: BrowserDriver;
let page: PageDriver;
let baseline: boolean;

beforeAll(async () => {
  server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("<p>x</p>", { headers: { "content-type": "text/html" } }) });
  ff = await launchFirefox({ headless: true });
  driver = createFirefoxDriver(ff.port);
  page = await driver.page(undefined);
  await page.navigate({ url: `http://127.0.0.1:${server.port}/` });
  baseline = (await page.evaluate(DARK)) as boolean;
}, 60_000);

afterAll(async () => {
  await page?.emulate({ clearOverrides: true }).catch(() => undefined);
  await ff?.close();
  server?.stop(true);
});

const scheme = (dark: boolean) => ({ mediaFeatures: [{ name: "prefers-color-scheme", value: dark ? "dark" : "light" }] });

test("capability rows are declared at 160 and in the driver's capability set", () => {
  expect(BIDI_CAPABILITY_MIN_FIREFOX["emulate.mediaFeatures"]).toBe(160);
  expect(BIDI_CAPABILITY_MIN_FIREFOX["emulate.networkConditions"]).toBe(160);
  expect(driver.capabilities.has("emulate.mediaFeatures")).toBe(true);
  expect(driver.capabilities.has("emulate.networkConditions")).toBe(true);
});

test("RED CONTROL: with no override applied, the scheme equals the baseline (so the 'flipped' assertion fails)", async () => {
  const now = (await page.evaluate(DARK)) as boolean;
  expect(now).toBe(baseline);
  expect(now === !baseline).toBe(false);
});

test("mediaFeatures flips prefers-color-scheme to dark and light, clearOverrides restores the baseline", async () => {
  const r = await page.emulate(scheme(true));
  expect(r.applied).toContain("mediaFeatures");
  expect(await page.evaluate(DARK)).toBe(true);
  await page.emulate(scheme(false));
  expect(await page.evaluate(DARK)).toBe(false);
  await page.emulate({ clearOverrides: true });
  expect(await page.evaluate(DARK)).toBe(baseline);
});

test("override set by one driver instance is in force for a SECOND instance on the same port; clear from the second clears media AND network", async () => {
  await page.emulate({ ...scheme(!baseline), networkConditions: { offline: true } });
  const driver2 = createFirefoxDriver(ff.port);
  const page2 = await driver2.page(undefined);
  expect(page2.info.id).toBe(page.info.id);
  expect(await page2.evaluate(DARK)).toBe(!baseline);
  expect(await page2.evaluate("navigator.onLine")).toBe(false);
  await page2.emulate({ clearOverrides: true });
  expect(await page.evaluate(DARK)).toBe(baseline);
  expect(await page.evaluate("navigator.onLine")).toBe(true);
});

test("offline: navigator.onLine false and fetch rejects, then back online", async () => {
  expect(await page.evaluate("navigator.onLine")).toBe(true);
  expect(await page.evaluate(FETCH, { awaitPromise: true })).toBe("ok");
  const r = await page.emulate({ networkConditions: { offline: true } });
  expect(r.applied).toContain("networkConditions");
  expect(await page.evaluate("navigator.onLine")).toBe(false);
  expect(await page.evaluate(FETCH, { awaitPromise: true })).toBe("err");
  await page.emulate({ networkConditions: { offline: false } });
  expect(await page.evaluate("navigator.onLine")).toBe(true);
  expect(await page.evaluate(FETCH, { awaitPromise: true })).toBe("ok");
});

test("Chrome-shaped throttle is refused 'unsupported' naming offline-only, and changes nothing", async () => {
  for (const nc of [
    { latency: 200 },
    { offline: false, downloadThroughput: 50_000, uploadThroughput: 20_000 },
    { offline: true, latency: 100 },
  ]) {
    const err = await page.emulate({ ...scheme(!baseline), networkConditions: nc }).then(() => undefined, (e: unknown) => e as { kind?: string; message: string });
    expect(err?.kind ?? (err as { code?: string } | undefined)?.code).toBe("unsupported");
    expect(err?.message).toContain("only emulates offline");
  }
  // refusal happened before any state change: neither scheme nor network moved
  expect(await page.evaluate(DARK)).toBe(baseline);
  expect(await page.evaluate("navigator.onLine")).toBe(true);
});

test("a media TYPE is refused 'unsupported', not ignored", async () => {
  const err = await page.emulate({ media: "print" }).then(() => undefined, (e: unknown) => e as { kind?: string; code?: string; message: string });
  expect(err?.kind ?? err?.code).toBe("unsupported");
  expect(err?.message).toContain("print");
});
