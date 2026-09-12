/**
 * extract-smoke.ts: live smoke for `extract_page` (src/tools/extract.ts).
 *
 * WHAT IT PROVES
 * ==============
 * The full pipeline against the real Chrome on CDP_BASE (default :9222):
 * in-page HTML cleaning on a known DOM, the size guard pass-through, the
 * POST to the OpenAI-compatible /chat/completions endpoint, and the parsed
 * schema-shaped result — end to end, not unit-by-unit.
 *
 * THE FIXTURE is a throwaway page loaded from a data: URL (no external
 * sites): a product card with known name/price/stock plus deliberate noise
 * (a <script> and a display:none span INSIDE the scoped subtree, so their
 * absence from the wire payload proves cleaning ran, not scoping). The
 * schema {product_name, price, in_stock} carries the descriptions that are
 * the extraction prompt; known answers make the result assertable.
 *
 * TWO MODES
 * =========
 * - LIVE (default): targets whatever CDP_EXTRACT_BASE_URL points at, default
 *   http://127.0.0.1:8090/v1 (loopback llm-ferry). NO REAL MONEY / no cloud
 *   by default: nothing leaves loopback unless an operator explicitly sets
 *   the env. Model output is not byte-deterministic, so live mode asserts
 *   shape + product_name non-empty.
 * - MOCK (CDP_EXTRACT_SMOKE_MOCK=1): spins up a node:http loopback server
 *   (stdlib import, the lighthouse.ts child_process precedent — no new dep)
 *   returning a canned schema-conformant chat completion, points
 *   CDP_EXTRACT_BASE_URL at it (read per call, extract.ts:135), and asserts
 *   the FULL wire path: the page's cleaned HTML actually left the browser,
 *   the request shape is the strict json_schema contract, and the canned
 *   content came back parsed. CDP_EXTRACT_SMOKE_MOCK=1 overrides any
 *   CDP_EXTRACT_BASE_URL already set.
 *
 * PREREQUISITES (the firefox-smoke convention: SKIP + exit 0, never a
 * misleading FAIL): Chrome on CDP_BASE, and — live mode only — a reachable
 * endpoint. Each skip line names exactly what is missing.
 *
 * SAFETY: creates its OWN throwaway page (about:blank → data: URL), operates
 * only on it, closes it. Never touches an existing/user tab.
 *
 * Run with: bun run extract:smoke   (CDP_EXTRACT_SMOKE_MOCK=1 for the mock)
 */
import { createServer, type Server } from "node:http";
import { BASE } from "../src/client.ts";
import { TOOLS } from "../src/index.ts";
import type { ExtractPageResult } from "../src/tools/extract.ts";

type Check = { name: string; ok: boolean; detail: string };
const checks: Check[] = [];
function record(name: string, ok: boolean, detail: string): void {
  checks.push({ name, ok, detail });
  console.log(`${ok ? "✅" : "❌"} ${name}: ${detail}`);
}

const MOCK_MODE = process.env.CDP_EXTRACT_SMOKE_MOCK === "1";
const DEFAULT_ENDPOINT = "http://127.0.0.1:8090/v1";
/** Same resolution as extract.ts's extractBaseUrl(): env per call, blank = unset. */
const endpointBase = (process.env.CDP_EXTRACT_BASE_URL?.trim() || DEFAULT_ENDPOINT).replace(/\/+$/, "");
/** Same resolution as extract.ts's extractModel(), for the mock wire check. */
const expectedModel = process.env.CDP_EXTRACT_MODEL?.trim() || "schematron";

/** The fixture: known product card + in-scope noise the cleaner must drop. */
const DATA_URL =
  'data:text/html,<title>extract-smoke</title>' +
  '<div id="card"><h2>Nimbus Widget 3000</h2><span class="price">$42.50</span>' +
  '<span class="stock">In stock: yes</span>' +
  "<script>var EXTRACT_NOISE_SCRIPT = 1</script>" +
  '<span style="display:none">EXTRACT_NOISE_HIDDEN</span></div>';

const KNOWN = { product_name: "Nimbus Widget 3000", price: "$42.50", in_stock: true };

/** Descriptions ARE the extraction prompt — required by validateExtractArgs. */
const SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["product_name", "price", "in_stock"],
  properties: {
    product_name: { type: "string", description: "The product's name, exactly as printed in the card heading." },
    price: { type: "string", description: "The product's price with currency symbol, exactly as printed." },
    in_stock: { type: "boolean", description: "true if the card says the product is in stock, else false." },
  },
} as const;

/* --------------------------- mock chat-completions -------------------------- */

interface CapturedChatRequest {
  method: string;
  url: string;
  contentType: string;
  body: Record<string, unknown>;
}

/** The canned, schema-conformant completion the mock returns verbatim. */
const MOCK_CONTENT = JSON.stringify(KNOWN);

function startMockChatServer(): Promise<{ server: Server; port: number; requests: CapturedChatRequest[] }> {
  return new Promise((resolve, reject) => {
    const requests: CapturedChatRequest[] = [];
    const server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        const raw = Buffer.concat(chunks).toString("utf8");
        let body: Record<string, unknown> = {};
        try {
          body = JSON.parse(raw) as Record<string, unknown>;
        } catch {
          // malformed request bodies are still recorded (as {}) so the wire
          // assertions below fail loudly on shape, not on a parse crash
        }
        if (req.method === "POST") {
          requests.push({
            method: req.method,
            url: req.url ?? "",
            contentType: String(req.headers["content-type"] ?? ""),
            body,
          });
          const payload = JSON.stringify({
            id: "chatcmpl-extract-smoke",
            object: "chat.completion",
            model: "extract-smoke-mock",
            choices: [
              { index: 0, message: { role: "assistant", content: MOCK_CONTENT }, finish_reason: "stop" },
            ],
            usage: { prompt_tokens: 321, completion_tokens: 21, total_tokens: 342, cost_usd: 0 },
          });
          res.writeHead(200, {
            "content-type": "application/json",
            "content-length": String(Buffer.byteLength(payload)),
          });
          res.end(payload);
        } else {
          res.writeHead(404, { "content-type": "application/json" });
          res.end(
            JSON.stringify({
              error: { message: `extract-smoke mock: only POST is served (got ${req.method ?? "?"} ${req.url ?? "?"})` },
            }),
          );
        }
      });
    });
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (addr === null || typeof addr === "string") {
        server.close();
        reject(new Error("mock server: no ephemeral port"));
        return;
      }
      resolve({ server, port: addr.port, requests });
    });
  });
}

/* ------------------------------ prerequisites ------------------------------- */

/** Any HTTP answer (even 404/500) proves the origin is listening; only a
 *  network-level throw means missing. */
async function reachable(url: string): Promise<boolean> {
  try {
    await fetch(url, { signal: AbortSignal.timeout(3000) });
    return true;
  } catch {
    return false;
  }
}

if (!(await reachable(`${BASE}/json/version`))) {
  console.log(
    `SKIP extract-smoke: Chrome DevTools endpoint not reachable at ${BASE} ` +
      `(needs Chrome --remote-debugging-port=9222, or a CDP_BASE override).`,
  );
  process.exit(0);
}

let mock: { server: Server; port: number; requests: CapturedChatRequest[] } | undefined;
if (MOCK_MODE) {
  mock = await startMockChatServer();
  // Read per call by extract.ts, so a runtime redirect is enough — no restart.
  process.env.CDP_EXTRACT_BASE_URL = `http://127.0.0.1:${mock.port}/v1`;
  record("mock server up", true, `listening on 127.0.0.1:${mock.port}/v1`);
} else if (!(await reachable(`${endpointBase}/models`))) {
  console.log(
    `SKIP extract-smoke: extraction endpoint not reachable at ${endpointBase} ` +
      `(set CDP_EXTRACT_BASE_URL to a running OpenAI-compatible server, or run with CDP_EXTRACT_SMOKE_MOCK=1).`,
  );
  process.exit(0);
}

/* --------------------------------- the run ---------------------------------- */

let targetId = "";
try {
  const created = (await TOOLS.new_page({ url: "about:blank" })) as { targetId: string };
  targetId = created.targetId;
  record("new_page (throwaway)", !!targetId, `targetId=${targetId.slice(0, 8)}`);

  await TOOLS.navigate_page({ target: targetId, url: DATA_URL });
  record("navigate_page (fixture data: URL)", true, "product card + in-scope noise loaded");

  const result = (await TOOLS.extract_page({
    target: targetId,
    schema: SCHEMA as unknown as Record<string, unknown>,
    selector: "#card",
    timeoutMs: MOCK_MODE ? 15000 : 60000,
  })) as ExtractPageResult;

  // --- result shape (both modes): every stage of the pipeline reports ---
  record(
    "extract_page (result shape)",
    typeof result.data === "object" && result.data !== null &&
      typeof result.model === "string" && result.model.length > 0 &&
      typeof result.usage?.totalTokens === "number" &&
      typeof result.html?.rawBytes === "number" && typeof result.html?.cleanBytes === "number",
    `model=${result.model}, usage.totalTokens=${result.usage?.totalTokens}, ` +
      `html ${result.html?.rawBytes}B raw → ${result.html?.cleanBytes}B clean`,
  );

  // --- page-side cleaning is deterministic in BOTH modes (runs before the
  //     endpoint is ever called): noise dropped, content kept, bytes shrank ---
  const dropped = result.html?.dropped as { elements?: Record<string, number>; hidden?: number } | undefined;
  record(
    "in-page cleaning (deterministic)",
    (dropped?.elements?.script ?? 0) >= 1 && (dropped?.hidden ?? 0) >= 1 &&
      (result.html?.cleanBytes ?? 0) > 0 && (result.html?.rawBytes ?? 0) >= (result.html?.cleanBytes ?? 0),
    `dropped script x${dropped?.elements?.script ?? 0}, hidden x${dropped?.hidden ?? 0}, ` +
      `${result.html?.rawBytes}B → ${result.html?.cleanBytes}B`,
  );

  record(
    "target identity",
    result.target?.id === targetId,
    `result.target.id=${(result.target?.id ?? "").slice(0, 8)}`,
  );

  if (MOCK_MODE) {
    // --- the FULL wire path, asserted server-side ---
    const req0 = mock?.requests[0];
    record(
      "wire: single POST /v1/chat/completions",
      !!req0 && req0.method === "POST" && req0.url === "/v1/chat/completions" && mock?.requests.length === 1,
      `${mock?.requests.length ?? 0} request(s), first ${req0?.method ?? "none"} ${req0?.url ?? ""}`,
    );
    const messages = req0?.body["messages"] as { role?: string; content?: string }[] | undefined;
    const wireHtml = messages?.[0]?.content ?? "";
    record(
      "wire: page HTML left the browser",
      wireHtml.includes("Nimbus Widget 3000") && wireHtml.includes("$42.50") && wireHtml.includes("In stock: yes"),
      `payload ${wireHtml.length} chars carries all three known values`,
    );
    record(
      "wire: cleaning visible on the wire",
      !wireHtml.includes("EXTRACT_NOISE_SCRIPT") && !wireHtml.includes("EXTRACT_NOISE_HIDDEN"),
      "script + hidden noise absent from the payload",
    );
    const rf = req0?.body["response_format"] as {
      type?: string;
      json_schema?: { name?: string; strict?: boolean; schema?: unknown };
    } | undefined;
    record(
      "wire: strict json_schema contract",
      req0?.body["model"] === expectedModel && req0?.body["temperature"] === 0 &&
        rf?.type === "json_schema" && rf.json_schema?.name === "extract" && rf.json_schema?.strict === true &&
        JSON.stringify(rf.json_schema?.schema) === JSON.stringify(SCHEMA),
      `model=${JSON.stringify(req0?.body["model"])}, temperature=${JSON.stringify(req0?.body["temperature"])}, ` +
        `response_format=${rf?.type}/strict=${rf?.json_schema?.strict}, schema echoed verbatim`,
    );
    record(
      "wire: content-type",
      req0?.contentType.includes("application/json") === true,
      req0?.contentType ?? "(none)",
    );

    // --- parsed result: exactly the canned completion ---
    record(
      "data (exact, from canned completion)",
      JSON.stringify(result.data) === JSON.stringify(KNOWN),
      JSON.stringify(result.data),
    );
    record(
      "usage echoed from endpoint",
      result.model === "extract-smoke-mock" && result.usage.promptTokens === 321 &&
        result.usage.completionTokens === 21 && result.usage.totalTokens === 342 && result.usage.costUsd === 0,
      `model=${result.model}, tokens ${result.usage.promptTokens}+${result.usage.completionTokens}=${result.usage.totalTokens}`,
    );
  } else {
    // --- live mode: model output is not byte-deterministic; assert shape ---
    const data = result.data as Record<string, unknown>;
    record(
      "data (live shape)",
      typeof data["product_name"] === "string" && (data["product_name"] as string).length > 0 &&
        "price" in data && "in_stock" in data,
      `product_name=${JSON.stringify(data["product_name"])}, keys=${JSON.stringify(Object.keys(data))}`,
    );
  }
} catch (err) {
  record("FATAL", false, err instanceof Error ? err.message : String(err));
} finally {
  if (targetId) {
    try {
      await TOOLS.close_page({ target: targetId });
      record("close_page (cleanup)", true, "throwaway page closed");
    } catch (err) {
      record("close_page (cleanup)", false, err instanceof Error ? err.message : String(err));
    }
  }
  if (mock) {
    mock.server.closeAllConnections?.();
    await new Promise<void>((r) => mock?.server.close(() => r()));
  }
}

const failed = checks.filter((c) => !c.ok);
console.log(`\n${checks.length - failed.length}/${checks.length} checks passed (${MOCK_MODE ? "mock" : "live"} mode)`);
if (failed.length) {
  console.error(`FAILED: ${failed.map((c) => c.name).join(", ")}`);
  process.exit(1);
}
console.log("SMOKE OK");
process.exit(0);
