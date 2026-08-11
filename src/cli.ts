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
import { resolveBrowserKind, stripBrowserFlag, startFirefoxSession } from "./backend.ts";
import { toolAvailability } from "./capabilities.ts";
import { FIREFOX_TOOLS } from "./firefox-tools.ts";
import { leaseFromArgs, withLeaseScope } from "./leases.ts";
import { MANIFEST } from "./manifest.ts";

const USAGE = `cdp-toolkit: raw single-target CDP, 29-tool chrome-devtools-mcp parity, plus a Firefox backend over WebDriver BiDi.

Usage:
  bun run src/cli.ts <tool> [--browser chrome|firefox] [--target <sel>] [--json '<obj>'] [--<key> <value> ...]
  bun run src/cli.ts --list [--browser chrome|firefox]
  bun run src/cli.ts --capabilities [--browser chrome|firefox]
  bun run src/cli.ts --help | -h                 # this message
  bun run src/cli.ts <tool> --help | -h           # that tool's arguments, sourced from its schema

Examples:
  bun run src/cli.ts list_pages
  bun run src/cli.ts navigate_page --target index:0 --url https://example.com
  bun run src/cli.ts click --target index:0 --uid 42
  bun run src/cli.ts evaluate_script --json '{"expression":"1+2"}'
  bun run src/cli.ts take_screenshot --target url:example --fullPage true
  bun run src/cli.ts --browser firefox take_snapshot
  bun run src/cli.ts --capabilities --browser firefox
  bun run src/cli.ts take_screenshot --help

--help/-h is recognised ANYWHERE in argv, before any tool dispatch: it never touches the
browser (no CDP connection, no lease, no file written) and is never passed through as a tool
argument, even when it appears after a tool name.

Backend selection: --browser chrome|firefox, else the CDP_BROWSER env var, else "chrome" (default,
zero behavior change for existing users). Firefox is LAUNCHED per invocation (it cannot be attached
to), used for exactly one tool call, then disposed before the process exits.

Target selector grammar: active | index:N | url:<substr> | title:<substr> | label:<name> | <targetId>
  plus worker:<substr> (Chrome only) for evaluate_script, list_network_requests, get_network_request
  and list_console_messages ONLY: an MV3 extension's background service worker, e.g.
  worker:<extension-id>. An idle-evicted worker is started first unless wake:false. Recording a
  worker keeps it alive for the length of the capture.
Leases: pass --lease <token> to act on a tab another agent claimed with claim_page (MCP only).
Run list_leases to see who holds what; release_page --lease <token> gives a lease back.
Run with --list to print every tool name available under the selected backend.
Run with --capabilities to see, per tool, whether it is available and (if not) which capability
the selected backend is missing.`;

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
  capabilities: boolean;
  help: boolean;
  args: Record<string, unknown>;
}

/** Parse process argv (already sliced to drop the runtime + script, and with --browser already stripped). */
function parseArgv(argv: string[]): ParsedArgs {
  const out: ParsedArgs = { list: false, capabilities: false, help: false, args: {} };
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
    if (token === "--capabilities") {
      out.capabilities = true;
      continue;
    }
    // Recognised ANYWHERE in argv (not just as the first token), and BEFORE the
    // generic "--key value" branch below, so --help/-h can never be swallowed as
    // a tool argument (the bug: `take_screenshot --help` used to run the tool
    // with args.help=true; `-h` doesn't even start with "--", so without this
    // explicit check it fell through to the positional branch and, if a tool
    // name was already set, was silently dropped and the tool ran anyway).
    if (token === "--help" || token === "-h") {
      out.help = true;
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

/** A JSON-Schema property shape narrow enough for the fields --help prints. */
interface HelpProp {
  type?: string | string[];
  enum?: unknown[];
  description?: string;
}

/** "string", "string|array" (a union type array), or an enum rendered as "png|jpeg". */
function formatType(prop: HelpProp | undefined): string {
  if (!prop) return "any";
  if (Array.isArray(prop.enum) && prop.enum.length > 0) return prop.enum.map(String).join("|");
  if (Array.isArray(prop.type)) return prop.type.join("|");
  return prop.type ?? "any";
}

/**
 * Print one tool's usage sourced ENTIRELY from MANIFEST's inputSchema (src/manifest.ts) — the
 * same JSON Schema the MCP server advertises via tools/list. This is a read of that single
 * source of truth, not a second hand-maintained argument list that could drift from it.
 */
function printToolHelp(name: ToolName): void {
  const spec = MANIFEST.find((t) => t.name === name);
  if (!spec) {
    // Every TOOLS entry has a MANIFEST entry (auditCoverage() in mcp.ts warns otherwise); this
    // is a defensive fallback, not an expected path.
    process.stdout.write(`${name}\n`);
    return;
  }
  const required = new Set(spec.inputSchema.required ?? []);
  const props = (spec.inputSchema.properties ?? {}) as Record<string, HelpProp>;
  const keys = Object.keys(props);

  const lines = [spec.name, "", spec.description, ""];
  if (keys.length === 0) {
    lines.push("Arguments: none.");
  } else {
    lines.push("Arguments:");
    for (const key of keys) {
      const prop = props[key];
      const reqTag = required.has(key) ? "required" : "optional";
      lines.push(`  --${key} <${formatType(prop)}> (${reqTag})`);
      if (prop?.description) lines.push(`      ${prop.description}`);
    }
  }
  lines.push("", `Usage: cdp ${spec.name} [--target <sel>] [--json '<obj>'] [--<key> <value> ...]`);
  process.stdout.write(`${lines.join("\n")}\n`);
}

async function main(): Promise<number> {
  const rawArgv = process.argv.slice(2);
  const browser = resolveBrowserKind(rawArgv);
  const parsed = parseArgv(stripBrowserFlag(rawArgv));

  // --help/-h short-circuits BEFORE any availability lookup or backend touch — no CDP
  // connection, no lease, no file written. This must be the very first thing checked in
  // main(), ahead of --list/--capabilities, so a --help gesture can never be downgraded
  // into a real dispatch by any branch below it.
  if (parsed.help) {
    if (!parsed.tool) {
      process.stdout.write(`${USAGE}\n`);
      return 0;
    }
    if (!isToolName(parsed.tool)) {
      process.stderr.write(
        `${JSON.stringify({ error: `unknown tool '${parsed.tool}'. Run --list to see all ${TOOL_NAMES.length} tools.` })}\n`,
      );
      return 1;
    }
    printToolHelp(parsed.tool);
    return 0;
  }

  const availability = toolAvailability(browser);
  const availableSet = new Set(availability.available);

  if (parsed.capabilities) {
    const lines = [`backend: ${browser}`, "", "available:"];
    for (const name of availability.available) lines.push(`  ${name}`);
    lines.push("", "unavailable:");
    for (const u of availability.unavailable) lines.push(`  ${u.name}  (needs: ${u.missing.join(", ")})`);
    process.stdout.write(`${lines.join("\n")}\n`);
    return 0;
  }

  if (parsed.list) {
    process.stdout.write(`${availability.available.join("\n")}\n`);
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

  if (!availableSet.has(parsed.tool)) {
    const gap = availability.unavailable.find((u) => u.name === parsed.tool);
    process.stderr.write(
      `${JSON.stringify({
        error: `tool '${parsed.tool}' is not available under --browser ${browser}${gap ? ` (needs: ${gap.missing.join(", ")})` : ""}. Run --capabilities --browser ${browser} to see the full list.`,
      })}\n`,
    );
    return 1;
  }

  // Decision: the CLI cannot claim a lease. Per backend.ts, a CLI invocation is
  // one process per call, so the claiming process is already dead by the next
  // call and the dead-pid rule would make the lease reclaimable at once,
  // regardless of ttlMs. A lease that is reclaimable on arrival is worse than
  // no lease, because it reads as protection that is not there. Every OTHER
  // CLI call still goes through assertLeaseOk and may present --lease.
  if (parsed.tool === "claim_page") {
    process.stderr.write(
      `${JSON.stringify({
        error:
          "claim_page is not available from the CLI: a CLI invocation is one process per call, so the lease it claimed would be reclaimable immediately by the dead-pid rule. Claim from the cdp-toolkit MCP server, which is long lived, then pass the token to CLI calls with --lease <token>.",
      })}\n`,
    );
    return 1;
  }

  // ONE lease scope per invocation, wrapping BOTH backend branches, exactly as
  // mcp.ts does. `--lease <token>` lands in parsed.args like any other flag, so
  // no tool signature changes and a tool added later is covered for free.
  const tool = parsed.tool;
  return withLeaseScope(leaseFromArgs(parsed.args), async () => {
    if (browser === "chrome") {
      const fn = TOOLS[tool];
      // The registry's value type is the union of all tool signatures; each tool
      // validates its own args at runtime, so we hand the parsed object through.
      const result = await (fn as (args: unknown) => Promise<unknown>)(parsed.args);
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
      return 0;
    }

    // Firefox: one process per invocation. Launch, run exactly one tool call, always dispose,
    // even if the tool call itself throws, so the spawned Firefox process never leaks.
    const neutralFn = FIREFOX_TOOLS[tool];
    if (!neutralFn) {
      process.stderr.write(`${JSON.stringify({ error: `tool '${tool}' has no Firefox implementation wired` })}\n`);
      return 1;
    }
    const session = await startFirefoxSession();
    try {
      const result = await neutralFn(session.driver, parsed.args as never);
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
      return 0;
    } finally {
      await session.dispose();
    }
  });
}

main()
  .then((code) => process.exit(code))
  .catch((err: unknown) => {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`${JSON.stringify({ error: message })}\n`);
    process.exit(1);
  });
