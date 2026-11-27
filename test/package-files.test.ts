/**
 * Issue #19: the npm tarball ships the built dist/ only, not the TypeScript sources.
 * Every bin and export must resolve inside a "files" entry, and src/ must not be one.
 * The MCP SDK is bundled into dist/mcp.js, so the package has no runtime dependencies.
 * Issue #21: dist/ is minified and split into shared chunks, and CHANGELOG.md is not shipped.
 */
import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const pkg = JSON.parse(readFileSync(fileURLToPath(new URL("../package.json", import.meta.url)), "utf8")) as {
  files: string[];
  main: string;
  bin: Record<string, string>;
  exports: Record<string, string>;
  dependencies?: Record<string, string>;
};

// Static `import ... from "x"`, side-effect `import "x"`, dynamic `import("x")`, `require("x")`.
const IMPORT_RE =
  /(?<=(?:^|[;}\n])\s*)import\s*(?:[\w$]+\s*,?\s*)?(?:\*\s*as\s+[\w$]+|\{[^{}"'`]*\})?\s*from\s*["']([^"']+)["']|(?<=(?:^|[;}\n])\s*)import\s*["']([^"']+)["']|(?<![.\w$"'`])import\(\s*["']([^"']+)["']\s*\)|(?<![.\w$])require\(\s*["']([^"']+)["']\s*\)/g;

const norm = (p: string) => p.replace(/^\.\//, "");
const shipped = (p: string) => pkg.files.some((f) => norm(p) === norm(f) || norm(p).startsWith(norm(f).replace(/\/?$/, "/")));

describe("package files (#19)", () => {
  test("src/ is not shipped", () => {
    expect(pkg.files.map((f) => norm(f).replace(/\/$/, ""))).not.toContain("src");
  });

  test("CHANGELOG.md is not shipped (it lives on GitHub, nothing reads it at runtime) (#21)", () => {
    expect(pkg.files).not.toContain("CHANGELOG.md");
  });

  test("main, every bin and every export resolve inside a files entry", () => {
    const targets = [pkg.main, ...Object.values(pkg.bin), ...Object.values(pkg.exports).filter((t) => t !== "./package.json")];
    for (const t of targets) expect({ target: t, shipped: shipped(t) }).toEqual({ target: t, shipped: true });
  });

  test("no runtime dependencies", () => {
    expect(Object.keys(pkg.dependencies ?? {})).toEqual([]);
  });

  // Only meaningful after `bun run build`; runtime-entry.test.ts builds dist/ when it is missing.
  // dist/ is minified and split into shared chunks (#21), so every .js file is scanned, and the
  // patterns match minified forms (`;import{a as b}from"x"`, `import"x"`) as well as formatted ones.
  test("every built file imports only node builtins and sibling chunks", () => {
    const dist = fileURLToPath(new URL("../dist", import.meta.url));
    if (!existsSync(dist)) return;
    const files = readdirSync(dist, { recursive: true, encoding: "utf8" }).filter((f) => f.endsWith(".js"));
    expect(files).toContain("mcp.js");
    for (const rel of files) {
      const code = readFileSync(join(dist, rel), "utf8");
      const bare = [...code.matchAll(IMPORT_RE)]
        // A require() right after a quote or backtick is code-gen text (ajv's standalone output), not a load.
        .filter((m) => !(m[4] && /[`'"]/.test(code[m.index! + m[0].indexOf("require") - 1] ?? "")))
        .map((m) => m[1] ?? m[2] ?? m[3] ?? m[4])
        .filter((s) => !s.startsWith("node:") && !s.startsWith(".") && !/^[a-z_]+(\/[a-z_]+)?$/.test(s));
      expect({ rel, bare }).toEqual({ rel, bare: [] });
    }
  });

  test("the import scan catches minified and formatted bare imports", () => {
    const sample = [
      'var a=1;import{McpServer as b}from"@scope/pkg";',
      'import"side-effect-pkg";',
      "import * as z from 'zod';",
      'let m=await import("lazy-pkg");',
      'const r=require("cjs-pkg");',
      'import{x}from"./chunk-abc.js";import{y}from"node:fs";',
      'case"import":return 1;let s=`see import: x`;let q="see import";let w="would import x from \'y\'";',
    ].join("\n");
    const found = [...sample.matchAll(IMPORT_RE)].map((m) => m[1] ?? m[2] ?? m[3] ?? m[4]);
    expect(found).toEqual(["@scope/pkg", "side-effect-pkg", "zod", "lazy-pkg", "cjs-pkg", "./chunk-abc.js", "node:fs"]);
  });
});
