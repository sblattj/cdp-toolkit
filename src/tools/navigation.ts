/**
 * Navigation + wait tools (raw CDP).
 *
 * Replicates chrome-devtools-mcp's `navigate_page` and `wait_for` over a direct
 * WebSocket, built only on the core client (`withPage`). No Puppeteer / MCP.
 *
 * - navigate_page: Page.enable -> Page.navigate, then await the load milestone
 *   (Page.loadEventFired for 'load'; Page.domContentEventFired /
 *   Page.frameStoppedLoading for 'domcontentloaded') with a bounded timeout so a
 *   wedged renderer can't hang the caller.
 * - wait_for: polls Runtime.evaluate(document.body.innerText.includes(text))
 *   on a fixed interval until the text appears or the timeout elapses.
 */
import { CdpError, withPage } from "../client.ts";
import type { CdpConnection } from "../client.ts";
import type { Target, TargetSelector } from "../types.ts";

export interface NavigatePageArgs {
  /** Page selector; defaults to the active page. */
  target?: TargetSelector;
  /** Destination URL. Required unless `reload` is true. */
  url?: string;
  /** Reload the current page (Page.reload) instead of navigating to `url`. */
  reload?: boolean;
  /**
   * When reloading, bypass the HTTP cache (hard reload) so freshly-deployed,
   * non-content-hashed bundles are refetched instead of served stale. Ignored
   * unless `reload` is true.
   */
  ignoreCache?: boolean;
  /** Which load milestone to wait for. Defaults to 'load'. */
  waitUntil?: "load" | "domcontentloaded";
  /** Override the navigation timeout (ms). */
  timeoutMs?: number;
}

export interface NavigatePageResult {
  url: string;
  frameId: string;
  /** True when the result came from a reload rather than a fresh navigation. */
  reloaded?: boolean;
  /** The milestone that resolved the wait, or 'timeout' if navigation committed but the milestone never fired in time. */
  waitedFor: "load" | "domcontentloaded" | "frameStoppedLoading" | "navigate-only";
}

/**
 * Navigate a page to `url`, OR reload it (`reload:true`), and wait for it to
 * finish loading.
 *
 * `Page.navigate`/`Page.reload` resolve once the action is *committed*. We
 * separately race the load milestone event — subscribed BEFORE issuing the
 * command so a fast load can't fire before we're listening. Pass
 * `reload:true, ignoreCache:true` for a hard reload that refetches every
 * subresource (the only way to pick up a freshly-deployed bundle the HTTP
 * cache would otherwise serve stale).
 */
export async function navigatePage(args: NavigatePageArgs): Promise<NavigatePageResult> {
  const reload = args.reload === true;
  if (!reload && (!args.url || typeof args.url !== "string")) {
    throw new CdpError("navigate_page: 'url' is required (or pass reload:true to reload the current page)");
  }
  const waitUntil = args.waitUntil ?? "load";

  return withPage(
    args.target,
    async (conn: CdpConnection): Promise<NavigatePageResult> => {
      await conn.send("Page.enable");

      // Subscribe to the load milestone BEFORE acting so a fast page that loads
      // before the navigate/reload command resolves still satisfies the wait.
      const milestoneMethod = waitUntil === "load" ? "Page.loadEventFired" : "Page.domContentEventFired";
      const milestone = conn
        .waitFor(milestoneMethod, undefined, args.timeoutMs)
        .then(() => waitUntil)
        .catch(() => undefined);
      // Secondary fallback: frameStoppedLoading covers same-document and edge
      // cases where the primary load event is suppressed.
      const stopped = conn
        .waitFor<{ frameId?: string }>("Page.frameStoppedLoading", undefined, args.timeoutMs)
        .then(() => "frameStoppedLoading" as const)
        .catch(() => undefined);

      let resolvedUrl: string;
      let frameId: string;
      if (reload) {
        // Page.reload has no return payload; ignoreCache:true forces a network
        // refetch of every subresource (a true hard reload).
        await conn.send(
          "Page.reload",
          { ignoreCache: args.ignoreCache === true },
          args.timeoutMs ? { timeoutMs: args.timeoutMs } : {},
        );
        // Recover the main frame id + post-reload URL (reload keeps the same URL).
        const tree = await conn
          .send<{ frameTree?: { frame?: { id?: string; url?: string } } }>("Page.getFrameTree")
          .catch(() => undefined);
        frameId = tree?.frameTree?.frame?.id ?? "";
        resolvedUrl = tree?.frameTree?.frame?.url ?? args.url ?? "";
      } else {
        const nav = await conn.send<{ frameId: string; loaderId?: string; errorText?: string }>(
          "Page.navigate",
          { url: args.url },
          args.timeoutMs ? { timeoutMs: args.timeoutMs } : {},
        );
        if (nav.errorText) {
          throw new CdpError(`navigate_page: ${nav.errorText} (${args.url})`);
        }
        frameId = nav.frameId;
        resolvedUrl = args.url as string;
      }

      const settled = await Promise.race([milestone, stopped]);
      const waitedFor: NavigatePageResult["waitedFor"] = settled ?? "navigate-only";

      return reload
        ? { url: resolvedUrl, frameId, reloaded: true, waitedFor }
        : { url: resolvedUrl, frameId, waitedFor };
    },
    args.timeoutMs ? { timeoutMs: args.timeoutMs } : {},
  );
}

export interface WaitForArgs {
  /** Page selector; defaults to the active page. */
  target?: TargetSelector;
  /** Substring to wait for in document.body.innerText. Required. */
  text: string;
  /** Total time budget (ms). Defaults to 15000. */
  timeoutMs?: number;
  /** Poll interval (ms). Defaults to 250. */
  pollMs?: number;
}

export interface WaitForResult {
  found: true;
  waitedMs: number;
}

const DEFAULT_WAIT_TIMEOUT_MS = 15_000;
const DEFAULT_POLL_MS = 250;

/**
 * Poll the page until `text` appears in document.body.innerText, or throw on
 * timeout. Polling (rather than a DOM-mutation subscription) matches the MCP
 * tool's semantics and is robust to text that's present on first paint.
 */
export async function waitForText(args: WaitForArgs): Promise<WaitForResult> {
  if (typeof args.text !== "string" || args.text.length === 0) {
    throw new CdpError("wait_for: 'text' is required");
  }
  const timeoutMs = args.timeoutMs ?? DEFAULT_WAIT_TIMEOUT_MS;
  const pollMs = args.pollMs ?? DEFAULT_POLL_MS;
  const start = Date.now();

  return withPage(
    args.target,
    async (conn: CdpConnection, _target: Target): Promise<WaitForResult> => {
      await conn.send("Runtime.enable");
      const expr = `(() => { const b = document.body; return !!b && typeof b.innerText === 'string' && b.innerText.includes(${JSON.stringify(args.text)}); })()`;

      for (;;) {
        const { result } = await conn.send<{ result: { value?: unknown } }>("Runtime.evaluate", {
          expression: expr,
          returnByValue: true,
        });
        if (result?.value === true) {
          return { found: true, waitedMs: Date.now() - start };
        }
        if (Date.now() - start >= timeoutMs) {
          throw new CdpError(`wait_for: text not found within ${timeoutMs}ms: ${JSON.stringify(args.text)}`);
        }
        await delay(Math.min(pollMs, Math.max(0, timeoutMs - (Date.now() - start))));
      }
    },
    // Give the per-command timeout enough headroom for the whole poll budget.
    { timeoutMs: Math.max(timeoutMs, DEFAULT_WAIT_TIMEOUT_MS) },
  );
}

/** Contract-mandated alias: `wait_for` -> `waitForText`, also exported as `waitFor`. */
export const waitFor = waitForText;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/*
 * CDP methods/domains used:
 *   - Page.enable
 *   - Page.navigate
 *   - Page.reload (reload:true; ignoreCache:true = hard reload)
 *   - Page.getFrameTree (recover main frameId + URL after a reload)
 *   - Page.loadEventFired (event; waitUntil:'load')
 *   - Page.domContentEventFired (event; waitUntil:'domcontentloaded')
 *   - Page.frameStoppedLoading (event; fallback load milestone)
 *   - Runtime.enable
 *   - Runtime.evaluate (poll document.body.innerText)
 *
 * Parity gaps vs chrome-devtools-mcp:
 *   - navigate_page: no automatic "snapshot of the new page" return; we return {url,frameId,waitedFor}. waitUntil supports 'load'|'domcontentloaded' only (no 'networkidle'). reload:true (+ignoreCache for a hard reload) covers the MCP's reload navigation type.
 *   - wait_for: only text-substring waiting (innerText.includes); no aria/role/selector or "wait for event" variants. Throws on timeout rather than returning {found:false}.
 */
