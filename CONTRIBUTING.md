# Contributing

Thanks for your interest. The single rule:

> Read [`CONTRACT.md`](./CONTRACT.md) end-to-end before writing any module. It's
> 12 KB of design rules and it is the reason the codebase is small enough to read.

## Setup

```bash
bun install
bun test                       # pure-logic unit tests (network_mock.test.ts)
bun run smoke                  # live tool smoke against the running Chrome
bun run mock:smoke             # network-mocking end-to-end
bun run mcp:smoke              # real stdio MCP handshake + tools/call round-trip
```

The three smokes REQUIRE Chrome/Chromium running with `--remote-debugging-port=9222`.

## Code rules

1. **Zero runtime dependencies.** `WebSocket` (global) + `fetch` (global). If you
   need a helper, write it. `@modelcontextprotocol/sdk` is the only allowed runtime
   dep (used by `src/mcp.ts`).
2. **Build on `src/client.ts` primitives — never open a WebSocket yourself.**
   Use `openPage`, `withPage`, `openBrowser`, `resolveTarget`, `CdpConnection`.
3. **TypeScript strict.** `tsc --noEmit` must stay clean with `strict`,
   `noUncheckedIndexedAccess`, `verbatimModuleSyntax`.
4. **One module per concern.** A new tool goes in `src/tools/<concern>.ts` with
   its export added to `src/index.ts`'s `TOOLS` registry and `src/manifest.ts`'s
   JSON Schemas.
5. **Tool name ↔ camelCase fn. Mechanical.** `take_snapshot` → `takeSnapshot()`.
   `list_console_messages` → `listConsoleMessages()`.

## Pull request process

1. Fork → branch (`feat/<short-name>` or `fix/<short-name>`).
2. If you change anything user-visible, update `README.md`'s tools table.
3. If you add a tool, also add a JSON Schema entry to `manifest.ts`. The smoke
   tests help: `bun run mcp:smoke` will warn on registry/manifest drift.
4. PR description: what changed, why, how you tested, and a one-line repro of
   `bun run` that the reviewer can run themselves.
5. CI (`bun test && bun run tsc --noEmit && bun run mcp:smoke`) must be green.

## Reporting security issues

Email `security@…` (TBD). Don't open a public issue for a vulnerability.
