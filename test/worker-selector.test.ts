/**
 * Unit tests for the 1.9.0 "worker:<substring>" selector arm.
 *
 * FOUR SEPARATE CLAIMS ARE UNDER TEST, and they fail in different places:
 *   1. the pure match (src/workers.ts) — what counts as a hit, a miss, an
 *      ambiguity, and what is deliberately NOT a worker;
 *   2. Chrome's resolver (client.ts's pickTarget, reached through resolveTarget
 *      with the HTTP listing stubbed) — including THE LEASE FENCE, which is the
 *      one behavior here that quietly corrupts state rather than erroring;
 *   3. evaluate_script's argument validation and the Firefox refusal, asserted
 *      against the REAL createFirefoxDriver capability set rather than a stub
 *      that could claim anything;
 *   4. the page-only resolvers refusing the arm instead of mis-reporting it as
 *      a bad id.
 *
 * The wake path itself is NOT unit-testable and is not faked here: it is three
 * live CDP round trips whose behavior (a domain that only exists on a page
 * session, a start command that reports success for a scope that does not
 * exist) is exactly what a stub would get wrong. It is proven in
 * test/extension-smoke.ts against a real browser and a real MV3 extension.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  isWorkerSelector,
  isWorkerTargetType,
  resolveWorkerTargets,
  workerMissMessage,
  workerNeedle,
  WORKER_SELECTOR_PAGE_ONLY_MESSAGE,
  WORKER_SELECTOR_UNSUPPORTED_MESSAGE,
} from "../src/workers.ts";
import type { Target } from "../src/types.ts";
import { evaluateScript, pickPage, resolveWorkerSelectorFor } from "../src/shared-tools.ts";
import { markLongLivedProcess } from "../src/leases.ts";
import { createFirefoxDriver } from "../src/bidi/driver.ts";
import { createCdpDriver } from "../src/cdp/driver.ts";
import type { BrowserDriver, PageInfo } from "../src/driver.ts";
import { page, stubDriver } from "./helpers/stub-driver.ts";

const EXT = "ekgaohljhieodkfggjkfgmmamfpngdhn";
const SW_URL = `chrome-extension://${EXT}/background.js`;

function target(id: string, type: string, url: string): Target {
  return { id, type, url, title: id, webSocketDebuggerUrl: `ws://127.0.0.1:9999/devtools/page/${id}` } as Target;
}

/* --------------------------- 1. the pure match --------------------------- */

describe("resolveWorkerTargets (pure)", () => {
  const listing = [
    target("P1", "page", "https://example.test/1"),
    target("W1", "service_worker", SW_URL),
    target("W2", "shared_worker", "https://example.test/shared-worker.js"),
    target("F1", "iframe", `chrome-extension://${EXT}/frame.html`),
  ];

  test("matches a service worker by extension id", () => {
    const { matches } = resolveWorkerTargets(listing, EXT);
    expect(matches.map((m) => m.id)).toEqual(["W1"]);
  });

  test("matches by script filename", () => {
    expect(resolveWorkerTargets(listing, "background.js").matches.map((m) => m.id)).toEqual(["W1"]);
  });

  test("matches shared workers too", () => {
    expect(resolveWorkerTargets(listing, "shared-worker").matches.map((m) => m.id)).toEqual(["W2"]);
  });

  test("never matches a non-worker target, even one whose url contains the needle", () => {
    // F1 is an iframe on the extension's own origin: it contains the needle and
    // must still be invisible to this arm, or `worker:<id>` would resolve to a
    // frame and evaluate somewhere the caller did not ask for.
    const { matches } = resolveWorkerTargets(listing, EXT);
    expect(matches.some((m) => m.id === "F1")).toBe(false);
  });

  test("an empty needle matches NOTHING rather than everything", () => {
    // "anything".includes("") is true, so the naive implementation of a bare
    // `worker:` silently means "whichever worker is first".
    expect(resolveWorkerTargets(listing, "").matches).toEqual([]);
  });

  test("reports every running worker for the miss message, needle or not", () => {
    expect(resolveWorkerTargets(listing, "nothing-matches-this").liveWorkers.map((w) => w.id)).toEqual(["W1", "W2"]);
  });

  test("ambiguity is reported as two matches, never a first-match", () => {
    const two = [...listing, target("W3", "service_worker", `chrome-extension://${EXT}/other.js`)];
    expect(resolveWorkerTargets(two, EXT).matches.map((m) => m.id)).toEqual(["W1", "W3"]);
  });

  test("selector helpers", () => {
    expect(isWorkerSelector("worker:abc")).toBe(true);
    expect(isWorkerSelector("label:abc")).toBe(false);
    expect(isWorkerSelector(undefined)).toBe(false);
    expect(workerNeedle("worker:abc")).toBe("abc");
    expect(isWorkerTargetType("service_worker")).toBe(true);
    expect(isWorkerTargetType("page")).toBe(false);
    expect(isWorkerTargetType(undefined)).toBe(false);
  });

  test("the wake:false miss message teaches the MV3 eviction fact", () => {
    // The whole point of the message: "no such worker" is nearly always "asleep".
    const msg = workerMissMessage("abc", { wakeAttempted: false, liveWorkers: [] });
    expect(msg).toContain("idle-evicted");
    expect(msg).toContain("wake:true");
  });

  test("the wake-attempted miss message names the registered scopes instead", () => {
    const msg = workerMissMessage("abc", { wakeAttempted: true, registeredScopes: ["chrome-extension://zzz/"] });
    expect(msg).toContain("chrome-extension://zzz/");
    expect(msg).not.toContain("You passed wake:false");
  });
});

/* ------------- 2. Chrome's resolver + THE LEASE FENCE ------------- */

describe("client.ts pickTarget's worker arm, and the lease fence", () => {
  let dir = "";
  const originalArtifactDir = process.env.CDP_ARTIFACT_DIR;
  const originalRequire = process.env.CDP_REQUIRE_LEASE;
  const realFetch = globalThis.fetch;

  // resolveTarget reaches the browser ONLY through GET /json/list, so stubbing
  // fetch exercises the real resolver and the real lease gate with no browser.
  function stubListing(targets: Target[]): void {
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/json/list")) return new Response(JSON.stringify(targets), { status: 200 });
      throw new Error(`unexpected fetch in test: ${url}`);
    }) as typeof fetch;
  }

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "cdp-worker-selector-"));
    process.env.CDP_ARTIFACT_DIR = dir;
  });
  afterAll(async () => {
    if (originalArtifactDir === undefined) delete process.env.CDP_ARTIFACT_DIR;
    else process.env.CDP_ARTIFACT_DIR = originalArtifactDir;
    globalThis.fetch = realFetch;
    await rm(dir, { recursive: true, force: true });
  });
  beforeEach(async () => {
    for (const f of await readdir(dir)) await rm(join(dir, f), { force: true });
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
    if (originalRequire === undefined) delete process.env.CDP_REQUIRE_LEASE;
    else process.env.CDP_REQUIRE_LEASE = originalRequire;
    markLongLivedProcess(false);
  });

  const listing = () => [target("P1", "page", "https://example.test/1"), target("W1", "service_worker", SW_URL)];
  const leaseFiles = async (): Promise<string[]> => (await readdir(dir)).filter((f) => f.startsWith("lease-"));

  test("resolves a running worker by substring", async () => {
    stubListing(listing());
    const { resolveTarget } = await import("../src/client.ts");
    expect((await resolveTarget(`worker:${EXT}`)).id).toBe("W1");
  });

  test("a bare worker target id still resolves (the all-targets bare-id branch)", async () => {
    stubListing(listing());
    const { resolveTarget } = await import("../src/client.ts");
    expect((await resolveTarget("W1")).type).toBe("service_worker");
  });

  test("an empty needle is refused with a usable message", async () => {
    stubListing(listing());
    const { resolveTarget } = await import("../src/client.ts");
    await expect(resolveTarget("worker:")).rejects.toThrow(/needs a substring/);
  });

  test("a miss names the running workers and teaches eviction", async () => {
    stubListing(listing());
    const { resolveTarget } = await import("../src/client.ts");
    await expect(resolveTarget("worker:not-installed")).rejects.toThrow(/idle-evicted/);
  });

  test("ambiguity names both candidates", async () => {
    stubListing([...listing(), target("W9", "service_worker", `chrome-extension://${EXT}/second.js`)]);
    const { resolveTarget } = await import("../src/client.ts");
    await expect(resolveTarget(`worker:${EXT}`)).rejects.toThrow(/matches more than one running worker/);
  });

  test("STRICT MODE MINTS NO LEASE FOR A WORKER — and a page in the same listing proves the gate was armed", async () => {
    markLongLivedProcess();
    process.env.CDP_REQUIRE_LEASE = "1";
    stubListing(listing());
    const { resolveTarget } = await import("../src/client.ts");

    await resolveTarget(`worker:${EXT}`);
    expect(await leaseFiles()).toEqual([]);
    await resolveTarget("W1"); // the bare-id route to the same worker
    expect(await leaseFiles()).toEqual([]);

    // CONTROL. Without this the test would also pass with strict mode simply
    // off, which is the failure mode that makes a zero-lease assertion worthless.
    await resolveTarget("P1");
    const after = await leaseFiles();
    expect(after.length).toBe(1);
    expect(after[0]).toContain("P1");
  });
});

/* ------------- 3. evaluate_script validation + the Firefox refusal ------------- */

/**
 * A LOCAL stub, not test/helpers/stub-driver.ts's: this is the only test that
 * needs `capabilities` and `page()`, which that helper deliberately omits, and
 * widening the shared helper would change the shape every other test sees.
 */
function evalDriver(opts: { worker?: boolean } = {}): { driver: BrowserDriver; acquired: string[]; workerCalls: Array<{ selector: string; wake: boolean }> } {
  const acquired: string[] = [];
  const workerCalls: Array<{ selector: string; wake: boolean }> = [];
  const info: PageInfo = { id: "W1", url: SW_URL, title: "sw", type: "service_worker" };
  const driver = {
    scheme: "cdp",
    capabilities: new Set(opts.worker === false ? [] : ["worker.targets"]),
    async listPages(): Promise<PageInfo[]> {
      return [];
    },
    async page(selector: string) {
      acquired.push(selector);
      return {
        info,
        async evaluate(expression: string) {
          return `evaluated:${expression}`;
        },
        async release() {},
      };
    },
    ...(opts.worker === false
      ? {}
      : {
          async resolveWorkerTarget(selector: string, o: { wake: boolean }): Promise<PageInfo> {
            workerCalls.push({ selector, wake: o.wake });
            return info;
          },
        }),
  };
  return { driver: driver as unknown as BrowserDriver, acquired, workerCalls };
}

describe("evaluate_script's worker routing and validation", () => {
  test("a worker: target is resolved to a bare id and acquired through the ordinary page path", async () => {
    const { driver, acquired, workerCalls } = evalDriver();
    const value = await evaluateScript(driver, { target: `worker:${EXT}`, expression: "1+1" });
    expect(value).toBe("evaluated:1+1");
    expect(workerCalls).toEqual([{ selector: `worker:${EXT}`, wake: true }]);
    // The id, NOT the selector: the acquisition must be the same one every
    // other selector makes, so savePath/args/exception handling cannot diverge.
    expect(acquired).toEqual(["W1"]);
  });

  test("wake defaults to true and wake:false is passed through verbatim", async () => {
    const { driver, workerCalls } = evalDriver();
    await evaluateScript(driver, { target: `worker:${EXT}`, expression: "1", wake: false });
    expect(workerCalls[0]).toEqual({ selector: `worker:${EXT}`, wake: false });
  });

  test("'wake' on a PAGE target is refused, never silently ignored", async () => {
    const { driver } = evalDriver();
    await expect(evaluateScript(driver, { target: "active", expression: "1", wake: true })).rejects.toThrow(
      /'wake' only applies to a target of the form 'worker:/,
    );
  });

  test("'wake' must be a boolean", async () => {
    const { driver } = evalDriver();
    await expect(
      evaluateScript(driver, { target: `worker:${EXT}`, expression: "1", wake: "yes" as unknown as boolean }),
    ).rejects.toThrow(/'wake' must be a boolean/);
  });

  test("a backend without Capability 'worker.targets' refuses the arm and names the gap", async () => {
    const { driver } = evalDriver({ worker: false });
    await expect(evaluateScript(driver, { target: `worker:${EXT}`, expression: "1" })).rejects.toThrow(
      /worker.targets.*Chrome-only/s,
    );
  });

  test("THE REAL DRIVERS: chrome declares worker.targets, firefox does not", () => {
    // Static capability sets, no port dialed (see capabilities.ts). Asserting
    // against the real objects is the point: a stub could claim anything.
    expect(createCdpDriver().capabilities.has("worker.targets")).toBe(true);
    expect(createFirefoxDriver(0).capabilities.has("worker.targets")).toBe(false);
  });

  test("THE REAL FIREFOX DRIVER refuses a worker: target with the capability message", async () => {
    const firefox = createFirefoxDriver(0);
    await expect(resolveWorkerSelectorFor(firefox, `worker:${EXT}`, true)).rejects.toThrow(WORKER_SELECTOR_UNSUPPORTED_MESSAGE);
    // And through the tool's own front door, which is what a caller hits.
    await expect(evaluateScript(firefox, { target: `worker:${EXT}`, expression: "1" })).rejects.toThrow(
      /WebDriver BiDi has no extension service-worker target/,
    );
  });
});

/* ------------- 4. the page-only resolvers refuse the arm ------------- */

describe("pickPage refuses worker: rather than mis-reporting it", () => {
  test("chrome: explains the tool is page-only and points at evaluate_script", async () => {
    const { driver } = stubDriver({ pages: [page("T1")] });
    await expect(pickPage(driver, [page("T1")], `worker:${EXT}`)).rejects.toThrow(WORKER_SELECTOR_PAGE_ONLY_MESSAGE);
  });

  test("firefox: explains the capability gap instead", async () => {
    const { driver } = stubDriver({ scheme: "bidi", pages: [page("T1")] });
    await expect(pickPage(driver, [page("T1")], `worker:${EXT}`)).rejects.toThrow(/WebDriver BiDi has no extension/);
  });

  test("neither message reads as a bad target id", async () => {
    const { driver } = stubDriver({ pages: [page("T1")] });
    await expect(pickPage(driver, [page("T1")], `worker:${EXT}`)).rejects.not.toThrow(/no target with id/);
  });
});
