/**
 * bidi-browser-tools.ts: Firefox (WebDriver BiDi) implementations of the two BROWSER-scoped tools,
 * `wait_for_download` (capability "browser.downloads") and `grant_permissions` ("browser.permissions").
 * Same argument schema, same validation (imported from the Chrome modules, never re-derived) and the
 * same result shapes as src/tools/downloads.ts and src/tools/permissions.ts. Both need Firefox 160+
 * (BIDI_CAPABILITY_MIN_FIREFOX in ./bidi/driver.ts); an older Firefox gets "unsupported" naming the
 * version before any browser state is touched.
 *
 * HOW THEY REACH THE CONNECTION. Both tools first acquire `driver.page(target)` — that is the
 * Firefox lease choke point (resolveContext) and the source of the `target` field — then do the
 * browser-wide work through BidiBrowserDriver.withBrowserConnection, and register a dispose hook
 * (BidiBrowserDriver.setDisposeHook) for state that must not outlive this process.
 *
 * MEASURED on headless Firefox 160.0 (probes /tmp/ffpar/dlperm/probe.ts, probe3.ts):
 *   - browser.setDownloadBehavior {type:"allowed", destinationFolder} redirects every download;
 *     `downloadBehavior: null` restores the profile's own behavior (a later download landed in the
 *     profile's browser.download.dir, not the capture folder). The override does NOT survive
 *     session.end — but in attach mode through the mux (./bidi/mux.ts) a joiner's session.end is
 *     answered locally, so the explicit null restore is the only restore there.
 *   - downloadWillBegin/downloadEnd fire for EVERY download, armed or not; the user's own downloads
 *     included. Only a download whose filepath is inside our staging folder is ever recorded.
 *   - Firefox de-duplicates a name collision itself ("one.txt" -> "one(1).txt") and reports the
 *     de-duplicated name as suggestedFilename.
 *   - permissions.setPermission: granted/denied/prompt are reflected by navigator.permissions.query.
 *     A grant SURVIVES session.end and a fresh session.new (it lives in the profile's permission
 *     manager), unlike Chrome's, which dies with the granting CDP client.
 *   - Firefox's PermissionName enum rejects clipboard-read/clipboard-write, background-sync,
 *     local-fonts, idle-detection, accelerometer ("not a valid value for enumeration"), and
 *     storage-access is "currently unsupported".
 *
 * ASYMMETRIES vs CHROME (for the README):
 *   1. Downloads: Chrome stays armed for the life of the server once armed. Firefox is armed by
 *      every wait_for_download call and DISARMED (downloadBehavior:null) when a collecting call
 *      returns or times out, so the user's everyday Firefox goes back to normal downloads. A download
 *      started after one collecting call and before the next arm is therefore not captured: on
 *      Firefox, arm (arm:true or a pending wait) before EVERY download, not just the first.
 *   2. Downloads: while armed, ANY download in that Firefox (including one the human starts) is
 *      redirected into the capture folder and can be the one a wait returns.
 *   3. Downloads: two same-named downloads both uncollected at once get Firefox's own "(1)" suffix
 *      in suggestedFilename (Firefox de-dupes inside the staging folder before we see the name);
 *      the common case still gets Chrome's "name-1.ext" via nextFreeName.
 *   4. Permissions take W3C descriptors, so Chrome PermissionType names are mapped through
 *      FIREFOX_PERMISSION_DESCRIPTORS — a local allowlist, which Chrome's implementation
 *      deliberately does not keep. A name with no measured Firefox equivalent is refused
 *      ("unsupported", naming it) before anything is granted, never silently skipped.
 *   5. Permissions persist in the Firefox profile. To keep Chrome's "the grant lives as long as the
 *      server process" contract (and leave the user's Firefox as it was), every grant is undone
 *      when the session is disposed (server shutdown; end of a CLI command) and by reset:true. The
 *      undo restores the state the page reported BEFORE the first grant when the grant origin is the
 *      target tab's own origin; for any other origin the prior state cannot be read, and it is
 *      restored to "prompt". A process killed with SIGKILL leaves its grants in the profile.
 *   6. Per CDP's docs (not measured here) Browser.grantPermissions also rejects the permissions it
 *      was NOT given for that origin; Firefox's setPermission touches only the named ones, and this
 *      implementation deliberately does not deny everything else in the user's real profile.
 *   7. All of the above was measured headless. Download-panel / dialog behavior of a headed
 *      everyday Firefox under "allowed" was not observed.
 */
import { mkdir, readdir, realpath, rename, stat } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import type { BidiConnection } from "./bidi/client.ts";
import { requireFirefox } from "./bidi/driver.ts";
import type { PermissionsPermissionDescriptor, PermissionsPermissionState } from "./bidi/protocol.ts";
import type { BrowserDriver, DriverError, PageDriver } from "./driver.ts";
import { DOWNLOADS_DIR, DOWNLOAD_BUFFER_LIMIT } from "./tools/browser-session.ts";
import {
  nextFreeName, safeFilename, validateWaitForDownloadArgs,
  type ArmDownloadResult, type WaitForDownloadArgs, type WaitForDownloadResult,
} from "./tools/downloads.ts";
import { originOf, validateGrantPermissionsArgs, type GrantPermissionsArgs, type GrantPermissionsResult } from "./tools/permissions.ts";

function unsupported(message: string): DriverError {
  return Object.assign(new Error(message), { code: "unsupported" as const }) as DriverError;
}

/** The slice of BidiConnection these tools use; a structural type so tests can pass a stub. */
export type BrowserConn = Pick<BidiConnection, "send" | "on" | "capabilities">;

/** What BidiBrowserDriver adds for browser-scoped work (see its withBrowserConnection). */
interface BrowserScope {
  withBrowserConnection<T>(fn: (conn: BrowserConn) => Promise<T>): Promise<T>;
  setDisposeHook(key: string, hook: ((conn: BrowserConn) => Promise<void>) | undefined): void;
}

function scopeOf(driver: BrowserDriver, tool: string): BrowserScope {
  const d = driver as Partial<BrowserScope>;
  if (typeof d.withBrowserConnection !== "function" || typeof d.setDisposeHook !== "function") {
    throw unsupported(`${tool}: this driver has no browser-scoped connection (the Firefox BiDi driver does; Chrome uses src/tools/).`);
  }
  return d as BrowserScope;
}

async function targetOf(driver: BrowserDriver, target: WaitForDownloadArgs["target"]): Promise<{ id: string; url: string; title: string }> {
  const page = await driver.page(target);
  try {
    return { id: page.info.id, url: page.info.url, title: page.info.title };
  } finally {
    await page.release();
  }
}

/* ===================================== downloads ===================================== */

/** Firefox writes here; wait_for_download then renames each file into DOWNLOADS_DIR under the
 *  page's own name, exactly as Chrome's guid files are renamed. A SIBLING of DOWNLOADS_DIR, never
 *  inside it, so it cannot count as a filename collision. */
export const FIREFOX_DOWNLOAD_STAGING_DIR = join(dirname(DOWNLOADS_DIR), "downloads-firefox-staging");

interface FfDownload {
  id: string;
  url?: string;
  suggestedFilename?: string;
  /** Where the finished file sits now (moved off Firefox's own name into an id-named file). */
  filePath?: string;
  state: "inProgress" | "completed";
  consumed: boolean;
}

interface DownloadState {
  downloads: FfDownload[];
  /** In-progress downloads by id, until downloadEnd decides whether they are ours. */
  begun: Map<string, FfDownload>;
  waiters: Array<(r: FfDownload) => void>;
  /** Accepted spellings of the staging folder (macOS /tmp -> /private/tmp). */
  stagingDirs: Set<string>;
}

const downloadStates = new WeakMap<object, DownloadState>();

/** willBegin/downloadEnd correlate on `download` per the spec; Firefox 160 also populates
 *  `navigation` with the same id, so either is accepted. */
function downloadId(p: { download?: unknown; navigation?: unknown }): string | undefined {
  const v = p.download ?? p.navigation;
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

function deliver(s: DownloadState, r: FfDownload): void {
  r.state = "completed";
  s.downloads.push(r);
  while (s.downloads.length > DOWNLOAD_BUFFER_LIMIT) {
    const i = s.downloads.findIndex((d) => d.consumed);
    s.downloads.splice(i >= 0 ? i : 0, 1);
  }
  const waiter = s.waiters.shift();
  if (waiter) {
    r.consumed = true;
    waiter(r);
  }
}

function downloadStateFor(conn: BrowserConn): DownloadState {
  let s = downloadStates.get(conn);
  if (s) return s;
  const state: DownloadState = { downloads: [], begun: new Map(), waiters: [], stagingDirs: new Set([resolve(FIREFOX_DOWNLOAD_STAGING_DIR)]) };
  downloadStates.set(conn, state);
  conn.on("browsingContext.downloadWillBegin", (p) => {
    const id = downloadId(p);
    if (!id) return;
    state.begun.set(id, { id, url: p.url, suggestedFilename: p.suggestedFilename, state: "inProgress", consumed: false });
    // Bound the map: a download that never reports an end must not grow it forever.
    if (state.begun.size > DOWNLOAD_BUFFER_LIMIT) state.begun.delete(state.begun.keys().next().value as string);
  });
  conn.on("browsingContext.downloadEnd", (p) => {
    const id = downloadId(p);
    if (!id) return;
    const rec = state.begun.get(id) ?? { id, state: "inProgress" as const, consumed: false };
    state.begun.delete(id);
    if (p.status !== "complete" || !p.filepath) return; // canceled, or nothing on disk: never returned
    // Only OUR captures: an unarmed download (the human's own, into their normal folder) is left alone.
    if (!state.stagingDirs.has(resolve(dirname(p.filepath)))) return;
    rec.url ??= p.url;
    const held = join(dirname(p.filepath), `${id.replace(/[^A-Za-z0-9-]/g, "_")}.download`);
    // Move off Firefox's own name at once, so the next same-named download is not de-duplicated
    // by Firefox into "name(1).ext" while this one waits to be collected.
    rename(p.filepath, held).then(
      () => { rec.filePath = held; },
      () => { rec.filePath = p.filepath ?? undefined; },
    ).finally(() => deliver(state, rec));
  });
  return state;
}

async function armFirefoxDownloads(conn: BrowserConn, s: DownloadState, scope: BrowserScope): Promise<void> {
  await mkdir(FIREFOX_DOWNLOAD_STAGING_DIR, { recursive: true });
  await mkdir(DOWNLOADS_DIR, { recursive: true });
  s.stagingDirs.add(resolve(await realpath(FIREFOX_DOWNLOAD_STAGING_DIR)));
  // The restore is registered BEFORE the override, so there is no window in which the browser is
  // redirected with nothing scheduled to put it back.
  scope.setDisposeHook("browser.downloads", async (c) => { await c.send("browser.setDownloadBehavior", { downloadBehavior: null }); });
  await conn.send("browser.setDownloadBehavior", { downloadBehavior: { type: "allowed", destinationFolder: FIREFOX_DOWNLOAD_STAGING_DIR } });
}

async function disarmFirefoxDownloads(conn: BrowserConn, scope: BrowserScope): Promise<void> {
  await conn.send("browser.setDownloadBehavior", { downloadBehavior: null });
  scope.setDisposeHook("browser.downloads", undefined);
}

function nextFirefoxDownload(s: DownloadState, timeoutMs: number): Promise<FfDownload> {
  const buffered = s.downloads.find((d) => !d.consumed);
  if (buffered) {
    buffered.consumed = true;
    return Promise.resolve(buffered);
  }
  return new Promise<FfDownload>((resolvePromise, reject) => {
    const waiter = (r: FfDownload): void => {
      clearTimeout(timer);
      resolvePromise(r);
    };
    const timer = setTimeout(() => {
      const i = s.waiters.indexOf(waiter);
      if (i >= 0) s.waiters.splice(i, 1);
      reject(new Error(
        `wait_for_download: no download completed within ${timeoutMs}ms. On Firefox, downloads are captured only while a wait_for_download call is armed: arm (arm:true) BEFORE the triggering click, and again before every later download, because each collecting call restores Firefox's normal download behavior when it returns.`,
      ));
    }, timeoutMs);
    s.waiters.push(waiter);
  });
}

/** Firefox `wait_for_download`. Same args, validation and result shapes as src/tools/downloads.ts. */
export async function waitForDownloadFirefox(driver: BrowserDriver, args: WaitForDownloadArgs = {}): Promise<WaitForDownloadResult | ArmDownloadResult> {
  validateWaitForDownloadArgs(args);
  const scope = scopeOf(driver, "wait_for_download");
  const target = await targetOf(driver, args.target); // the lease gate, before any browser state is touched
  return scope.withBrowserConnection(async (conn) => {
    requireFirefox(conn, "browser.downloads");
    const s = downloadStateFor(conn);
    await armFirefoxDownloads(conn, s, scope);
    if (args.arm === true) {
      return { armed: true as const, downloadPath: DOWNLOADS_DIR, pending: s.downloads.filter((d) => !d.consumed).length, target };
    }
    let rec: FfDownload;
    try {
      rec = await nextFirefoxDownload(s, args.timeoutMs ?? 30_000);
    } finally {
      // Put the user's Firefox back to normal downloads — unless another wait is still pending on
      // this connection, which still needs capture armed.
      if (s.waiters.length === 0) await disarmFirefoxDownloads(conn, scope).catch(() => undefined);
    }
    if (!rec.filePath) {
      throw new Error(`wait_for_download: download ${rec.id} completed without a file path (nothing to return)`);
    }
    const suggestedFilename = safeFilename(rec.suggestedFilename);
    const taken = new Set(await readdir(DOWNLOADS_DIR).catch(() => [] as string[]));
    taken.delete(basename(rec.filePath));
    const finalName = nextFreeName(suggestedFilename, taken);
    const path = join(DOWNLOADS_DIR, finalName);
    await rename(rec.filePath, path);
    const bytes = (await stat(path)).size;
    return { path, suggestedFilename, bytes, ...(rec.url ? { url: rec.url } : {}), target };
  });
}

/* ==================================== permissions ==================================== */

/**
 * Chrome PermissionType name -> the W3C PermissionDescriptor Firefox 160's permissions.setPermission
 * accepts. ONLY pairs measured working (setPermission succeeded AND navigator.permissions.query
 * followed) are listed; everything else is refused by name. Chrome's notifications grant also covers
 * push; on Firefox, granting notifications made a {name:"push"} query report "granted" too (measured).
 */
export const FIREFOX_PERMISSION_DESCRIPTORS: Readonly<Record<string, PermissionsPermissionDescriptor>> = {
  geolocation: { name: "geolocation" },
  notifications: { name: "notifications" },
  audioCapture: { name: "microphone" },
  videoCapture: { name: "camera" },
  durableStorage: { name: "persistent-storage" },
  midi: { name: "midi" },
  midiSysex: { name: "midi", sysex: true },
  wakeLockScreen: { name: "screen-wake-lock" },
};

/** Map every name or throw "unsupported" naming the first unmappable one. Pure, for unit tests. */
export function mapFirefoxPermissions(names: readonly string[]): PermissionsPermissionDescriptor[] {
  return names.map((n) => {
    const d = Object.hasOwn(FIREFOX_PERMISSION_DESCRIPTORS, n) ? FIREFOX_PERMISSION_DESCRIPTORS[n] : undefined;
    if (!d) {
      throw unsupported(
        `grant_permissions: permission '${n}' is not supported on Firefox (WebDriver BiDi permissions.setPermission has no measured equivalent). Supported on Firefox: ${Object.keys(FIREFOX_PERMISSION_DESCRIPTORS).join(", ")}.`,
      );
    }
    return d;
  });
}

interface TrackedGrant {
  origin: string;
  descriptor: PermissionsPermissionDescriptor;
  /** The state to put back on reset/dispose: what the page reported before our first grant. */
  previous: PermissionsPermissionState;
}

/** Grants this process made, per driver (the dispose hook is per driver endpoint). */
const trackedGrants = new WeakMap<object, Map<string, TrackedGrant>>();

function grantKey(origin: string, d: PermissionsPermissionDescriptor): string {
  return `${origin} ${JSON.stringify(d)}`;
}

async function restoreGrants(conn: BrowserConn, grants: Map<string, TrackedGrant>): Promise<void> {
  const all = [...grants.values()];
  grants.clear();
  for (const g of all) {
    await conn.send("permissions.setPermission", { descriptor: g.descriptor, state: g.previous, origin: g.origin });
  }
}

async function queryState(page: PageDriver, d: PermissionsPermissionDescriptor): Promise<PermissionsPermissionState> {
  try {
    const v = await page.evaluate(
      `navigator.permissions.query(${JSON.stringify(d)}).then((p) => p.state, () => "prompt")`,
      { awaitPromise: true },
    );
    return v === "granted" || v === "denied" ? v : "prompt";
  } catch {
    return "prompt";
  }
}

/** Firefox `grant_permissions`. Same args, validation and result shape as src/tools/permissions.ts. */
export async function grantPermissionsFirefox(driver: BrowserDriver, args: GrantPermissionsArgs = {}): Promise<GrantPermissionsResult> {
  validateGrantPermissionsArgs(args);
  const reset = args.reset === true;
  const permissions = args.permissions ?? [];
  // Every name is mapped BEFORE anything is granted: one bad name must not leave a half-applied grant.
  const descriptors = mapFirefoxPermissions(permissions);
  const scope = scopeOf(driver, "grant_permissions");
  let grants = trackedGrants.get(driver);
  if (!grants) { grants = new Map(); trackedGrants.set(driver, grants); }
  const tracked = grants;

  const page = await driver.page(args.target); // the lease gate
  try {
    const target = { id: page.info.id, url: page.info.url, title: page.info.title };
    return await scope.withBrowserConnection(async (conn) => {
      requireFirefox(conn, "browser.permissions");
      if (reset) await restoreGrants(conn, tracked);
      if (permissions.length === 0) return { reset: true as const, target };

      const origin = args.origin ?? originOf(page.info.url);
      if (!origin) {
        throw new Error(
          `grant_permissions: cannot derive an origin from the target tab's url (${JSON.stringify(page.info.url)}); pass 'origin' explicitly, e.g. origin:"https://example.com"`,
        );
      }
      const pageIsOrigin = originOf(page.info.url) === origin;
      // Restore is registered before the first grant lands (see armFirefoxDownloads for why).
      scope.setDisposeHook("browser.permissions", (c) => restoreGrants(c, tracked));
      for (const d of descriptors) {
        const key = grantKey(origin, d);
        if (!tracked.has(key)) {
          tracked.set(key, { origin, descriptor: d, previous: pageIsOrigin ? await queryState(page, d) : "prompt" });
        }
        await conn.send("permissions.setPermission", { descriptor: d, state: "granted", origin });
      }
      return { granted: [...permissions], origin, ...(reset ? { reset: true as const } : {}), target };
    });
  } finally {
    await page.release();
  }
}

/** Registered in src/firefox-tools.ts. */
export const BIDI_BROWSER_TOOLS = {
  wait_for_download: waitForDownloadFirefox,
  grant_permissions: grantPermissionsFirefox,
} satisfies Record<string, (driver: BrowserDriver, args: never) => Promise<unknown>>;
