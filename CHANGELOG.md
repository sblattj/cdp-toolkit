# Changelog

All notable changes to cdp-toolkit are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **`evaluate_script` can write its value to a file instead of returning it,
  via a new optional `savePath`.** Reading a JWT, a session token, or any other
  credential out of the page previously forced the secret through the tool
  result, which is to say straight into the calling agent's transcript, with no
  way to opt out. With `savePath` set, the evaluated value is serialized as
  JSON to that file and the response carries only `{path, bytes, type, target}`:
  no copy of the value, no preview, no truncated form, no leading characters.
  `type` is the JS `typeof` of the value (`"null"` for null), which describes
  the value without disclosing any of it. Path handling matches
  `take_heapsnapshot`: an absolute path is used as-is, a relative one resolves
  under the artifact dir (`/tmp/cdp-toolkit`, or `CDP_ARTIFACT_DIR`), and
  missing parent directories are created. Omitting `savePath` leaves
  `evaluate_script` behaving exactly as it did before, value returned inline,
  so this is purely additive for every existing caller. Thrown page-side
  exceptions still surface as errors and are never written into the file.

## [1.3.0] - 2026-08-06

`v1.2.1` was tagged and pushed to GitHub but never published to npm: the
release runs through GitHub Actions with OIDC trusted publishing, and Actions
was down for a full day. Rather than publish that fix on its own, it ships
here alongside tab origin, so 1.3.0 is the first npm release carrying both
the lease feature (`claim_page`/`release_page`/`list_leases`) and tab origin.

### Added

- **`list_pages` now reports where each tab came from.** Every tab cdp-toolkit
  creates (`new_page`, and `claim_page` with no `targetId`) is written to a
  creation ledger stored alongside the lease files, and each `list_pages` row
  gains `origin`: `"agent"` when the toolkit created the tab, carrying the
  creating `label` and `createdAt`, otherwise `"unknown"`. The record outlives
  the lease on purpose. Once an agent releases, expires, or dies, its abandoned
  tab was previously indistinguishable from one the human opened, which is
  exactly when provenance is worth having. `origin` is never `"human"`: the
  toolkit cannot prove a person opened a tab, so `"unknown"` is the honest word
  for anything it did not create itself. A tab whose record exists but could
  not be read reports `"unknown"` plus `originUnreadable`, so a broken record is
  never mistaken for no record, matching how `list_leases` reports an unreadable
  lease. The ledger is reaped when it is read, dropping records for targets the
  browser no longer has, so nothing has to be scheduled to clean it up. Purely
  additive: `id`, `url`, `title`, and `type` are unchanged, and a missing or
  unreadable ledger degrades to every page reporting `"unknown"` rather than
  failing the call.

## [1.2.1] - 2026-08-05

### Fixed

- **On Chrome, a refusal caused by another agent's lease is now reported as a
  lease conflict.** It was reported with the code meaning the target did not
  exist, and the holder details were dropped, so a caller could not tell "this
  tab is spoken for, go get the token or retry" apart from "that tab is not
  there, stop looking". The refusal message itself always read correctly, so
  anyone reading the text saw the real reason; only the machine readable code
  and the holder fields were wrong. A genuinely missing target is still
  reported as `no-such-target`. Enforcement was never affected: a leased tab
  was refused before this fix and is refused after it. Firefox was never
  affected, and now reports an identical conflict to Chrome's.

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

- **The one behavior change.** Any call that resolves to a leased tab without
  presenting that tab's token is now refused, naming the tab, its url, and the
  label of the holder. That is every selector form, not just one: `active` or no
  target at all, `index:N`, `url:<substring>`, `title:<substring>`, and a bare
  targetId all reach the same check. The case worth singling out is `active` (or
  no target) against a leased tab index 0, because there you did not name the
  tab and before 1.2 the call silently succeeded against whatever tab happened
  to be first, but it is not the only exposure. What still holds: an unleased
  tab is always allowed, a stale lease (dead owner or elapsed TTL) never blocks,
  and no default, return shape, or previously legal call changed. For a user who
  never claims a tab there are no lease files at all, so nothing changes.
  A lease whose tab is no longer open is reported by `list_leases`
  as `target-gone`, but that report is not what frees it: it is freed by the
  same two rules, whichever lands first.
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
