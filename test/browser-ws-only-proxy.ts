/**
 * A DevTools endpoint that serves ONLY the browser socket, in front of a normal
 * Chrome.
 *
 * WHY THIS EXISTS. The transport this fixture reproduces is not something you
 * can ask Chrome for with a flag. It is what a Chrome exposes when debugging
 * was enabled at RUNTIME, through the toggle on `chrome://inspect/#remote-debugging`,
 * rather than with `--remote-debugging-port`. A Chrome in that state ALSO puts
 * a modal consent dialog in front of every new client, so it is not something a
 * test suite may dial by itself.
 *
 * So instead of a real one, this proxies a disposable `--remote-debugging-port`
 * Chrome and removes exactly what that mode removes, with the responses it was
 * measured to give (Chrome 153):
 *
 *   GET  /json/version, /json/list        -> 404
 *   WS   /devtools/page/<targetId>        -> 403
 *   WS   /devtools/browser/<uuid>         -> 101, proxied verbatim
 *
 * A test that passes through here therefore proves the transport works with no
 * HTTP discovery and no per-target socket available — which is the claim — on a
 * browser the suite owns and may connect to freely.
 */
declare const Bun: {
  serve(opts: {
    port: number;
    fetch(req: Request, server: { upgrade(req: Request, opts?: { data?: unknown }): boolean }): Response | Promise<Response> | undefined;
    websocket: {
      open(ws: BunSocket): void | Promise<void>;
      message(ws: BunSocket, msg: string | Buffer): void;
      close(ws: BunSocket): void;
    };
  }): { port: number; stop(closeActive?: boolean): void };
};
interface BunSocket {
  data: { upstream?: WebSocket; queue: string[]; ready: boolean };
  send(msg: string): void;
  close(): void;
}

export interface BrowserWsOnlyEndpoint {
  /** The base URL to hand the toolkit as CDP_BASE. Its /json/* all 404. */
  base: string;
  /** The one URL that upgrades, to hand the toolkit as CDP_BROWSER_WS. */
  browserWsUrl: string;
  stop(): void;
}

/**
 * Front `upstreamBase` (a normal Chrome) with a browser-ws-only endpoint.
 *
 * The upstream browser socket is resolved ONCE here, through the upstream's own
 * `/json/version` — that is the fixture's own plumbing, not part of what is
 * under test, and it is why the toolkit can be given a `CDP_BROWSER_WS` without
 * any `/json` of its own.
 */
export async function startBrowserWsOnlyProxy(upstreamBase: string): Promise<BrowserWsOnlyEndpoint> {
  const { webSocketDebuggerUrl } = (await fetch(`${upstreamBase}/json/version`).then((r) => r.json())) as {
    webSocketDebuggerUrl: string;
  };

  const server = Bun.serve({
    port: 0,
    fetch(req, srv) {
      const { pathname } = new URL(req.url);
      // The browser socket is the ONLY thing that upgrades.
      if (pathname.startsWith("/devtools/browser/")) {
        if (srv.upgrade(req, { data: { queue: [], ready: false } })) return undefined;
        return new Response("upgrade failed", { status: 400 });
      }
      // What the runtime-toggle mode returns for a per-target socket.
      if (pathname.startsWith("/devtools/page/") || pathname.startsWith("/devtools/frame/")) {
        return new Response("Forbidden", { status: 403 });
      }
      // ...and for HTTP discovery.
      return new Response("Not Found", { status: 404 });
    },
    websocket: {
      async open(ws) {
        const upstream = new WebSocket(webSocketDebuggerUrl);
        ws.data.upstream = upstream;
        upstream.onmessage = (ev: MessageEvent) => ws.send(String(ev.data));
        upstream.onclose = () => ws.close();
        upstream.onerror = () => ws.close();
        await new Promise<void>((resolve) => {
          upstream.onopen = () => resolve();
        });
        ws.data.ready = true;
        // Anything the client sent during the upstream handshake, in order.
        for (const queued of ws.data.queue) upstream.send(queued);
        ws.data.queue.length = 0;
      },
      message(ws, msg) {
        const text = String(msg);
        if (!ws.data.ready) {
          ws.data.queue.push(text);
          return;
        }
        ws.data.upstream?.send(text);
      },
      close(ws) {
        try {
          ws.data.upstream?.close();
        } catch {
          /* ignore */
        }
      },
    },
  });

  const path = new URL(webSocketDebuggerUrl).pathname;
  return {
    base: `http://127.0.0.1:${server.port}`,
    browserWsUrl: `ws://127.0.0.1:${server.port}${path}`,
    stop: () => server.stop(true),
  };
}
