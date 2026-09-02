/**
 * MCP server smoke test: spawns src/mcp.ts as a real stdio MCP server via the
 * official SDK client, performs the initialize/tools/list handshake, and (if the
 * manifest is populated and Chrome is reachable) round-trips a real tool call
 * against a throwaway page. Run with `bun run mcp:smoke`.
 *
 * It then does the whole handshake a SECOND time on a client pinned to the 2026-07-28
 * revision, because the server is dual-era (a `server/discover` opening pins a modern
 * instance, a plain `initialize` pins a legacy one) and only a real client can prove the
 * modern path is reachable through the SDK rather than only through a hand-rolled probe.
 * The default client is left un-pinned on purpose: SDK 2.0's default is `mode: 'legacy'`,
 * so this file also reports which era an ordinary consumer actually lands on today.
 *
 * SAFETY: only creates and drives its OWN about:blank page; never touches a real tab.
 */
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { fileURLToPath } from "node:url";

const serverPath = fileURLToPath(new URL("../src/mcp.ts", import.meta.url));
// Forward our env (notably CDP_BASE) to the spawned server. The SDK otherwise
// passes only a safe whitelist, so a non-default CDP port would be silently dropped.
const childEnv: Record<string, string> = {};
for (const [k, v] of Object.entries(process.env)) if (v !== undefined) childEnv[k] = v;
const spawnServer = () => new StdioClientTransport({ command: process.execPath, args: [serverPath], env: childEnv });
const client = new Client({ name: "cdp-mcp-smoke", version: "0.0.0" });

let exitCode = 0;
/** The legacy connection's tool names, in order — the modern connection must match them. */
let legacyToolNames: string[] = [];
function callText(res: { content: Array<{ type: string; text?: string }>; isError?: boolean }): string {
  return res.content.map((c) => c.text ?? "").join("");
}

try {
  await client.connect(spawnServer());
  console.log("✅ initialize: connected to cdp-toolkit MCP server");
  // Measurement, not an assertion: an SDK 2.0 client with no versionNegotiation option
  // opens with `initialize`, so an ordinary consumer is expected to land on 'legacy'.
  console.log(`ℹ️  default client (no versionNegotiation) negotiated era: ${client.getProtocolEra() ?? "unknown"}`);

  const { tools } = await client.listTools();
  console.log(`✅ tools/list: ${tools.length} tools advertised`);
  legacyToolNames = tools.map((t) => t.name);
  const names = new Set(tools.map((t) => t.name));
  if (tools.length) {
    const sample = tools.find((t) => t.name === "click");
    console.log(`   e.g. click schema props: ${sample ? Object.keys((sample.inputSchema as { properties?: object }).properties ?? {}).join(", ") : "n/a"}`);
  }

  // Live round-trip only if the toolset is wired and Chrome is reachable.
  if (names.has("new_page") && names.has("evaluate_script") && names.has("close_page")) {
    let targetId = "";
    try {
      const created = await client.callTool({ name: "new_page", arguments: { url: "about:blank" } });
      targetId = JSON.parse(callText(created as never)).targetId as string;
      console.log(`✅ tools/call new_page: targetId=${targetId.slice(0, 8)}`);

      const ev = await client.callTool({ name: "evaluate_script", arguments: { target: targetId, expression: "2+40" } });
      const val = JSON.parse(callText(ev as never));
      console.log(`${val === 42 ? "✅" : "❌"} tools/call evaluate_script: 2+40 => ${val}`);
      if (val !== 42) exitCode = 1;
    } finally {
      if (targetId) {
        await client.callTool({ name: "close_page", arguments: { target: targetId } });
        console.log("✅ tools/call close_page: throwaway page cleaned up");
      }
    }
  } else {
    console.log("ℹ️  manifest not yet populated (or Chrome down), skipped live tools/call round-trip");
  }
} catch (err) {
  console.error(`❌ FATAL: ${err instanceof Error ? err.message : String(err)}`);
  exitCode = 1;
} finally {
  await client.close();
}

// ---- the 2026-07-28 era, through the real SDK client ----
// `{ mode: { pin } }` is the shape ClientOptions.versionNegotiation actually accepts
// (VersionNegotiationOptions = { mode?, probe? }); a bare `{ pin }` is not a mode and
// would silently leave the client on its 'legacy' default. Pinning means no fallback:
// if the server does not offer 2026-07-28 at connect, this throws rather than degrading.
const modern = new Client(
  { name: "cdp-mcp-smoke-modern", version: "0.0.0" },
  { versionNegotiation: { mode: { pin: "2026-07-28" } } },
);
try {
  await modern.connect(spawnServer());
  const era = modern.getProtocolEra();
  console.log(`${era === "modern" ? "✅" : "❌"} pinned 2026-07-28 client: era=${era ?? "unknown"}`);
  if (era !== "modern") exitCode = 1;

  const modernNames = (await modern.listTools()).tools.map((t) => t.name);
  // The length floor matters: two empty listings would "match" and turn a dead
  // connection into a green check.
  const same = modernNames.length > 0
    && modernNames.length === legacyToolNames.length
    && modernNames.every((n, i) => n === legacyToolNames[i]);
  console.log(`${same ? "✅" : "❌"} tools/list on the modern era: ${modernNames.length} tools, same names in the same order as the legacy connection`);
  if (!same) {
    exitCode = 1;
    console.error(`   legacy: ${legacyToolNames.join(", ")}`);
    console.error(`   modern: ${modernNames.join(", ")}`);
  }
} catch (err) {
  console.error(`❌ FATAL (modern era): ${err instanceof Error ? err.message : String(err)}`);
  exitCode = 1;
} finally {
  await modern.close();
}

console.log(exitCode === 0 ? "\nMCP SMOKE OK" : "\nMCP SMOKE FAILED");
process.exit(exitCode);
