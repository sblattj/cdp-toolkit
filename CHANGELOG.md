# Changelog

All notable changes to cdp-toolkit are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.2.0] - 2026-08-05

Two things landed since 1.0: a second backend, Firefox over WebDriver BiDi,
alongside the existing Chrome over CDP; and lease based tab ownership, so
several agents can drive the same browser without stealing each other's tab.
Both are opt in. Pick Firefox explicitly or you get Chrome as before; omit
`lease` and every call behaves exactly as it did in 1.0.

### Added

- **A second backend: Firefox over WebDriver BiDi**, behind the same tool
  surface as Chrome over CDP. Chrome stays the default; select Firefox with
  `--browser firefox` (CLI) or `CDP_BROWSER=firefox` (CLI or MCP server).
- **Per-backend tool filtering.** `tools/list` (MCP) and `--list`/
  `--capabilities` (CLI) only ever advertise a tool the selected browser can
  actually run; a tool a backend cannot run is absent from the listing rather
  than throwing at call time. Firefox lacks the accessibility tree, atomic
  text insert, full emulation, tracing, heap snapshots, and Lighthouse audits;
  everything else, including network mocking and the lease group below, runs
  on both backends.
- **A Firefox smoke job in CI**, gating the new backend the same way the
  existing Chrome smoke gates the old one.
- **Three tools**: `claim_page` (take a tab, or open and take one in a single
  call, and get back an opaque lease token), `release_page` (idempotent, and
  does not close the tab), and `list_leases` (who holds what, with pid liveness
  and reclaimability; needs no token and never returns the lease nonce).
- **An optional `lease` argument on the other tools.** Present it and a tab
  you hold keeps answering you; omit it and an unleased tab behaves as before.
  `release_page` is the one tool where the token is required.
- **`new_page` gained `claim`, `label`, and `ttlMs`.** With `claim:true` the new
  tab is claimed as part of creating it and the response carries a `lease`
  token, so no other agent can see the tab unclaimed and take it first.
- **`CDP_LEASE_TTL_MS`** (default `900000`, 15 minutes): how long a lease
  survives without use before another agent can reclaim it. Every checked call
  refreshes it, so a working agent never expires and needs no heartbeat.
- Lease files under `CDP_ARTIFACT_DIR`, one per leased tab, created with the
  `wx` exclusive flag so two simultaneous claims cannot both win.

### Changed

- **The one behavior change.** If tab index 0 is leased and a call arrives with
  `target: active` (or no target at all) and no `lease`, it is now refused,
  naming the tab, its url, and the label of the holder. Before 1.2 that call
  silently succeeded against whatever tab happened to be first. Nothing else
  newly fails: an unleased tab is always allowed, a stale lease (dead owner,
  elapsed TTL, closed tab) never blocks, and no default, return shape, or
  previously legal call changed.
- `close_page` releases that tab's lease when the close actually succeeds, and
  leaves the lease in place when it does not.
- Enforcement lives at the three target resolution choke points (`resolveTarget`
  for Chrome, `resolveContext` for Firefox, `resolvePage` for `close_page` and
  `select_page`), never in individual tools, so a tool added later is covered
  with no action from whoever writes it.
- `claim_page` is refused from the CLI. A CLI invocation is one process per
  call, so a lease it claimed would be reclaimable immediately under the dead
  pid rule. It is still listed by `--list`, and CLI calls can still present a
  token minted by the MCP server via `--lease`.
- Tool count is now 36 (29 parity + 7 superset); 30 under Firefox, which lacks
  the six capability gated tools.

## [1.0.0] - 2026-06-24

First public release.

### Added
- **33 tools** over raw Chrome DevTools Protocol on a single direct WebSocket:
  - **29 `chrome-devtools-mcp` parity tools**: `list_pages`, `new_page`, `close_page`, `select_page`, `navigate_page`, `wait_for`, `evaluate_script`, `take_snapshot`, `click`, `hover`, `drag`, `fill`, `fill_form`, `type_text`, `press_key`, `upload_file`, `take_screenshot`, `emulate`, `resize_page`, `handle_dialog`, `list_console_messages`, `get_console_message`, `list_network_requests`, `get_network_request`, `performance_start_trace`, `performance_stop_trace`, `performance_analyze_insight`, `take_heapsnapshot`, `lighthouse_audit`.
  - **4 superset tools** beyond parity: `performance_trace` (a robust single-call trace that survives the cross-process limitation of the start/stop pair), and the network-mocking group `mock_request` / `list_mocks` / `clear_mocks` (a persistent per-target fake backend).
- **Single direct WebSocket per call**: every tool resolves exactly one target (`active | index:N | url:<substr> | title:<substr> | <targetId>`); no all-target fan-out.
- **Per-command timeout** (`CDP_TIMEOUT_MS`, default 15s): `CdpConnection.send()` rejects rather than hangs, so a stuck renderer can't block a caller indefinitely.
- **Lazy domain enabling**: domains are enabled only where a tool needs them; no eager `Network.enable` on connect.
- **Stateless element refs**: a `uid` IS the CDP `backendDOMNodeId`, resolved on demand; no server-side handle table to drift or expire.
- **stdio MCP server** (`src/mcp.ts`) exposing every tool via `@modelcontextprotocol/sdk`, with JSON Schemas in `src/manifest.ts`. Connects to Chrome lazily per call, so it loads cleanly even when Chrome isn't running.
- **Bun CLI** (`src/cli.ts`): `bun run src/cli.ts <tool> [--target <sel>] [--json '<obj>'] [--<key> <value> ...]`.
- Hermetic test fixtures: `mock-smoke.ts` mocks `https://mock.invalid/*` (CDP `Fetch.requestPaused` intercepts before DNS, so the smoke needs no real network).

### Notes
- License: MIT.
- Zero runtime dependencies in the CDP/CLI layer (Node's global `WebSocket` + `fetch`). The MCP server adds only `@modelcontextprotocol/sdk`; `lighthouse_audit` is the sole non-CDP tool and shells out to `npx lighthouse`.
- Runtime: Bun ≥ 1.1 (recommended) or Node ≥ 22 (for the global `WebSocket`). Requires Chrome/Chromium started with `--remote-debugging-port=9222`.

[1.0.0]: https://github.com/sblattj/cdp-toolkit/releases/tag/v1.0.0
