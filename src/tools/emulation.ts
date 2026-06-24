/**
 * emulation tools — `emulate` and `resize_page` over raw CDP.
 *
 * `emulate` is a one-call switchboard over Chrome's emulation overrides:
 * device metrics (size / DPR / mobile), user-agent, CPU throttling, emulated
 * media (type + features like prefers-color-scheme), and network conditions.
 * `resize_page` is the narrow case of setting just the device-metrics size.
 * A `clearOverrides` path resets every override back to the browser default.
 *
 * NOTE on persistence: these overrides live on the DevTools *session*. The
 * toolkit's stateless one-shot model (withPage opens then closes the
 * connection) means an override applied in one call is gone once that
 * connection closes — except device metrics, which Chrome keeps applied to the
 * target until explicitly cleared or the renderer navigates/reloads. We
 * therefore re-assert metrics in resize_page and document this in the footer.
 */
import type { CdpConnection } from "../client.ts";
import { CdpError, withPage } from "../client.ts";
import type { Target, TargetSelector } from "../types.ts";

export interface NetworkConditions {
  /** true = simulate offline. */
  offline?: boolean;
  /** additional round-trip latency, ms. */
  latency?: number;
  /** max download throughput, bytes/sec (-1 = no limit). */
  downloadThroughput?: number;
  /** max upload throughput, bytes/sec (-1 = no limit). */
  uploadThroughput?: number;
  /** "none" | "cellular2g" | "cellular3g" | "cellular4g" | "bluetooth" | "ethernet" | "wifi" | "wimax" | "other" */
  connectionType?: string;
}

export interface EmulateArgs {
  target?: TargetSelector;
  width?: number;
  height?: number;
  deviceScaleFactor?: number;
  mobile?: boolean;
  userAgent?: string;
  /** 1 = no throttle; 2 = 2x slower; etc. */
  cpuThrottlingRate?: number;
  /** Emulated CSS media type: "screen" | "print" | "" (clear). */
  media?: string;
  /** Emulated media features, e.g. [{ name:"prefers-color-scheme", value:"dark" }]. */
  mediaFeatures?: Array<{ name: string; value: string }>;
  networkConditions?: NetworkConditions;
  /** Reset every override to the browser default; ignores all other fields. */
  clearOverrides?: boolean;
}

export interface EmulateResult {
  target: { id: string; url: string; title: string };
  applied: string[];
  cleared?: boolean;
}

export interface ResizeArgs {
  target?: TargetSelector;
  width: number;
  height: number;
  deviceScaleFactor?: number;
  mobile?: boolean;
}

export interface ResizeResult {
  target: { id: string; url: string; title: string };
  width: number;
  height: number;
  /** window.innerWidth/innerHeight observed after the override is applied. */
  innerWidth: number;
  innerHeight: number;
}

async function clearAll(conn: CdpConnection): Promise<void> {
  // Order doesn't matter; each is independent. Tolerate per-domain absence.
  await conn.send("Emulation.clearDeviceMetricsOverride").catch(() => undefined);
  await conn.send("Emulation.setUserAgentOverride", { userAgent: "" }).catch(() => undefined);
  await conn.send("Emulation.setCPUThrottlingRate", { rate: 1 }).catch(() => undefined);
  await conn.send("Emulation.setEmulatedMedia", { media: "", features: [] }).catch(() => undefined);
  await conn.send("Network.enable").catch(() => undefined);
  await conn
    .send("Network.emulateNetworkConditions", {
      offline: false,
      latency: 0,
      downloadThroughput: -1,
      uploadThroughput: -1,
    })
    .catch(() => undefined);
}

/**
 * emulate — apply any subset of device-metrics / UA / CPU / media / network
 * overrides in a single call, or clear them all with { clearOverrides:true }.
 */
export async function emulate(args: EmulateArgs = {}): Promise<EmulateResult> {
  const { target } = args;
  return withPage(target, async (conn: CdpConnection, t: Target) => {
    if (args.clearOverrides) {
      await clearAll(conn);
      return {
        target: { id: t.id, url: t.url, title: t.title },
        applied: [],
        cleared: true,
      };
    }

    const applied: string[] = [];

    if (args.width != null || args.height != null) {
      if (args.width == null || args.height == null) {
        throw new CdpError("emulate device metrics require both width and height");
      }
      await conn.send("Emulation.setDeviceMetricsOverride", {
        width: args.width,
        height: args.height,
        deviceScaleFactor: args.deviceScaleFactor ?? 0,
        mobile: args.mobile ?? false,
      });
      applied.push("deviceMetrics");
    }

    if (args.userAgent != null) {
      await conn.send("Emulation.setUserAgentOverride", { userAgent: args.userAgent });
      applied.push("userAgent");
    }

    if (args.cpuThrottlingRate != null) {
      if (args.cpuThrottlingRate < 1) throw new CdpError("cpuThrottlingRate must be >= 1");
      await conn.send("Emulation.setCPUThrottlingRate", { rate: args.cpuThrottlingRate });
      applied.push("cpuThrottlingRate");
    }

    if (args.media != null || args.mediaFeatures != null) {
      await conn.send("Emulation.setEmulatedMedia", {
        media: args.media ?? "",
        features: args.mediaFeatures ?? [],
      });
      applied.push("emulatedMedia");
    }

    if (args.networkConditions != null) {
      const n = args.networkConditions;
      await conn.send("Network.enable").catch(() => undefined);
      await conn.send("Network.emulateNetworkConditions", {
        offline: n.offline ?? false,
        latency: n.latency ?? 0,
        downloadThroughput: n.downloadThroughput ?? -1,
        uploadThroughput: n.uploadThroughput ?? -1,
        ...(n.connectionType ? { connectionType: n.connectionType } : {}),
      });
      applied.push("networkConditions");
    }

    if (applied.length === 0) {
      throw new CdpError("emulate: no overrides specified (pass clearOverrides:true to reset)");
    }

    return { target: { id: t.id, url: t.url, title: t.title }, applied };
  });
}

/**
 * resize_page — set the page's device-metrics width/height. Verifies by reading
 * back window.innerWidth/innerHeight after the override is applied.
 */
export async function resizePage(args: ResizeArgs): Promise<ResizeResult> {
  const { target, width, height } = args;
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    throw new CdpError("resize_page requires positive numeric width and height");
  }
  return withPage(target, async (conn: CdpConnection, t: Target) => {
    await conn.send("Emulation.setDeviceMetricsOverride", {
      width,
      height,
      deviceScaleFactor: args.deviceScaleFactor ?? 0,
      mobile: args.mobile ?? false,
    });
    await conn.send("Runtime.enable").catch(() => undefined);
    const { result } = await conn.send<{ result: { value?: { w: number; h: number } } }>("Runtime.evaluate", {
      expression: "({ w: window.innerWidth, h: window.innerHeight })",
      returnByValue: true,
    });
    const v = result.value;
    return {
      target: { id: t.id, url: t.url, title: t.title },
      width,
      height,
      innerWidth: v?.w ?? width,
      innerHeight: v?.h ?? height,
    };
  });
}

/*
 * CDP methods/domains used:
 *   - Emulation.setDeviceMetricsOverride   (resize + emulate metrics)
 *   - Emulation.clearDeviceMetricsOverride (clearOverrides)
 *   - Emulation.setUserAgentOverride
 *   - Emulation.setCPUThrottlingRate
 *   - Emulation.setEmulatedMedia           (media type + features)
 *   - Network.enable / Network.emulateNetworkConditions
 *   - Runtime.enable / Runtime.evaluate    (resize_page read-back verification)
 * Parity gaps vs chrome-devtools-mcp emulate/resize_page:
 *   - Override lifetime: toolkit is stateless (connection closes after each call). Device-metrics
 *     overrides persist on the target until cleared/navigated; UA/CPU/media/network overrides are
 *     session-scoped and reset when the per-call connection closes. The MCP keeps one long-lived
 *     session so its non-metrics overrides persist across subsequent MCP calls; ours do not.
 *   - No named device-descriptor presets (e.g. "iPhone 15"); caller passes raw metrics + UA.
 *   - No touch-emulation / screen-orientation override (Emulation.setTouchEmulationEnabled,
 *     setDeviceMetricsOverride.screenOrientation) — out of the assigned arg surface.
 */
