# cdp-toolkit

**A single-target Chrome MCP server that drives one tab over raw Chrome DevTools Protocol — with a bounded timeout on every call.** No Puppeteer, no all-target fan-out, no `Network.enable` hang. Plus a built-in network-mocking fake backend. 33 tools, zero runtime dependencies in the CDP layer.

> For AI-agent developers and Claude Code / Cursor users who need **one known tab driven reliably** — not a Puppeteer-managed browser.

[![CI](https://github.com/sblattj/cdp-toolkit/actions/workflows/ci.yml/badge.svg)](https://github.com/sblattj/cdp-toolkit/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/cdp-toolkit?color=cb3837&logo=npm)](https://www.npmjs.com/package/cdp-toolkit)
[![license](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)
[![Model Context Protocol](https://img.shields.io/badge/MCP-compatible-1f6feb)](https://modelcontextprotocol.io)

<!-- Demo: record with `vhs docs/demo.tape` (see docs/demo.tape) and commit docs/demo.gif -->
![cdp-toolkit demo](docs/demo.gif)

## Why it exists

If [`chrome-devtools-mcp`](https://github.com/ChromeDevTools/chrome-devtools-mcp) ever **wedged your agent on a busy tab**, you've met its design: it manages a Puppeteer browser, fans every operation out across *all* attached targets, and enables the `Network` domain on connect so it can passively buffer everything. That generality is exactly what makes it fragile once you already know which tab you want to drive.

`cdp-toolkit` makes the opposite bet. Every tool attaches **one** direct WebSocket to **one** resolved target, enables only the CDP domains it needs, and enforces a **per-command timeout** so a stuck renderer can never hang the caller. For driving a tab you already have in hand — the common automation and evidence-gathering case — it's materially more robust.

## cdp-toolkit vs chrome-devtools-mcp

| | **cdp-toolkit** | **chrome-devtools-mcp** |
|---|---|---|
| **Target scope** | one resolved tab (`active` / `index:N` / `url:` / `title:`) | all attached targets — fan-out can stall on an unrelated tab |
| **`Network.enable`** | lazy — only when a tool needs it | eager on connect — a known hang on busy renderers |
| **Per-command timeout** | ✅ bounded (`CDP_TIMEOUT_MS`, 15s default) — rejects, never hangs | ❌ none — a stuck renderer blocks indefinitely |
| **Element refs** | stateless `backendDOMNodeId` (resolved on demand) | server-side handle table (can drift / expire) |
| **Network mocking** | ✅ persistent per-target fake backend | ❌ not available |
| **Runtime deps** | CDP/CLI layer: native `WebSocket` + `fetch` (the MCP server adds only the MCP SDK) | Puppeteer stack |
| **Auto-wait / retry** | ❌ single-shot — re-snapshot between steps | ✅ Puppeteer's auto-wait envelope |

**Use `chrome-devtools-mcp`** if you need multi-target autonomy or Puppeteer's auto-wait/retry on an *unknown* page. **Use `cdp-toolkit`** when you have one tab in hand and need it not to hang. They coexist — `cdp-toolkit`'s tools are namespaced `mcp__cdp-toolkit__*`, distinct from `mcp__chrome-devtools__*`.

## Is this for you?

**Yes, if you —**
- drive one known tab from Claude Code / Cursor / any MCP host and want it to never wedge;
- need to **mock a backend** to build or test a UI before the real API exists;
- have been bitten by the eager-`Network.enable` hang on a busy renderer.

**Probably not, if you —**
- need cross-browser (Firefox / WebKit) — use [`playwright-mcp`](https://github.com/microsoft/playwright-mcp);
- need Puppeteer's auto-wait/retry envelope for an unknown, changing page;
- want one server to fan out across *all* your open tabs at once.

## Quickstart (about 30 seconds)

```bash
# 1. Start Chrome/Chromium with the DevTools port open
open -a "Google Chrome" --args --remote-debugging-port=9222
#   (Linux: google-chrome --remote-debugging-port=9222)

# 2. Add cdp-toolkit to Claude Code at user scope (every project, no install step)
claude mcp add cdp-toolkit --scope user -- bunx -y cdp-toolkit

# 3. In Claude Code, call a tool to prove it works:
#    mcp__cdp-toolkit__list_pages
```

That's it. Tools appear namespaced as `mcp__cdp-toolkit__<tool>`. The server connects to Chrome **lazily per call**, so it loads cleanly even when Chrome isn't running.

Prefer the **CLI**? Every tool is runnable directly:

```bash
bunx -y --package cdp-toolkit cdp list_pages
bunx -y --package cdp-toolkit cdp navigate_page --target index:0 --url https://example.com
# …or from a clone: `bun run src/cli.ts <tool> …`
```

**Requirements:** Bun ≥ 1.1 (recommended) or Node ≥ 22 (for the global `WebSocket`). Chrome/Chromium with `--remote-debugging-port=9222`. Smoke-check the port: `curl -s http://127.0.0.1:9222/json/version`.

### MCP client setup

<details>
<summary><b>Claude Code</b></summary>

```bash
claude mcp add cdp-toolkit --scope user -- bunx -y cdp-toolkit
claude mcp get cdp-toolkit   # status (should show ✓ Connected)
```
A newly-registered server loads on the next Claude Code start; in an existing session, reconnect via `/mcp`.
</details>

<details>
<summary><b>Cursor / Windsurf / any MCP host</b></summary>

Add to your MCP config (e.g. `~/.cursor/mcp.json`):
```json
{
  "mcpServers": {
    "cdp-toolkit": { "command": "bunx", "args": ["-y", "cdp-toolkit"] }
  }
}
```
</details>

<details>
<summary><b>From a local checkout</b></summary>

```bash
git clone https://github.com/sblattj/cdp-toolkit && cd cdp-toolkit && bun install
claude mcp add cdp-toolkit --scope user -- bun run "$(pwd)/src/mcp.ts"
bun run mcp:smoke   # spawn the server + a real initialize/tools-list/tools-call round-trip
```
</details>

## Key capabilities

- **Single-target reliability.** One WebSocket to one resolved target, a bounded timeout on every CDP command, lazy domain enabling, and stateless element refs. There is no broadcast step that can stall on a wedged tab.
- **Network mocking — build the UI before the backend exists.** `mock_request` arms a persistent per-target fake backend: return canned responses, force errors, or inject latency/fault rates. Mocks survive reloads and navigations until `clear_mocks`.
- **Full chrome-devtools-mcp parity + extras.** All 29 upstream tools, plus `performance_trace` (a robust single-call trace), Lighthouse audits, and heap snapshots. 33 single-purpose tools — no discovery overhead, and they coexist with `chrome-devtools-mcp` in a separate namespace.

## Why raw CDP beats the MCP for known targets

Each point below leads with the symptom you've probably hit, then the cause, then the fix.

- **Your agent stalls on a call when a busy background tab is open** → that's the **all-target fan-out**: every operation broadcasts to all attached targets. cdp-toolkit resolves *one* target (`active | index:N | url:<substr> | title:<substr> | <targetId>`) and attaches a single WebSocket to just that page.
- **A tool hangs forever and never returns** → the MCP's eager `Network.enable` on a busy or hung renderer is a known wedge. cdp-toolkit enables domains **lazily**, only where a tool needs them (the recorder enables `Network`/`Runtime`/`Log`; most tools touch only `Page`/`Runtime`/`DOM`).
- **No way to bound a slow call** → `CdpConnection.send()` enforces `CDP_TIMEOUT_MS` (15s default) on *every* command and **rejects rather than hangs**, so a stuck renderer can never block a caller indefinitely.
- **Element handles drift across calls** → a `uid` **is** a CDP `backendDOMNodeId`, resolved on demand via `DOM.resolveNode`. There is no server-side handle table to drift or expire.

The trade-off is generality: this toolkit targets one known page at a time and does **not** replicate Puppeteer's auto-wait/retry envelope. Re-`take_snapshot` between steps rather than expecting an implicit wait.

## Network mocking — a fake backend for building/testing UIs

Build and test a UI before its backend (or its data) exists. `mock_request` arms a persistent per-target interception session; mock several endpoints by calling it repeatedly, then iterate on the page — the mocks survive reloads and navigations until `clear_mocks`.

```bash
# Return empty search results and reload to see how the UI renders the zero state
cdp mock_request --urlPattern '*/api/search*' --body '{"results":[],"total":0}' --reload true
# Force the endpoint to error (does the UI show a clean error or hang?)
cdp mock_request --urlPattern '*/api/search*' --action fail --errorReason Failed --reload true
# Resilience: fail 30% of calls + add 800ms latency
cdp mock_request --urlPattern '*/api/*' --failRate 0.3 --delayMs 800
cdp list_mocks
cdp clear_mocks --all true
```

> Cross-origin fetches (e.g. from a `data:` page) need an `Access-Control-Allow-Origin` header on the mock: `--json '{"urlPattern":"*api*","body":"{}","headers":{"Access-Control-Allow-Origin":"*"}}'`. Persistent mock sessions live in the long-lived MCP-server process; under the one-shot CLI each `mock_request` is its own process, so use `--reload true` to apply-and-observe within the single invocation.

## CLI usage

```bash
# Run any tool by its MCP name; args come from --json and/or --key value flags.
cdp <tool> [--target <sel>] [--json '<obj>'] [--<key> <value> ...]
cdp --list                                   # list every available tool name

cdp list_pages
cdp navigate_page --target index:0 --url https://example.com
cdp take_snapshot --target url:example --interactiveOnly true
cdp click --target index:0 --uid 42
cdp evaluate_script --json '{"expression":"document.title"}'
cdp take_screenshot --target url:example --fullPage true
cdp lighthouse_audit --url https://example.com --json '{"categories":["performance"]}'
```

**Argument parsing:** the first positional token is the tool name. `--json '<obj>'` merges a JSON object into the args (applied first). `--target <sel>` sets `args.target`. Repeated `--key value` pairs become `args.key`, coerced (`true`/`false` → boolean, numeric strings → number, else string); a bare `--flag` is `true`. Explicit flags override keys from `--json`. Output is `JSON.stringify(result, null, 2)` on stdout (exit 0); on any throw, `{"error":"<message>"}` goes to stderr and the process exits 1.

### Programmatic use

```ts
import { TOOLS, withPage, resolveTarget, CdpError } from "cdp-toolkit";

const pages = await TOOLS.list_pages({});
await TOOLS.navigate_page({ target: "index:0", url: "https://example.com" });
```

### Environment knobs

| Env var | Default | Purpose |
|---|---|---|
| `CDP_BASE` | `http://127.0.0.1:9222` | DevTools HTTP origin (drives discovery + the lighthouse `--port`). |
| `CDP_TIMEOUT_MS` | `15000` | Per-command timeout. |
| `CDP_ARTIFACT_DIR` | `/tmp/cdp-toolkit` | Screenshots, traces, heap snapshots, lighthouse reports, recorder buffers. |
| `CDP_STATE_DIR` | `/tmp/cdp-toolkit` | `select_page` selected-target file, in-flight trace state. |

## The tools (29 parity + 4 superset = 33)

The 29 parity tools are 1:1 with `chrome-devtools-mcp`; the 4 superset tools (`performance_trace` + the `mock_request`/`list_mocks`/`clear_mocks` group) are toolkit additions. Each row notes the underlying CDP method(s) and the precise parity gaps.

| MCP name | CDP method(s) | Parity notes / gaps |
|---|---|---|
| `list_pages` | `GET /json/list` | `all` flag also exposes worker/background targets; MCP lists only page tabs. |
| `new_page` | `Target.createTarget` | Returns `{targetId,url}`; does not await navigation (use `navigate_page`). |
| `close_page` | `Target.closeTarget` | Reports `success:true` on the empty result newer Chromium returns. |
| `select_page` | `Target.activateTarget` + selected-state file | Writes a flat-file selected target; `resolveTarget` does not read it, so `active` still means `index:0` unless a tool opts in. |
| `navigate_page` | `Page.navigate` / `Page.reload` + load events | Returns `{url,frameId,waitedFor}` (no auto-snapshot). `waitUntil` supports `load`/`domcontentloaded`. `reload:true` (+ `ignoreCache:true` for a hard reload). |
| `wait_for` | `Runtime.evaluate` (poll `innerText`) | Text-substring waiting only; throws on timeout rather than returning `{found:false}`. |
| `evaluate_script` | `Runtime.evaluate` / `callFunctionOn` | No live `page`/element handle; `args` are plain JSON. Main-world context only. |
| `take_snapshot` | `Accessibility.getFullAXTree` | uid is the raw `backendDOMNodeId` (stateless, non-sequential). Full tree in one shot; frames flattened. `interactiveOnly` is a toolkit addition. |
| `click` | `Input.dispatchMouseEvent` | No implicit auto-wait/retry — resolves and acts once; re-snapshot between steps. |
| `hover` | `Input.dispatchMouseEvent` (`mouseMoved`) | Same single-shot model as `click`. |
| `drag` | `Input.dispatchMouseEvent` (press→move→release) | Synthetic mouse drag; native HTML5 DnD is approximated. |
| `fill` | `Input.insertText` | Atomic paste-like commit, not per-character keystrokes. |
| `fill_form` | per field: `callFunctionOn` + `insertText` | Array of `{uid|selector,value}`; same insertText caveat. |
| `type_text` | `Input.insertText` | Appends (does not clear first); insertText, not per-key. |
| `press_key` | `Input.dispatchKeyEvent` | Curated named-key table + single chars; not the full Puppeteer KeyInput enum. |
| `upload_file` | `DOM.setFileInputFiles` | Requires a resolvable `<input type=file>` (uid or selector). |
| `take_screenshot` | `Page.captureScreenshot` (+ layout metrics) | Clip scale fixed at 1. Full-page uses `captureBeyondViewport` + layout-metrics clip. |
| `emulate` | `Emulation.*` / `Network.emulateNetworkConditions` | Stateless: UA/CPU/media/network overrides reset when the per-call connection closes. No named device presets. |
| `resize_page` | `Emulation.setDeviceMetricsOverride` | Verifies via `window.innerWidth/innerHeight`. Override persists on the target. |
| `handle_dialog` | `Page.javascriptDialogOpening` / `handleJavaScriptDialog` | Caller arms first and triggers out-of-band (or `handleDialogForExpression` to trigger-and-handle atomically). Supports wait-for-next and auto-handle-for-N-ms. |
| `list_console_messages` | `Runtime`/`Log` events (+ `Page.reload`) | `reload:true` records console+network into a unique per-capture file; default read returns the latest. Args flattened best-effort. |
| `get_console_message` | reads the shared "latest" buffer | Index into the latest capture; throws if out of range. |
| `list_network_requests` | `Network.*` events (+ `Page.reload`) | Correlated rows from the per-capture buffer; redirect chains collapse to the first row. No timing breakdown / POST data. |
| `get_network_request` | above + `Network.getResponseBody` | Bodies only via a fresh reload capture (CDP serves bodies from the live session); `includeBody` matches by **url**. |
| `performance_start_trace` | `Tracing.start` / `dataCollected` | Works ONLY within one process — a live trace buffer is bound to its connection. Use `performance_trace` for robustness. |
| `performance_stop_trace` | `Tracing.end` / `tracingComplete` | Must run in the SAME process as `performance_start_trace`; throws a clear error otherwise. |
| `performance_analyze_insight` | parses a trace JSON file | A **CDP-native approximation** of the MCP insight analyzer (FCP/LCP/CLS/TBT/long-tasks); close but not byte-identical. Requires an explicit `tracePath`. |
| `take_heapsnapshot` | `HeapProfiler.takeHeapSnapshot` | Returns `{path,bytes,chunks,target}`; does not parse the snapshot (load the `.heapsnapshot` in the DevTools Memory panel). |
| `lighthouse_audit` | **none (non-CDP)** — spawns `npx --yes lighthouse …` | The toolkit's sole non-CDP tool. Defaults to the desktop preset. Returns numeric category scores (full report on disk). |
| `performance_trace` *(superset)* | `Tracing.*` (+ `Page.reload`) | **Toolkit convenience.** A robust single-call trace: start → optional reload → capture for `durationMs` → end → write the trace JSON → return `{path,bytes,events,metrics}`. Preferred over the `start`/`stop` pair (CDP tracing is browser-global and bound to one connection). |
| `mock_request` *(superset)* | `Fetch.*` (+ `Page.reload`) | **A fake backend.** Registers a rule on a target's persistent session: fulfill with a canned response, fail, or continue (with optional `delayMs`/`failRate`). Persists across reloads until `clear_mocks`. Request-stage only. Cached requests aren't intercepted (use `reload:true`). |
| `list_mocks` *(superset)* | `Runtime.evaluate` (liveness probe) | Lists active mock sessions with rules + hit counts; prunes sessions whose tab closed. |
| `clear_mocks` *(superset)* | `Fetch.disable` | Tears down the resolved target's mock session (or all with `all:true`). |

## How it's built

```
src/
  client.ts          # CdpConnection, openPage/withPage/openBrowser, resolveTarget, timeouts
  types.ts           # Target, TargetSelector, Uid, CDP envelopes
  index.ts           # TOOLS registry (33) + re-exported client primitives
  cli.ts             # the Bun CLI
  mcp.ts             # stdio MCP server (exposes TOOLS via @modelcontextprotocol/sdk)
  manifest.ts        # JSON Schemas advertised by the MCP server (one per tool)
  tools/
    pages.ts navigation.ts evaluate.ts snapshot.ts input.ts
    screenshot.ts emulation.ts dialogs.ts recorder.ts console.ts
    network.ts performance.ts heap.ts lighthouse.ts network_mock.ts
test/
  smoke.ts             # safe end-to-end tool smoke (bun run smoke)
  mock-smoke.ts        # network-mocking end-to-end smoke (bun run mock:smoke)
  network_mock.test.ts # pure-logic unit tests (bun test)
  mcp-smoke.ts         # MCP handshake + live tools/call round-trip (bun run mcp:smoke)
```

Each module ends with a footer comment listing the exact CDP methods it uses and its parity gaps. The full design contract lives in [`CONTRACT.md`](./CONTRACT.md).

## Contributing

Issues and PRs welcome — see [`CONTRIBUTING.md`](./CONTRIBUTING.md) and the [`good first issue`](https://github.com/sblattj/cdp-toolkit/labels/good%20first%20issue) label. By participating you agree to the [Code of Conduct](./CODE_OF_CONDUCT.md).

## License

[MIT](./LICENSE) © Stephen Blatt
