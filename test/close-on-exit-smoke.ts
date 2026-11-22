/**
 * Live smoke for close-on-exit and CDP_MAX_AGENT_TABS (src/ownedTabs.ts) against a REAL Chrome.
 *
 *   CDP_BASE=http://127.0.0.1:9333 node --experimental-strip-types test/close-on-exit-smoke.ts
 *   (or: CDP_BASE=... bun run close-on-exit:smoke)
 *
 * Point it at a THROWAWAY Chrome (its own --user-data-dir and port): it opens and closes tabs and
 * kills MCP servers on purpose. It refuses CDP_BASE on port 9222, the usual shared browser.
 *
 * For each exit path (SIGTERM, SIGINT, SIGHUP, stdin EOF, parent killed with SIGKILL while stdin
 * stays open) it starts the built server (dist/mcp.js, the installed entry point), opens:
 *   A  new_page (background agent tab)          -> must be CLOSED on exit
 *   B  new_page claim:true (leased agent tab)   -> must be CLOSED on exit
 *   H  new_page focus:true (for the human)      -> must SURVIVE
 * and, outside that server:
 *   U  a tab opened with PUT /json/new (origin 'unknown')              -> must SURVIVE
 *   P  a tab opened by a second, still-running server (another process) -> must SURVIVE
 * and popups (window.open from a page, ./src/cdp/popupWatch.ts):
 *   W  opened by A                               -> must be CLOSED on exit (inherits A's ownership)
 *   HW opened by H                               -> must SURVIVE (a copy of a tab for the human)
 *   XW (SIGTERM only) opened by agent tab X, then X closed with close_page before exit (the hop a
 *      web app makes when it moves to a copy of itself) -> must be CLOSED on exit
 *   UW opened by U (not this server's)           -> must SURVIVE
 * then checks /json/list after the server is gone. Finally it checks the cap: with
 * CDP_MAX_AGENT_TABS=2 the third background new_page is an error naming the cap, and a focus:true
 * one still opens.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const BASE = process.env.CDP_BASE ?? "";
if (!/^http:\/\/127\.0\.0\.1:\d+$/.test(BASE) || BASE.endsWith(":9222")) {
  console.error("set CDP_BASE=http://127.0.0.1:<port> of a THROWAWAY Chrome (never :9222)");
  process.exit(2);
}
const SERVER = process.env.SMOKE_SERVER ?? fileURLToPath(new URL("../dist/mcp.js", import.meta.url));
const NODE = process.env.SMOKE_NODE ?? process.execPath;
const artifactDir = mkdtempSync(join(tmpdir(), "cdp-close-smoke-"));
const extraEnv = (process.env.SMOKE_EXTRA_ENV ?? "").split(",").filter(Boolean).map((kv) => kv.split("=") as [string, string]);
const baseEnv: Record<string, string> = {
  ...(process.env as Record<string, string>),
  CDP_BROWSER: "chrome",
  CDP_BASE: BASE,
  CDP_ARTIFACT_DIR: artifactDir,
  CDP_STATE_DIR: join(artifactDir, "state"),
  ...Object.fromEntries(extraEnv),
};

/** CDP_HIDDEN_TABS=1: background agent tabs are Chrome hidden targets, which open NO popup at all
 *  (measured on Chrome 158: window.open returns a window but no target is created, and a clicked
 *  target=_blank link creates nothing). So W and XW are checked as "never appeared" there. */
const HIDDEN = ["1", "true", "yes", "on"].includes((Object.fromEntries(extraEnv).CDP_HIDDEN_TABS ?? "").toLowerCase());

let failures = 0;
const check = (ok: boolean, msg: string) => {
  console.log(`${ok ? "PASS" : "FAIL"} ${msg}`);
  if (!ok) failures++;
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function listing(): Promise<Array<{ id: string; url: string }>> {
  return (await (await fetch(`${BASE}/json/list`)).json()) as Array<{ id: string; url: string }>;
}
/** Open a popup from tab `from` the way a person does: a target=_blank link, clicked with real
 *  input (via `rpc`'s click tool, or raw CDP Input events for U, which no server holds). A bare
 *  window.open without a user gesture is eaten by the popup blocker. Returns the popup's id. */
async function popup(rpc: Rpc | undefined, from: string, tag: string, opts: { mayNotAppear?: boolean } = {}): Promise<string | undefined> {
  const plant = `(() => { const a = document.createElement('a'); a.id = 'pop'; a.href = 'about:blank#${tag}'; a.target = '_blank'; a.textContent = 'open'; a.style.cssText = 'position:fixed;left:10px;top:10px;font-size:40px'; document.body.append(a); return 1; })()`;
  if (rpc) {
    const r = await rpc.tool("evaluate_script", { target: from, expression: plant });
    if (r.isError) throw new Error(`plant link in ${from} failed: ${r.text}`);
    const c = await rpc.tool("click", { target: from, selector: "#pop" });
    if (c.isError) throw new Error(`click in ${from} failed: ${c.text}`);
  } else {
    await rawCdp(from, [
      ["Runtime.evaluate", { expression: plant }],
      ["Input.dispatchMouseEvent", { type: "mousePressed", x: 30, y: 30, button: "left", clickCount: 1 }],
      ["Input.dispatchMouseEvent", { type: "mouseReleased", x: 30, y: 30, button: "left", clickCount: 1 }],
    ]);
  }
  const t0 = Date.now();
  while (Date.now() - t0 < (opts.mayNotAppear ? 2_000 : 5_000)) {
    const hit = (await listing()).find((t) => t.url.endsWith(`#${tag}`));
    if (hit) return hit.id;
    await sleep(100);
  }
  if (opts.mayNotAppear) return undefined;
  throw new Error(`popup #${tag} from ${from} never appeared`);
}
/** CDP commands on a page over its own socket, outside any MCP server (for U, the "human" tab). */
async function rawCdp(id: string, cmds: Array<[string, Record<string, unknown>]>): Promise<void> {
  const ws = new WebSocket(`${BASE.replace("http", "ws")}/devtools/page/${id}`);
  await new Promise((r, j) => ((ws.onopen = r), (ws.onerror = j)));
  let n = 0;
  for (const [method, params] of cmds) {
    const id = ++n;
    await new Promise<void>((r) => {
      ws.onmessage = (m) => { if (JSON.parse(String(m.data)).id === id) r(); };
      ws.send(JSON.stringify({ id, method, params }));
    });
  }
  ws.close();
}

async function liveIds(): Promise<Set<string>> {
  const list = (await (await fetch(`${BASE}/json/list`)).json()) as Array<{ id: string }>;
  return new Set(list.map((t) => t.id));
}
async function closeRaw(id: string) {
  await fetch(`${BASE}/json/close/${id}`).catch(() => undefined);
}

/** A minimal line-delimited JSON-RPC client over a child's stdio (2025-era initialize). */
class Rpc {
  private buf = "";
  private next = 1;
  private waiters = new Map<number, (v: unknown) => void>();
  stderr = "";
  constructor(readonly child: ChildProcess) {
    child.stdout!.setEncoding("utf8");
    child.stdout!.on("data", (d: string) => {
      this.buf += d;
      let i: number;
      while ((i = this.buf.indexOf("\n")) >= 0) {
        const line = this.buf.slice(0, i);
        this.buf = this.buf.slice(i + 1);
        if (!line.trim()) continue;
        const msg = JSON.parse(line) as { id?: number };
        if (typeof msg.id === "number") this.waiters.get(msg.id)?.(msg);
      }
    });
    child.stderr!.setEncoding("utf8");
    child.stderr!.on("data", (d: string) => (this.stderr += d));
  }
  request(method: string, params: unknown): Promise<any> {
    const id = this.next++;
    this.child.stdin!.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    return new Promise((r) => this.waiters.set(id, r));
  }
  notify(method: string) {
    this.child.stdin!.write(JSON.stringify({ jsonrpc: "2.0", method }) + "\n");
  }
  async init() {
    await this.request("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "close-smoke", version: "0" } });
    this.notify("notifications/initialized");
  }
  async tool(name: string, args: Record<string, unknown>): Promise<{ text: string; isError: boolean }> {
    const res = await this.request("tools/call", { name: "call_tool", arguments: { name, arguments: args } });
    const text = res.result?.content?.[0]?.text ?? JSON.stringify(res.error);
    return { text, isError: res.result?.isError === true || res.error !== undefined };
  }
  async newPage(args: Record<string, unknown>): Promise<string> {
    const r = await this.tool("new_page", { url: "about:blank", ...args });
    if (r.isError) throw new Error(`new_page failed: ${r.text}`);
    return (JSON.parse(r.text) as { targetId: string }).targetId;
  }
}

function startServer(env: Record<string, string> = {}): Rpc {
  const child = spawn(NODE, [SERVER], { env: { ...baseEnv, ...env }, stdio: ["pipe", "pipe", "pipe"] });
  return new Rpc(child);
}

/** Server as a GRANDCHILD: bash starts it and waits, so killing bash orphans it with stdin open. */
function startOrphanable(): { rpc: Rpc; parent: ChildProcess } {
  const parent = spawn("bash", ["-c", `exec 3<&0; "${NODE}" "${SERVER}" <&3 & wait`], { env: baseEnv, stdio: ["pipe", "pipe", "pipe"] });
  return { rpc: new Rpc(parent), parent };
}

async function waitExit(child: ChildProcess, ms: number): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) return true;
  return Promise.race([new Promise<boolean>((r) => child.once("exit", () => r(true))), sleep(ms).then(() => false)]);
}

async function waitGone(ids: string[], ms: number): Promise<Set<string>> {
  const t0 = Date.now();
  let live = await liveIds();
  while (ids.some((id) => live.has(id)) && Date.now() - t0 < ms) {
    await sleep(100);
    live = await liveIds();
  }
  return live;
}

async function main() {
  console.log(`close-on-exit smoke against ${BASE}, server ${SERVER}, node ${NODE}`);
  // P: another process's agent tab, held by a peer server that stays up the whole run.
  const peer = startServer();
  await peer.init();
  const P = await peer.newPage({});
  // U: a tab the toolkit did not create.
  const U = ((await (await fetch(`${BASE}/json/new?about:blank`, { method: "PUT" })).json()) as { id: string }).id;
  const toClean: string[] = [];

  const modes = ["SIGTERM", "SIGINT", "SIGHUP", "stdin-eof", "parent-killed"] as const;
  for (const mode of modes) {
    let rpc: Rpc;
    let parent: ChildProcess | undefined;
    if (mode === "parent-killed") ({ rpc, parent } = startOrphanable());
    else rpc = startServer();
    await rpc.init();
    const A = await rpc.newPage({});
    const B = await rpc.newPage({ claim: true });
    const H = await rpc.newPage({ focus: true });
    const W = await popup(rpc, A, `w-${mode}`, { mayNotAppear: HIDDEN });
    if (HIDDEN) check(W === undefined, `${mode}: hidden agent tab A opened no popup (Chrome hidden targets cannot)`);
    const HW = (await popup(rpc, H, `hw-${mode}`))!;
    const UW = (await popup(undefined, U, `uw-${mode}`))!;
    toClean.push(UW);
    let XW: string | undefined;
    if (mode === "SIGTERM" && !HIDDEN) {
      const X = await rpc.newPage({});
      XW = await popup(rpc, X, `xw-${mode}`);
      await rpc.tool("close_page", { target: X });
    }
    const listed = JSON.parse((await rpc.tool("list_pages", {})).text) as { pages: Array<{ id: string; origin: string }> };
    const originOf = (id: string) => listed.pages.find((p) => p.id === id)?.origin;
    if (W) check(originOf(W) === "agent", `${mode}: popup W listed with origin agent (got ${originOf(W)})`);
    check(originOf(HW) === "agent", `${mode}: popup HW of H listed with origin agent (got ${originOf(HW)})`);
    check(originOf(UW) === "unknown", `${mode}: popup UW of U listed with origin unknown (got ${originOf(UW)})`);
    const before = await liveIds();
    check([A, B, H, U, P, HW, UW, ...(W ? [W] : [])].every((id) => before.has(id)), `${mode}: all tabs and popups open before exit`);
    const expectClosed = 2 + (W ? 1 : 0) + (XW ? 1 : 0);

    if (mode === "stdin-eof") rpc.child.stdin!.end();
    else if (mode === "parent-killed") parent!.kill("SIGKILL");
    else rpc.child.kill(mode);

    if (mode !== "parent-killed") check(await waitExit(rpc.child, 10_000), `${mode}: server exited`);
    const after = await waitGone([A, B, ...(W ? [W] : []), ...(XW ? [XW] : [])], 10_000);
    check(!after.has(A) && !after.has(B), `${mode}: agent tabs A,B closed`);
    if (W) check(!after.has(W), `${mode}: popup W of agent tab A closed`);
    if (XW) check(!after.has(XW), `${mode}: popup XW closed although its opener X was closed first (the hop)`);
    check(after.has(HW), `${mode}: popup HW of the human's tab H kept`);
    check(after.has(UW), `${mode}: popup UW of the unknown-origin tab U kept`);
    check(after.has(H), `${mode}: for-the-human tab H kept`);
    check(after.has(U), `${mode}: unknown-origin tab U kept`);
    check(after.has(P), `${mode}: other process's agent tab P kept`);
    const line = rpc.stderr.split("\n").find((l) => l.includes("shutdown ("));
    if (mode !== "parent-killed") check(line !== undefined && line.includes(`closed ${expectClosed} `), `${mode}: stderr reports it: ${line?.trim() ?? "(none)"}`);
    else console.log(`     parent-killed: grandchild stderr not captured past the parent (bash), tab check above is the evidence`);
    rpc.child.stdin!.destroy();
    await closeRaw(H);
    await closeRaw(HW);
  }

  // The cap.
  const capped = startServer({ CDP_MAX_AGENT_TABS: "2" });
  await capped.init();
  const c1 = await capped.newPage({});
  const c2 = await capped.newPage({});
  const third = await capped.tool("new_page", { url: "about:blank" });
  check(third.isError && third.text.includes("CDP_MAX_AGENT_TABS=2") && third.text.includes(c1) && third.text.includes(c2), `cap: third background new_page refused: ${third.text.slice(0, 140)}...`);
  const human = await capped.newPage({ focus: true });
  check(typeof human === "string", "cap: a focus:true tab still opens at the cap");
  await capped.tool("close_page", { target: c1 });
  const c3 = await capped.tool("new_page", { url: "about:blank" });
  check(!c3.isError, "cap: closing one frees a slot");
  capped.child.kill("SIGTERM");
  await waitExit(capped.child, 10_000);
  await closeRaw(human);

  // Clean up the peer and U.
  peer.child.kill("SIGTERM");
  await waitExit(peer.child, 10_000);
  const end = await waitGone([P], 10_000);
  check(!end.has(P), "peer: its own agent tab P closed when the PEER exited");
  await closeRaw(U);
  for (const id of toClean) await closeRaw(id);
  rmSync(artifactDir, { recursive: true, force: true });
  console.log(failures === 0 ? "ALL PASS" : `${failures} FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
