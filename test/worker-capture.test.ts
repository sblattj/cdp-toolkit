/**
 * Unit tests for the 1.9.1 worker arm on the console/network readers
 * (list_network_requests, get_network_request, list_console_messages).
 *
 * WHAT IS AND IS NOT TESTABLE WITHOUT A BROWSER. The READ path is: resolve a
 * target, then parse a JSONL buffer off disk. Both halves are reachable with
 * `/json/list` stubbed, so these tests run the REAL resolver, the REAL lease
 * gate and the REAL buffer parser with no Chrome at all — which is what makes
 * the lease-fence assertion here worth something.
 *
 * The CAPTURE path (reload:true / includeBody) opens a WebSocket to the worker
 * and depends on facts a stub would get wrong: that Network.enable works on a
 * worker session, that Page.enable does NOT exist there, and that holding the
 * session suppresses idle-eviction. All three were measured against Chrome
 * 151.0.7922.109 and are asserted end-to-end in test/extension-smoke.ts. Nothing
 * here fakes them.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listNetworkRequests, getNetworkRequest } from "../src/tools/network.ts";
import { listConsoleMessages, getConsoleMessage } from "../src/tools/console.ts";
import { assertWakeApplies, recFile, resolveRecorderTarget } from "../src/tools/recorder.ts";
import {
  listConsoleMessages as bidiListConsoleMessages,
  listNetworkRequests as bidiListNetworkRequests,
  getNetworkRequest as bidiGetNetworkRequest,
} from "../src/bidi-tools.ts";
import { createFirefoxDriver } from "../src/bidi/driver.ts";
import { markLongLivedProcess } from "../src/leases.ts";
import { WORKER_SELECTOR_UNSUPPORTED_MESSAGE } from "../src/workers.ts";
import type { Target } from "../src/types.ts";

const EXT = "ekgaohljhieodkfggjkfgmmamfpngdhn";
const SW_URL = `chrome-extension://${EXT}/background.js`;
const WORKER = `worker:${EXT}`;

function target(id: string, type: string, url: string): Target {
  return { id, type, url, title: id, webSocketDebuggerUrl: `ws://127.0.0.1:9999/devtools/page/${id}` } as Target;
}
const listing = (): Target[] => [target("P1", "page", "https://example.test/1"), target("W1", "service_worker", SW_URL)];

let dir = "";
const originalArtifactDir = process.env.CDP_ARTIFACT_DIR;
const originalRequire = process.env.CDP_REQUIRE_LEASE;
const realFetch = globalThis.fetch;

/** The tools reach the browser ONLY through GET /json/list on the read path. */
function stubListing(targets: Target[]): void {
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.endsWith("/json/list")) return new Response(JSON.stringify(targets), { status: 200 });
    throw new Error(`unexpected fetch in test: ${url}`);
  }) as typeof fetch;
}

/** Write a recorder buffer for `targetId` containing one request and one log. */
async function seedBuffer(targetId: string): Promise<void> {
  const lines = [
    {
      kind: "network",
      method: "Network.requestWillBeSent",
      ts: 1,
      params: { requestId: "R1", type: "Fetch", request: { url: "https://api.test/orders", method: "POST", headers: { accept: "*/*" } } },
    },
    {
      kind: "network",
      method: "Network.responseReceived",
      ts: 2,
      params: { requestId: "R1", response: { status: 201, statusText: "Created", mimeType: "application/json", headers: { "x-req": "1" } } },
    },
    { kind: "network", method: "Network.loadingFinished", ts: 3, params: { requestId: "R1", encodedDataLength: 42 } },
    {
      kind: "console",
      method: "Runtime.consoleAPICalled",
      ts: 4,
      params: { type: "log", args: [{ type: "string", value: "sw-said-hello" }] },
    },
  ];
  await writeFile(recFile(targetId), lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
}

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "cdp-worker-capture-"));
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

/* ------------------ 1. each tool really reaches the worker arm ------------------ */

describe("the three readers resolve a worker target (per tool, through its own front door)", () => {
  test("list_network_requests reads the worker's buffer via worker:<substring>", async () => {
    stubListing(listing());
    await seedBuffer("W1");
    const res = await listNetworkRequests({ target: WORKER });
    expect(res.target.id).toBe("W1");
    expect(res.target.url).toBe(SW_URL);
    expect(res.count).toBe(1);
    expect(res.requests[0]).toMatchObject({ url: "https://api.test/orders", method: "POST", status: 201, state: "finished" });
  });

  test("list_network_requests also takes a BARE worker target id", async () => {
    stubListing(listing());
    await seedBuffer("W1");
    expect((await listNetworkRequests({ target: "W1" })).count).toBe(1);
  });

  test("get_network_request matches inside the worker's buffer", async () => {
    stubListing(listing());
    await seedBuffer("W1");
    const hit = await getNetworkRequest({ target: WORKER, url: "api.test/orders" });
    expect(hit.requestId).toBe("R1");
    expect(hit.responseHeaders).toEqual({ "x-req": "1" });
  });

  test("list_console_messages reads the worker's console entries", async () => {
    stubListing(listing());
    await seedBuffer("W1");
    const res = await listConsoleMessages({ target: WORKER });
    expect(res.target.id).toBe("W1");
    expect(res.messages.map((m) => m.text)).toEqual(["sw-said-hello"]);
  });

  test("get_console_message resolves the same worker buffer (not advertised, but must not mis-resolve)", async () => {
    stubListing(listing());
    await seedBuffer("W1");
    expect((await getConsoleMessage({ target: WORKER, index: 0 })).text).toBe("sw-said-hello");
  });

  test("a page target is untouched by any of this", async () => {
    stubListing(listing());
    await seedBuffer("P1");
    expect((await listNetworkRequests({ target: "index:0" })).target.id).toBe("P1");
  });
});

/* ---------------- 2. the read path's own miss/ambiguity messages ---------------- */

describe("read-path resolution messages", () => {
  test("a miss does NOT promise that waking would help, and points at reload:true", async () => {
    stubListing([target("P1", "page", "https://example.test/1")]);
    const err = await listNetworkRequests({ target: WORKER }).catch((e: unknown) => e as Error);
    expect(err).toBeInstanceOf(Error);
    // The eviction teaching survives...
    expect((err as Error).message).toContain("idle-evicted");
    // ...but not the wake:true promise, which is false on a read: a restarted
    // worker has a NEW target id and therefore an empty buffer.
    expect((err as Error).message).not.toContain("wake:true (the default)");
    expect((err as Error).message).toContain("reload:true");
  });

  test("an empty needle is refused rather than matching whichever worker is first", async () => {
    stubListing(listing());
    await expect(listConsoleMessages({ target: "worker:" })).rejects.toThrow(/needs a substring/);
  });

  test("ambiguity names both candidates instead of silently picking one", async () => {
    stubListing([...listing(), target("W9", "service_worker", `chrome-extension://${EXT}/second.js`)]);
    await expect(listNetworkRequests({ target: WORKER })).rejects.toThrow(/matches more than one running worker/);
  });

  test("resolveRecorderTarget(capture:false) never wakes: it only reads the listing", async () => {
    // If this path could wake, the stub would blow up on the unexpected
    // /json/version fetch that openBrowser() makes. That it throws the read-path
    // message instead is the proof no wake was attempted.
    stubListing([target("P1", "page", "https://example.test/1")]);
    await expect(resolveRecorderTarget(WORKER, { capture: false })).rejects.toThrow(/only READS a buffer/);
  });
});

/* ----------------------------- 3. wake validation ----------------------------- */

describe("'wake' is accepted only where it can do something", () => {
  test("refused on a page target, with the reason a bare id cannot be woken either", () => {
    expect(() => assertWakeApplies("active", true, true)).toThrow(/only applies to a target of the form 'worker:/);
    expect(() => assertWakeApplies("W1", true, true)).toThrow(/mints a NEW id/);
  });

  test("refused on a read-only call even for a worker target", () => {
    expect(() => assertWakeApplies(WORKER, true, false)).toThrow(/only applies when a capture is being started/);
  });

  test("accepted for a worker capture, and absent is always fine", () => {
    expect(() => assertWakeApplies(WORKER, true, true)).not.toThrow();
    expect(() => assertWakeApplies(WORKER, false, true)).not.toThrow();
    expect(() => assertWakeApplies("active", undefined, false)).not.toThrow();
  });

  test("a non-boolean wake is refused", () => {
    expect(() => assertWakeApplies(WORKER, "yes" as unknown as boolean, true)).toThrow(/'wake' must be a boolean/);
  });

  test("each tool enforces it through its own front door, BEFORE touching the browser", async () => {
    // No fetch stub is installed here on purpose: if validation ran late, these
    // would fail with a connection error instead of the teaching message.
    globalThis.fetch = (async () => {
      throw new Error("the browser must not be contacted for an invalid wake");
    }) as typeof fetch;
    await expect(listNetworkRequests({ target: "active", reload: true, wake: true })).rejects.toThrow(/only applies to a target/);
    await expect(listConsoleMessages({ target: "active", reload: true, wake: false })).rejects.toThrow(/only applies to a target/);
    await expect(listNetworkRequests({ target: WORKER, wake: true })).rejects.toThrow(/only applies when a capture is being started/);
    await expect(listConsoleMessages({ target: WORKER, wake: true })).rejects.toThrow(/only applies when a capture is being started/);
    // get_network_request's capture is includeBody+url; metadata reads are not one.
    await expect(getNetworkRequest({ target: WORKER, requestId: "R1", wake: true })).rejects.toThrow(
      /only applies when a capture is being started/,
    );
  });
});

/* ------------------------------ 4. THE LEASE FENCE ------------------------------ */

describe("worker reads mint no leases, under real strict mode", () => {
  const leaseFiles = async (): Promise<string[]> => (await readdir(dir)).filter((f) => f.startsWith("lease-"));

  test("a worker read mints ZERO lease files — and a page read proves the gate was armed", async () => {
    markLongLivedProcess();
    process.env.CDP_REQUIRE_LEASE = "1";
    stubListing(listing());
    await seedBuffer("W1");
    await seedBuffer("P1");

    await listNetworkRequests({ target: WORKER });
    await listConsoleMessages({ target: WORKER });
    await getNetworkRequest({ target: "W1", requestId: "R1" });
    expect(await leaseFiles()).toEqual([]);

    // THE CONTROL. Without it, "zero leases" is also what a test with strict
    // mode accidentally off would report.
    await listNetworkRequests({ target: "P1" });
    const after = await leaseFiles();
    expect(after.length).toBe(1);
    expect(after[0]).toContain("P1");
  });
});

/* ---------------------- 5. the Firefox refusal, for real ---------------------- */

describe("Firefox refuses the arm on all three tools, from its REAL capability set", () => {
  test("createFirefoxDriver(0) does not declare worker.targets", () => {
    expect(createFirefoxDriver(0).capabilities.has("worker.targets")).toBe(false);
  });

  test("each tool refuses with the capability message WITHOUT launching a browser", async () => {
    // Port 0 is never dialable: if the refusal came after driver.page(), these
    // would hang or fail with a connection error rather than this message.
    const firefox = createFirefoxDriver(0);
    for (const call of [
      () => bidiListNetworkRequests(firefox, { target: WORKER }),
      () => bidiGetNetworkRequest(firefox, { target: WORKER, url: "x" }),
      () => bidiListConsoleMessages(firefox, { target: WORKER }),
    ]) {
      await expect(call()).rejects.toThrow(WORKER_SELECTOR_UNSUPPORTED_MESSAGE);
    }
  });

  test("the refusal names the protocol gap, not a typo", async () => {
    await expect(bidiListNetworkRequests(createFirefoxDriver(0), { target: WORKER })).rejects.toThrow(
      /WebDriver BiDi has no extension service-worker target/,
    );
  });

  test("a page selector on Firefox is NOT refused by this gate (it is only the worker arm)", async () => {
    // It must fail trying to reach a browser, not with the capability message.
    const err = await bidiListNetworkRequests(createFirefoxDriver(0), { target: "active" }).catch((e: unknown) => e as Error);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).not.toContain("worker.targets");
  });
});
