/**
 * heap.ts — `take_heapsnapshot` over raw CDP.
 *
 * Captures a V8 heap snapshot of a page target and writes it as a
 * `.heapsnapshot` file (the JSON format DevTools' Memory panel loads).
 *
 * CDP semantics this module relies on:
 *   - `HeapProfiler.takeHeapSnapshot` streams the snapshot back as a sequence
 *     of `HeapProfiler.addHeapSnapshotChunk` events. The command's own result
 *     does NOT carry the data — it resolves only after the final chunk has been
 *     emitted. So we subscribe to the chunk event first, accumulate every
 *     chunk's string, then `await` the command; once it resolves we have the
 *     complete snapshot and join the chunks into one JSON document.
 */

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { withPage } from "../client.ts";
import type { TargetSelector } from "../types.ts";

const ARTIFACT_DIR = process.env.CDP_ARTIFACT_DIR ?? "/tmp/cdp-toolkit";

export interface TakeHeapsnapshotArgs {
  /** Page selector (defaults to the active page). */
  target?: TargetSelector;
  /** Override the output path. When relative, resolved under ARTIFACT_DIR. */
  savePath?: string;
}

export interface TakeHeapsnapshotResult {
  path: string;
  bytes: number;
  /** Number of `addHeapSnapshotChunk` events accumulated. */
  chunks: number;
  target: { id: string; url: string; title: string };
}

/** A short, fs-safe stamp derived from the target id and the current time. */
function stamp(targetId: string): string {
  const short = targetId.slice(0, 8);
  const iso = new Date().toISOString().replace(/[:.]/g, "-");
  return `${short}-${iso}`;
}

/**
 * Take a V8 heap snapshot of the selected page and persist it as a
 * `.heapsnapshot` file under ARTIFACT_DIR (or `savePath`).
 */
export async function takeHeapsnapshot(
  args: TakeHeapsnapshotArgs = {},
): Promise<TakeHeapsnapshotResult> {
  return withPage(args.target, async (conn, target) => {
    await conn.send("HeapProfiler.enable");

    // Subscribe BEFORE issuing the command so we don't miss early chunks.
    const parts: string[] = [];
    const off = conn.on("HeapProfiler.addHeapSnapshotChunk", (params) => {
      const chunk = (params as { chunk?: unknown }).chunk;
      if (typeof chunk === "string") parts.push(chunk);
    });

    try {
      // Resolves only after the final addHeapSnapshotChunk has fired. We grant
      // it a generous timeout: heap snapshots of large pages can take a while.
      await conn.send(
        "HeapProfiler.takeHeapSnapshot",
        { reportProgress: false, captureNumericValue: false },
        { timeoutMs: 120_000 },
      );
    } finally {
      off();
    }

    const snapshot = parts.join("");
    if (snapshot.length === 0) {
      throw new Error("HeapProfiler.takeHeapSnapshot produced no chunks");
    }

    await mkdir(ARTIFACT_DIR, { recursive: true });
    const path = args.savePath
      ? args.savePath.startsWith("/")
        ? args.savePath
        : join(ARTIFACT_DIR, args.savePath)
      : join(ARTIFACT_DIR, `take_heapsnapshot-${stamp(target.id)}.heapsnapshot`);

    await writeFile(path, snapshot, "utf8");
    const bytes = Buffer.byteLength(snapshot, "utf8");

    return {
      path,
      bytes,
      chunks: parts.length,
      target: { id: target.id, url: target.url, title: target.title },
    };
  });
}

/* ----------------------------------------------------------------------------
 * CDP methods/domains used:
 *   - HeapProfiler.enable
 *   - HeapProfiler.takeHeapSnapshot           (command; resolves after last chunk)
 *   - HeapProfiler.addHeapSnapshotChunk        (event; accumulated into the file)
 *
 * Parity gaps vs chrome-devtools-mcp `take_heapsnapshot`:
 *   - reportProgress is forced false; no incremental progress callbacks surfaced.
 *   - Returns {path,bytes,chunks,target} only — does not parse/summarize the
 *     snapshot (node counts, retained sizes); the .heapsnapshot file is for the
 *     DevTools Memory panel to load, matching the MCP tool's artifact behavior.
 * --------------------------------------------------------------------------*/
