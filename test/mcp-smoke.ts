/**
 * MCP server smoke test — spawns src/mcp.ts as a real stdio MCP server via the
 * official SDK client, performs the initialize/tools/list handshake, and (if the
 * manifest is populated and Chrome is reachable) round-trips a real tool call
 * against a throwaway page. Run with `bun run mcp:smoke`.
 *
 * SAFETY: only creates and drives its OWN about:blank page; never touches a real tab.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { fileURLToPath } from "node:url";

const serverPath = fileURLToPath(new URL("../src/mcp.ts", import.meta.url));
// Forward our env (notably CDP_BASE) to the spawned server. The SDK otherwise
// passes only a safe whitelist, so a non-default CDP port would be silently dropped.
const childEnv: Record<string, string> = {};
for (const [k, v] of Object.entries(process.env)) if (v !== undefined) childEnv[k] = v;
const transport = new StdioClientTransport({ command: process.execPath, args: [serverPath], env: childEnv });
const client = new Client({ name: "cdp-mcp-smoke", version: "0.0.0" });

let exitCode = 0;
function callText(res: { content: Array<{ type: string; text?: string }>; isError?: boolean }): string {
  return res.content.map((c) => c.text ?? "").join("");
}

try {
  await client.connect(transport);
  console.log("✅ initialize — connected to cdp-toolkit MCP server");

  const { tools } = await client.listTools();
  console.log(`✅ tools/list — ${tools.length} tools advertised`);
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
      console.log(`✅ tools/call new_page — targetId=${targetId.slice(0, 8)}`);

      const ev = await client.callTool({ name: "evaluate_script", arguments: { target: targetId, expression: "2+40" } });
      const val = JSON.parse(callText(ev as never));
      console.log(`${val === 42 ? "✅" : "❌"} tools/call evaluate_script — 2+40 => ${val}`);
      if (val !== 42) exitCode = 1;
    } finally {
      if (targetId) {
        await client.callTool({ name: "close_page", arguments: { target: targetId } });
        console.log("✅ tools/call close_page — throwaway page cleaned up");
      }
    }
  } else {
    console.log("ℹ️  manifest not yet populated (or Chrome down) — skipped live tools/call round-trip");
  }
} catch (err) {
  console.error(`❌ FATAL: ${err instanceof Error ? err.message : String(err)}`);
  exitCode = 1;
} finally {
  await client.close();
}

console.log(exitCode === 0 ? "\nMCP SMOKE OK" : "\nMCP SMOKE FAILED");
process.exit(exitCode);
