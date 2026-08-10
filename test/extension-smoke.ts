/**
 * MV3 extension harness: evaluate_script against a real extension's background
 * SERVICE WORKER, in a real Chrome, including waking one that Chrome has
 * genuinely idle-evicted.
 *
 * WHY NONE OF THIS CAN BE A UNIT TEST. Every load-bearing claim of the 1.9.0
 * worker feature is a claim about Chrome, and each one was measured to be the
 * OPPOSITE of the obvious guess:
 *
 *   1. `--load-extension` is inert on Chrome 151 even with the documented
 *      unblock flag (`--disable-features=DisableLoadExtensionCommandLineSwitch`).
 *      The extension never installs — verified against the ServiceWorker
 *      REGISTRATION inventory, which lists stopped workers, so "it installed but
 *      is merely asleep" is excluded. The CDP `Extensions.loadUnpacked` command
 *      is what works, and this harness uses it.
 *   2. A stopped MV3 worker is not a target: absent from /json/list and from
 *      Target.getTargets under every filter. So "no such worker" is usually
 *      "asleep", which is what wake exists for.
 *   3. `ServiceWorker.startWorker` returns EMPTY SUCCESS for a scope that does
 *      not exist. A test that trusted its result would pass against a wake that
 *      never happened, so every wake assertion here is a re-read of the target
 *      list plus the fixture's own restart counter.
 *   4. An attached CDP session KEEPS A WORKER ALIVE. The eviction wait below
 *      therefore holds no connection, and would hang forever if the toolkit's
 *      per-call connection model ever regressed to a held one.
 *
 * ============================ SAFETY RULES ============================
 *   - This harness LAUNCHES ITS OWN Chrome, headless, on a scratch port
 *     (EXTENSION_SMOKE_PORT, default 9517) with a throwaway --user-data-dir,
 *     and kills it on the way out. It NEVER attaches to a browser it did not
 *     start, and it refuses outright if anything already answers on that port.
 *   - PORT 9222 IS THE OWNER'S LIVE BROWSER AND IS REFUSED OUTRIGHT. This
 *     harness INSTALLS AN EXTENSION into whatever browser it talks to; doing
 *     that to a person's real profile is unforgivable.
 *   - It installs one extension, from this repo's own test/fixtures directory,
 *     into a profile created seconds earlier and deleted on exit.
 *   - Lease and state files go to a private temp dir, removed on exit.
 * ======================================================================
 *
 * Run with `bun run test/extension-smoke.ts`. Prints one PASS/FAIL line per
 * assertion and exits non-zero naming every failure.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/* ------------------------------- safety preflight ------------------------------- */

const PORT = Number(process.env.EXTENSION_SMOKE_PORT ?? 9517);
if (PORT === 9222) {
  console.error("FATAL: 9222 is the owner's live browser. This harness installs an extension; it never runs there.");
  process.exit(1);
}
const SMOKE_BASE = `http://127.0.0.1:${PORT}`;

// client.ts reads CDP_BASE into a MODULE-LEVEL const at import time, so it has
// to be set before the toolkit is imported (hence the dynamic imports below),
// and ONE process can only ever speak to ONE browser. Overriding any inherited
// CDP_BASE is deliberate: an inherited 9222 would be catastrophic here.
process.env.CDP_BASE = SMOKE_BASE;

const artifactDir = await mkdtemp(join(tmpdir(), "cdp-extension-smoke-"));
const profileDir = await mkdtemp(join(tmpdir(), "cdp-extension-chrome-"));
process.env.CDP_ARTIFACT_DIR = artifactDir;
process.env.CDP_STATE_DIR = artifactDir;

const { TOOLS } = await import("../src/index.ts");
const { markLongLivedProcess } = await import("../src/leases.ts");
const { openBrowser, listTargets } = await import("../src/client.ts");

// requireLease() is gated on BOTH CDP_REQUIRE_LEASE and "this is the long-lived
// MCP process"; only mcp.ts calls this in production, and importing src/index.ts
// directly bypasses it. Without this the strict-mode section below would prove
// nothing, because the gate it is asserting about would never run at all.
markLongLivedProcess();

const CHROME = process.env.CHROME_PATH ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "mv3-extension");

/**
 * Chrome's id for an unpacked extension: the first 32 hex digits of the
 * SHA-256 of the absolute path, mapped 0-f -> a-p. Computed independently here
 * so the harness can ASSERT the id Chrome returns rather than just believing it
 * — which is also what makes it impossible to mistake one of Chrome's built-in
 * component extensions (there is a service worker among them, running at
 * launch) for the fixture.
 */
function unpackedExtensionId(path: string): string {
  const hex = createHash("sha256").update(path, "utf8").digest("hex").slice(0, 32);
  return [...hex].map((c) => String.fromCharCode(97 + parseInt(c, 16))).join("");
}
const EXT_ID = unpackedExtensionId(FIXTURE);
const WORKER_SELECTOR = `worker:${EXT_ID}`;

/* --------------------------------- assertions --------------------------------- */

interface Check {
  name: string;
  ok: boolean;
  detail: string;
}
const checks: Check[] = [];
function record(name: string, ok: boolean, detail: string): void {
  checks.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"} ${name}: ${detail}`);
}
const pause = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function refuseIfOccupied(): Promise<void> {
  try {
    const res = await fetch(`${SMOKE_BASE}/json/version`, { signal: AbortSignal.timeout(1_500) });
    if (res.ok) {
      console.error(`FATAL: something is already listening on ${SMOKE_BASE}. This harness only drives a browser it launched itself; refusing to attach.`);
      process.exit(1);
    }
  } catch {
    /* nothing there: exactly what we want */
  }
}

async function waitForBrowser(child: ChildProcess): Promise<void> {
  for (let i = 0; i < 150; i++) {
    if (child.exitCode !== null) throw new Error(`chrome exited early with code ${child.exitCode}`);
    try {
      if ((await fetch(`${SMOKE_BASE}/json/version`, { signal: AbortSignal.timeout(1_000) })).ok) return;
    } catch {
      /* not up yet */
    }
    await pause(100);
  }
  throw new Error(`chrome never answered on ${SMOKE_BASE}`);
}

/** The fixture's worker target, or undefined when Chrome has it stopped. */
async function fixtureWorker(): Promise<{ id: string; url: string } | undefined> {
  return (await listTargets()).find((t) => t.type === "service_worker" && t.url.includes(EXT_ID));
}

/** Lease files only — origin records live in the same directory. */
async function leaseFiles(): Promise<string[]> {
  return (await readdir(artifactDir)).filter((f) => f.startsWith("lease-"));
}

/** Read the fixture's restart counter THROUGH THE TOOL under test. */
async function readStarts(): Promise<number> {
  const value = (await TOOLS.evaluate_script({
    target: WORKER_SELECTOR,
    expression: "chrome.storage.local.get('starts')",
  })) as { starts?: number };
  return Number(value?.starts ?? -1);
}

/* ------------------------------------ the run ------------------------------------ */

let chrome: ChildProcess | undefined;

try {
  await refuseIfOccupied();

  chrome = spawn(
    CHROME,
    [
      "--headless=new",
      `--remote-debugging-port=${PORT}`,
      `--user-data-dir=${profileDir}`,
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-background-networking",
      // NOTE: no --disable-extensions here, unlike the other smokes. Also no
      // --load-extension: it is inert on Chrome 151 (see the header) and having
      // it here would suggest it is doing the work that loadUnpacked does.
      "about:blank",
    ],
    { stdio: "ignore" },
  );
  await waitForBrowser(chrome);
  const version = (await (await fetch(`${SMOKE_BASE}/json/version`)).json()) as { Browser: string };
  record(
    "isolated browser launched on the scratch port",
    PORT !== 9222,
    `${version.Browser} on ${SMOKE_BASE}, profile=${profileDir}, artifacts=${artifactDir}`,
  );

  /* --- 1. install the fixture, and prove it is OURS --- */
  const browser = await openBrowser();
  let loadedId = "";
  try {
    const res = await browser.send<{ id?: string }>("Extensions.loadUnpacked", { path: FIXTURE });
    loadedId = String(res.id ?? "");
  } finally {
    // Dispose or the process never exits — and a held session also suppresses
    // the eviction this file goes on to require.
    browser.close();
  }
  record(
    "Extensions.loadUnpacked installed the fixture, and its id matches the path-derived id",
    loadedId === EXT_ID && loadedId.length === 32,
    `chrome returned '${loadedId}', computed '${EXT_ID}' from ${FIXTURE}`,
  );

  /* --- 2. THE FIELD AGENT'S CASE: read chrome.storage.local out of the SW --- */
  const storage = (await TOOLS.evaluate_script({
    target: WORKER_SELECTOR,
    expression: "chrome.storage.local.get(null)",
  })) as { probe?: string; starts?: number };
  record(
    "evaluate_script{target:'worker:<ext-id>'} reads chrome.storage.local from the extension's service worker",
    storage?.probe === "mv3-fixture-ok",
    `value=${JSON.stringify(storage)}`,
  );

  /* --- 3. it really ran IN THE WORKER, not in some page --- */
  const scope = await TOOLS.evaluate_script({ target: WORKER_SELECTOR, expression: "self.constructor.name" });
  record(
    "the evaluation landed in the worker's own global scope",
    scope === "ServiceWorkerGlobalScope",
    `self.constructor.name = ${JSON.stringify(scope)}`,
  );
  const runtimeId = await TOOLS.evaluate_script({ target: WORKER_SELECTOR, expression: "chrome.runtime.id" });
  record(
    "the worker exposes the extension's own chrome.runtime",
    runtimeId === EXT_ID,
    `chrome.runtime.id = ${JSON.stringify(runtimeId)}`,
  );

  /* --- 4. awaitPromise really awaits (the complaint that started this) --- */
  const awaited = await TOOLS.evaluate_script({
    target: WORKER_SELECTOR,
    expression: "Promise.resolve('awaited-value-came-back')",
  });
  record(
    "an awaited Promise returns its VALUE, not a bare undefined or an empty object",
    awaited === "awaited-value-came-back",
    `value=${JSON.stringify(awaited)}`,
  );
  const notAwaited = await TOOLS.evaluate_script({
    target: WORKER_SELECTOR,
    expression: "Promise.resolve('should-stay-a-promise')",
    awaitPromise: false,
  });
  // The control: without awaitPromise the same expression is an opaque object.
  // It is what proves the assertion above is testing the await and not the
  // string round trip.
  record(
    "awaitPromise:false is honoured on a worker too (control for the assertion above)",
    notAwaited !== "should-stay-a-promise",
    `value=${JSON.stringify(notAwaited)}`,
  );

  /* --- 5. args/function form and a thrown exception behave as on a page --- */
  const summed = await TOOLS.evaluate_script({
    target: WORKER_SELECTOR,
    expression: "(a, b) => a + b + (typeof chrome === 'object' ? 1 : 0)",
    args: [2, 3],
  });
  record("the function+args form works in a worker", summed === 6, `value=${JSON.stringify(summed)}`);
  const threw = await TOOLS.evaluate_script({
    target: WORKER_SELECTOR,
    expression: "(() => { throw new Error('worker-side boom'); })()",
  })
    .then(() => "resolved (WRONG)")
    .catch((e: unknown) => (e instanceof Error ? e.message : String(e)));
  record("a worker-side exception surfaces as an error", /worker-side boom/.test(threw), `error=${threw}`);

  /* --- 6. savePath keeps the value out of the response, for a worker too --- */
  const sinkPath = join(artifactDir, "worker-storage.json");
  const saved = (await TOOLS.evaluate_script({
    target: WORKER_SELECTOR,
    expression: "chrome.storage.local.get(null)",
    savePath: sinkPath,
  })) as { path?: string; bytes?: number; type?: string; target?: { id: string } };
  const savedJson = await readFile(sinkPath, "utf8");
  record(
    "savePath writes the worker's value to disk and returns NO form of it",
    saved?.path === sinkPath &&
      (saved.bytes ?? 0) > 0 &&
      saved.type === "object" &&
      !JSON.stringify(saved).includes("mv3-fixture-ok") &&
      savedJson.includes("mv3-fixture-ok"),
    `result=${JSON.stringify(saved)} file=${savedJson.replace(/\s+/g, " ")}`,
  );

  /* --- 7. GENUINE EVICTION, asserted before any wake --- */
  const startsBefore = await readStarts();
  record("read the fixture's restart counter before eviction", startsBefore > 0, `starts=${startsBefore}`);

  let evicted = false;
  const evictT0 = Date.now();
  // No connection is held during this wait, on purpose: an attached session
  // would keep the worker alive and this loop would spin out.
  for (let i = 0; i < 120 && !evicted; i++) {
    await pause(1_000);
    evicted = (await fixtureWorker()) === undefined;
  }
  const evictSecs = Math.round((Date.now() - evictT0) / 1000);
  record(
    "the MV3 worker is GENUINELY idle-evicted: it vanishes from the target listing",
    evicted,
    evicted ? `absent from /json/list after ~${evictSecs}s idle` : `STILL RUNNING after ${evictSecs}s — nothing below proves a wake`,
  );

  /* --- 8. wake:false teaches the eviction fact instead of waking --- */
  const refusal = await TOOLS.evaluate_script({
    target: WORKER_SELECTOR,
    expression: "1",
    wake: false,
  })
    .then(() => "resolved (WRONG: wake:false must not start anything)")
    .catch((e: unknown) => (e instanceof Error ? e.message : String(e)));
  record(
    "wake:false refuses an evicted worker AND teaches why it is missing",
    /idle-evicted/.test(refusal) && /wake:true/.test(refusal),
    `error=${refusal}`,
  );
  record(
    "and wake:false really started nothing (the worker is still absent)",
    (await fixtureWorker()) === undefined,
    "no service_worker target for the fixture after the refusal",
  );

  /* --- 9. THE WAKE: proven by a restart counter, never by the protocol --- */
  const startsAfter = await readStarts();
  record(
    "wake (default) starts the evicted worker and the evaluate lands in the RESTARTED instance",
    startsAfter === startsBefore + 1,
    `starts ${startsBefore} -> ${startsAfter} (a worker that never died would report ${startsBefore})`,
  );
  const wokenGlobal = await TOOLS.evaluate_script({
    target: WORKER_SELECTOR,
    expression: "globalThis.__cdpToolkitFixture ?? '(absent)'",
  });
  record(
    "the woken worker re-ran its top-level script (its in-memory global is back)",
    wokenGlobal === "sw-alive",
    `__cdpToolkitFixture = ${JSON.stringify(wokenGlobal)}`,
  );

  /* --- 10. a bare worker target id resolves too --- */
  const live = await fixtureWorker();
  const byId = live ? await TOOLS.evaluate_script({ target: live.id, expression: "self.constructor.name" }) : undefined;
  record("a bare worker target id resolves through the all-targets branch", byId === "ServiceWorkerGlobalScope", `id=${live?.id} value=${JSON.stringify(byId)}`);

  /* --- 11. THE LEASE FENCE, under real strict mode --- */
  const beforeLeases = await leaseFiles();
  process.env.CDP_REQUIRE_LEASE = "1";
  try {
    await TOOLS.evaluate_script({ target: WORKER_SELECTOR, expression: "1+1" });
    if (live) await TOOLS.evaluate_script({ target: live.id, expression: "1+1" });
    const afterWorker = await leaseFiles();
    record(
      "STRICT MODE: a worker evaluate mints ZERO lease files",
      afterWorker.length === beforeLeases.length,
      `lease files before=${beforeLeases.length} after=${afterWorker.length} [${afterWorker.join(", ")}]`,
    );

    // THE CONTROL. Without it, "zero leases" would also be what a smoke that
    // silently failed to enable strict mode reports — the exact way this
    // assertion could pass while proving nothing (markLongLivedProcess()).
    const pageTargets = (await listTargets()).filter((t) => t.type === "page");
    await TOOLS.evaluate_script({ target: pageTargets[0]!.id, expression: "1+1" });
    const afterPage = await leaseFiles();
    record(
      "and the SAME strict mode does mint one for a page (proves the gate was armed)",
      afterPage.length === afterWorker.length + 1,
      `after a page evaluate: ${afterPage.length} lease files [${afterPage.join(", ")}]`,
    );
  } finally {
    delete process.env.CDP_REQUIRE_LEASE;
  }

  /* --- 12. the page-only tools refuse the arm instead of mangling it --- */
  const pageOnly = await TOOLS.close_page({ target: WORKER_SELECTOR })
    .then(() => "resolved (WRONG)")
    .catch((e: unknown) => (e instanceof Error ? e.message : String(e)));
  record(
    "close_page refuses a worker: target and points at evaluate_script",
    /page-only/.test(pageOnly) && /evaluate_script/.test(pageOnly),
    `error=${pageOnly}`,
  );
} catch (fatal) {
  record("FATAL", false, fatal instanceof Error ? `${fatal.name}: ${fatal.message}` : String(fatal));
} finally {
  chrome?.kill("SIGKILL");
  await rm(artifactDir, { recursive: true, force: true }).catch(() => undefined);
  await rm(profileDir, { recursive: true, force: true }).catch(() => undefined);
}

const failed = checks.filter((c) => !c.ok);
console.log(`\n${checks.length - failed.length}/${checks.length} assertions passed`);
if (failed.length) {
  console.error(`FAILED (${failed.length}): ${failed.map((c) => c.name).join(" | ")}`);
  process.exit(1);
}
console.log("EXTENSION SMOKE OK");
process.exit(0);
