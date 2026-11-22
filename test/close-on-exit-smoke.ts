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

let failures = 0;
const check = (ok: boolean, msg: string) => {
  console.log(`${ok ? "PASS" : "FAIL"} ${msg}`);
  if (!ok) failures++;
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

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
    const before = await liveIds();
    check([A, B, H, U, P].every((id) => before.has(id)), `${mode}: all five tabs open before exit`);

    if (mode === "stdin-eof") rpc.child.stdin!.end();
    else if (mode === "parent-killed") parent!.kill("SIGKILL");
    else rpc.child.kill(mode);

    if (mode !== "parent-killed") check(await waitExit(rpc.child, 10_000), `${mode}: server exited`);
    const after = await waitGone([A, B], 10_000);
    check(!after.has(A) && !after.has(B), `${mode}: agent tabs A,B closed`);
    check(after.has(H), `${mode}: for-the-human tab H kept`);
    check(after.has(U), `${mode}: unknown-origin tab U kept`);
    check(after.has(P), `${mode}: other process's agent tab P kept`);
    const line = rpc.stderr.split("\n").find((l) => l.includes("shutdown ("));
    if (mode !== "parent-killed") check(line !== undefined && line.includes("closed 2"), `${mode}: stderr reports it: ${line?.trim() ?? "(none)"}`);
    else console.log(`     parent-killed: grandchild stderr not captured past the parent (bash), tab check above is the evidence`);
    rpc.child.stdin!.destroy();
    await closeRaw(H);
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
  rmSync(artifactDir, { recursive: true, force: true });
  console.log(failures === 0 ? "ALL PASS" : `${failures} FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
