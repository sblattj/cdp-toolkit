/**
 * Unit tests for src/install/browser.ts. Everything here is pure/filesystem-only: no browser,
 * no network, no dependence on which browsers happen to be installed on the machine running the
 * tests (binary detection is exercised only through explicit env-var overrides pointed at files
 * this test creates itself, never by trusting whatever CHROME_BIN etc. already resolves to).
 */
import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  aliasLine,
  appendAliasToRc,
  browserLaunchArgs,
  defaultAliasName,
  detectShellRc,
} from "../src/install/browser.ts";

async function withTmp<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "cdp-install-browser-"));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** Save/restore an env var around a test so overrides never leak into other tests. */
async function withEnv<T>(key: string, value: string | undefined, fn: () => Promise<T> | T): Promise<T> {
  const prev = process.env[key];
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
  try {
    return await fn();
  } finally {
    if (prev === undefined) delete process.env[key];
    else process.env[key] = prev;
  }
}

/* ------------------------------- defaultAliasName ------------------------------- */

describe("defaultAliasName", () => {
  test("is cdp-<choice> for all three browsers", () => {
    expect(defaultAliasName("chrome")).toBe("cdp-chrome");
    expect(defaultAliasName("arc")).toBe("cdp-arc");
    expect(defaultAliasName("firefox")).toBe("cdp-firefox");
  });
});

/* ------------------------------- browserLaunchArgs ------------------------------- */

describe("browserLaunchArgs", () => {
  test("chrome includes --remote-debugging-port= and --user-data-dir=", () => {
    const args = browserLaunchArgs({ choice: "chrome", port: 9222 });
    expect(args.some((a) => a === "--remote-debugging-port=9222")).toBe(true);
    expect(args.some((a) => a.startsWith("--user-data-dir="))).toBe(true);
    // Not a shared/default profile: a dedicated one, per-choice.
    expect(args.find((a) => a.startsWith("--user-data-dir="))).toContain("chrome-profile");
  });

  test("arc includes --remote-debugging-port= and --user-data-dir=", () => {
    const args = browserLaunchArgs({ choice: "arc", port: 9223 });
    expect(args.some((a) => a === "--remote-debugging-port=9223")).toBe(true);
    expect(args.some((a) => a.startsWith("--user-data-dir="))).toBe(true);
    expect(args.find((a) => a.startsWith("--user-data-dir="))).toContain("arc-profile");
  });

  test("firefox includes --remote-debugging-port, --marionette, --no-remote, --profile", () => {
    const args = browserLaunchArgs({ choice: "firefox", port: 9222 });
    expect(args).toContain("--remote-debugging-port");
    expect(args).toContain("9222");
    expect(args).toContain("--marionette");
    expect(args).toContain("--no-remote");
    expect(args).toContain("--profile");
    expect(args.find((a) => a.includes("firefox-profile"))).toBeTruthy();
    // --marionette is required for orphan-recovery: never let this regress silently.
    expect(args.includes("--marionette")).toBe(true);
  });

  test("firefox does NOT use the chrome-style --remote-debugging-port= single-token flag", () => {
    const args = browserLaunchArgs({ choice: "firefox", port: 9222 });
    expect(args.some((a) => a.startsWith("--remote-debugging-port="))).toBe(false);
  });

  test("honors an explicit profileDir override", () => {
    const args = browserLaunchArgs({ choice: "chrome", port: 9222, profileDir: "/tmp/my-custom-profile" });
    expect(args).toContain("--user-data-dir=/tmp/my-custom-profile");
  });
});

/* ------------------------------------ aliasLine ------------------------------------ */

describe("aliasLine", () => {
  test("quotes a spaced binary path (forced via env override to a real temp file with a space in it)", async () => {
    await withTmp(async (dir) => {
      const spacedDir = join(dir, "My Browser App");
      mkdirSync(spacedDir, { recursive: true });
      const binPath = join(spacedDir, "chrome-bin");
      writeFileSync(binPath, "");

      await withEnv("CHROME_BIN", binPath, () => {
        const line = aliasLine({ choice: "chrome", port: 9222 });
        expect(line).toContain(`"${binPath}"`);
        expect(line.startsWith(`alias cdp-chrome='"${binPath}"`)).toBe(true);
        expect(line).toContain("--remote-debugging-port=9222");
        expect(line).toContain("--user-data-dir=");
        // Overall shape: alias name='...'
        expect(line).toMatch(/^alias cdp-chrome='.*'$/);
      });
    });
  });

  test("does not quote an unspaced binary path", async () => {
    await withTmp(async (dir) => {
      const binPath = join(dir, "chrome-bin-nospace");
      writeFileSync(binPath, "");
      await withEnv("CHROME_BIN", binPath, () => {
        const line = aliasLine({ choice: "chrome", port: 9222 });
        expect(line).toContain(binPath);
        expect(line).not.toContain(`"${binPath}"`);
      });
    });
  });

  test("respects a custom aliasName", async () => {
    await withTmp(async (dir) => {
      const binPath = join(dir, "arc-bin");
      writeFileSync(binPath, "");
      await withEnv("ARC_BIN", binPath, () => {
        const line = aliasLine({ choice: "arc", port: 9333, aliasName: "my-arc-debug" });
        expect(line.startsWith("alias my-arc-debug=")).toBe(true);
      });
    });
  });

  test("produces a well-formed alias for firefox including --marionette", async () => {
    await withTmp(async (dir) => {
      const binPath = join(dir, "firefox-bin");
      writeFileSync(binPath, "");
      await withEnv("FIREFOX_BIN", binPath, () => {
        const line = aliasLine({ choice: "firefox", port: 9222 });
        expect(line).toContain("--marionette");
        expect(line).toContain("--no-remote");
        expect(line).toContain("--profile");
        expect(line.startsWith("alias cdp-firefox=")).toBe(true);
      });
    });
  });

  test("exact alias strings at port 9222/9223 for all three browsers (documented in the build report)", async () => {
    await withTmp(async (dir) => {
      const chromeBin = join(dir, "chrome-bin");
      const arcBin = join(dir, "arc-bin");
      const ffBin = join(dir, "firefox-bin");
      writeFileSync(chromeBin, "");
      writeFileSync(arcBin, "");
      writeFileSync(ffBin, "");

      await withEnv("CHROME_BIN", chromeBin, () => {
        const line = aliasLine({ choice: "chrome", port: 9222 });
        expect(line).toBe(
          `alias cdp-chrome='${chromeBin} --remote-debugging-port=9222 --user-data-dir=$HOME/.cdp-toolkit/chrome-profile'`,
        );
      });
      await withEnv("ARC_BIN", arcBin, () => {
        const line = aliasLine({ choice: "arc", port: 9223 });
        expect(line).toBe(
          `alias cdp-arc='${arcBin} --remote-debugging-port=9223 --user-data-dir=$HOME/.cdp-toolkit/arc-profile'`,
        );
      });
      await withEnv("FIREFOX_BIN", ffBin, () => {
        const line = aliasLine({ choice: "firefox", port: 9222 });
        expect(line).toBe(
          `alias cdp-firefox='${ffBin} --remote-debugging-port 9222 --marionette --no-remote --profile $HOME/.cdp-toolkit/firefox-profile'`,
        );
      });
    });
  });
});

/* ------------------------------------ detectShellRc ------------------------------------ */

describe("detectShellRc", () => {
  test("SHELL=/bin/zsh resolves to ~/.zshrc", async () => {
    await withEnv("SHELL", "/bin/zsh", () => {
      const rc = detectShellRc();
      expect(rc.endsWith("/.zshrc")).toBe(true);
      expect(rc.startsWith("/")).toBe(true);
    });
  });

  test("SHELL=/bin/bash resolves to ~/.bashrc", async () => {
    await withEnv("SHELL", "/bin/bash", () => {
      const rc = detectShellRc();
      expect(rc.endsWith("/.bashrc")).toBe(true);
      expect(rc.startsWith("/")).toBe(true);
    });
  });

  test("a zsh login shell path (e.g. /usr/local/bin/zsh) still resolves to ~/.zshrc", async () => {
    await withEnv("SHELL", "/usr/local/bin/zsh", () => {
      expect(detectShellRc().endsWith("/.zshrc")).toBe(true);
    });
  });
});

/* ------------------------------------ appendAliasToRc ------------------------------------ */

describe("appendAliasToRc", () => {
  test("created-block on first call into a nonexistent file, preserving nothing (there was nothing)", async () => {
    await withTmp(async (dir) => {
      const rcPath = join(dir, "does-not-exist-yet.rc");
      expect(existsSync(rcPath)).toBe(false);
      const res = await appendAliasToRc(rcPath, "alias cdp-chrome='chrome --flag'");
      expect(res).toEqual({ rcPath, action: "created-block" });
      const content = readFileSync(rcPath, "utf8");
      expect(content).toContain("# >>> cdp-toolkit alias >>>");
      expect(content).toContain("alias cdp-chrome='chrome --flag'");
      expect(content).toContain("# <<< cdp-toolkit alias <<<");
      expect(content.endsWith("\n")).toBe(true);
    });
  });

  test("created-block on first call into an existing file, preserving prior content verbatim", async () => {
    await withTmp(async (dir) => {
      const rcPath = join(dir, ".zshrc");
      const priorContent = 'export PATH="$PATH:/usr/local/bin"\nexport EDITOR=vim\n';
      writeFileSync(rcPath, priorContent);

      const res = await appendAliasToRc(rcPath, "alias cdp-chrome='chrome --flag'");
      expect(res.action).toBe("created-block");

      const content = readFileSync(rcPath, "utf8");
      expect(content.startsWith(priorContent)).toBe(true);
      expect(content).toContain("# >>> cdp-toolkit alias >>>");
      expect(content).toContain("alias cdp-chrome='chrome --flag'");
      expect(content).toContain("# <<< cdp-toolkit alias <<<");
    });
  });

  test("unchanged when re-run with the same body; replaced-block when re-run with a different body", async () => {
    await withTmp(async (dir) => {
      const rcPath = join(dir, ".bashrc");
      writeFileSync(rcPath, "# my rc file\n");

      const first = await appendAliasToRc(rcPath, "alias cdp-chrome='chrome --flag-a'");
      expect(first.action).toBe("created-block");
      const afterFirst = readFileSync(rcPath, "utf8");

      const second = await appendAliasToRc(rcPath, "alias cdp-chrome='chrome --flag-a'");
      expect(second.action).toBe("unchanged");
      expect(readFileSync(rcPath, "utf8")).toBe(afterFirst);

      const third = await appendAliasToRc(rcPath, "alias cdp-chrome='chrome --flag-b'\nalias cdp-firefox='ff --flag-c'");
      expect(third.action).toBe("replaced-block");
      const afterThird = readFileSync(rcPath, "utf8");
      expect(afterThird).toContain("alias cdp-chrome='chrome --flag-b'");
      expect(afterThird).toContain("alias cdp-firefox='ff --flag-c'");
      expect(afterThird).not.toContain("flag-a");
      // The rest of the file survived every call.
      expect(afterThird.startsWith("# my rc file\n")).toBe(true);
    });
  });

  test("exactly one marker block ever exists across many repeated calls", async () => {
    await withTmp(async (dir) => {
      const rcPath = join(dir, ".zshrc");
      writeFileSync(rcPath, "alias unrelated='echo hi'\n");

      for (let i = 0; i < 6; i++) {
        await appendAliasToRc(rcPath, `alias cdp-chrome='chrome --iteration-${i}'`);
      }

      const content = readFileSync(rcPath, "utf8");
      const startCount = content.split("# >>> cdp-toolkit alias >>>").length - 1;
      const endCount = content.split("# <<< cdp-toolkit alias <<<").length - 1;
      expect(startCount).toBe(1);
      expect(endCount).toBe(1);
      expect(content).toContain("iteration-5");
      expect(content).not.toContain("iteration-4");
      // Unrelated pre-existing content untouched.
      expect(content).toContain("alias unrelated='echo hi'");
    });
  });

  test("preserves content that comes AFTER the marker block on replace", async () => {
    await withTmp(async (dir) => {
      const rcPath = join(dir, ".zshrc");
      const before = "# before\n";
      const after = "# after, must survive\nexport FOO=bar\n";
      writeFileSync(rcPath, `${before}# >>> cdp-toolkit alias >>>\nalias cdp-chrome='old'\n# <<< cdp-toolkit alias <<<\n${after}`);

      const res = await appendAliasToRc(rcPath, "alias cdp-chrome='new'");
      expect(res.action).toBe("replaced-block");

      const content = readFileSync(rcPath, "utf8");
      expect(content.startsWith(before)).toBe(true);
      expect(content).toContain("alias cdp-chrome='new'");
      expect(content).not.toContain("alias cdp-chrome='old'");
      expect(content).toContain(after.trim());
      // "after" content still comes after the block.
      expect(content.indexOf("# after, must survive")).toBeGreaterThan(content.indexOf("# <<< cdp-toolkit alias <<<"));
    });
  });

  test("ensures a trailing newline even when the prior file had none", async () => {
    await withTmp(async (dir) => {
      const rcPath = join(dir, ".zshrc");
      writeFileSync(rcPath, "export FOO=bar"); // no trailing newline
      const res = await appendAliasToRc(rcPath, "alias cdp-chrome='chrome --flag'");
      expect(res.action).toBe("created-block");
      const content = readFileSync(rcPath, "utf8");
      expect(content.endsWith("\n")).toBe(true);
      expect(content.startsWith("export FOO=bar")).toBe(true);
    });
  });
});
