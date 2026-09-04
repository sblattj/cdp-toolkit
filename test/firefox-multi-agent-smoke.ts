/**
 * Firefox MULTI-AGENT smoke — can several agents drive several Firefox tabs of ONE browser
 * AT THE SAME TIME, through the real stdio MCP entry point (`bun src/mcp.ts`)?
 *
 * Two shapes of "several agents", both measured, because they hit different layers:
 *
 *   S1  ONE MCP server process, N concurrent clients-of-it (the Claude Code subagent shape:
 *       every subagent of a session shares the session's one MCP server). Exercises the
 *       in-process path: one BiDi session, N tabs, N tool calls in flight at once.
 *
 *   S2  N MCP server PROCESSES, each attached to the SAME user-launched Firefox endpoint
 *       (the multi-session / multi-harness shape: two Claude sessions, or Claude + Codex,
 *       each spawning its own cdp-toolkit server). Exercises the cross-process path, where
 *       Firefox's one-BiDi-session-per-browser limit lives.
 *
 * Each agent does real work on ITS OWN claimed tab: new_page{claim} → navigate_page →
 * evaluate_script writes an agent-private marker → R rounds of evaluate_script that bump a
 * per-tab counter and read the marker/title/href back → close_page. Every read is checked
 * against the agent's own identity, so a call that landed in another agent's tab FAILS
 * (isolation), and every tool call is timestamped so genuine overlap can be PROVEN rather
 * than assumed (concurrency): the check is the maximum number of tool calls in flight at
 * any instant across agents, which must exceed 1, plus the wall-clock ratio against the
 * serial sum.
 *
 * S2 has a one-process CONTROL (S2a, N=1) so a failure of S2b (N=4) is attributable to the
 * product's cross-process path and not to the harness's process-spawning.
 *
 *   S3  Failover. The cross-process shape works because a detached mux DAEMON owns Firefox's one
 *       BiDi session and every server process joins it. S3a SIGKILLs a server process while all
 *       agents are parked at a barrier: the others must not notice. S3b SIGKILLs the daemon:
 *       Firefox renumbers every tab when its session is re-created, so each survivor must get a
 *       stale-target error carrying a recovery hint, re-find its tab by url, re-claim it and finish
 *       on it — proven by the marker and round set living inside that tab. Finally the daemon must
 *       exit by itself once Firefox is gone.
 *
 * SAFETY. WE launch ONE throwaway-profile headless Firefox on OS-assigned ephemeral ports
 * (BiDi debug port + Marionette port via the `marionette.port` pref) and SIGKILL it by pid in
 * `finally`; nothing here touches a developer's own browser. Private CDP_ARTIFACT_DIR. A hard
 * wall-clock cap exits non-zero if anything hangs. Missing Firefox binary → SKIP, exit 0.
 *
 * Run with `bun run firefox:multi:smoke`. Env knobs: AGENTS (default 4), ROUNDS (default 6).
 */
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createConnection, createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// No bun-types devDep (CONTRACT.md); this is the runtime-provided global under tsc's "node" + "DOM" libs,
// declared locally exactly as test/firefox-smoke.ts does.
declare const Bun: {
  serve(opts: {
    port: number;
    hostname: string;
    fetch(req: Request): Response | Promise<Response>;
  }): { port: number; stop(closeActiveConnections?: boolean): void };
};

const SERVER = fileURLToPath(new URL("../src/mcp.ts", import.meta.url));
const AGENTS = Math.max(2, Number(process.env.AGENTS ?? 4));
const ROUNDS = Math.max(1, Number(process.env.ROUNDS ?? 6));
const HARD_CAP_MS = 300_000;

/* ------------------------------------ bookkeeping ------------------------------------ */
interface Check { name: string; ok: boolean; detail: string }
const checks: Check[] = [];
function record(name: string, ok: boolean, detail: string): void {
  checks.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}\n      ${detail}`);
}

/* ------------------------------------ infra helpers ------------------------------------ */
function firefoxBinary(): string | undefined {
  const cands = [process.env.FIREFOX_BIN, "/Applications/Firefox.app/Contents/MacOS/firefox"];
  for (const c of cands) if (c && existsSync(c)) return c;
  const paths = (process.env.PATH ?? "").split(":");
  const onPath = paths.find((p) => p && existsSync(join(p, "firefox")));
  return onPath ? join(onPath, "firefox") : undefined;
}

function pickFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const addr = probe.address();
      if (addr === null || typeof addr === "string") { probe.close(); reject(new Error("no port")); return; }
      const { port } = addr;
      probe.close(() => resolve(port));
    });
  });
}

function pollPort(port: number, deadlineMs: number, label: string): Promise<void> {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const attempt = (): void => {
      const sock = createConnection({ port, host: "127.0.0.1" });
      sock.once("connect", () => { sock.destroy(); resolve(); });
      sock.once("error", () => {
        sock.destroy();
        if (Date.now() - start >= deadlineMs) { reject(new Error(`${label} port ${port} never opened in ${deadlineMs}ms`)); return; }
        setTimeout(attempt, 100);
      });
    };
    attempt();
  });
}

/** Tiny fixture site: /agent/<id> renders a page whose title and body carry the id. Served over
 *  http (not file://) so every agent tab has a distinct, ordinary origin. */
function startFixtureServer(): { port: number; stop(): void } {
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(req) {
      const url = new URL(req.url);
      const m = /^\/agent\/([A-Za-z0-9_-]+)$/.exec(url.pathname);
      if (!m) return new Response("not found", { status: 404 });
      const id = m[1]!;
      const html = `<!doctype html><html><head><meta charset="utf-8"><title>agent-${id}</title></head>` +
        `<body><h1 id="who">agent-${id}</h1><p>fixture for multi-agent smoke</p></body></html>`;
      return new Response(html, { headers: { "content-type": "text/html; charset=utf-8" } });
    },
  });
  return { port: server.port!, stop: () => server.stop(true) };
}

/* ------------------------------------ the shared Firefox ------------------------------------ */
interface SharedFirefox { proc: ChildProcess; pid: number; rdpPort: number; marionettePort: number; profile: string }

async function launchSharedFirefox(binary: string): Promise<SharedFirefox> {
  const rdpPort = await pickFreePort();
  let marionettePort = await pickFreePort();
  while (marionettePort === rdpPort) marionettePort = await pickFreePort();
  const profile = mkdtempSync(join(tmpdir(), "cdp-toolkit-multi-agent-ff-"));
  writeFileSync(
    join(profile, "user.js"),
    `user_pref("marionette.port", ${marionettePort});\nuser_pref("remote.prefs.recommended", true);\n`,
  );
  const proc = spawn(
    binary,
    ["--profile", profile, "--remote-debugging-port", String(rdpPort), "--marionette", "--no-remote", "--headless"],
    { stdio: "ignore" },
  );
  if (proc.pid === undefined) throw new Error("Firefox failed to spawn");
  await pollPort(rdpPort, 30_000, "Firefox BiDi");
  await pollPort(marionettePort, 30_000, "Marionette");
  return { proc, pid: proc.pid, rdpPort, marionettePort, profile };
}

/* ------------------------------------ MCP server processes ------------------------------------ */
interface Server { client: Client; label: string; pid: number; kill(): void; close(): Promise<void> }

async function startServer(label: string, env: Record<string, string>): Promise<Server> {
  const childEnv: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined) childEnv[k] = v;
  Object.assign(childEnv, env);
  const transport = new StdioClientTransport({ command: process.execPath, args: [SERVER], env: childEnv, stderr: "pipe" });
  const client = new Client({ name: `multi-agent-smoke:${label}`, version: "0.0.0" });
  await client.connect(transport);
  const pid = transport.pid;
  if (pid === null) throw new Error(`server ${label}: no child pid after connect`);
  return {
    client,
    label,
    pid,
    kill() { try { process.kill(pid, "SIGKILL"); } catch { /* already gone */ } },
    async close() { await client.close().catch(() => undefined); },
  };
}

/** The pid recorded in the Firefox session-slot file under artifactDir — i.e. the current HOLDER. */
function holderPid(artifactDir: string): number | undefined {
  for (const name of readdirSync(artifactDir)) {
    if (!name.startsWith("ff-session-") || !name.endsWith(".json")) continue;
    try {
      const rec = JSON.parse(readFileSync(join(artifactDir, name), "utf8")) as { pid?: unknown; muxEndpoint?: unknown };
      if (typeof rec.pid === "number") return rec.pid;
    } catch { /* mid-rename; caller polls */ }
  }
  return undefined;
}

/* ------------------------------------ one agent's job ------------------------------------ */
interface CallSpan { agent: string; tool: string; start: number; end: number; ok: boolean }
interface AgentResult {
  agent: string; ok: boolean; error?: string; spans: CallSpan[]; targetId?: string;
  /** Transient failures that were retried. */
  retries: number;
  /** Times the agent had to re-resolve its tab (stale target id after a session re-establishment). */
  reResolutions: number;
  /** The first stale-target error message seen (S3b asserts it carries the recovery hint). */
  staleError?: string;
}
interface AgentOpts {
  /** Transient-failure retries allowed per round (the failover scenarios). Default 0. */
  retries?: number;
  /** Awaited after every completed round; lets a scenario hold every agent at a barrier and act (kill a process) while all are mid-run. */
  onRound?: (round: number) => void | Promise<void>;
  /** On a stale-target error, re-find the tab by url via list_pages, claim it again and continue on it. */
  reResolve?: boolean;
}
const STALE_TARGET_RE = /no context matching|no such frame|re-established|no page target|not found/i;

function text(res: unknown): string {
  const r = res as { content?: Array<{ type: string; text?: string }>; isError?: boolean };
  return (r.content ?? []).map((c) => c.text ?? "").join("");
}

/**
 * Drive ONE agent on ONE tab. `lease` is threaded on every call because the tab is claimed:
 * that is the real multi-agent protocol (a tab another agent holds refuses you), and it is what
 * makes an accidental cross-tab call fail loudly instead of silently reading the wrong page.
 */
async function runAgent(client: Client, agent: string, fixturePort: number, spans: CallSpan[], opts: AgentOpts = {}): Promise<AgentResult> {
  const url = `http://127.0.0.1:${fixturePort}/agent/${agent}`;
  const retriesAllowed = opts.retries ?? 0;
  let retries = 0;
  let reResolutions = 0;
  let staleError: string | undefined;
  let targetId: string | undefined;
  let lease: string | undefined;
  const call = async (tool: string, args: Record<string, unknown>): Promise<unknown> => {
    const start = Date.now();
    let ok = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      // A SIGKILLed server never answers; bound every call so a dead process's agent fails
      // instead of hanging the scenario until the hard cap.
      const res = await Promise.race([
        client.callTool({ name: tool, arguments: args }),
        new Promise<never>((_, rej) => { timer = setTimeout(() => rej(new Error(`${tool}: no reply in 30s (server dead?)`)), 30_000); }),
      ]);
      const body = text(res);
      if ((res as { isError?: boolean }).isError) throw new Error(`${tool}: ${body}`);
      ok = true;
      try { return JSON.parse(body); } catch { return body; }
    } finally {
      if (timer) clearTimeout(timer);
      spans.push({ agent, tool, start, end: Date.now(), ok });
    }
  };
  try {
    const created = (await call("new_page", { url, claim: true, label: `agent-${agent}` })) as { targetId: string; lease?: string };
    targetId = created.targetId;
    lease = created.lease;
    if (!targetId) throw new Error(`new_page returned no targetId: ${JSON.stringify(created)}`);
    if (!lease) throw new Error(`new_page{claim:true} returned no lease: ${JSON.stringify(created)}`);
    await call("navigate_page", { target: targetId, lease, url, waitUntil: "load" });
    const marked = (await call("evaluate_script", {
      target: targetId, lease,
      expression: `(() => { window.__agent = ${JSON.stringify(agent)}; window.__r = {}; return document.title; })()`,
    })) as string;
    if (marked !== `agent-${agent}`) throw new Error(`after navigate, title=${JSON.stringify(marked)} expected agent-${agent}`);
    type Seen = { agent: string; n: number; title: string; href: string };
    for (let round = 1; round <= ROUNDS; round++) {
      // The round write is IDEMPOTENT (a keyed set, not an increment): a retry after a transient
      // failure — the first attempt may or may not have reached Firefox before the socket died —
      // still reads exactly `round` keys. A lost round or a foreign write still shows as a wrong count.
      const attemptRound = () => call("evaluate_script", {
        target: targetId, lease,
        expression: `(() => { window.__r = window.__r || {}; window.__r[${round}] = 1; return { agent: window.__agent, n: Object.keys(window.__r).length, title: document.title, href: location.href }; })()`,
      }) as Promise<Seen>;
      let seen: Seen | undefined;
      for (let attempt = 0; seen === undefined; attempt++) {
        try { seen = await attemptRound(); } catch (e) {
          if (attempt >= retriesAllowed) throw e;
          const msg = e instanceof Error ? e.message : String(e);
          if (opts.reResolve && STALE_TARGET_RE.test(msg)) {
            // The session was re-established under us and Firefox re-numbered every tab. The tab
            // itself is still there: find it by its url, claim it again, and carry on. The marker
            // and the round set inside it prove it is the SAME tab, not a look-alike.
            staleError ??= msg;
            await new Promise((r) => setTimeout(r, 300));
            const listed = (await call("list_pages", {})) as { pages?: Array<{ id?: string; targetId?: string; url?: string }> } | Array<{ id?: string; targetId?: string; url?: string }>;
            const pages = Array.isArray(listed) ? listed : (listed.pages ?? []);
            const hit = pages.find((p) => p.url === url);
            if (!hit) throw new Error(`round ${round}: after a stale-target error the tab ${url} is gone from list_pages (${pages.map((p) => p.url).join(", ")})`);
            const newId = hit.id ?? hit.targetId;
            if (!newId) throw new Error(`round ${round}: list_pages entry has no id: ${JSON.stringify(hit)}`);
            const claimed = (await call("claim_page", { target: newId, label: `agent-${agent}` })) as { targetId: string; lease?: string };
            targetId = claimed.targetId;
            lease = claimed.lease;
            reResolutions++;
          }
          retries++;
          await new Promise((r) => setTimeout(r, 500 * (attempt + 1)));
        }
      }
      if (seen.agent !== agent) throw new Error(`round ${round}: read marker of agent ${JSON.stringify(seen.agent)} in tab of agent ${agent} (cross-tab leak)`);
      if (seen.n !== round) throw new Error(`round ${round}: counter=${seen.n} (someone else bumped this tab, or a round was lost)`);
      if (seen.title !== `agent-${agent}` || seen.href !== url) throw new Error(`round ${round}: tab drifted to ${seen.href} (${seen.title})`);
      await opts.onRound?.(round);
    }
    return { agent, ok: true, spans, targetId, retries, reResolutions, staleError };
  } catch (e) {
    return { agent, ok: false, error: e instanceof Error ? e.message : String(e), spans, targetId, retries, reResolutions, staleError };
  } finally {
    if (targetId) await call("close_page", { target: targetId, ...(lease ? { lease } : {}) }).catch(() => undefined);
  }
}

/* ------------------------------------ concurrency metrics ------------------------------------ */
function maxInFlight(spans: CallSpan[]): number {
  const events: Array<[number, number]> = [];
  for (const s of spans) { events.push([s.start, +1]); events.push([s.end, -1]); }
  events.sort((a, b) => a[0] - b[0] || a[1] - b[1]); // an end at t sorts before a start at t
  let cur = 0, max = 0;
  for (const [, d] of events) { cur += d; if (cur > max) max = cur; }
  return max;
}
/** Instants where calls from ≥2 DISTINCT agents were in flight together. */
function maxDistinctAgentsInFlight(spans: CallSpan[]): number {
  const events: Array<[number, number, string]> = [];
  for (const s of spans) { events.push([s.start, +1, s.agent]); events.push([s.end, -1, s.agent]); }
  events.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const live = new Map<string, number>();
  let max = 0;
  for (const [, d, a] of events) {
    live.set(a, (live.get(a) ?? 0) + d);
    if ((live.get(a) ?? 0) <= 0) live.delete(a);
    if (live.size > max) max = live.size;
  }
  return max;
}
function summarize(results: AgentResult[], spans: CallSpan[], wallMs: number): string {
  const serialMs = spans.reduce((acc, s) => acc + (s.end - s.start), 0);
  const failed = results.filter((r) => !r.ok);
  const retries = results.reduce((acc, r) => acc + r.retries, 0);
  return `agents=${results.length} ok=${results.length - failed.length} calls=${spans.length} wall=${wallMs}ms serialSum=${serialMs}ms ` +
    `maxInFlight=${maxInFlight(spans)} maxDistinctAgentsInFlight=${maxDistinctAgentsInFlight(spans)}` +
    (retries ? ` retries=${retries}` : "") +
    (failed.length ? ` | errors: ${failed.map((f) => `${f.agent}: ${(f.error ?? "").slice(0, 160)}`).join(" || ")}` : "");
}

/* ------------------------------------ scenarios ------------------------------------ */
async function scenarioOneProcess(env: Record<string, string>, fixturePort: number): Promise<void> {
  console.log(`\n── S1: ONE MCP server process, ${AGENTS} concurrent agents on ${AGENTS} tabs ──`);
  const server = await startServer("s1", env);
  try {
    const spans: CallSpan[] = [];
    const t0 = Date.now();
    const results = await Promise.all(
      Array.from({ length: AGENTS }, (_, i) => runAgent(server.client, `s1-${i + 1}`, fixturePort, spans)),
    );
    const wall = Date.now() - t0;
    const allOk = results.every((r) => r.ok);
    const overlap = maxDistinctAgentsInFlight(spans);
    record(`S1 every agent completed ${ROUNDS} isolated rounds on its own tab (one process, one BiDi session)`, allOk, summarize(results, spans, wall));
    record("S1 agents ran CONCURRENTLY, not serialized (≥2 distinct agents in flight at once)", allOk && overlap >= 2, `maxDistinctAgentsInFlight=${overlap}`);
    const pages = JSON.parse(text(await server.client.callTool({ name: "list_pages", arguments: {} }))) as { pages?: unknown[] } | unknown[];
    const count = Array.isArray(pages) ? pages.length : (pages.pages?.length ?? -1);
    record("S1 every agent tab was closed afterwards (no leaked tabs beyond Firefox's initial one)", count <= 1, `list_pages count=${count}`);
  } finally {
    await server.close();
  }
}

async function scenarioManyProcesses(env: Record<string, string>, fixturePort: number, n: number, tag: string, artifactDir?: string): Promise<boolean> {
  console.log(`\n── ${tag}: ${n} MCP server PROCESS${n === 1 ? "" : "ES"} attached to the SAME Firefox, one agent each, all at once ──`);
  const servers = await Promise.all(Array.from({ length: n }, (_, i) => startServer(`${tag}-${i + 1}`, env)));
  try {
    const spans: CallSpan[] = [];
    const t0 = Date.now();
    const results = await Promise.all(servers.map((s, i) => runAgent(s.client, `${tag}-${i + 1}`, fixturePort, spans)));
    const wall = Date.now() - t0;
    const allOk = results.every((r) => r.ok);
    const overlap = maxDistinctAgentsInFlight(spans);
    record(`${tag} every process's agent completed ${ROUNDS} isolated rounds on its own tab of the ONE shared Firefox`, allOk, summarize(results, spans, wall));
    if (n > 1) record(`${tag} processes drove their tabs CONCURRENTLY (≥2 distinct agents in flight at once)`, allOk && overlap >= 2, `maxDistinctAgentsInFlight=${overlap}`);
    if (n > 1 && artifactDir !== undefined) {
      // The one real BiDi session must be owned by a DETACHED daemon, not by any of the server
      // processes: that is what makes a server's exit invisible to the others (S3a).
      const holder = holderPid(artifactDir);
      const alive = holder !== undefined && (() => { try { process.kill(holder, 0); return true; } catch { return false; } })();
      record(`${tag} the session slot is held by a live DETACHED daemon, not by any server process`,
        alive && !servers.some((s) => s.pid === holder), `holder pid=${holder} alive=${alive} servers=${servers.map((s) => s.pid).join(",")}`);
    }
    return allOk;
  } finally {
    await Promise.all(servers.map((s) => s.close()));
  }
}

/**
 * S3 — failover. N processes share the Firefox through the mux DAEMON (a detached process that owns
 * the one real BiDi session; every MCP server process is a joiner). Once every agent has completed
 * two rounds, all agents are held at a barrier while ONE process is SIGKILLed, then released.
 *
 *   S3a victim = one of the MCP server processes. The daemon is untouched, so the survivors must not
 *       even notice: every remaining round succeeds on the same tab, and the session holder is unchanged.
 *   S3b victim = the daemon itself. The session must be re-established by a fresh daemon. Firefox
 *       renumbers every tab when its session is re-created (measured on 153.0.3), so each survivor's
 *       target id goes stale: the driver must say so with a recovery hint, and the agent must be able
 *       to find its tab again by url, claim it again, and finish on it — proven by the marker and the
 *       round set that live inside that tab.
 *
 * The killed server's own agent is expected to fail and its tab to leak (nobody can close a dead
 * process's tab); neither counts against anyone.
 */
async function scenarioFailover(env: Record<string, string>, fixturePort: number, n: number, artifactDir: string, victim: "server" | "daemon"): Promise<boolean> {
  const tag = victim === "server" ? "S3a" : "S3b";
  console.log(`\n── ${tag}: ${n} MCP server PROCESSES on the SAME Firefox; the ${victim === "server" ? "FIRST SERVER PROCESS" : "SESSION DAEMON"} is SIGKILLed while every agent is mid-run ──`);
  const servers = await Promise.all(Array.from({ length: n }, (_, i) => startServer(`${tag}-${i + 1}`, env)));
  let killedServer: Server | undefined;
  let killedPid: number | undefined;
  let killedAt = 0;
  let holderBefore: number | undefined;
  let gateError = "";
  let arrived = 0;
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  const barrier = async (round: number): Promise<void> => {
    if (round !== 2) return;
    arrived++;
    if (arrived === n) {
      holderBefore = holderPid(artifactDir);
      if (victim === "server") {
        killedServer = servers[0]!;
        killedPid = killedServer.pid;
      } else {
        killedPid = holderBefore;
        if (killedPid === undefined) gateError = "no session-slot record found, so there is no daemon pid to kill";
        else if (servers.some((s) => s.pid === killedPid)) gateError = `slot holder pid ${killedPid} is one of our SERVER processes — the session is not held by a detached daemon`;
      }
      if (!gateError && killedPid !== undefined) {
        killedAt = Date.now();
        try { process.kill(killedPid, "SIGKILL"); } catch (e) { gateError = `SIGKILL ${killedPid}: ${e instanceof Error ? e.message : String(e)}`; }
        console.log(`      SIGKILLed ${victim} pid=${killedPid} with every agent parked after round 2`);
      }
      release();
    }
    await gate;
  };
  try {
    const spans: CallSpan[] = [];
    const t0 = Date.now();
    const results = await Promise.all(servers.map((s, i) => {
      const agent = `${tag}-${i + 1}`;
      return runAgent(s.client, agent, fixturePort, spans, { retries: 6, reResolve: victim === "daemon", onRound: barrier });
    }));
    const wall = Date.now() - t0;
    const killed = !gateError && killedPid !== undefined;
    record(`${tag} the ${victim} was identified and SIGKILLed while all ${n} agents were parked mid-run`, killed,
      killed ? `pid=${killedPid} at t+${killedAt - t0}ms; holder before=${holderBefore}` : gateError || "barrier never filled (an agent failed before round 2?)");
    const survivors = results.filter((r) => r.agent !== killedServer?.label);
    const survivorSpans = spans.filter((s) => s.agent !== killedServer?.label);
    const expected = victim === "server" ? n - 1 : n;
    record(`${tag} every surviving process finished all ${ROUNDS} rounds on its ORIGINAL tab (same marker, same round set) after the kill`,
      killed && survivors.length === expected && survivors.every((r) => r.ok), summarize(survivors, survivorSpans, wall));
    const holderAfter = holderPid(artifactDir);
    const holderAlive = holderAfter !== undefined && (() => { try { process.kill(holderAfter, 0); return true; } catch { return false; } })();
    if (victim === "server") {
      record("S3a the session holder (daemon) is UNCHANGED and alive: a client process dying does not disturb the shared session",
        killed && holderAfter === holderBefore && holderAlive, `holder before=${holderBefore} after=${holderAfter} alive=${holderAlive}`);
      record("S3a survivors needed NO retries and NO re-resolution (the kill was invisible to them)",
        killed && survivors.every((r) => r.retries === 0 && r.reResolutions === 0), survivors.map((r) => `${r.agent}: retries=${r.retries} reResolutions=${r.reResolutions}`).join(", "));
    } else {
      record("S3b a NEW daemon took over the session slot (live pid, different from the killed one, not a server process)",
        killed && holderAlive && holderAfter !== holderBefore && !servers.some((s) => s.pid === holderAfter), `holder before=${holderBefore} after=${holderAfter} alive=${holderAlive}`);
      record("S3b every survivor hit a stale-target error, re-found its tab by url, claimed it again and continued on it (Firefox renumbers tabs per session)",
        killed && survivors.every((r) => r.reResolutions >= 1), survivors.map((r) => `${r.agent}: reResolutions=${r.reResolutions} retries=${r.retries}`).join(", "));
      const hinted = survivors.filter((r) => r.staleError && /re-established|list_pages/i.test(r.staleError));
      record("S3b the stale-target error itself carried the recovery hint (session re-established → re-resolve with list_pages)",
        killed && hinted.length === survivors.length, survivors[0]?.staleError ? `e.g. ${survivors[0].staleError.slice(0, 220)}` : "no stale error captured");
    }
    const afterKill = survivorSpans.filter((s) => killed && s.start > killedAt && s.ok);
    record(`${tag} after the kill the survivors still ran CONCURRENTLY (≥2 distinct agents in flight together)`,
      killed && maxDistinctAgentsInFlight(afterKill) >= 2, `post-kill successful calls=${afterKill.length} maxDistinctAgentsInFlight=${maxDistinctAgentsInFlight(afterKill)}`);
    if (killedServer) {
      const kr = results.find((r) => r.agent === killedServer?.label);
      console.log(`      (killed server's own agent: ${kr?.ok ? "unexpectedly ok" : `failed as expected — ${(kr?.error ?? "").slice(0, 120)}`})`);
    }
    return killed && survivors.every((r) => r.ok);
  } finally {
    await Promise.all(servers.map((s) => s.close()));
  }
}

/* ------------------------------------ main ------------------------------------ */
const binary = firefoxBinary();
if (!binary) {
  console.log("SKIP: Firefox binary not found (FIREFOX_BIN, /Applications/Firefox.app, or `firefox` on PATH)");
  process.exit(0);
}

const artifactDir = mkdtempSync(join(tmpdir(), "cdp-toolkit-multi-agent-artifacts-"));
const fixture = startFixtureServer();
let firefox: SharedFirefox | undefined;
const hardTimer = setTimeout(() => {
  console.error(`FATAL: hard wall-clock cap ${HARD_CAP_MS}ms hit`);
  cleanup();
  process.exit(2);
}, HARD_CAP_MS);
function cleanup(): void {
  try { fixture.stop(); } catch { /* ignore */ }
  if (firefox) {
    try { process.kill(firefox.pid, "SIGKILL"); } catch { /* already gone */ }
    rmSync(firefox.profile, { recursive: true, force: true });
  }
  rmSync(artifactDir, { recursive: true, force: true });
}

try {
  firefox = await launchSharedFirefox(binary);
  console.log(`shared Firefox pid=${firefox.pid} bidi=127.0.0.1:${firefox.rdpPort} marionette=${firefox.marionettePort} fixture=127.0.0.1:${fixture.port} agents=${AGENTS} rounds=${ROUNDS}`);
  const env: Record<string, string> = {
    CDP_BROWSER: "firefox",
    CDP_FIREFOX_ENDPOINT: String(firefox.rdpPort),
    CDP_FIREFOX_MARIONETTE_PORT: String(firefox.marionettePort),
    CDP_ARTIFACT_DIR: artifactDir,
    CDP_FIREFOX_SESSION_WAIT_MS: "8000",
  };
  await scenarioOneProcess(env, fixture.port);
  const control = await scenarioManyProcesses(env, fixture.port, 1, "S2a");
  const multi = control ? await scenarioManyProcesses(env, fixture.port, AGENTS, "S2b", artifactDir) : false;
  if (!control) record("S2b skipped: the one-process control S2a failed, so a multi-process result would be uninterpretable", false, "");
  if (multi) {
    const a = await scenarioFailover(env, fixture.port, AGENTS, artifactDir, "server");
    if (a) await scenarioFailover(env, fixture.port, AGENTS, artifactDir, "daemon");
    else record("S3b skipped: S3a did not pass", false, "");
  } else {
    record("S3a/S3b skipped: S2b did not pass, so there is nothing to fail over from", false, "");
  }
  record("FINAL: the shared Firefox is still the same live pid (no server killed the browser it attached to)",
    (() => { try { process.kill(firefox.pid, 0); return true; } catch { return false; } })(), `pid=${firefox.pid}`);
  // Daemon lifecycle: with every server gone the daemon is idle (default idle exit is 15 s), but
  // Firefox dying must end it at once — a daemon that outlives its browser would be a leak.
  const daemon = holderPid(artifactDir);
  const daemonAlive = (): boolean => { if (daemon === undefined) return false; try { process.kill(daemon, 0); return true; } catch { return false; } };
  const wasAlive = daemonAlive();
  try { process.kill(firefox.pid, "SIGKILL"); } catch { /* already gone */ }
  const tKill = Date.now();
  while (daemonAlive() && Date.now() - tKill < 10_000) await new Promise((r) => setTimeout(r, 100));
  record("FINAL: the session daemon exits by itself once Firefox is gone (no leaked daemon)",
    daemon !== undefined && wasAlive && !daemonAlive(), `daemon pid=${daemon} aliveBeforeFirefoxDied=${wasAlive} exitedWithin=${Date.now() - tKill}ms`);
} catch (err) {
  record("FATAL", false, err instanceof Error ? (err.stack ?? err.message) : String(err));
} finally {
  clearTimeout(hardTimer);
  cleanup();
}

const failed = checks.filter((c) => !c.ok);
console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`);
if (failed.length) {
  console.error(`FAILED: ${failed.map((c) => c.name).join(" | ")}`);
  process.exit(1);
}
console.log("FIREFOX MULTI-AGENT SMOKE OK");
process.exit(0);
