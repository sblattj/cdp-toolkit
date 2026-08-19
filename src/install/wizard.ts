/**
 * `cdp install` — the interactive-or-flags installer that ties the two sibling install modules
 * together into one command:
 *
 *   1. registers the cdp-toolkit MCP stdio server into the user's chosen coding harness
 *      (claude / codex / opencode), via src/install/harness.ts, and
 *   2. appends a shell alias that launches the user's chosen browser with the remote-debugging
 *      port open, via src/install/browser.ts (the user chose AUTO-APPEND to the shell rc).
 *
 * This module owns ONLY the orchestration and the human interaction (flag parsing, interactive
 * prompts, confirmation, summary). The actual writes — harness config and shell rc — are delegated
 * to the two sibling modules; nothing here reimplements them.
 *
 * Test seams: runInstaller takes an `io` object whose `configPath` / `homeDir` (harness config
 * target) and `rcPath` (shell rc target) let a test point every write at a temp file, so the
 * installer can be exercised end-to-end without touching the real ~/.claude.json or ~/.zshrc.
 * `stdout` / `stderr` default to the real process streams.
 */
import { createInterface } from "node:readline";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  aliasLine,
  appendAliasToRc,
  defaultAliasName,
  detectBrowser,
  detectShellRc,
  type BrowserChoice,
  type RcAppendResult,
} from "./browser.ts";
import {
  installMcpServer,
  type HarnessChoice,
  type InstallResult,
  type McpServerConfig,
} from "./harness.ts";

export interface InstallArgs {
  harness?: HarnessChoice;
  browser?: BrowserChoice;
  port?: number;
  name?: string;
  alias?: boolean;
  aliasName?: string;
  yes?: boolean;
  help?: boolean;
}

export interface InstallerIO {
  /** Whether we're attached to an interactive terminal. Defaults to process.stdin.isTTY. */
  isTTY?: boolean;
  /** Harness config path override (claude only). Test seam — points the write at a temp file. */
  configPath?: string;
  /** os.homedir() override when deriving the default claude config path. Test seam. */
  homeDir?: string;
  /** Shell rc path override. Test seam — points the alias append at a temp file. */
  rcPath?: string;
  /** stdout sink. Defaults to process.stdout.write. */
  stdout?: (s: string) => void;
  /** stderr sink. Defaults to process.stderr.write. */
  stderr?: (s: string) => void;
}

const DEFAULT_NAME = "cdp-toolkit";
const HARNESSES: readonly HarnessChoice[] = ["claude", "codex", "opencode"];
const BROWSERS: readonly BrowserChoice[] = ["arc", "chrome", "firefox"];

/* --------------------------------- pure: arg parsing --------------------------------- */

/** Default remote-debugging port per browser: firefox listens on 9223 here, chromium on 9222. */
function defaultPortFor(browser: BrowserChoice): number {
  return browser === "firefox" ? 9223 : 9222;
}

function parseHarness(v: string | undefined): HarnessChoice {
  if (v === undefined) throw new Error("--harness requires a value: claude, codex, or opencode");
  if ((HARNESSES as readonly string[]).includes(v)) return v as HarnessChoice;
  throw new Error(`--harness must be one of claude|codex|opencode (got '${v}')`);
}

function parseBrowserChoice(v: string | undefined): BrowserChoice {
  if (v === undefined) throw new Error("--browser requires a value: arc, chrome, or firefox");
  if ((BROWSERS as readonly string[]).includes(v)) return v as BrowserChoice;
  throw new Error(`--browser must be one of arc|chrome|firefox (got '${v}')`);
}

function parsePort(v: string | undefined): number {
  if (v === undefined) throw new Error("--port requires a value (an integer 1-65535)");
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1 || n > 65535) {
    throw new Error(`--port must be an integer 1-65535 (got '${v}')`);
  }
  return n;
}

/** Expand `--key=value` into `["--key", "value"]` so both forms parse; leaves everything else alone. */
function normalizeArgv(argv: string[]): string[] {
  const out: string[] = [];
  for (const t of argv) {
    if (t.startsWith("--") && t.includes("=")) {
      const eq = t.indexOf("=");
      out.push(t.slice(0, eq), t.slice(eq + 1));
    } else {
      out.push(t);
    }
  }
  return out;
}

/**
 * PURE. Parse `cdp install` flags. Throws on an unknown option, a missing required value, or an
 * out-of-range/enum-invalid value. Defaults: name="cdp-toolkit", alias=true.
 */
export function parseInstallArgs(argv: string[]): InstallArgs {
  const tokens = normalizeArgv(argv);
  const out: InstallArgs = { name: DEFAULT_NAME, alias: true };
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]!;
    switch (t) {
      case "--help":
      case "-h":
        out.help = true;
        break;
      case "--yes":
      case "-y":
        out.yes = true;
        break;
      case "--no-alias":
        out.alias = false;
        break;
      case "--alias":
        out.alias = true;
        break;
      case "--harness":
        out.harness = parseHarness(tokens[++i]);
        break;
      case "--browser":
        out.browser = parseBrowserChoice(tokens[++i]);
        break;
      case "--port":
        out.port = parsePort(tokens[++i]);
        break;
      case "--name": {
        const v = tokens[++i];
        if (v === undefined) throw new Error("--name requires a value");
        out.name = v;
        break;
      }
      case "--alias-name": {
        const v = tokens[++i];
        if (v === undefined) throw new Error("--alias-name requires a value");
        out.aliasName = v;
        break;
      }
      default:
        throw new Error(`cdp install: unknown option '${t}' (run \`cdp install --help\`)`);
    }
  }
  return out;
}

/* --------------------------------- pure: server config --------------------------------- */

/**
 * PURE. Build the MCP stdio server config for a given browser + debug port.
 *
 * The server always runs `npx -y cdp-toolkit`. Only the env differs by browser, and even then
 * chrome and arc are IDENTICAL: both are driven over CDP, and the driver just talks CDP to
 * whatever is listening on CDP_BASE — the arc-vs-chrome distinction lives entirely in the shell
 * ALIAS (which .app it launches), not in the server env. Firefox is the odd one out: it is driven
 * over WebDriver BiDi, selected by CDP_BROWSER=firefox with the port in CDP_FIREFOX_ENDPOINT.
 */
export function composeServerConfig(browser: BrowserChoice, port: number): McpServerConfig {
  const env: Record<string, string> =
    browser === "firefox"
      ? { CDP_BROWSER: "firefox", CDP_FIREFOX_ENDPOINT: String(port) }
      : { CDP_BASE: `http://127.0.0.1:${port}` };
  return { command: "npx", args: ["-y", "cdp-toolkit"], env };
}

/* --------------------------------- help text --------------------------------- */

export function installHelpText(): string {
  return `cdp install — register the cdp-toolkit MCP server with your coding harness and add a
browser-launch alias (with the remote-debugging port open) to your shell rc.

Usage:
  cdp install [--harness <claude|codex|opencode>] [--browser <arc|chrome|firefox>]
              [--port <n>] [--name <server-name>] [--alias-name <name>]
              [--no-alias] [--yes|-y] [--help|-h]

Options:
  --harness <h>     Coding harness to register the MCP server with: claude, codex, opencode.
  --browser <b>     Browser the alias launches: arc, chrome, firefox.
  --port <n>        Remote-debugging port (1-65535). Default: 9222 (chrome/arc), 9223 (firefox).
  --name <name>     MCP server name to register. Default: ${DEFAULT_NAME}.
  --alias-name <n>  Shell alias name. Default: cdp-<browser> (e.g. cdp-firefox).
  --no-alias        Register the MCP server only; skip writing the shell alias.
  --yes, -y         Skip the confirmation prompt (proceed immediately).
  --help, -h        Show this help.

Interactive: run \`cdp install\` in a terminal with no flags and it prompts for harness, browser,
and port, then asks before writing anything.

Non-interactive (piped/CI): pass at least --harness and --browser (port defaults per browser); a
missing required value fails fast with usage instead of hanging on stdin.`;
}

/* --------------------------------- interactive prompts --------------------------------- */

/** One question over a fresh readline interface, closed before returning. Reached only when TTY. */
async function ask(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return await new Promise<string>((resolve) => rl.question(question, resolve));
  } finally {
    rl.close();
  }
}

async function promptMenu<T extends string>(label: string, options: readonly T[]): Promise<T> {
  const lines = [label];
  options.forEach((o, i) => lines.push(`  ${i + 1}) ${o}`));
  process.stdout.write(`${lines.join("\n")}\n`);
  for (;;) {
    const ans = (await ask(`Enter 1-${options.length}: `)).trim();
    const n = Number(ans);
    if (Number.isInteger(n) && n >= 1 && n <= options.length) return options[n - 1]!;
    process.stdout.write(`Please enter a number between 1 and ${options.length}.\n`);
  }
}

async function promptPort(def: number): Promise<number> {
  for (;;) {
    const ans = (await ask(`Remote-debugging port [${def}]: `)).trim();
    if (ans === "") return def;
    const n = Number(ans);
    if (Number.isInteger(n) && n >= 1 && n <= 65535) return n;
    process.stdout.write("Please enter an integer between 1 and 65535.\n");
  }
}

/* --------------------------------- helpers --------------------------------- */

/** Where the harness config lands, for the pre-write plan. claude → a file path; others → the CLI. */
function harnessTargetDesc(harness: HarnessChoice, io: InstallerIO): string {
  if (harness === "claude") {
    return io.configPath ?? join(io.homeDir ?? homedir(), ".claude.json");
  }
  return `via \`${harness} mcp add\``;
}

/** The env var that overrides binary detection for a given browser (see src/install/browser.ts). */
function binEnvVar(browser: BrowserChoice): string {
  return `${browser.toUpperCase()}_BIN`;
}

/* --------------------------------- orchestration --------------------------------- */

/**
 * Run the installer. Returns a process exit code (0 success, 1 failure). Never throws for an
 * expected condition (bad flags, missing CLI, missing required option in a pipe) — those are
 * reported to stderr and return 1.
 */
export async function runInstaller(argv: string[], io: InstallerIO = {}): Promise<number> {
  const write = io.stdout ?? ((s: string) => void process.stdout.write(s));
  const writeErr = io.stderr ?? ((s: string) => void process.stderr.write(s));
  const isTTY = io.isTTY ?? Boolean(process.stdin.isTTY);

  // 1. parse
  let args: InstallArgs;
  try {
    args = parseInstallArgs(argv);
  } catch (err) {
    writeErr(`${(err as Error).message}\n\n`);
    writeErr(`${installHelpText()}\n`);
    return 1;
  }

  if (args.help) {
    write(`${installHelpText()}\n`);
    return 0;
  }

  // 2. resolve harness/browser/port — prompt when interactive, fail fast in a pipe.
  let harness = args.harness;
  let browser = args.browser;
  let port = args.port;

  if (isTTY) {
    if (harness === undefined) harness = await promptMenu("Which coding harness?", HARNESSES);
    if (browser === undefined) browser = await promptMenu("Which browser?", BROWSERS);
    if (port === undefined) port = await promptPort(defaultPortFor(browser));
  } else {
    const missing: string[] = [];
    if (harness === undefined) missing.push("--harness");
    if (browser === undefined) missing.push("--browser");
    if (missing.length > 0) {
      writeErr(`cdp install: missing required option(s) ${missing.join(", ")} in non-interactive mode.\n`);
      writeErr("Run `cdp install` in a terminal to be prompted, or pass the option(s) explicitly.\n\n");
      writeErr(`${installHelpText()}\n`);
      return 1;
    }
    if (port === undefined) port = defaultPortFor(browser!);
  }

  if (harness === undefined || browser === undefined || port === undefined) {
    // Unreachable: both branches above set all three or return. Defensive for the type-checker.
    writeErr("cdp install: internal error resolving options\n");
    return 1;
  }

  const name = args.name ?? DEFAULT_NAME;
  const writeAlias = args.alias !== false;
  const rcPath = io.rcPath ?? detectShellRc();
  const resolvedAliasName = args.aliasName ?? defaultAliasName(browser);
  const line = aliasLine({ choice: browser, port, aliasName: args.aliasName });

  // 3. confirm the plan (interactive only; --yes or a fully-specified pipe run proceeds).
  if (!args.yes && isTTY) {
    const plan = [
      "",
      "About to:",
      `  - Register MCP server "${name}" with ${harness}  (${harnessTargetDesc(harness, io)})`,
      writeAlias
        ? `  - Append a shell alias to ${rcPath}:\n      ${line}`
        : "  - (skipping shell alias: --no-alias)",
      "",
    ].join("\n");
    write(`${plan}\n`);
    const ans = (await ask("Proceed? [y/N] ")).trim();
    if (!/^y(es)?$/i.test(ans)) {
      write("Aborted. Nothing was written.\n");
      return 0;
    }
  }

  // 4. register the MCP server.
  let harnessResult: InstallResult;
  try {
    harnessResult = await installMcpServer(harness, name, composeServerConfig(browser, port), {
      configPath: io.configPath,
      homeDir: io.homeDir,
    });
  } catch (err) {
    writeErr(`cdp install: could not register the MCP server with ${harness}: ${(err as Error).message}\n`);
    return 1;
  }

  // 5. append the shell alias (unless --no-alias). A missing browser binary is a WARNING, not a
  //    failure: the alias is still written, but we tell the user it won't launch until they fix it.
  let rcResult: RcAppendResult | undefined;
  let browserFound = true;
  if (writeAlias) {
    rcResult = await appendAliasToRc(rcPath, line);
    browserFound = detectBrowser(browser).found;
    if (!browserFound) {
      writeErr(
        `\nWarning: could not find the ${browser} binary at its expected location. The alias was ` +
          `written anyway, but \`${resolvedAliasName}\` will not launch until the binary is found.\n` +
          `  Fix: set ${binEnvVar(browser)}=/path/to/${browser} and re-run \`cdp install\`, or edit the\n` +
          `  alias line in ${rcPath} to point at the real binary.\n`,
      );
    }
  }

  // 6. summary + next steps.
  const summary: string[] = [
    "",
    "cdp-toolkit install complete.",
    "",
    `Harness: ${harness}`,
    `  server name: ${name}`,
    harnessResult.path ? `  config:      ${harnessResult.path}` : `  registered:  ${harnessTargetDesc(harness, io)}`,
    `  method:      ${harnessResult.method}`,
    `  action:      ${harnessResult.action}${harnessResult.detail ? `  (${harnessResult.detail})` : ""}`,
  ];

  if (writeAlias && rcResult) {
    summary.push(
      "",
      `Browser alias: ${resolvedAliasName} -> ${rcResult.rcPath}`,
      `  action:  ${rcResult.action}`,
      `  line:    ${line}`,
    );
    if (!browserFound) summary.push(`  note:    ${browser} binary not found yet (see warning above)`);
  } else {
    summary.push("", "Browser alias: skipped (--no-alias).");
  }

  summary.push("", "Next steps:");
  if (writeAlias && rcResult) {
    summary.push(
      `  1. Load the alias into your shell:  source ${rcResult.rcPath}   (or open a new terminal)`,
      `  2. Launch the browser with the debug port open:  ${resolvedAliasName}`,
      `  3. Restart / reconnect ${harness} so it picks up the "${name}" MCP server.`,
    );
    if (browser === "firefox") {
      summary.push(
        "",
        "Firefox note: the alias includes --marionette, which cdp-toolkit needs for its orphan",
        "auto-recovery path — don't remove it.",
      );
    }
  } else {
    summary.push(`  1. Restart / reconnect ${harness} so it picks up the "${name}" MCP server.`);
  }
  summary.push("");

  write(`${summary.join("\n")}\n`);
  return 0;
}
