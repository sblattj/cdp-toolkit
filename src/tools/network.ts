/**
 * network.ts — read network activity captured by the recorder.
 *
 *   list_network_requests -> listNetworkRequests
 *   get_network_request   -> getNetworkRequest
 *
 * READ vs CAPTURE model (see recorder.ts header):
 *   - default ({ reload: false }): read the target's shared "latest" buffer
 *     (rec-<targetId>.jsonl), correlate the four Network.* events by requestId,
 *     and return one row per request.
 *   - { reload: true }: run a captureWindow (both domains) — Page.reload, capture
 *     for `durationMs` (default 2500ms), stop, then read+return the requests.
 *
 * Response bodies: CDP only serves a body from the LIVE renderer session, so
 * get_network_request with { includeBody: true } drives a fresh reload capture
 * and calls Network.getResponseBody before closing. Because a reload re-mints
 * requestIds, body fetch is matched by `url` (stable), not by a carried-over
 * requestId — see getNetworkRequest for the exact contract.
 */
import { readFile } from "node:fs/promises";
import { CdpError, resolveTarget } from "../client.ts";
import type { TargetSelector } from "../types.ts";
import { recFile, captureWindow } from "./recorder.ts";
import type { RecLine } from "./recorder.ts";

const DEFAULT_CAPTURE_MS = 2500;

/** A correlated network request row. */
export interface NetworkRequest {
  requestId: string;
  url: string;
  method: string;
  resourceType?: string;
  /** HTTP status code from Network.responseReceived (undefined if pending/failed). */
  status?: number;
  statusText?: string;
  mimeType?: string;
  /** Response headers (lower-cased keys as CDP delivers them). */
  responseHeaders?: Record<string, string>;
  /** Request headers as sent. */
  requestHeaders?: Record<string, string>;
  /** Total encoded bytes received, when loadingFinished reported it. */
  encodedDataLength?: number;
  /** "finished" | "failed" | "pending". */
  state: "finished" | "failed" | "pending";
  /** Failure text from Network.loadingFailed, when state === "failed". */
  errorText?: string;
  /** Capture time of the initiating requestWillBeSent (ms since epoch). */
  ts: number;
}

export interface ListNetworkRequestsArgs {
  target?: TargetSelector;
  reload?: boolean;
  durationMs?: number;
  /** Only return requests whose URL contains this substring. */
  filterUrl?: string;
}

export interface GetNetworkRequestArgs {
  target?: TargetSelector;
  /** Match by exact requestId (metadata only — see includeBody). */
  requestId?: string;
  /** Match by URL substring (first match). Required for body fetch (includeBody). */
  url?: string;
  /** Fetch the response body too (drives a fresh reload capture; use with `url`). */
  includeBody?: boolean;
  durationMs?: number;
}

/** Coerce a CDP headers object to a string-keyed/string-valued record. */
function asHeaders(v: unknown): Record<string, string> | undefined {
  if (!v || typeof v !== "object") return undefined;
  const out: Record<string, string> = {};
  for (const [k, val] of Object.entries(v as Record<string, unknown>)) out[k] = String(val);
  return out;
}

/** Correlate the four Network.* events from a JSONL buffer into request rows. */
function correlate(lines: RecLine[]): NetworkRequest[] {
  const byId = new Map<string, NetworkRequest>();
  const order: string[] = [];

  for (const line of lines) {
    if (line.kind !== "network") continue;
    const p = line.params;
    const requestId = typeof p.requestId === "string" ? p.requestId : undefined;
    if (!requestId) continue;

    if (line.method === "Network.requestWillBeSent") {
      const req = (p.request ?? {}) as Record<string, unknown>;
      if (!byId.has(requestId)) order.push(requestId);
      // requestWillBeSent can fire twice (redirects); keep the first, but always
      // ensure a row exists.
      const existing = byId.get(requestId);
      const row: NetworkRequest = existing ?? {
        requestId,
        url: typeof req.url === "string" ? req.url : "",
        method: typeof req.method === "string" ? req.method : "GET",
        resourceType: typeof p.type === "string" ? p.type : undefined,
        requestHeaders: asHeaders(req.headers),
        state: "pending",
        ts: line.ts,
      };
      byId.set(requestId, row);
    } else if (line.method === "Network.responseReceived") {
      const resp = (p.response ?? {}) as Record<string, unknown>;
      const row = byId.get(requestId);
      if (row) {
        row.status = typeof resp.status === "number" ? resp.status : row.status;
        row.statusText = typeof resp.statusText === "string" ? resp.statusText : row.statusText;
        row.mimeType = typeof resp.mimeType === "string" ? resp.mimeType : row.mimeType;
        row.responseHeaders = asHeaders(resp.headers) ?? row.responseHeaders;
        if (typeof p.type === "string") row.resourceType = p.type;
      }
    } else if (line.method === "Network.loadingFinished") {
      const row = byId.get(requestId);
      if (row) {
        row.state = "finished";
        if (typeof p.encodedDataLength === "number") row.encodedDataLength = p.encodedDataLength;
      }
    } else if (line.method === "Network.loadingFailed") {
      const row = byId.get(requestId);
      if (row) {
        row.state = "failed";
        if (typeof p.errorText === "string") row.errorText = p.errorText;
      }
    }
  }

  return order.map((id) => byId.get(id)!).filter(Boolean);
}

/** Parse a JSONL buffer file into correlated network request rows. */
async function readNetworkRequests(file: string): Promise<NetworkRequest[]> {
  let raw: string;
  try {
    raw = await readFile(file, "utf8");
  } catch {
    return [];
  }
  const lines: RecLine[] = [];
  for (const rawLine of raw.split("\n")) {
    const trimmed = rawLine.trim();
    if (!trimmed) continue;
    try {
      lines.push(JSON.parse(trimmed) as RecLine);
    } catch {
      /* skip malformed line */
    }
  }
  return correlate(lines);
}

/**
 * list_network_requests — correlated request rows for the target. With
 * `reload:true`, records a fresh capture window (both domains) by reloading.
 */
export async function listNetworkRequests(args: ListNetworkRequestsArgs = {}): Promise<{
  target: { id: string; url: string; title: string };
  count: number;
  requests: NetworkRequest[];
  droppedWrites?: number;
}> {
  let file: string;
  let resolved: { id: string; url: string; title: string };
  let droppedWrites: number | undefined;

  if (args.reload) {
    const cap = await captureWindow(args.target, args.durationMs ?? DEFAULT_CAPTURE_MS);
    await cap.stop();
    file = cap.file;
    resolved = cap.resolved;
    droppedWrites = cap.droppedWrites();
  } else {
    const target = await resolveTarget(args.target);
    file = recFile(target.id);
    resolved = { id: target.id, url: target.url, title: target.title };
  }

  let requests = await readNetworkRequests(file);
  if (args.filterUrl) {
    const needle = args.filterUrl;
    requests = requests.filter((r) => r.url.includes(needle));
  }
  return { target: resolved, count: requests.length, requests, droppedWrites };
}

/**
 * get_network_request — return one request (matched by requestId, else by URL
 * substring) including response status/headers.
 *
 * Body retrieval: CDP only serves a response body from the LIVE renderer
 * session, so `includeBody:true` must drive a fresh reload capture and fetch the
 * body before the connection closes. A reload re-mints requestIds, so a body
 * fetch can only be matched by `url` (stable across reload) — NOT by a
 * `requestId` carried over from a prior `list_network_requests`. When a
 * requestId is supplied with includeBody we therefore return metadata from the
 * existing buffer and explain why the body is unavailable, rather than reloading
 * into a guaranteed no-match.
 */
export async function getNetworkRequest(args: GetNetworkRequestArgs = {}): Promise<
  NetworkRequest & { body?: string; bodyBase64Encoded?: boolean; bodyUnavailableReason?: string }
> {
  if (!args.requestId && !args.url) {
    throw new CdpError("get_network_request requires either requestId or url");
  }

  const pick = (requests: NetworkRequest[]): NetworkRequest | undefined => {
    if (args.requestId) return requests.find((r) => r.requestId === args.requestId);
    return requests.find((r) => r.url.includes(args.url!));
  };

  const describeSelector = (): string =>
    args.requestId ? `requestId ${args.requestId}` : `url ~ '${args.url}'`;

  // Body fetch by URL: a fresh reload capture (url is stable across reload).
  if (args.includeBody && args.url) {
    const cap = await captureWindow(args.target, args.durationMs ?? DEFAULT_CAPTURE_MS);
    try {
      await cap.flush(); // ensure the buffer is complete; conn stays open for the body fetch
      const match = (await readNetworkRequests(cap.file)).find((r) => r.url.includes(args.url!));
      if (!match) {
        throw new CdpError(`no network request matched ${describeSelector()} in fresh capture`);
      }
      try {
        const { body, base64Encoded } = await cap.conn.send<{ body: string; base64Encoded: boolean }>(
          "Network.getResponseBody",
          { requestId: match.requestId },
        );
        return { ...match, body, bodyBase64Encoded: base64Encoded };
      } catch {
        // No body (e.g. redirect/204/failed) or already evicted.
        return { ...match, body: undefined, bodyBase64Encoded: undefined };
      }
    } finally {
      await cap.stop();
    }
  }

  // Metadata path: read the target's existing buffer (also the requestId+includeBody case).
  const target = await resolveTarget(args.target);
  const match = pick(await readNetworkRequests(recFile(target.id)));
  if (!match) {
    throw new CdpError(
      `no network request matched ${describeSelector()}; run list_network_requests with reload:true first` +
        (args.includeBody ? `, then fetch the body with the url selector (reload re-mints requestIds)` : ``),
    );
  }
  if (args.includeBody && args.requestId) {
    return {
      ...match,
      body: undefined,
      bodyUnavailableReason:
        "response bodies are only fetchable via a fresh reload capture, which re-mints requestIds; re-request with the `url` selector to retrieve the body",
    };
  }
  return match;
}

/*
 * CDP methods / domains used (via recorder.ts + this module):
 *   Network.enable                                                  (recorder)
 *   Network.requestWillBeSent / .responseReceived / .loadingFinished /
 *     .loadingFailed (events)                                       (recorder)
 *   Network.getResponseBody                                         (includeBody mode)
 *   Page.enable / Page.reload                                       (reload mode)
 *
 * Parity gaps vs chrome-devtools-mcp:
 *   - Response bodies require a fresh reload capture (CDP serves bodies only from
 *     the live session); reading the on-disk buffer yields metadata only.
 *   - Redirect chains collapse to the original requestId's first row; per-hop
 *     redirect entries are not expanded.
 *   - Timing breakdown (DNS/connect/TTFB) and request POST data are not surfaced.
 */
