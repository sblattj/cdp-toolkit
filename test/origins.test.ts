/**
 * Unit tests for the tab-origin creation ledger (src/origins.ts) and the
 * list_pages annotation built on it.
 *
 * The last describe block is the one that matters most and is not optional.
 * Every other test here calls an implementation function directly, which is
 * exactly the shape that let a previous bug in this repo ship green: an
 * intermediate layer can reshape or swallow a result while every direct-call
 * test still passes. So the last block spawns the REAL MCP server as a
 * subprocess, speaks the real protocol to it over stdio, and asserts on the
 * structure a consumer actually receives. It fakes only the browser's HTTP
 * endpoint, on an EPHEMERAL port chosen by the OS (never a hardcoded one), so
 * the whole toolkit path above that endpoint is the real code.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { createServer, type Server } from "node:http";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { BrowserDriver, PageInfo } from "../src/driver.ts";
import { claimPage, releasePage } from "../src/leases-tools.ts";
import { listPages, newPage } from "../src/shared-tools.ts";
import { listOrigins, originFile, readOrigin, recordOrigin } from "../src/origins.ts";

let dir = "";
const originalArtifactDir = process.env.CDP_ARTIFACT_DIR;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "cdp-origins-"));
  process.env.CDP_ARTIFACT_DIR = dir;
});

afterAll(async () => {
  if (originalArtifactDir === undefined) delete process.env.CDP_ARTIFACT_DIR;
  else process.env.CDP_ARTIFACT_DIR = originalArtifactDir;
  await rm(dir, { recursive: true, force: true });
});

beforeEach(async () => {
  // mkdir first: one test deletes the directory outright to prove a missing
  // ledger degrades rather than throws, so this must be able to rebuild it.
  await mkdir(dir, { recursive: true });
  for (const f of await readdir(dir)) await rm(join(dir, f), { force: true });
});

/** Minimal BrowserDriver stand-in: only the members these tools touch. */
function stubDriver(opts: { scheme?: string; pages?: PageInfo[]; listAllThrows?: boolean } = {}) {
  const pages: PageInfo[] = [...(opts.pages ?? [])];
  let created = 0;
  const driver = {
    scheme: opts.scheme ?? "cdp",
    async listPages(o?: { all?: boolean }): Promise<PageInfo[]> {
      if (o?.all && opts.listAllThrows) throw new Error("browser unreachable");
      return [...pages];
    },
    async newPage(url?: string): Promise<PageInfo> {
      const p: PageInfo = { id: `NEW-${++created}`, url: url ?? "about:blank", title: "", type: "page" };
      pages.push(p);
      return p;
    },
    async closePage(id: string): Promise<{ success: boolean }> {
      const i = pages.findIndex((p) => p.id === id);
      if (i >= 0) pages.splice(i, 1);
      return { success: true };
    },
    async activatePage(id: string): Promise<PageInfo> {
      return pages.find((p) => p.id === id) ?? { id, url: "", title: "" };
    },
  };
  return { driver: driver as unknown as BrowserDriver, pages };
}

const page = (id: string): PageInfo => ({ id, url: `https://example.test/${id}`, title: id, type: "page" });

describe("the ledger records what the toolkit creates", () => {
  test("new_page writes a record with the caller's label, whether or not it claims", async () => {
    const { driver } = stubDriver();
    const res = await newPage(driver, { claim: false, label: "agent-one" });
    const rec = await readOrigin("chrome", res.targetId);
    expect(rec).toMatchObject({ backend: "chrome", targetId: res.targetId, label: "agent-one", pid: process.pid });
    expect(typeof rec?.createdAt).toBe("number");
  });

  test("no label falls back to the same pid-<pid> default the lease code uses", async () => {
    const { driver } = stubDriver();
    const res = await newPage(driver, { claim: true });
    expect((await readOrigin("chrome", res.targetId))?.label).toBe(`pid-${process.pid}`);
  });

  test("claim_page with no targetId records the tab it opened", async () => {
    const { driver } = stubDriver();
    const res = await claimPage(driver, { label: "agent-two" });
    expect((await readOrigin("chrome", res.targetId))?.label).toBe("agent-two");
  });

  test("claim_page on an EXISTING tab records nothing: provenance is not ownership", async () => {
    const { driver } = stubDriver({ pages: [page("HUMAN-TAB")] });
    await claimPage(driver, { targetId: "HUMAN-TAB", label: "agent-two" });
    expect(await readOrigin("chrome", "HUMAN-TAB")).toBeUndefined();
  });

  test("a bidi driver records under the firefox backend, not chrome", async () => {
    const { driver } = stubDriver({ scheme: "bidi" });
    const res = await newPage(driver, { label: "ffx" });
    expect(await readOrigin("firefox", res.targetId)).toBeDefined();
    expect(await readOrigin("chrome", res.targetId)).toBeUndefined();
  });
});

describe("list_pages annotates origin", () => {
  test("a tab the toolkit created reports origin agent, with label and createdAt", async () => {
    const { driver } = stubDriver();
    const created = await newPage(driver, { label: "agent-one" });
    const rec = await readOrigin("chrome", created.targetId);
    const { pages } = await listPages(driver, {});
    const hit = pages.find((p) => p.id === created.targetId);
    expect(hit?.origin).toBe("agent");
    expect(hit?.label).toBe("agent-one");
    expect(hit?.createdAt).toBe(rec!.createdAt);
  });

  test("a tab the toolkit did NOT create reports unknown, and never human", async () => {
    const { driver } = stubDriver({ pages: [page("HUMAN-TAB")] });
    const { pages } = await listPages(driver, {});
    const hit = pages.find((p) => p.id === "HUMAN-TAB");
    expect(hit?.origin).toBe("unknown");
    expect(hit).not.toHaveProperty("label");
    expect(hit).not.toHaveProperty("createdAt");
    for (const p of pages) expect(p.origin).not.toBe("human");
  });

  test("the record OUTLIVES the lease: still agent after release_page", async () => {
    const { driver } = stubDriver();
    const created = await newPage(driver, { claim: true, label: "agent-one" });
    const released = await releasePage(driver, { lease: created.lease });
    expect(released.released).toBe(true);
    const { pages } = await listPages(driver, {});
    const hit = pages.find((p) => p.id === created.targetId);
    expect(hit?.origin).toBe("agent");
    expect(hit?.label).toBe("agent-one");
  });

  test("the record also outlives a lease that was never taken at all", async () => {
    const { driver } = stubDriver();
    const created = await newPage(driver, { claim: false, label: "agent-one" });
    const { pages } = await listPages(driver, {});
    expect(pages.find((p) => p.id === created.targetId)?.origin).toBe("agent");
  });

  test("the legacy page fields are untouched: additive only", async () => {
    const { driver } = stubDriver({ pages: [page("HUMAN-TAB")] });
    const { pages, count } = await listPages(driver, {});
    expect(count).toBe(1);
    expect(pages[0]).toMatchObject({ id: "HUMAN-TAB", url: "https://example.test/HUMAN-TAB", title: "HUMAN-TAB", type: "page" });
  });
});

describe("the ledger reaps on read", () => {
  test("a closed tab's record is dropped the next time pages are listed", async () => {
    const { driver } = stubDriver();
    const created = await newPage(driver, { label: "agent-one" });
    expect(await readOrigin("chrome", created.targetId)).toBeDefined();
    await driver.closePage(created.targetId);
    await listPages(driver, {});
    expect(await readOrigin("chrome", created.targetId)).toBeUndefined();
    expect(await listOrigins({})).toEqual([]);
  });

  test("a live tab's record survives a reap", async () => {
    const { driver } = stubDriver();
    const keep = await newPage(driver, { label: "agent-one" });
    const drop = await newPage(driver, { label: "agent-one" });
    await driver.closePage(drop.targetId);
    await listPages(driver, {});
    expect(await readOrigin("chrome", keep.targetId)).toBeDefined();
    expect(await readOrigin("chrome", drop.targetId)).toBeUndefined();
  });

  test("a failed target enumeration reaps NOTHING rather than emptying the ledger", async () => {
    const { driver } = stubDriver({ listAllThrows: true });
    const created = await newPage(driver, { label: "agent-one" });
    await driver.closePage(created.targetId);
    // The unfiltered listing throws, so there is no trustworthy reap set. The
    // record must survive: losing provenance to a transient browser error is
    // strictly worse than keeping a stale row until the next successful read.
    const { pages } = await listPages(driver, {});
    expect(pages).toEqual([]);
    expect(await readOrigin("chrome", created.targetId)).toBeDefined();
  });

  test("a Chrome target list never reaps a Firefox record", async () => {
    await recordOrigin("firefox", "FFX-CTX", { label: "ffx" });
    const { driver } = stubDriver();
    await listPages(driver, {});
    expect(await readOrigin("firefox", "FFX-CTX")).toBeDefined();
  });
});

describe("a corrupt ledger degrades honestly", () => {
  test("an unparseable record does not throw and does not read as a clean unknown", async () => {
    await recordOrigin("chrome", "A", { label: "agent-one" });
    await writeFile(originFile("chrome", "A"), "{not json", "utf8");
    const { driver } = stubDriver({ pages: [page("A"), page("B")] });
    const { pages } = await listPages(driver, {});
    const corrupt = pages.find((p) => p.id === "A");
    const clean = pages.find((p) => p.id === "B");
    // Both report origin "unknown", because provenance genuinely IS unknown for
    // a record that cannot be read. What must NOT happen is the two rows being
    // indistinguishable: A has a record and B does not, and only A carries the
    // marker that says so.
    expect(corrupt?.origin).toBe("unknown");
    expect(corrupt?.originUnreadable).toBe("unparseable");
    expect(clean?.origin).toBe("unknown");
    expect(clean?.originUnreadable).toBeUndefined();
  });

  test("listOrigins reports the broken row rather than skipping it", async () => {
    await recordOrigin("chrome", "A", { label: "agent-one" });
    await writeFile(originFile("chrome", "A"), "{not json", "utf8");
    const rows = await listOrigins({});
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ backend: "chrome", targetId: "A", unreadable: "unparseable" });
  });

  test("a ledger directory that does not exist reports every page as unknown", async () => {
    await rm(dir, { recursive: true, force: true });
    const { driver } = stubDriver({ pages: [page("A")] });
    const { pages } = await listPages(driver, {});
    expect(pages[0]?.origin).toBe("unknown");
    expect(pages[0]?.originUnreadable).toBeUndefined();
  });

  test("a record for a REUSED target id is replaced by the newer creation", async () => {
    await recordOrigin("chrome", "REUSED", { label: "old-agent", now: 1_000 });
    await recordOrigin("chrome", "REUSED", { label: "new-agent", now: 2_000 });
    expect(await readOrigin("chrome", "REUSED")).toMatchObject({ label: "new-agent", createdAt: 2_000 });
  });
});

/* ------------------- the real entry point, end to end ------------------- */

/**
 * Everything above drives implementation functions. This block drives what a
 * CONSUMER drives: the MCP server process, over the MCP protocol, through the
 * real TOOLS registry, the real CDP driver, and real HTTP. If any layer in
 * between were to drop, rename, or reshape the provenance fields, only a test
 * of this shape can see it.
 */
describe("list_pages over the real MCP server", () => {
  let http: Server | undefined;
  let base = "";
  let client: Client | undefined;

  beforeAll(async () => {
    http = createServer((req, res) => {
      if (req.url?.startsWith("/json/list")) {
        res.setHeader("content-type", "application/json");
        res.end(
          JSON.stringify([
            { id: "PAGE-AGENT", type: "page", url: "https://example.test/agent", title: "agent tab", webSocketDebuggerUrl: "" },
            { id: "PAGE-STRANGER", type: "page", url: "https://example.test/stranger", title: "stranger tab", webSocketDebuggerUrl: "" },
          ]),
        );
        return;
      }
      res.statusCode = 404;
      res.end("{}");
    });
    await new Promise<void>((resolve) => http!.listen(0, "127.0.0.1", resolve));
    // Ephemeral, OS-assigned: this test must never depend on a particular port.
    base = `http://127.0.0.1:${(http!.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await client?.close().catch(() => undefined);
    await new Promise<void>((resolve) => (http ? http.close(() => resolve()) : resolve()));
  });

  afterEach(async () => {
    await client?.close().catch(() => undefined);
    client = undefined;
  });

  async function connect(): Promise<Client> {
    const serverPath = fileURLToPath(new URL("../src/mcp.ts", import.meta.url));
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v;
    env.CDP_BASE = base;
    env.CDP_ARTIFACT_DIR = dir;
    const transport = new StdioClientTransport({ command: process.execPath, args: [serverPath], env });
    const c = new Client({ name: "cdp-origins-test", version: "0.0.0" });
    await c.connect(transport);
    client = c;
    return c;
  }

  function payload(res: unknown): { pages: Array<Record<string, unknown>>; count: number } {
    const r = res as { content: Array<{ text?: string }>; isError?: boolean };
    expect(r.isError).toBeFalsy();
    return JSON.parse(r.content.map((c) => c.text ?? "").join(""));
  }

  test("a page with a creation record arrives at the consumer as origin agent", async () => {
    await recordOrigin("chrome", "PAGE-AGENT", { label: "agent-seven", now: 1_700_000_000_000 });
    const c = await connect();
    const { pages, count } = payload(await c.callTool({ name: "list_pages", arguments: {} }));
    expect(count).toBe(2);
    const agent = pages.find((p) => p.id === "PAGE-AGENT");
    const stranger = pages.find((p) => p.id === "PAGE-STRANGER");
    // Identity and structure, not message text: a rewrap can preserve a
    // substring by accident, it cannot preserve a field it dropped.
    expect(agent).toEqual({
      id: "PAGE-AGENT",
      url: "https://example.test/agent",
      title: "agent tab",
      type: "page",
      origin: "agent",
      label: "agent-seven",
      createdAt: 1_700_000_000_000,
    });
    expect(stranger).toEqual({
      id: "PAGE-STRANGER",
      url: "https://example.test/stranger",
      title: "stranger tab",
      type: "page",
      origin: "unknown",
    });
  }, 30_000);

  test("with an empty ledger every page arrives as unknown, and the legacy fields still do", async () => {
    const c = await connect();
    const { pages } = payload(await c.callTool({ name: "list_pages", arguments: {} }));
    for (const p of pages) {
      expect(p.origin).toBe("unknown");
      expect(typeof p.id).toBe("string");
      expect(typeof p.url).toBe("string");
      expect(typeof p.title).toBe("string");
    }
  }, 30_000);

  test("the advertised tool description tells the consumer origin is never 'human'", async () => {
    const c = await connect();
    const { tools } = await c.listTools();
    const spec = tools.find((t) => t.name === "list_pages");
    expect(spec?.description).toContain("never says 'human'");
    expect(spec?.description).toContain("origin");
  }, 30_000);
});
