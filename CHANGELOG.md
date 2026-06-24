# Changelog

All notable changes to cdp-toolkit are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.0.0] — 2026-06-24

First public release.

### Added
- **33 tools** over raw Chrome DevTools Protocol on a single direct WebSocket:
  - **29 `chrome-devtools-mcp` parity tools** — `list_pages`, `new_page`, `close_page`, `select_page`, `navigate_page`, `wait_for`, `evaluate_script`, `take_snapshot`, `click`, `hover`, `drag`, `fill`, `fill_form`, `type_text`, `press_key`, `upload_file`, `take_screenshot`, `emulate`, `resize_page`, `handle_dialog`, `list_console_messages`, `get_console_message`, `list_network_requests`, `get_network_request`, `performance_start_trace`, `performance_stop_trace`, `performance_analyze_insight`, `take_heapsnapshot`, `lighthouse_audit`.
  - **4 superset tools** beyond parity — `performance_trace` (a robust single-call trace that survives the cross-process limitation of the start/stop pair), and the network-mocking group `mock_request` / `list_mocks` / `clear_mocks` (a persistent per-target fake backend).
- **Single direct WebSocket per call** — every tool resolves exactly one target (`active | index:N | url:<substr> | title:<substr> | <targetId>`); no all-target fan-out.
- **Per-command timeout** (`CDP_TIMEOUT_MS`, default 15s) — `CdpConnection.send()` rejects rather than hangs, so a stuck renderer can't block a caller indefinitely.
- **Lazy domain enabling** — domains are enabled only where a tool needs them; no eager `Network.enable` on connect.
- **Stateless element refs** — a `uid` IS the CDP `backendDOMNodeId`, resolved on demand; no server-side handle table to drift or expire.
- **stdio MCP server** (`src/mcp.ts`) exposing every tool via `@modelcontextprotocol/sdk`, with JSON Schemas in `src/manifest.ts`. Connects to Chrome lazily per call, so it loads cleanly even when Chrome isn't running.
- **Bun CLI** (`src/cli.ts`) — `bun run src/cli.ts <tool> [--target <sel>] [--json '<obj>'] [--<key> <value> ...]`.
- Hermetic test fixtures — `mock-smoke.ts` mocks `https://mock.invalid/*` (CDP `Fetch.requestPaused` intercepts before DNS, so the smoke needs no real network).

### Notes
- License: MIT.
- Zero runtime dependencies in the CDP/CLI layer (Node's global `WebSocket` + `fetch`). The MCP server adds only `@modelcontextprotocol/sdk`; `lighthouse_audit` is the sole non-CDP tool and shells out to `npx lighthouse`.
- Runtime: Bun ≥ 1.1 (recommended) or Node ≥ 22 (for the global `WebSocket`). Requires Chrome/Chromium started with `--remote-debugging-port=9222`.

[1.0.0]: https://github.com/sblattj/cdp-toolkit/releases/tag/v1.0.0
