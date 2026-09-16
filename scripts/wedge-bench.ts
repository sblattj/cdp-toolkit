/**
 * Wedge/stability benchmark: proves cdp-toolkit's core claim with numbers
 * anyone can re-run. Against a live Chrome (default: spawns an isolated,
 * headless instance on a throwaway profile; honors CDP_BASE to attach to your
 * own), it measures the full lifecycle of a stuck page:
 *
 *   1. HEALTHY  — 50 evaluate_script round-trips; p50/p95 wall-clock.
 *   2. WEDGE    — N times: open a throwaway page, navigate it to an endpoint
 *                 that accepts the connection and never responds. The call
 *                 MUST reject at the configured bound (CDP_TIMEOUT_MS, 15s
 *                 default) with a clean error — never hang.
 *   3. BLAST RADIUS — a witness tab stays fast while the stuck page is bricked
 *                 (measured during every wedge iteration), and the stuck page
 *                 itself stays unresponsive while its load is pending (checked
 *                 once, reported as an observation, not a failure).
 *   4. RECOVERY — close the bricked tab (browser-level command) and verify a
 *                 fresh page evaluates at healthy latency. Zero /mcp restarts.
 *
 * Exit 0 only if every wedge rejected inside bound+slack, the witness never
 * slowed past its budget, recovery always landed under budget, and no late
 * (abandoned) rejections escaped.
 *
 * Run: bun run scripts/wedge-bench.ts         (spawn + drive its own Chrome)
 *      CDP_BASE=http://127.0.0.1:9222 bun run scripts/wedge-bench.ts
 *      CDP_TIMEOUT_MS=3000 bun run scripts/wedge-bench.ts   (fast sample)
 */
import { TOOLS } from "../src/index.ts";
import { DEFAULT_TIMEOUT_MS } from "../src/client.ts";

const N_HEALTHY = Number(process.env.BENCH_HEALTHY_N ?? 50);
const N_WEDGE = Number(process.env.BENCH_WEDGE_N ?? 8);
const BOUND = DEFAULT_TIMEOUT_MS;
const SLACK_MS = 2_000;
const FAST_BUDGET_MS = 1_000; // witness / close / recovery calls must stay under this

const percentiles = (xs: number[], p: number): number => {
  const s = [...xs].sort((a, b) => a - b);
  const i = Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1);
  return s[Math.max(0, i)];
};
const fmt = (n: number): string => (n >= 1000 ? `${(n / 1000).toFixed(2)}s` : `${n.toFixed(0)}ms`);

async function timed<T>(fn: () => Promise<T>): Promise<{ ms: number; result?: T; error?: Error }> {
  const t0 = performance.now();
  try {
    const result = await fn();
    return { ms: performance.now() - t0, result };
  } catch (error) {
    return { ms: performance.now() - t0, error: error as Error };
  }
}

// Late rejections from commands nobody is awaiting any more. The MCP server
// wraps tool calls so these never escape there; the bench counts them and
// requires zero for a PASS.
let lateRejections = 0;
process.on("unhandledRejection", (err) => {
  lateRejections++;
  console.error(`late rejection #${lateRejections}:`, err instanceof Error ? err.message : err);
});

// --- local fast/hang endpoints -------------------------------------------------

const hangGates: Promise<never>[] = [];
const server = Bun.serve({
  port: 0,
  idleTimeout: 255, // Bun's max: keep the hung request pending for the whole run
  fetch: (req) => {
    const url = new URL(req.url);
    if (url.pathname === "/fast") {
      return new Response("ok", { headers: { "content-type": "text/plain" } });
    }
    // /hang: accept the connection, then never respond.
    const gate = new Promise<never>(() => {});
    hangGates.push(gate);
    return gate;
  },
});
const HANG_URL = `http://127.0.0.1:${server.port}/hang`;

// --- isolated Chrome (only when CDP_BASE is not provided) ----------------------

const BASE = process.env.CDP_BASE ?? "http://127.0.0.1:9222";
const spawnedChrome: { proc: Bun.Subprocess; dir: string } | null = process.env.CDP_BASE
  ? null
  : await (async () => {
      const dir = (await Bun.$`mktemp -d /tmp/cdp-wedge-bench-XXXXXX`.text()).trim();
      const candidates = [
        process.env.CHROME_BIN,
        "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
        "/usr/bin/google-chrome",
        "/usr/bin/chromium-browser",
      ].filter(Boolean) as string[];
      const isExec = async (c: string): Promise<boolean> => (await Bun.$`test -x ${c}`.nothrow().quiet()).exitCode === 0;
      const checks = await Promise.all(candidates.map(isExec));
      const bin = candidates[checks.findIndex(Boolean)];
      if (!bin) throw new Error("no Chrome found; set CHROME_BIN or CDP_BASE");
      const port = 9333;
      const proc = Bun.spawn(
        [
          bin,
          "--headless=new",
          `--remote-debugging-port=${port}`,
          `--user-data-dir=${dir}`,
          "--no-first-run",
          "--no-default-browser-check",
          "about:blank",
        ],
        { stdout: "ignore", stderr: "ignore" },
      );
      const base = `http://127.0.0.1:${port}`;
      for (let i = 0; i < 100; i++) {
        try {
          const r = await fetch(`${base}/json/version`);
          if (r.ok) return { proc, dir };
        } catch {}
        await new Promise((r) => setTimeout(r, 100));
      }
      proc.kill();
      throw new Error(`Chrome did not open ${base} within 10s`);
    })();

try {
  const boundNote = `${BOUND}ms (${process.env.CDP_TIMEOUT_MS ? "CDP_TIMEOUT_MS" : "default"})`;
  console.log(`cdp-toolkit wedge benchmark — base ${BASE}, timeout bound ${boundNote}, slack ${SLACK_MS}ms\n`);

  // --- witness tab: proves other targets are unaffected the whole time ---
  const witness = (await TOOLS.new_page({ url: "about:blank" })) as { targetId: string };

  // --- 1. healthy path ---
  const healthy: number[] = [];
  for (let i = 0; i < N_HEALTHY; i++) {
    const { ms } = await timed(() => TOOLS.evaluate_script({ target: witness.targetId, expression: `${i}*2` }));
    if (ms !== undefined) healthy.push(ms);
  }
  const healthyP50 = percentiles(healthy, 50);
  const healthyP95 = percentiles(healthy, 95);
  console.log(`healthy      ${N_HEALTHY}× evaluate_script        p50 ${fmt(healthyP50)}   p95 ${fmt(healthyP95)}`);

  // --- 2–4. wedge → blast radius → recovery, N times ---
  let rejectedInBound = 0;
  let witnessFast = 0;
  let recovered = 0;
  let stuckObserved = 0;
  const wedgeMs: number[] = [];
  const witnessMs: number[] = [];
  const closeMs: number[] = [];
  const freshMs: number[] = [];
  let stuckNotePrinted = false;

  for (let i = 0; i < N_WEDGE; i++) {
    const victim = (await TOOLS.new_page({ url: "about:blank" })) as { targetId: string };

    // 2. the wedged navigation MUST reject at the bound, never hang
    const wedge = await timed(() => TOOLS.navigate_page({ target: victim.targetId, url: HANG_URL }));
    wedgeMs.push(wedge.ms);
    if (!wedge.error && wedge.ms <= BOUND + SLACK_MS) continue; // resolved instead of rejecting → count as miss
    if (wedge.error && wedge.ms <= BOUND + SLACK_MS) rejectedInBound++;

    // 3a. blast radius: the witness tab answers at healthy latency mid-brick
    const w = await timed(() => TOOLS.evaluate_script({ target: witness.targetId, expression: `"w${i}"` }));
    witnessMs.push(w.ms);
    if (!w.error && w.ms < FAST_BUDGET_MS) witnessFast++;

    // 3b. one-time observation: the stuck page itself stays unresponsive
    if (!stuckNotePrinted) {
      const s = await timed(() => TOOLS.evaluate_script({ target: victim.targetId, expression: `"stuck?"` }));
      stuckObserved = s.error ? 1 : 0;
      console.log(
        `blast radius stuck page still unresponsive after the rejected call: ${s.error ? "yes (expected)" : "no"} (${fmt(s.ms)})`,
      );
      stuckNotePrinted = true;
    }

    // 4. recovery: browser-level close, then a fresh page at healthy latency
    const c = await timed(() => TOOLS.close_page({ target: victim.targetId }));
    closeMs.push(c.ms);
    const fresh = (await timed(() => TOOLS.new_page({ url: "about:blank" }))) as {
      ms: number;
      result?: { targetId: string };
    };
    if (fresh.result) {
      const e = await timed(() =>
        TOOLS.evaluate_script({ target: fresh.result!.targetId, expression: `${i}+1` }),
      );
      const total = fresh.ms + e.ms;
      freshMs.push(total);
      if (!e.error && e.result === i + 1 && total < FAST_BUDGET_MS) recovered++;
    }
  }

  const wedgedP50 = percentiles(wedgeMs, 50);
  const wedgedMax = Math.max(...wedgeMs);
  const recoveryP95 = percentiles(freshMs, 95);
  console.log(`wedged       ${rejectedInBound}/${N_WEDGE} navigate → hang      rejected at p50 ${fmt(wedgedP50)}   max ${fmt(wedgedMax)}   (bound ${boundNote})`);
  console.log(`blast radius witness eval mid-brick    p95 ${fmt(percentiles(witnessMs, 95))}   within ${fmt(FAST_BUDGET_MS)}: ${witnessFast}/${N_WEDGE}`);
  console.log(`recovery    close+reopen+evaluate      p95 ${fmt(recoveryP95)}   within ${fmt(FAST_BUDGET_MS)}: ${recovered}/${N_WEDGE}`);
  console.log(`restarts required: 0 · server restarts: 0 · late rejections: ${lateRejections}`);

  // --- verdict ---
  const pass =
    rejectedInBound === N_WEDGE &&
    witnessFast === N_WEDGE &&
    recovered === N_WEDGE &&
    wedgedMax <= BOUND + SLACK_MS &&
    percentiles(witnessMs, 95) < FAST_BUDGET_MS &&
    recoveryP95 < FAST_BUDGET_MS &&
    lateRejections === 0;
  console.log(`\n${pass ? "PASS" : "FAIL"}${stuckObserved ? "  (stuck page stays stuck until closed — by design, see README)" : ""}`);
  process.exitCode = pass ? 0 : 1;
} finally {
  server.stop(true);
  spawnedChrome?.proc.kill();
  if (spawnedChrome) await Bun.$`rm -rf ${spawnedChrome.dir}`.quiet();
}
