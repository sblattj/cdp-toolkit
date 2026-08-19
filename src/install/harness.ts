/**
 * Registering the cdp-toolkit MCP stdio server into a coding-agent harness.
 *
 * Three harnesses, three different registration mechanisms, chosen per-harness
 * from what was actually verified against real on-disk configs, the official
 * docs, and the installed CLIs (not assumed):
 *
 * - claude: `claude mcp add` is NOT an upsert — it errors on a duplicate
 *   server name. So this does a direct read-modify-write of the JSON config
 *   (~/.claude.json) instead, which is naturally idempotent: same input in,
 *   same file out, unrelated keys and servers preserved untouched.
 * - codex: no confirmed idempotent single command, so this shells out to
 *   `codex mcp add`, first checking `codex mcp get <name>` and doing a
 *   remove-then-add when the name already exists.
 * - opencode: `opencode mcp add` is a confirmed idempotent upsert (verified
 *   against its source), so this just shells out to it directly.
 *
 * Only the pure argv builders (codexAddArgs, opencodeAddArgs) and the
 * claude-side JSON shape are exported for unit testing; the codex/opencode
 * shell-outs are not covered by tests here because doing so would mean either
 * running the real CLIs or mocking node:child_process, and the spec for this
 * module calls only for testing the pure builders plus the claude RMW path.
 */
import { spawnSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export type HarnessChoice = "claude" | "codex" | "opencode";

export interface McpServerConfig {
  command: string;
  args: string[];
  env: Record<string, string>;
}

export interface InstallResult {
  harness: HarnessChoice;
  method: "file" | "cli";
  path?: string;
  action: "added" | "updated" | "unchanged";
  detail?: string;
}

export interface InstallOpts {
  /** Overrides the on-disk config path (claude only). For tests. */
  configPath?: string;
  /** Overrides os.homedir() when deriving the default config path (claude only). For tests. */
  homeDir?: string;
}

export async function installMcpServer(
  harness: HarnessChoice,
  name: string,
  cfg: McpServerConfig,
  opts: InstallOpts = {},
): Promise<InstallResult> {
  switch (harness) {
    case "claude":
      return installClaude(name, cfg, opts);
    case "codex":
      return installCodex(name, cfg);
    case "opencode":
      return installOpencode(name, cfg);
    default: {
      const exhaustive: never = harness;
      throw new Error(`unknown harness: ${String(exhaustive)}`);
    }
  }
}

/* ------------------------------- claude: file RMW ------------------------------- */

async function installClaude(name: string, cfg: McpServerConfig, opts: InstallOpts): Promise<InstallResult> {
  const path = opts.configPath ?? join(opts.homeDir ?? homedir(), ".claude.json");

  let root: Record<string, unknown>;
  let fileExisted: boolean;
  try {
    const text = await readFile(path, "utf8");
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new Error(`${path} does not contain a JSON object at its top level`);
    }
    root = parsed as Record<string, unknown>;
    fileExisted = true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      root = {};
      fileExisted = false;
    } else {
      throw err;
    }
  }

  const rawServers = root.mcpServers;
  const mcpServers: Record<string, unknown> =
    typeof rawServers === "object" && rawServers !== null && !Array.isArray(rawServers)
      ? (rawServers as Record<string, unknown>)
      : {};
  root.mcpServers = mcpServers;

  // No `type` field: stdio is the implicit default for this shape in
  // ~/.claude.json, and adding one would diverge from what `claude mcp add`
  // itself writes for a stdio server.
  const entry: Record<string, unknown> = { command: cfg.command, args: cfg.args };
  if (Object.keys(cfg.env).length > 0) entry.env = cfg.env;

  const prior = mcpServers[name];
  const action: InstallResult["action"] =
    prior === undefined ? "added" : canonicalJson(prior) === canonicalJson(entry) ? "unchanged" : "updated";

  mcpServers[name] = entry;

  if (action === "unchanged") {
    return { harness: "claude", method: "file", path, action, detail: "no change needed" };
  }

  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(root, null, 2) + "\n", "utf8");

  return {
    harness: "claude",
    method: "file",
    path,
    action,
    detail: fileExisted ? undefined : "created new config file",
  };
}

/** Deep-equality via a key-sorted JSON string, so key order never causes a false "updated". */
function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      out[key] = canonicalize((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  return value;
}

/* -------------------------------- codex: CLI shell-out -------------------------------- */

/** Pure argv builder (argv AFTER `codex`), exported for unit tests. */
export function codexAddArgs(name: string, cfg: McpServerConfig): string[] {
  const envArgs = Object.entries(cfg.env).flatMap(([k, v]) => ["--env", `${k}=${v}`]);
  return ["mcp", "add", name, ...envArgs, "--", cfg.command, ...cfg.args];
}

async function installCodex(name: string, cfg: McpServerConfig): Promise<InstallResult> {
  if (!isOnPath("codex")) {
    throw new Error("codex CLI not found on PATH — install Codex or pick a different harness");
  }

  // codex mcp add is not confirmed idempotent upstream, so probe first and
  // remove-then-add when the name already exists.
  const probe = spawnSync("codex", ["mcp", "get", name], { encoding: "utf8" });
  const exists = probe.status === 0;

  if (exists) {
    const removed = spawnSync("codex", ["mcp", "remove", name], { encoding: "utf8" });
    if (removed.status !== 0) {
      throw new Error(`codex mcp remove ${name} failed: ${(removed.stderr || removed.stdout || "").trim()}`);
    }
  }

  const addArgs = codexAddArgs(name, cfg);
  const added = spawnSync("codex", addArgs, { encoding: "utf8" });
  if (added.status !== 0) {
    throw new Error(`codex ${addArgs.join(" ")} failed: ${(added.stderr || added.stdout || "").trim()}`);
  }

  return {
    harness: "codex",
    method: "cli",
    action: exists ? "updated" : "added",
    detail: added.stdout?.trim() || undefined,
  };
}

/* ------------------------------ opencode: CLI shell-out ------------------------------- */

/** Pure argv builder (argv AFTER `opencode`), exported for unit tests. */
export function opencodeAddArgs(name: string, cfg: McpServerConfig): string[] {
  const envArgs = Object.entries(cfg.env).flatMap(([k, v]) => ["--env", `${k}=${v}`]);
  return ["mcp", "add", name, ...envArgs, "--", cfg.command, ...cfg.args];
}

async function installOpencode(name: string, cfg: McpServerConfig): Promise<InstallResult> {
  if (!isOnPath("opencode")) {
    throw new Error("opencode CLI not found on PATH — install OpenCode or pick a different harness");
  }

  const addArgs = opencodeAddArgs(name, cfg);
  const added = spawnSync("opencode", addArgs, { encoding: "utf8" });
  if (added.status !== 0) {
    throw new Error(`opencode ${addArgs.join(" ")} failed: ${(added.stderr || added.stdout || "").trim()}`);
  }

  // `opencode mcp add` is a confirmed idempotent upsert, and telling "added"
  // from "updated" cheaply would mean an extra `opencode mcp get` round trip
  // whose output shape isn't confirmed; "added" is accurate enough either way
  // since the end state (server registered with this config) is identical.
  return {
    harness: "opencode",
    method: "cli",
    action: "added",
    detail: added.stdout?.trim() || undefined,
  };
}

/* ---------------------------------- shared helpers ------------------------------------ */

function isOnPath(bin: string): boolean {
  const finder = process.platform === "win32" ? "where" : "which";
  const result = spawnSync(finder, [bin], { encoding: "utf8" });
  return result.status === 0;
}
