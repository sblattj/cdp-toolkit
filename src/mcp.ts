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
 *          CDP_TOOL_PROFILE (`full` — the default — advertises every group; `core` advertises
 *          just the 12 everyday tools; or a comma-separated group list, e.g. `core,network`.
 *          Startup-only filter on what tools/list shows; unlisted tools stay callable by name),
 *          CDP_FIREFOX_ENDPOINT (attach to a user-launched Firefox instead of spawning one;
 *          see backend.ts's ATTACH mode).
 *
 * stdout is the JSON-RPC channel, all diagnostics go to stderr only.
 */
import { Server } from "@modelcontextprotocol/server";
import type { Tool } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { TOOLS, TOOL_NAMES, BASE } from "./index.ts";
import { MANIFEST } from "./manifest.ts";
import { resolveBackend, getOrCreateFirefoxSession, disposeFirefoxSession } from "./backend.ts";
import { disposeBrowserSession } from "./tools/browser-session.ts";
import { toolAvailability } from "./capabilities.ts";
import { FIREFOX_TOOLS } from "./firefox-tools.ts";
import { leaseFromArgs, markLongLivedProcess, withLeaseScope } from "./leases.ts";
import { resolveProfile, TOOL_GROUP, TOOL_GROUPS, GROUP_TOOLS } from "./toolGroups.ts";
import { TOOL_DOCS } from "./toolDocs.ts";
import { VERSION } from "./version.ts";

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

// Server `instructions` (returned by server/discover on 2026-era connections, and by
// initialize on 2025-era ones): the cross-cutting conventions that used to be re-stated
// inside every tool's schema — the target-selector grammar, the lease-token model, the
// MV3 worker/wake arm, the origin vocabulary — plus how to read the (fixed, cacheable)
// tool listing. Stating them ONCE here is what let the per-tool descriptions and the
// 42-way-duplicated `lease` param collapse to short pointers, cutting the tools/list
// payload without losing a single behavior. Kept under Claude Code's 2KB instructions
// cap and front-loaded (grammar + leases before origin) so nothing critical is clipped.
const INSTRUCTIONS = [
  "cdp-toolkit drives a real browser over Chrome DevTools Protocol (or Firefox WebDriver-BiDi): open and drive pages, click/fill/type, screenshot and accessibility-snapshot, read console + network, set cookies, emulate devices, run Lighthouse and performance traces, record screencasts. Conventions shared across its tools:",
  "TOOL AVAILABILITY: tools/list is complete and fixed for this process's life — cache it. Its one-liners are not the full docs: call describe_tool {name} on an unfamiliar tool, or describe_tool {} for the grouped catalog. CDP_TOOL_PROFILE=core (or a group list) lists only those groups; unlisted tools stay callable by name.",
  "TARGET SELECTOR (the `target` param, unless a tool says otherwise): 'active' (default = first page) | 'index:N' (0-based) | 'url:<substr>' | 'title:<substr>' | 'label:<name>' (exact, from the origin ledger or a live lease) | a 32-hex '<targetId>'. Four Chrome-only tools (evaluate_script, list_network_requests, get_network_request, list_console_messages) also accept 'worker:<substr>' to reach a service/shared worker — e.g. an MV3 extension's background worker (worker:<extension-id> or worker:background.js); an idle-evicted worker is started first (see each tool's `wake`).",
  "LEASES (the `lease` param): claim_page, and new_page{claim:true}, mint an opaque token. Omit it for a tab THIS process already holds. It is required for a tab held by ANOTHER process, or one claimed explicitly. Under CDP_REQUIRE_LEASE the gate auto-acquires a lease for any tab this process drives — no token is surfaced, so pass `target`, not `lease` — while an explicit claim:true still demands its token on every later call. Without CDP_REQUIRE_LEASE an unleased tab needs no token at all.",
  "ORIGIN: list_pages and list_leases tag each tab's `origin` as 'agent' (this toolkit created it) or 'unknown' — never 'human', because the toolkit cannot prove a person opened a tab. An 'agent' tab stays findable after its creator releases the lease or dies.",
].join("\n\n");

// Progressive disclosure, 2.1 model: the tool listing is STATIC — computed once here and
// returned byte-identical to every tools/list on every connection, so a client may cache
// it (the 2026-07-28 revision requires the tool set not to change as a side effect of
// other requests, which is exactly what the 2.0 browser_tools toggle did). Discovery is
// the HOST's job per the MCP client best-practices: the client picks which of the listed
// tools to put in front of the model. `describe_tool` is the inspect layer — one call
// returns the full prose for any tool, listed or not — and CDP_TOOL_PROFILE is the only
// filter, applied once at startup by whoever configures the server. A tool that the
// profile hides is still callable by name; hiding only trims the listing's token cost.
const PROFILE = startupProfile();

/** Read CDP_TOOL_PROFILE once; an unknown group name is a configuration error, not a warning. */
function startupProfile() {
  try {
    return resolveProfile(process.env.CDP_TOOL_PROFILE);
  } catch (err) {
    console.error(`[cdp-toolkit] ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
}

/**
 * The one and only tools/list payload, in manifest order (a stable order is a spec
 * SHOULD, and it keeps the response byte-identical across calls so caching is real):
 * describe_tool first, then every manifest tool the selected backend can run whose
 * group the profile advertises. Descriptions here are the compressed one-liners —
 * full prose is served on demand by describe_tool.
 *
 * Frozen at runtime (the handler hands the SAME array to every caller); the cast back to
 * a mutable Tool[] is only because ListToolsResult declares `tools` mutable.
 */
const LISTING: Tool[] = Object.freeze([
  {
    name: "describe_tool",
    description:
      "Full description and per-parameter docs for any cdp-toolkit tool by name, including tools not in tools/list (unlisted tools stay callable by name). Call it before using an unfamiliar tool: the live tools/list carries only terse one-liners. With no name it returns the grouped catalog of every tool the selected browser supports.",
    inputSchema: {
      type: "object",
      properties: {
        name: {
          type: "string",
          description: "Tool name, e.g. take_screenshot. Omit it to get the catalog: every group, its tool names, and whether the group is in tools/list.",
        },
      },
      additionalProperties: false,
    } as Tool["inputSchema"],
  },
  ...MANIFEST
    .filter((s) => AVAILABLE_NAMES.has(s.name) && PROFILE.groups.has(TOOL_GROUP[s.name]!))
    .map((s) => ({ name: s.name, description: s.description, inputSchema: s.inputSchema as Tool["inputSchema"] })),
] satisfies Tool[]) as Tool[];

/** describe_tool with no name: every group the backend supports, and whether it is listed. */
function renderCatalog(): string {
  const lines = [
    `cdp-toolkit ${VERSION} · browser=${BROWSER} · ${AVAILABILITY.available.length} tools available, ${LISTING.length} in tools/list (CDP_TOOL_PROFILE=${PROFILE.label})`,
  ];
  for (const g of TOOL_GROUPS) {
    const shown = GROUP_TOOLS[g].filter((n) => AVAILABLE_NAMES.has(n));
    if (!shown.length) continue;
    lines.push(`${PROFILE.groups.has(g) ? "[listed]" : "[hidden]"} ${g} (${shown.length}): ${shown.join(", ")}`);
  }
  lines.push("Unlisted tools are callable by name; describe_tool {name} documents any of them.");
  return lines.join("\n");
}

/** describe_tool body: full prose for one tool from the on-demand docs map. */
function renderToolDoc(toolName: string): string {
  const doc = TOOL_DOCS[toolName];
  if (!doc) return `unknown tool: ${toolName}`;
  const group = TOOL_GROUP[toolName];
  const params = Object.entries(doc.params);
  const body = params.length ? params.map(([p, d]) => `- ${p}: ${d || "(no description)"}`).join("\n") : "(no parameters)";
  return `${toolName}${group ? ` [group: ${group}]` : ""}\n\n${doc.description}\n\nParameters:\n${body}`;
}

// The listing never changes, and it is identical for every caller (a stdio server has no
// per-caller auth), so it is `public` with a 1h TTL rather than the SDK's conservative
// { ttlMs: 0, cacheScope: 'private' } default. A restart under a different CDP_TOOL_PROFILE
// or --browser is a different server configuration, not a mid-life change to this one.
const LIST_CACHE_HINT = { ttlMs: 3_600_000, cacheScope: "public" } as const;

/**
 * Build one server instance. serveStdio calls this per connection — and possibly twice
 * per process (a server/discover probe instance that is discarded if the client falls
 * back to initialize) — so it must be PURE: no I/O, no shared mutable state.
 *
 * We stay on the low-level `Server` rather than `McpServer` deliberately, despite the
 * deprecation note. McpServer.registerTool wants a Standard-Schema (zod) object for
 * inputSchema, and CONTRACT.md rule 1 forbids any runtime dependency beyond the SDK;
 * our manifest is plain JSON Schema (src/manifest.ts). McpServer also cannot express
 * "hidden tools remain callable by name", which is the whole point of CDP_TOOL_PROFILE.
 */
function buildServer(): Server {
  const server = new Server(
    { name: "cdp-toolkit", version: VERSION },
    {
      // The list is fixed for the life of the process; nothing will ever notify.
      capabilities: { tools: { listChanged: false } },
      instructions: INSTRUCTIONS,
      cacheHints: { "tools/list": LIST_CACHE_HINT, "server/discover": LIST_CACHE_HINT },
    },
  );

  server.setRequestHandler('tools/list', async () => ({ tools: LISTING }));

  server.setRequestHandler('tools/call', async (request) => {
    const { name } = request.params;
    const args = (request.params.arguments ?? {}) as unknown;

    // describe_tool is handled at the MCP layer (it reads only static docs) and never
    // enters the browser dispatch or a lease scope. With a name it documents one tool —
    // listed or not; with no name it returns the grouped catalog.
    if (name === "describe_tool") {
      const requested = (args as { name?: unknown }).name;
      if (typeof requested !== "string" || requested === "") {
        return { content: [{ type: "text" as const, text: renderCatalog() }] };
      }
      const known = Boolean(TOOL_DOCS[requested]);
      return { content: [{ type: "text" as const, text: renderToolDoc(requested) }], isError: !known };
    }

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

  return server;
}

auditCoverage();
// This process is the long-lived MCP server, which is what makes strict mode
// (CDP_REQUIRE_LEASE) safe to honor here and unsafe in cli.ts. See requireLease.
markLongLivedProcess();

// serveStdio owns the era decision for the connection: a modern opening (server/discover
// with the per-request _meta envelope) pins a 2026-07-28 instance, a 2025-era `initialize`
// pins a legacy one. legacy:'serve' (the default) is deliberate — 2025-era clients keep the
// initialize handshake they expect, so this upgrade is invisible to them.
const handle = serveStdio(
  ({ era }) => {
    console.error(`[cdp-toolkit] connection pinned to the ${era} protocol era`);
    return buildServer();
  },
  { onerror: (err) => console.error(`[cdp-toolkit] stdio: ${err.message}`) },
);
console.error(
  `[cdp-toolkit] MCP server v${VERSION} ready, browser=${BROWSER}${FIREFOX_ENDPOINT ? ` (attach ${FIREFOX_ENDPOINT})` : ""}, ${AVAILABILITY.available.length} tools available, ${LISTING.length} listed (CDP_TOOL_PROFILE=${PROFILE.label}), CDP_BASE=${BASE}`,
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
  // Close the stdio connection (pinned instance + transport) last, so a tool call still
  // in flight over it cannot outlive the browser resources it was driving.
  await handle.close().catch(() => undefined);
  process.exit(0);
}
process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());
process.stdin.on("close", () => void shutdown());
