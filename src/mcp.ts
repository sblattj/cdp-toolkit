#!/usr/bin/env bun
/**
 * cdp-toolkit MCP server (stdio).
 *
 * Exposes the toolkit's raw-CDP tools to any MCP client (Claude Code, etc.) over
 * the standard stdio transport. It does NOT connect to Chrome at startup: each
 * tool call lazily opens a single-target CDP connection (with its own timeout),
 * so the server loads cleanly even when Chrome isn't running; individual calls
 * then fail with a clear error if the browser is unreachable.
 *
 * Launch: `bunx -y cdp-toolkit`  (or `bun run src/mcp.ts` from a checkout)
 * Config:  CDP_BASE (default http://127.0.0.1:9222), CDP_TIMEOUT_MS, CDP_ARTIFACT_DIR,
 *          CDP_FIREFOX_ENDPOINT (attach to a user-launched Firefox instead of spawning one;
 *          see backend.ts's ATTACH mode).
 *
 * stdout is the JSON-RPC channel, all diagnostics go to stderr only.
 */
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { TOOLS, TOOL_NAMES, BASE } from "./index.ts";
import { MANIFEST } from "./manifest.ts";
import { resolveBackend, getOrCreateFirefoxSession, disposeFirefoxSession } from "./backend.ts";
import { disposeBrowserSession } from "./tools/browser-session.ts";
import { toolAvailability } from "./capabilities.ts";
import { FIREFOX_TOOLS } from "./firefox-tools.ts";
import { leaseFromArgs, markLongLivedProcess, withLeaseScope } from "./leases.ts";

const VERSION = "1.9.4";

// Backend + (Firefox only) attach endpoint are read once at startup (MCP has no per-call notion
// of backend): --browser flag / CDP_BROWSER env, else "chrome" (zero behavior change for existing
// users/configs); --connect flag / CDP_FIREFOX_ENDPOINT env selects Firefox ATTACH mode and
// implies browser=firefox (resolveBackend, backend.ts).
const { kind: BROWSER, endpoint: FIREFOX_ENDPOINT } = resolveBackend(process.argv.slice(2));
const AVAILABILITY = toolAvailability(BROWSER);
const AVAILABLE_NAMES = new Set<string>(AVAILABILITY.available);

/** Loose dispatch view of the strongly-typed TOOLS registry. */
const dispatch = TOOLS as Record<string, (args: unknown) => Promise<unknown>>;
const neutralDispatch = FIREFOX_TOOLS as Record<string, (driver: import("./driver.ts").BrowserDriver, args: unknown) => Promise<unknown>>;

/** Warn (to stderr) about any registry/manifest drift, but don't fail startup. */
function auditCoverage(): void {
  const manifestNames = new Set(MANIFEST.map((s) => s.name));
  const registryNames = new Set<string>(TOOL_NAMES);
  const missingSchema = [...registryNames].filter((n) => !manifestNames.has(n));
  const orphanSchema = [...manifestNames].filter((n) => !registryNames.has(n));
  if (missingSchema.length) console.error(`[cdp-toolkit] WARN: tools without a manifest schema: ${missingSchema.join(", ")}`);
  if (orphanSchema.length) console.error(`[cdp-toolkit] WARN: manifest schemas with no registered tool: ${orphanSchema.join(", ")}`);
}

const server = new Server({ name: "cdp-toolkit", version: VERSION }, { capabilities: { tools: {} } });

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  // Filtered to whatever the selected backend can actually run, per REQUIRED_CAPABILITIES:
  // under Chrome this is byte-identical to the unfiltered MANIFEST (every capability CDP needs
  // is declared); under Firefox the performance/heap/lighthouse tools are simply absent.
  tools: MANIFEST.filter((s) => AVAILABLE_NAMES.has(s.name)).map((s) => ({ name: s.name, description: s.description, inputSchema: s.inputSchema })),
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name } = request.params;
  const args = (request.params.arguments ?? {}) as unknown;

  if (!AVAILABLE_NAMES.has(name)) {
    const gap = AVAILABILITY.unavailable.find((u) => u.name === name);
    return {
      content: [{ type: "text" as const, text: `unknown tool: ${name}${gap ? ` (not available under --browser ${BROWSER}, needs: ${gap.missing.join(", ")})` : ""}` }],
      isError: true,
    };
  }

  // ONE lease scope per dispatch, wrapping BOTH backend branches. This is the
  // reason no tool takes a lease parameter: the token rides the async context
  // down to whichever resolution path the tool eventually reaches, so a tool
  // added tomorrow is covered with no action from whoever writes it. Reading
  // 'lease' off args here is the only place the MCP layer knows the key exists.
  return withLeaseScope(leaseFromArgs(args), async () => {
    if (BROWSER === "chrome") {
      const fn = dispatch[name];
      if (!fn) return { content: [{ type: "text" as const, text: `unknown tool: ${name}` }], isError: true };
      try {
        const result = await fn(args);
        return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return { content: [{ type: "text" as const, text: `Error: ${message}` }], isError: true };
      }
    }

    // Firefox: one BiDi session memoized for the life of this server process (lifetime "session",
    // ADR-001); launched lazily on the first Firefox tool call, torn down on shutdown below.
    const neutralFn = neutralDispatch[name];
    if (!neutralFn) return { content: [{ type: "text" as const, text: `unknown tool: ${name}` }], isError: true };
    try {
      const session = await getOrCreateFirefoxSession({ endpoint: FIREFOX_ENDPOINT });
      const result = await neutralFn(session.driver, args);
      return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { content: [{ type: "text" as const, text: `Error: ${message}` }], isError: true };
    }
  });
});

auditCoverage();
// This process is the long-lived MCP server, which is what makes strict mode
// (CDP_REQUIRE_LEASE) safe to honor here and unsafe in cli.ts. See requireLease.
markLongLivedProcess();
await server.connect(new StdioServerTransport());
console.error(
  `[cdp-toolkit] MCP server v${VERSION} ready, browser=${BROWSER}${FIREFOX_ENDPOINT ? ` (attach ${FIREFOX_ENDPOINT})` : ""}, ${AVAILABILITY.available.length} tools, CDP_BASE=${BASE}`,
);

// LAUNCH-mode Firefox owns a real OS process (see bidi/launch.ts): it must be reaped on every
// shutdown path, not just a clean exit. ATTACH-mode Firefox (CDP_FIREFOX_ENDPOINT / --connect)
// owns no process here — disposeFirefoxSession() below only ends its BiDi session (freeing
// Firefox's single session slot) and closes the socket, leaving the user's browser running.
// SIGINT/SIGTERM cover ctrl-C and a supervising client killing the server; stdin 'close' covers
// the normal MCP shutdown (the client closes the stdio pipe). All three are idempotent through
// disposeFirefoxSession(), and a no-op entirely when Firefox was never launched/attached.
let shuttingDown = false;
async function shutdown(): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  await disposeFirefoxSession();
  // The standing browser-endpoint connection behind wait_for_download / grant_permissions (1.8.0
  // Track P3). Unlike Firefox it owns no OS process, so process.exit would collect it anyway; it is
  // closed explicitly so shutdown does not depend on that, and is a no-op when neither tool ran.
  await disposeBrowserSession();
  process.exit(0);
}
process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());
process.stdin.on("close", () => void shutdown());
