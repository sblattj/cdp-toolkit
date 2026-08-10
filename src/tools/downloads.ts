/**
 * downloads.ts: `wait_for_download` — block until a file download finishes, then hand back a real
 * path on disk with the page's own filename (1.8.0 Track P3).
 *
 * WHY THIS IS CHROME-ONLY (capability "browser.downloads"), NOT a PageDriver method
 * ================================================================================
 * A download is browser-scoped, not page-scoped: Browser.setDownloadBehavior, Browser.downloadWillBegin
 * and Browser.downloadProgress all live on the CDP browser endpoint, and the download a caller
 * cares about may be started by a click in one tab and finish while another is focused. There is no
 * page handle to hang it off, so it stays out of the Driver interface entirely, exactly like
 * dispatch-mouse.ts and screencast.ts. WebDriver BiDi has browsingContext.downloadWillBegin and
 * downloadEnd events but NO command to redirect a download to a directory of our choosing, so
 * Firefox cannot deliver the "here is the file" half of this tool at all: per ADR-001 it is absent
 * from tools/list under --browser firefox rather than present and throwing.
 *
 * THE ORDERING RULE, and why it is a rule rather than a wart
 * ---------------------------------------------------------
 * Download capture must be ARMED BEFORE the click that starts the download. That is not a design
 * preference; it is Chrome's behavior, measured (see browser-session.ts's header for the three
 * controls): the download-behavior override is per-client state, reverted the moment the arming
 * connection disconnects, and unarmed headless Chrome denies the download outright. So:
 *
 *     wait_for_download { arm: true }     <- arms, returns immediately, connection stays open
 *     click { selector: "#export" }       <- the download starts and COMPLETES, captured meanwhile
 *     wait_for_download {}                <- returns the file that finished during the click call
 *
 * The last step works because the standing connection buffered the completion while no tool call
 * was running. A caller who does not want two round trips can also do click-then-wait in the other
 * order (`wait_for_download` arms on every call), but only if something armed earlier in the same
 * server process — the FIRST download of a process must be preceded by an arm.
 *
 * Lease gate: this tool resolves `target` through client.ts's resolveTarget, which calls
 * assertLeaseOk — the same choke point every other Chrome tool passes through. It resolves a target
 * even though the CDP work is browser-scoped precisely so that gate is not skipped, and so the
 * result names the tab the caller believed it was working in.
 */
import { readdir, rename, stat } from "node:fs/promises";
import { basename, extname, join } from "node:path";
import { resolveTarget } from "../client.ts";
import type { TargetSelector } from "../types.ts";
import { DOWNLOADS_DIR, armDownloads, nextCompletedDownload, pendingDownloads } from "./browser-session.ts";

export interface WaitForDownloadArgs {
  target?: TargetSelector;
  /** Arm download capture and return immediately, without waiting for a download. */
  arm?: boolean;
  /** How long to wait for a download to complete. Default 30000. */
  timeoutMs?: number;
}

export interface WaitForDownloadResult {
  path: string;
  suggestedFilename: string;
  bytes: number;
  url?: string;
  target: { id: string; url: string; title: string };
}

export interface ArmDownloadResult {
  armed: true;
  downloadPath: string;
  /** Completed downloads already buffered and not yet collected, so an arm call is also a peek. */
  pending: number;
  target: { id: string; url: string; title: string };
}

/**
 * A page-supplied filename reduced to something safe to join onto a directory.
 *
 * `suggestedFilename` comes from the page (an `<a download>` attribute or a Content-Disposition
 * header), so it is ATTACKER-CONTROLLED in the ordinary case of driving an untrusted site. A name
 * like "../../../../etc/cron.d/x" or "/etc/passwd" would otherwise be joined straight onto the
 * downloads directory and escape it. Everything up to the last separator is discarded, then the
 * traversal and hidden-file edge cases ("", ".", "..") fall back to a fixed name. Pure, and
 * exported so every one of those cases is pinned by a unit test.
 */
export function safeFilename(suggested: string | undefined): string {
  const raw = (suggested ?? "").replace(/[\u0000-\u001f]/g, "");
  // basename() on the platform separator, plus an explicit backslash split, so a Windows-style
  // path in a header cannot survive on a POSIX host where basename() would treat it as one name.
  const name = basename(raw.split("\\").pop() ?? "").trim();
  if (!name || name === "." || name === "..") return "download";
  return name;
}

/**
 * `name`, or the first "name-N.ext" that is not already taken. Suffixed before the extension so a
 * collided "report.csv" stays a .csv file, which is the difference between the caller's next tool
 * opening it and not.
 */
export function nextFreeName(name: string, taken: ReadonlySet<string>): string {
  if (!taken.has(name)) return name;
  const ext = extname(name);
  const stem = ext ? name.slice(0, -ext.length) : name;
  for (let i = 1; ; i++) {
    const candidate = `${stem}-${i}${ext}`;
    if (!taken.has(candidate)) return candidate;
  }
}

/** Validation split out so the refusals are unit-testable without a browser. */
export function validateWaitForDownloadArgs(args: WaitForDownloadArgs): void {
  if (args.timeoutMs !== undefined) {
    if (typeof args.timeoutMs !== "number" || !Number.isFinite(args.timeoutMs) || args.timeoutMs <= 0) {
      throw new Error(`wait_for_download: 'timeoutMs' must be a positive number (got ${JSON.stringify(args.timeoutMs)})`);
    }
  }
  if (args.arm !== undefined && typeof args.arm !== "boolean") {
    throw new Error(`wait_for_download: 'arm' must be a boolean (got ${JSON.stringify(args.arm)})`);
  }
}

/**
 * Wait for the next completed download and return it as a named file on disk.
 *
 * With `arm:true` this only arms capture and returns — no waiting, no file. See the file header for
 * why arming has to happen before the triggering click.
 */
export async function waitForDownload(args: WaitForDownloadArgs = {}): Promise<WaitForDownloadResult | ArmDownloadResult> {
  validateWaitForDownloadArgs(args);
  // The lease gate, before any browser state is touched.
  const t = await resolveTarget(args.target);
  const target = { id: t.id, url: t.url, title: t.title };
  const { downloadPath } = await armDownloads();
  if (args.arm === true) return { armed: true, downloadPath, pending: pendingDownloads().length, target };

  const rec = await nextCompletedDownload(args.timeoutMs ?? 30_000);
  if (!rec.filePath) {
    throw new Error(`wait_for_download: download ${rec.guid} completed without a file path (nothing to return)`);
  }
  const suggestedFilename = safeFilename(rec.suggestedFilename);
  // Read the directory at rename time, not earlier: another download may have landed while this
  // call was waiting, and the collision set has to reflect the directory as it is now.
  const taken = new Set(await readdir(DOWNLOADS_DIR).catch(() => [] as string[]));
  taken.delete(basename(rec.filePath)); // our own guid file is not a collision with itself
  const finalName = nextFreeName(suggestedFilename, taken);
  const path = join(DOWNLOADS_DIR, finalName);
  await rename(rec.filePath, path);
  // Size from the file itself, not from the event's receivedBytes: the file on disk is what the
  // caller is about to read, and it is the only number that cannot disagree with it.
  const bytes = (await stat(path)).size;
  return { path, suggestedFilename, bytes, ...(rec.url ? { url: rec.url } : {}), target };
}
