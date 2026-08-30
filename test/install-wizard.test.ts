/**
 * Unit tests for src/install/wizard.ts (the `cdp install` orchestrator).
 *
 * Nothing here runs the real claude/codex/opencode CLIs or touches any real user config: the
 * claude harness write is redirected at a per-test temp file via io.configPath, and the shell
 * alias is redirected at a per-test temp rc via io.rcPath. stdout/stderr are captured into
 * buffers so the summary/usage can be asserted without spilling to the console.
 *
 * The two shelled-out harnesses (codex/opencode) are NOT exercised through runInstaller — that
 * would require the real CLIs — so this file covers the pure pieces (parseInstallArgs,
 * composeServerConfig), the non-interactive failure path, and the claude happy path end to end.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  composeServerConfig,
  installHelpText,
  parseInstallArgs,
  runInstaller,
  type InstallerIO,
} from "../src/install/wizard.ts";

/* --------------------------------- parseInstallArgs --------------------------------- */

describe("parseInstallArgs", () => {
  test("defaults: name=cdp-toolkit, alias=true, nothing else set", () => {
    expect(parseInstallArgs([])).toEqual({ name: "cdp-toolkit", alias: true });
  });

  test("full flag set parses each field", () => {
    const args = parseInstallArgs([
      "--harness",
      "codex",
      "--browser",
      "chrome",
      "--port",
      "9444",
      "--name",
      "my-cdp",
      "--alias-name",
      "cdp-x",
      "--yes",
    ]);
    expect(args).toEqual({
      harness: "codex",
      browser: "chrome",
      port: 9444,
      name: "my-cdp",
      alias: true,
      aliasName: "cdp-x",
      yes: true,
    });
  });

  test("--no-alias sets alias=false", () => {
    expect(parseInstallArgs(["--no-alias"]).alias).toBe(false);
  });

  test("-y is an alias for --yes, -h for --help", () => {
    expect(parseInstallArgs(["-y"]).yes).toBe(true);
    expect(parseInstallArgs(["-h"]).help).toBe(true);
  });

  test("--key=value form is accepted", () => {
    const args = parseInstallArgs(["--harness=opencode", "--browser=firefox", "--port=9223"]);
    expect(args.harness).toBe("opencode");
    expect(args.browser).toBe("firefox");
    expect(args.port).toBe(9223);
  });

  test("port is coerced to a number", () => {
    expect(parseInstallArgs(["--port", "9222"]).port).toBe(9222);
  });

  test.each([["0"], ["65536"], ["-1"], ["abc"], ["92.5"], [""]])(
    "port %p is rejected",
    (bad) => {
      expect(() => parseInstallArgs(["--port", bad])).toThrow();
    },
  );

  test("invalid harness enum is rejected", () => {
    expect(() => parseInstallArgs(["--harness", "vscode"])).toThrow(/harness/);
  });

  test("invalid browser enum is rejected", () => {
    expect(() => parseInstallArgs(["--browser", "safari"])).toThrow(/browser/);
  });

  test("unknown option is rejected", () => {
    expect(() => parseInstallArgs(["--wat"])).toThrow(/unknown option/);
  });
});

/* --------------------------------- composeServerConfig --------------------------------- */

describe("composeServerConfig", () => {
  test("always runs npx -y cdp-toolkit", () => {
    const cfg = composeServerConfig("chrome", 9222);
    expect(cfg.command).toBe("npx");
    expect(cfg.args).toEqual(["-y", "cdp-toolkit"]);
  });

  test("firefox → CDP_BROWSER=firefox + CDP_FIREFOX_ENDPOINT=<port as string>", () => {
    const cfg = composeServerConfig("firefox", 9223);
    expect(cfg.env).toEqual({ CDP_BROWSER: "firefox", CDP_FIREFOX_ENDPOINT: "9223" });
  });

  test("chrome → CDP_BASE with the port, no CDP_BROWSER", () => {
    const cfg = composeServerConfig("chrome", 9222);
    expect(cfg.env).toEqual({ CDP_BASE: "http://127.0.0.1:9222" });
  });

  test("arc → identical env shape to chrome (only the alias differs)", () => {
    const cfg = composeServerConfig("arc", 9345);
    expect(cfg.env).toEqual({ CDP_BASE: "http://127.0.0.1:9345" });
    expect(cfg.env.CDP_BROWSER).toBeUndefined();
  });
});

/* --------------------------------- installHelpText --------------------------------- */

describe("installHelpText", () => {
  test("mentions the subcommand and all three harnesses", () => {
    const help = installHelpText();
    expect(help).toContain("cdp install");
    expect(help).toContain("claude");
    expect(help).toContain("codex");
    expect(help).toContain("opencode");
  });
});

/* --------------------------------- runInstaller --------------------------------- */

describe("runInstaller", () => {
  let dir = "";
  let out = "";
  let err = "";
  let io: InstallerIO;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "cdp-install-wizard-"));
    out = "";
    err = "";
    io = {
      isTTY: false,
      configPath: join(dir, ".claude.json"),
      rcPath: join(dir, ".zshrc"),
      stdout: (s) => {
        out += s;
      },
      stderr: (s) => {
        err += s;
      },
    };
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  test("--help prints the installer help and returns 0", async () => {
    const code = await runInstaller(["--help"], io);
    expect(code).toBe(0);
    expect(out).toContain("cdp install");
    expect(err).toBe("");
  });

  test("non-TTY with a missing required flag returns 1 and does not hang", async () => {
    // Missing --harness. isTTY:false, so it must fail fast rather than read stdin.
    const code = await runInstaller(["--browser", "chrome"], io);
    expect(code).toBe(1);
    expect(err).toContain("--harness");
    // Nothing written.
    await expect(readFile(io.configPath!, "utf8")).rejects.toThrow();
    await expect(readFile(io.rcPath!, "utf8")).rejects.toThrow();
  });

  test("happy path (claude + firefox, --yes) writes the harness entry and one alias block", async () => {
    const code = await runInstaller(
      ["--harness", "claude", "--browser", "firefox", "--port", "9223", "--yes"],
      io,
    );
    expect(code).toBe(0);

    // Harness config: the cdp-toolkit entry with the firefox env.
    const written = JSON.parse(await readFile(io.configPath!, "utf8"));
    expect(written.mcpServers["cdp-toolkit"]).toEqual({
      command: "npx",
      args: ["-y", "cdp-toolkit"],
      env: { CDP_BROWSER: "firefox", CDP_FIREFOX_ENDPOINT: "9223" },
    });

    // Shell rc: exactly ONE marker block, containing the cdp-firefox alias with --marionette.
    const rc = await readFile(io.rcPath!, "utf8");
    const markerCount = (rc.match(/# >>> cdp-toolkit alias >>>/g) ?? []).length;
    expect(markerCount).toBe(1);
    expect(rc).toContain("cdp-firefox");
    expect(rc).toContain("--marionette");

    // Summary went to stdout and names the next steps.
    expect(out).toContain("install complete");
    expect(out).toContain("Next steps");
  });

  test("happy path is idempotent: re-running leaves exactly one alias block", async () => {
    const argv = ["--harness", "claude", "--browser", "firefox", "--port", "9223", "--yes"];
    expect(await runInstaller(argv, io)).toBe(0);
    expect(await runInstaller(argv, io)).toBe(0);

    const rc = await readFile(io.rcPath!, "utf8");
    const markerCount = (rc.match(/# >>> cdp-toolkit alias >>>/g) ?? []).length;
    expect(markerCount).toBe(1);
  });

  test("--no-alias registers the harness only, writes no rc file", async () => {
    const code = await runInstaller(
      ["--harness", "claude", "--browser", "chrome", "--port", "9222", "--no-alias", "--yes"],
      io,
    );
    expect(code).toBe(0);

    const written = JSON.parse(await readFile(io.configPath!, "utf8"));
    expect(written.mcpServers["cdp-toolkit"].env).toEqual({ CDP_BASE: "http://127.0.0.1:9222" });

    // No shell rc written.
    await expect(readFile(io.rcPath!, "utf8")).rejects.toThrow();
    expect(out).toContain("skipped (--no-alias)");
  });

  test("custom --name and --alias-name are honored", async () => {
    const code = await runInstaller(
      [
        "--harness",
        "claude",
        "--browser",
        "chrome",
        "--port",
        "9222",
        "--name",
        "cdp-alt",
        "--alias-name",
        "mychrome",
        "--yes",
      ],
      io,
    );
    expect(code).toBe(0);

    const written = JSON.parse(await readFile(io.configPath!, "utf8"));
    expect(written.mcpServers["cdp-alt"]).toBeDefined();
    expect(written.mcpServers["cdp-toolkit"]).toBeUndefined();

    const rc = await readFile(io.rcPath!, "utf8");
    expect(rc).toContain("alias mychrome=");
  });
});
