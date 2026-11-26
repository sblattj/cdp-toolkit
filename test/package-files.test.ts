/**
 * Issue #19: the npm tarball ships the built dist/ only, not the TypeScript sources.
 * Every bin and export must resolve inside a "files" entry, and src/ must not be one.
 * The MCP SDK is bundled into dist/mcp.js, so the package has no runtime dependencies.
 */
import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const pkg = JSON.parse(readFileSync(fileURLToPath(new URL("../package.json", import.meta.url)), "utf8")) as {
  files: string[];
  main: string;
  bin: Record<string, string>;
  exports: Record<string, string>;
  dependencies?: Record<string, string>;
};

const norm = (p: string) => p.replace(/^\.\//, "");
const shipped = (p: string) => pkg.files.some((f) => norm(p) === norm(f) || norm(p).startsWith(norm(f).replace(/\/?$/, "/")));

describe("package files (#19)", () => {
  test("src/ is not shipped", () => {
    expect(pkg.files.map((f) => norm(f).replace(/\/$/, ""))).not.toContain("src");
  });

  test("main, every bin and every export resolve inside a files entry", () => {
    const targets = [pkg.main, ...Object.values(pkg.bin), ...Object.values(pkg.exports).filter((t) => t !== "./package.json")];
    for (const t of targets) expect({ target: t, shipped: shipped(t) }).toEqual({ target: t, shipped: true });
  });

  test("no runtime dependencies", () => {
    expect(Object.keys(pkg.dependencies ?? {})).toEqual([]);
  });

  // Only meaningful after `bun run build`; runtime-entry.test.ts builds dist/ when it is missing.
  test("built entrypoints import only node builtins", () => {
    for (const rel of ["dist/mcp.js", "dist/cli.js", "dist/index.js", "dist/bidi/mux-daemon.js"]) {
      const file = fileURLToPath(new URL(`../${rel}`, import.meta.url));
      if (!existsSync(file)) continue;
      const code = readFileSync(file, "utf8");
      const bare = [...code.matchAll(/(?:^|\n)\s*import\s[^;]*?from\s*["']([^"']+)["']|\bimport\(\s*["']([^"']+)["']\s*\)|\brequire\(\s*["']([^"']+)["']\s*\)/g)]
        // A require() right after a quote or backtick is code-gen text (ajv's standalone output), not a load.
        .filter((m) => !(m[3] && /[`'"]/.test(code[m.index! + m[0].indexOf("require") - 1] ?? "")))
        .map((m) => m[1] ?? m[2] ?? m[3])
        .filter((s) => !s.startsWith("node:") && !s.startsWith(".") && !/^[a-z_]+(\/[a-z_]+)?$/.test(s));
      expect({ rel, bare }).toEqual({ rel, bare: [] });
    }
  });
});
