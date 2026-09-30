/**
 * MCP wire-protocol tests for the static tool listing (2.1), and the 3.0 gateway default.
 *
 * These drive a REAL `src/mcp.ts` child over raw stdio JSON-RPC with no SDK client in
 * the loop, so what they assert is the bytes a consumer actually receives — on both
 * protocol eras the server serves (a `server/discover` opening pins the 2026-07-28
 * instance, a plain `initialize` pins the 2025-11-25 one).
 *
 * The listing is computed once per process from MANIFEST × backend capability ×
 * CDP_TOOL_PROFILE, so every expectation below is derived from those same sources
 * rather than from a frozen copy: a tool added to the manifest updates the gate.
 */
import { beforeAll, describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { MANIFEST } from "../src/manifest.ts";
import { toolAvailability } from "../src/capabilities.ts";
import { GATEWAY_TOOLS, GROUP_TOOLS } from "../src/toolGroups.ts";
import { VERSION } from "../src/version.ts";

const SERVER = fileURLToPath(new URL("../src/mcp.ts", import.meta.url));
const MODERN = "2026-07-28";
const LEGACY = "2025-11-25";
/** The per-request envelope a 2026-era client attaches to every request. */
const META = {
  "io.modelcontextprotocol/protocolVersion": MODERN,
  "io.modelcontextprotocol/clientInfo": { name: "cdp-protocol-test", version: "1" },
  "io.modelcontextprotocol/clientCapabilities": {},
};

type Json = Record<string, any>;
interface Outcome {
  /** Replies, in the order the requests were sent (notifications produce none). */
  res: Json[];
  stderr: string;
  code: number | null;
}

/**
 * Drive a server child over raw stdio: one request at a time, replies matched by id.
 * stdout is buffered and split on newlines because a single chunk can carry two frames.
 */
async function runServer(msgs: Json[], overrides: Record<string, string> = {}, waitForExit = false): Promise<Outcome> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v;
  delete env.CDP_TOOL_PROFILE; // never inherit the operator's profile
  Object.assign(env, overrides);
  const child = spawn(process.execPath, [SERVER], { env, stdio: ["pipe", "pipe", "pipe"] });
  const pending = new Map<number, (m: Json) => void>();
  const out: Outcome = { res: [], stderr: "", code: null };
  let buf = "";
  const exited = new Promise<void>((resolve) => child.on("exit", (c) => { out.code = c; resolve(); }));
  child.stdout.on("data", (chunk: Buffer) => {
    buf += chunk.toString();
    for (let nl = buf.indexOf("\n"); nl >= 0; nl = buf.indexOf("\n")) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      const msg = JSON.parse(line) as Json;
      const settle = typeof msg.id === "number" ? pending.get(msg.id) : undefined;
      if (settle) { pending.delete(msg.id as number); settle(msg); }
    }
  });
  child.stderr.on("data", (chunk: Buffer) => { out.stderr += chunk.toString(); });
  try {
    for (const msg of msgs) {
      child.stdin.write(`${JSON.stringify(msg)}\n`);
      if (typeof msg.id !== "number") continue;
      out.res.push(await new Promise<Json>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`no reply to id=${msg.id} (${msg.method}) within 10s; stderr:\n${out.stderr}`)), 10_000);
        pending.set(msg.id as number, (m) => { clearTimeout(timer); resolve(m); });
      }));
    }
    if (waitForExit) {
      await Promise.race([exited, new Promise((_, reject) => setTimeout(() => reject(new Error(`child never exited; stderr:\n${out.stderr}`)), 10_000))]);
    } else {
      await new Promise((r) => setTimeout(r, 60)); // let the stderr era line land before we kill
    }
  } finally {
    child.kill();
  }
  return out;
}

let nextId = 0;
const rpc = (method: string, params: Json = {}): Json => ({ jsonrpc: "2.0", id: ++nextId, method, params });
const modernRpc = (method: string, params: Json = {}): Json => rpc(method, { ...params, _meta: META });
const text = (reply: Json): string => (reply.result.content as Array<{ text?: string }>).map((c) => c.text ?? "").join("");
const names = (reply: Json): string[] => (reply.result.tools as Array<{ name: string }>).map((t) => t.name);

// ---- expectations derived from the same sources the server reads ----
const CHROME = toolAvailability("chrome");
const CHROME_AVAILABLE = new Set<string>(CHROME.available);
/** The two meta-tools, always listed first. describe_tool is still answered but no longer listed. */
const META_TOOLS = ["search_tools", "call_tool"];
/** tools/list under CDP_TOOL_PROFILE=full: the meta-tools, then manifest order. */
const EXPECTED_FULL = [...META_TOOLS, ...MANIFEST.filter((s) => CHROME_AVAILABLE.has(s.name)).map((s) => s.name)];
/** tools/list under the 3.0 default (gateway): the meta-tools, then the 5 gateway tools in manifest order. */
const GATEWAY = new Set<string>(GATEWAY_TOOLS);
const EXPECTED_DEFAULT = EXPECTED_FULL.filter((n) => META_TOOLS.includes(n) || GATEWAY.has(n));
const SPEC = new Map(MANIFEST.map((s) => [s.name, s]));
const json = (reply: Json): Json => JSON.parse(text(reply)) as Json;

/** One modern connection: discover, two listings, and the three describe_tool shapes. */
const modernScenario = () => runServer([
  modernRpc("server/discover"),
  modernRpc("tools/list"),
  modernRpc("tools/list"),
  modernRpc("tools/call", { name: "describe_tool", arguments: { name: "wait_for_download" } }),
  modernRpc("tools/call", { name: "describe_tool", arguments: {} }),
  modernRpc("tools/call", { name: "describe_tool", arguments: { name: "no_such_tool" } }),
  modernRpc("tools/call", { name: "search_tools", arguments: {} }),
  modernRpc("tools/call", { name: "search_tools", arguments: { query: "screenshot" } }),
  modernRpc("tools/call", { name: "search_tools", arguments: { query: "new_page" } }),
  modernRpc("tools/call", { name: "search_tools", arguments: { query: "page", limit: 2 } }),
  modernRpc("tools/call", { name: "search_tools", arguments: { query: "zzzqqq" } }),
]);

/** tools/list names under a given CDP_TOOL_PROFILE, over a modern connection. */
async function listUnder(profile?: string): Promise<string[]> {
  const o = await runServer(
    [modernRpc("server/discover"), modernRpc("tools/list")],
    profile === undefined ? {} : { CDP_TOOL_PROFILE: profile },
  );
  return names(o.res[1]!);
}

describe("modern era (server/discover)", () => {
  let out: Outcome;
  beforeAll(async () => { out = await modernScenario(); });

  test("server/discover advertises 2026-07-28, a fixed tool list, and the serverInfo envelope", () => {
    const r = out.res[0]!.result;
    expect(out.res[0]!.error).toBeUndefined();
    expect(r.supportedVersions).toContain(MODERN);
    expect(r.capabilities.tools.listChanged).toBe(false);
    expect(typeof r.instructions).toBe("string");
    // Claude Code clips server instructions at ~2KB; the pointer to the meta-tools is
    // the load-bearing sentence, so it must survive inside that budget.
    expect(r.instructions.length).toBeLessThanOrEqual(2000);
    expect(r.instructions).toContain("search_tools");
    expect(r.instructions).toContain("call_tool");
    expect(r.resultType).toBe("complete");
    expect(r.ttlMs).toBe(3_600_000);
    expect(r.cacheScope).toBe("public");
    expect(r._meta["io.modelcontextprotocol/serverInfo"]).toEqual({ name: "cdp-toolkit", version: VERSION });
  }, 30_000);

  test("tools/list is complete, cacheable for an hour, and byte-stable across calls", () => {
    const first = out.res[1]!.result;
    const second = out.res[2]!.result;
    expect(first.resultType).toBe("complete");
    expect(first.ttlMs).toBe(3_600_000);
    expect(first.cacheScope).toBe("public");
    expect(names(out.res[1]!)).toEqual(EXPECTED_DEFAULT);
    expect(EXPECTED_DEFAULT.length).toBe(7);
    // The whole point of the 2.1 static listing: the same bytes to every caller, forever.
    expect(JSON.stringify(second.tools)).toBe(JSON.stringify(first.tools));
  }, 30_000);

  test("every wire tool is its manifest entry verbatim, and nothing extra is listed", () => {
    const tools = out.res[1]!.result.tools as Array<{ name: string; description: string; inputSchema: unknown }>;
    let compared = 0;
    for (const t of tools) {
      if (META_TOOLS.includes(t.name)) continue;
      const spec = SPEC.get(t.name);
      expect(spec).toBeDefined();
      expect({ name: t.name, description: t.description, inputSchema: t.inputSchema })
        .toEqual({ name: spec!.name, description: spec!.description, inputSchema: spec!.inputSchema });
      compared += 1;
    }
    expect(compared).toBe(EXPECTED_DEFAULT.length - META_TOOLS.length);
    const known = new Set([...SPEC.keys(), ...META_TOOLS]);
    expect(tools.filter((t) => !known.has(t.name)).map((t) => t.name)).toEqual([]);
  }, 30_000);

  test("describe_tool (unlisted since 3.0) still documents a real tool and refuses an unknown one", () => {
    const ok = out.res[3]!;
    expect(ok.result.isError).toBeFalsy();
    expect(text(ok).startsWith("wait_for_download [group: downloads]")).toBe(true);
    // Control: the same call shape with a name nobody registered must fail, or the
    // assertion above proves only that describe_tool returns text for anything.
    const bad = out.res[5]!;
    expect(bad.result.isError).toBe(true);
    expect(text(bad)).toBe("unknown tool: no_such_tool");
  }, 30_000);

  test("search_tools {} returns the grouped catalog with listed/partly/hidden state", () => {
    const catalog = text(out.res[6]!);
    const lines = catalog.split("\n");
    expect(lines[0]).toBe(
      `cdp-toolkit ${VERSION} · browser=chrome · ${CHROME.available.length} tools available, ${EXPECTED_DEFAULT.length} in tools/list (CDP_TOOL_PROFILE=gateway)`,
    );
    expect(catalog).toContain(`[partly listed] core (${GROUP_TOOLS.core.length}): list_pages, new_page,`);
    expect(catalog).toContain("[hidden] downloads (1): wait_for_download");
    expect(catalog.endsWith("Run any tool with call_tool {name, arguments}; search_tools {query:<name>} returns its docs and inputSchema.")).toBe(true);
    // describe_tool {} is the same catalog, kept for 2.x callers.
    expect(text(out.res[4]!)).toBe(catalog);
  }, 30_000);

  test("search_tools {query} ranks matches and returns each one's manifest inputSchema", () => {
    const hit = json(out.res[7]!);
    expect(hit.matches[0].name).toBe("take_screenshot");
    expect(hit.matches[0].inputSchema).toEqual(SPEC.get("take_screenshot")!.inputSchema);
    expect(hit.matches[0].listed).toBe(false);
    // An exact name returns that one tool only.
    const exact = json(out.res[8]!);
    expect(exact.total).toBe(1);
    expect(exact.matches.map((m: Json) => m.name)).toEqual(["new_page"]);
    // limit caps what is returned, not what matched.
    const broad = json(out.res[9]!);
    expect(broad.matches.length).toBe(2);
    expect(broad.total).toBeGreaterThan(2);
    // Control: a query nothing matches returns no matches, so the hits above are not "everything".
    const none = json(out.res[10]!);
    expect(none.total).toBe(0);
    expect(none.matches).toEqual([]);
  }, 30_000);

  test("stderr names the era the connection was pinned to", () => {
    expect(out.stderr).toContain("pinned to the modern protocol era");
  }, 30_000);
});

describe("legacy era (initialize)", () => {
  let out: Outcome;
  let modernNames: string[];
  beforeAll(async () => {
    out = await runServer([
      rpc("initialize", { protocolVersion: LEGACY, capabilities: {}, clientInfo: { name: "cdp-protocol-test", version: "1" } }),
      { jsonrpc: "2.0", method: "notifications/initialized", params: {} }, // no reply, so res[] is initialize, tools/list, describe_tool
      rpc("tools/list"),
      rpc("tools/call", { name: "describe_tool", arguments: { name: "wait_for_download" } }),
    ]);
    // A second, independent spawn: the two eras must agree on the tool set, and the
    // only way to know that is to ask both rather than to assume one from the other.
    modernNames = await listUnder();
  });

  test("a 2025-era initialize still gets the handshake it expects", () => {
    const r = out.res[0]!.result;
    expect(r.protocolVersion).toBe(LEGACY);
    expect(r.serverInfo.version).toBe(VERSION);
    expect(r.capabilities.tools.listChanged).toBe(false);
    expect(typeof r.instructions).toBe("string");
  }, 30_000);

  test("legacy tools/list carries the same tools, without the modern cache hints", () => {
    expect(names(out.res[1]!)).toEqual(modernNames);
    expect(names(out.res[1]!)).toEqual(EXPECTED_DEFAULT);
    // Documents a real asymmetry: the legacy codec has no cache path, so the hour-long
    // TTL the modern era advertises simply is not on the wire here.
    expect(out.res[1]!.result).not.toHaveProperty("ttlMs");
    expect(out.res[1]!.result).not.toHaveProperty("cacheScope");
  }, 30_000);

  test("describe_tool answers on the legacy era too", () => {
    expect(out.res[2]!.result.isError).toBeFalsy();
    expect(text(out.res[2]!).startsWith("wait_for_download [group: downloads]")).toBe(true);
  }, 30_000);

  test("stderr names the era the connection was pinned to", () => {
    expect(out.stderr).toContain("pinned to the legacy protocol era");
  }, 30_000);
});

test("an unsupported protocol version is refused with the versions the server does speak", async () => {
  const out = await runServer([
    rpc("server/discover", {
      _meta: { ...META, "io.modelcontextprotocol/protocolVersion": "1900-01-01" },
    }),
  ]);
  const err = out.res[0]!.error;
  expect(err).toBeDefined();
  expect(err.code).toBe(-32022);
  expect(err.data.supported).toContain(MODERN);
  expect(err.data.requested).toBe("1900-01-01");
}, 30_000);

describe("CDP_TOOL_PROFILE", () => {
  test("full lists the meta-tools plus every tool the backend can run", async () => {
    expect(await listUnder("full")).toEqual(EXPECTED_FULL);
  }, 30_000);

  test("core lists the meta-tools plus exactly the core group", async () => {
    const listed = await listUnder("core");
    expect(listed.length).toBe(META_TOOLS.length + GROUP_TOOLS.core.length);
    // Order on the wire is manifest order (meta-tools first), NOT GROUP_TOOLS order —
    // the two differ (evaluate_script sits 7th in the manifest, 11th in the group).
    expect(listed).toEqual(EXPECTED_FULL.filter((n) => META_TOOLS.includes(n) || GROUP_TOOLS.core.includes(n)));
    expect([...listed].sort()).toEqual([...META_TOOLS, ...GROUP_TOOLS.core].sort());
  }, 30_000);

  test("a group list adds exactly those groups, in TOOL_GROUPS-canonical label order", async () => {
    expect((await listUnder("core,network,console")).length)
      .toBe(META_TOOLS.length + GROUP_TOOLS.core.length + GROUP_TOOLS.network.length + GROUP_TOOLS.console.length);
    // Spelling-insensitive: whitespace and caller order do not change the result...
    expect((await listUnder("network, core")).length).toBe(META_TOOLS.length + GROUP_TOOLS.core.length + GROUP_TOOLS.network.length);
  }, 60_000);

  test("the catalog reports the canonical profile label and which groups are hidden", async () => {
    const out = await runServer(
      [modernRpc("server/discover"), modernRpc("tools/call", { name: "describe_tool", arguments: {} })],
      { CDP_TOOL_PROFILE: "network, core" },
    );
    const catalog = text(out.res[1]!);
    // ...and the header proves it: the label is TOOL_GROUPS order, not "network,core".
    expect(catalog.split("\n")[0]).toContain("(CDP_TOOL_PROFILE=core,network)");
    expect(catalog).toContain(`[listed] network (${GROUP_TOOLS.network.length}):`);
  }, 30_000);

  test("under core, the hidden groups are marked hidden in the catalog", async () => {
    const out = await runServer(
      [modernRpc("server/discover"), modernRpc("tools/call", { name: "describe_tool", arguments: {} })],
      { CDP_TOOL_PROFILE: "core" },
    );
    expect(text(out.res[1]!)).toContain(`[hidden] network (${GROUP_TOOLS.network.length}):`);
  }, 30_000);

  test("an unknown group name is a startup failure, not a warning", async () => {
    const out = await runServer([], { CDP_TOOL_PROFILE: "bogus" }, true);
    expect(out.code).toBe(1);
    expect(out.stderr).toContain("unknown tool group 'bogus'");
  }, 30_000);

  test("a tool the profile hides is still callable by name", async () => {
    // list_mocks reads in-process mock state only, so it succeeds with NO browser; CDP_BASE
    // is pinned to a closed port so a Chrome on the developer's machine can never mask a
    // regression here (list_leases dials the browser and failed on CI for exactly that reason).
    const out = await runServer(
      [
        modernRpc("server/discover"),
        modernRpc("tools/list"),
        modernRpc("tools/call", { name: "list_mocks", arguments: {} }),
        modernRpc("tools/call", { name: "browser_tools", arguments: {} }),
      ],
      { CDP_TOOL_PROFILE: "core", CDP_BASE: "http://127.0.0.1:1" },
    );
    // Control: it really is absent from THIS connection's listing, so the call below
    // is exercising the unlisted path and not just a tool that was listed anyway.
    expect(names(out.res[1]!)).not.toContain("list_mocks");
    const call = out.res[2]!;
    expect(call.result.isError).toBeFalsy();
    expect(JSON.parse(text(call))).toEqual({ count: 0, mocks: [] });
    // Second control: a name that is neither listed nor exists (the 2.0.0 meta-tool removed
    // in 2.1) is refused as unknown, so "unlisted" is not the same as "any name works".
    const removed = out.res[3]!;
    expect(removed.result.isError).toBe(true);
    expect(text(removed)).toBe("unknown tool: browser_tools");
  }, 30_000);
});

describe("call_tool", () => {
  // list_mocks reads in-process mock state only, so it succeeds with NO browser; CDP_BASE
  // is pinned to a closed port so a Chrome on the developer's machine can never mask a regression.
  let out: Outcome;
  beforeAll(async () => {
    out = await runServer(
      [
        modernRpc("server/discover"),
        modernRpc("tools/list"),
        modernRpc("tools/call", { name: "call_tool", arguments: { name: "list_mocks", arguments: {} } }),
        modernRpc("tools/call", { name: "list_mocks", arguments: {} }),
        modernRpc("tools/call", { name: "call_tool", arguments: { name: "call_tool", arguments: {} } }),
        modernRpc("tools/call", { name: "call_tool", arguments: { name: "search_tools" } }),
        modernRpc("tools/call", { name: "call_tool", arguments: { name: "no_such_tool" } }),
        modernRpc("tools/call", { name: "no_such_tool", arguments: {} }),
        modernRpc("tools/call", { name: "call_tool", arguments: {} }),
        modernRpc("tools/call", { name: "call_tool", arguments: { name: "list_mocks", arguments: [] } }),
      ],
      { CDP_BASE: "http://127.0.0.1:1" },
    );
  });

  test("runs an unlisted tool and returns exactly what a direct call returns", () => {
    expect(names(out.res[1]!)).not.toContain("list_mocks");
    expect(out.res[2]!.result.isError).toBeFalsy();
    expect(JSON.parse(text(out.res[2]!))).toEqual({ count: 0, mocks: [] });
    expect(out.res[2]!.result).toEqual(out.res[3]!.result);
  }, 30_000);

  test("refuses to wrap a meta-tool", () => {
    for (const r of [out.res[4]!, out.res[5]!]) expect(r.result.isError).toBe(true);
    expect(text(out.res[4]!)).toBe("call_tool: 'call_tool' is a meta-tool; call it directly");
    expect(text(out.res[5]!)).toBe("call_tool: 'search_tools' is a meta-tool; call it directly");
  }, 30_000);

  test("an unknown inner name fails exactly like the direct call", () => {
    expect(out.res[6]!.result).toEqual(out.res[7]!.result);
    expect(text(out.res[6]!)).toBe("unknown tool: no_such_tool");
  }, 30_000);

  test("a missing name or non-object arguments is refused before dispatch", () => {
    expect(out.res[8]!.result.isError).toBe(true);
    expect(text(out.res[8]!)).toContain("`name` is required");
    expect(out.res[9]!.result.isError).toBe(true);
    expect(text(out.res[9]!)).toBe("call_tool: `arguments` must be an object");
  }, 30_000);

  test("a tool the backend cannot run reports the same capability gap through call_tool", async () => {
    // dispatch_mouse is Chrome-only; under firefox the availability check fires before any
    // browser is launched, so this needs no Firefox either.
    const ff = await runServer(
      [
        modernRpc("server/discover"),
        modernRpc("tools/call", { name: "call_tool", arguments: { name: "dispatch_mouse", arguments: {} } }),
        modernRpc("tools/call", { name: "dispatch_mouse", arguments: {} }),
      ],
      { CDP_BROWSER: "firefox" },
    );
    expect(ff.res[1]!.result.isError).toBe(true);
    expect(text(ff.res[1]!)).toContain("not available under --browser firefox");
    expect(ff.res[1]!.result).toEqual(ff.res[2]!.result);
  }, 30_000);
});

test("VERSION is the package version", () => {
  const pkg = JSON.parse(readFileSync(fileURLToPath(new URL("../package.json", import.meta.url)), "utf8")) as { version: string };
  expect(VERSION).toBe(pkg.version);
});
