/**
 * Named CDP endpoints (issue #15): config parsing, the endpoint:<name>/ selector
 * prefix, the dispatch scope, per-endpoint lease/origin keys, list_pages
 * {endpoint, allEndpoints}, and the prefix's path through the real MCP server
 * (direct call and call_tool) and the real CLI.
 *
 * The fake endpoints here are HTTP-only (/json/list, /json/version): every
 * assertion is chosen so it needs no WebSocket. Dead endpoints use port 1, as
 * test/mcp-protocol.test.ts does.
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  currentEndpoint,
  defaultEndpoint,
  endpointForArgs,
  EndpointConfigError,
  getEndpoint,
  leaseNamespace,
  loadEndpoints,
  resetEndpointCache,
  splitEndpointSelector,
  stripEndpointArgs,
  usesEndpointArgs,
  withEndpointScope,
  type Endpoint,
} from "../src/endpoints.ts";
import { chromeLeaseBackend, claimLease, leaseFile, listLeases, mintToken, tokenParts } from "../src/leases.ts";
import { listOrigins, originFile, recordOrigin } from "../src/origins.ts";
import { listPages } from "../src/shared-tools.ts";
import { createCdpDriver } from "../src/cdp/driver.ts";
import { listTargets } from "../src/client.ts";

const DEAD = "http://127.0.0.1:1";
const KEYS = ["CDP_BASE", "CDP_ENDPOINTS", "CDP_ENDPOINTS_FILE", "CDP_ARTIFACT_DIR", "CDP_REQUIRE_LEASE"] as const;
const saved: Record<string, string | undefined> = {};
for (const k of KEYS) saved[k] = process.env[k];

/** Set exactly these endpoint env vars (others in KEYS unset), and drop the memo. */
function setEnv(vars: Partial<Record<(typeof KEYS)[number], string>>): void {
  for (const k of KEYS) {
    if (k === "CDP_ARTIFACT_DIR") continue;
    delete process.env[k];
  }
  for (const [k, v] of Object.entries(vars)) process.env[k] = v;
  resetEndpointCache();
}

afterEach(() => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  resetEndpointCache();
});

const scratch = mkdtempSync(join(tmpdir(), "cdp-endpoints-test-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

function writeJson(name: string, value: unknown): string {
  const p = join(scratch, name);
  writeFileSync(p, typeof value === "string" ? value : JSON.stringify(value));
  return p;
}

function expectConfigError(env: NodeJS.ProcessEnv, match: RegExp): void {
  let caught: unknown;
  try {
    loadEndpoints(env);
  } catch (e) {
    caught = e;
  }
  expect(caught).toBeInstanceOf(EndpointConfigError);
  expect((caught as Error).message).toMatch(match);
}

/* ------------------------------- config parsing ------------------------------- */

describe("loadEndpoints", () => {
  test("nothing set: one endpoint 'default' at http://127.0.0.1:9222", () => {
    const c = loadEndpoints({});
    expect(c.default).toEqual({ name: "default", base: "http://127.0.0.1:9222", readOnly: false });
    expect([...c.byName.keys()]).toEqual(["default"]);
  });

  test("CDP_BASE only: kept VERBATIM (trailing slash, odd host and all), named 'default'", () => {
    for (const raw of ["http://127.0.0.1:9333", "http://127.0.0.1:9333/", "http://localhost:1234", ""]) {
      const c = loadEndpoints({ CDP_BASE: raw });
      expect(c.default).toEqual({ name: "default", base: raw, readOnly: false });
      expect(c.byName.size).toBe(1);
    }
  });

  test("CDP_ENDPOINTS string: names, normalized bases, ?mode=read, default synthesized from CDP_BASE", () => {
    const c = loadEndpoints({
      CDP_BASE: "http://127.0.0.1:9222",
      CDP_ENDPOINTS: " browser=http://127.0.0.1:9222/ , teams=http://127.0.0.1:9333?mode=read,rw=http://127.0.0.1:9444?mode=write,",
    });
    expect(c.default.name).toBe("default");
    expect([...c.byName.keys()]).toEqual(["default", "browser", "teams", "rw"]);
    expect(c.byName.get("browser")).toEqual({ name: "browser", base: "http://127.0.0.1:9222", readOnly: false });
    expect(c.byName.get("teams")).toEqual({ name: "teams", base: "http://127.0.0.1:9333", readOnly: true });
    expect(c.byName.get("rw")!.readOnly).toBe(false);
  });

  test("CDP_ENDPOINTS without CDP_BASE: default stays http://127.0.0.1:9222", () => {
    const c = loadEndpoints({ CDP_ENDPOINTS: "teams=http://127.0.0.1:9333" });
    expect(c.default).toEqual({ name: "default", base: "http://127.0.0.1:9222", readOnly: false });
  });

  test("CDP_ENDPOINTS may define 'default' itself", () => {
    const c = loadEndpoints({ CDP_ENDPOINTS: "default=http://127.0.0.1:9555,teams=http://127.0.0.1:9333" });
    expect(c.default.base).toBe("http://127.0.0.1:9555");
  });

  test("JSON file: default key, readOnly, mode alias; the file's default wins over the name 'default'", () => {
    const file = writeJson("ok.json", {
      default: "browser",
      endpoints: {
        browser: { base: "http://127.0.0.1:9222" },
        teams: { base: "http://127.0.0.1:9333", readOnly: true },
        ide: { base: "http://127.0.0.1:9444", mode: "read" },
      },
    });
    const c = loadEndpoints({ CDP_ENDPOINTS_FILE: file });
    expect(c.default).toEqual({ name: "browser", base: "http://127.0.0.1:9222", readOnly: false });
    expect([...c.byName.keys()]).toEqual(["browser", "teams", "ide"]);
    expect(c.byName.get("teams")!.readOnly).toBe(true);
    expect(c.byName.get("ide")!.readOnly).toBe(true);
  });

  test("file naming another default plus CDP_BASE: CDP_BASE is the non-default endpoint 'default'", () => {
    const file = writeJson("dflt.json", { default: "browser", endpoints: { browser: { base: "http://127.0.0.1:9222" } } });
    const c = loadEndpoints({ CDP_ENDPOINTS_FILE: file, CDP_BASE: "http://127.0.0.1:9777" });
    expect(c.default.name).toBe("browser");
    expect(c.byName.get("default")!.base).toBe("http://127.0.0.1:9777");
  });

  test("env string and file merge; an identical double definition is fine", () => {
    const file = writeJson("merge.json", { endpoints: { teams: { base: "http://127.0.0.1:9333/", mode: "read" }, ide: { base: "http://127.0.0.1:9444" } } });
    const c = loadEndpoints({ CDP_ENDPOINTS: "teams=http://127.0.0.1:9333?mode=read", CDP_ENDPOINTS_FILE: file });
    expect([...c.byName.keys()]).toEqual(["default", "teams", "ide"]);
  });

  describe("malformed config names the problem", () => {
    test("bad URL", () => expectConfigError({ CDP_ENDPOINTS: "teams=not a url" }, /teams.*not a valid URL/));
    test("non-http scheme", () => expectConfigError({ CDP_ENDPOINTS: "teams=ws://127.0.0.1:9333" }, /http:\/\/ or https:\/\//));
    test("missing '='", () => expectConfigError({ CDP_ENDPOINTS: "http://127.0.0.1:9333" }, /not name=url/));
    test("duplicate name", () => expectConfigError({ CDP_ENDPOINTS: "a=http://127.0.0.1:1,a=http://127.0.0.1:2" }, /duplicate endpoint name 'a'/));
    test("invalid name ('-')", () => expectConfigError({ CDP_ENDPOINTS: "my-app=http://127.0.0.1:2" }, /name 'my-app' is invalid/));
    test("unknown mode", () => expectConfigError({ CDP_ENDPOINTS: "t=http://127.0.0.1:2?mode=readonly" }, /unknown mode 'readonly'/));
    test("unknown query parameter", () => expectConfigError({ CDP_ENDPOINTS: "t=http://127.0.0.1:2?ro=1" }, /unknown query parameter 'ro'/));
    test("unreadable file", () =>
      expectConfigError({ CDP_ENDPOINTS_FILE: join(scratch, "missing.json") }, /cannot read .*missing\.json.*ENOENT/));
    test("invalid JSON", () => expectConfigError({ CDP_ENDPOINTS_FILE: writeJson("bad.json", "{nope") }, /not valid JSON/));
    test("unknown file key", () =>
      expectConfigError({ CDP_ENDPOINTS_FILE: writeJson("key.json", { endpoints: { t: { base: "http://127.0.0.1:2", readonly: true } } }) }, /unknown key 'readonly'/));
    test("unknown file mode", () =>
      expectConfigError({ CDP_ENDPOINTS_FILE: writeJson("mode.json", { endpoints: { t: { base: "http://127.0.0.1:2", mode: "ro" } } }) }, /unknown mode 'ro'/));
    test("file default that is not defined", () =>
      expectConfigError({ CDP_ENDPOINTS_FILE: writeJson("nodef.json", { default: "x", endpoints: {} }) }, /default endpoint 'x', which is not defined/));
    test("readOnly and mode contradict", () =>
      expectConfigError(
        { CDP_ENDPOINTS_FILE: writeJson("contra.json", { endpoints: { t: { base: "http://127.0.0.1:2", readOnly: false, mode: "read" } } }) },
        /contradict/,
      ));
    test("env and file define the same name differently", () =>
      expectConfigError(
        { CDP_ENDPOINTS: "teams=http://127.0.0.1:9333", CDP_ENDPOINTS_FILE: writeJson("diff.json", { endpoints: { teams: { base: "http://127.0.0.1:9334" } } }) },
        /'teams' is defined differently in CDP_ENDPOINTS .* and CDP_ENDPOINTS_FILE/,
      ));
    test("env and file differ only in mode", () =>
      expectConfigError(
        { CDP_ENDPOINTS: "teams=http://127.0.0.1:9333", CDP_ENDPOINTS_FILE: writeJson("diffmode.json", { endpoints: { teams: { base: "http://127.0.0.1:9333", readOnly: true } } }) },
        /defined differently/,
      ));
    test("CDP_BASE disagrees with a configured 'default'", () =>
      expectConfigError({ CDP_BASE: "http://127.0.0.1:9222", CDP_ENDPOINTS: "default=http://127.0.0.1:9333" }, /CDP_BASE .* disagree/));
  });

  test("a config error is not cached: fixing the file is picked up on the next call", () => {
    const p = writeJson("fixme.json", "{broken");
    setEnv({ CDP_ENDPOINTS_FILE: p });
    expect(() => defaultEndpoint()).toThrow(EndpointConfigError);
    writeJson("fixme.json", { endpoints: { teams: { base: "http://127.0.0.1:9333" } } });
    expect(getEndpoint("teams").base).toBe("http://127.0.0.1:9333");
  });
});

/* --------------------------------- selectors --------------------------------- */

describe("splitEndpointSelector / stripEndpointArgs / endpointForArgs", () => {
  const env = { CDP_ENDPOINTS: "teams=http://127.0.0.1:9333?mode=read,ide=http://127.0.0.1:9444" };

  test("prefix with rest, prefix alone, trailing slash, no prefix", () => {
    setEnv(env);
    const a = splitEndpointSelector("endpoint:teams/title:Chat");
    expect(a.endpoint.name).toBe("teams");
    expect(a.rest).toBe("title:Chat");
    expect(splitEndpointSelector("endpoint:teams").rest).toBeUndefined();
    expect(splitEndpointSelector("endpoint:teams/").rest).toBeUndefined();
    // Everything after the FIRST slash is the selector, slashes included.
    expect(splitEndpointSelector("endpoint:ide/url:https://x.test/a").rest).toBe("url:https://x.test/a");
    const none = splitEndpointSelector("title:Chat");
    expect(none.endpoint.name).toBe("default");
    expect(none.rest).toBe("title:Chat");
    expect(splitEndpointSelector(undefined).rest).toBeUndefined();
  });

  test("unknown name throws EndpointConfigError listing the known names", () => {
    setEnv(env);
    expect(() => splitEndpointSelector("endpoint:nope/title:x")).toThrow(/unknown endpoint 'nope' \(known: default, teams, ide\)/);
    expect(() => splitEndpointSelector("endpoint:/title:x")).toThrow(/empty endpoint name/);
  });

  test("'url:endpoint:x' and 'title:endpoint:x' are NOT a prefix", () => {
    setEnv(env);
    for (const s of ["url:endpoint:teams/x", "title:endpoint:teams", "label:endpoint:teams"]) {
      const r = splitEndpointSelector(s);
      expect(r.endpoint.name).toBe("default");
      expect(r.rest).toBe(s);
    }
  });

  test("no prefix and no endpoint key: the ORIGINAL args object, untouched", () => {
    setEnv(env);
    const args = { target: "title:Chat", uid: "1" };
    const r = stripEndpointArgs(args);
    expect(r.args).toBe(args);
    expect(r.endpoint.name).toBe("default");
  });

  test("target prefix is stripped; prefix alone DELETES target; targetId honored; endpoint key removed", () => {
    setEnv(env);
    const a = stripEndpointArgs({ target: "endpoint:teams/title:Chat", uid: "1" });
    expect(a.endpoint.name).toBe("teams");
    expect(a.args).toEqual({ target: "title:Chat", uid: "1" });
    const b = stripEndpointArgs({ target: "endpoint:teams" });
    expect(b.args).toEqual({});
    expect("target" in (b.args as object)).toBe(false);
    const c = stripEndpointArgs({ targetId: "endpoint:ide/ABC" });
    expect(c.endpoint.name).toBe("ide");
    expect(c.args).toEqual({ targetId: "ABC" });
    const d = stripEndpointArgs({ endpoint: "teams", url: "about:blank" });
    expect(d.endpoint.name).toBe("teams");
    expect(d.args).toEqual({ url: "about:blank" });
  });

  test("prefix and endpoint key must agree", () => {
    setEnv(env);
    expect(stripEndpointArgs({ target: "endpoint:teams/x", endpoint: "teams" }).endpoint.name).toBe("teams");
    expect(() => stripEndpointArgs({ target: "endpoint:teams/x", endpoint: "ide" })).toThrow(/conflicting endpoints/);
    expect(() => stripEndpointArgs({ endpoint: 3 })).toThrow(/non-empty endpoint name/);
  });

  test("a chrome@<ns> lease token selects its endpoint; a disagreeing prefix is an error", () => {
    setEnv({ CDP_ENDPOINTS: "teams=http://127.0.0.1:9333?mode=read,ide=http://127.0.0.1:9444,ide2=http://127.0.0.1:9444" });
    const nonce = "0123456789abcdef01234567";
    const ideTok = mintToken("chrome@ide", "T1", nonce);
    // No prefix: the token's namespace picks the endpoint, and args come back untouched (lease kept).
    const args = { lease: ideTok };
    const r = stripEndpointArgs(args);
    expect(r.endpoint.name).toBe("ide");
    expect(r.args).toBe(args);
    // Plain `chrome:` is the default namespace; firefox and malformed tokens are left to the lease layer.
    expect(endpointForArgs({ lease: mintToken("chrome", "T1", nonce) }).name).toBe("default");
    expect(endpointForArgs({ lease: mintToken("firefox", "T1", nonce) }).name).toBe("default");
    expect(endpointForArgs({ lease: "garbage" }).name).toBe("default");
    // Agreeing prefix (by namespace: ide2 is an alias of ide's base, so it shares ide's lease space).
    expect(endpointForArgs({ target: "endpoint:ide/T1", lease: ideTok }).name).toBe("ide");
    expect(endpointForArgs({ endpoint: "ide2", lease: ideTok }).name).toBe("ide2");
    // Disagreeing: prefix names teams, token belongs to ide; and a default token under a named prefix.
    expect(() => stripEndpointArgs({ target: "endpoint:teams/T1", lease: ideTok })).toThrow(/conflicting endpoints.*lease token.*endpoint 'ide'/);
    expect(() => stripEndpointArgs({ endpoint: "ide", lease: mintToken("chrome", "T1", nonce) })).toThrow(/lease token.*default endpoint/);
    // A namespace nobody configures.
    expect(() => stripEndpointArgs({ lease: mintToken("chrome@gone", "T1", nonce) })).toThrow(/lease token belongs to endpoint 'gone', which is not configured/);
  });

  test("endpointForArgs", () => {
    setEnv(env);
    expect(endpointForArgs(undefined).name).toBe("default");
    expect(endpointForArgs({}).name).toBe("default");
    expect(endpointForArgs({ target: "endpoint:teams/title:Chat" })).toEqual({ name: "teams", base: "http://127.0.0.1:9333", readOnly: true });
    expect(endpointForArgs({ endpoint: "ide" }).name).toBe("ide");
    expect(endpointForArgs({ target: "url:endpoint:teams" }).name).toBe("default");
  });

  test("usesEndpointArgs never loads config (so Firefox can refuse without it)", () => {
    setEnv({ CDP_ENDPOINTS: "broken" });
    expect(usesEndpointArgs({ target: "endpoint:x/y" })).toBe(true);
    expect(usesEndpointArgs({ endpoint: "x" })).toBe(true);
    expect(usesEndpointArgs({ allEndpoints: true })).toBe(true);
    expect(usesEndpointArgs({ target: "url:endpoint:x" })).toBe(false);
    expect(usesEndpointArgs(undefined)).toBe(false);
  });
});

/* ----------------------------------- scope ----------------------------------- */

describe("withEndpointScope", () => {
  test("two concurrent scopes each see their own endpoint across awaits", async () => {
    setEnv({ CDP_ENDPOINTS: "teams=http://127.0.0.1:9333,ide=http://127.0.0.1:9444" });
    const tick = () => new Promise((r) => setTimeout(r, 5));
    const seen = (ep: Endpoint) =>
      withEndpointScope(ep, async () => {
        const out: string[] = [];
        for (let i = 0; i < 5; i++) {
          out.push(currentEndpoint().name);
          await tick();
        }
        return out;
      });
    const [a, b] = await Promise.all([seen(getEndpoint("teams")), seen(getEndpoint("ide"))]);
    expect(a).toEqual(Array(5).fill("teams"));
    expect(b).toEqual(Array(5).fill("ide"));
    expect(currentEndpoint().name).toBe("default");
  });
});

/* --------------------------- lease and origin keys --------------------------- */

describe("lease and origin keys", () => {
  const ID = "ABCDEF0123456789ABCDEF0123456789";

  test("default endpoint: filenames and tokens exactly as before", () => {
    setEnv({ CDP_ENDPOINTS: "teams=http://127.0.0.1:9333" });
    expect(chromeLeaseBackend()).toBe("chrome");
    expect(leaseFile(chromeLeaseBackend(), ID)).toEndWith(`/lease-chrome-${ID}.json`);
    expect(originFile(chromeLeaseBackend(), ID)).toEndWith(`/origin-chrome-${ID}.json`);
  });

  test("CDP_BASE only: still plain 'chrome'", () => {
    setEnv({ CDP_BASE: "http://127.0.0.1:9555" });
    expect(chromeLeaseBackend()).toBe("chrome");
  });

  test("named endpoint: distinct filenames and a token that round-trips", async () => {
    setEnv({ CDP_ENDPOINTS: "teams=http://127.0.0.1:9333" });
    await withEndpointScope(getEndpoint("teams"), async () => {
      const b = chromeLeaseBackend();
      expect(b).toBe("chrome@teams");
      expect(leaseFile(b, ID)).toEndWith(`/lease-chrome@teams-${ID}.json`);
      expect(originFile(b, ID)).toEndWith(`/origin-chrome@teams-${ID}.json`);
      const token = mintToken(b, ID, "0123456789abcdef01234567");
      expect(tokenParts(token)).toEqual({ backend: "chrome@teams", targetId: ID, nonce: "0123456789abcdef01234567" });
    });
    expect(tokenParts("chrome@bad-name:X:0123456789abcdef01234567")).toBeUndefined();
  });

  test("an endpoint whose base equals the default's shares the default lease space", () => {
    setEnv({ CDP_ENDPOINTS: "browser=http://127.0.0.1:9222/,teams=http://127.0.0.1:9333,teams2=http://127.0.0.1:9333" });
    expect(leaseNamespace(getEndpoint("browser"))).toBeUndefined();
    expect(chromeLeaseBackend(getEndpoint("browser"))).toBe("chrome");
    expect(chromeLeaseBackend(getEndpoint("teams2"))).toBe("chrome@teams");
  });

  test("listLeases / listOrigins scope by endpoint: one endpoint's live list never reaps or stales another's", async () => {
    const dir = mkdtempSync(join(scratch, "leases-"));
    process.env.CDP_ARTIFACT_DIR = dir;
    setEnv({ CDP_ENDPOINTS: "teams=http://127.0.0.1:9333" });
    const teams = getEndpoint("teams");
    await withEndpointScope(teams, async () => {
      await claimLease(chromeLeaseBackend(), ID, { label: "t", ttlMs: 60_000 });
      await recordOrigin(chromeLeaseBackend(), ID, { label: "t" });
    });
    await claimLease("chrome", "DEF", { label: "d", ttlMs: 60_000 });
    expect(readdirSync(dir).sort()).toEqual([`lease-chrome-DEF.json`, `lease-chrome@teams-${ID}.json`, `origin-chrome@teams-${ID}.json`].sort());

    // The DEFAULT endpoint's live list does not contain the teams id: target-gone
    // must not fire for the teams lease, and the teams origin must not be reaped.
    const leases = await listLeases({ liveIds: ["DEF"], liveBackend: "chrome" });
    const teamsRow = leases.find((l) => l.backend === "chrome@teams");
    expect(teamsRow?.targetId).toBe(ID);
    expect(teamsRow?.stale).toBe(false);
    const origins = await listOrigins({ liveIds: ["DEF"], liveBackend: "chrome" });
    expect(origins.map((o) => o.backend)).toEqual(["chrome@teams"]);
    expect(readdirSync(dir)).toContain(`origin-chrome@teams-${ID}.json`);

    // Its OWN endpoint's live list does stale/reap it.
    const own = await listLeases({ liveIds: [], liveBackend: "chrome@teams" });
    expect(own.find((l) => l.backend === "chrome@teams")?.stale).toBe("target-gone");
    await listOrigins({ liveIds: [], liveBackend: "chrome@teams" });
    expect(readdirSync(dir)).not.toContain(`origin-chrome@teams-${ID}.json`);
  });
});

/* --------------------------- fake HTTP-only endpoints --------------------------- */

interface FakeTarget { id: string; type: string; url: string; title: string }
function fakeEndpoint(targets: FakeTarget[]): Promise<{ server: Server; base: string }> {
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      const port = (server.address() as { port: number }).port;
      const body =
        req.url === "/json/list" ? targets.map((t) => ({ ...t, webSocketDebuggerUrl: `ws://127.0.0.1:${port}/devtools/page/${t.id}` }))
        : req.url === "/json/version" ? { webSocketDebuggerUrl: `ws://127.0.0.1:${port}/devtools/browser/x` }
        : undefined;
      if (!body) {
        res.writeHead(404).end();
        return;
      }
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(body));
    });
    server.listen(0, "127.0.0.1", () => resolve({ server, base: `http://127.0.0.1:${(server.address() as { port: number }).port}` }));
  });
}

const BROWSER_TARGETS: FakeTarget[] = [{ id: "B0000000000000000000000000000001", type: "page", url: "https://example.test/", title: "Example" }];
const TEAMS_TARGETS: FakeTarget[] = [
  { id: "T0000000000000000000000000000001", type: "page", url: "https://teams.test/host", title: "" },
  { id: "T0000000000000000000000000000002", type: "page", url: "https://teams.test/chat", title: "Chat | Alice" },
];

let browserFake: { server: Server; base: string };
let teamsFake: { server: Server; base: string };
beforeAll(async () => {
  browserFake = await fakeEndpoint(BROWSER_TARGETS);
  teamsFake = await fakeEndpoint(TEAMS_TARGETS);
});
afterAll(() => {
  browserFake.server.close();
  teamsFake.server.close();
});

describe("client discovery and list_pages", () => {
  test("listTargets follows the scope, per call (no restart, nothing cached)", async () => {
    setEnv({ CDP_BASE: browserFake.base, CDP_ENDPOINTS: `teams=${teamsFake.base}` });
    expect((await listTargets()).map((t) => t.id)).toEqual(BROWSER_TARGETS.map((t) => t.id));
    expect((await withEndpointScope(getEndpoint("teams"), () => listTargets())).map((t) => t.id)).toEqual(TEAMS_TARGETS.map((t) => t.id));
    expect((await listTargets()).map((t) => t.id)).toEqual(BROWSER_TARGETS.map((t) => t.id));
  });

  test("an endpoint that is down, then comes up, works with no restart", async () => {
    // Port reserved then released, so it is (very likely) closed for the first call.
    const late = await fakeEndpoint(TEAMS_TARGETS);
    const base = late.base;
    await new Promise<void>((r) => late.server.close(() => r()));
    setEnv({ CDP_ENDPOINTS: `late=${base}` });
    const ep = getEndpoint("late");
    await expect(withEndpointScope(ep, () => listTargets())).rejects.toThrow();
    const port = Number(new URL(base).port);
    const revived = createServer((_req, res) => res.writeHead(200, { "content-type": "application/json" }).end("[]"));
    await new Promise<void>((r) => revived.listen(port, "127.0.0.1", () => r()));
    try {
      expect(await withEndpointScope(ep, () => listTargets())).toEqual([]);
    } finally {
      revived.close();
    }
  });

  test("default-only list_pages output carries no endpoint field; a named endpoint's rows do", async () => {
    process.env.CDP_ARTIFACT_DIR = mkdtempSync(join(scratch, "lp-"));
    setEnv({ CDP_BASE: browserFake.base, CDP_ENDPOINTS: `teams=${teamsFake.base}` });
    const driver = createCdpDriver();
    const def = await listPages(driver, {});
    expect(def.count).toBe(1);
    expect(def.pages[0]).toEqual({ id: BROWSER_TARGETS[0]!.id, url: "https://example.test/", title: "Example", type: "page", origin: "unknown" });
    expect("endpoints" in def).toBe(false);
    const teams = await withEndpointScope(getEndpoint("teams"), () => listPages(driver, {}));
    expect(teams.pages.map((p) => [p.id, p.endpoint])).toEqual(TEAMS_TARGETS.map((t) => [t.id, "teams"]));
  });

  test("allEndpoints: rows tagged by endpoint, a dead port reported down, not thrown", async () => {
    process.env.CDP_ARTIFACT_DIR = mkdtempSync(join(scratch, "lp-"));
    setEnv({ CDP_BASE: browserFake.base, CDP_ENDPOINTS: `teams=${teamsFake.base}?mode=read,dead=${DEAD}` });
    const res = await listPages(createCdpDriver(), { allEndpoints: true });
    expect(res.pages.map((p) => [p.endpoint, p.id])).toEqual([
      ["default", BROWSER_TARGETS[0]!.id],
      ...TEAMS_TARGETS.map((t) => ["teams", t.id]),
    ]);
    expect(res.count).toBe(3);
    expect(res.endpoints!.slice(0, 2)).toEqual([
      { endpoint: "default", base: browserFake.base, readOnly: false, count: 1 },
      { endpoint: "teams", base: teamsFake.base, readOnly: true, count: 2 },
    ]);
    const dead = res.endpoints![2] as { endpoint: string; down?: boolean; error?: string };
    expect(dead.endpoint).toBe("dead");
    expect(dead.down).toBe(true);
    expect(typeof dead.error).toBe("string");
    expect(dead.error!.length).toBeGreaterThan(0);
  });
});

/* -------------------- the real MCP server and CLI entry points -------------------- */

const SERVER = fileURLToPath(new URL("../src/mcp.ts", import.meta.url));
const CLI = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
type Json = Record<string, any>;

function childEnv(overrides: Record<string, string>): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !(KEYS as readonly string[]).includes(k) && k !== "CDP_TOOL_PROFILE" && k !== "CDP_BROWSER") env[k] = v;
  return { ...env, CDP_TOOL_PROFILE: "full", ...overrides };
}

let rpcId = 0;
const call = (name: string, args: Json): Json => ({ jsonrpc: "2.0", id: ++rpcId, method: "tools/call", params: { name, arguments: args } });
const init = (): Json => ({
  jsonrpc: "2.0",
  id: ++rpcId,
  method: "initialize",
  params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "endpoints-test", version: "1" } },
});

async function runServer(msgs: Json[], env: Record<string, string>): Promise<{ res: Json[]; stderr: string; code: number | null }> {
  const child = spawn(process.execPath, [SERVER], { env: childEnv(env), stdio: ["pipe", "pipe", "pipe"] });
  const out = { res: [] as Json[], stderr: "", code: null as number | null };
  const exited = new Promise<void>((r) => child.on("exit", (c) => { out.code = c; r(); }));
  const pending = new Map<number, (m: Json) => void>();
  let buf = "";
  child.stdout.on("data", (chunk: Buffer) => {
    buf += chunk.toString();
    for (let nl = buf.indexOf("\n"); nl >= 0; nl = buf.indexOf("\n")) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      const msg = JSON.parse(line) as Json;
      const settle = pending.get(msg.id as number);
      if (settle) { pending.delete(msg.id as number); settle(msg); }
    }
  });
  child.stderr.on("data", (c: Buffer) => { out.stderr += c.toString(); });
  try {
    if (!msgs.length) {
      await Promise.race([exited, new Promise((_, rej) => setTimeout(() => rej(new Error(`no exit; stderr:\n${out.stderr}`)), 10_000))]);
      return out;
    }
    for (const msg of msgs) {
      child.stdin.write(`${JSON.stringify(msg)}\n`);
      out.res.push(await new Promise<Json>((resolve, reject) => {
        const t = setTimeout(() => reject(new Error(`no reply to ${msg.id}; stderr:\n${out.stderr}`)), 10_000);
        pending.set(msg.id as number, (m) => { clearTimeout(t); resolve(m); });
      }));
    }
  } finally {
    child.kill();
  }
  return out;
}
const textOf = (r: Json): string => (r.result.content as Array<{ text?: string }>).map((c) => c.text ?? "").join("");

describe("MCP dispatch (real src/mcp.ts child)", () => {
  let out: { res: Json[]; stderr: string };
  beforeAll(async () => {
    out = await runServer(
      [
        init(),
        call("list_pages", {}),
        call("list_pages", { endpoint: "teams" }),
        call("call_tool", { name: "list_pages", arguments: { allEndpoints: true } }),
        call("list_pages", { endpoint: "nope" }),
        call("release_page", { target: "endpoint:teams/title:Chat" }),
        call("call_tool", { name: "release_page", arguments: { target: "endpoint:teams/title:Chat" } }),
        call("release_page", { target: "title:Chat" }),
        call("release_page", { target: "endpoint:teams/title:Chat", endpoint: "default" }),
      ],
      {
        CDP_BASE: browserFake.base,
        // teams is WRITABLE here: release_page (MUTATING) is the prefix probe, and a read-only
        // endpoint would refuse it before the picker ran. The read-only policy itself is
        // covered against recording fakes in test/endpoints-acceptance.test.ts.
        CDP_ENDPOINTS: `teams=${teamsFake.base},dead=${DEAD}`,
        CDP_ARTIFACT_DIR: mkdtempSync(join(scratch, "mcp-")),
      },
    );
  }, 30_000);

  test("startup log names the endpoints", () => {
    expect(out.stderr).toContain(`CDP_BASE=${browserFake.base}, endpoints=default=${browserFake.base},teams=${teamsFake.base},dead=${DEAD}`);
  });

  test("consecutive calls reach two endpoints with no restart", () => {
    const def = JSON.parse(textOf(out.res[1]!));
    expect(def.pages.map((p: Json) => p.id)).toEqual([BROWSER_TARGETS[0]!.id]);
    expect(def.pages[0].endpoint).toBeUndefined();
    const teams = JSON.parse(textOf(out.res[2]!));
    expect(teams.pages.map((p: Json) => [p.id, p.endpoint])).toEqual(TEAMS_TARGETS.map((t) => [t.id, "teams"]));
  });

  test("call_tool list_pages{allEndpoints} lists both and reports the dead one down", () => {
    const all = JSON.parse(textOf(out.res[3]!));
    expect(all.pages.length).toBe(3);
    expect(all.endpoints.map((e: Json) => [e.endpoint, e.down === true])).toEqual([["default", false], ["teams", false], ["dead", true]]);
  });

  test("an unknown endpoint is an isError result naming the known ones", () => {
    expect(out.res[4]!.result.isError).toBe(true);
    expect(textOf(out.res[4]!)).toContain("unknown endpoint 'nope' (known: default, teams, dead)");
  });

  test("the prefix is stripped before the picker, directly and through call_tool", () => {
    for (const r of [out.res[5]!, out.res[6]!]) {
      expect(r.result.isError).toBeFalsy();
      expect(JSON.parse(textOf(r))).toEqual({ released: false, closed: false, targetId: TEAMS_TARGETS[1]!.id });
    }
    // Same selector without the prefix goes to the default endpoint, which has no Chat page.
    expect(out.res[7]!.result.isError).toBe(true);
    expect(textOf(out.res[7]!)).toContain("no page title containing 'Chat'");
  });

  test("a prefix and an endpoint arg that disagree are refused", () => {
    expect(out.res[8]!.result.isError).toBe(true);
    expect(textOf(out.res[8]!)).toContain("conflicting endpoints");
  });
});

describe("a down endpoint never reaps its own leases (strict-lease server)", () => {
  test("list_pages{allEndpoints} and list_leases leave the dead endpoint's files; a live endpoint's stale origin IS reaped", async () => {
    const dir = mkdtempSync(join(scratch, "reap-"));
    process.env.CDP_ARTIFACT_DIR = dir;
    setEnv({ CDP_BASE: browserFake.base, CDP_ENDPOINTS: `teams=${teamsFake.base},dead=${DEAD}` });
    const DEAD_ID = "D0000000000000000000000000000001";
    const GONE_ID = "G0000000000000000000000000000001";
    await withEndpointScope(getEndpoint("dead"), async () => {
      await claimLease(chromeLeaseBackend(), DEAD_ID, { label: "d", ttlMs: 1 });
      await recordOrigin(chromeLeaseBackend(), DEAD_ID, { label: "d" });
    });
    // Control: an origin on the LIVE teams endpoint for an id teams does not list.
    await withEndpointScope(getEndpoint("teams"), () => recordOrigin(chromeLeaseBackend(), GONE_ID, { label: "g" }));
    await new Promise((r) => setTimeout(r, 10)); // the dead lease is now past its 1ms TTL
    const before = readdirSync(dir).sort();
    expect(before).toEqual([`lease-chrome@dead-${DEAD_ID}.json`, `origin-chrome@dead-${DEAD_ID}.json`, `origin-chrome@teams-${GONE_ID}.json`].sort());

    const o = await runServer(
      [init(), call("list_pages", { allEndpoints: true }), call("list_leases", { endpoint: "dead" })],
      { CDP_BASE: browserFake.base, CDP_ENDPOINTS: `teams=${teamsFake.base},dead=${DEAD}`, CDP_ARTIFACT_DIR: dir, CDP_REQUIRE_LEASE: "1" },
    );
    const all = JSON.parse(textOf(o.res[1]!));
    expect(all.endpoints.find((e: Json) => e.endpoint === "dead").down).toBe(true);
    expect(o.res[2]!.result.isError).toBe(true); // unreachable endpoint: the tool fails, it does not guess
    const after = readdirSync(dir);
    expect(after).toContain(`lease-chrome@dead-${DEAD_ID}.json`);
    expect(after).toContain(`origin-chrome@dead-${DEAD_ID}.json`);
    expect(after).not.toContain(`origin-chrome@teams-${GONE_ID}.json`);
  }, 30_000);
});

describe("MCP startup and Firefox refusal", () => {
  test("malformed CDP_ENDPOINTS is a named startup error, exit 1", async () => {
    const o = await runServer([], { CDP_ENDPOINTS: "teams=http://127.0.0.1:9333?mode=nope" });
    expect(o.code).toBe(1);
    expect(o.stderr).toContain("unknown mode 'nope'");
  }, 20_000);

  test("CDP_BASE-only startup line is unchanged (no endpoints suffix)", async () => {
    const o = await runServer([init()], { CDP_BASE: DEAD });
    expect(o.stderr).toContain(`CDP_BASE=${DEAD}\n`);
    expect(o.stderr).not.toContain("endpoints=");
  }, 20_000);

  test("Firefox backend refuses endpoint selectors before touching any browser", async () => {
    const o = await runServer(
      [init(), call("list_pages", { allEndpoints: true }), call("take_snapshot", { target: "endpoint:teams/title:Chat" })],
      { CDP_BROWSER: "firefox", CDP_ENDPOINTS: "broken config is never read" },
    );
    for (const r of o.res.slice(1)) {
      expect(r.result.isError).toBe(true);
      expect(textOf(r)).toContain("need the Chrome backend");
    }
  }, 20_000);
});

describe("CLI dispatch (real src/cli.ts child)", () => {
  function runCli(args: string[], env: Record<string, string>): Promise<{ code: number | null; stdout: string; stderr: string }> {
    return new Promise((resolve) => {
      const child = spawn(process.execPath, [CLI, ...args], { env: childEnv(env), stdio: ["ignore", "pipe", "pipe"] });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (c: Buffer) => (stdout += c.toString()));
      child.stderr.on("data", (c: Buffer) => (stderr += c.toString()));
      child.on("exit", (code) => resolve({ code, stdout, stderr }));
    });
  }
  const envFor = () => ({ CDP_BASE: browserFake.base, CDP_ENDPOINTS: `teams=${teamsFake.base}`, CDP_ARTIFACT_DIR: mkdtempSync(join(scratch, "cli-")) });

  test("--endpoint teams lists the teams endpoint", async () => {
    const r = await runCli(["list_pages", "--endpoint", "teams"], envFor());
    expect(r.code).toBe(0);
    expect(JSON.parse(r.stdout).pages.map((p: Json) => p.endpoint)).toEqual(["teams", "teams"]);
  }, 20_000);

  test("--target endpoint:teams/title:Chat resolves on the teams endpoint", async () => {
    const r = await runCli(["release_page", "--target", "endpoint:teams/title:Chat"], envFor());
    expect(r.code).toBe(0);
    expect(JSON.parse(r.stdout)).toEqual({ released: false, closed: false, targetId: TEAMS_TARGETS[1]!.id });
  }, 20_000);

  test("an unknown endpoint is a JSON error, exit 1", async () => {
    const r = await runCli(["list_pages", "--endpoint", "nope"], envFor());
    expect(r.code).toBe(1);
    expect(JSON.parse(r.stderr).error).toContain("unknown endpoint 'nope'");
  }, 20_000);
});
