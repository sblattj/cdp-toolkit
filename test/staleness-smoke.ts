/**
 * Activity-beacon end-to-end harness: a real browser, real navigation, real
 * synthesized input, and two DIFFERENT ways of producing it.
 *
 * WHY THIS CANNOT BE A UNIT TEST. Three of the claims this feature rests on are
 * claims about Chrome, and none of them is checkable without Chrome:
 *
 *   1. CDP-dispatched input arrives in the page as a real input event, so an
 *      in-page listener alone can never tell an agent from a person. If that
 *      were false the whole dispatch-log correlation would be unnecessary
 *      complexity, so the test that would delete this design has to be here.
 *   2. Page.addScriptToEvaluateOnNewDocument is cleared when the client that
 *      registered it disconnects, which is why cdp/driver.ts HOLDS a connection
 *      per beaconed tab. A stub cannot fail that way, so a stub cannot prove the
 *      held connection earns its cost. Navigating and re-checking is what does.
 *   3. Input that did NOT go through this process's dispatch log reads as human.
 *      Producing it needs a second, raw CDP connection driving the same tab —
 *      the closest thing to a person's hand that a test can build.
 *
 * ============================ SAFETY RULES ============================
 *   - This harness LAUNCHES ITS OWN Chrome, headless, on port 9501 with a
 *     throwaway --user-data-dir, and kills it on the way out. It NEVER attaches
 *     to a browser it did not start.
 *   - PORT 9222 IS THE OWNER'S LIVE BROWSER AND IS REFUSED OUTRIGHT. The check
 *     below is not a guard rail to be relaxed for convenience; connecting a test
 *     that dispatches input and closes tabs to a person's real browser is the
 *     one unforgivable failure here.
 *   - If ANYTHING already answers on 9501 the harness stops instead of
 *     attaching: an unexpected listener is somebody else's browser by
 *     definition, and "probably just a leftover of mine" is exactly the
 *     assumption that ends with someone's tabs driven by a test.
 *   - Every tab is one this harness opened, and every selector is a bare target
 *     id it minted itself. Never `active`, never `index:N`, never url:/title:.
 *   - Lease and state files go to a private temp dir, removed on exit.
 * ======================================================================
 *
 * Run with `bun run staleness:smoke`. Prints one PASS/FAIL line per assertion
 * and exits non-zero naming every failure.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { createServer, type Server } from "node:http";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";

/* ------------------------------- safety preflight ------------------------------- */

// S2's checks (reap grace, renderer ping, observability) run against the SAME
// browser and port as S1's, in this same process. `client.ts` reads CDP_BASE
// into a MODULE-LEVEL const at import time, so one process can only ever
// speak to one Chrome — a genuinely separate port-9502 instance, as the spec
// names for S2, is not reachable from inside this shared harness without a
// second process. See test/staleness-smoke.ts's git history / the S2 FRICTION
// note for the full reasoning; STALENESS_SMOKE_PORT still overrides the one
// port this whole file uses, S1 and S2 sections alike.
const PORT = Number(process.env.STALENESS_SMOKE_PORT ?? 9501);
if (PORT === 9222) {
  console.error("FATAL: 9222 is the owner's live browser. This harness dispatches input and closes tabs; it never runs there.");
  process.exit(1);
}
const SMOKE_BASE = `http://127.0.0.1:${PORT}`;

// client.ts reads CDP_BASE into a module-level const, so it has to be set before
// the toolkit is imported. Hence the dynamic imports further down. Overriding
// any inherited CDP_BASE is deliberate: an inherited 9222 would be catastrophic.
process.env.CDP_BASE = SMOKE_BASE;

const artifactDir = await mkdtemp(join(tmpdir(), "cdp-staleness-smoke-"));
const profileDir = await mkdtemp(join(tmpdir(), "cdp-staleness-chrome-"));
process.env.CDP_ARTIFACT_DIR = artifactDir;
process.env.CDP_STATE_DIR = artifactDir;

const { TOOLS } = await import("../src/index.ts");
const { leaseFile, markLongLivedProcess, withLeaseScope } = await import("../src/leases.ts");
const { BEACON_DATA_GLOBAL, BEACON_INSTALLED_GLOBAL, CONTENTION_WINDOW_MS, DISPATCH_ATTRIBUTION_WINDOW_MS } =
  await import("../src/activity.ts");
const { DEFAULT_REAP_GRACE_MS } = await import("../src/reap.ts");

// requireLease() is gated on BOTH CDP_REQUIRE_LEASE and "this is the long-lived
// MCP process" (leases.ts); only mcp.ts calls markLongLivedProcess() in
// production, and this harness imports src/index.ts directly, bypassing it.
// Without this, every S2 strict-mode check below would silently no-op.
markLongLivedProcess();

const CHROME =
  process.env.CHROME_PATH ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

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

function pause(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/* ------------------------------ a raw CDP connection ------------------------------ */

/**
 * A deliberately SEPARATE CDP client, built here rather than reused from
 * src/client.ts.
 *
 * That is the entire point of it: it must not touch the toolkit's dispatch log,
 * because "input this server did not dispatch" is precisely what the beacon is
 * supposed to notice. Routing this through the toolkit's own connection would
 * log the dispatch and the test would prove the opposite of what it claims.
 * This is the closest a test can get to a person's hand on the mouse.
 */
class RawCdp {
  private ws!: WebSocket;
  private nextId = 0;
  private readonly pending = new Map<number, (msg: Record<string, unknown>) => void>();

  static async open(wsUrl: string): Promise<RawCdp> {
    const c = new RawCdp();
    c.ws = new WebSocket(wsUrl);
    await new Promise<void>((resolve, reject) => {
      c.ws.onopen = () => resolve();
      c.ws.onerror = () => reject(new Error(`raw CDP could not connect: ${wsUrl}`));
    });
    c.ws.onmessage = (ev: MessageEvent) => {
      const msg = JSON.parse(String(ev.data)) as { id?: number };
      if (typeof msg.id !== "number") return; // an event, not a command reply
      const waiter = c.pending.get(msg.id);
      if (!waiter) return;
      c.pending.delete(msg.id);
      waiter(msg as Record<string, unknown>);
    };
    return c;
  }

  send(method: string, params: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`raw CDP '${method}' timed out`)), 10_000);
      this.pending.set(id, (msg) => {
        clearTimeout(timer);
        resolve(msg);
      });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  /** One click, dispatched WITHOUT going through the toolkit: the stand-in for a
   *  person. Coordinates are inside the default headless viewport. */
  async click(x = 60, y = 60): Promise<void> {
    await this.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
    await this.send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1 });
    await this.send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1 });
  }

  close(): void {
    try {
      this.ws.close();
    } catch {
      /* already gone */
    }
  }
}

/* ------------------------------ browser + page server ------------------------------ */

interface CdpTarget {
  id: string;
  webSocketDebuggerUrl: string;
}

async function targets(): Promise<CdpTarget[]> {
  return (await (await fetch(`${SMOKE_BASE}/json/list`)).json()) as CdpTarget[];
}

async function wsUrlFor(targetId: string): Promise<string> {
  const hit = (await targets()).find((t) => t.id === targetId);
  if (!hit) throw new Error(`no target ${targetId}`);
  return hit.webSocketDebuggerUrl;
}

/** Refuse to run if anything is already listening: an unexpected browser on this
 *  port is someone else's by definition. */
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
      const res = await fetch(`${SMOKE_BASE}/json/version`, { signal: AbortSignal.timeout(1_000) });
      if (res.ok) return;
    } catch {
      /* not up yet */
    }
    await pause(100);
  }
  throw new Error(`chrome never answered on ${SMOKE_BASE}`);
}

/** A local page server, so navigation is real. A data: URL cannot be used here:
 *  Chrome blocks top-level data: navigation, which is exactly the navigation
 *  this file needs to perform. */
function startPageServer(): Promise<{ server: Server; origin: string }> {
  const server = createServer((req, res) => {
    const n = (req.url ?? "/1").replace(/[^0-9]/g, "") || "1";
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(
      `<!doctype html><meta charset="utf-8"><title>staleness-smoke ${n}</title>` +
        `<body style="margin:0"><div id="pad" style="width:600px;height:400px;background:#eee">page ${n}</div></body>`,
    );
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as AddressInfo).port;
      resolve({ server, origin: `http://127.0.0.1:${port}` });
    });
  });
}

/* ------------------------------- toolkit shorthands ------------------------------- */

interface ClaimResult {
  lease: string;
  targetId: string;
  opened: boolean;
  humanActiveMs?: number | null;
  contention?: string;
}
interface LeaseRow {
  targetId: string;
  humanActiveMs?: number;
  idleMs?: number;
  expiresAt?: number;
}
interface PageEntry {
  id: string;
  responsive?: boolean;
  humanActiveMs?: number;
  lease?: { label: string; pid: number; idleMs: number; expiresAt: number; stale: string | false };
}
interface ReapedTab {
  targetId: string;
  label: string;
  reason: "dead-pid" | "expired";
}
interface ListPagesResult {
  pages: PageEntry[];
  reaped?: ReapedTab[];
}

/** Hand-write a lease record straight to disk, bypassing claim_page, so the
 *  reap-grace checks below can control pid/lastUsedAt/ttlMs precisely instead
 *  of waiting on a real TTL. Mirrors test/reap-wiring.test.ts's approach,
 *  against the real filesystem path this harness's CDP_ARTIFACT_DIR points at. */
async function writeLeaseRecord(targetId: string, over: { pid?: number; ttlMs: number; lastUsedAt: number }): Promise<void> {
  const rec = {
    backend: "chrome" as const,
    targetId,
    nonce: "b".repeat(24),
    pid: over.pid ?? process.pid,
    label: "staleness-smoke-s2",
    createdAt: Date.now(),
    lastUsedAt: over.lastUsedAt,
    ttlMs: over.ttlMs,
    auto: true,
  };
  await writeFile(leaseFile("chrome", targetId), JSON.stringify(rec), "utf8");
}

/** The beacon's own two globals, read straight out of the page. This is the
 *  control for every attribution assertion: it says what the page recorded,
 *  independently of what the toolkit decided that recording MEANS. */
async function readBeaconState(lease: string, targetId: string): Promise<{ installed: boolean; ts: number | null }> {
  return (await withLeaseScope(lease, () =>
    TOOLS.evaluate_script({
      target: targetId,
      expression: `({ installed: window.${BEACON_INSTALLED_GLOBAL} === true, ts: typeof window.${BEACON_DATA_GLOBAL} === "number" ? window.${BEACON_DATA_GLOBAL} : null })`,
    }),
  )) as { installed: boolean; ts: number | null };
}

async function leaseRow(targetId: string): Promise<LeaseRow | undefined> {
  const { leases } = (await TOOLS.list_leases({})) as { leases: LeaseRow[] };
  return leases.find((l) => l.targetId === targetId);
}

/* ------------------------------------ the run ------------------------------------ */

let chrome: ChildProcess | undefined;
let pageServer: Server | undefined;
const openedTabs: string[] = [];

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
      "--disable-extensions",
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

  const started = await startPageServer();
  pageServer = started.server;
  const ORIGIN = started.origin;

  /* --- 1. claim opens a tab, installs the beacon, and reports no human --- */
  const claim = (await TOOLS.claim_page({ url: `${ORIGIN}/1`, label: "staleness-smoke" })) as ClaimResult;
  const tab = claim.targetId;
  openedTabs.push(tab);
  record("claim_page opened and claimed a throwaway tab", claim.opened === true, `target=${tab}`);
  record(
    "a freshly opened tab reports no human activity and no contention",
    claim.humanActiveMs === null && claim.contention === undefined,
    `humanActiveMs=${JSON.stringify(claim.humanActiveMs)}, contention=${claim.contention === undefined ? "absent" : "PRESENT"}`,
  );

  const afterClaim = await readBeaconState(claim.lease, tab);
  record("the beacon is installed in the claimed tab", afterClaim.installed === true, `window.${BEACON_INSTALLED_GLOBAL}=${afterClaim.installed}`);
  record("no input has been recorded yet", afterClaim.ts === null, `window.${BEACON_DATA_GLOBAL}=${JSON.stringify(afterClaim.ts)}`);

  /* --- 2. the beacon survives navigation --- */
  // The claim above is what a held connection buys. Chrome clears an init-script
  // registration when the registering client disconnects, and this toolkit
  // closes a connection after every call, so a beacon that is still here after a
  // navigation is proof the keep-alive session is doing its job.
  await withLeaseScope(claim.lease, () => TOOLS.navigate_page({ target: tab, url: `${ORIGIN}/2` }));
  const afterNav = await readBeaconState(claim.lease, tab);
  record(
    "the beacon survives navigation to a new document",
    afterNav.installed === true && afterNav.ts === null,
    `installed=${afterNav.installed} in a document this run never injected into directly; timestamp reset with the document as it should`,
  );

  // Installed is not the same as WORKING. Prove the listeners in the new
  // document actually fire, or "survives navigation" is a flag, not a beacon.
  const raw = await RawCdp.open(await wsUrlFor(tab));
  await raw.click();
  await pause(150);
  const afterRawOnNewDoc = await readBeaconState(claim.lease, tab);
  record(
    "the surviving beacon actually records input in the new document",
    typeof afterRawOnNewDoc.ts === "number",
    `window.${BEACON_DATA_GLOBAL}=${JSON.stringify(afterRawOnNewDoc.ts)} after a raw click on the post-navigation document`,
  );

  /* --- 3. input the toolkit dispatched does NOT read as human --- */
  await withLeaseScope(claim.lease, () => TOOLS.click({ target: tab, selector: "#pad" }));
  await pause(150);
  const afterToolkitClick = await readBeaconState(claim.lease, tab);
  const rowAfterToolkit = await leaseRow(tab);
  record(
    // THE CONTROL, and the reason this assertion can fail. A missing
    // humanActiveMs is equally consistent with "correctly attributed to us" and
    // "the beacon is dead". Reading the raw timestamp proves the page DID record
    // our click, so the absence below is attribution and nothing else.
    "the toolkit's own click moved the in-page beacon (CDP input is indistinguishable in-page)",
    typeof afterToolkitClick.ts === "number" && afterToolkitClick.ts > (afterRawOnNewDoc.ts ?? 0),
    `beacon ${JSON.stringify(afterRawOnNewDoc.ts)} -> ${JSON.stringify(afterToolkitClick.ts)}`,
  );
  record(
    "and it is NOT reported as human activity",
    rowAfterToolkit !== undefined && rowAfterToolkit.humanActiveMs === undefined,
    `list_leases row for the tab: humanActiveMs=${rowAfterToolkit === undefined ? "NO ROW" : JSON.stringify(rowAfterToolkit.humanActiveMs)}`,
  );

  /* --- 4. input from a second, raw CDP connection DOES read as human --- */
  // Past the attribution window on purpose: inside it, a real person's input is
  // deliberately credited to our own click, which is the documented trade.
  await pause(DISPATCH_ATTRIBUTION_WINDOW_MS + 400);
  await raw.click(80, 80);
  await pause(150);
  const rowAfterRaw = await leaseRow(tab);
  record(
    "input dispatched outside the toolkit IS reported as human",
    rowAfterRaw !== undefined && typeof rowAfterRaw.humanActiveMs === "number",
    `list_leases row: humanActiveMs=${JSON.stringify(rowAfterRaw?.humanActiveMs)}`,
  );
  record(
    "and it is reported as RECENT, not as some stale timestamp",
    typeof rowAfterRaw?.humanActiveMs === "number" && rowAfterRaw.humanActiveMs < 5_000,
    `${rowAfterRaw?.humanActiveMs}ms ago`,
  );

  /* --- 5. a takeover of a human-active tab reports humanActiveMs + contention --- */
  // Hand the tab back first, leaving it open, unleased and beaconed: a stand-in
  // for the tab a person has open. The beacon stays installed on release, which
  // is deliberate — a released tab is exactly the one a human picks back up.
  const released = (await TOOLS.release_page({ lease: claim.lease, close: false })) as { released: boolean; closed: boolean };
  record("the tab is handed back and left open", released.released === true && released.closed === false, JSON.stringify(released));

  await raw.click(100, 100);
  await pause(150);
  const takeover = (await TOOLS.claim_page({ target: tab, label: "staleness-smoke-takeover" })) as ClaimResult;
  record(
    "claim_page on a human-active tab reports humanActiveMs",
    typeof takeover.humanActiveMs === "number" && takeover.humanActiveMs < CONTENTION_WINDOW_MS,
    `humanActiveMs=${JSON.stringify(takeover.humanActiveMs)} (< ${CONTENTION_WINDOW_MS}ms window)`,
  );
  record(
    "and warns about contention",
    typeof takeover.contention === "string" && takeover.contention.includes("SUCCEEDED"),
    takeover.contention ?? "NO WARNING",
  );
  record(
    "the claim is NOT refused: the takeover holds a working lease",
    takeover.targetId === tab && takeover.opened === false && typeof takeover.lease === "string",
    `targetId matches=${takeover.targetId === tab}, opened=${takeover.opened}`,
  );
  const drivable = await withLeaseScope(takeover.lease, () =>
    TOOLS.evaluate_script({ target: tab, expression: "'takeover-can-drive'" }),
  );
  record("the contended tab is genuinely drivable with the returned token", drivable === "takeover-can-drive", `=> ${JSON.stringify(drivable)}`);

  /* --- 6. the toolkit's own click on the SAME tab still reads as ours --- */
  // The state machine has to work in both directions, not just once: after a
  // human input has been attributed, our next click must take attribution back.
  await withLeaseScope(takeover.lease, () => TOOLS.click({ target: tab, selector: "#pad" }));
  await pause(150);
  const rowAfterReclaim = await leaseRow(tab);
  record(
    "a toolkit click after a human input takes attribution back",
    rowAfterReclaim !== undefined && rowAfterReclaim.humanActiveMs === undefined,
    `humanActiveMs=${rowAfterReclaim === undefined ? "NO ROW" : JSON.stringify(rowAfterReclaim.humanActiveMs)}`,
  );

  /* --- 6b. THE CROSS-TRACK PROOF: a 1.8.0 input tool is in the dispatch log too --- */
  // The regression this exists to catch is invisible to both feature branches. Track P's `scroll`
  // was written against main, before this branch's dispatch log existed, and sent its wheel event
  // straight down the connection. Merged naively, the result compiles, typechecks, passes both unit
  // suites and every other assertion in this file — and then reports the TOOLKIT'S OWN scroll as a
  // person using the tab, i.e. warns an agent about contention with itself. Only a live browser can
  // show it: the wheel event has to actually reach the page's beacon for the misattribution to
  // happen at all.
  //
  // Shaped as "take attribution BACK from a real human input" rather than "scroll a fresh tab",
  // because a fresh tab reports humanActiveMs undefined anyway and the assertion could not fail.
  await pause(DISPATCH_ATTRIBUTION_WINDOW_MS + 400);
  await raw.click(120, 120);
  await pause(150);
  const rowBeforeScroll = await leaseRow(tab);
  const beaconBeforeScroll = await readBeaconState(takeover.lease, tab);
  record(
    "a human input is attributed before the toolkit scrolls (the precondition this proof needs)",
    rowBeforeScroll !== undefined && typeof rowBeforeScroll.humanActiveMs === "number",
    `humanActiveMs=${JSON.stringify(rowBeforeScroll?.humanActiveMs)} before the scroll`,
  );

  await withLeaseScope(takeover.lease, () => TOOLS.scroll({ target: tab, deltaY: 240 }));
  await pause(150);
  const beaconAfterScroll = await readBeaconState(takeover.lease, tab);
  const rowAfterScroll = await leaseRow(tab);
  record(
    // THE CONTROL, exactly as in section 3: the beacon has to have SEEN the scroll, or the
    // attribution assertion below would pass on a page where nothing happened at all.
    "the toolkit's own scroll moved the in-page beacon (a wheel event is one of the beacon's five)",
    typeof beaconAfterScroll.ts === "number" && beaconAfterScroll.ts > (beaconBeforeScroll.ts ?? 0),
    `beacon ${JSON.stringify(beaconBeforeScroll.ts)} -> ${JSON.stringify(beaconAfterScroll.ts)}`,
  );
  record(
    "and the scroll is NOT attributed to a human: Track P's tool writes to Track S's dispatch log",
    rowAfterScroll !== undefined && rowAfterScroll.humanActiveMs === undefined,
    `list_leases row after a toolkit scroll: humanActiveMs=${rowAfterScroll === undefined ? "NO ROW" : JSON.stringify(rowAfterScroll.humanActiveMs)}`,
  );

  raw.close();
  await TOOLS.release_page({ lease: takeover.lease, close: false }).catch(() => undefined);

  /* ==================== S2: reap grace, renderer ping, observability ==================== */

  /* --- S2.1 split reap horizon --- */
  // requireLease() gates every reap below; it is off for the S1 checks above
  // (which never wanted reaping) and turned on for exactly this section.
  process.env.CDP_REQUIRE_LEASE = "1";

  const graceWithin = await TOOLS.new_page({ url: `${ORIGIN}/3` }) as { targetId: string };
  openedTabs.push(graceWithin.targetId);
  // 500ms past a 1s ttlMs: reclaimable, nowhere near the 45-minute default grace.
  await writeLeaseRecord(graceWithin.targetId, { ttlMs: 1_000, lastUsedAt: Date.now() - 1_500 });
  const listWithinGrace = (await TOOLS.list_pages({})) as ListPagesResult;
  record(
    "an expired-but-within-grace lease survives a strict-mode list_pages",
    listWithinGrace.pages.some((p) => p.id === graceWithin.targetId) &&
      !(listWithinGrace.reaped ?? []).some((r) => r.targetId === graceWithin.targetId),
    `default grace=${DEFAULT_REAP_GRACE_MS}ms; pages contains tab=${listWithinGrace.pages.some((p) => p.id === graceWithin.targetId)}, reaped=${JSON.stringify(listWithinGrace.reaped)}`,
  );

  process.env.CDP_REAP_GRACE_MS = "0";
  const graceBeyond = await TOOLS.new_page({ url: `${ORIGIN}/4` }) as { targetId: string };
  openedTabs.push(graceBeyond.targetId);
  await writeLeaseRecord(graceBeyond.targetId, { ttlMs: 1_000, lastUsedAt: Date.now() - 1_500 });
  const listBeyondGrace = (await TOOLS.list_pages({})) as ListPagesResult;
  const beyondReap = (listBeyondGrace.reaped ?? []).find((r) => r.targetId === graceBeyond.targetId);
  record(
    "the same lease shape IS reaped once CDP_REAP_GRACE_MS is 0",
    beyondReap?.reason === "expired" && !listBeyondGrace.pages.some((p) => p.id === graceBeyond.targetId),
    `reaped=${JSON.stringify(beyondReap)}`,
  );
  delete process.env.CDP_REAP_GRACE_MS;

  const deadPidTab = await TOOLS.new_page({ url: `${ORIGIN}/5` }) as { targetId: string };
  openedTabs.push(deadPidTab.targetId);
  // lastUsedAt is "now" (nowhere near expired) but the pid is dead: must reap
  // immediately, proving dead-pid genuinely ignores grace rather than merely
  // defaulting to a short one.
  await writeLeaseRecord(deadPidTab.targetId, { pid: 999_999, ttlMs: 900_000, lastUsedAt: Date.now() });
  const listDeadPid = (await TOOLS.list_pages({})) as ListPagesResult;
  const deadPidReap = (listDeadPid.reaped ?? []).find((r) => r.targetId === deadPidTab.targetId);
  record(
    "a dead-pid lease is reaped immediately regardless of grace",
    deadPidReap?.reason === "dead-pid" && !listDeadPid.pages.some((p) => p.id === deadPidTab.targetId),
    `reaped=${JSON.stringify(deadPidReap)}`,
  );

  delete process.env.CDP_REQUIRE_LEASE;

  /* --- S2.2 renderer ping (list_pages{probe:true}) --- */
  const probeClaim = (await TOOLS.claim_page({ url: `${ORIGIN}/6`, label: "s2-probe" })) as ClaimResult;
  openedTabs.push(probeClaim.targetId);
  const listProbe = (await TOOLS.list_pages({ probe: true })) as ListPagesResult;
  const probeEntry = listProbe.pages.find((p) => p.id === probeClaim.targetId);
  record(
    "probe:true marks a live tab responsive:true",
    probeEntry?.responsive === true,
    `entry=${JSON.stringify(probeEntry)}`,
  );
  record(
    "and list_pages also reports that tab's lease {idleMs, expiresAt}",
    typeof probeEntry?.lease?.idleMs === "number" && typeof probeEntry?.lease?.expiresAt === "number" && probeEntry?.lease?.label === "s2-probe",
    `lease=${JSON.stringify(probeEntry?.lease)}`,
  );

  // A tab this harness never claimed/probed before must show NO lease field.
  const bareTab = await TOOLS.new_page({ url: `${ORIGIN}/7` }) as { targetId: string };
  openedTabs.push(bareTab.targetId);
  const listBare = (await TOOLS.list_pages({})) as ListPagesResult;
  const bareEntry = listBare.pages.find((p) => p.id === bareTab.targetId);
  record(
    "an unleased tab's list_pages entry has no lease field",
    bareEntry !== undefined && !("lease" in bareEntry),
    `entry=${JSON.stringify(bareEntry)}`,
  );

  /* --- S2.3 a wedged renderer reports responsive:false without stalling the call --- */
  const wedgeTab = await TOOLS.new_page({ url: `${ORIGIN}/8` }) as { targetId: string };
  openedTabs.push(wedgeTab.targetId);
  const wedgeRaw = await RawCdp.open(await wsUrlFor(wedgeTab.targetId));
  // Fire-and-forget: this command's response never comes back (the renderer's
  // JS thread never yields), and it must NOT be awaited or this harness would
  // hang for its own 10s timeout instead of proving the toolkit's 500ms one.
  wedgeRaw.send("Runtime.evaluate", { expression: "while(true){}" }).catch(() => undefined);
  await pause(150); // let the loop actually start before probing it
  const probeStart = Date.now();
  const listWedged = (await TOOLS.list_pages({ probe: true })) as ListPagesResult;
  const probeElapsedMs = Date.now() - probeStart;
  const wedgedEntry = listWedged.pages.find((p) => p.id === wedgeTab.targetId);
  record(
    "a wedged renderer reports responsive:false, not an error for the whole call",
    wedgedEntry?.responsive === false,
    `entry=${JSON.stringify(wedgedEntry)}`,
  );
  record(
    "and the wedged tab does not stall the listing beyond its own probe budget",
    // Generous multiple of the 500ms per-tab budget: proves there is no
    // multi-second hang, without pinning to an exact number a slow CI box
    // could flake on.
    probeElapsedMs < 5_000,
    `list_pages{probe:true} took ${probeElapsedMs}ms with one wedged tab present`,
  );
  wedgeRaw.close();
} catch (fatal) {
  record("FATAL", false, fatal instanceof Error ? `${fatal.name}: ${fatal.message}` : String(fatal));
} finally {
  // Each tab by its own id; the browser is this run's own and is killed outright.
  for (const id of openedTabs) await TOOLS.close_page({ target: id }).catch(() => undefined);
  pageServer?.close();
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
console.log("STALENESS SMOKE OK");
process.exit(0);
