/**
 * Unit tests for take_snapshot's OOPIF iframe markers (issue #7 fix 1), all driver-level on
 * stubs — no browser. The live behavior being modeled was researched against real Chrome and is
 * stated in cdp/driver.ts's OOPIF MARKERS block: Accessibility.getFullAXTree emits the <iframe>
 * ELEMENT's AX node (role "Iframe", backendDOMNodeId set) but NOT the subtree of an
 * out-of-process iframe; same-origin iframe subtrees ARE merged into the same response.
 *
 * Stubbing follows screenshot-scale.test.ts's CdpPageDriver pattern: a CdpConnection stub answers
 * Accessibility/DOM/Page commands from canned payloads, and client.ts's listTargets() — which the
 * driver calls directly and which normally does GET /json/list over HTTP — is intercepted by
 * replacing globalThis.fetch for the duration of this file (restored in afterAll, since bun runs
 * the whole suite in one process). That exercises the real listTargets code path, not a mock of
 * it, so a change to its wire shape breaks here rather than in production.
 *
 * The five pins, one per describe block:
 *   1. an OOPIF iframe's line carries the marker: extras frame=<frame id (= CDP target id)> and
 *      frameUrl=<frame url>, rendered quoted by renderSnapshotLine;
 *   2. a same-origin frame (no iframe-type target) gets NO marker, and DOM.getFrameOwner is not
 *      even asked for it;
 *   3. interactiveOnly still emits the MARKED iframe (Iframe is not in INTERACTIVE_ROLES; the
 *      marker is the special case) while unmarked noninteractive nodes stay dropped;
 *   4. detection failure (DOM.getFrameOwner throws for every frame; separately, /json/list
 *      itself failing) is failure-soft: the snapshot succeeds with no markers at all;
 *   5. every non-iframe line is byte-identical to the pre-marker rendering.
 */
import { afterAll, describe, expect, test } from "bun:test";
import type { BrowserDriver, PageDriver } from "../src/driver.ts";
import { takeSnapshot } from "../src/shared-tools.ts";
import { CdpPageDriver } from "../src/cdp/driver.ts";
import type { CdpConnection } from "../src/client.ts";
import type { Target } from "../src/types.ts";

/* ------------------------------- CDP stub plumbing ------------------------------- */

const OOPIF_FRAME_ID = "A1B2C3D4E5";
const OOPIF_FRAME_URL = "https://pay.test/checkout";
const SAME_ORIGIN_FRAME_ID = "SAME0001";
const SAME_ORIGIN_FRAME_URL = "https://shop.test/widget";

/**
 * The canned AX tree, shaped the way Chrome answers getFullAXTree on a page with two iframes:
 * the OOPIF iframe node has NO children in the tree (its subtree lives in another process),
 * the same-origin iframe's button IS merged in. axString() reads {value} off role/name blobs.
 */
const axv = (value: string): { type: string; value: string } => ({ type: "internal", value });
const AX_NODES = [
  { nodeId: "n-webarea", role: axv("WebArea"), name: axv("Shop"), backendDOMNodeId: 100, childIds: ["n-oopif", "n-same", "n-text", "n-heading", "n-submit"] },
  { nodeId: "n-oopif", role: axv("Iframe"), name: axv("Checkout"), backendDOMNodeId: 4821, parentId: "n-webarea", childIds: [] },
  { nodeId: "n-same", role: axv("Iframe"), name: axv("Widget"), backendDOMNodeId: 5100, parentId: "n-webarea", childIds: ["n-samebtn"] },
  { nodeId: "n-samebtn", role: axv("button"), name: axv("Buy"), backendDOMNodeId: 5101, parentId: "n-same" },
  { nodeId: "n-text", role: axv("StaticText"), name: axv("hello"), backendDOMNodeId: 200, parentId: "n-webarea" },
  { nodeId: "n-heading", role: axv("heading"), name: axv("Hi"), backendDOMNodeId: 201, parentId: "n-webarea" },
  { nodeId: "n-submit", role: axv("button"), name: axv("Submit"), backendDOMNodeId: 202, parentId: "n-webarea" },
];

/** /json/list as Chrome serves it: the page target plus an iframe-type target per OOPIF. */
const LIST_TARGETS: Target[] = [
  { id: "MAIN0001", type: "page", title: "Shop", url: "https://shop.test/", webSocketDebuggerUrl: "ws://127.0.0.1:9222/devtools/page/MAIN0001" },
  { id: OOPIF_FRAME_ID, type: "iframe", title: "", url: OOPIF_FRAME_URL, webSocketDebuggerUrl: "ws://127.0.0.1:9222/devtools/frame/" + OOPIF_FRAME_ID },
];

type ConnStub = { conn: CdpConnection; calls: Array<{ method: string; params?: Record<string, unknown> }> };

function stubCdpConn(onSend: (method: string, params?: Record<string, unknown>) => unknown): ConnStub {
  const calls: Array<{ method: string; params?: Record<string, unknown> }> = [];
  const conn = {
    calls,
    async send(method: string, params?: Record<string, unknown>) {
      calls.push({ method, params });
      return onSend(method, params);
    },
    close() { /* the driver's release() calls this; nothing is open */ },
  } as unknown as CdpConnection;
  return { conn, calls };
}

/** The standard wire stub: AX tree + frame owner; throw via opts.failMethod. */
function standardConn(opts: { failMethod?: string } = {}): ConnStub {
  return stubCdpConn((method, params) => {
    if (method === opts.failMethod) throw new Error(`stub: ${method} failed`);
    if (method === "Accessibility.getFullAXTree") return { nodes: AX_NODES };
    if (method === "DOM.getFrameOwner") {
      // Ownership filter exactly as Chrome applies it: this page owns the OOPIF (its frame id
      // resolves to an owner element) and throws for every other frame id — which is how
      // same-origin frames (no iframe target, never queried) and other tabs' OOPIFs are excluded.
      if (params?.frameId === OOPIF_FRAME_ID) return { backendNodeId: 4821 };
      throw new Error(`stub: getFrameOwner called for unexpected frame ${String(params?.frameId)}`);
    }
    return {};
  });
}

function driverOn(conn: CdpConnection): CdpPageDriver {
  const target: Target = { id: "MAIN0001", type: "page", title: "Shop", url: "https://shop.test/", webSocketDebuggerUrl: "ws://x" };
  return new CdpPageDriver(conn, target, { scheme: "cdp" } as unknown as BrowserDriver);
}

/* ------------------------- listTargets interception ------------------------- */

const realFetch = globalThis.fetch;

/** Serve /json/list from LIST_TARGETS (or reject, to fail the detection round-trip). */
function interceptListTargets(mode: "ok" | "fail" = "ok"): void {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url.endsWith("/json/list")) {
      if (mode === "fail") throw new Error("stub: /json/list unreachable");
      return new Response(JSON.stringify(LIST_TARGETS), { status: 200, headers: { "content-type": "application/json" } });
    }
    return realFetch(input as RequestInfo, init);
  }) as typeof fetch;
}

afterAll(() => {
  globalThis.fetch = realFetch;
});

/* ------------------------------- the five pins ------------------------------- */

describe("snapshot OOPIF markers: full mode", () => {
  test("the OOPIF iframe's node carries frame=<target id> + frameUrl, keyed to its owning <iframe> element", async () => {
    interceptListTargets("ok");
    const stub = standardConn();
    const nodes = await driverOn(stub.conn).snapshot();
    const oopifLine = nodes.find((n) => n.uid === "cdp:4821");
    // The marker's frame id IS the CDP target id of the OOPIF (== its frame id), per the research.
    expect(oopifLine).toBeDefined();
    expect(oopifLine?.extras).toEqual({ frame: OOPIF_FRAME_ID, frameUrl: OOPIF_FRAME_URL });
    // Detection asked for the OOPIF frame's owner (and only that frame's): the map is built from
    // DOM.getFrameOwner, not guessed from the AX tree.
    const ownerCalls = stub.calls.filter((c) => c.method === "DOM.getFrameOwner");
    expect(ownerCalls.map((c) => c.params?.frameId)).toEqual([OOPIF_FRAME_ID]);
    // Depth accounting is untouched: same depths as the pre-marker walk (WebArea 0, children 1,
    // the same-origin iframe's merged button 2).
    expect(nodes.map((n) => [n.uid, n.depth])).toEqual([
      ["cdp:100", 0], ["cdp:4821", 1], ["cdp:5100", 1], ["cdp:5101", 2], ["cdp:200", 1], ["cdp:201", 1], ["cdp:202", 1],
    ]);
  });

  test("a same-origin frame (no iframe-type target) gets NO marker and NO getFrameOwner round-trip", async () => {
    interceptListTargets("ok");
    const stub = standardConn();
    const nodes = await driverOn(stub.conn).snapshot();
    const sameOriginLine = nodes.find((n) => n.uid === "cdp:5100");
    expect(sameOriginLine).toBeDefined();
    expect(sameOriginLine?.extras).toBeUndefined();
    expect(nodes.find((n) => n.uid === "cdp:5101")?.extras).toBeUndefined();
    expect(stub.calls.filter((c) => c.method === "DOM.getFrameOwner").length).toBe(1);
  });
});

describe("snapshot OOPIF markers: interactiveOnly", () => {
  test("emits the MARKED iframe (Iframe is not interactive) and drops unmarked noninteractive nodes", async () => {
    interceptListTargets("ok");
    const nodes = await driverOn(standardConn().conn).snapshot({ interactiveOnly: true });
    // Order follows the AX walk: the marked Iframe, then the same-origin iframe's merged button,
    // then the page's own button. The unmarked same-origin Iframe, StaticText, and heading are
    // gone, and nothing indents (interactiveOnly's flat rendering rule is unchanged).
    expect(nodes).toEqual([
      { uid: "cdp:4821", role: "Iframe", name: "Checkout", depth: 0, extras: { frame: OOPIF_FRAME_ID, frameUrl: OOPIF_FRAME_URL } },
      { uid: "cdp:5101", role: "button", name: "Buy", depth: 0 },
      { uid: "cdp:202", role: "button", name: "Submit", depth: 0 },
    ]);
  });
});

describe("snapshot OOPIF markers: failure-soft detection", () => {
  test("DOM.getFrameOwner throwing for every frame leaves a successful, marker-free snapshot", async () => {
    interceptListTargets("ok");
    const nodes = await driverOn(standardConn({ failMethod: "DOM.getFrameOwner" }).conn).snapshot();
    expect(nodes.find((n) => n.uid === "cdp:4821")?.extras).toBeUndefined();
    expect(nodes.length).toBe(7);
  });

  test("listTargets itself failing (/json/list unreachable) is equally soft", async () => {
    interceptListTargets("fail");
    const stub = standardConn();
    const nodes = await driverOn(stub.conn).snapshot();
    expect(nodes.find((n) => n.uid === "cdp:4821")?.extras).toBeUndefined();
    // The frame owner is never asked: target correlation happens before the per-frame calls.
    expect(stub.calls.filter((c) => c.method === "DOM.getFrameOwner").length).toBe(0);
  });
});

describe("snapshot OOPIF markers: rendered lines", () => {
  test("the marker renders quoted via the real takeSnapshot pipeline; every other line is unchanged", async () => {
    interceptListTargets("ok");
    const stub = standardConn();
    const page = driverOn(stub.conn);
    const browser = { scheme: "cdp", async page(): Promise<PageDriver> { return page; } } as unknown as BrowserDriver;
    const { snapshot: rendered, nodeCount } = await takeSnapshot(browser, {});
    expect(nodeCount).toBe(7);
    expect(rendered).toBe(
      '[100] WebArea "Shop"\n' +
      `  [4821] Iframe "Checkout" [frame="${OOPIF_FRAME_ID}" frameUrl="${OOPIF_FRAME_URL}"]\n` +
      '  [5100] Iframe "Widget"\n' +
      '    [5101] button "Buy"\n' +
      '  [200] StaticText "hello"\n' +
      '  [201] heading "Hi"\n' +
      '  [202] button "Submit"',
    );
  });

  test("with markers suppressed, the rendering is byte-identical to the pre-marker output", async () => {
    interceptListTargets("fail");
    const page = driverOn(standardConn().conn);
    const browser = { scheme: "cdp", async page(): Promise<PageDriver> { return page; } } as unknown as BrowserDriver;
    const { snapshot: rendered } = await takeSnapshot(browser, {});
    expect(rendered).toBe(
      '[100] WebArea "Shop"\n' +
      '  [4821] Iframe "Checkout"\n' +
      '  [5100] Iframe "Widget"\n' +
      '    [5101] button "Buy"\n' +
      '  [200] StaticText "hello"\n' +
      '  [201] heading "Hi"\n' +
      '  [202] button "Submit"',
    );
  });
});
