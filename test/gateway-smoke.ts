/**
 * call_tool end-to-end against a real browser: the 3.0 gateway's one claim that the
 * browser-free protocol tests (test/mcp-protocol.test.ts) cannot reach — that a `lease`
 * passed INSIDE call_tool's `arguments` reaches the lease scope exactly as it does on a
 * direct call. Drives the real `src/mcp.ts` over raw stdio JSON-RPC with the default
 * (gateway) profile, so only the 5 gateway tools are listed and new_page/close_page are
 * reachable only through call_tool.
 *
 * Touches only the one tab it opens (labelled gateway-smoke, closed at the end); lease
 * files go to a private CDP_ARTIFACT_DIR removed on exit.
 *
 * Run with `bun run gateway:smoke`. `CDP_BASE` selects the browser (default
 * http://127.0.0.1:9222). Prints one PASS/FAIL line per assertion; exits non-zero on any FAIL.
 */
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const BASE = process.env.CDP_BASE ?? "http://127.0.0.1:9222";
const SERVER = fileURLToPath(new URL("../src/mcp.ts", import.meta.url));
const LABEL = "gateway-smoke";

try {
  const res = await fetch(`${BASE}/json/version`, { signal: AbortSignal.timeout(5_000) });
  const ver = (await res.json()) as { Browser?: string; "User-Agent"?: string };
  console.log(`browser at ${BASE}: ${ver.Browser} (${ver["User-Agent"]?.includes("Headless") ? "headless" : "headed"})`);
} catch {
  console.error(`No browser answering at ${BASE}. Start one with remote debugging on that port, or set CDP_BASE.`);
  process.exit(2);
}

const artifactDir = await mkdtemp(join(tmpdir(), "cdp-gateway-smoke-"));
const env: Record<string, string> = {};
for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v;
delete env.CDP_TOOL_PROFILE;
Object.assign(env, { CDP_BASE: BASE, CDP_ARTIFACT_DIR: artifactDir });
const child = spawn(process.execPath, [SERVER], { env, stdio: ["pipe", "pipe", "pipe"] });

type Json = Record<string, any>;
const pending = new Map<number, (m: Json) => void>();
let buf = "";
child.stdout.on("data", (chunk: Buffer) => {
  buf += chunk.toString();
  for (let nl = buf.indexOf("\n"); nl >= 0; nl = buf.indexOf("\n")) {
    const line = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    if (!line) continue;
    const msg = JSON.parse(line) as Json;
    const settle = typeof msg.id === "number" ? pending.get(msg.id) : undefined;
    if (settle) { pending.delete(msg.id); settle(msg); }
  }
});
let nextId = 0;
function rpc(method: string, params: Json = {}): Promise<Json> {
  const id = ++nextId;
  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`no reply to ${method} within 30s`)), 30_000);
    pending.set(id, (m) => { clearTimeout(timer); resolve(m); });
  });
}
async function call(name: string, args: Json): Promise<{ isError: boolean; text: string }> {
  const m = await rpc("tools/call", { name, arguments: args });
  return { isError: Boolean(m.result?.isError), text: (m.result?.content ?? []).map((c: { text?: string }) => c.text ?? "").join("") };
}

const failures: string[] = [];
function check(name: string, ok: boolean, detail = ""): void {
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${!ok && detail ? ` — ${detail}` : ""}`);
  if (!ok) failures.push(name);
}

let lease: string | undefined;
try {
  await rpc("initialize", { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "gateway-smoke", version: "1" } });
  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);

  const listed = ((await rpc("tools/list")).result.tools as Array<{ name: string }>).map((t) => t.name);
  check("default listing is the 7-tool gateway without new_page", listed.length === 7 && !listed.includes("new_page"), listed.join(","));

  const opened = await call("call_tool", { name: "new_page", arguments: { url: "about:blank", claim: true, label: LABEL } });
  lease = opened.isError ? undefined : (JSON.parse(opened.text) as { lease?: string }).lease;
  check("call_tool new_page {claim:true} returns a lease token", Boolean(lease), opened.text.slice(0, 200));

  const nav = { target: `label:${LABEL}`, url: "data:text/html,<title>gw</title><h1>gateway</h1>" };
  const refused = await call("call_tool", { name: "navigate_page", arguments: nav });
  check("call_tool without the lease is refused by the lease gate", refused.isError && refused.text.includes(`is leased by '${LABEL}'`), refused.text.slice(0, 200));

  const allowed = await call("call_tool", { name: "navigate_page", arguments: { ...nav, lease } });
  check("call_tool with the inner lease succeeds", !allowed.isError, allowed.text.slice(0, 200));

  const direct = await call("navigate_page", { ...nav, lease });
  check("direct call with the same lease succeeds (control)", !direct.isError, direct.text.slice(0, 200));

  const snap = await call("take_snapshot", { target: `label:${LABEL}`, lease });
  check("listed take_snapshot sees the navigated page", !snap.isError && snap.text.includes("gateway"), snap.text.slice(0, 200));
} finally {
  if (lease) {
    const closed = await call("call_tool", { name: "close_page", arguments: { target: `label:${LABEL}`, lease } });
    check("call_tool close_page releases the lease", !closed.isError && closed.text.includes('"leaseReleased": true'), closed.text.slice(0, 200));
  }
  child.kill();
  await rm(artifactDir, { recursive: true, force: true });
}

if (failures.length) {
  console.error(`\n${failures.length} FAIL: ${failures.join("; ")}`);
  process.exit(1);
}
console.log("\nall gateway smoke checks passed");
