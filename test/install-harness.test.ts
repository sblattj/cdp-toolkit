/**
 * Unit tests for src/install/harness.ts.
 *
 * Deliberately does NOT run the real claude/codex/opencode CLIs or touch any
 * real user config: the claude path is exercised through opts.configPath
 * pointed at a per-test temp file, and the codex/opencode paths are only
 * exercised through their pure argv builders (codexAddArgs/opencodeAddArgs),
 * never through installMcpServer, since that would shell out for real.
 *
 * The claude tests are the ones that matter most: `claude mcp add` errors on
 * a duplicate name, so this module's idempotency guarantee rests entirely on
 * the read-modify-write being correct — same input twice must be a no-op, a
 * changed input must update in place, and every unrelated key in the (large,
 * live) ~/.claude.json-shaped file must survive untouched.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  codexAddArgs,
  installMcpServer,
  opencodeAddArgs,
  type McpServerConfig,
} from "../src/install/harness.ts";

let dir = "";

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "cdp-install-harness-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const cfg: McpServerConfig = {
  command: "npx",
  args: ["-y", "cdp-toolkit"],
  env: {},
};

const cfgWithEnv: McpServerConfig = {
  command: "npx",
  args: ["-y", "cdp-toolkit"],
  env: { CDP_ARTIFACT_DIR: "/tmp/cdp-toolkit" },
};

describe("installMcpServer(claude): fresh file", () => {
  test("creates the file with mcpServers.<name>, action added, no type field", async () => {
    const configPath = join(dir, ".claude.json");
    const result = await installMcpServer("claude", "cdp-toolkit", cfg, { configPath });

    expect(result).toEqual({
      harness: "claude",
      method: "file",
      path: configPath,
      action: "added",
      detail: "created new config file",
    });

    const written = JSON.parse(await readFile(configPath, "utf8"));
    expect(written).toEqual({
      mcpServers: {
        "cdp-toolkit": { command: "npx", args: ["-y", "cdp-toolkit"] },
      },
    });
    expect(written.mcpServers["cdp-toolkit"].type).toBeUndefined();
    expect(written.mcpServers["cdp-toolkit"].env).toBeUndefined();

    // trailing newline, 2-space indent
    const raw = await readFile(configPath, "utf8");
    expect(raw.endsWith("\n")).toBe(true);
    expect(raw).toContain('  "mcpServers"');
  });

  test("with a non-empty env, writes an env object", async () => {
    const configPath = join(dir, ".claude.json");
    const result = await installMcpServer("claude", "cdp-toolkit", cfgWithEnv, { configPath });

    expect(result.action).toBe("added");
    const written = JSON.parse(await readFile(configPath, "utf8"));
    expect(written.mcpServers["cdp-toolkit"]).toEqual({
      command: "npx",
      args: ["-y", "cdp-toolkit"],
      env: { CDP_ARTIFACT_DIR: "/tmp/cdp-toolkit" },
    });
    expect(written.mcpServers["cdp-toolkit"].type).toBeUndefined();
  });
});

describe("installMcpServer(claude): preserves unrelated content", () => {
  test("keeps other top-level keys and other mcpServers entries verbatim", async () => {
    const configPath = join(dir, ".claude.json");
    const seed = {
      numStartups: 42,
      theme: "dark",
      someNestedThing: { a: 1, b: [1, 2, 3] },
      mcpServers: {
        "some-other-server": { command: "node", args: ["other.js"], env: { FOO: "bar" } },
      },
    };
    await Bun.write(configPath, JSON.stringify(seed, null, 2) + "\n");

    const result = await installMcpServer("claude", "cdp-toolkit", cfg, { configPath });
    expect(result.action).toBe("added");

    const written = JSON.parse(await readFile(configPath, "utf8"));
    expect(written.numStartups).toBe(42);
    expect(written.theme).toBe("dark");
    expect(written.someNestedThing).toEqual({ a: 1, b: [1, 2, 3] });
    expect(written.mcpServers["some-other-server"]).toEqual({
      command: "node",
      args: ["other.js"],
      env: { FOO: "bar" },
    });
    expect(written.mcpServers["cdp-toolkit"]).toEqual({ command: "npx", args: ["-y", "cdp-toolkit"] });
  });
});

describe("installMcpServer(claude): idempotency", () => {
  test("re-running with identical config is unchanged, and the file content is byte-identical", async () => {
    const configPath = join(dir, ".claude.json");
    await installMcpServer("claude", "cdp-toolkit", cfgWithEnv, { configPath });
    const before = await readFile(configPath, "utf8");

    const result = await installMcpServer("claude", "cdp-toolkit", cfgWithEnv, { configPath });
    expect(result.action).toBe("unchanged");

    const after = await readFile(configPath, "utf8");
    expect(after).toBe(before);
  });

  test("re-running with a changed env updates in place, no duplicate key, still valid JSON", async () => {
    const configPath = join(dir, ".claude.json");
    await installMcpServer("claude", "cdp-toolkit", cfgWithEnv, { configPath });

    const changed: McpServerConfig = {
      command: "npx",
      args: ["-y", "cdp-toolkit"],
      env: { CDP_ARTIFACT_DIR: "/tmp/other-dir" },
    };
    const result = await installMcpServer("claude", "cdp-toolkit", changed, { configPath });
    expect(result.action).toBe("updated");

    const raw = await readFile(configPath, "utf8");
    const written = JSON.parse(raw); // throws if not valid JSON
    expect(Object.keys(written.mcpServers)).toEqual(["cdp-toolkit"]);
    expect(written.mcpServers["cdp-toolkit"].env).toEqual({ CDP_ARTIFACT_DIR: "/tmp/other-dir" });
  });

  test("key-order differences alone do not count as a change", async () => {
    const configPath = join(dir, ".claude.json");
    // Seed with the same logical entry but env keys in a different order and
    // an added-then-removed key ordering wouldn't apply here (single env key),
    // so seed multiple env keys in reverse order vs. what cfg would produce.
    const seeded = {
      mcpServers: {
        "cdp-toolkit": {
          command: "npx",
          args: ["-y", "cdp-toolkit"],
          env: { B: "2", A: "1" },
        },
      },
    };
    await Bun.write(configPath, JSON.stringify(seeded, null, 2) + "\n");

    const matching: McpServerConfig = {
      command: "npx",
      args: ["-y", "cdp-toolkit"],
      env: { A: "1", B: "2" },
    };
    const result = await installMcpServer("claude", "cdp-toolkit", matching, { configPath });
    expect(result.action).toBe("unchanged");
  });
});

describe("installMcpServer(claude): malformed existing file", () => {
  test("non-object top-level JSON throws rather than silently clobbering", async () => {
    const configPath = join(dir, ".claude.json");
    await Bun.write(configPath, JSON.stringify(["not", "an", "object"]));

    await expect(installMcpServer("claude", "cdp-toolkit", cfg, { configPath })).rejects.toThrow();
  });
});

describe("pure argv builders", () => {
  test("codexAddArgs: no env", () => {
    expect(codexAddArgs("cdp-toolkit", cfg)).toEqual(["mcp", "add", "cdp-toolkit", "--", "npx", "-y", "cdp-toolkit"]);
  });

  test("codexAddArgs: with env, one --env pair per entry, before the -- separator", () => {
    const multiEnv: McpServerConfig = {
      command: "npx",
      args: ["-y", "cdp-toolkit"],
      env: { A: "1", B: "2" },
    };
    expect(codexAddArgs("cdp-toolkit", multiEnv)).toEqual([
      "mcp",
      "add",
      "cdp-toolkit",
      "--env",
      "A=1",
      "--env",
      "B=2",
      "--",
      "npx",
      "-y",
      "cdp-toolkit",
    ]);
  });

  test("opencodeAddArgs: no env", () => {
    expect(opencodeAddArgs("cdp-toolkit", cfg)).toEqual([
      "mcp",
      "add",
      "cdp-toolkit",
      "--",
      "npx",
      "-y",
      "cdp-toolkit",
    ]);
  });

  test("opencodeAddArgs: with env, one --env pair per entry, before the -- separator", () => {
    expect(opencodeAddArgs("cdp-toolkit", cfgWithEnv)).toEqual([
      "mcp",
      "add",
      "cdp-toolkit",
      "--env",
      "CDP_ARTIFACT_DIR=/tmp/cdp-toolkit",
      "--",
      "npx",
      "-y",
      "cdp-toolkit",
    ]);
  });
});
