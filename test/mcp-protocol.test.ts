/**
 * MCP wire-protocol tests for the 2.1 static tool listing.
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
import { GROUP_TOOLS } from "../src/toolGroups.ts";
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
/** tools/list under the default (full) profile: describe_tool, then manifest order. */
const EXPECTED_FULL = ["describe_tool", ...MANIFEST.filter((s) => CHROME_AVAILABLE.has(s.name)).map((s) => s.name)];
const SPEC = new Map(MANIFEST.map((s) => [s.name, s]));

/** One modern connection: discover, two listings, and the three describe_tool shapes. */
const modernScenario = () => runServer([
  modernRpc("server/discover"),
  modernRpc("tools/list"),
  modernRpc("tools/list"),
  modernRpc("tools/call", { name: "describe_tool", arguments: { name: "wait_for_download" } }),
  modernRpc("tools/call", { name: "describe_tool", arguments: {} }),
  modernRpc("tools/call", { name: "describe_tool", arguments: { name: "no_such_tool" } }),
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
    // Claude Code clips server instructions at ~2KB; the pointer to describe_tool is
    // the load-bearing sentence, so it must survive inside that budget.
    expect(r.instructions.length).toBeLessThanOrEqual(2000);
    expect(r.instructions).toContain("describe_tool");
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
    expect(names(out.res[1]!)).toEqual(EXPECTED_FULL);
    // The whole point of the 2.1 static listing: the same bytes to every caller, forever.
    expect(JSON.stringify(second.tools)).toBe(JSON.stringify(first.tools));
  }, 30_000);

  test("every wire tool is its manifest entry verbatim, and nothing extra is listed", () => {
    const tools = out.res[1]!.result.tools as Array<{ name: string; description: string; inputSchema: unknown }>;
    let compared = 0;
    for (const t of tools) {
      if (t.name === "describe_tool") continue;
      const spec = SPEC.get(t.name);
      expect(spec).toBeDefined();
      expect({ name: t.name, description: t.description, inputSchema: t.inputSchema })
        .toEqual({ name: spec!.name, description: spec!.description, inputSchema: spec!.inputSchema });
      compared += 1;
    }
    expect(compared).toBe(EXPECTED_FULL.length - 1);
    const known = new Set([...SPEC.keys(), "describe_tool"]);
    expect(tools.filter((t) => !known.has(t.name)).map((t) => t.name)).toEqual([]);
  }, 30_000);

  test("describe_tool {name} documents a real tool and refuses an unknown one", () => {
    const ok = out.res[3]!;
    expect(ok.result.isError).toBeFalsy();
    expect(text(ok).startsWith("wait_for_download [group: downloads]")).toBe(true);
    // Control: the same call shape with a name nobody registered must fail, or the
    // assertion above proves only that describe_tool returns text for anything.
    const bad = out.res[5]!;
    expect(bad.result.isError).toBe(true);
    expect(text(bad)).toBe("unknown tool: no_such_tool");
  }, 30_000);

  test("describe_tool {} returns the grouped catalog with listed/hidden state", () => {
    const catalog = text(out.res[4]!);
    const lines = catalog.split("\n");
    expect(lines[0]).toBe(
      `cdp-toolkit ${VERSION} · browser=chrome · ${CHROME.available.length} tools available, ${EXPECTED_FULL.length} in tools/list (CDP_TOOL_PROFILE=full)`,
    );
    expect(catalog).toContain(`[listed] core (${GROUP_TOOLS.core.length}): list_pages, new_page,`);
    expect(catalog).toContain("[listed] downloads (1): wait_for_download");
    expect(catalog.endsWith("Unlisted tools are callable by name; describe_tool {name} documents any of them.")).toBe(true);
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
    expect(names(out.res[1]!)).toEqual(EXPECTED_FULL);
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
  test("core lists describe_tool plus exactly the core group", async () => {
    const listed = await listUnder("core");
    expect(listed.length).toBe(1 + GROUP_TOOLS.core.length);
    // Order on the wire is manifest order (describe_tool first), NOT GROUP_TOOLS order —
    // the two differ (evaluate_script sits 7th in the manifest, 11th in the group).
    expect(listed).toEqual(EXPECTED_FULL.filter((n) => n === "describe_tool" || GROUP_TOOLS.core.includes(n)));
    expect([...listed].sort()).toEqual(["describe_tool", ...GROUP_TOOLS.core].sort());
  }, 30_000);

  test("a group list adds exactly those groups, in TOOL_GROUPS-canonical label order", async () => {
    expect((await listUnder("core,network,console")).length)
      .toBe(1 + GROUP_TOOLS.core.length + GROUP_TOOLS.network.length + GROUP_TOOLS.console.length);
    // Spelling-insensitive: whitespace and caller order do not change the result...
    expect((await listUnder("network, core")).length).toBe(1 + GROUP_TOOLS.core.length + GROUP_TOOLS.network.length);
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
    const out = await runServer(
      [modernRpc("server/discover"), modernRpc("tools/list"), modernRpc("tools/call", { name: "list_leases", arguments: {} })],
      { CDP_TOOL_PROFILE: "core" },
    );
    // Control: it really is absent from THIS connection's listing, so the call below
    // is exercising the unlisted path and not just a tool that was listed anyway.
    expect(names(out.res[1]!)).not.toContain("list_leases");
    const call = out.res[2]!;
    expect(call.result.isError).toBeFalsy();
    expect(() => JSON.parse(text(call))).not.toThrow();
  }, 30_000);
});

test("VERSION is the package version", () => {
  const pkg = JSON.parse(readFileSync(fileURLToPath(new URL("../package.json", import.meta.url)), "utf8")) as { version: string };
  expect(VERSION).toBe(pkg.version);
});
