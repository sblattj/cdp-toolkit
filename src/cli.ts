#!/usr/bin/env bun
/**
 * cdp-toolkit CLI.
 *
 *   bun run src/cli.ts <tool> [--target <sel>] [--json '<obj>'] [--<key> <value> ...]
 *   bun run src/cli.ts --list
 *
 * Argv parsing rules (see CONTRACT.md "Integration"):
 *   - First positional token is the tool name (a key of TOOLS).
 *   - `--json '<obj>'` parses a JSON object and merges it into the args object.
 *   - `--target <sel>` sets `args.target` (a TargetSelector string).
 *   - Any other `--key value` pair becomes `args.key`, with the value coerced:
 *       "true"/"false" -> boolean, a numeric string -> number, else the raw
 *       string. A bare `--flag` with no following value (or followed by another
 *       --flag) is treated as boolean true.
 *   - Explicit `--key` pairs OVERRIDE keys merged from `--json` (last writer
 *     wins; --json is applied first, then the individual flags).
 *
 * Output:
 *   - success -> JSON.stringify(result, null, 2) to stdout, exit 0.
 *   - throw   -> JSON.stringify({ error: message }) to stderr, exit 1.
 *   - no tool -> usage message to stderr, exit 1.
 *   - --list  -> all tool names (one per line) to stdout, exit 0.
 */
import { TOOLS, TOOL_NAMES, type ToolName } from "./index.ts";

const USAGE = `cdp-toolkit — raw single-target CDP, 29-tool chrome-devtools-mcp parity.

Usage:
  bun run src/cli.ts <tool> [--target <sel>] [--json '<obj>'] [--<key> <value> ...]
  bun run src/cli.ts --list

Examples:
  bun run src/cli.ts list_pages
  bun run src/cli.ts navigate_page --target index:0 --url https://example.com
  bun run src/cli.ts click --target index:0 --uid 42
  bun run src/cli.ts evaluate_script --json '{"expression":"1+2"}'
  bun run src/cli.ts take_screenshot --target url:example --fullPage true

Target selector grammar: active | index:N | url:<substr> | title:<substr> | <targetId>
Run with --list to print every available tool name.`;

/** Coerce a raw CLI string into boolean / number / string. */
function coerce(raw: string): boolean | number | string {
  if (raw === "true") return true;
  if (raw === "false") return false;
  // Numbers: only when the trimmed string round-trips through Number cleanly.
  if (raw.trim() !== "" && !Number.isNaN(Number(raw)) && /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(raw.trim())) {
    return Number(raw);
  }
  return raw;
}

interface ParsedArgs {
  tool?: string;
  list: boolean;
  args: Record<string, unknown>;
}

/** Parse process argv (already sliced to drop the runtime + script). */
function parseArgv(argv: string[]): ParsedArgs {
  const out: ParsedArgs = { list: false, args: {} };
  // Collect flag pairs separately so --json can be merged BEFORE individual
  // flags override it, regardless of token order.
  let jsonObj: Record<string, unknown> | undefined;
  const flagPairs: Array<[string, unknown]> = [];

  for (let i = 0; i < argv.length; i++) {
    const token = argv[i]!;
    if (token === "--list") {
      out.list = true;
      continue;
    }
    if (token.startsWith("--")) {
      const key = token.slice(2);
      const next = argv[i + 1];
      // A value follows unless we're at the end or the next token is another flag.
      const hasValue = next !== undefined && !next.startsWith("--");
      const rawValue = hasValue ? next! : "true";
      if (hasValue) i++;

      if (key === "json") {
        const parsed = JSON.parse(rawValue) as unknown;
        if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
          throw new Error("--json must be a JSON object");
        }
        jsonObj = parsed as Record<string, unknown>;
        continue;
      }
      if (key === "target") {
        flagPairs.push(["target", rawValue]);
        continue;
      }
      flagPairs.push([key, hasValue ? coerce(rawValue) : true]);
      continue;
    }
    // First non-flag positional is the tool name; ignore any extras.
    if (out.tool === undefined) out.tool = token;
  }

  // --json first, then explicit flags win.
  if (jsonObj) Object.assign(out.args, jsonObj);
  for (const [k, v] of flagPairs) out.args[k] = v;
  return out;
}

function isToolName(name: string): name is ToolName {
  return Object.prototype.hasOwnProperty.call(TOOLS, name);
}

async function main(): Promise<number> {
  const parsed = parseArgv(process.argv.slice(2));

  if (parsed.list) {
    process.stdout.write(`${TOOL_NAMES.join("\n")}\n`);
    return 0;
  }

  if (!parsed.tool) {
    process.stderr.write(`${USAGE}\n`);
    return 1;
  }

  if (!isToolName(parsed.tool)) {
    process.stderr.write(
      `${JSON.stringify({ error: `unknown tool '${parsed.tool}'. Run --list to see all ${TOOL_NAMES.length} tools.` })}\n`,
    );
    return 1;
  }

  const fn = TOOLS[parsed.tool];
  // The registry's value type is the union of all tool signatures; each tool
  // validates its own args at runtime, so we hand the parsed object through.
  const result = await (fn as (args: unknown) => Promise<unknown>)(parsed.args);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  return 0;
}

main()
  .then((code) => process.exit(code))
  .catch((err: unknown) => {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`${JSON.stringify({ error: message })}\n`);
    process.exit(1);
  });
