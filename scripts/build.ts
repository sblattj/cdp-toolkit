#!/usr/bin/env bun
/**
 * Build the publishable dist/ from src/.
 *
 * The source is authored for Bun (`.ts` bins with a `bun` shebang), but the
 * code itself is Node-portable (it relies only on `node:` builtins + the global
 * `fetch`/`WebSocket` available in Node >= 22). So we bundle each entrypoint to
 * plain Node ESM and rewrite the bin shebangs to `node`. That makes the package
 * runnable via BOTH `bunx -y cdp-toolkit` and `npx -y cdp-toolkit`, and npx is the
 * dominant MCP-install idiom, so this widens the audience without giving up Bun.
 *
 * `@modelcontextprotocol/server` (and its zod) is BUNDLED into dist/mcp.js, so the
 * published package has no runtime dependencies (#19): an install is the package
 * alone, not the SDK's own dist, maps, typings and zod copy next to it.
 *
 * dist/ is gitignored and rebuilt at publish time via the `prepublishOnly` hook.
 */
import { chmodSync, readFileSync, rmSync, writeFileSync } from "node:fs";

rmSync("dist", { recursive: true, force: true });

const result = await Bun.build({
  // src/bidi/mux-daemon.ts is a fourth ENTRY POINT, not a library import: it is spawned as its own
  // process (`node dist/bidi/mux-daemon.js <endpoint> <pid>`) by src/bidi/driver.ts, so it must exist
  // as a standalone bundle in dist. Bun roots the outputs at the entrypoints' common ancestor (src/),
  // so it lands at dist/bidi/mux-daemon.js — the path driver.ts's resolveDaemonScript looks for.
  entrypoints: ["src/index.ts", "src/cli.ts", "src/mcp.ts", "src/bidi/mux-daemon.ts"],
  outdir: "dist",
  target: "node",
  format: "esm",
  // Shared code between the four entries goes into dist/chunk-*.js instead of being copied into
  // each bundle, and the output is minified: together about 64% smaller (#21). In-page scripts are
  // string literals, so minifying does not touch what runs in the browser.
  splitting: true,
  minify: true,
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

console.log(`built ${result.outputs.length} files → dist/{index,cli,mcp}.js + dist/bidi/mux-daemon.js (node target, MCP SDK bundled)`);
