/**
 * Headless Firefox end-to-end smoke test for the WebDriver BiDi backend.
 *
 * Unlike test/smoke.ts (which drives an already-running Chrome on CDP_BASE),
 * this script owns the whole lifecycle itself: it launches a throwaway
 * headless Firefox via src/bidi/launch.ts, serves the local fixtures over
 * Bun.serve on an ephemeral port (never file://, never a shared debug port),
 * and tears the process down again. It NEVER connects to port 9333 or any
 * other fixed port — that convention is reserved for a real Chrome the
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
  console.log(`${ok ? "PASS" : "FAIL"} ${name} — ${detail}`);
}

let launchedPid: number | undefined;
const hardTimer: ReturnType<typeof setTimeout> = setTimeout(() => {
  console.error(`FAIL wall-clock cap — did not finish within ${WALL_CLOCK_MS}ms, killing Firefox and exiting`);
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

  // --- 8. a Chrome-only capability is reported ABSENT for the Firefox backend ---
  // heap.snapshot (V8 heap snapshots) has no BiDi/Firefox equivalent at all,
  // per bidi/driver.ts's BIDI_CAPABILITIES / footer comment.
  const hasHeapSnapshot = driver.capabilities.has("heap.snapshot");
  record(
    "Chrome-only capability (heap.snapshot) is absent on the Firefox backend",
    hasHeapSnapshot === false,
    `capabilities=${[...driver.capabilities].sort().join(",")}`,
  );

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
