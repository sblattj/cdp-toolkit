/**
 * Headless Firefox end-to-end smoke test for the WebDriver BiDi backend.
 *
 * Unlike test/smoke.ts (which drives an already-running Chrome on CDP_BASE),
 * this script owns the whole lifecycle itself: it launches a throwaway
 * headless Firefox via src/bidi/launch.ts, serves the local fixtures over
 * Bun.serve on an ephemeral port (never file://, never a shared debug port),
 * and tears the process down again. It NEVER connects to port 9222 or any
 * other fixed port: that convention is reserved for a real Chrome the
 * developer may have running locally, and this script must not touch it.
 *
 * Exits non-zero on any failed assertion. The launched Firefox is killed in
 * a `finally` so a mid-test throw can never leak a process, and a hard
 * wall-clock cap kills it and exits non-zero if something hangs, so this
 * can never wedge CI. Run with `bun run firefox:smoke`.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { launchFirefox, type LaunchedFirefox } from "../src/bidi/launch.ts";
import { createFirefoxDriver } from "../src/bidi/driver.ts";
import { BEACON_INSTALLED_GLOBAL } from "../src/activity.ts";
import type { BrowserDriver } from "../src/driver.ts";

// Minimal ambient shape for the bit of the Bun global this file uses. No
// bun-types devDep (CONTRACT.md forbids adding one for a devDep-only need,
// same rule test/bidi_snapshot.test.ts's header cites for happy-dom); this is
// the runtime-provided global under `tsc --noEmit`'s "node" + "DOM" libs.
declare const Bun: {
  serve(opts: {
    port: number;
    hostname: string;
    fetch(req: Request): Response | Promise<Response>;
  }): { port: number; stop(closeActiveConnections?: boolean): void };
};

const HERE = fileURLToPath(new URL(".", import.meta.url));
const FIXTURES_DIR = join(HERE, "fixtures");
const WALL_CLOCK_MS = 120_000;
const UID_RE = /^bidi:[0-9a-f]{12}$/;

type Check = { name: string; ok: boolean; detail: string };
const checks: Check[] = [];
function record(name: string, ok: boolean, detail: string): void {
  checks.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"} ${name}: ${detail}`);
}

let launchedPid: number | undefined;
const hardTimer: ReturnType<typeof setTimeout> = setTimeout(() => {
  console.error(`FAIL wall-clock cap: did not finish within ${WALL_CLOCK_MS}ms, killing Firefox and exiting`);
  if (launchedPid !== undefined) {
    try {
      process.kill(launchedPid, "SIGKILL");
    } catch {
      /* already gone */
    }
  }
  process.exit(1);
}, WALL_CLOCK_MS);

// Serve the fixtures directory over HTTP on an ephemeral port. No file://.
const server = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  fetch(req) {
    const url = new URL(req.url);
    const name = url.pathname.replace(/^\//, "") || "form.html";
    if (!/^[a-zA-Z0-9_-]+\.html$/.test(name)) return new Response("not found", { status: 404 });
    try {
      const body = readFileSync(join(FIXTURES_DIR, name));
      return new Response(body, { headers: { "content-type": "text/html; charset=utf-8" } });
    } catch {
      return new Response("not found", { status: 404 });
    }
  },
});
const BASE_URL = `http://127.0.0.1:${server.port}`;

let launched: LaunchedFirefox | undefined;
let driver: BrowserDriver | undefined;

try {
  // --- 1. browser launches and the BiDi session establishes ---
  launched = await launchFirefox({ headless: true });
  launchedPid = launched.pid;
  driver = createFirefoxDriver(launched.port);
  const pages = await driver.listPages();
  record(
    "browser launches and BiDi session establishes",
    pages.length > 0,
    `port=${launched.port} pid=${launched.pid} pages=${pages.length}`,
  );

  const page = await driver.page(undefined);

  // --- 2. navigate to the form.html fixture succeeds ---
  const nav = await page.navigate({ url: `${BASE_URL}/form.html` });
  record("navigate_page to form.html fixture succeeds", nav.url.includes("form.html"), `url=${nav.url}`);

  // --- 3. snapshot returns nodes with the bidi:<12 lowercase hex> uid scheme ---
  const nodes = await page.snapshot();
  const allMatch = nodes.length > 0 && nodes.every((n) => UID_RE.test(n.uid));
  record(
    "snapshot returns nodes with bidi:<12 lowercase hex> uids",
    allMatch,
    `nodeCount=${nodes.length}, sample=${nodes[0]?.uid ?? "n/a"}`,
  );

  // --- 4. a uid resolves back to the same element on a second call ---
  const uid1 = await page.locate({ css: "#name-input" });
  const uid2 = await page.locate({ css: "#name-input" });
  record(
    "uid resolves back to the same element on a second call",
    uid1 === uid2 && UID_RE.test(uid1),
    `uid1=${uid1} uid2=${uid2}`,
  );

  // --- 5. fill/setValue on a text input lands the value ---
  await page.setValue({ css: "#name-input" }, "hello firefox smoke");
  const inputValue = await page.evaluate("document.getElementById('name-input').value");
  record(
    "fill/setValue on a text input lands the value",
    inputValue === "hello firefox smoke",
    `value=${JSON.stringify(inputValue)}`,
  );

  // --- 6. fill/setValue on the contenteditable fixture lands the text ---
  await page.navigate({ url: `${BASE_URL}/contenteditable.html` });
  await page.setValue({ css: "#prefilled-editable" }, "smoke edited text");
  const editableText = await page.evaluate("document.getElementById('prefilled-editable').textContent");
  record(
    "fill/setValue on the contenteditable fixture lands the text",
    editableText === "smoke edited text",
    `text=${JSON.stringify(editableText)}`,
  );

  // --- 7. click works and a page-observable effect fires ---
  await page.navigate({ url: `${BASE_URL}/form.html` });
  await page.setValue({ css: "#name-input" }, "hello firefox smoke");
  await page.click({ css: "#submit-button" });
  const resultText = await page.evaluate("document.getElementById('result').textContent");
  record(
    "click works and a page-observable effect fires",
    resultText === "submitted: hello firefox smoke",
    `result=${JSON.stringify(resultText)}`,
  );

  // --- 7b. navigate history back/forward over BiDi (1.8.0 Track P3) ---
  // navigate_page's `history` param is one of the few 1.8.0 features required on BOTH backends, so
  // the BiDi half is proved here rather than asserted from the Chrome result. It exercises the
  // path that has no Chrome counterpart: browsingContext.traverseHistory takes no `wait` parameter,
  // so bidi/driver.ts owns the readiness wait itself (settleAfterTraversal).
  await page.navigate({ url: `${BASE_URL}/form.html` });
  await page.navigate({ url: `${BASE_URL}/contenteditable.html` });
  const backNav = await page.navigate({ history: "back" });
  const urlAfterBack = await page.evaluate("location.href");
  record(
    "navigate history:'back' traverses to the previous page (BiDi traverseHistory)",
    backNav.traversed === "back" && String(urlAfterBack).includes("form.html") && backNav.url.includes("form.html"),
    `result url=${backNav.url} traversed=${backNav.traversed} waitedFor=${backNav.waitedFor}; location=${String(urlAfterBack)}`,
  );

  const fwdNav = await page.navigate({ history: "forward" });
  const urlAfterForward = await page.evaluate("location.href");
  record(
    "navigate history:'forward' traverses back to the later page (BiDi traverseHistory)",
    fwdNav.traversed === "forward" && String(urlAfterForward).includes("contenteditable.html"),
    `result url=${fwdNav.url} traversed=${fwdNav.traversed} waitedFor=${fwdNav.waitedFor}; location=${String(urlAfterForward)}`,
  );

  // The traversal we just did left this context on its NEWEST history entry, so one more 'forward'
  // has nowhere to go. NavigateOptions.history forbids a silent no-op on every backend, and Firefox
  // phrases its own refusal as "History entry with delta 1 not found" — a message that never names
  // the direction the caller asked for — so bidi/driver.ts rewraps it. This pins that the Firefox
  // error reads the same as the Chrome one rather than leaking the protocol's wording.
  let ffBoundaryError = "";
  try {
    await page.navigate({ history: "forward", timeoutMs: 3000 });
  } catch (err) {
    ffBoundaryError = err instanceof Error ? err.message : String(err);
  }
  record(
    "navigate history past the end of the stack ERRORS naming the direction, never a silent no-op",
    /no history entry to go forward to/.test(ffBoundaryError),
    `error=${JSON.stringify(ffBoundaryError)}`,
  );

  // --- 7c. the two Chrome-only P3 tools are ABSENT from this backend, not present-and-throwing ---
  const p3Caps = { downloads: driver.capabilities.has("browser.downloads"), permissions: driver.capabilities.has("browser.permissions") };
  record(
    "wait_for_download / grant_permissions capabilities are absent on the Firefox backend (ADR-001)",
    p3Caps.downloads === false && p3Caps.permissions === false,
    `browser.downloads=${p3Caps.downloads} browser.permissions=${p3Caps.permissions}`,
  );

  // --- 8. a Chrome-only capability is reported ABSENT for the Firefox backend ---
  // heap.snapshot (V8 heap snapshots) has no BiDi/Firefox equivalent at all,
  // per bidi/driver.ts's BIDI_CAPABILITIES / footer comment.
  const hasHeapSnapshot = driver.capabilities.has("heap.snapshot");
  record(
    "Chrome-only capability (heap.snapshot) is absent on the Firefox backend",
    hasHeapSnapshot === false,
    `capabilities=${[...driver.capabilities].sort().join(",")}`,
  );

  // --- 8b. the activity beacon installs, records, and survives navigation ---
  // Firefox gets for free the property Chrome needs a held socket for: this
  // driver's LifetimeModel is "session", so a script.addPreloadScript
  // registration lives as long as the memoized BiDi connection. Chrome clears
  // its equivalent when the registering client disconnects, and this toolkit
  // disconnects after every call, which is why cdp/driver.ts holds one socket
  // per beaconed tab and this backend holds none. That asymmetry is the reason
  // this assertion exists here as well as in test/staleness-smoke.ts: it is the
  // same promise kept by a completely different mechanism.
  const beaconPage = await driver.page(undefined);
  const beaconContext = beaconPage.info.id;
  await beaconPage.navigate({ url: `${BASE_URL}/form.html` });
  const beaconInstalled = await driver.installActivityBeacon!(beaconContext);
  record(
    "activity beacon installs on a Firefox context",
    beaconInstalled === true && (await beaconPage.evaluate(`window.${BEACON_INSTALLED_GLOBAL} === true`)) === true,
    `installActivityBeacon=${beaconInstalled}, window.${BEACON_INSTALLED_GLOBAL} set in page`,
  );
  record(
    "a freshly beaconed context reports no input yet",
    (await driver.readActivityBeacon!(beaconContext)) === null,
    "readActivityBeacon=null before anything touches the page",
  );

  await beaconPage.click({ css: "#submit-button" });
  const beaconTs = await driver.readActivityBeacon!(beaconContext);
  record(
    // Firefox's synthesized input is as indistinguishable in-page as Chrome's:
    // the beacon moves for it, which is exactly why attribution cannot be done
    // in the page and needs the dispatch-log correlation above this layer.
    "the beacon records synthesized input",
    typeof beaconTs === "number",
    `readActivityBeacon=${JSON.stringify(beaconTs)} after a driver click`,
  );

  await beaconPage.navigate({ url: `${BASE_URL}/contenteditable.html` });
  record(
    "the beacon survives navigation with NO held connection (BiDi preload script)",
    (await beaconPage.evaluate(`window.${BEACON_INSTALLED_GLOBAL} === true`)) === true &&
      (await driver.readActivityBeacon!(beaconContext)) === null,
    "re-armed in a document nothing injected into directly; timestamp reset with the document",
  );
  await beaconPage.release();

  await page.release();
} catch (err) {
  record("FATAL", false, err instanceof Error ? (err.stack ?? err.message) : String(err));
} finally {
  clearTimeout(hardTimer);

  try {
    if (driver) await driver.dispose();
  } catch {
    /* best effort */
  }
  try {
    if (launched) await launched.close();
  } catch {
    /* best effort */
  }

  // --- 9. the browser shuts down cleanly and the launched process is gone ---
  let processGone = true;
  if (launchedPid !== undefined) {
    try {
      process.kill(launchedPid, 0); // signal 0: existence check, no actual signal sent
      processGone = false;
    } catch {
      processGone = true; // ESRCH: no such process
    }
  }
  record("browser shuts down cleanly and the launched process is gone", processGone, `pid=${launchedPid}`);

  server.stop(true);
}

const failed = checks.filter((c) => !c.ok);
console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`);
if (failed.length) {
  console.error(`FAILED: ${failed.map((c) => c.name).join(", ")}`);
  process.exit(1);
}
console.log("FIREFOX SMOKE OK");
process.exit(0);
