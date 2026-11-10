/**
 * Recording fake CDP endpoint, built on Bun.serve (HTTP + WebSocket on one port).
 *
 * It speaks the slice of the DevTools protocol the toolkit's real tool code uses for
 * take_snapshot, take_screenshot, list_pages and the click path, and it RECORDS everything it
 * sees: every HTTP request and every WebSocket message, tagged with the target it hit. A test that
 * asserts "read-only click sends zero messages" needs a recorder known to see clicks; the control
 * for that lives in test/fake-cdp-server.test.ts.
 *
 * Usage:
 *   const fake = new FakeCdpServer();
 *   const { base } = await fake.start();   // e.g. http://127.0.0.1:43211
 *   ...run the real client with CDP_BASE=base...
 *   fake.messages  // [{ targetId: "PAGE1" | "browser", method, params }]
 *   fake.requests  // [{ path }]
 *   fake.reset();  // clears the recordings (keeps targets and handlers)
 *   await fake.stop();
 */

/** A 1x1 transparent PNG. */
export const PNG_1X1_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

// tsconfig has no bun-types (only `node`), so the Bun runtime is reached untyped.
interface WsLike {
  data: { targetId: string };
  send(s: string): void;
}
interface BunServer {
  port: number;
  stop(force?: boolean): Promise<void> | void;
  upgrade(req: Request, opts: { data: { targetId: string } }): boolean;
}
const BunRuntime = (globalThis as unknown as { Bun: { serve(opts: unknown): BunServer } }).Bun;

export interface FakeTarget {
  id: string;
  type?: string;
  title?: string;
  url?: string;
}

export interface RecordedRequest {
  path: string;
}

export interface RecordedMessage {
  /** The page target id, or "browser" for the browser-level socket. */
  targetId: string;
  method: string;
  params: unknown;
}

export type CdpHandler = (params: any, ctx: { targetId: string }) => unknown | Promise<unknown>;

export interface FakeCdpOptions {
  /** `Browser` string in /json/version. Default "Chrome/150.0.0.0 (fake)". */
  browser?: string;
  targets?: FakeTarget[];
  /** Per-method overrides, merged over the built-in handlers. A thrown Error becomes a CDP error reply. */
  handlers?: Record<string, CdpHandler>;
}

/** A tiny accessibility tree: a root web area, a heading and one button. */
export const CANNED_AX_NODES = [
  { nodeId: "1", ignored: false, role: { type: "role", value: "RootWebArea" }, name: { type: "computedString", value: "Fake page" }, childIds: ["2", "3"], backendDOMNodeId: 1 },
  { nodeId: "2", ignored: false, role: { type: "role", value: "heading" }, name: { type: "computedString", value: "Hello" }, parentId: "1", childIds: [], backendDOMNodeId: 2 },
  { nodeId: "3", ignored: false, role: { type: "role", value: "button" }, name: { type: "computedString", value: "Go" }, parentId: "1", childIds: [], backendDOMNodeId: 3 },
];

const DEFAULT_TARGETS: FakeTarget[] = [{ id: "PAGE1", type: "page", title: "Fake page", url: "https://fake.test/" }];

export class FakeCdpServer {
  readonly requests: RecordedRequest[] = [];
  readonly messages: RecordedMessage[] = [];
  browser: string;
  targets: FakeTarget[];
  /** Per-method handlers; assign more at any time (`fake.handlers["Foo.bar"] = () => ({})`). */
  handlers: Record<string, CdpHandler>;

  private server: BunServer | undefined;
  private readonly initial: { browser: string; targets: FakeTarget[]; handlers: Record<string, CdpHandler> };
  private nextTarget = 2;

  constructor(opts: FakeCdpOptions = {}) {
    this.browser = opts.browser ?? "Chrome/150.0.0.0 (fake)";
    this.targets = (opts.targets ?? DEFAULT_TARGETS).map((t) => ({ ...t }));
    this.handlers = { ...opts.handlers };
    this.initial = {
      browser: this.browser,
      targets: this.targets.map((t) => ({ ...t })),
      handlers: { ...this.handlers },
    };
  }

  get base(): string {
    if (!this.server) throw new Error("FakeCdpServer is not started");
    return `http://127.0.0.1:${this.server.port}`;
  }

  /** `port` 0 (the default) lets the OS pick; a fixed port lets a test start an endpoint LATE
   *  on an address a server was already configured with. */
  async start(port = 0): Promise<{ base: string; port: number }> {
    if (this.server) return { base: this.base, port: this.server.port as number };
    this.server = BunRuntime.serve({
      hostname: "127.0.0.1",
      port,
      fetch: (req: Request, server: BunServer) => this.onFetch(req, server),
      websocket: {
        message: (ws: WsLike, raw: string | Buffer) => void this.onWsMessage(ws, raw),
      },
    });
    return { base: this.base, port: this.server.port as number };
  }

  async stop(): Promise<void> {
    const s = this.server;
    this.server = undefined;
    if (s) await s.stop(true);
  }

  /** Clear recordings and restore the initial targets, browser string and handlers. */
  reset(): void {
    this.requests.length = 0;
    this.messages.length = 0;
    this.browser = this.initial.browser;
    this.targets = this.initial.targets.map((t) => ({ ...t }));
    this.handlers = { ...this.initial.handlers };
    this.nextTarget = 2;
  }

  /** Messages recorded for one target ("browser" for the browser socket). */
  messagesFor(targetId: string): RecordedMessage[] {
    return this.messages.filter((m) => m.targetId === targetId);
  }

  /* ------------------------------- HTTP + WS upgrade ------------------------------- */

  private targetJson(t: FakeTarget) {
    const ws = `ws://127.0.0.1:${this.server!.port}/devtools/page/${t.id}`;
    return {
      description: "",
      devtoolsFrontendUrl: `/devtools/inspector.html?ws=127.0.0.1:${this.server!.port}/devtools/page/${t.id}`,
      id: t.id,
      title: t.title ?? "",
      type: t.type ?? "page",
      url: t.url ?? "about:blank",
      webSocketDebuggerUrl: ws,
    };
  }

  private onFetch(req: Request, server: BunServer): Response | undefined {
    const url = new URL(req.url);
    const path = url.pathname;

    if (req.headers.get("upgrade")?.toLowerCase() === "websocket") {
      const m = /^\/devtools\/(browser|page)\/(.+)$/.exec(path);
      if (!m) return new Response("bad websocket path", { status: 404 });
      const targetId = m[1] === "browser" ? "browser" : m[2]!;
      if (targetId !== "browser" && !this.targets.some((t) => t.id === targetId)) {
        return new Response("no such target", { status: 404 });
      }
      return server.upgrade(req, { data: { targetId } }) ? undefined : new Response("upgrade failed", { status: 400 });
    }

    this.requests.push({ path: path + url.search });
    const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status, headers: { "content-type": "application/json" } });

    if (path === "/json/version") {
      return json({
        Browser: this.browser,
        "Protocol-Version": "1.3",
        "User-Agent": "FakeCDP",
        "V8-Version": "0",
        "WebKit-Version": "0",
        webSocketDebuggerUrl: `ws://127.0.0.1:${this.server!.port}/devtools/browser/fake-browser`,
      });
    }
    if (path === "/json/list" || path === "/json") return json(this.targets.map((t) => this.targetJson(t)));
    if (path === "/json/new") {
      const t: FakeTarget = { id: `PAGE${this.nextTarget++}`, type: "page", title: "", url: url.search.slice(1) || "about:blank" };
      this.targets.push(t);
      return json(this.targetJson(t));
    }
    const act = /^\/json\/activate\/(.+)$/.exec(path);
    if (act) return this.targets.some((t) => t.id === act[1]) ? new Response("Target activated") : new Response("No such target id", { status: 404 });
    const close = /^\/json\/close\/(.+)$/.exec(path);
    if (close) {
      const before = this.targets.length;
      this.targets = this.targets.filter((t) => t.id !== close[1]);
      return this.targets.length < before ? new Response("Target is closing") : new Response("No such target id", { status: 404 });
    }
    return new Response("not found", { status: 404 });
  }

  /* ------------------------------- CDP JSON-RPC ------------------------------- */

  private builtin(method: string, params: any, targetId: string): unknown {
    switch (method) {
      case "Accessibility.getFullAXTree":
        return { nodes: CANNED_AX_NODES };
      case "Page.captureScreenshot":
        return { data: PNG_1X1_BASE64 };
      case "Page.getLayoutMetrics": {
        const vp = { clientWidth: 800, clientHeight: 600, pageX: 0, pageY: 0, scale: 1, zoom: 1 };
        return {
          layoutViewport: { pageX: 0, pageY: 0, clientWidth: 800, clientHeight: 600 },
          visualViewport: vp,
          contentSize: { x: 0, y: 0, width: 800, height: 600 },
          cssLayoutViewport: { pageX: 0, pageY: 0, clientWidth: 800, clientHeight: 600 },
          cssVisualViewport: vp,
          cssContentSize: { x: 0, y: 0, width: 800, height: 600 },
        };
      }
      case "Target.getTargets":
        return { targetInfos: this.targets.map((t) => ({ targetId: t.id, type: t.type ?? "page", title: t.title ?? "", url: t.url ?? "about:blank", attached: false })) };
      case "Target.createTarget": {
        const t: FakeTarget = { id: `PAGE${this.nextTarget++}`, type: "page", title: "", url: params?.url ?? "about:blank" };
        this.targets.push(t);
        return { targetId: t.id };
      }
      case "Target.closeTarget": {
        const before = this.targets.length;
        this.targets = this.targets.filter((t) => t.id !== params?.targetId);
        return { success: this.targets.length < before };
      }
      case "DOM.resolveNode":
        return { object: { type: "object", objectId: `obj-${params?.backendNodeId ?? 0}` } };
      case "DOM.getBoxModel":
        return { model: { content: [10, 10, 50, 10, 50, 30, 10, 30], padding: [], border: [], margin: [], width: 40, height: 20 } };
      case "DOM.getDocument":
        return { root: { nodeId: 1, backendNodeId: 1, nodeType: 9, nodeName: "#document" } };
      case "Runtime.callFunctionOn":
        // the element locator asks for a click point; give it a plausible one
        return { result: { type: "object", value: { x: 30, y: 20 } } };
      case "Runtime.evaluate":
        return { result: { type: "undefined" } };
      default:
        return {};
    }
  }

  private async onWsMessage(ws: WsLike, raw: string | Buffer | ArrayBuffer | Uint8Array): Promise<void> {
    const targetId = ws.data.targetId;
    let msg: { id?: number; method?: string; params?: unknown; sessionId?: string };
    try {
      msg = JSON.parse(typeof raw === "string" ? raw : Buffer.from(raw as ArrayBuffer).toString("utf8"));
    } catch {
      return;
    }
    if (typeof msg.method !== "string") return;
    this.messages.push({ targetId, method: msg.method, params: msg.params });
    const reply = (body: Record<string, unknown>) => ws.send(JSON.stringify({ id: msg.id, ...(msg.sessionId ? { sessionId: msg.sessionId } : {}), ...body }));
    try {
      const handler = this.handlers[msg.method];
      const result = handler ? await handler(msg.params, { targetId }) : this.builtin(msg.method, msg.params, targetId);
      reply({ result: result ?? {} });
    } catch (e) {
      reply({ error: { code: -32000, message: e instanceof Error ? e.message : String(e) } });
    }
  }
}

/** Convenience: construct, start, and hand back both. */
export async function startFakeCdp(opts: FakeCdpOptions = {}): Promise<{ fake: FakeCdpServer; base: string; port: number }> {
  const fake = new FakeCdpServer(opts);
  const { base, port } = await fake.start();
  return { fake, base, port };
}
