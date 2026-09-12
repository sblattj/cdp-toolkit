/**
 * Unit tests for extract_page (src/tools/extract.ts) — schema-conformant JSON
 * extraction from a page's cleaned HTML via an OpenAI-compatible endpoint.
 *
 * Everything here runs WITHOUT a browser: driver.page() is stubbed to a page
 * whose evaluate() returns the in-page cleaning result, and globalThis.fetch is
 * stubbed per test following the leases.test.ts resolveTarget precedent
 * (save the real fetch, assign a recording stub, restore).
 *
 * The properties this file pins:
 *   1. ARG/SCHEMA VALIDATION refuses before any page or network work — the
 *      schema IS the prompt here, so a schema with no descriptions must fail
 *      up front rather than produce garbage extraction with no hint why.
 *   2. THE WIRE SHAPE — temperature 0, max_tokens 8192, strict json_schema
 *      response_format, and the CLEANED html as the user message. The endpoint
 *      contract is the one thing a refactor could silently break.
 *   3. THE KEY NEVER LEAKS — CDP_EXTRACT_API_KEY may ride the Authorization
 *      header but must not survive into any thrown error string, including one
 *      whose body echoes it back (the 401 case).
 *   4. The size guard refuses BEFORE the paid network call (no silent
 *      truncation, and no fetch either).
 *   5. savePath sinks the whole result and returns only {path,bytes,target}.
 *
 * Written against the extract_page spec while src/tools/extract.ts was still
 * being implemented; assumptions that could not be pinned from the spec are
 * marked with TODO and reconciled against the implementation once it landed.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CdpError } from "../src/client.ts";
import type { BrowserDriver, PageDriver, PageInfo } from "../src/driver.ts";
import { extractPage } from "../src/tools/extract.ts";
import { MANIFEST } from "../src/manifest.ts";
import { TOOL_DOCS } from "../src/toolDocs.ts";
import { GROUP_TOOLS } from "../src/toolGroups.ts";
import { TOOLS, TOOL_NAMES } from "../src/index.ts";

/* ------------------------------- stubs -------------------------------- */

const INFO: PageInfo = { id: "TAB-X", url: "https://example.test/report", title: "Report", type: "page" };

/** What the in-page evaluate() returns: the cleaning result the spec defines. */
interface Cleaning {
  html: string;
  rawBytes: number;
  cleanBytes: number;
  dropped: Record<string, number>;
}

const CLEANING: Cleaning = {
  html: "<main><h1>Quarterly Report</h1><p>Revenue up 12%</p></main>",
  rawBytes: 5000,
  cleanBytes: 48,
  dropped: { scripts: 3, styles: 2, hidden: 1 },
};

/**
 * Minimal driver stand-in, cookies.test.ts pattern: only page() (with a
 * release-counting page whose evaluate returns `cleaning`) plus listPages, in
 * case the implementation routes resolution through resolvePage first.
 */
function stubExtractDriver(cleaning: Partial<Cleaning> = {}) {
  const result: Cleaning = { ...CLEANING, ...cleaning };
  let released = 0;
  const evaluated: string[] = [];
  const page = {
    info: INFO,
    async evaluate(expression: string): Promise<unknown> {
      evaluated.push(expression);
      return { ...result };
    },
    async release(): Promise<void> {
      released += 1;
    },
  };
  const driver = {
    scheme: "cdp",
    async listPages(): Promise<PageInfo[]> {
      return [INFO];
    },
    async page(_sel?: unknown): Promise<PageDriver> {
      return page as unknown as PageDriver;
    },
  };
  return { driver: driver as unknown as BrowserDriver, cleaning: result, releases: () => released, evaluated };
}

/** The env surface the spec gives the tool. Saved/deleted in beforeEach,
 *  restored in afterEach, so every test sees the documented defaults unless it
 *  sets an override itself — a host-exported CDP_EXTRACT_MODEL cannot flake CI. */
const ENV_VARS = ["CDP_EXTRACT_BASE_URL", "CDP_EXTRACT_MODEL", "CDP_EXTRACT_API_KEY", "CDP_EXTRACT_TIMEOUT_MS", "CDP_EXTRACT_MAX_CHARS"] as const;
const savedEnv: Record<string, string | undefined> = {};

const realFetch = globalThis.fetch;

beforeEach(() => {
  for (const v of ENV_VARS) {
    savedEnv[v] = process.env[v];
    delete process.env[v];
  }
});

afterEach(() => {
  for (const v of ENV_VARS) {
    const val = savedEnv[v];
    if (val === undefined) delete process.env[v];
    else process.env[v] = val;
  }
  globalThis.fetch = realFetch;
});

/** Recording fetch stub. The handler throwing means "fetch must not have been
 *  called", which makes over-eager implementations fail their matcher instead
 *  of silently passing. */
function stubFetch(handler: (url: string, init: RequestInit) => Response | Promise<Response>) {
  const calls: { url: string; init: RequestInit }[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(typeof input === "object" && "url" in input ? input.url : input);
    calls.push({ url, init: init ?? {} });
    return handler(url, init ?? {});
  }) as typeof fetch;
  return calls;
}

/** A fetch stub that records calls and always fails loudly — for tests whose
 *  contract is that the network is never reached. */
function forbidFetch() {
  return stubFetch(() => {
    throw new Error("unexpected fetch: this test must not reach the endpoint");
  });
}

/** init.headers arrives as object, Headers, or [k,v][] depending on the impl;
 *  normalize so the Authorization assertions don't depend on that choice. */
function headerValue(init: RequestInit, name: string): string | undefined {
  const h = init.headers;
  if (!h) return undefined;
  if (h instanceof Headers) return h.get(name) ?? undefined;
  if (Array.isArray(h)) {
    const hit = (h as readonly [string, string][]).find(([k]) => k.toLowerCase() === name.toLowerCase());
    return hit?.[1];
  }
  for (const [k, v] of Object.entries(h as Record<string, string>)) {
    if (k.toLowerCase() === name.toLowerCase()) return v;
  }
  return undefined;
}

/** An OpenAI-compatible success response with a known payload and usage block. */
function completionResponse(overrides: Record<string, unknown> = {}): Response {
  return new Response(
    JSON.stringify({
      choices: [{ message: { content: JSON.stringify({ title: "Quarterly Report" }) } }],
      model: "schematron",
      usage: { prompt_tokens: 101, completion_tokens: 7, total_tokens: 108 },
      ...overrides,
    }),
    { headers: { "content-type": "application/json" } },
  );
}

/** Capture the thrown error, failing the test on an unexpected resolve. */
async function rejection(p: Promise<unknown>): Promise<Error> {
  return p.then(
    () => {
      throw new Error("expected a rejection, got a resolve");
    },
    (e: Error) => e,
  );
}

/** A schema that satisfies the description rule: ≥1 described property. */
const VALID_SCHEMA = {
  type: "object",
  properties: {
    title: { type: "string", description: "the page's main heading, exactly as printed" },
  },
  required: ["title"],
} as const;

/* --------------------------- 1. arg validation --------------------------- */

describe("arg/schema validation refuses before any page or network work", () => {
  test("a missing schema is rejected as a CdpError", async () => {
    const calls = forbidFetch();
    const { driver } = stubExtractDriver();
    const err = await rejection(extractPage(driver, {} as never));
    expect(err).toBeInstanceOf(CdpError);
    expect(err.message.toLowerCase()).toContain("schema");
    expect(calls.length).toBe(0);
  });

  test("a non-object root is rejected", async () => {
    const calls = forbidFetch();
    const { driver } = stubExtractDriver();
    const err = await rejection(
      extractPage(driver, { schema: { type: "string", description: "nope" } } as never),
    );
    expect(err).toBeInstanceOf(CdpError);
    expect(calls.length).toBe(0);
  });

  test("additionalProperties:true is rejected", async () => {
    const calls = forbidFetch();
    const { driver } = stubExtractDriver();
    const err = await rejection(
      extractPage(driver, {
        schema: { type: "object", additionalProperties: true, properties: { a: { type: "string", description: "x" } } },
      } as never),
    );
    expect(err).toBeInstanceOf(CdpError);
    expect(calls.length).toBe(0);
  });

  test("a schema with zero property descriptions is rejected", async () => {
    const calls = forbidFetch();
    const { driver } = stubExtractDriver();
    const err = await rejection(
      extractPage(driver, {
        schema: { type: "object", properties: { title: { type: "string" }, year: { type: "number" } } },
      } as never),
    );
    expect(err).toBeInstanceOf(CdpError);
    // The description rule exists because descriptions ARE the prompt; the
    // error must say what to fix, not just "invalid schema".
    expect(err.message.toLowerCase()).toContain("description");
    expect(calls.length).toBe(0);
  });

  test("a valid minimal schema passes validation and extracts", async () => {
    stubFetch(() => completionResponse());
    const { driver, releases } = stubExtractDriver();
    const result = (await extractPage(driver, { schema: VALID_SCHEMA })) as Record<string, unknown>;
    expect(result.data).toEqual({ title: "Quarterly Report" });
    expect(releases()).toBe(1);
  });
});

/* ------------------------------ 2. source arm --------------------------- */

describe("source:'served' is a loud not-implemented, not a guess", () => {
  test("served refuses with a not-implemented error naming the arm, before any fetch", async () => {
    const calls = forbidFetch();
    const { driver } = stubExtractDriver();
    const err = await rejection(extractPage(driver, { schema: VALID_SCHEMA, source: "served" } as never));
    expect(err).toBeInstanceOf(CdpError);
    expect(err.message.toLowerCase()).toMatch(/implement/);
    expect(err.message).toContain("served");
    expect(calls.length).toBe(0);
  });
});

/* --------------------------- 3. registration ---------------------------- */

describe("registration: registry, manifest, docs, groups", () => {
  test("extract_page is in the TOOLS registry and TOOL_NAMES", () => {
    expect(typeof TOOLS["extract_page"]).toBe("function");
    expect(TOOL_NAMES).toContain("extract_page");
  });

  test("the manifest entry forbids unknown params and requires exactly the schema", () => {
    const entry = MANIFEST.find((m) => m.name === "extract_page");
    expect(entry, "extract_page manifest entry").toBeDefined();
    expect(entry!.inputSchema.additionalProperties).toBe(false);
    expect(entry!.inputSchema.required).toEqual(["schema"]);
  });

  test("the manifest documents every documented param — no silent arg drift", () => {
    const entry = MANIFEST.find((m) => m.name === "extract_page")!;
    const props = Object.keys(entry.inputSchema.properties ?? {}).sort();
    expect(props).toEqual(
      ["baseUrl", "clean", "lease", "maxChars", "model", "savePath", "schema", "selector", "source", "target", "timeoutMs"].sort(),
    );
  });

  test("the toolDocs description is substantial", () => {
    expect(TOOL_DOCS["extract_page"]?.description.length ?? 0).toBeGreaterThan(40);
  });

  test("it lives in the extraction group", () => {
    expect(GROUP_TOOLS.extraction).toContain("extract_page");
  });
});

/* ---------------------------- 4. happy path ----------------------------- */

describe("the wire shape: what actually goes over fetch", () => {
  const BASE = "http://loopback.test/v1";

  test("POSTs baseUrl+/chat/completions with temperature 0, max_tokens 8192, strict json_schema, and the CLEANED html", async () => {
    process.env.CDP_EXTRACT_BASE_URL = BASE;
    const calls = stubFetch(() => completionResponse());
    const { driver, cleaning } = stubExtractDriver();

    const result = (await extractPage(driver, { schema: VALID_SCHEMA })) as Record<string, unknown>;

    expect(calls.length).toBe(1);
    const { url, init } = calls[0]!;
    expect(url).toBe(`${BASE}/chat/completions`);
    expect(init.method).toBe("POST");
    // The call is budgeted: a wedged endpoint must expire, never hang.
    expect(init.signal).toBeTruthy();

    const body = JSON.parse(String(init.body)) as {
      model: string;
      temperature: number;
      max_tokens: number;
      messages: { role: string; content: string }[];
      response_format: { type: string; json_schema: { name: string; strict: boolean; schema: unknown } };
    };
    expect(body.model).toBe("schematron");
    expect(body.temperature).toBe(0);
    expect(body.max_tokens).toBe(8192);
    expect(body.messages.length).toBe(1);
    expect(body.messages[0]!.role).toBe("user");
    // The payload is the CLEANED html from the in-page evaluate, not the raw one.
    expect(body.messages[0]!.content).toBe(cleaning.html);
    expect(body.response_format.type).toBe("json_schema");
    expect(body.response_format.json_schema.name).toBe("extract");
    expect(body.response_format.json_schema.strict).toBe(true);
    expect(body.response_format.json_schema.schema).toEqual(VALID_SCHEMA);

    // TODO(spec-assumed): result shape per spec — data/model/usage passthrough
    // (snake_case endpoint fields mapped to camelCase), html accounting block,
    // legacy 3-field target.
    expect(result.data).toEqual({ title: "Quarterly Report" });
    expect(result.model).toBe("schematron");
    expect(result.usage).toMatchObject({ promptTokens: 101, completionTokens: 7, totalTokens: 108 });
    const html = result.html as Record<string, unknown>;
    expect(html.source).toBe("dom");
    expect(html.rawBytes).toBe(cleaning.rawBytes);
    expect(html.cleanBytes).toBe(cleaning.cleanBytes);
    expect(html.dropped).toEqual(cleaning.dropped);
    expect(typeof html.estTokens).toBe("number");
    expect(result.target).toEqual({ id: INFO.id, url: INFO.url, title: INFO.title });
  });

  test("the Authorization header rides along iff CDP_EXTRACT_API_KEY is set", async () => {
    process.env.CDP_EXTRACT_BASE_URL = BASE;
    const key = "sk-seekrit00001111"; // matches /sk-\w{8,}/ like a real key

    const withKey = stubFetch(() => completionResponse());
    process.env.CDP_EXTRACT_API_KEY = key;
    await extractPage(stubExtractDriver().driver, { schema: VALID_SCHEMA });
    expect(headerValue(withKey[0]!.init, "authorization")).toBe(`Bearer ${key}`);

    const withoutKey = stubFetch(() => completionResponse());
    delete process.env.CDP_EXTRACT_API_KEY;
    await extractPage(stubExtractDriver().driver, { schema: VALID_SCHEMA });
    expect(headerValue(withoutKey[0]!.init, "authorization")).toBeUndefined();
  });

  test("per-call baseUrl and model override the env defaults", async () => {
    process.env.CDP_EXTRACT_BASE_URL = BASE;
    process.env.CDP_EXTRACT_MODEL = "env-model";
    const calls = stubFetch(() => completionResponse());
    await extractPage(stubExtractDriver().driver, {
      schema: VALID_SCHEMA,
      baseUrl: "http://elsewhere.test/api",
      model: "per-call-model",
    });
    expect(calls[0]!.url).toBe("http://elsewhere.test/api/chat/completions");
    expect((JSON.parse(String(calls[0]!.init.body)) as { model: string }).model).toBe("per-call-model");
  });
});

/* ---------------------------- 5. size guard ----------------------------- */

describe("the size guard refuses before the paid network call", () => {
  test("cleaned html over maxChars fails html_too_large without any fetch", async () => {
    const calls = forbidFetch();
    // cleanBytes, not html.length, is what the cap measures — the fixture must
    // exceed maxChars on the byte count the spec pins.
    const { driver } = stubExtractDriver({ html: `<main>${"a".repeat(500)}</main>`, rawBytes: 5000, cleanBytes: 600 });
    const err = await rejection(extractPage(driver, { schema: VALID_SCHEMA, maxChars: 100 }));
    expect(err).toBeInstanceOf(CdpError);
    expect(err.message).toContain("html_too_large");
    expect(calls.length).toBe(0);
  });

  test("a payload whose ESTIMATED TOKENS blow the context budget fails even under a raised maxChars", async () => {
    const calls = forbidFetch();
    // 900k chars: ceil(900000/3.5) ≈ 257k est-tokens; +8192+8000 far exceeds
    // the 128000 budget, while cleanBytes stays under the raised maxChars, so
    // ONLY the second guard condition can catch it.
    const { driver } = stubExtractDriver({ html: "a".repeat(900_000), rawBytes: 900_000, cleanBytes: 900_000 });
    const err = await rejection(extractPage(driver, { schema: VALID_SCHEMA, maxChars: 10_000_000 }));
    expect(err).toBeInstanceOf(CdpError);
    expect(err.message).toContain("html_too_large");
    expect(calls.length).toBe(0);
  });
});

/* ---------------------------- 6. error paths ---------------------------- */

describe("endpoint failures", () => {
  const BASE = "http://loopback.test/v1";

  test("a 429 surfaces retry-after and is NOT retried", async () => {
    process.env.CDP_EXTRACT_BASE_URL = BASE;
    const calls = stubFetch(
      () =>
        new Response(JSON.stringify({ error: { message: "rate limited" } }), {
          status: 429,
          headers: { "retry-after": "37" },
        }),
    );
    const err = await rejection(extractPage(stubExtractDriver().driver, { schema: VALID_SCHEMA }));
    expect(err).toBeInstanceOf(CdpError);
    expect(err.message.toLowerCase()).toContain("retry");
    expect(err.message).toContain("37");
    expect(calls.length).toBe(1);
  });

  test("a 500 is retried exactly once, then throws", async () => {
    process.env.CDP_EXTRACT_BASE_URL = BASE;
    const calls = stubFetch(() => new Response("upstream exploded", { status: 500 }));
    await rejection(extractPage(stubExtractDriver().driver, { schema: VALID_SCHEMA }));
    expect(calls.length).toBe(2);
    expect(calls[0]!.url).toBe(calls[1]!.url);
  });

  test("a network-level TypeError becomes a CdpError naming the ferry, so the operator knows which lane died", async () => {
    process.env.CDP_EXTRACT_BASE_URL = BASE;
    stubFetch(() => {
      throw new TypeError("fetch failed");
    });
    const err = await rejection(extractPage(stubExtractDriver().driver, { schema: VALID_SCHEMA }));
    expect(err).toBeInstanceOf(CdpError);
    expect(err.message.toLowerCase()).toContain("ferry");
  });

  test("non-JSON model content fails with a bounded excerpt, not a silent half-answer", async () => {
    process.env.CDP_EXTRACT_BASE_URL = BASE;
    // 500 chars of 'X': if the whole content were echoed, the run would be 500.
    stubFetch(() => completionResponse({ choices: [{ message: { content: "X".repeat(500) } }] }));
    const err = await rejection(extractPage(stubExtractDriver().driver, { schema: VALID_SCHEMA }));
    expect(err).toBeInstanceOf(CdpError);
    const longestRun = err.message.match(/X+/)![0]!.length;
    expect(longestRun).toBeGreaterThan(0); // the excerpt is actually there
    expect(longestRun).toBeLessThanOrEqual(200);
  });

  test("an error body echoing the API key is REDACTED out of the thrown message", async () => {
    process.env.CDP_EXTRACT_BASE_URL = BASE;
    const key = "sk-seekrit00001111";
    process.env.CDP_EXTRACT_API_KEY = key;
    stubFetch(
      () =>
        new Response(JSON.stringify({ error: { message: `invalid api key ${key} for tenant` } }), {
          status: 401,
          headers: { "content-type": "application/json" },
        }),
    );
    const err = await rejection(extractPage(stubExtractDriver().driver, { schema: VALID_SCHEMA }));
    expect(err).toBeInstanceOf(CdpError);
    expect(err.message).not.toContain(key);
    // No other sk- shaped token survives either — the redactor is pattern-based,
    // not just an exact-string replace of the one configured key.
    expect(err.message).not.toMatch(/sk-\w{8,}/);
  });
});

/* ----------------------------- 7. savePath ------------------------------ */

describe("savePath sinks the whole result and returns only the receipt", () => {
  let dir = "";
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "cdp-extract-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  test("the file carries data+usage+html; the response carries {path,bytes,target} and NOTHING else", async () => {
    const path = join(dir, "extract.json");
    stubFetch(() => completionResponse());
    const { driver } = stubExtractDriver();

    const result = (await extractPage(driver, { schema: VALID_SCHEMA, savePath: path })) as Record<string, unknown>;

    // The file has the whole result, data and usage and all.
    const onDisk = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
    expect(onDisk.data).toEqual({ title: "Quarterly Report" });
    expect(onDisk.usage).toMatchObject({ totalTokens: 108 });
    expect(onDisk.html).toBeDefined();
    expect(onDisk.target).toEqual({ id: INFO.id, url: INFO.url, title: INFO.title });

    // The response is a receipt: no data at any depth. It DOES carry the usage
    // counts — spec draft said {path,bytes,target} only, but the shipped
    // toolDocs ("carries the file path and usage counts only", "cost is always
    // visible") and the implementation agree the cost stays visible under
    // savePath; flagged as a spec-vs-implementation mismatch in the handoff.
    expect(Object.keys(result).sort()).toEqual(["bytes", "model", "path", "target", "usage"]);
    expect(result).not.toHaveProperty("data");
    expect(result.path).toBe(path);
    expect(result.bytes).toBe((await stat(path)).size);
    expect((result.usage as Record<string, unknown>).totalTokens).toBe(108);
    expect(result.target).toEqual({ id: INFO.id, url: INFO.url, title: INFO.title });
  });
});
