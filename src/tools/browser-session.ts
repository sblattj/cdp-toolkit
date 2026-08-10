/**
 * browser-session.ts: ONE standing connection to the CDP **browser** endpoint, held open across
 * tool calls, owning the browser-client-scoped state behind `wait_for_download` and
 * `grant_permissions` (1.8.0 Track P3).
 *
 * WHY A STANDING CONNECTION IS NOT OPTIONAL HERE
 * ==============================================
 * The 1.8.0 spec described wait_for_download as "the server subscribes to
 * Browser.downloadWillBegin/downloadProgress and keeps a ring buffer", which silently assumes a
 * connection that outlives a tool call. This toolkit's CDP lifetime is per-call (ADR-001,
 * driver.ts: "per-call": acquiring opens a transport and release() closes it), so that assumption
 * had to be checked rather than inherited — the same spec had already shipped one false
 * protocol assertion that Track S1 caught the same way.
 *
 * MEASURED, against an isolated headless Chrome 151 on macOS (three controls, one variable — the
 * arming client's liveness — with the click, the page, and the download path held identical):
 *
 *   A. armer connection OPEN across the click .............. BOTH downloads landed in downloadPath;
 *      Browser.downloadWillBegin + downloadProgress{state:"completed"} arrived on the armer.
 *   B. armer connection CLOSED before the click ............ ZERO files. No events anywhere.
 *   C. armed from the PAGE endpoint, then closed .......... ZERO files.
 *
 * So `Browser.setDownloadBehavior{behavior:"allowAndName", downloadPath, eventsEnabled:true}` does
 * NOT persist browser-side after the arming client disconnects: it is per-client state that Chrome
 * reverts on disconnect, and headless Chrome's default is to deny downloads, so the file does not
 * merely go somewhere else — it never happens at all.
 *
 * The same experiment run for permissions gives the same verdict: `Browser.grantPermissions` on
 * either endpoint, followed by that connection closing, leaves
 * `navigator.permissions.query({name:"geolocation"}).state` at "prompt", never "granted". Both
 * features therefore need a connection someone keeps open. That is this module.
 *
 * WHAT A DIRECTORY WATCHER WOULD AND WOULD NOT BUY. Watching downloadPath for a new file (and its
 * .crdownload disappearing) was the obvious per-call fallback, and it does not work on its own:
 * with nothing armed, the download is denied and the directory stays empty forever, so the watcher
 * would poll a directory that can never fill. Once something IS armed, the standing connection
 * already receives `Browser.downloadProgress{state:"completed", filePath}` — which carries the
 * finished path directly, so there is nothing left for a watcher to discover. It is not implemented
 * because it would be strictly redundant, not because it was overlooked.
 *
 * LIFETIME AND ITS HONEST LIMIT. The connection is opened LAZILY, on the first call to one of the
 * two tools, so a session that never downloads and never grants permissions opens nothing and pays
 * nothing. It then lives until the process exits. Under the MCP server (a long-lived process) that
 * spans many tool calls, which is what makes "arm, click in a later call, wait in a later call
 * still" work. Under the CLI — one process per command — it dies at process exit, so both tools are
 * MCP-server capabilities, exactly like network_mock.ts's persistent fake backends and recorder.ts's
 * background mode, and for exactly the same reason.
 *
 * If the connection dies (browser exited, socket dropped), the arm and every grant made through it
 * are gone with it; the session is marked dead and the next call opens a fresh one and RE-ARMS the
 * download behavior it remembers. Permission grants cannot be replayed that way — this module never
 * pretends a grant survived a reconnect, because a caller told "granted" for a permission the
 * browser has since forgotten would act on it.
 */
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { openBrowser, type CdpConnection } from "../client.ts";

/** Artifact root, captured at import exactly like every other module here (screencast, heap, ...). */
const ARTIFACT_DIR = process.env.CDP_ARTIFACT_DIR ?? "/tmp/cdp-toolkit";

/** Where armed downloads are written, before wait_for_download renames each guid to its filename. */
export const DOWNLOADS_DIR = join(ARTIFACT_DIR, "downloads");

/** How many finished downloads the ring buffer keeps. Same intent as recorder.ts's buffers: enough
 *  that a caller who triggered several downloads before waiting gets them all, bounded so a
 *  long-lived server cannot grow this without limit. */
export const DOWNLOAD_BUFFER_LIMIT = 50;

/** One download, as the standing connection observed it. */
export interface DownloadRecord {
  guid: string;
  /** Source URL, from Browser.downloadWillBegin. */
  url?: string;
  /** The page's own name for the file (the `download` attribute / Content-Disposition). UNTRUSTED:
   *  it is page-controlled, so downloads.ts sanitizes it before it ever reaches a filesystem path. */
  suggestedFilename?: string;
  /** Bytes received, from the terminal Browser.downloadProgress. */
  bytes?: number;
  /** Absolute path Chrome wrote, straight off the completed event — never reconstructed by us. */
  filePath?: string;
  state: "inProgress" | "completed" | "canceled";
  /** True once a wait_for_download call has returned this record, so two waits never answer with
   *  the same download. */
  consumed: boolean;
}

interface BrowserSession {
  conn: CdpConnection;
  /** The path passed to setDownloadBehavior on this connection; undefined until armed. */
  armedPath?: string;
  downloads: DownloadRecord[];
  /** Resolvers waiting for the next completed download, in FIFO order. */
  waiters: Array<(r: DownloadRecord) => void>;
  dead: boolean;
}

let session: BrowserSession | undefined;

/** True for the errors that mean "this socket is gone", not "the command was rejected". */
function isDisconnect(e: unknown): boolean {
  const m = e instanceof Error ? e.message : String(e);
  return /connection (not open|closed)|closed by caller|websocket|ECONNREFUSED|socket/i.test(m);
}

function record(s: BrowserSession, guid: string): DownloadRecord {
  let r = s.downloads.find((d) => d.guid === guid);
  if (!r) {
    r = { guid, state: "inProgress", consumed: false };
    s.downloads.push(r);
    // Drop the OLDEST already-consumed record first, and only fall back to dropping an unconsumed
    // one when the buffer is full of them: evicting a download nobody has collected yet is how a
    // caller silently loses a file they are about to ask for.
    while (s.downloads.length > DOWNLOAD_BUFFER_LIMIT) {
      const i = s.downloads.findIndex((d) => d.consumed);
      s.downloads.splice(i >= 0 ? i : 0, 1);
    }
  }
  return r;
}

/** Wire the download event handlers onto a freshly opened connection. */
function subscribe(s: BrowserSession): void {
  s.conn.on("Browser.downloadWillBegin", (p) => {
    const r = record(s, String(p.guid));
    if (typeof p.url === "string") r.url = p.url;
    if (typeof p.suggestedFilename === "string") r.suggestedFilename = p.suggestedFilename;
  });
  s.conn.on("Browser.downloadProgress", (p) => {
    const r = record(s, String(p.guid));
    if (typeof p.receivedBytes === "number") r.bytes = p.receivedBytes;
    if (typeof p.filePath === "string") r.filePath = p.filePath;
    const state = String(p.state);
    if (state === "completed" || state === "canceled") {
      r.state = state;
      // Hand a completed download straight to the longest-waiting caller. Marking it consumed HERE
      // (not in the waiter) closes the race where a second waiter, scheduled between this callback
      // and the first waiter resuming, scans the buffer and claims the same record.
      if (state === "completed") {
        const waiter = s.waiters.shift();
        if (waiter) {
          r.consumed = true;
          waiter(r);
        }
      }
    }
  });
}

/**
 * The standing connection, opened on first use and reused forever after. Re-arms the download
 * behavior when a dead connection is replaced, so a browser restart does not silently leave the
 * caller unarmed while every call still reports success.
 */
export async function getBrowserSession(): Promise<BrowserSession> {
  if (session && !session.dead) return session;
  const previousPath = session?.armedPath;
  const conn = await openBrowser();
  const s: BrowserSession = { conn, downloads: [], waiters: [], dead: false };
  subscribe(s);
  session = s;
  if (previousPath) await armDownloadsAt(previousPath);
  return s;
}

/** Send on the standing connection, marking the session dead if the socket turned out to be gone. */
export async function browserSend<T = Record<string, unknown>>(method: string, params: Record<string, unknown> = {}): Promise<T> {
  const s = await getBrowserSession();
  try {
    return await s.conn.send<T>(method, params);
  } catch (e) {
    if (isDisconnect(e)) {
      s.dead = true;
      // One retry on a fresh connection: a socket that died between calls is the expected case
      // (the browser was restarted), not an error the caller can act on.
      const fresh = await getBrowserSession();
      return await fresh.conn.send<T>(method, params);
    }
    throw e;
  }
}

/** Point Chrome's downloads at `path` on the standing connection, creating the directory first. */
async function armDownloadsAt(path: string): Promise<void> {
  await mkdir(path, { recursive: true });
  const s = await getBrowserSession();
  await s.conn.send("Browser.setDownloadBehavior", { behavior: "allowAndName", downloadPath: path, eventsEnabled: true });
  s.armedPath = path;
}

/**
 * Ensure downloads are captured to DOWNLOADS_DIR. Idempotent and cheap to repeat: re-issuing
 * setDownloadBehavior with identical parameters is accepted by Chrome (verified), so every
 * wait_for_download call can arm without tracking whether some earlier call already did.
 */
export async function armDownloads(): Promise<{ downloadPath: string }> {
  const s = await getBrowserSession();
  if (s.armedPath !== DOWNLOADS_DIR) await armDownloadsAt(DOWNLOADS_DIR);
  return { downloadPath: DOWNLOADS_DIR };
}

/** Completed-but-uncollected downloads, oldest first. */
export function pendingDownloads(): DownloadRecord[] {
  return (session?.downloads ?? []).filter((d) => d.state === "completed" && !d.consumed);
}

/**
 * The next completed download nobody has collected: one already buffered, else the next one to
 * finish, else a timeout. Buffered-first is what makes "click in one tool call, wait in a later
 * one" work — the standing connection recorded the completion while no tool call was running.
 */
export async function nextCompletedDownload(timeoutMs: number): Promise<DownloadRecord> {
  const s = await getBrowserSession();
  const buffered = s.downloads.find((d) => d.state === "completed" && !d.consumed);
  if (buffered) {
    buffered.consumed = true;
    return buffered;
  }
  return new Promise<DownloadRecord>((resolve, reject) => {
    const waiter = (r: DownloadRecord): void => {
      clearTimeout(timer);
      resolve(r);
    };
    const timer = setTimeout(() => {
      const i = s.waiters.indexOf(waiter);
      if (i >= 0) s.waiters.splice(i, 1);
      reject(new Error(
        `wait_for_download: no download completed within ${timeoutMs}ms. Downloads are only captured while this server holds the arming connection, so the triggering click must come AFTER a wait_for_download call (use arm:true to arm without waiting).`,
      ));
    }, timeoutMs);
    s.waiters.push(waiter);
  });
}

/** Close the standing connection. For process shutdown and tests; safe to call when none is open. */
export async function disposeBrowserSession(): Promise<void> {
  const s = session;
  session = undefined;
  if (!s) return;
  s.dead = true;
  try {
    s.conn.close();
  } catch {
    /* already gone */
  }
}
