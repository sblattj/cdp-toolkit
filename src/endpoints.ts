/**
 * Named CDP endpoints (issue #15): one process, several DevTools ports.
 *
 * A LEAF MODULE ON PURPOSE. client.ts, leases.ts and origins.ts all import it,
 * so it imports nothing from this package, only node builtins.
 *
 * CONFIG SOURCES, all optional:
 *   CDP_BASE             the single-endpoint shorthand. It is the endpoint named
 *                        `default`, stored VERBATIM (no normalization, no
 *                        validation), so `${base}${path}` is byte-for-byte what
 *                        it was before this module existed.
 *   CDP_ENDPOINTS        "browser=http://127.0.0.1:9222,teams=http://127.0.0.1:9333?mode=read"
 *   CDP_ENDPOINTS_FILE   path to JSON:
 *                        {"default":"browser","endpoints":{"browser":{"base":"http://127.0.0.1:9222"},
 *                         "teams":{"base":"http://127.0.0.1:9333","readOnly":true}}}
 *                        `"mode":"read"` is accepted as an alias of `"readOnly":true`.
 *
 * PRECEDENCE AND MERGING. The env string and the file are merged, never
 * shadowed: a name both define must define it identically (same base, same
 * mode), otherwise it is a config error, so precedence can never silently pick
 * the wrong port. Order (which matters only for listing) is env string, then
 * file. The DEFAULT endpoint is the file's `"default"` key if present, else the
 * endpoint named `default`. When no source defines `default`, it is synthesized
 * from CDP_BASE, else http://127.0.0.1:9222, exactly as before; it is NOT
 * synthesized when the file names a different default and CDP_BASE is unset.
 * When CDP_BASE is set and the config also defines `default`, both must agree on
 * the base.
 *
 * NAMES are [A-Za-z0-9_]+ (no '-'): the name lands in lease and origin
 * filenames as `lease-chrome@<name>-<targetId>.json`, and a '-' in it would make
 * the name/id boundary unparseable.
 *
 * Malformed config throws EndpointConfigError naming the problem. Nothing here
 * caches a failure: a bad file that gets fixed is picked up on the next call,
 * and endpoint reachability is never consulted at all (connect-per-call already
 * retries a port that was down at startup).
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { readFileSync } from "node:fs";

export interface Endpoint {
  name: string;
  base: string;
  readOnly: boolean;
}

export class EndpointConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EndpointConfigError";
  }
}

/** The implicit base when nothing is configured; unchanged from client.ts's old const. */
export const DEFAULT_CDP_BASE = "http://127.0.0.1:9222";

/** The selector prefix, e.g. `endpoint:teams/title:Chat`. */
export const ENDPOINT_PREFIX = "endpoint:";

const NAME_RE = /^[A-Za-z0-9_]+$/;

export interface EndpointConfig {
  default: Endpoint;
  byName: Map<string, Endpoint>;
}

function checkName(name: string, where: string): void {
  if (!NAME_RE.test(name)) {
    throw new EndpointConfigError(
      `${where}: endpoint name '${name}' is invalid; names are letters, digits and '_' only (no '-', '/', ':' or spaces)`,
    );
  }
}

/** Compare bases on a trailing-slash-insensitive form. Never used to BUILD a URL. */
function sameBase(a: string, b: string): boolean {
  return a.replace(/\/+$/, "") === b.replace(/\/+$/, "");
}

/** Parse one configured base URL (from CDP_ENDPOINTS or the file), pulling out `?mode=`. */
function parseBase(raw: string, where: string): { base: string; mode?: "read" | "write" } {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new EndpointConfigError(`${where}: '${raw}' is not a valid URL (expected e.g. http://127.0.0.1:9222)`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new EndpointConfigError(`${where}: '${raw}' must be an http:// or https:// DevTools origin, not ${url.protocol}`);
  }
  if (url.hash) throw new EndpointConfigError(`${where}: '${raw}' must not carry a #fragment`);
  let mode: "read" | "write" | undefined;
  for (const [key, value] of url.searchParams) {
    if (key !== "mode") {
      throw new EndpointConfigError(`${where}: unknown query parameter '${key}' in '${raw}' (only ?mode=read or ?mode=write is understood)`);
    }
    if (value !== "read" && value !== "write") {
      throw new EndpointConfigError(`${where}: unknown mode '${value}' in '${raw}' (use mode=read or mode=write)`);
    }
    mode = value;
  }
  const path = url.pathname.replace(/\/+$/, "");
  return { base: `${url.protocol}//${url.host}${path}`, mode };
}

function parseEnvString(spec: string): Endpoint[] {
  const out: Endpoint[] = [];
  const seen = new Set<string>();
  for (const part of spec.split(",")) {
    const entry = part.trim();
    if (!entry) continue;
    const eq = entry.indexOf("=");
    if (eq <= 0) {
      throw new EndpointConfigError(`CDP_ENDPOINTS: entry '${entry}' is not name=url (e.g. teams=http://127.0.0.1:9333)`);
    }
    const name = entry.slice(0, eq).trim();
    checkName(name, "CDP_ENDPOINTS");
    if (seen.has(name)) throw new EndpointConfigError(`CDP_ENDPOINTS: duplicate endpoint name '${name}'`);
    seen.add(name);
    const { base, mode } = parseBase(entry.slice(eq + 1).trim(), `CDP_ENDPOINTS endpoint '${name}'`);
    out.push({ name, base, readOnly: mode === "read" });
  }
  return out;
}

function parseFile(path: string): { endpoints: Endpoint[]; defaultName?: string } {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code ?? String(err);
    throw new EndpointConfigError(`CDP_ENDPOINTS_FILE: cannot read '${path}' (${code})`);
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (err) {
    throw new EndpointConfigError(`CDP_ENDPOINTS_FILE: '${path}' is not valid JSON (${err instanceof Error ? err.message : String(err)})`);
  }
  const where = `CDP_ENDPOINTS_FILE '${path}'`;
  if (!json || typeof json !== "object" || Array.isArray(json)) {
    throw new EndpointConfigError(`${where}: top level must be an object {"default"?, "endpoints": {...}}`);
  }
  const top = json as Record<string, unknown>;
  for (const key of Object.keys(top)) {
    if (key !== "default" && key !== "endpoints") throw new EndpointConfigError(`${where}: unknown top-level key '${key}'`);
  }
  if (top.default !== undefined && typeof top.default !== "string") {
    throw new EndpointConfigError(`${where}: "default" must be an endpoint name string`);
  }
  const raw = top.endpoints ?? {};
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new EndpointConfigError(`${where}: "endpoints" must be an object keyed by endpoint name`);
  }
  const endpoints: Endpoint[] = [];
  for (const [name, value] of Object.entries(raw as Record<string, unknown>)) {
    checkName(name, where);
    const at = `${where} endpoint '${name}'`;
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new EndpointConfigError(`${at}: must be an object like {"base":"http://127.0.0.1:9333"}`);
    }
    const v = value as Record<string, unknown>;
    for (const key of Object.keys(v)) {
      if (key !== "base" && key !== "readOnly" && key !== "mode") {
        throw new EndpointConfigError(`${at}: unknown key '${key}' (known: base, readOnly, mode)`);
      }
    }
    if (typeof v.base !== "string") throw new EndpointConfigError(`${at}: "base" is required and must be a URL string`);
    if (v.readOnly !== undefined && typeof v.readOnly !== "boolean") throw new EndpointConfigError(`${at}: "readOnly" must be a boolean`);
    if (v.mode !== undefined && v.mode !== "read" && v.mode !== "write") {
      throw new EndpointConfigError(`${at}: unknown mode '${String(v.mode)}' (use "read" or "write")`);
    }
    const parsed = parseBase(v.base, at);
    const votes = [parsed.mode, v.mode as string | undefined, v.readOnly === undefined ? undefined : v.readOnly ? "read" : "write"].filter(
      (x): x is string => x !== undefined,
    );
    if (new Set(votes).size > 1) throw new EndpointConfigError(`${at}: readOnly / mode settings contradict each other`);
    endpoints.push({ name, base: parsed.base, readOnly: votes[0] === "read" });
  }
  return { endpoints, defaultName: top.default as string | undefined };
}

/**
 * Parse the endpoint config out of `env`. Pure apart from reading
 * CDP_ENDPOINTS_FILE; no caching (see the memoized accessors below).
 */
export function loadEndpoints(env: NodeJS.ProcessEnv = process.env): EndpointConfig {
  const fromEnv = env.CDP_ENDPOINTS !== undefined ? parseEnvString(env.CDP_ENDPOINTS) : [];
  const file = env.CDP_ENDPOINTS_FILE ? parseFile(env.CDP_ENDPOINTS_FILE) : { endpoints: [] as Endpoint[], defaultName: undefined };

  const merged = new Map<string, Endpoint>();
  for (const ep of fromEnv) merged.set(ep.name, ep);
  for (const ep of file.endpoints) {
    const prior = merged.get(ep.name);
    if (prior && (prior.base !== ep.base || prior.readOnly !== ep.readOnly)) {
      throw new EndpointConfigError(
        `endpoint '${ep.name}' is defined differently in CDP_ENDPOINTS (${prior.base}${prior.readOnly ? " read-only" : ""}) and CDP_ENDPOINTS_FILE (${ep.base}${ep.readOnly ? " read-only" : ""})`,
      );
    }
    if (!prior) merged.set(ep.name, ep);
  }

  // CDP_BASE is the endpoint named `default`. Read with `!== undefined`, not
  // truthiness, matching the old `process.env.CDP_BASE ?? ...` exactly.
  const cdpBase = env.CDP_BASE;
  if (cdpBase !== undefined) {
    const configured = merged.get("default");
    if (configured && !sameBase(configured.base, cdpBase)) {
      throw new EndpointConfigError(
        `CDP_BASE (${cdpBase}) and the configured endpoint 'default' (${configured.base}) disagree; drop one or make them match`,
      );
    }
    // Verbatim string, never the normalized one, so a CDP_BASE-only setup builds byte-identical URLs.
    merged.set("default", { name: "default", base: cdpBase, readOnly: configured?.readOnly ?? false });
  }

  const defaultName = file.defaultName ?? "default";
  if (!merged.has(defaultName)) {
    if (file.defaultName !== undefined) {
      throw new EndpointConfigError(
        `CDP_ENDPOINTS_FILE names default endpoint '${file.defaultName}', which is not defined (known: ${[...merged.keys()].join(", ") || "none"})`,
      );
    }
    merged.set("default", { name: "default", base: DEFAULT_CDP_BASE, readOnly: false });
  }

  // The default endpoint first, then config order: listing order and the lease
  // namespace tie-break (see leaseNamespace) both read this order.
  const def = merged.get(defaultName)!;
  const byName = new Map<string, Endpoint>([[def.name, def]]);
  for (const [name, ep] of merged) if (name !== def.name) byName.set(name, ep);
  return { default: def, byName };
}

/* ------------------------------ memoized accessors ------------------------------ */

let cache: { sig: string; config: EndpointConfig } | undefined;

function signature(env: NodeJS.ProcessEnv): string {
  return JSON.stringify([env.CDP_BASE ?? null, env.CDP_ENDPOINTS ?? null, env.CDP_ENDPOINTS_FILE ?? null]);
}

/** The process config, re-parsed whenever the three env vars change. Errors are never cached. */
export function endpointConfig(): EndpointConfig {
  const sig = signature(process.env);
  if (cache?.sig === sig) return cache.config;
  const config = loadEndpoints(process.env);
  cache = { sig, config };
  return config;
}

/** Test hook: forget the memoized config (e.g. after rewriting the file in place). */
export function resetEndpointCache(): void {
  cache = undefined;
}

export function defaultEndpoint(): Endpoint {
  return endpointConfig().default;
}

/** Every configured endpoint, default first. */
export function allEndpoints(): Endpoint[] {
  return [...endpointConfig().byName.values()];
}

export function getEndpoint(name: string): Endpoint {
  const { byName } = endpointConfig();
  const ep = byName.get(name);
  if (!ep) {
    throw new EndpointConfigError(
      `unknown endpoint '${name}' (known: ${[...byName.keys()].join(", ")}). Configure it with CDP_ENDPOINTS or CDP_ENDPOINTS_FILE.`,
    );
  }
  return ep;
}

/**
 * The lease/origin namespace of an endpoint: undefined means the legacy
 * un-suffixed filenames (`lease-chrome-<id>.json`), shared with older
 * processes. That is the default endpoint, and ANY endpoint whose base equals
 * the default's: two names for one browser must share one lease space, or
 * `endpoint:browser/` would walk straight past a lease held through the
 * default. Two non-default names for one base share the namespace of the first
 * declared.
 */
export function leaseNamespace(ep: Endpoint): string | undefined {
  const { default: def, byName } = endpointConfig();
  if (sameBase(ep.base, def.base)) return undefined;
  for (const other of byName.values()) if (sameBase(other.base, ep.base)) return other.name;
  return ep.name;
}

/* ---------------------------------- selectors ---------------------------------- */

/** True when `target` starts with the `endpoint:` prefix. `url:endpoint:x` is NOT a prefix. */
export function hasEndpointPrefix(target: unknown): target is string {
  return typeof target === "string" && target.startsWith(ENDPOINT_PREFIX);
}

/**
 * Split `endpoint:<name>/<rest>` into the endpoint and the remaining selector.
 * No prefix: the default endpoint and the selector unchanged. `endpoint:teams`
 * or `endpoint:teams/` alone: rest undefined (the endpoint's active page).
 */
export function splitEndpointSelector(target: string | undefined): { endpoint: Endpoint; rest: string | undefined } {
  if (!hasEndpointPrefix(target)) return { endpoint: defaultEndpoint(), rest: target };
  const body = target.slice(ENDPOINT_PREFIX.length);
  const slash = body.indexOf("/");
  const name = slash < 0 ? body : body.slice(0, slash);
  if (!name) throw new EndpointConfigError(`selector '${target}' has an empty endpoint name; use endpoint:<name>/<selector>`);
  const rest = slash < 0 ? undefined : body.slice(slash + 1);
  return { endpoint: getEndpoint(name), rest: rest === "" ? undefined : rest };
}

/** Args keys that carry a target selector: `target` everywhere, `targetId` on claim_page. */
export const SELECTOR_KEYS = ["target", "targetId"] as const;

/** The refusal for any endpoint feature under the Firefox backend (mcp.ts and cli.ts). */
export const ENDPOINTS_FIREFOX_MESSAGE =
  "named CDP endpoints (an 'endpoint:<name>/' selector prefix, the endpoint arg, list_pages allEndpoints) need the Chrome backend; the Firefox BiDi backend has one session and no endpoints";

/** True when args ask for any endpoint feature at all (used to refuse them on Firefox, without loading config). */
export function usesEndpointArgs(args: unknown): boolean {
  if (!args || typeof args !== "object") return false;
  const a = args as Record<string, unknown>;
  return SELECTOR_KEYS.some((k) => hasEndpointPrefix(a[k])) || a.endpoint !== undefined || a.allEndpoints === true;
}

/**
 * Resolve the endpoint and strip the prefix: the one place dispatch rewrites
 * args. With no prefix and no `endpoint` key the ORIGINAL object comes back
 * untouched. A prefix that names nothing after the slash deletes the key (so
 * the tool sees its own default, 'active'), and the `endpoint` key itself is
 * removed so no tool's own arg checks ever see it.
 */
export function stripEndpointArgs(args: unknown): { endpoint: Endpoint; args: unknown } {
  if (!args || typeof args !== "object" || Array.isArray(args)) return { endpoint: defaultEndpoint(), args };
  const a = args as Record<string, unknown>;
  const picks: Array<{ from: string; endpoint: Endpoint }> = [];
  let out: Record<string, unknown> | undefined;
  for (const key of SELECTOR_KEYS) {
    const v = a[key];
    if (!hasEndpointPrefix(v)) continue;
    const { endpoint, rest } = splitEndpointSelector(v);
    picks.push({ from: `${key} '${v}'`, endpoint });
    out ??= { ...a };
    if (rest === undefined) delete out[key];
    else out[key] = rest;
  }
  if (a.endpoint !== undefined) {
    if (typeof a.endpoint !== "string" || a.endpoint === "") {
      throw new EndpointConfigError("`endpoint` must be a non-empty endpoint name string");
    }
    picks.push({ from: `endpoint '${a.endpoint}'`, endpoint: getEndpoint(a.endpoint) });
    out ??= { ...a };
    delete out.endpoint;
  }
  // A Chrome lease token names its endpoint too (`chrome@<ns>:<targetId>:<nonce>`), so
  // `release_page {lease}` with no prefix acts on the endpoint the lease was taken on,
  // not the default. The token stays in args: the lease scope still reads it.
  const token = leaseTokenNamespace(a.lease);
  if (!picks.length) {
    if (token?.ns === undefined) return { endpoint: defaultEndpoint(), args };
    return { endpoint: endpointForNamespace(token.ns), args };
  }
  const first = picks[0]!;
  for (const p of picks.slice(1)) {
    if (p.endpoint.name !== first.endpoint.name) {
      throw new EndpointConfigError(`conflicting endpoints: ${first.from} vs ${p.from}; name one endpoint per call`);
    }
  }
  // Compared by lease namespace, not name: two names for one base share one lease space.
  if (token && leaseNamespace(first.endpoint) !== token.ns) {
    throw new EndpointConfigError(
      `conflicting endpoints: ${first.from} vs the lease token, which belongs to ${token.ns === undefined ? "the default endpoint" : `endpoint '${token.ns}'`}; name one endpoint per call`,
    );
  }
  return { endpoint: first.endpoint, args: out ?? a };
}

/**
 * The lease namespace a Chrome lease token was minted under (leases.ts mintToken:
 * `<backend>:<targetId>:<nonce>`, backend `chrome` or `chrome@<ns>`). `{ns: undefined}`
 * is the default namespace (plain `chrome`). null for anything else: no token, a
 * Firefox token, or a malformed one, which the lease layer rejects on its own terms.
 * Parsed here rather than via leases.ts's tokenParts because this module is a leaf.
 */
function leaseTokenNamespace(lease: unknown): { ns: string | undefined } | null {
  if (typeof lease !== "string") return null;
  const colon = lease.indexOf(":");
  if (colon <= 0) return null;
  const head = lease.slice(0, colon);
  if (head === "chrome") return { ns: undefined };
  if (!head.startsWith("chrome@")) return null;
  const ns = head.slice("chrome@".length);
  return NAME_RE.test(ns) ? { ns } : null;
}

/** The first configured endpoint whose lease namespace is `ns` (see leaseNamespace). */
function endpointForNamespace(ns: string): Endpoint {
  for (const ep of endpointConfig().byName.values()) if (leaseNamespace(ep) === ns) return ep;
  throw new EndpointConfigError(
    `the lease token belongs to endpoint '${ns}', which is not configured (known: ${[...endpointConfig().byName.keys()].join(", ")})`,
  );
}

/** The endpoint a call's args select (selector prefix, `endpoint` key, or a `chrome@<ns>` lease token), else the default. */
export function endpointForArgs(args: unknown): Endpoint {
  return stripEndpointArgs(args).endpoint;
}

/* ------------------------------------ scope ------------------------------------ */

const endpointScope = new AsyncLocalStorage<Endpoint>();

/** The endpoint of the enclosing withEndpointScope, else the default endpoint. */
export function currentEndpoint(): Endpoint {
  return endpointScope.getStore() ?? defaultEndpoint();
}

/** True when the current scope is a non-default endpoint (used to tag output rows). */
export function isDefaultEndpoint(ep: Endpoint): boolean {
  return ep.name === defaultEndpoint().name;
}

export function withEndpointScope<T>(ep: Endpoint, fn: () => Promise<T>): Promise<T> {
  return endpointScope.run(ep, fn);
}
