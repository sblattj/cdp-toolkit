#!/usr/bin/env bun
/**
 * cdp-toolkit MCP server (stdio by default, streamable-http on request).
 *
 * Exposes the toolkit's raw-CDP tools to any MCP client (Claude Code, etc.) over
 * the standard stdio transport, or — with `--transport streamable-http` — over
 * an HTTP/SSE listener served by Bun. It does NOT connect to Chrome at startup:
 * each tool call lazily opens a single-target CDP connection (with its own
 * timeout), so the server loads cleanly even when Chrome isn't running;
 * individual calls then fail with a clear error if the browser is unreachable.
 *
 * Importing this module is side-effect-free: the server starts only when the
 * file is the directly executed entry (bin invocation or `bun run src/mcp.ts`),
 * never when imported (see isDirectRun below).
 *
 * Launch: `bunx -y cdp-toolkit`  (or `bun run src/mcp.ts` from a checkout)
 *   HTTP:  `bun run src/mcp.ts --transport streamable-http [--port 3000] [--host 127.0.0.1]`
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
import {
  createMcpHandler,
  hostHeaderValidationResponse,
  localhostAllowedHostnames,
  localhostAllowedOrigins,
  originValidationResponse,
} from "@modelcontextprotocol/server";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { TOOLS, TOOL_NAMES, BASE } from "./index.ts";
import { MANIFEST } from "./manifest.ts";
import { resolveBackend, getOrCreateFirefoxSession, disposeFirefoxSession } from "./backend.ts";
import { disposeBrowserSession } from "./tools/browser-session.ts";
import { toolAvailability } from "./capabilities.ts";
import { FIREFOX_TOOLS } from "./firefox-tools.ts";
import { leaseFromArgs, markLongLivedProcess, withLeaseScope } from "./leases.ts";
import { isListed, resolveProfile, TOOL_GROUP, TOOL_GROUPS, GROUP_TOOLS } from "./toolGroups.ts";
import { TOOL_DOCS } from "./toolDocs.ts";
import { VERSION } from "./version.ts";

// Bun.serve is the HTTP transport's listener: a Bun-only global, typed here (not via bun-types,
// which CONTRACT.md keeps out of the dependency set) in the narrow shape this file uses. The code
// below never touches it unless --transport streamable-http was requested, and checks
// `typeof Bun === "undefined"` first so running under plain node fails with a clear message
// instead of a ReferenceError. The declaration emits nothing — at runtime the identifier resolves
// to the real global when one exists.
declare const Bun: {
  serve(opts: {
    port: number;
    hostname: string;
    fetch(req: Request): Promise<Response> | Response;
  }): { stop(): void; port: number };
};

/**
 * True when this module is the process's entry script — the ONLY condition under which the
 * server starts. Works under both node and bun, ESM included: compare this module's real path
 * with the realpath of argv[1]. realpathSync resolves the bunx/npm bin symlink (argv[1] is the
 * symlink, the module URL is its target) and any /tmp-style symlinked directory; when argv[1] is
 * absent (e.g. `node -e`/REPL importing this file) the answer is simply "not direct". A plain
 * `import(".../mcp.js")` from another module leaves argv[1] pointing at that other entry, so the
 * import stays silent.
 */
function isDirectRun(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return fileURLToPath(import.meta.url) === realpathSync(entry);
  } catch {
    // argv[1] may not exist as a file (eval strings, wrappers); never treat that as direct.
    return false;
  }
}

/** What --transport/--port/--host asked for. stdio is the default and stays byte-for-byte unchanged. */
interface ServeOptions {
  transport: "stdio" | "streamable-http";
  port: number;
  host: string;
}

/**
 * Parse the serving flags from the same argv resolveBackend reads (it scans only --browser and
 * --connect, so these extra tokens were already invisible to it). An unknown --transport value or
 * a non-port --port is a hard configuration error, mirroring resolveBackend's loud failures.
 */
function parseServeOptions(argv: readonly string[]): ServeOptions {
  const out: ServeOptions = { transport: "stdio", port: 3000, host: "127.0.0.1" };
  const transportIdx = argv.indexOf("--transport");
  if (transportIdx !== -1) {
    const value = argv[transportIdx + 1];
    if (value !== "stdio" && value !== "streamable-http") {
      throw new Error(`unknown --transport '${value ?? ""}': expected 'stdio' or 'streamable-http'`);
    }
    out.transport = value;
  }
  const portIdx = argv.indexOf("--port");
  if (portIdx !== -1) {
    const raw = argv[portIdx + 1];
    const port = Number(raw);
    // 0 is valid HERE (unlike backend.ts's dial-out endpoints): for a listener it means "let the
    // OS pick a free port", and the resolved port is then announced on stderr (see run()).
    if (raw === undefined || !/^\d+$/.test(raw) || port < 0 || port > 65_535) {
      throw new Error(`invalid --port '${raw ?? ""}': expected an integer 0-65535`);
    }
    out.port = port;
  }
  const hostIdx = argv.indexOf("--host");
  if (hostIdx !== -1) {
    const raw = argv[hostIdx + 1];
    if (raw === undefined || raw === "") {
      throw new Error(`invalid --host '${raw ?? ""}': expected a hostname or address`);
    }
    out.host = raw;
  }
  return out;
}

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
  "cdp-toolkit drives a real browser over CDP (or Firefox WebDriver-BiDi): pages, input, screenshots, snapshots, console, network, cookies, emulation, Lighthouse, traces, screencasts.",
  "TOOLS: by default only 5 are listed (navigate_page, take_snapshot, click, fill, evaluate_script). ~45 more exist: find one with search_tools {query} (returns its schema; no query = catalog), run it with call_tool {name, arguments}. No tab yet? call_tool {name:'new_page'}. The listing is fixed for the process's life; CDP_TOOL_PROFILE=full lists everything.",
  "TARGET SELECTOR (the `target` param, unless a tool says otherwise): 'active' (default = first page) | 'index:N' (0-based) | 'url:<substr>' | 'title:<substr>' | 'label:<name>' (exact, ledger or live lease) | a 32-hex '<targetId>' of any target type — an iframe id from list_pages{all:true} drives like a tab. Chrome tools also accept 'frame:<substr>' for OOPIF iframe targets. Four Chrome-only tools (evaluate_script, list_network_requests, get_network_request, list_console_messages) also accept 'worker:<substr>' to reach a service/shared worker (e.g. an MV3 background worker); an idle-evicted worker is started first (see `wake`).",
  "LEASES (the `lease` param): claim_page, and new_page{claim:true}, mint an opaque token. Omit it for a tab THIS process already holds. It is required for a tab held by ANOTHER process, or one claimed explicitly. Under CDP_REQUIRE_LEASE the gate auto-acquires a lease for any tab this process drives — no token is surfaced, so pass `target`, not `lease` — while an explicit claim:true still demands its token on every later call.",
  "ORIGIN: list_pages and list_leases tag each tab's `origin` as 'agent' (this toolkit created it) or 'unknown' — never 'human', because the toolkit cannot prove a person opened a tab. An 'agent' tab stays findable after its creator releases the lease or dies.",
].join("\n\n");

// Progressive disclosure, 2.1 model: the tool listing is STATIC — computed once here and
// returned byte-identical to every tools/list on every connection, so a client may cache
// it (the 2026-07-28 revision requires the tool set not to change as a side effect of
// other requests, which is exactly what the 2.0 browser_tools toggle did). Discovery is
// the HOST's job per the MCP client best-practices: the client picks which of the listed
// tools to put in front of the model. CDP_TOOL_PROFILE is the only filter, applied once at
// startup by whoever configures the server. 3.0 defaults it to `gateway` (5 tools) and adds
// two STATIC meta-tools, search_tools (inspect) and call_tool (execute), so a model whose host
// forwards only the listing can still reach every tool — without the listing ever changing.
const PROFILE = startupProfile();

/** Names handled at the MCP layer rather than dispatched to a browser tool. */
const META_TOOLS = new Set(["search_tools", "call_tool", "describe_tool"]);
const SEARCH_DEFAULT_LIMIT = 8;
const SEARCH_MAX_LIMIT = 20;

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
 * the two meta-tools first, then every manifest tool the selected backend can run that
 * the profile advertises. Descriptions here are the compressed one-liners — full prose
 * is served on demand by search_tools.
 *
 * Frozen at runtime (the handler hands the SAME array to every caller); the cast back to
 * a mutable Tool[] is only because ListToolsResult declares `tools` mutable.
 */
const LISTING: Tool[] = Object.freeze([
  {
    name: "search_tools",
    description:
      "Find a cdp-toolkit tool that is not in your tool list (cookies, network, console, screenshots, tabs, emulation, performance, recording, leases, downloads, …). Returns the best matches with full docs and inputSchema; run one with call_tool. With no query, returns the catalog of every tool by group.",
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Keywords or an exact tool name, e.g. 'screenshot', 'network requests', 'new_page'. Omit for the catalog.",
        },
        limit: {
          type: "integer",
          description: `Max matches to return (default ${SEARCH_DEFAULT_LIMIT}, max ${SEARCH_MAX_LIMIT}).`,
        },
      },
      additionalProperties: false,
    } as Tool["inputSchema"],
  },
  {
    name: "call_tool",
    description:
      "Run any cdp-toolkit tool by name, including the ones not in your tool list. Look its arguments up with search_tools first. Behaves exactly like calling the tool directly (same leases, same errors).",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Tool name from search_tools, e.g. new_page." },
        arguments: { type: "object", description: "That tool's arguments, per its inputSchema.", additionalProperties: true },
      },
      required: ["name"],
      additionalProperties: false,
    } as Tool["inputSchema"],
  },
  ...MANIFEST
    .filter((s) => AVAILABLE_NAMES.has(s.name) && isListed(PROFILE, s.name))
    .map((s) => ({ name: s.name, description: s.description, inputSchema: s.inputSchema as Tool["inputSchema"] })),
] satisfies Tool[]) as Tool[];

/** search_tools with no query: every group the backend supports, and what of it is listed. */
function renderCatalog(): string {
  const lines = [
    `cdp-toolkit ${VERSION} · browser=${BROWSER} · ${AVAILABILITY.available.length} tools available, ${LISTING.length} in tools/list (CDP_TOOL_PROFILE=${PROFILE.label})`,
  ];
  for (const g of TOOL_GROUPS) {
    const shown = GROUP_TOOLS[g].filter((n) => AVAILABLE_NAMES.has(n));
    if (!shown.length) continue;
    const listed = shown.filter((n) => isListed(PROFILE, n));
    const state = listed.length === shown.length ? "[listed]" : listed.length === 0 ? "[hidden]" : "[partly listed]";
    lines.push(`${state} ${g} (${shown.length}): ${shown.join(", ")}`);
  }
  lines.push("Run any tool with call_tool {name, arguments}; search_tools {query:<name>} returns its docs and inputSchema.");
  return lines.join("\n");
}

/** Lowercased word tokens: 'list_network_requests' and 'Network requests' both split cleanly. */
function tokenize(text: string): string[] {
  return text.toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length > 1);
}

const MANIFEST_BY_NAME = new Map(MANIFEST.map((s) => [s.name, s]));

/**
 * search_tools with a query: rank the backend's available tools against it. An exact tool
 * name returns just that tool. Otherwise each query token scores against the tool's name
 * (strongest), its group, and its full docs; ties keep manifest order. Capped, because an
 * uncapped broad query would hand back the very 49-schema payload the gateway exists to avoid.
 */
function searchTools(query: string, rawLimit: unknown) {
  const limit = typeof rawLimit === "number" && Number.isInteger(rawLimit) && rawLimit > 0
    ? Math.min(rawLimit, SEARCH_MAX_LIMIT)
    : SEARCH_DEFAULT_LIMIT;
  const q = query.trim().toLowerCase();
  const describe = (name: string) => {
    const spec = MANIFEST_BY_NAME.get(name)!;
    return {
      name,
      group: TOOL_GROUP[name] ?? null,
      listed: isListed(PROFILE, name),
      description: TOOL_DOCS[name]?.description ?? spec.description,
      inputSchema: spec.inputSchema,
    };
  };
  const candidates = MANIFEST.map((s) => s.name).filter((n) => AVAILABLE_NAMES.has(n));
  let ranked: string[];
  if (candidates.includes(q)) {
    ranked = [q];
  } else {
    const tokens = tokenize(q);
    const scored = candidates.map((name, order) => {
      const nameTokens = tokenize(name);
      const group = TOOL_GROUP[name] ?? "";
      const docs = `${MANIFEST_BY_NAME.get(name)!.description} ${TOOL_DOCS[name]?.description ?? ""}`.toLowerCase();
      let score = 0;
      for (const t of tokens) {
        if (nameTokens.includes(t)) score += 5;
        else if (name.includes(t)) score += 3;
        if (group === t || group.includes(t)) score += 2;
        if (docs.includes(t)) score += 1;
      }
      return { name, order, score };
    });
    ranked = scored
      .filter((s) => s.score > 0)
      .sort((a, b) => b.score - a.score || a.order - b.order)
      .map((s) => s.name);
  }
  const unavailable = AVAILABILITY.unavailable.find((u) => u.name === q);
  return {
    query,
    total: ranked.length,
    matches: ranked.slice(0, limit).map(describe),
    ...(unavailable ? { unavailable: `${q} is not available under --browser ${BROWSER} (needs: ${unavailable.missing.join(", ")})` } : {}),
    next: ranked.length ? "Run one with call_tool {name, arguments}." : "No match. Call search_tools with no query for the full catalog.",
  };
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
export function buildServer(): Server {
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

    // The meta-tools are handled at the MCP layer (they read only static docs) and never
    // enter the browser dispatch or a lease scope.
    if (name === "search_tools") {
      const { query, limit } = args as { query?: unknown; limit?: unknown };
      if (typeof query !== "string" || query.trim() === "") {
        return { content: [{ type: "text" as const, text: renderCatalog() }] };
      }
      return { content: [{ type: "text" as const, text: JSON.stringify(searchTools(query, limit), null, 2) }] };
    }

    // describe_tool is the 2.x inspect tool: no longer listed (search_tools {query:<name>}
    // replaces it), still answered so 2.x callers keep working. With a name it documents
    // one tool — listed or not; with no name it returns the grouped catalog.
    if (name === "describe_tool") {
      const requested = (args as { name?: unknown }).name;
      if (typeof requested !== "string" || requested === "") {
        return { content: [{ type: "text" as const, text: renderCatalog() }] };
      }
      const known = Boolean(TOOL_DOCS[requested]);
      return { content: [{ type: "text" as const, text: renderToolDoc(requested) }], isError: !known };
    }

    // call_tool unwraps to the inner tool and re-enters the SAME dispatch below, so the
    // availability check, the lease scope (read off the INNER arguments) and the error
    // shapes are identical to calling the tool directly. It exists because a model can
    // only invoke tools its host put in front of it — an unlisted tool is callable by name
    // over the wire, but not by a model whose host only forwards tools/list.
    if (name === "call_tool") {
      const inner = args as { name?: unknown; arguments?: unknown };
      if (typeof inner.name !== "string" || inner.name === "") {
        return { content: [{ type: "text" as const, text: "call_tool: `name` is required (find one with search_tools)" }], isError: true };
      }
      if (META_TOOLS.has(inner.name)) {
        return { content: [{ type: "text" as const, text: `call_tool: '${inner.name}' is a meta-tool; call it directly` }], isError: true };
      }
      const innerArgs = inner.arguments ?? {};
      if (typeof innerArgs !== "object" || Array.isArray(innerArgs)) {
        return { content: [{ type: "text" as const, text: "call_tool: `arguments` must be an object" }], isError: true };
      }
      return runTool(inner.name, innerArgs);
    }

    return runTool(name, args);
  });

  return server;
}

/** Dispatch one browser tool by name: the path both a direct call and call_tool take. */
async function runTool(name: string, args: unknown) {
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
}

/**
 * Start serving: stdio (the default) or the streamable-http listener. Only ever called from the
 * isDirectRun guard below — importing this module must stay silent.
 */
async function run(argv: string[]): Promise<void> {
  const serve = parseServeOptions(argv);
  auditCoverage();
  // This process is the long-lived MCP server, which is what makes strict mode
  // (CDP_REQUIRE_LEASE) safe to honor here and unsafe in cli.ts. See requireLease.
  markLongLivedProcess();

  // Per-transport state the shutdown path closes (only one is ever set).
  let stdioHandle: Awaited<ReturnType<typeof serveStdio>> | undefined;
  let httpHandler: ReturnType<typeof createMcpHandler> | undefined;
  let listener: { stop(): void; port: number } | undefined;

  // LAUNCH-mode Firefox owns a real OS process (see bidi/launch.ts): it must be reaped on every
  // shutdown path, not just a clean exit. ATTACH-mode Firefox (CDP_FIREFOX_ENDPOINT / --connect)
  // owns no process here — disposeFirefoxSession() below only ends its BiDi session (freeing
  // Firefox's single session slot) and closes the socket, leaving the user's browser running.
  // SIGINT/SIGTERM cover ctrl-C and a supervising client killing the server; in stdio mode the
  // stdin 'close' event covers the normal MCP shutdown (the client closes the pipe). All are
  // idempotent through disposeFirefoxSession(), and a no-op entirely when Firefox was never
  // launched/attached.
  let shuttingDown = false;
  async function shutdown(): Promise<void> {
    if (shuttingDown) return;
    shuttingDown = true;
    await disposeFirefoxSession();
    // The standing browser-endpoint connection behind wait_for_download / grant_permissions (1.8.0
    // Track P3). Unlike Firefox it owns no OS process, so process.exit would collect it anyway; it is
    // closed explicitly so shutdown does not depend on that, and is a no-op when neither tool ran.
    await disposeBrowserSession();
    // Close the active transport last, so a tool call still in flight over it cannot outlive the
    // browser resources it was driving. For http this also stops accepting new connections.
    if (stdioHandle) await stdioHandle.close().catch(() => undefined);
    if (httpHandler) await httpHandler.close().catch(() => undefined);
    if (listener) listener.stop();
    process.exit(0);
  }
  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());

  if (serve.transport === "stdio") {
    // serveStdio owns the era decision for the connection: a modern opening (server/discover
    // with the per-request _meta envelope) pins a 2026-07-28 instance, a 2025-era `initialize`
    // pins a legacy one. legacy:'serve' (the default) is deliberate — 2025-era clients keep the
    // initialize handshake they expect, so this upgrade is invisible to them.
    stdioHandle = serveStdio(
      ({ era }) => {
        console.error(`[cdp-toolkit] connection pinned to the ${era} protocol era`);
        return buildServer();
      },
      { onerror: (err) => console.error(`[cdp-toolkit] stdio: ${err.message}`) },
    );
    process.stdin.on("close", () => void shutdown());
    console.error(
      `[cdp-toolkit] MCP server v${VERSION} ready, browser=${BROWSER}${FIREFOX_ENDPOINT ? ` (attach ${FIREFOX_ENDPOINT})` : ""}, ${AVAILABILITY.available.length} tools available, ${LISTING.length} listed (CDP_TOOL_PROFILE=${PROFILE.label}), CDP_BASE=${BASE}`,
    );
    return;
  }

  // streamable-http: Bun.serve + the SDK's web-standard handler. DNS-rebinding protection comes
  // from the SDK's host/origin validators composed in front (each returns an error Response for a
  // disallowed request, undefined to fall through); the localhost allowlists match the default
  // loopback bind. Everything diagnostic goes to stderr — stdout stays the stdio JSON-RPC channel
  // only, and even here it must carry nothing (an http client never reads it).
  if (typeof Bun === "undefined") {
    console.error(
      "[cdp-toolkit] --transport streamable-http needs Bun's HTTP listener (Bun.serve). Re-run with bun, or use the default stdio transport.",
    );
    process.exit(1);
  }
  httpHandler = createMcpHandler(
    ({ era }) => {
      console.error(`[cdp-toolkit] connection pinned to the ${era} protocol era`);
      return buildServer();
    },
    { onerror: (err) => console.error(`[cdp-toolkit] http: ${err.message}`) },
  );
  listener = Bun.serve({
    port: serve.port,
    hostname: serve.host,
    fetch: (req) =>
      hostHeaderValidationResponse(req, localhostAllowedHostnames()) ??
      originValidationResponse(req, localhostAllowedOrigins()) ??
      httpHandler!.fetch(req),
  });
  // The resolved port is announced as a bare `port N` token BEFORE the URL text, so a stderr
  // scanner finds the real listening port first (matters under --port 0, where N is the
  // OS-assigned one and the only place it is knowable).
  console.error(
    `[cdp-toolkit] MCP server v${VERSION} listening on streamable-http port ${listener.port} (http://${serve.host}:${listener.port}/), browser=${BROWSER}${FIREFOX_ENDPOINT ? ` (attach ${FIREFOX_ENDPOINT})` : ""}, ${AVAILABILITY.available.length} tools available, ${LISTING.length} listed (CDP_TOOL_PROFILE=${PROFILE.label}), CDP_BASE=${BASE}`,
  );
}

if (isDirectRun()) {
  run(process.argv.slice(2)).catch((err: unknown) => {
    console.error(`[cdp-toolkit] ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  });
}
