#!/usr/bin/env bun
/**
 * Build the publishable dist/ from src/.
 *
 * The source is authored for Bun (`.ts` bins with a `bun` shebang), but the
 * code itself is Node-portable (it relies only on `node:` builtins + the global
 * `fetch`/`WebSocket` available in Node >= 22). So we bundle each entrypoint to
 * plain Node ESM and rewrite the bin shebangs to `node`. That makes the package
 * runnable via BOTH `bunx -y cdp-toolkit` and `npx -y cdp-toolkit` — npx is the
 * dominant MCP-install idiom, so this widens the audience without giving up Bun.
 *
 * `@modelcontextprotocol/sdk` stays EXTERNAL (a real runtime dependency, resolved
 * from node_modules by the consumer) — we bundle only our own code.
 *
 * dist/ is gitignored and rebuilt at publish time via the `prepublishOnly` hook.
 */
import { chmodSync, readFileSync, rmSync, writeFileSync } from "node:fs";

rmSync("dist", { recursive: true, force: true });

const result = await Bun.build({
  entrypoints: ["src/index.ts", "src/cli.ts", "src/mcp.ts"],
  outdir: "dist",
  target: "node",
  format: "esm",
  splitting: false, // self-contained file per entry (no shared chunks to resolve)
  minify: false,
  external: ["@modelcontextprotocol/sdk", "@modelcontextprotocol/sdk/*"],
});

if (!result.success) {
  console.error("build failed:");
  for (const log of result.logs) console.error(log);
  process.exit(1);
}

// The two executables ship with a node shebang (source uses `#!/usr/bin/env bun`).
for (const bin of ["dist/cli.js", "dist/mcp.js"]) {
  let code = readFileSync(bin, "utf8");
  code = code.replace(/^#![^\n]*\n/, ""); // drop whatever shebang the bundler emitted
  writeFileSync(bin, `#!/usr/bin/env node\n${code}`);
  chmodSync(bin, 0o755);
}

console.log(`built ${result.outputs.length} files → dist/{index,cli,mcp}.js (node target, MCP SDK external)`);
