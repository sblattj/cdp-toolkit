/**
 * console.ts — read console output captured by the recorder.
 *
 *   list_console_messages -> listConsoleMessages
 *   get_console_message   -> getConsoleMessage
 *
 * READ vs CAPTURE model (see recorder.ts header):
 *   - default ({ reload: false }): read the target's shared "latest" buffer
 *     (rec-<targetId>.jsonl) and return its parsed console entries. If no capture
 *     has run for this target, returns an empty list.
 *   - { reload: true }: run a captureWindow (records BOTH console+network into a
 *     unique per-capture file), Page.reload, capture for `durationMs` (default
 *     2500ms), stop, then read+return the console entries from that capture. The
 *     both-domains capture means a network reload never wipes console history.
 */
import { readFile } from "node:fs/promises";
import { CdpError, resolveTarget } from "../client.ts";
import type { TargetSelector } from "../types.ts";
import { recFile, captureWindow } from "./recorder.ts";
import type { RecLine } from "./recorder.ts";

const DEFAULT_CAPTURE_MS = 2500;

/** A normalized console entry returned to callers. */
export interface ConsoleEntry {
  index: number;
  /** Origin domain: "console" (Runtime.consoleAPICalled), "exception" (Runtime.exceptionThrown), "log" (Log.entryAdded). */
  source: "console" | "exception" | "log";
  /** Severity level: log/info/warn/error/debug/verbose. */
  level: string;
  /** Best-effort flattened text of the message. */
  text: string;
  /** Page URL associated with the message, if present. */
  url?: string;
  /** Source line number, if present. */
  lineNumber?: number;
  /** Wall-clock capture time (ms since epoch). */
  ts: number;
}

export interface ListConsoleMessagesArgs {
  target?: TargetSelector;
  /** Record fresh by reloading the page and capturing for a window. */
  reload?: boolean;
  /** Capture window for reload mode (ms). Default 2500. */
  durationMs?: number;
}

export interface GetConsoleMessageArgs {
  target?: TargetSelector;
  /** Zero-based index into the parsed console entries. Default 0. */
  index?: number;
}

/** Stringify a single CDP RemoteObject arg into readable text. */
function remoteObjectToText(arg: Record<string, unknown> | undefined): string {
  if (!arg) return "";
  if (arg.value !== undefined && arg.value !== null) return String(arg.value);
  if (typeof arg.description === "string") return arg.description;
  if (typeof arg.unserializableValue === "string") return arg.unserializableValue;
  if (arg.type === "undefined") return "undefined";
  if (arg.type === "object" && arg.subtype === "null") return "null";
  if (typeof arg.type === "string") return `[${arg.type}]`;
  return "";
}

/** Map a persisted JSONL line into a normalized ConsoleEntry. */
function lineToEntry(line: RecLine, index: number): ConsoleEntry | null {
  const p = line.params;
  if (line.method === "Runtime.consoleAPICalled") {
    const args = Array.isArray(p.args) ? (p.args as Array<Record<string, unknown>>) : [];
    return {
      index,
      source: "console",
      level: typeof p.type === "string" ? p.type : "log",
      text: args.map(remoteObjectToText).join(" "),
      url: undefined,
      ts: line.ts,
    };
  }
  if (line.method === "Runtime.exceptionThrown") {
    const detail = (p.exceptionDetails ?? {}) as Record<string, unknown>;
    const exception = (detail.exception ?? {}) as Record<string, unknown>;
    const text =
      remoteObjectToText(exception) ||
      (typeof detail.text === "string" ? detail.text : "uncaught exception");
    return {
      index,
      source: "exception",
      level: "error",
      text,
      url: typeof detail.url === "string" ? detail.url : undefined,
      lineNumber: typeof detail.lineNumber === "number" ? detail.lineNumber : undefined,
      ts: line.ts,
    };
  }
  if (line.method === "Log.entryAdded") {
    const entry = (p.entry ?? {}) as Record<string, unknown>;
    return {
      index,
      source: "log",
      level: typeof entry.level === "string" ? entry.level : "info",
      text: typeof entry.text === "string" ? entry.text : "",
      url: typeof entry.url === "string" ? entry.url : undefined,
      lineNumber: typeof entry.lineNumber === "number" ? entry.lineNumber : undefined,
      ts: line.ts,
    };
  }
  return null;
}

/** Parse a JSONL buffer file into console entries (skips network lines). */
async function readConsoleEntries(file: string): Promise<ConsoleEntry[]> {
  let raw: string;
  try {
    raw = await readFile(file, "utf8");
  } catch {
    return []; // no buffer yet
  }
  const out: ConsoleEntry[] = [];
  for (const rawLine of raw.split("\n")) {
    const trimmed = rawLine.trim();
    if (!trimmed) continue;
    let line: RecLine;
    try {
      line = JSON.parse(trimmed) as RecLine;
    } catch {
      continue;
    }
    if (line.kind !== "console") continue;
    const entry = lineToEntry(line, out.length);
    if (entry) out.push(entry);
  }
  return out;
}

/**
 * list_console_messages — return console output for the target. With
 * `reload:true`, records a fresh capture window by reloading the page.
 */
export async function listConsoleMessages(args: ListConsoleMessagesArgs = {}): Promise<{
  target: { id: string; url: string; title: string };
  count: number;
  messages: ConsoleEntry[];
  droppedWrites?: number;
}> {
  if (args.reload) {
    const cap = await captureWindow(args.target, args.durationMs ?? DEFAULT_CAPTURE_MS);
    await cap.stop();
    const messages = await readConsoleEntries(cap.file);
    return {
      target: cap.resolved,
      count: messages.length,
      messages,
      droppedWrites: cap.droppedWrites(),
    };
  }

  const target = await resolveTarget(args.target);
  const messages = await readConsoleEntries(recFile(target.id));
  return {
    target: { id: target.id, url: target.url, title: target.title },
    count: messages.length,
    messages,
  };
}

/**
 * get_console_message — return a single console entry by index from the
 * existing buffer for the target. Throws if the index is out of range.
 */
export async function getConsoleMessage(args: GetConsoleMessageArgs = {}): Promise<ConsoleEntry> {
  const target = await resolveTarget(args.target);
  const messages = await readConsoleEntries(recFile(target.id));
  const index = args.index ?? 0;
  const entry = messages[index];
  if (!entry) {
    throw new CdpError(
      `no console message at index ${index} (have ${messages.length}); run list_console_messages or list with reload:true first`,
    );
  }
  return entry;
}

/*
 * CDP methods / domains used (via recorder.ts + this module):
 *   Page.enable           (reload mode)
 *   Page.reload           (reload mode)
 *   Runtime.enable / Runtime.consoleAPICalled / Runtime.exceptionThrown (recorder)
 *   Log.enable / Log.entryAdded                                          (recorder)
 *
 * Parity gaps vs chrome-devtools-mcp:
 *   - RemoteObject args are flattened to text best-effort; deep object inspection
 *     (expandable previews) the DevTools UI shows is not reconstructed.
 *   - Stack traces from exceptions are summarized to the top message + url/line,
 *     not the full frame list.
 *   - Without reload:true the result reflects whatever a prior recorder buffered;
 *     the MCP keeps a live in-process buffer for its managed page.
 */
