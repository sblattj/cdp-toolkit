/**
 * extract.ts: `extract_page` — structured extraction from a page's HTML via an
 * OpenAI-compatible /chat/completions endpoint.
 *
 * THE PIPELINE (why each stage exists)
 * ====================================
 * A page's DOM is a terrible prompt: scripts, styles, hidden boilerplate and
 * 40KB of attribute noise drown the content an extraction actually needs. So
 * the tool cleans the HTML IN-PAGE (a self-contained function evaluated on the
 * resolved page, the bidi/snapshot.ts pattern: no closures over TS scope, no
 * imports, only DOM calls every shipped browser has), measures the result, and
 * only then hands it to the endpoint — page content never leaves the machine
 * unless an operator explicitly points baseUrl (or CDP_EXTRACT_BASE_URL) at a
 * remote host.
 *
 * The caller's JSON Schema is BOTH the response contract (sent as
 * response_format json_schema strict in "html" mode) AND the extraction
 * prompt: Schematron reads the schema's property DESCRIPTIONS as its only
 * instructions. A schema with no descriptions anywhere would extract garbage
 * with no hint why, so it is rejected up front, before any page work happens.
 * In "schematron" mode response_format is OMITTED — the schema already rides
 * inline in the prompt, and constrained decoding on top of it collapses real
 * pages to an empty result (see buildExtractionMessages/callExtractionEndpoint).
 *
 * COST IS ALWAYS VISIBLE: every successful call reports the endpoint's token
 * counts, so a bloated extraction is visible in the answer itself, not
 * discovered on a bill later.
 *
 * ENDPOINT CONFIG (env, read per call like leases.ts's getters — never at
 * module load, so a test or operator can redirect without a restart):
 *   CDP_EXTRACT_BASE_URL   default http://127.0.0.1:8090/v1 (loopback llm-ferry)
 *   CDP_EXTRACT_MODEL      default "schematron"
 *   CDP_EXTRACT_API_KEY    optional; sent as Bearer if set. THE KEY IS NEVER AN
 *                          ARGUMENT (args can land in transcripts/logs; env
 *                          cannot), never logged, and redacted out of every
 *                          upstream-derived error text (see redactSecrets).
 *   CDP_EXTRACT_TIMEOUT_MS default 90000 (hard-capped at 300000 with the arg)
 *   CDP_EXTRACT_MAX_CHARS  default 300000
 *   CDP_EXTRACT_PROMPT     default "html"; "schematron" switches to the
 *                          Schematron model-card prompt (see buildMessages)
 *
 * BOTH BACKENDS, NO capability gating: everything page-side goes through the
 * neutral Driver's page.evaluate (Chrome Runtime.evaluate / Firefox
 * script.evaluate), so the tool works identically under --browser firefox.
 * Lease gate: driver.page() -> resolveTarget/resolveContext -> assertLeaseOk,
 * the same choke points as every other driver-based tool (the `lease` arg is
 * consumed by mcp.ts's ambient withLeaseScope, never read here).
 */
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { CdpError } from "../client.ts";
import type { BrowserDriver, PageDriver } from "../driver.ts";
import type { TargetSelector } from "../types.ts";

const ARTIFACT_DIR = process.env.CDP_ARTIFACT_DIR ?? "/tmp/cdp-toolkit";

const DEFAULT_BASE_URL = "http://127.0.0.1:8090/v1";
const DEFAULT_MODEL = "schematron";
const DEFAULT_TIMEOUT_MS = 90_000;
const DEFAULT_MAX_CHARS = 300_000;
const MAX_TIMEOUT_MS = 300_000;
const DEFAULT_PROMPT_MODE = "html";

/** Token arithmetic for the size guard: ~3.5 chars/token on HTML, the fixed
 *  completion budget we request, a safety margin, against a 128k context. */
const CHARS_PER_TOKEN = 3.5;
const COMPLESION_TOKENS = 8_192;
const SAFETY_TOKENS = 8_000;
const CONTEXT_TOKEN_BUDGET = 128_000;

export interface ExtractPageArgs {
  target?: TargetSelector;
  /** Consumed by mcp.ts's ambient lease scope; declared for manifest parity. */
  lease?: string;
  /**
   * REQUIRED JSON Schema (type "object") describing the JSON you want back.
   * Its property descriptions ARE the extraction instructions — a schema with
   * no descriptions anywhere is rejected before any page work happens.
   * additionalProperties:true is rejected too: strict json_schema mode would
   * otherwise silently widen the contract.
   */
  schema: Record<string, unknown>;
  /** CSS selector scoping the payload to that subtree (pierces open shadow
   *  roots when locating; the serialized subtree is its light DOM). */
  selector?: string;
  /** Page source to read. "dom" (default) only; "served" is not implemented. */
  source?: "dom" | "served";
  /** Cleaning level: "standard" (default), "aggressive", or "none". */
  clean?: "standard" | "aggressive" | "none";
  /** Character cap on the cleaned HTML. Default 300000. NO truncation: over
   *  the cap is an html_too_large error naming the levers, never a half page
   *  extracted as though it were whole. */
  maxChars?: number;
  /** Endpoint budget in ms. Default 90000, hard max 300000. */
  timeoutMs?: number;
  /**
   * Prompt shape sent upstream. "html" (default) sends the cleaned HTML as the
   * only user message and lets the server carry the schema — what the hosted
   * Schematron API expects, since it injects the schema server-side.
   * "schematron" sends the open-weight Schematron model card's own messages
   * (system + a user message with the schema INLINE, then the HTML), which a
   * locally served open-weight Schematron was fine-tuned on: without it, an
   * HTML-only prompt yields garbage even under constrained decoding. It adds
   * roughly the JSON-stringified schema's length to the prompt. Default from
   * CDP_EXTRACT_PROMPT, then "html". "schematron" mode sends NO
   * response_format — the schema is already inline in the prompt, and the
   * client validates only that the response parses as JSON.
   */
  prompt?: "html" | "schematron";
  /** Model name override (default CDP_EXTRACT_MODEL, then "schematron"). */
  model?: string;
  /** Base URL override; the tool appends /chat/completions. Default is the
   *  loopback llm-ferry. THE API KEY IS NOT AN ARGUMENT — env only. */
  baseUrl?: string;
  /** Write the full result object to this path instead of returning it
   *  inline; the response then carries the path, bytes, model, usage and
   *  target only. Absolute used as-is, relative under the artifact dir. */
  savePath?: string;
}

export interface ExtractUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  costUsd?: number;
}

export interface ExtractPageResult {
  data: unknown;
  model: string;
  usage: ExtractUsage;
  html: {
    source: "dom";
    rawBytes: number;
    cleanBytes: number;
    estTokens: number;
    dropped: Record<string, unknown>;
  };
  target: { id: string; url: string; title: string };
}

export interface ExtractPageSaveResult {
  path: string;
  bytes: number;
  model: string;
  usage: ExtractUsage;
  target: { id: string; url: string; title: string };
}

/* ------------------------------ env (per call) ------------------------------ */

/** Read per call, not at module load, so a test or operator can redirect the
 *  endpoint without a restart. An empty/blank value counts as unset (the same
 *  precedence rule backend.ts gives CDP_FIREFOX_ENDPOINT). */
function extractBaseUrl(): string {
  const raw = process.env.CDP_EXTRACT_BASE_URL?.trim();
  return raw ? raw : DEFAULT_BASE_URL;
}

function extractModel(): string {
  const raw = process.env.CDP_EXTRACT_MODEL?.trim();
  return raw ? raw : DEFAULT_MODEL;
}

/** Prompt shape default. Same precedence rule as the others: an empty/blank
 *  value counts as unset. An unrecognized value is NOT silently ignored — it
 *  is reported by validateExtractArgs, so a typo'd env var fails loudly
 *  instead of quietly extracting garbage from the wrong prompt. */
function extractPromptMode(): string {
  const raw = process.env.CDP_EXTRACT_PROMPT?.trim();
  return raw ? raw : DEFAULT_PROMPT_MODE;
}

/** The key lives in env only, never in args, never in a log line. */
function extractApiKey(): string | undefined {
  const raw = process.env.CDP_EXTRACT_API_KEY;
  return raw && raw.length > 0 ? raw : undefined;
}

function extractTimeoutMs(): number {
  const raw = Number(process.env.CDP_EXTRACT_TIMEOUT_MS);
  return Number.isFinite(raw) && raw > 0 ? Math.min(raw, MAX_TIMEOUT_MS) : DEFAULT_TIMEOUT_MS;
}

function extractMaxChars(): number {
  const raw = Number(process.env.CDP_EXTRACT_MAX_CHARS);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_MAX_CHARS;
}

/* ------------------------------ arg validation ------------------------------ */

/**
 * Recursively look for one non-empty `description` anywhere in the schema
 * (property values under `properties`, items, anyOf/oneOf/allOf branches).
 * Inner descriptions count, because Schematron reads whichever ones exist,
 * wherever they sit.
 */
function hasAnyDescription(node: unknown, seen: Set<unknown> = new Set()): boolean {
  if (typeof node !== "object" || node === null || seen.has(node)) return false;
  seen.add(node);
  const n = node as Record<string, unknown>;
  if (typeof n.description === "string" && n.description.trim() !== "") return true;
  const props = n.properties;
  if (typeof props === "object" && props !== null) {
    for (const value of Object.values(props)) if (hasAnyDescription(value, seen)) return true;
  }
  if (hasAnyDescription(n.items, seen)) return true;
  for (const key of ["anyOf", "oneOf", "allOf", "prefixItems"] as const) {
    const branches = n[key];
    if (Array.isArray(branches)) {
      for (const branch of branches) if (hasAnyDescription(branch, seen)) return true;
    }
  }
  return false;
}

export function validateExtractArgs(args: ExtractPageArgs): void {
  if (args.schema === null || typeof args.schema !== "object" || Array.isArray(args.schema)) {
    throw new CdpError("extract_page: 'schema' is required and must be a JSON Schema object");
  }
  if (args.schema.type !== "object") {
    throw new CdpError(`extract_page: 'schema.type' must be "object" (got ${JSON.stringify(args.schema.type)})`);
  }
  if (args.schema.additionalProperties === true) {
    throw new CdpError(
      'extract_page: schema must not set additionalProperties:true — strict json_schema mode requires a closed object so the extraction cannot invent fields',
    );
  }
  if (!hasAnyDescription(args.schema)) {
    throw new CdpError(
      "extract_page: no property in 'schema' carries a description. This is prompt-driven extraction: the property descriptions ARE the instructions the extractor follows ('the job title, exactly as printed'). Write them like prompts and retry.",
    );
  }
  if (args.selector !== undefined && (typeof args.selector !== "string" || args.selector.length === 0)) {
    throw new CdpError("extract_page: 'selector' must be a non-empty CSS selector string");
  }
  if (args.source !== undefined && args.source !== "dom" && args.source !== "served") {
    throw new CdpError(`extract_page: 'source' must be "dom" or "served" (got ${JSON.stringify(args.source)})`);
  }
  if (args.source === "served") {
    throw new CdpError(
      "extract_page: source 'served' (the raw server response before rendering) is not implemented; use source 'dom' (the live rendered DOM).",
    );
  }
  if (args.clean !== undefined && args.clean !== "standard" && args.clean !== "aggressive" && args.clean !== "none") {
    throw new CdpError(`extract_page: 'clean' must be "standard", "aggressive" or "none" (got ${JSON.stringify(args.clean)})`);
  }
  if (args.prompt !== undefined && args.prompt !== "html" && args.prompt !== "schematron") {
    throw new CdpError(`extract_page: 'prompt' must be "html" or "schematron" (got ${JSON.stringify(args.prompt)})`);
  }
  const envPrompt = process.env.CDP_EXTRACT_PROMPT?.trim();
  if (args.prompt === undefined && envPrompt && envPrompt !== "html" && envPrompt !== "schematron") {
    throw new CdpError(`extract_page: CDP_EXTRACT_PROMPT must be "html" or "schematron" (got ${JSON.stringify(envPrompt)})`);
  }
  if (args.maxChars !== undefined && (!Number.isFinite(args.maxChars) || args.maxChars <= 0)) {
    throw new CdpError("extract_page: 'maxChars' must be a positive number");
  }
  if (args.timeoutMs !== undefined && (!Number.isFinite(args.timeoutMs) || args.timeoutMs <= 0)) {
    throw new CdpError("extract_page: 'timeoutMs' must be a positive number");
  }
  if (args.model !== undefined && (typeof args.model !== "string" || args.model.length === 0)) {
    throw new CdpError("extract_page: 'model' must be a non-empty string");
  }
  if (args.baseUrl !== undefined && (typeof args.baseUrl !== "string" || args.baseUrl.length === 0)) {
    throw new CdpError("extract_page: 'baseUrl' must be a non-empty string (the API key is env-only: CDP_EXTRACT_API_KEY)");
  }
}

/* --------------------------- in-page HTML cleaning --------------------------- */

/**
 * The in-page cleaner, as a zero-arg self-contained function SOURCE (the
 * bidi/snapshot.ts pattern): stringified, injected with its two parameters,
 * referencing nothing outside itself, and run via the neutral Driver's
 * page.evaluate — so Chrome and Firefox run byte-identical cleaning logic.
 *
 * Everything operates on a CLONE of the scoped root; the live DOM is never
 * mutated. Visibility is computed on the LIVE twins zipped against the clone's
 * element list (safe: the whole function is one synchronous run, so the page
 * cannot mutate between the two querySelectorAll calls). Returns
 * { matched, html, rawBytes, cleanBytes, dropped } — matched:false is the
 * selector miss the caller turns into a CdpError, because a page-side throw
 * would surface as a generic page-error and lose the selector.
 */
export function buildCleanFunctionSource(selector: string | undefined, clean: "standard" | "aggressive" | "none"): string {
  return `function() {
    var SEL = ${JSON.stringify(selector ?? null)};
    var CLEAN = ${JSON.stringify(clean)};
    var STRIP = ["script","style","noscript","svg","canvas","iframe","video","audio","source","track","template","object","embed","link","meta"];
    var AGGRO = ["nav","header","footer","aside","form","button"];
    var WHITELIST = ["href","src","alt","title","value","placeholder","for","name","type","role","aria-label","selected","checked","disabled"];

    function bytes(s) {
      try { return new TextEncoder().encode(s).length; } catch (e) { return s.length; }
    }

    function collectShadowScopes(root, out) {
      var els = root.querySelectorAll("*");
      for (var i = 0; i < els.length; i++) {
        var sr = els[i].shadowRoot;
        if (sr) { out.push(sr); collectShadowScopes(sr, out); }
      }
    }

    // Locate SEL piercing open shadow roots (querySelector on document first,
    // then every open shadow scope). LIMIT: outerHTML serializes the matched
    // element's light DOM only; a closed shadow root is invisible by design.
    function deepQuery(sel) {
      var direct = document.querySelector(sel);
      if (direct) return direct;
      var scopes = [];
      collectShadowScopes(document, scopes);
      for (var i = 0; i < scopes.length; i++) {
        var hit = scopes[i].querySelector(sel);
        if (hit) return hit;
      }
      return null;
    }

    // The visibility heuristic, same shape as bidi/snapshot.ts's isVisible:
    // hidden attr, aria-hidden, computed display/visibility, then the 0x0
    // paint check. OPTION/OPTGROUP skip the size check (a closed select's
    // popup is unpainted though its options are real, extractable content).
    function isHidden(el) {
      if (el.hidden) return true;
      if (el.getAttribute("aria-hidden") === "true") return true;
      var style = null;
      try { style = el.ownerDocument.defaultView.getComputedStyle(el); } catch (e) {}
      if (style && (style.display === "none" || style.visibility === "hidden")) return true;
      var tag = el.tagName;
      if (tag !== "OPTION" && tag !== "OPTGROUP") {
        var rect = el.getBoundingClientRect();
        if (rect.width === 0 && rect.height === 0) return true;
      }
      return false;
    }

    function countDrop(dropped, tag) {
      dropped.elements[tag] = (dropped.elements[tag] || 0) + 1;
    }

    function cleanRoot(root) {
      var rawHtml = root.outerHTML;
      var dropped = { comments: 0, hidden: 0, attributes: 0, elements: {} };
      if (CLEAN === "none") {
        return { matched: true, html: rawHtml, rawBytes: bytes(rawHtml), cleanBytes: bytes(rawHtml), dropped: dropped };
      }
      var live = root.querySelectorAll("*");
      var clone = root.cloneNode(true);
      var mirrored = clone.querySelectorAll("*");
      for (var i = 0; i < mirrored.length; i++) {
        var cel = mirrored[i];
        if (!cel.parentNode) continue; // dropped already, with an ancestor
        var low = cel.tagName.toLowerCase();
        if (STRIP.indexOf(low) !== -1) { countDrop(dropped, low); cel.parentNode.removeChild(cel); continue; }
        if (CLEAN === "aggressive" && AGGRO.indexOf(low) !== -1) { countDrop(dropped, low); cel.parentNode.removeChild(cel); continue; }
        var lel = live[i];
        if (lel && isHidden(lel)) { dropped.hidden++; cel.parentNode.removeChild(cel); continue; }
        for (var j = cel.attributes.length - 1; j >= 0; j--) {
          var attr = cel.attributes[j];
          if (WHITELIST.indexOf(attr.name.toLowerCase()) === -1) {
            cel.removeAttribute(attr.name);
            dropped.attributes++;
          }
        }
      }
      var walker = clone.ownerDocument.createTreeWalker(clone, NodeFilter.SHOW_COMMENT);
      var comments = [];
      while (walker.nextNode()) comments.push(walker.currentNode);
      for (var k = 0; k < comments.length; k++) {
        var c = comments[k];
        if (c.parentNode) c.parentNode.removeChild(c);
      }
      dropped.comments = comments.length;
      // Whitespace collapse at the TEXT-NODE level, never on the serialized
      // string: a regex over outerHTML would also flatten <pre> content.
      var tw = clone.ownerDocument.createTreeWalker(clone, NodeFilter.SHOW_TEXT);
      while (tw.nextNode()) {
        var node = tw.currentNode;
        node.nodeValue = node.nodeValue.replace(/\\s+/g, " ");
      }
      var html = clone.outerHTML;
      return { matched: true, html: html, rawBytes: bytes(rawHtml), cleanBytes: bytes(html), dropped: dropped };
    }

    if (SEL) {
      var found = deepQuery(SEL);
      if (!found) return { matched: false };
      return cleanRoot(found);
    }
    return cleanRoot(document.documentElement);
  }`;
}

interface CleanOutcome {
  html: string;
  rawBytes: number;
  cleanBytes: number;
  dropped: Record<string, unknown>;
}

/** Validate + narrow the untyped page.evaluate() return; a `matched:false`
 *  marks the selector miss so its error can name the selector. `matched` is
 *  ADDITIVE: our own cleaner always sets it, but the contract shape is the
 *  bare {html, rawBytes, cleanBytes, dropped}, which is accepted as-is. */
export function coerceCleanOutcome(raw: unknown, selector: string | undefined): CleanOutcome {
  if (typeof raw !== "object" || raw === null) {
    throw new CdpError("extract_page: in-page cleaning returned an unexpected shape");
  }
  const r = raw as { matched?: unknown; html?: unknown; rawBytes?: unknown; cleanBytes?: unknown; dropped?: unknown };
  if (r.matched === false) {
    throw new CdpError(`extract_page: no element matches selector '${selector}' (checked document and every open shadow root)`);
  }
  if (
    typeof r.html !== "string" ||
    typeof r.rawBytes !== "number" || !Number.isFinite(r.rawBytes) ||
    typeof r.cleanBytes !== "number" || !Number.isFinite(r.cleanBytes)
  ) {
    throw new CdpError("extract_page: in-page cleaning returned an unexpected shape");
  }
  return {
    html: r.html,
    rawBytes: r.rawBytes,
    cleanBytes: r.cleanBytes,
    dropped: (typeof r.dropped === "object" && r.dropped !== null ? r.dropped : {}) as Record<string, unknown>,
  };
}

/* -------------------------------- size guard -------------------------------- */

/** ~3.5 chars per token on cleaned HTML — an estimate for the guard, not a
 *  bill; the true count comes back in usage.promptTokens. */
export function estimateTokens(chars: number): number {
  return Math.ceil(chars / CHARS_PER_TOKEN);
}

/**
 * NO truncation, NO chunking: a half page extracted as though it were whole
 * is a wrong answer that looks right, so over-budget is a loud error naming
 * the numbers and the three levers that actually shrink the payload.
 *
 * maxChars is a CHARACTER cap (as its name, the manifest and the docs all
 * promise): the comparison is html.length, not cleanBytes — comparing UTF-8
 * bytes against a char cap would false-fail a CJK page at a third of its
 * documented budget. cleanBytes is still reported alongside.
 */
function guardSize(outcome: CleanOutcome, maxChars: number): number {
  const estTokens = estimateTokens(outcome.html.length);
  const overChars = outcome.html.length > maxChars;
  const overContext = estTokens + COMPLESION_TOKENS + SAFETY_TOKENS > CONTEXT_TOKEN_BUDGET;
  if (overChars || overContext) {
    const why = overChars
      ? `cleaned HTML is ${outcome.html.length} chars (${outcome.cleanBytes} bytes), over the ${maxChars}-char cap`
      : `estimated ${estTokens} prompt tokens + ${COMPLESION_TOKENS} completion + ${SAFETY_TOKENS} safety exceeds the ${CONTEXT_TOKEN_BUDGET}-token context budget`;
    throw new CdpError(
      `extract_page: html_too_large — ${why}. Shrink the payload with 'selector' to scope to a subtree, clean:"aggressive" to strip nav/footer/form/button too, or a larger maxChars if you truly need it all. No truncation: a partial page extracted as whole is a wrong answer that looks right.`,
    );
  }
  return estTokens;
}

/* --------------------- upstream response shape & helpers --------------------- */

interface ChatCompletionResponse {
  choices?: { message?: { content?: unknown }; finish_reason?: unknown }[];
  model?: string;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
    cost_usd?: number;
    costUsd?: number;
    cost?: number;
  };
  error?: { message?: unknown; code?: unknown };
}

/**
 * Strip the API key value (if one is set) and any sk-… credential out of
 * upstream-derived text BEFORE it can ride an error message into a transcript
 * or log. Runs on every excerpt we embed — response bodies, network error
 * text, model output fragments — because an upstream 401 body echoing the
 * request's Authorization header is exactly the leak this exists to stop.
 */
export function redactSecrets(text: string, apiKey?: string): string {
  let out = text;
  if (apiKey && apiKey.length > 0) {
    out = out.split(apiKey).join("[redacted]");
  }
  return out.replace(/sk-[A-Za-z0-9_-]{8,}/g, "[redacted]");
}

/** The cost field name is not standardized across OpenAI-compatible servers;
 *  take the first of the usual spellings, and only when it is a finite number. */
function pickCostUsd(usage: NonNullable<ChatCompletionResponse["usage"]>): number | undefined {
  for (const v of [usage.cost_usd, usage.costUsd, usage.cost]) {
    if (typeof v === "number" && Number.isFinite(v)) return v;
  }
  return undefined;
}

function excerpt(text: string, max: number): string {
  const t = text.trim();
  return t.length > max ? `${t.slice(0, max)}…` : t;
}

/* ------------------------------ prompt shapes ------------------------------ */

export interface ChatMessage {
  role: "system" | "user";
  content: string;
}

/**
 * The two prompt shapes, kept in one place because the wire body is the only
 * thing a refactor can silently break here.
 *
 * "html" (default, unchanged): the cleaned HTML is the ONLY user message and
 * the schema rides in response_format alone. That is what the HOSTED
 * Schematron API expects — it injects the schema into the prompt server-side.
 *
 * "schematron": the open-weight Schematron model card's own `construct_messages`
 * (inference-net/Schematron-8B), verbatim — a "You are a helpful assistant"
 * system message plus a user message carrying the COMPACT JSON.stringify'd
 * schema inline, then the HTML, then the "MAKE SURE ITS VALID JSON." tail. The
 * model was fine-tuned on exactly this string; a locally served open-weight
 * Schematron handed a bare HTML prompt returns garbage even with constrained
 * decoding, which is why this mode exists. Note the schema text is charged to
 * the prompt on top of the HTML (maxChars caps the HTML only).
 */
export function buildExtractionMessages(
  mode: "html" | "schematron",
  html: string,
  schema: Record<string, unknown>,
): ChatMessage[] {
  if (mode !== "schematron") return [{ role: "user", content: html }];
  const user =
    "You are going to be given a JSON schema following the standardized JSON Schema format. You are going to be given a HTML page and you are going to apply the schema to the HTML page however you see it as applicable and return the results in a JSON object. The schema is as follows:" +
    "\n\n" +
    JSON.stringify(schema) +
    "\n\n" +
    "Here is the HTML page:" +
    "\n\n" +
    html +
    "\n\n" +
    "MAKE SURE ITS VALID JSON.";
  return [
    { role: "system", content: "You are a helpful assistant" },
    { role: "user", content: user },
  ];
}

/* ------------------------------ upstream call ------------------------------ */

/**
 * One POST to ${baseUrl}/chat/completions, with a single bounded retry on 5xx
 * (transient gateway flaps are the one failure worth an automatic second try;
 * everything else fails fast and loud). Each attempt gets its own
 * AbortSignal.timeout(timeoutMs), so an expiry is a timeout error, never a hang.
 */
export async function callExtractionEndpoint(opts: {
  baseUrl: string;
  apiKey: string | undefined;
  model: string;
  html: string;
  schema: Record<string, unknown>;
  timeoutMs: number;
  /** Prompt shape; default "html" (the pre-existing wire shape). */
  prompt?: "html" | "schematron";
}): Promise<{ content: string; usage: ExtractUsage; model: string; finishReason: string | undefined }> {
  const url = `${opts.baseUrl.replace(/\/+$/, "")}/chat/completions`;
  const promptMode = opts.prompt ?? "html";
  // "schematron" mode OMITS response_format entirely (never sends it as null).
  // Measured 2026-09-12: against a locally served open-weight Schematron-8B
  // (llguidance-constrained decoding), the IDENTICAL messages with
  // response_format present returned {"stories": []} in 6 completion tokens
  // for a real CNN zone, while omitting response_format returned valid,
  // schema-conformant JSON with 5 stories (285 tokens) — the schema is
  // already inline in the schematron user message, so constrained decoding
  // on top of it is redundant and, on real markup, harmful.
  const body = JSON.stringify({
    model: opts.model,
    messages: buildExtractionMessages(promptMode, opts.html, opts.schema),
    temperature: 0,
    max_tokens: COMPLESION_TOKENS,
    ...(promptMode === "schematron"
      ? {}
      : { response_format: { type: "json_schema", json_schema: { name: "extract", strict: true, schema: opts.schema } } }),
  });
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (opts.apiKey) headers.authorization = `Bearer ${opts.apiKey}`;

  let lastStatus = 0;
  let lastBody = "";
  for (let attempt = 1; attempt <= 2; attempt++) {
    let res: Response;
    try {
      res = await fetch(url, { method: "POST", headers, body, signal: AbortSignal.timeout(opts.timeoutMs) });
    } catch (e) {
      const err = e as Error;
      if (err.name === "TimeoutError" || err.name === "AbortError") {
        throw new CdpError(
          `extract_page: upstream call to ${opts.baseUrl} timed out after ${opts.timeoutMs}ms`,
        );
      }
      // fetch's network-level failure mode is a TypeError; anything carrying
      // upstream text through it still passes redaction on the way out.
      throw new CdpError(
        `extract_page: could not reach ${opts.baseUrl} (${redactSecrets(err.message, opts.apiKey)}) — is ferry running?`,
      );
    }
    const text = await res.text();
    if (res.ok) {
      let parsed: ChatCompletionResponse;
      try {
        parsed = JSON.parse(text) as ChatCompletionResponse;
      } catch {
        throw new CdpError(
          `extract_page: endpoint returned a non-JSON 200 body: ${excerpt(redactSecrets(text, opts.apiKey), 200)}`,
        );
      }
      if (parsed.error) {
        throw new CdpError(
          `extract_page: upstream_error from ${opts.baseUrl}: ${excerpt(redactSecrets(String(parsed.error.message ?? JSON.stringify(parsed.error)), opts.apiKey), 600)}`,
        );
      }
      const content = parsed.choices?.[0]?.message?.content;
      if (typeof content !== "string" || content.length === 0) {
        throw new CdpError(
          `extract_page: endpoint response carried no message content: ${excerpt(redactSecrets(text, opts.apiKey), 200)}`,
        );
      }
      const u = parsed.usage ?? {};
      const usage: ExtractUsage = {
        promptTokens: u.prompt_tokens ?? 0,
        completionTokens: u.completion_tokens ?? 0,
        totalTokens: u.total_tokens ?? 0,
        ...(pickCostUsd(u) !== undefined ? { costUsd: pickCostUsd(u) } : {}),
      };
      const fr = parsed.choices?.[0]?.finish_reason;
      const finishReason = typeof fr === "string" ? fr : undefined;
      return { content, usage, model: parsed.model ?? opts.model, finishReason };
    }
    lastStatus = res.status;
    lastBody = text;
    if (res.status === 429) {
      const retryAfter = res.headers.get("retry-after");
      throw new CdpError(
        `extract_page: upstream rate-limited (HTTP 429) from ${opts.baseUrl}${retryAfter !== null ? `, retry-after: ${retryAfter}` : " (no retry-after header)"}`,
      );
    }
    if (res.status < 500 || res.status >= 600) break; // not retryable, not 5xx
    // 5xx on the FIRST attempt falls through to the single retry; on the
    // second it exits the loop into the error below.
  }
  throw new CdpError(
    `extract_page: upstream_error HTTP ${lastStatus} from POST ${url}: ${excerpt(redactSecrets(lastBody, opts.apiKey), 600)}`,
  );
}

/* --------------------------------- the tool --------------------------------- */

/** Acquire, run, always release — the local twin of shared-tools.ts's
 *  file-private withPage (that file is owned elsewhere; the 8 lines are
 *  replicated rather than widening its exports mid-flight). */
async function withPage<T>(driver: BrowserDriver, target: TargetSelector, fn: (page: PageDriver) => Promise<T>): Promise<T> {
  const page = await driver.page(target);
  try {
    return await fn(page);
  } finally {
    await page.release();
  }
}

/**
 * Extract schema-conformant JSON from the target page: clean its HTML in-page,
 * enforce the size guard, POST to the OpenAI-compatible endpoint with the
 * caller's schema as a strict json_schema response_format, and return the
 * parsed JSON plus the token usage that produced it.
 */
export async function extractPage(
  driver: BrowserDriver,
  args: ExtractPageArgs,
): Promise<ExtractPageResult | ExtractPageSaveResult> {
  validateExtractArgs(args);
  const clean = args.clean ?? "standard";
  const maxChars = args.maxChars ?? extractMaxChars();
  const timeoutMs = Math.min(args.timeoutMs ?? extractTimeoutMs(), MAX_TIMEOUT_MS);
  const baseUrl = args.baseUrl ?? extractBaseUrl();
  const model = args.model ?? extractModel();
  // The arg wins over the env; validateExtractArgs already refused any other
  // value from either source, so the cast cannot widen the contract.
  const prompt = (args.prompt ?? extractPromptMode()) as "html" | "schematron";
  const apiKey = extractApiKey();

  return withPage(driver, args.target, async (page) => {
    // The builder emits a zero-arg function declaration; evaluate() takes an
    // EXPRESSION, so wrap-and-call in parens (both drivers evaluate the
    // string as-is when no args are given).
    const source = `(${buildCleanFunctionSource(args.selector, clean)})()`;
    const outcome = coerceCleanOutcome(await page.evaluate(source, { awaitPromise: true }), args.selector);
    const estTokens = guardSize(outcome, maxChars);

    const { content, usage, model: respondedModel, finishReason } = await callExtractionEndpoint({
      baseUrl,
      apiKey,
      model,
      html: outcome.html,
      schema: args.schema,
      timeoutMs,
      prompt,
    });

    // A completion cut off at max_tokens is NOT a JSON bug, and the endpoint
    // says so in finish_reason. Without this check the truncated tail surfaces
    // as "Unterminated string", which reads as a model or quoting defect and
    // sends the operator debugging the wrong layer. The remedy is to shrink
    // the payload (selector) or the schema, so name that here.
    if (finishReason === "length") {
      throw new CdpError(
        `extract_page: completion truncated at max_tokens=${COMPLESION_TOKENS} (finish_reason=length, ${usage.completionTokens} completion tokens); ` +
          `narrow the payload with 'selector' or ask the schema for less: ${excerpt(redactSecrets(content, apiKey), 200)}`,
      );
    }

    let data: unknown;
    try {
      data = JSON.parse(content);
    } catch (e) {
      throw new CdpError(
        `extract_page: endpoint returned invalid JSON (${(e as Error).message}${finishReason !== undefined ? `, finish_reason=${finishReason}` : ""}): ${excerpt(redactSecrets(content, apiKey), 200)}`,
      );
    }
    // In "schematron" mode nothing constrains the shape server-side (no
    // response_format), so a syntactically valid but non-object payload
    // (array/null/primitive) is caught here with the same invalid-JSON error
    // shape used above.
    if (data === null || typeof data !== "object" || Array.isArray(data)) {
      throw new CdpError(
        `extract_page: endpoint returned invalid JSON (expected a JSON object${finishReason !== undefined ? `, finish_reason=${finishReason}` : ""}): ${excerpt(redactSecrets(content, apiKey), 200)}`,
      );
    }

    const result: ExtractPageResult = {
      data,
      model: respondedModel,
      usage,
      html: {
        source: "dom",
        rawBytes: outcome.rawBytes,
        cleanBytes: outcome.cleanBytes,
        estTokens,
        dropped: outcome.dropped,
      },
      target: { id: page.info.id, url: page.info.url, title: page.info.title },
    };
    if (args.savePath === undefined || args.savePath === "") return result;

    // Local copy of shared-tools.ts's file-private writeJsonSink (~20 lines,
    // replicated for the same ownership reason as withPage above): absolute
    // path as-is, relative under the artifact dir, parents created, full
    // result object written, and NOTHING value-shaped leaked back inline.
    const path = args.savePath.startsWith("/") ? args.savePath : join(ARTIFACT_DIR, args.savePath);
    await mkdir(dirname(path), { recursive: true });
    const json = JSON.stringify(result, null, 2);
    await writeFile(path, json, "utf8");
    const saved: ExtractPageSaveResult = {
      path,
      bytes: Buffer.byteLength(json, "utf8"),
      model: respondedModel,
      usage,
      target: result.target,
    };
    return saved;
  });
}

/*
 * ---------------------------------------------------------------------------
 * Driver-surface module (both backends, no raw CDP): the ONLY page access is
 * BrowserDriver.page() -> PageDriver.evaluate() (Chrome: Runtime.evaluate via
 * openPage/resolveTarget → assertLeaseOk, the standard choke point; Firefox:
 * script.evaluate via resolveContext → assertLeaseOk). No other CDP/BiDi
 * method is used, and the live DOM is never mutated (cleaning runs on a clone).
 *
 * Upstream dependency (global fetch, zero npm deps): POST ${baseUrl}/chat/completions
 * with response_format json_schema strict in "html" mode only ("schematron"
 * mode omits it — see callExtractionEndpoint); default baseUrl is the loopback
 * llm-ferry (http://127.0.0.1:8090/v1, model "schematron"). If it is not
 * running, the network error names the URL and asks "is ferry running?".
 *
 * Parity gaps / known limits:
 *   - source:"served" (raw server response before rendering) is REJECTED as
 *     not-implemented; only the live rendered DOM ("dom") is read.
 *   - A scoped selector piercing an open shadow root serializes the matched
 *     element's LIGHT DOM; shadow content and closed roots do not serialize.
 *   - The response is JSON.parse'd only; it is NOT re-validated against the
 *     caller's schema (no schema-validation dep by contract) — strict
 *     json_schema mode is the conformance mechanism.
 *   - The token estimate (chars/3.5) guards the context budget; the true
 *     count is whatever usage.prompt_tokens reports after the call.
 * ---------------------------------------------------------------------------
 */
