/**
 * screenshot tool — `take_screenshot` over raw CDP.
 *
 * Captures the viewport, the full scrollable page, or a single element via
 * Page.captureScreenshot. Full-page support computes the content size from
 * Page.getLayoutMetrics and passes an explicit clip + captureBeyondViewport so
 * we don't depend on Headless-only conveniences (Arc is headful). Element
 * capture resolves the node (uid -> backendNodeId, or CSS selector) and clips
 * to its box. Artifacts are written under ARTIFACT_DIR; the base64 bytes are
 * only returned when explicitly requested.
 */
import { writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { CdpConnection } from "../client.ts";
import { CdpError, withPage } from "../client.ts";
import type { Target, TargetSelector, Uid } from "../types.ts";

const ARTIFACT_DIR = process.env.CDP_ARTIFACT_DIR ?? "/tmp/cdp-toolkit";

export interface ScreenshotArgs {
  target?: TargetSelector;
  format?: "png" | "jpeg";
  /** JPEG/quality 0-100. Ignored for png. */
  quality?: number;
  /** Capture the full scrollable content height, not just the viewport. */
  fullPage?: boolean;
  /** Element to clip to (a backendDOMNodeId). Mutually exclusive with selector. */
  uid?: Uid;
  /** CSS selector to clip to. Mutually exclusive with uid. */
  selector?: string;
  /** Override the artifact path. Default: ARTIFACT_DIR/<stamp>.<ext>. */
  savePath?: string;
  /** Also return the raw base64 image in the result. */
  returnBase64?: boolean;
}

export interface ScreenshotResult {
  path: string;
  bytes: number;
  format: "png" | "jpeg";
  target: { id: string; url: string; title: string };
  base64?: string;
}

interface Viewport {
  x: number;
  y: number;
  width: number;
  height: number;
  scale: number;
}

interface LayoutMetrics {
  cssContentSize?: { x: number; y: number; width: number; height: number };
  contentSize?: { x: number; y: number; width: number; height: number };
  cssLayoutViewport?: { clientWidth: number; clientHeight: number };
}

interface BoxModel {
  model: {
    /** content quad: [x1,y1,x2,y2,x3,y3,x4,y4] (top-left, top-right, bottom-right, bottom-left). */
    content: number[];
    width: number;
    height: number;
  };
}

function shortId(id: string): string {
  return id.slice(0, 8);
}

function stamp(): string {
  return new Date(Date.now()).toISOString().replace(/[:.]/g, "-");
}

/** Compute a full-content clip from layout metrics (CSS pixels). */
async function fullPageClip(conn: CdpConnection): Promise<Viewport> {
  const m = await conn.send<LayoutMetrics>("Page.getLayoutMetrics");
  const size = m.cssContentSize ?? m.contentSize;
  if (!size) throw new CdpError("Page.getLayoutMetrics returned no content size");
  return { x: 0, y: 0, width: Math.ceil(size.width), height: Math.ceil(size.height), scale: 1 };
}

/** Compute an element clip from its box model (uid or CSS selector). */
async function elementClip(conn: CdpConnection, uid: Uid | undefined, selector: string | undefined): Promise<Viewport> {
  let backendNodeId: number;
  if (uid != null) {
    backendNodeId = uid;
  } else if (selector) {
    const { root } = await conn.send<{ root: { nodeId: number } }>("DOM.getDocument", { depth: 0 });
    const { nodeId } = await conn.send<{ nodeId: number }>("DOM.querySelector", {
      nodeId: root.nodeId,
      selector,
    });
    if (!nodeId) throw new CdpError(`selector matched no element: ${selector}`);
    const desc = await conn.send<{ node: { backendNodeId: number } }>("DOM.describeNode", { nodeId });
    backendNodeId = desc.node.backendNodeId;
  } else {
    throw new CdpError("elementClip requires uid or selector");
  }

  // Scroll the element into view so the clip is within the captured region.
  try {
    await conn.send("DOM.scrollIntoViewIfNeeded", { backendNodeId });
  } catch {
    /* not all builds expose this; box-model coordinates are absolute regardless */
  }

  const box = await conn.send<BoxModel>("DOM.getBoxModel", { backendNodeId });
  const q = box.model.content;
  const q0 = q[0];
  const q1 = q[1];
  if (q0 == null || q1 == null) throw new CdpError("DOM.getBoxModel returned an empty content quad");
  const xs = [q[0], q[2], q[4], q[6]].filter((n): n is number => n != null);
  const ys = [q[1], q[3], q[5], q[7]].filter((n): n is number => n != null);
  const minX = Math.min(...xs);
  const minY = Math.min(...ys);
  const maxX = Math.max(...xs);
  const maxY = Math.max(...ys);
  const width = Math.ceil(maxX - minX);
  const height = Math.ceil(maxY - minY);
  if (width <= 0 || height <= 0) throw new CdpError("resolved element has zero area");
  return { x: minX, y: minY, width, height, scale: 1 };
}

/**
 * take_screenshot — capture viewport / full page / element to a file.
 * Returns { path, bytes, format } (+ base64 when requested).
 */
export async function takeScreenshot(args: ScreenshotArgs = {}): Promise<ScreenshotResult> {
  const { target, fullPage, uid, selector, savePath, returnBase64 } = args;
  if (uid != null && selector) throw new CdpError("provide exactly one of uid or selector, not both");
  const format: "png" | "jpeg" = args.format ?? "png";
  const quality = format === "jpeg" ? (args.quality ?? 80) : undefined;

  return withPage(target, async (conn: CdpConnection, t: Target) => {
    await conn.send("Page.enable");

    const params: Record<string, unknown> = { format, captureBeyondViewport: true };
    if (quality != null) params.quality = quality;

    if (uid != null || selector) {
      params.clip = await elementClip(conn, uid, selector);
    } else if (fullPage) {
      params.clip = await fullPageClip(conn);
    }

    const { data } = await conn.send<{ data: string }>("Page.captureScreenshot", params);
    const buf = Buffer.from(data, "base64");
    if (buf.byteLength === 0) throw new CdpError("Page.captureScreenshot returned empty data");

    await mkdir(ARTIFACT_DIR, { recursive: true });
    const ext = format === "jpeg" ? "jpg" : "png";
    const path = savePath ?? join(ARTIFACT_DIR, `screenshot-${shortId(t.id)}-${stamp()}.${ext}`);
    await writeFile(path, buf);

    const result: ScreenshotResult = {
      path,
      bytes: buf.byteLength,
      format,
      target: { id: t.id, url: t.url, title: t.title },
    };
    if (returnBase64) result.base64 = data;
    return result;
  });
}

/*
 * CDP methods/domains used:
 *   - Page.enable
 *   - Page.captureScreenshot { format, quality, clip, captureBeyondViewport }
 *   - Page.getLayoutMetrics            (full-page content clip)
 *   - DOM.getDocument / DOM.querySelector / DOM.describeNode  (selector -> backendNodeId)
 *   - DOM.scrollIntoViewIfNeeded       (best-effort, ignored if unsupported)
 *   - DOM.getBoxModel                  (element clip)
 * Parity gaps vs chrome-devtools-mcp take_screenshot:
 *   - MCP refs are its own snapshot uids; here uid IS a backendDOMNodeId (toolkit ref scheme).
 *   - No device-pixel upscaling control beyond emulation-set deviceScaleFactor (clip scale fixed at 1).
 *   - Full-page on headful Arc relies on captureBeyondViewport + layout-metrics clip rather than headless auto-sizing.
 */
