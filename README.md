# cdp-toolkit

**A lightweight, drop-in alternative to [`chrome-devtools-mcp`](https://github.com/ChromeDevTools/chrome-devtools-mcp) that won't wedge your agent.** It drives the Chrome tabs you point it at over the raw DevTools Protocol: any number of tabs, one explicitly named target per call over one direct socket, with a bounded timeout on every call, so a stuck page returns a clean error instead of hanging your agent and forcing a `/mcp` restart. Same idea, no all-target fan-out, plus tab leases so several agents can work one browser, plus a built-in network-mocking fake backend. **39 tools.**

> For AI-agent developers and Claude Code / Cursor users who need **the tabs they name driven reliably**, not a Puppeteer-managed browser.

[![CI](https://github.com/sblattj/cdp-toolkit/actions/workflows/ci.yml/badge.svg)](https://github.com/sblattj/cdp-toolkit/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/cdp-toolkit?color=cb3837&logo=npm)](https://www.npmjs.com/package/cdp-toolkit)
[![license](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)
[![Model Context Protocol](https://img.shields.io/badge/MCP-compatible-1f6feb)](https://modelcontextprotocol.io)

<!-- Demo: record with `vhs docs/demo.tape` (see docs/demo.tape) and commit docs/demo.gif -->
![cdp-toolkit demo](docs/demo.gif)

## In plain terms

You let an AI agent (Claude Code, Cursor, any MCP host) control a Chrome tab: click, type, read the page, take screenshots, even fake API responses to test a UI before its backend exists. [`chrome-devtools-mcp`](https://github.com/ChromeDevTools/chrome-devtools-mcp) does this too, but it runs a whole Puppeteer browser and talks to *all* your open tabs at once, which is why a single busy tab can freeze it and leave you typing `/mcp` to restart the server mid-task.

`cdp-toolkit` keeps it simple: **one connection to the one tab each call names, and a time limit on every action.** Drive as many tabs as you like, one named target at a time, and point several agents at the same Chrome without them stealing each other's tabs. When something stalls, you get an error back, not a frozen agent. Same things you could do before, minus the wedging and the restarts.

That's the whole pitch. The technical *why* (fan-out, lazy domain enabling, the `Network.enable` hang) is below.

## Why it exists

If [`chrome-devtools-mcp`](https://github.com/ChromeDevTools/chrome-devtools-mcp) ever **wedged your agent on a busy tab**, you've met its design: it manages a Puppeteer browser, fans every operation out across *all* attached targets, and enables the `Network` domain on connect so it can passively buffer everything. That generality is exactly what makes it fragile once you already know which tab you want to drive.

`cdp-toolkit` makes the opposite bet. Every call attaches **one** direct WebSocket to the **one** target it resolved, enables only the CDP domains it needs, and enforces a **per-command timeout** so a stuck renderer can never hang the caller. The connection lives for that call and closes after it, so nothing bleeds between tabs. For driving tabs you already have in hand, the common automation and evidence-gathering case, it's materially more robust.

## cdp-toolkit vs chrome-devtools-mcp

| | **cdp-toolkit** | **chrome-devtools-mcp** |
|---|---|---|
| **Target scope** | one resolved tab per call (`active` / `index:N` / `url:` / `title:`), any number of tabs across calls | all attached targets; fan-out can stall on an unrelated tab |
| **`Network.enable`** | lazy, only when a tool needs it | eager on connect, a known hang on busy renderers |
| **Per-command timeout** | ✅ bounded (`CDP_TIMEOUT_MS`, 15s default), rejects, never hangs | ❌ none; a stuck renderer blocks indefinitely |
| **Element refs** | stateless `backendDOMNodeId` (resolved on demand) | server-side handle table (can drift / expire) |
| **Network mocking** | ✅ persistent per-target fake backend | ❌ not available |
| **Runtime deps** | CDP/CLI layer: native `WebSocket` + `fetch` (the MCP server adds only the MCP SDK) | Puppeteer stack |
| **Auto-wait / retry** | ❌ single-shot; re-snapshot between steps | ✅ Puppeteer's auto-wait envelope |

**Use `chrome-devtools-mcp`** if you need multi-target autonomy or Puppeteer's auto-wait/retry on an *unknown* page. **Use `cdp-toolkit`** when you know which tabs you want driven, however many that is, and need them not to hang. They coexist: `cdp-toolkit`'s tools are namespaced `mcp__cdp-toolkit__*`, distinct from `mcp__chrome-devtools__*`.

## Is this for you?

**Yes, if you:**
- drive tabs you name from Claude Code / Cursor / any MCP host and want them to never wedge;
- need to **mock a backend** to build or test a UI before the real API exists;
- have been bitten by the eager-`Network.enable` hang on a busy renderer;
- run **multiple agents against one Chrome** and need them to stop stealing each other's tabs.

**Probably not, if you:**
- need cross-browser (Firefox / WebKit), use [`playwright-mcp`](https://github.com/microsoft/playwright-mcp);
- need Puppeteer's auto-wait/retry envelope for an unknown, changing page;
- want one server to fan out across *all* your open tabs at once.

## Quickstart (about 30 seconds)

```bash
# 1. Start Chrome/Chromium with the DevTools port open
open -a "Google Chrome" --args --remote-debugging-port=9222
#   (Linux: google-chrome --remote-debugging-port=9222)

# 2. Add cdp-toolkit to Claude Code at user scope (every project, no install step)
claude mcp add cdp-toolkit --scope user -- npx -y cdp-toolkit   # or: bunx -y cdp-toolkit

# 3. In Claude Code, call a tool to prove it works:
#    mcp__cdp-toolkit__list_pages
```

That's it. Tools appear namespaced as `mcp__cdp-toolkit__<tool>`. The server connects to Chrome **lazily per call**, so it loads cleanly even when Chrome isn't running.

Prefer the **CLI**? Every tool is runnable directly:

```bash
npx -y --package cdp-toolkit cdp list_pages          # or swap npx → bunx
npx -y --package cdp-toolkit cdp navigate_page --target index:0 --url https://example.com
# …or from a clone: `bun run src/cli.ts <tool> …`
```

**Requirements:** Node ≥ 22 **or** Bun ≥ 1.1: `npx -y cdp-toolkit` and `bunx -y cdp-toolkit` both work (the published bins are plain Node ESM). Chrome/Chromium with `--remote-debugging-port=9222`. Smoke-check the port: `curl -s http://127.0.0.1:9222/json/version`.

### MCP client setup

<details>
<summary><b>Claude Code</b></summary>

```bash
claude mcp add cdp-toolkit --scope user -- npx -y cdp-toolkit   # or: bunx -y cdp-toolkit
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
    "cdp-toolkit": { "command": "npx", "args": ["-y", "cdp-toolkit"] }
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

- **One target per call, never a broadcast.** Each call opens one WebSocket to the one target it named, with a bounded timeout on every CDP command, lazy domain enabling, and stateless element refs. Drive as many tabs as you like across calls; there is still no broadcast step that can stall on a wedged tab.
- **Network mocking: build the UI before the backend exists.** `mock_request` arms a persistent per-target fake backend: return canned responses, force errors, or inject latency/fault rates. Mocks survive reloads and navigations until `clear_mocks`.
- **Full chrome-devtools-mcp parity + extras.** All 29 upstream tools, plus `performance_trace` (a robust single-call trace), Lighthouse audits, heap snapshots, and a cookie group that reads, writes, and deletes httpOnly cookies. 39 single-purpose tools, no discovery overhead, and they coexist with `chrome-devtools-mcp` in a separate namespace.
- **Many agents, one browser, no stolen tabs.** `claim_page` hands out an opaque lease token for one tab; every other tool checks it at target resolution, so an unqualified call against a leased tab is refused by name rather than silently retargeted to whatever tab a different agent is driving.
- **Out-of-model secret handling.** A read that would return a credential, a JWT in `localStorage` via `evaluate_script` or an httpOnly session cookie via `list_cookies`, takes a `savePath` that writes the value to a file and keeps it out of the tool response entirely, so the secret never lands in the agent transcript. That same per-call, in-process design makes cdp-toolkit a clean substrate for credential-injection tools: a vaulted password can be typed straight into the DOM while only a status crosses back to the model, never the secret.
- **Provenance that outlives the lease.** `list_pages` reports `origin: "agent"` (with the creating `label`) for every tab this toolkit opened, and `"unknown"` otherwise. It never claims `"human"`: the absence of a creation record cannot prove a person opened the tab, so `"unknown"` is the honest word once an agent releases, expires, or dies and its tab is left behind.

## Why raw CDP beats the MCP for known targets

Each point below leads with the symptom you've probably hit, then the cause, then the fix.

- **Your agent stalls on a call when a busy background tab is open** → that's the **all-target fan-out**: every operation broadcasts to all attached targets. every cdp-toolkit call resolves *one* target (`active | index:N | url:<substr> | title:<substr> | <targetId>`) and attaches a single WebSocket to just that page, so a busy tab you did not name is never touched.
- **A tool hangs forever and never returns** → the MCP's eager `Network.enable` on a busy or hung renderer is a known wedge. cdp-toolkit enables domains **lazily**, only where a tool needs them (the recorder enables `Network`/`Runtime`/`Log`; most tools touch only `Page`/`Runtime`/`DOM`).
- **No way to bound a slow call** → `CdpConnection.send()` enforces `CDP_TIMEOUT_MS` (15s default) on *every* command and **rejects rather than hangs**, so a stuck renderer can never block a caller indefinitely.
- **Element handles drift across calls** → a `uid` **is** a CDP `backendDOMNodeId`, resolved on demand via `DOM.resolveNode`. There is no server-side handle table to drift or expire.

The trade-off is generality: this toolkit acts on one named page per call and does **not** replicate Puppeteer's auto-wait/retry envelope. Re-`take_snapshot` between steps rather than expecting an implicit wait.

## Network mocking: a fake backend for building/testing UIs

Build and test a UI before its backend (or its data) exists. `mock_request` arms a persistent per-target interception session; mock several endpoints by calling it repeatedly, then iterate on the page; the mocks survive reloads and navigations until `clear_mocks`.

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
# Read a value WITHOUT it landing in the response (or an agent transcript):
# savePath writes the value to a JSON file and returns {path,bytes,type,target} only.
cdp evaluate_script --json '{"expression":"localStorage.getItem(\"auth\")","savePath":"auth.json"}'
# Cookies, httpOnly ones included (document.cookie cannot see those):
cdp list_cookies --target index:0 --json '{"domain":"example.com"}'
# Same read, with the values kept out of the response: {path,bytes,count,target} only.
cdp list_cookies --json '{"name":"session","savePath":"cookies.json"}'
# Write one, httpOnly included (document.cookie cannot create those either):
cdp set_cookie --json '{"name":"session","value":"abc","url":"https://example.com/","httpOnly":true}'
# Remove it again. Either url or domain is required on both write tools.
cdp delete_cookies --json '{"name":"session","url":"https://example.com/"}'
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
| `CDP_LEASE_TTL_MS` | `900000` | How long a tab lease survives without use before another agent can reclaim it. Refreshed on every checked call. |

## Firefox (WebDriver BiDi)

cdp-toolkit ships a second backend, Firefox over [WebDriver BiDi](https://w3c.github.io/webdriver-bidi/), behind the same 39-tool surface. Chrome stays the default and its behavior is unchanged, opt in explicitly to reach Firefox:

```bash
cdp --browser firefox take_snapshot                 # CLI: explicit flag
CDP_BROWSER=firefox cdp take_snapshot                # CLI: env var (same precedence, lower priority)
cdp --capabilities --browser firefox                 # see what's available and why the rest isn't
```

Backend selection precedence: `--browser chrome|firefox` flag, then `CDP_BROWSER`, then `chrome`. For the MCP server, set `CDP_BROWSER=firefox` (or pass `--browser firefox` in its launch args) in your MCP client config; the backend is fixed for the life of that server process.

**Firefox is launched, never attached to.** Unlike Chrome, there is no way to add a debug port to an already-running Firefox: the flag only takes effect on the process's original launch, so relaunching the binary against a running instance hands off and exits silently, opening no port (verified against Firefox 153.0.3). `--browser firefox` therefore always starts a fresh Firefox process with a throwaway profile:

- **CLI** (one process per invocation): each command launches Firefox, runs exactly one tool call, and disposes the session and kills the process before exiting, win or lose. State does not carry between separate CLI invocations: there is no running Firefox left afterward for a second command to find.
- **MCP server** (long-lived): the first Firefox tool call launches one Firefox process and memoizes its BiDi session for the life of the server; every later Firefox call reuses it. The session is torn down on `SIGINT`/`SIGTERM`/stdin close. Multi-step Firefox workflows (navigate, then snapshot, then click) need the MCP server, not the CLI, for exactly this reason.

**Tool availability is filtered per backend**, not per call: `tools/list` (MCP) and `--list`/`--capabilities` (CLI) only ever advertise a tool the selected browser can actually run. A tool is never listed and then thrown from at call time. Under Firefox, four tool groups are absent because Firefox 153's BiDi implementation has no equivalent domain:

- `performance_start_trace`, `performance_stop_trace`, `performance_analyze_insight`, `performance_trace` (needs `trace.performance`)
- `take_heapsnapshot` (needs `heap.snapshot`)
- `lighthouse_audit` (needs `audit.lighthouse`)

Everything else, including `mock_request`/`list_mocks`/`clear_mocks` (Firefox's `network.addIntercept` covers the same fake-backend use case as Chrome's `Fetch` domain) and the `claim_page`/`release_page`/`list_leases` lease group, is available under both backends: 33 of the 39 tools.

**Honest capability gaps, not oversold parity:**

- **No accessibility tree.** `take_snapshot` under Chrome reads a native a11y tree (`Accessibility.getFullAXTree`). Firefox 153's BiDi has no equivalent domain, so the Firefox snapshot is a DOM-heuristic walk that infers roles from tag/attribute conventions. It is good enough to find and click things; it is not a substitute for a real accessibility audit.
- **No atomic text insert.** Chrome's `fill`/`type_text` commit a value in one `Input.insertText` call. BiDi has no equivalent primitive, so Firefox always synthesizes real per-character keystrokes via `input.performActions` (one `<select>` exception: an exact-match value/index assignment, since typeahead-by-first-letter cannot reliably commit an arbitrary option).
- **Thin emulation.** Only viewport size/DPR and `userAgent` are applied. CPU throttling, media-feature emulation (e.g. `prefers-color-scheme`), and network-condition throttling are not available: Firefox 153 does not implement the underlying BiDi commands.
- **No tracing, heap snapshots, or Lighthouse.** See the capability list above; there is no BiDi equivalent for any of the three.
- **`locate.text` is not available** (Firefox 153's `browsingContext.locateNodes` rejects the `innerText` locator type as unsupported), unlike Chrome, which has it via `DOM.performSearch`.
- **No `--browser firefox` attach mode.** By design, per the launch model above: every invocation gets its own throwaway Firefox process and profile.

## The tools (29 parity + 10 superset = 39)

The 29 parity tools are 1:1 with `chrome-devtools-mcp`; the 10 superset tools (`performance_trace`, the `list_cookies`/`set_cookie`/`delete_cookies` cookie group, the `mock_request`/`list_mocks`/`clear_mocks` group, and the `claim_page`/`release_page`/`list_leases` lease group) are toolkit additions. Each row notes the underlying CDP method(s) and the precise parity gaps.

| MCP name | CDP method(s) | Parity notes / gaps |
|---|---|---|
| `list_pages` | `GET /json/list` | `all` flag also exposes worker/background targets; MCP lists only page tabs. Each row additionally carries `origin` (`agent` or `unknown`, never `human`) plus `label`/`createdAt` for tabs this toolkit created. |
| `new_page` | `Target.createTarget` (+ lease file) | Returns `{targetId,url}`; does not await navigation (use `navigate_page`). `claim:true` also claims the new tab and returns a `lease` token (`label`/`ttlMs` optional). |
| `close_page` | `Target.closeTarget` (+ lease file) | Reports `success:true` on the empty result newer Chromium returns. A successful close also releases that tab's lease; a failed close leaves it in place. |
| `select_page` | `Target.activateTarget` + selected-state file | Writes a flat-file selected target; `resolveTarget` does not read it, so `active` still means `index:0` unless a tool opts in. |
| `navigate_page` | `Page.navigate` / `Page.reload` + load events | Returns `{url,frameId,waitedFor}` (no auto-snapshot). `waitUntil` supports `load`/`domcontentloaded`. `reload:true` (+ `ignoreCache:true` for a hard reload). |
| `wait_for` | `Runtime.evaluate` (poll `innerText`) | Text-substring waiting only; throws on timeout rather than returning `{found:false}`. |
| `evaluate_script` | `Runtime.evaluate` / `callFunctionOn` | No live `page`/element handle; `args` are plain JSON. Main-world context only. Toolkit addition: optional `savePath` writes the value to a JSON file and keeps it out of the response entirely. |
| `list_cookies` *(superset)* | `Network.getCookies` | Reads the target page's cookie store, httpOnly cookies included, which `document.cookie` and therefore `evaluate_script` cannot see. Page-scoped on purpose, not the browser-wide jar (`Storage.getCookies`), so it answers for the tab you named. Optional `domain`/`name` filters; optional `savePath` writes the array to a JSON file and returns `{path,bytes,count,target}` with no cookie value in the response. |
| `set_cookie` *(superset)* | `Network.setCookie` | Writes one cookie, httpOnly and secure ones included, which `document.cookie` cannot create. Either `url` or `domain` is required and the call is refused with an error when neither is given. Chrome's `success:false` refusal is raised as an error rather than reported as a write. Answers `{set:true,target}` and never echoes the value back. `path` is passed through as given, never defaulted. |
| `delete_cookies` *(superset)* | `Network.deleteCookies` | Removes the named cookie, httpOnly ones included. Requires `name` plus `url` or `domain`, so a name-only call cannot sweep the store; optional `path` narrows further. Answers `{deleted:true,target}` with no count, because neither protocol reports one; read `list_cookies` before and after for a real count. |
| `take_snapshot` | `Accessibility.getFullAXTree` | uid is the raw `backendDOMNodeId` (stateless, non-sequential). Full tree in one shot; frames flattened. `interactiveOnly` is a toolkit addition. |
| `click` | `Input.dispatchMouseEvent` | No implicit auto-wait/retry; resolves and acts once; re-snapshot between steps. |
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
| `performance_start_trace` | `Tracing.start` / `dataCollected` | Works ONLY within one process; a live trace buffer is bound to its connection. Use `performance_trace` for robustness. |
| `performance_stop_trace` | `Tracing.end` / `tracingComplete` | Must run in the SAME process as `performance_start_trace`; throws a clear error otherwise. |
| `performance_analyze_insight` | parses a trace JSON file | A **CDP-native approximation** of the MCP insight analyzer (FCP/LCP/CLS/TBT/long-tasks); close but not byte-identical. Requires an explicit `tracePath`. |
| `take_heapsnapshot` | `HeapProfiler.takeHeapSnapshot` | Returns `{path,bytes,chunks,target}`; does not parse the snapshot (load the `.heapsnapshot` in the DevTools Memory panel). |
| `lighthouse_audit` | **none (non-CDP)**, spawns `npx --yes lighthouse …` | The toolkit's sole non-CDP tool. Defaults to the desktop preset. Returns numeric category scores (full report on disk). |
| `performance_trace` *(superset)* | `Tracing.*` (+ `Page.reload`) | **Toolkit convenience.** A robust single-call trace: start → optional reload → capture for `durationMs` → end → write the trace JSON → return `{path,bytes,events,metrics}`. Preferred over the `start`/`stop` pair (CDP tracing is browser-global and bound to one connection). |
| `mock_request` *(superset)* | `Fetch.*` (+ `Page.reload`) | **A fake backend.** Registers a rule on a target's persistent session: fulfill with a canned response, fail, or continue (with optional `delayMs`/`failRate`). Persists across reloads until `clear_mocks`. Request-stage only. Cached requests aren't intercepted (use `reload:true`). |
| `list_mocks` *(superset)* | `Runtime.evaluate` (liveness probe) | Lists active mock sessions with rules + hit counts; prunes sessions whose tab closed. |
| `clear_mocks` *(superset)* | `Fetch.disable` | Tears down the resolved target's mock session (or all with `all:true`). |
| `claim_page` *(superset)* | `Target.createTarget` + lease file | Opens or claims a tab and returns an opaque lease token. MCP only; the CLI refuses it. |
| `release_page` *(superset)* | lease file | Gives a lease back. Idempotent, and does not close the tab. |
| `list_leases` *(superset)* | lease file | Who holds what, with pid liveness and reclaimability. Needs no token; never returns the nonce. A lease file that could not be read or parsed is reported as an `unreadable` row instead of being skipped. |

## Parallel tabs: many agents, one browser

Two agents pointed at the same Chrome both resolve `target: active` to whatever tab the human last focused. Nothing errors. Each one gets plausible, well-formed output from the wrong page: a snapshot of someone else's form, a fill that lands in someone else's field. A crash gets caught; a silent wrong-tab success does not.

`claim_page` fixes that by handing you an opaque lease token for one tab:

```json
{"tool": "claim_page", "arguments": {"url": "https://example.com", "label": "checkout-agent"}}
```

```json
{"lease": "chrome:1A2B...:0f3c...", "targetId": "1A2B...", "url": "https://example.com", "label": "checkout-agent", "ttlMs": 900000, "expiresAt": 1754400000000}
```

Pass that token as `lease` on every later call against the tab. `new_page` with `claim: true` does the open-and-claim in one call. `release_page` gives it back, `list_leases` shows who holds what.

**Opt in, and only ever a refusal.** A tab nobody claimed behaves exactly as it did before. Omitting `lease` is identical to pre-1.2 behavior in every respect: no default changed, no return shape changed, no previously legal call now needs a new argument. This is why it is 1.2 and not 2.0.

**What can newly fail.** Any call that resolves to a leased tab without presenting that tab's token is refused, naming the tab, its url, and the label of whoever holds it. That is every selector form, not one of them: `active` or no target at all, `index:N`, `url:<substring>`, `title:<substring>`, and a bare targetId all reach the same check. The case worth singling out is `active` (or no target) against a leased tab index 0, because there you did not name the tab and before 1.2 the call silently succeeded against whatever tab happened to be first. That refusal is the point of the feature, and it is called out here rather than left to be discovered.

**Reclamation.** A lease is reclaimable when its owning process is gone, or when `lastUsedAt` is older than `ttlMs` (default 15 minutes, `CDP_LEASE_TTL_MS`). Those two are the whole list. A lease whose tab is no longer open is *reported* by `list_leases` as `target-gone`, which is useful to see, but that report is not what frees it: such a record is freed by the same two rules as any other, whichever lands first. Every checked call refreshes `lastUsedAt`, so an agent that is working never expires and no heartbeat is needed. Reclaiming mints a fresh nonce, which invalidates the previous owner's token: a stalled agent that comes back cannot keep driving a tab someone else now owns.

**Unreadable lease files.** A row in `list_leases` can carry `unreadable`, holding the errno (for example `EACCES`) or `"unparseable"`, when the lease file exists but could not be read or parsed. On such a row `label`, `pid`, `createdAt`, `lastUsedAt`, and `ttlMs` are zero placeholders, not real values, since they live inside the file that could not be read. `stale` is always `false` on that row, deliberately: `stale` is what a reader treats as free to take, and an unreadable lease must never read that way.

**Verifying it against a real browser.** `bun run lease:smoke` (`test/lease-smoke.ts`) is the end-to-end harness for this feature. It drives a REAL browser on `CDP_BASE` (default `http://127.0.0.1:9222`) and spawns a genuine second OS process for the stranger role, because a lease records the claiming pid and a sequence of CLI calls can never collide: the first process is dead before the second starts. It asserts that the owner can act, that a tokenless stranger is refused with the `LeaseConflictError` type, `targetId` and `holder` intact and NOT coded `no-such-target`, that the refusal actually prevented the side effect (proved by reading the marker back, not by the throw), that a genuinely missing target still reports `no-such-target`, that the stranger is admitted after `release_page`, and that a lease orphaned by a real child process which exited is reclaimable with a fresh nonce. It is safe to point at a browser with real tabs open: it opens exactly one throwaway `about:blank` tab, addresses it only by its own target id, closes exactly that tab, and never closes the browser. It captures its own baseline tab listing at runtime and fails only if a tab that existed before the run went missing; tabs you open mid-run are ignored. Lease files go to a private temp dir that is removed on exit.

### Which tab did an agent open? (`origin`)

A lease answers "who is *driving* this tab right now". It cannot answer "who *opened* it", and that second question outlives the first: the moment an agent releases, expires, or dies, its abandoned tab is indistinguishable from one you opened yourself. Diffing two `list_pages` snapshots does not settle it either, since a tab you opened a minute ago looks exactly like a stray agent tab.

So every tab this toolkit creates is written to a creation ledger, and `list_pages` reports it:

```json
{"id": "1A2B...", "url": "https://example.com", "title": "Example", "type": "page",
 "origin": "agent", "label": "checkout-agent", "createdAt": 1754400000000}
```

- `origin: "agent"` means cdp-toolkit created the tab, via `new_page` or via `claim_page` with no `targetId`. The row then also carries the creating `label` (the same value a lease would show, defaulting to `pid-<pid>`) and `createdAt`.
- `origin: "unknown"` means there is no creation record. **It never says `"human"`.** The toolkit cannot prove a person opened a tab: no record is equally consistent with a tab opened before the server started, a tab restored from a previous session, another tool driving the same Chrome, or a record that could not be written. `unknown` is the honest word, and reading it as "safe, a human opened this" is the one mistake this field exists to prevent.

**It outlives the lease, deliberately.** `release_page`, expiry, and reclamation all leave the record alone. Only the tab going away removes it: the ledger is reaped when it is read, dropping records for targets the browser no longer has, so it stays self-cleaning with nothing scheduled.

**Claiming a tab you did not open records nothing.** `claim_page` with an explicit `targetId` takes ownership of an existing tab; that tab keeps reporting `origin: "unknown"`, because provenance is not ownership.

**Unreadable records.** If a target has a creation record that could not be read or parsed, its row reports `origin: "unknown"` plus `originUnreadable` (the errno, for example `EACCES`, or `"unparseable"`). Same principle as `list_leases`' `unreadable` rows: a broken record must never be indistinguishable from no record at all. A missing or unreadable ledger never fails `list_pages`; every page simply reports `unknown`.

**Backward compatible.** `id`, `url`, `title`, and `type` are unchanged. The provenance fields are purely additive.

**What this does not do.**

- No fan-out. Every call still names exactly one tab. An agent that wants several drives them a call at a time and holds a separate lease per tab; a single call acting on many tabs is a different feature and is not addressed.
- No isolation. Two leased tabs on one Chrome still share cookies, `localStorage`, and every other origin-scoped store. A lease is ownership of a tab, not isolation of the browser under it.
- No protection from humans. The lease is enforced against cdp-toolkit's own tool calls. It cannot stop someone clicking into the tab.
- Not for the CLI. A CLI invocation is one process per call, so a lease it claimed would be reclaimable immediately by the dead-pid rule. `claim_page` is refused there. CLI calls can still present a token minted by the MCP server with `--lease`.

## How it's built

```
src/
  client.ts          # CdpConnection, openPage/withPage/openBrowser, resolveTarget, timeouts
  types.ts           # Target, TargetSelector, Uid, CDP envelopes
  index.ts           # TOOLS registry (39) + re-exported client primitives
  cli.ts             # the Bun CLI
  mcp.ts             # stdio MCP server (exposes TOOLS via @modelcontextprotocol/sdk)
  manifest.ts        # JSON Schemas advertised by the MCP server (one per tool)
  leases.ts          # lease records, staleness, reclamation, assertLeaseOk
  leases-tools.ts    # claim_page / release_page / list_leases
  origins.ts         # tab creation ledger: who OPENED a tab, outliving its lease
  tools/
    pages.ts navigation.ts evaluate.ts snapshot.ts input.ts
    screenshot.ts emulation.ts dialogs.ts recorder.ts console.ts
    network.ts performance.ts heap.ts lighthouse.ts network_mock.ts
test/
  smoke.ts             # safe end-to-end tool smoke (bun run smoke)
  mock-smoke.ts        # network-mocking end-to-end smoke (bun run mock:smoke)
  network_mock.test.ts # pure-logic unit tests (bun test)
  mcp-smoke.ts         # MCP handshake + live tools/call round-trip (bun run mcp:smoke)
  lease-smoke.ts       # two-process live lease harness (bun run lease:smoke)
```

Each module ends with a footer comment listing the exact CDP methods it uses and its parity gaps. The full design contract lives in [`CONTRACT.md`](./CONTRACT.md).

## Contributing

Issues and PRs welcome, see [`CONTRIBUTING.md`](./CONTRIBUTING.md) and the [`good first issue`](https://github.com/sblattj/cdp-toolkit/labels/good%20first%20issue) label. By participating you agree to the [Code of Conduct](./CODE_OF_CONDUCT.md).

## License

[MIT](./LICENSE) © Stephen Blatt
