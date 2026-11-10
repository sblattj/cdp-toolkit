/**
 * Issue #15 acceptance, end to end: the REAL src/mcp.ts (and src/cli.ts) as a subprocess, pointed
 * at RECORDING fake CDP endpoints (test/helpers/fake-cdp-server.ts), so "sends no CDP message" is
 * an observation of the wire, not of a mock. The recorder is known to see clicks: every refusal
 * below is paired with a positive control that drives the same tool against a writable fake and
 * asserts the traffic DID arrive.
 *
 * Hermetic: every inherited CDP_* variable is dropped from the child env, and the default endpoint
 * is always pinned to a fake, so nothing here can reach a real browser on 9222.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { FakeCdpServer } from "./helpers/fake-cdp-server.ts";
import { getEndpoint, resetEndpointCache, withEndpointScope } from "../src/endpoints.ts";
import { chromeLeaseBackend, claimLease, mintToken } from "../src/leases.ts";
import { recordOrigin } from "../src/origins.ts";
import { READ_TOOLS } from "../src/policy.ts";

const SERVER = fileURLToPath(new URL("../src/mcp.ts", import.meta.url));
const CLI = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
const DEAD = "http://127.0.0.1:1";
const META = {
  "io.modelcontextprotocol/protocolVersion": "2026-07-28",
  "io.modelcontextprotocol/clientInfo": { name: "endpoints-acceptance", version: "1" },
  "io.modelcontextprotocol/clientCapabilities": {},
};

type Json = Record<string, any>;

/** The Teams desktop shape: an empty host page plus the real chat page (see the issue's notes). */
const TEAMS_TARGETS = [
  { id: "HOST1", type: "page", title: "", url: "https://teams.fake/host" },
  { id: "CHAT1", type: "page", title: "Chat | Microsoft Teams", url: "https://teams.fake/chat" },
];

const scratch = mkdtempSync(join(tmpdir(), "cdp-acceptance-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

/** A child env with NO inherited CDP_* setting, then exactly `vars`. */
function childEnv(vars: Record<string, string>): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !k.startsWith("CDP_")) env[k] = v;
  return Object.assign(env, vars);
}

/** An interactive stdio MCP client over a real src/mcp.ts child: one request at a time, by id. */
class McpChild {
  stderr = "";
  private buf = "";
  private nextId = 0;
  private readonly pending = new Map<number, (m: Json) => void>();
  private readonly child: ChildProcess;

  constructor(vars: Record<string, string>) {
    this.child = spawn(process.execPath, [SERVER], { env: childEnv(vars), stdio: ["pipe", "pipe", "pipe"] });
    this.child.stdout!.on("data", (chunk: Buffer) => {
      this.buf += chunk.toString();
      for (let nl = this.buf.indexOf("\n"); nl >= 0; nl = this.buf.indexOf("\n")) {
        const line = this.buf.slice(0, nl).trim();
        this.buf = this.buf.slice(nl + 1);
        if (!line) continue;
        const msg = JSON.parse(line) as Json;
        const settle = typeof msg.id === "number" ? this.pending.get(msg.id) : undefined;
        if (settle) {
          this.pending.delete(msg.id as number);
          settle(msg);
        }
      }
    });
    this.child.stderr!.on("data", (chunk: Buffer) => {
      this.stderr += chunk.toString();
    });
  }

  request(method: string, params: Json = {}): Promise<Json> {
    const id = ++this.nextId;
    this.child.stdin!.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params: { ...params, _meta: META } })}\n`);
    return new Promise<Json>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`no reply to ${method} within 15s; stderr:\n${this.stderr}`)), 15_000);
      this.pending.set(id, (m) => {
        clearTimeout(timer);
        resolve(m);
      });
    });
  }

  async start(): Promise<this> {
    const r = await this.request("server/discover");
    if (r.error) throw new Error(`server/discover failed: ${JSON.stringify(r.error)}; stderr:\n${this.stderr}`);
    return this;
  }

  /** tools/call; returns {isError, text, json?}. */
  async call(name: string, args: Json = {}): Promise<{ isError: boolean; text: string; json: any }> {
    const r = await this.request("tools/call", { name, arguments: args });
    if (r.error) throw new Error(`tools/call ${name}: JSON-RPC error ${JSON.stringify(r.error)}`);
    const text = (r.result.content as Array<{ text?: string }>).map((c) => c.text ?? "").join("");
    let json: any;
    try {
      json = JSON.parse(text);
    } catch {
      json = undefined;
    }
    return { isError: r.result.isError === true, text, json };
  }

  close(): void {
    this.child.kill();
  }
}

/** A recorder snapshot: counts that a refused call must leave unchanged. */
const traffic = (f: FakeCdpServer) => ({ messages: f.messages.length, requests: f.requests.length });
const methodsOf = (f: FakeCdpServer, targetId?: string) => (targetId ? f.messagesFor(targetId) : f.messages).map((m) => m.method);

/** Reserve a free port: bind a throwaway fake, read its port, stop it. */
async function freePort(): Promise<number> {
  const probe = new FakeCdpServer();
  const { port } = await probe.start();
  await probe.stop();
  return port;
}

const NONCE = "0123456789abcdef01234567";

/* ------------------------------ named endpoints, one server ------------------------------ */

describe("one server, a writable default and a read-only teams endpoint (CDP_ENDPOINTS)", () => {
  const fakeA = new FakeCdpServer();
  const fakeB = new FakeCdpServer({ browser: "Edg/156.0.0.0 (fake)", targets: TEAMS_TARGETS });
  let mcp: McpChild;

  beforeAll(async () => {
    await fakeA.start();
    await fakeB.start();
    const dir = mkdtempSync(join(scratch, "named-"));
    mcp = await new McpChild({
      // `default` named in the string itself, so no implicit 9222 endpoint exists.
      CDP_ENDPOINTS: `default=${fakeA.base},teams=${fakeB.base}?mode=read,dead=${DEAD}`,
      CDP_ARTIFACT_DIR: dir,
      CDP_STATE_DIR: dir,
    }).start();
  }, 30_000);

  afterAll(async () => {
    mcp.close();
    await fakeA.stop();
    await fakeB.stop();
  });

  beforeEach(() => {
    fakeA.reset();
    fakeB.reset();
  });

  test("startup log tags the read-only endpoint", () => {
    expect(mcp.stderr).toContain(`endpoints=default=${fakeA.base},teams=${fakeB.base}(read),dead=${DEAD}`);
  });

  test("ACCEPTANCE 1: take_snapshot on the default endpoint, then on endpoint:teams, consecutive calls, no restart", async () => {
    const a = await mcp.call("take_snapshot", {});
    expect(a.isError).toBe(false);
    expect(a.text).toContain("Hello");
    expect(methodsOf(fakeA, "PAGE1")).toContain("Accessibility.getFullAXTree");
    expect(traffic(fakeB)).toEqual({ messages: 0, requests: 0 });

    fakeA.reset();
    const b = await mcp.call("take_snapshot", { target: "endpoint:teams/title:Chat" });
    expect(b.isError).toBe(false);
    expect(b.text).toContain("Hello");
    // The CHAT page, not the empty host page, and nothing on the default endpoint.
    expect(methodsOf(fakeB, "CHAT1")).toContain("Accessibility.getFullAXTree");
    expect(methodsOf(fakeB, "HOST1")).toEqual([]);
    expect(traffic(fakeA)).toEqual({ messages: 0, requests: 0 });
  });

  test("ACCEPTANCE 2: click on the read-only endpoint is a policy error and sends NOTHING; the same click on the default endpoint does send", async () => {
    // Positive control: the recorder sees this click.
    const ok = await mcp.call("click", { uid: "3" });
    expect(ok.isError).toBe(false);
    expect(methodsOf(fakeA, "PAGE1")).toContain("Input.dispatchMouseEvent");

    const before = traffic(fakeB);
    const refused = await mcp.call("click", { target: "endpoint:teams/title:Chat", uid: "3" });
    expect(refused.isError).toBe(true);
    expect(refused.text).toContain("'click' is not allowed on endpoint 'teams'");
    expect(refused.text).toContain("read-only");
    expect(traffic(fakeB)).toEqual(before);
    expect(fakeB.messages).toEqual([]);
    expect(fakeB.requests).toEqual([]);
  });

  test("call_tool cannot launder a mutating tool: call_tool{click, endpoint:teams/...} is refused with no traffic", async () => {
    const r = await mcp.call("call_tool", { name: "click", arguments: { target: "endpoint:teams/title:Chat", uid: "3" } });
    expect(r.isError).toBe(true);
    expect(r.text).toContain("'click' is not allowed on endpoint 'teams'");
    expect(traffic(fakeB)).toEqual({ messages: 0, requests: 0 });
  });

  test("a teams lease token alone routes the call to teams, so policy refuses it there (token resolved before the check)", async () => {
    const r = await mcp.call("click", { uid: "3", lease: mintToken("chrome@teams", "CHAT1", NONCE) });
    expect(r.isError).toBe(true);
    expect(r.text).toContain("'click' is not allowed on endpoint 'teams'");
    expect(traffic(fakeB)).toEqual({ messages: 0, requests: 0 });
    expect(traffic(fakeA)).toEqual({ messages: 0, requests: 0 });
  });

  test("other mutating tools are refused too (navigate_page, fill, new_page), all before any traffic", async () => {
    for (const [tool, args] of [
      ["navigate_page", { target: "endpoint:teams/title:Chat", url: "https://x.test/" }],
      ["fill", { target: "endpoint:teams/title:Chat", uid: "3", value: "x" }],
      ["new_page", { endpoint: "teams", url: "about:blank" }],
    ] as const) {
      const r = await mcp.call(tool, args);
      expect({ tool, isError: r.isError }).toEqual({ tool, isError: true });
      expect(r.text).toContain(`'${tool}' is not allowed on endpoint 'teams'`);
    }
    expect(traffic(fakeB)).toEqual({ messages: 0, requests: 0 });
  });

  test("evaluate_script on the read-only endpoint is ALLOWED (user decision) and reaches the teams page", async () => {
    // A real value: the fake's default `undefined` result would serialize to no text at all.
    const title = () => ({ result: { type: "string", value: "Chat | Microsoft Teams" } });
    fakeB.handlers["Runtime.evaluate"] = title;
    fakeB.handlers["Runtime.callFunctionOn"] = title;
    const r = await mcp.call("evaluate_script", { target: "endpoint:teams/title:Chat", expression: "document.title" });
    expect(r.isError).toBe(false);
    expect(r.text).toContain("Chat | Microsoft Teams");
    expect(methodsOf(fakeB, "CHAT1").some((m) => m === "Runtime.evaluate" || m === "Runtime.callFunctionOn")).toBe(true);
  });

  test("evaluate_script whose value is undefined (void 0) answers null, not an empty reply the SDK rejects", async () => {
    // the fake's default Runtime.evaluate reply is { type: "undefined" }, what Chrome sends for `void 0`
    delete fakeB.handlers["Runtime.evaluate"];
    delete fakeB.handlers["Runtime.callFunctionOn"];
    const r = await mcp.call("evaluate_script", { target: "endpoint:teams/title:Chat", expression: "void 0" });
    expect(r.isError).toBe(false);
    expect(r.text).toBe("null");
  });

  test("take_screenshot on read-only: plain capture is allowed; renderWidth (an emulation override) is refused with no traffic", async () => {
    const shot = join(scratch, "teams-shot.png");
    const ok = await mcp.call("take_screenshot", { target: "endpoint:teams/title:Chat", savePath: shot });
    expect(ok.isError).toBe(false);
    expect(methodsOf(fakeB, "CHAT1")).toContain("Page.captureScreenshot");

    fakeB.reset();
    const refused = await mcp.call("take_screenshot", { target: "endpoint:teams/title:Chat", renderWidth: 1200, savePath: shot });
    expect(refused.isError).toBe(true);
    expect(refused.text).toContain("'take_screenshot' is not allowed on endpoint 'teams'");
    expect(traffic(fakeB)).toEqual({ messages: 0, requests: 0 });
  });

  test("ACCEPTANCE 3: list_pages{allEndpoints:true} lists both live endpoints and reports the dead one as down", async () => {
    const r = await mcp.call("list_pages", { allEndpoints: true });
    expect(r.isError).toBe(false);
    expect(r.json.pages.map((p: Json) => [p.endpoint, p.id])).toEqual([
      ["default", "PAGE1"],
      ["teams", "HOST1"],
      ["teams", "CHAT1"],
    ]);
    const byName = Object.fromEntries(r.json.endpoints.map((e: Json) => [e.endpoint, e]));
    expect(byName.default).toMatchObject({ base: fakeA.base, readOnly: false, count: 1 });
    expect(byName.teams).toMatchObject({ base: fakeB.base, readOnly: true, count: 2 });
    expect(byName.dead).toMatchObject({ base: DEAD, down: true });
    expect(typeof byName.dead.error).toBe("string");
    expect(byName.default.down).toBeUndefined();
    expect(byName.teams.down).toBeUndefined();
  });
});

/* ------------------------------------- tools/list ------------------------------------- */

describe("tools/list annotations", () => {
  test("every listed tool carries annotations.readOnlyHint, true exactly for READ tools", async () => {
    const fakeA = new FakeCdpServer();
    await fakeA.start();
    const mcp = await new McpChild({ CDP_BASE: fakeA.base, CDP_TOOL_PROFILE: "full", CDP_ARTIFACT_DIR: scratch }).start();
    try {
      const r = await mcp.request("tools/list");
      const tools = r.result.tools as Array<{ name: string; annotations?: { readOnlyHint?: unknown } }>;
      expect(tools.length).toBeGreaterThan(40);
      const missing = tools.filter((t) => typeof t.annotations?.readOnlyHint !== "boolean").map((t) => t.name);
      expect(missing).toEqual([]);
      const hint = Object.fromEntries(tools.map((t) => [t.name, t.annotations!.readOnlyHint]));
      expect(hint).toMatchObject({
        click: false,
        fill: false,
        navigate_page: false,
        call_tool: false,
        take_snapshot: true,
        evaluate_script: true,
        list_pages: true,
        search_tools: true,
      });
    } finally {
      mcp.close();
      await fakeA.stop();
    }
  }, 30_000);
});

/* --------------------------------- single CDP_BASE setup --------------------------------- */

describe("ACCEPTANCE 4: a CDP_BASE-only setup behaves exactly as before", () => {
  const fakeA = new FakeCdpServer();
  let mcp: McpChild;
  let dir: string;

  beforeAll(async () => {
    await fakeA.start();
    dir = mkdtempSync(join(scratch, "single-"));
    mcp = await new McpChild({ CDP_BASE: fakeA.base, CDP_ARTIFACT_DIR: dir, CDP_STATE_DIR: dir }).start();
  }, 30_000);

  afterAll(async () => {
    mcp.close();
    await fakeA.stop();
  });

  test("startup log has no endpoints suffix", () => {
    expect(mcp.stderr).toContain(`CDP_BASE=${fakeA.base}`);
    expect(mcp.stderr).not.toContain("endpoints=");
  });

  test("list_pages has no endpoint fields anywhere", async () => {
    const r = await mcp.call("list_pages", {});
    expect(r.isError).toBe(false);
    expect(Object.keys(r.json).sort()).toEqual(["count", "pages"]);
    expect(r.json.pages.map((p: Json) => p.id)).toEqual(["PAGE1"]);
    expect(r.json.pages.some((p: Json) => "endpoint" in p)).toBe(false);
  });

  test("click works and reaches the page", async () => {
    fakeA.reset();
    const r = await mcp.call("click", { uid: "3" });
    expect(r.isError).toBe(false);
    expect(methodsOf(fakeA, "PAGE1")).toContain("Input.dispatchMouseEvent");
  });

  test("lease and origin filenames and the token are the legacy un-suffixed form", async () => {
    const created = await mcp.call("new_page", { url: "about:blank", claim: true });
    expect(created.isError).toBe(false);
    const id = created.json.targetId as string;
    expect(created.json.lease).toStartWith(`chrome:${id}:`);
    const files = readdirSync(dir);
    expect(files).toContain(`lease-chrome-${id}.json`);
    expect(files).toContain(`origin-chrome-${id}.json`);
    expect(files.some((f) => f.includes("@"))).toBe(false);
  });
});

/* ---------------------------------- CDP_ENDPOINTS_FILE ---------------------------------- */

describe("CDP_ENDPOINTS_FILE config, end to end", () => {
  test("a JSON file with a named default and a readOnly endpoint: snapshot, refusal, listing", async () => {
    const fakeA = new FakeCdpServer();
    const fakeB = new FakeCdpServer({ targets: TEAMS_TARGETS });
    await fakeA.start();
    await fakeB.start();
    const dir = mkdtempSync(join(scratch, "file-"));
    const file = join(dir, "endpoints.json");
    writeFileSync(
      file,
      JSON.stringify({ default: "browser", endpoints: { browser: { base: fakeA.base }, teams: { base: fakeB.base, readOnly: true } } }),
    );
    const mcp = await new McpChild({ CDP_ENDPOINTS_FILE: file, CDP_ARTIFACT_DIR: dir, CDP_STATE_DIR: dir }).start();
    try {
      const snap = await mcp.call("take_snapshot", {});
      expect(snap.isError).toBe(false);
      expect(methodsOf(fakeA, "PAGE1")).toContain("Accessibility.getFullAXTree");
      expect(traffic(fakeB)).toEqual({ messages: 0, requests: 0 });

      const teamsSnap = await mcp.call("take_snapshot", { target: "endpoint:teams/title:Chat" });
      expect(teamsSnap.isError).toBe(false);
      expect(methodsOf(fakeB, "CHAT1")).toContain("Accessibility.getFullAXTree");

      fakeB.reset();
      const refused = await mcp.call("click", { target: "endpoint:teams/title:Chat", uid: "3" });
      expect(refused.isError).toBe(true);
      expect(refused.text).toContain("'click' is not allowed on endpoint 'teams'");
      expect(traffic(fakeB)).toEqual({ messages: 0, requests: 0 });

      const all = await mcp.call("list_pages", { allEndpoints: true });
      expect(all.json.endpoints.map((e: Json) => [e.endpoint, e.readOnly, e.count])).toEqual([
        ["browser", false, 1],
        ["teams", true, 2],
      ]);
    } finally {
      mcp.close();
      await fakeA.stop();
      await fakeB.stop();
    }
  }, 30_000);
});

/* --------------------------------- late-starting endpoint --------------------------------- */

describe("an endpoint that is down at server start", () => {
  test("is reported down, then works once it comes up, with no restart", async () => {
    const fakeA = new FakeCdpServer();
    await fakeA.start();
    const port = await freePort();
    const late = new FakeCdpServer({ targets: TEAMS_TARGETS });
    const dir = mkdtempSync(join(scratch, "late-"));
    const mcp = await new McpChild({
      CDP_BASE: fakeA.base,
      CDP_ENDPOINTS: `late=http://127.0.0.1:${port}`,
      CDP_ARTIFACT_DIR: dir,
      CDP_STATE_DIR: dir,
    }).start();
    try {
      const down = await mcp.call("list_pages", { allEndpoints: true });
      expect(down.json.endpoints.find((e: Json) => e.endpoint === "late").down).toBe(true);
      const direct = await mcp.call("take_snapshot", { target: "endpoint:late/title:Chat" });
      expect(direct.isError).toBe(true);

      await late.start(port);
      const up = await mcp.call("list_pages", { endpoint: "late" });
      expect(up.isError).toBe(false);
      expect(up.json.pages.map((p: Json) => [p.endpoint, p.id])).toEqual([
        ["late", "HOST1"],
        ["late", "CHAT1"],
      ]);
      const snap = await mcp.call("take_snapshot", { target: "endpoint:late/title:Chat" });
      expect(snap.isError).toBe(false);
      expect(methodsOf(late, "CHAT1")).toContain("Accessibility.getFullAXTree");
    } finally {
      mcp.close();
      await fakeA.stop();
      await late.stop();
    }
  }, 30_000);
});

/* ------------------------------ strict-lease reap on read-only ------------------------------ */

describe("CDP_REQUIRE_LEASE reap never closes a tab on a read-only endpoint", () => {
  test("a stale agent tab on the default endpoint IS reaped; the same shape on read-only teams is NOT", async () => {
    const fakeA = new FakeCdpServer();
    const fakeB = new FakeCdpServer({ targets: TEAMS_TARGETS });
    await fakeA.start();
    await fakeB.start();
    const dir = mkdtempSync(join(scratch, "reap-"));
    const endpointsSpec = `teams=${fakeB.base}?mode=read`;

    // Seed, in this process, an abandoned agent tab on EACH endpoint: an origin record plus a
    // lease past its 1ms TTL (CDP_REAP_GRACE_MS=0 below makes "expired" reapable at once).
    const savedEnv = { CDP_BASE: process.env.CDP_BASE, CDP_ENDPOINTS: process.env.CDP_ENDPOINTS, CDP_ENDPOINTS_FILE: process.env.CDP_ENDPOINTS_FILE, CDP_ARTIFACT_DIR: process.env.CDP_ARTIFACT_DIR };
    try {
      delete process.env.CDP_ENDPOINTS_FILE;
      process.env.CDP_BASE = fakeA.base;
      process.env.CDP_ENDPOINTS = endpointsSpec;
      process.env.CDP_ARTIFACT_DIR = dir;
      resetEndpointCache();
      for (const [ep, id] of [["default", "PAGE1"], ["teams", "CHAT1"]] as const) {
        await withEndpointScope(getEndpoint(ep), async () => {
          await recordOrigin(chromeLeaseBackend(), id, { label: "abandoned" });
          await claimLease(chromeLeaseBackend(), id, { label: "abandoned", ttlMs: 1 });
        });
      }
    } finally {
      for (const [k, v] of Object.entries(savedEnv)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
      resetEndpointCache();
    }
    await new Promise((r) => setTimeout(r, 20));
    expect(readdirSync(dir).sort()).toEqual(
      ["lease-chrome-PAGE1.json", "lease-chrome@teams-CHAT1.json", "origin-chrome-PAGE1.json", "origin-chrome@teams-CHAT1.json"].sort(),
    );

    const mcp = await new McpChild({
      CDP_BASE: fakeA.base,
      CDP_ENDPOINTS: endpointsSpec,
      CDP_ARTIFACT_DIR: dir,
      CDP_STATE_DIR: dir,
      CDP_REQUIRE_LEASE: "1",
      CDP_REAP_GRACE_MS: "0",
    }).start();
    try {
      const all = await mcp.call("list_pages", { allEndpoints: true });
      expect(all.isError).toBe(false);
      // Positive control: the default endpoint's abandoned tab was closed and reported.
      expect(all.json.reaped.map((t: Json) => [t.endpoint, t.targetId])).toEqual([["default", "PAGE1"]]);
      expect(methodsOf(fakeA, "browser")).toContain("Target.closeTarget");
      // Read-only teams: no close of any kind, the tab still listed, its lease file intact.
      const closesB = fakeB.messages.filter((m) => m.method === "Target.closeTarget").length + fakeB.requests.filter((r) => r.path.startsWith("/json/close")).length;
      expect(closesB).toBe(0);
      expect(all.json.pages.filter((p: Json) => p.endpoint === "teams").map((p: Json) => p.id)).toEqual(["HOST1", "CHAT1"]);

      const leases = await mcp.call("list_leases", { endpoint: "teams" });
      expect(leases.isError).toBe(false);
      expect(leases.json.reaped).toBeUndefined();
      expect(fakeB.messages.filter((m) => m.method === "Target.closeTarget")).toEqual([]);
      expect(fakeB.targets.map((t) => t.id)).toEqual(["HOST1", "CHAT1"]);
      expect(readdirSync(dir)).toContain("lease-chrome@teams-CHAT1.json");
      expect(readdirSync(dir)).not.toContain("lease-chrome-PAGE1.json");
    } finally {
      mcp.close();
      await fakeA.stop();
      await fakeB.stop();
    }
  }, 30_000);
});

/* ------------------------------------ lease-token routing ------------------------------------ */

describe("release_page{lease} acts on the endpoint the lease belongs to", () => {
  test("a token claimed on a writable named endpoint releases AND closes there, not on the default", async () => {
    const fakeA = new FakeCdpServer();
    const fakeC = new FakeCdpServer({ targets: [{ id: "IDE1", type: "page", title: "IDE", url: "https://ide.fake/" }] });
    await fakeA.start();
    await fakeC.start();
    const dir = mkdtempSync(join(scratch, "release-"));
    const mcp = await new McpChild({ CDP_BASE: fakeA.base, CDP_ENDPOINTS: `ide=${fakeC.base}`, CDP_ARTIFACT_DIR: dir, CDP_STATE_DIR: dir }).start();
    try {
      // new_page{claim} creates the tab, so release closes it (an agent-created tab).
      const created = await mcp.call("new_page", { endpoint: "ide", url: "about:blank", claim: true });
      expect(created.isError).toBe(false);
      const id = created.json.targetId as string;
      expect(created.json.lease).toStartWith(`chrome@ide:${id}:`);
      fakeA.reset();
      const beforeC = fakeC.messages.length;

      const rel = await mcp.call("release_page", { lease: created.json.lease });
      expect(rel.isError).toBe(false);
      expect(rel.json).toMatchObject({ released: true, targetId: id });
      expect(fakeC.messages.slice(beforeC).filter((m) => m.method === "Target.closeTarget").map((m) => (m.params as Json).targetId)).toEqual(
        rel.json.closed ? [id] : [],
      );
      expect(rel.json.closed).toBe(true);
      expect(fakeA.messages.filter((m) => m.method === "Target.closeTarget")).toEqual([]);
      expect(readdirSync(dir)).not.toContain(`lease-chrome@ide-${id}.json`);

      // A prefix that disagrees with the token is an error, not a guess.
      const clash = await mcp.call("release_page", { target: "endpoint:default/PAGE1", lease: mintToken("chrome@ide", "IDE1", NONCE) });
      expect(clash.isError).toBe(true);
      expect(clash.text).toContain("conflicting endpoints");
    } finally {
      mcp.close();
      await fakeA.stop();
      await fakeC.stop();
    }
  }, 30_000);
});

/* --------------------------------------------- docs --------------------------------------------- */

describe("README read-only table", () => {
  test("the Read row names exactly policy.ts's READ_TOOLS", () => {
    const readme = readFileSync(fileURLToPath(new URL("../README.md", import.meta.url)), "utf8");
    const row = readme.split("\n").find((l) => l.startsWith("| **Read** (allowed) |"));
    expect(row).toBeDefined();
    const named = [...row!.matchAll(/`([a-z_]+)`/g)].map((m) => m[1]!).sort();
    expect(named.length).toBeGreaterThan(0);
    expect(named).toEqual([...READ_TOOLS].sort());
  });
});

/* --------------------------------------------- CLI --------------------------------------------- */

describe("CLI dispatch enforces the same policy", () => {
  test("click on a read-only endpoint exits nonzero with the policy message and sends nothing; the default endpoint click works", async () => {
    const fakeA = new FakeCdpServer();
    const fakeB = new FakeCdpServer({ targets: TEAMS_TARGETS });
    await fakeA.start();
    await fakeB.start();
    const dir = mkdtempSync(join(scratch, "cli-"));
    const run = async (args: string[]) => {
      const proc = Bun.spawn([process.execPath, "run", CLI, ...args], {
        env: childEnv({ CDP_BASE: fakeA.base, CDP_ENDPOINTS: `teams=${fakeB.base}?mode=read`, CDP_ARTIFACT_DIR: dir, CDP_STATE_DIR: dir }),
        stdout: "pipe",
        stderr: "pipe",
        signal: AbortSignal.timeout(30_000),
      });
      const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
      return { code: await proc.exited, stdout, stderr };
    };
    try {
      const ok = await run(["click", "--uid", "3"]);
      expect({ code: ok.code, stderr: ok.stderr }).toEqual({ code: 0, stderr: "" });
      expect(methodsOf(fakeA, "PAGE1")).toContain("Input.dispatchMouseEvent");

      const refused = await run(["click", "--target", "endpoint:teams/title:Chat", "--uid", "3"]);
      expect(refused.code).not.toBe(0);
      expect(refused.stderr).toContain("'click' is not allowed on endpoint 'teams'");
      expect(traffic(fakeB)).toEqual({ messages: 0, requests: 0 });
    } finally {
      await fakeA.stop();
      await fakeB.stop();
    }
  }, 60_000);
});
