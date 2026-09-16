/**
 * Unit tests for the "frame:<url-substring>" selector arm (issue #7 fix 3).
 *
 * FOUR SEPARATE CLAIMS ARE UNDER TEST, mirroring worker-selector.test.ts, and
 * they fail in different places:
 *   1. the pure match (src/frames.ts) — what counts as a hit, a miss, an
 *      ambiguity, and what is deliberately NOT an iframe target;
 *   2. Chrome's resolver (client.ts's pickTarget, reached through resolveTarget
 *      with the HTTP listing stubbed) — including that an iframe hit meets the
 *      SAME lease gate a bare iframe id does, the deliberate difference from
 *      the worker arm's bypass;
 *   3. the Firefox refusal (bidi/driver.ts's pickContext, reached through the
 *      exported resolveContext against a stub connection, the same seam
 *      test/leases.test.ts uses) — asserting the REAL DriverErrorCode rather
 *      than only the message text;
 *   4. the page-only resolver (shared-tools.ts's pickPage) refusing the arm
 *      instead of mis-reporting it as a bad id.
 *
 * One INVARIANT CARRIED OVER from worker-selector.test.ts: worker: must never
 * match an iframe and frame: must never match a worker, now that both arms see
 * the same listing — a cross-match would evaluate somewhere the caller did not
 * ask for.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  frameAmbiguityMessage,
  frameMissMessage,
  frameNeedle,
  isFrameSelector,
  isFrameTargetType,
  resolveFrameTargets,
  FRAME_EMPTY_NEEDLE_MESSAGE,
  FRAME_SELECTOR_PAGE_ONLY_MESSAGE,
  FRAME_SELECTOR_UNSUPPORTED_MESSAGE,
} from "../src/frames.ts";
import { resolveWorkerTargets } from "../src/workers.ts";
import type { Target } from "../src/types.ts";
import { pickPage } from "../src/shared-tools.ts";
import { markLongLivedProcess } from "../src/leases.ts";
import { createFirefoxDriver, resolveContext } from "../src/bidi/driver.ts";
import { createCdpDriver } from "../src/cdp/driver.ts";
import type { BrowsingContextInfo } from "../src/bidi/protocol.ts";
import { page, stubDriver } from "./helpers/stub-driver.ts";

const EMBEDDER = "https://example.test/";
const AD_URL = "https://ads.example.com/frame.html";

function target(id: string, type: string, url: string): Target {
  return { id, type, url, title: id, webSocketDebuggerUrl: `ws://127.0.0.1:9999/devtools/page/${id}` } as Target;
}

/* --------------------------- 1. the pure match --------------------------- */

describe("resolveFrameTargets (pure)", () => {
  const listing = [
    target("P1", "page", EMBEDDER),
    target("F1", "iframe", AD_URL),
    target("F2", "iframe", "https://player.example.org/embed"),
    target("W1", "service_worker", "chrome-extension://abc/background.js"),
  ];

  test("matches a unique iframe by url substring", () => {
    expect(resolveFrameTargets(listing, "ads.example.com").matches.map((m) => m.id)).toEqual(["F1"]);
    expect(resolveFrameTargets(listing, "player").matches.map((m) => m.id)).toEqual(["F2"]);
  });

  test("never matches a page or a worker, even one whose url contains the needle", () => {
    // P1's url contains "example", and so does the worker's extension origin in
    // other listings; the arm must stay type-scoped or a substring shared with
    // the embedder would evaluate in the parent.
    const { matches } = resolveFrameTargets(listing, "example");
    expect(matches.map((m) => m.id).sort()).toEqual(["F1", "F2"]);
    expect(matches.some((m) => m.id === "P1")).toBe(false);
    expect(resolveFrameTargets(listing, "background.js").matches).toEqual([]);
  });

  test("an empty needle matches NOTHING rather than everything", () => {
    // "anything".includes("") is true, so a naive bare `frame:` would silently
    // mean "whichever iframe happens to be first".
    expect(resolveFrameTargets(listing, "").matches).toEqual([]);
  });

  test("reports every live iframe for the miss message, needle or not", () => {
    expect(resolveFrameTargets(listing, "nothing-matches-this").liveFrames.map((f) => f.id)).toEqual(["F1", "F2"]);
  });

  test("ambiguity is reported as both matches, never a first-match", () => {
    const two = [...listing, target("F3", "iframe", "https://ads.example.com/second.html")];
    expect(resolveFrameTargets(two, "ads.example.com").matches.map((m) => m.id)).toEqual(["F1", "F3"]);
  });

  test("the ambiguity message names every candidate's url AND id", () => {
    const msg = frameAmbiguityMessage("ads", [target("F1", "iframe", AD_URL), target("F3", "iframe", "https://ads.example.com/2")]);
    expect(msg).toContain("more than one");
    expect(msg).toContain(`${AD_URL} (F1)`);
    expect(msg).toContain("https://ads.example.com/2 (F3)");
  });

  test("the miss message names the OOPIF fact: same-origin iframes are not targets", () => {
    const msg = frameMissMessage("nope", [target("F1", "iframe", AD_URL)]);
    expect(msg).toContain("no out-of-process iframe whose url contains 'nope'");
    expect(msg).toContain(AD_URL); // the live alternatives are listed
    expect(msg).toMatch(/same-origin iframe[\s\S]*NOT a target/);
    expect(frameMissMessage("nope", [])).toContain("no out-of-process iframes are live");
  });

  test("selector helpers", () => {
    expect(isFrameSelector("frame:abc")).toBe(true);
    expect(isFrameSelector("worker:abc")).toBe(false);
    expect(isFrameSelector(undefined)).toBe(false);
    expect(frameNeedle("frame:abc")).toBe("abc");
    expect(isFrameTargetType("iframe")).toBe(true);
    expect(isFrameTargetType("page")).toBe(false);
    expect(isFrameTargetType(undefined)).toBe(false);
  });

  test("CARRIED-OVER INVARIANT: worker: still never matches an iframe with frames in the listing", () => {
    // worker-selector.test.ts pins that worker: ignores an iframe whose url
    // contains the needle; this pins the same listing viewed from the new arm.
    const { matches } = resolveWorkerTargets(listing, "ads.example.com");
    expect(matches).toEqual([]);
    // And the mirror: frame: never matches a worker.
    expect(resolveFrameTargets(listing, "background.js").matches).toEqual([]);
  });
});

/* ------------- 2. Chrome's resolver + the lease-gate consistency ------------- */

describe("client.ts pickTarget's frame arm", () => {
  let dir = "";
  const originalArtifactDir = process.env.CDP_ARTIFACT_DIR;
  const originalRequire = process.env.CDP_REQUIRE_LEASE;
  const realFetch = globalThis.fetch;

  // resolveTarget reaches the browser ONLY through GET /json/list, so stubbing
  // fetch exercises the real resolver with no browser.
  function stubListing(targets: Target[]): void {
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/json/list")) return new Response(JSON.stringify(targets), { status: 200 });
      throw new Error(`unexpected fetch in test: ${url}`);
    }) as typeof fetch;
  }

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "cdp-frame-selector-"));
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

  const listing = () => [target("P1", "page", EMBEDDER), target("F1", "iframe", AD_URL)];
  const leaseFiles = async (): Promise<string[]> => (await readdir(dir)).filter((f) => f.startsWith("lease-"));

  test("a unique substring resolves to the iframe target id", async () => {
    stubListing(listing());
    const { resolveTarget } = await import("../src/client.ts");
    const hit = await resolveTarget("frame:ads.example.com");
    expect(hit.id).toBe("F1");
    expect(hit.type).toBe("iframe");
  });

  test("a bare iframe target id still resolves (the all-targets bare-id branch, unchanged)", async () => {
    stubListing(listing());
    const { resolveTarget } = await import("../src/client.ts");
    expect((await resolveTarget("F1")).type).toBe("iframe");
  });

  test("an empty needle is refused with a usable message", async () => {
    stubListing(listing());
    const { resolveTarget } = await import("../src/client.ts");
    await expect(resolveTarget("frame:")).rejects.toThrow(FRAME_EMPTY_NEEDLE_MESSAGE);
    await expect(resolveTarget("frame:")).rejects.toThrow(/needs a substring/);
  });

  test("a miss lists the live iframes and teaches the OOPIF fact", async () => {
    stubListing(listing());
    const { resolveTarget } = await import("../src/client.ts");
    await expect(resolveTarget("frame:same-origin.example")).rejects.toThrow(/NOT a target/);
    await expect(resolveTarget("frame:same-origin.example")).rejects.toThrow(/ads\.example\.com\/frame\.html/);
  });

  test("ambiguity names every candidate id and url, never a first match", async () => {
    stubListing([...listing(), target("F9", "iframe", "https://ads.example.com/banner")]);
    const { resolveTarget } = await import("../src/client.ts");
    const err = await resolveTarget("frame:ads.example.com").catch((e: unknown) => e as Error);
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toContain("more than one out-of-process iframe");
    expect(err.message).toContain(`${AD_URL} (F1)`);
    expect(err.message).toContain("https://ads.example.com/banner (F9)");
  });

  test("a frame: hit meets the SAME lease gate as the bare id — no worker-style bypass", async () => {
    // The worker arm bypasses assertLeaseOk entirely (a worker is not a tab).
    // An iframe deliberately does NOT: the bare-id path has always gated it,
    // and frame: is a way of naming the same target, not a new permission.
    // Strict mode therefore mints a lease keyed on the FRAME id, exactly as a
    // bare-id iframe hit does — pinned here so a future change is a decision.
    markLongLivedProcess();
    process.env.CDP_REQUIRE_LEASE = "1";
    stubListing(listing());
    const { resolveTarget } = await import("../src/client.ts");

    await resolveTarget("frame:ads.example.com");
    const files = await leaseFiles();
    expect(files.length).toBe(1);
    expect(files[0]).toContain("F1");
    // The bare id to the same iframe reuses that auto lease, it does not stack.
    await resolveTarget("F1");
    expect((await leaseFiles()).length).toBe(1);
  });
});

/* ------------- 3. the Firefox refusal (pickContext) and the capability ------------- */

describe("bidi pickContext refuses frame:, with the unsupported code", () => {
  // The same stub seam test/leases.test.ts drives resolveContext through: only
  // browsingContext.getTree is sent before the arm's refusal fires.
  const context = (id: string, url: string) =>
    ({ children: null, clientWindow: "w", context: id, originalOpener: null, url, userContext: "default" }) as unknown as BrowsingContextInfo;
  function stubConn(contexts: BrowsingContextInfo[]) {
    const conn = {
      async send(method: string) {
        if (method === "browsingContext.getTree") return { contexts };
        throw new Error(`unexpected BiDi command in test: ${method}`);
      },
    };
    return conn as unknown as Parameters<typeof resolveContext>[0];
  }

  test("a frame: selector is refused with DriverErrorCode 'unsupported' naming the capability", async () => {
    const err = await resolveContext(stubConn([context("FF-A", EMBEDDER)]), "frame:ads.example.com").catch((e: unknown) => e);
    expect(typeof (err as { code?: unknown }).code).toBe("string");
    expect((err as { code?: string }).code).toBe("unsupported");
    expect((err as Error).message).toBe(FRAME_SELECTOR_UNSUPPORTED_MESSAGE);
    expect((err as Error).message).toContain("frame.targets");
    expect((err as Error).message).toContain("Chrome-only");
  });

  test("a page selector still resolves through the same resolver", async () => {
    expect((await resolveContext(stubConn([context("FF-A", EMBEDDER)]), "url:example.test")).context).toBe("FF-A");
  });

  test("THE REAL DRIVERS: chrome declares frame.targets, firefox does not", () => {
    // Static capability sets, no port dialed. Asserting against the real
    // objects is the point: a stub could claim anything.
    expect(createCdpDriver().capabilities.has("frame.targets")).toBe(true);
    expect(createFirefoxDriver(0).capabilities.has("frame.targets")).toBe(false);
  });
});

/* ------------- 4. the page-only resolver refuses the arm ------------- */

describe("pickPage refuses frame: rather than mis-reporting it", () => {
  test("chrome: explains the tool is page-only and which tools accept frame:", async () => {
    const { driver } = stubDriver({ pages: [page("T1")] });
    await expect(pickPage(driver, [page("T1")], "frame:ads.example.com")).rejects.toThrow(FRAME_SELECTOR_PAGE_ONLY_MESSAGE);
    await expect(pickPage(driver, [page("T1")], "frame:ads.example.com")).rejects.toThrow(/close_page, select_page, release_page, claim_page/);
  });

  test("firefox: explains the capability gap instead", async () => {
    const { driver } = stubDriver({ scheme: "bidi", pages: [page("T1")] });
    await expect(pickPage(driver, [page("T1")], "frame:ads.example.com")).rejects.toThrow(/frame\.targets.*Chrome-only/s);
  });

  test("neither message reads as a bad target id", async () => {
    const { driver } = stubDriver({ pages: [page("T1")] });
    await expect(pickPage(driver, [page("T1")], "frame:ads.example.com")).rejects.not.toThrow(/no target with id/);
  });
});
