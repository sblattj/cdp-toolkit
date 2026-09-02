# cdp-toolkit

**A lightweight, drop-in alternative to [`chrome-devtools-mcp`](https://github.com/ChromeDevTools/chrome-devtools-mcp) that won't wedge your agent.** It drives the Chrome tabs you point it at over the raw DevTools Protocol: any number of tabs, one explicitly named target per call over one direct socket, with a bounded timeout on every call, so a stuck page returns a clean error instead of hanging your agent and forcing a `/mcp` restart. Same idea, no all-target fan-out, plus tab leases so several agents can work one browser (and know when a human is using it too), plus a built-in network-mocking fake backend. **45 tools, all of them on one static, cacheable MCP listing** — or a lean 12-tool `core` listing when your client loads every schema eagerly (see [Progressive disclosure](#progressive-disclosure)). Chrome is the flagship default; a second backend drives Firefox over WebDriver BiDi behind the same tool surface (see below).

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
- need **WebKit / Safari**, or a browser that is neither Chromium nor Firefox — use [`playwright-mcp`](https://github.com/microsoft/playwright-mcp). Firefox *is* supported here, as a first-class backend (see [Firefox (WebDriver BiDi)](#firefox-webdriver-bidi));
- need Puppeteer's auto-wait/retry envelope for an unknown, changing page;
- want one server to fan out across *all* your open tabs at once.

## Quickstart (about 30 seconds)

**Fastest path — the interactive installer.** `cdp install` registers the MCP server into a harness you pick and appends a shell alias that launches your browser with its debug port open:

```bash
npx -y --package cdp-toolkit cdp install     # or `cdp install` from a clone / after a global install
```

It asks for a harness (`claude` | `codex` | `opencode`), a debug port, and a browser (`arc` | `chrome` | `firefox`), then writes an idempotent marker block into your `~/.zshrc`/`~/.bashrc`. The same flags drive it non-interactively: `--harness --browser --port --name --no-alias --yes`. The Firefox alias it writes includes `--marionette` (required for cdp-toolkit's orphaned-session auto-recovery — see [Firefox](#firefox-webdriver-bidi)). It is a CLI subcommand, **not** a 46th tool: `cdp --list` still shows 45.

Prefer to wire it by hand? The manual path is three steps:

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

Either let `cdp install` register it for you (pick `claude` at the harness prompt), or wire it by hand:
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
- **Full chrome-devtools-mcp parity + extras.** All 29 upstream tools, plus `performance_trace` (a robust single-call trace), Lighthouse audits, heap snapshots, a cookie group that reads, writes, and deletes httpOnly cookies, real HTML5 drag-and-drop, raw scroll/mouse dispatch, download capture, permission grants, and tab-to-video screen recording. The MCP server publishes all of them on one static, cacheable `tools/list` (≈8.5k tokens, −58% vs 1.x) and serves the full per-tool prose on demand through `describe_tool`; `CDP_TOOL_PROFILE=core` trims that listing to a 12-tool everyday set (≈2.3k tokens) for clients that eagerly load every schema, and the trimmed-away tools stay callable by name. The CLI exposes all 45 regardless. They coexist with `chrome-devtools-mcp` in a separate namespace.
- **A whole page is a file, not a wedged tab.** Chrome cannot encode a screenshot past 16384 device px on either side, and past that `Page.captureScreenshot` does not error — it never answers, and leaves the tab resized to the clip it was capturing. On a ratio-2 display that ceiling arrives at about 8192 CSS px: an ordinary long article. `take_screenshot` measures the projection before every capture and, past the cap, takes the page as vertical bands stitched losslessly into one PNG — a 140,982 CSS px page comes back as a 2780×281964 file in 18 bands, in 17 seconds, with the tab still healthy. Also per-capture `scale`, and `renderWidth`/`renderHeight` to shoot one capture at an emulated viewport and restore the tab afterwards.
- **Many agents, one browser, no stolen tabs.** `claim_page` hands out an opaque lease token for one tab; every other tool checks it at target resolution, so an unqualified call against a leased tab is refused by name rather than silently retargeted to whatever tab a different agent is driving.
- **Knows when a human is already using the tab you're driving.** An in-page activity beacon distinguishes a person's clicks/keys/scrolls from the toolkit's own dispatched input, so `claim_page` and `list_leases` can report `humanActiveMs` and warn on contention instead of silently fighting someone for the keyboard. See "Staleness: is a human already using this tab?" below.
- **Out-of-model secret handling.** A read that would return a credential, a JWT in `localStorage` via `evaluate_script` or an httpOnly session cookie via `list_cookies`, takes a `savePath` that writes the value to a file and keeps it out of the tool response entirely, so the secret never lands in the agent transcript. That same per-call, in-process design makes cdp-toolkit a clean substrate for credential-injection tools: a vaulted password can be typed straight into the DOM while only a status crosses back to the model, never the secret.
- **Provenance that outlives the lease.** `list_pages` reports `origin: "agent"` (with the creating `label`) for every tab this toolkit opened, and `"unknown"` otherwise. It never claims `"human"`: the absence of a creation record cannot prove a person opened the tab, so `"unknown"` is the honest word once an agent releases, expires, or dies and its tab is left behind.

## Why raw CDP beats the MCP for known targets

Each point below leads with the symptom you've probably hit, then the cause, then the fix.

- **Your agent stalls on a call when a busy background tab is open** → that's the **all-target fan-out**: every operation broadcasts to all attached targets. every cdp-toolkit call resolves *one* target (`active | index:N | url:<substr> | title:<substr> | label:<name> | <targetId>`) and attaches a single WebSocket to just that page, so a busy tab you did not name is never touched.
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
cdp --help                                   # top-level usage
cdp take_screenshot --help                   # that tool's arguments, from its schema — touches no browser

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
# A whole page, however long: past Chrome's 16384-device-px encode limit the capture is
# taken as vertical bands and stitched into one lossless PNG. No flag needed — this is the
# default — and the result says so: {"width":2780,"height":281964,"tiled":true,"bands":18}.
cdp take_screenshot --target url:example --fullPage true --savePath /tmp/whole-page.png
# 3x output pixels for one capture (Chrome only). The page is not told anything changed.
cdp take_screenshot --target url:example --scale 3
# Shoot a responsive page at desktop width from a tab that isn't that size, then restore it.
cdp take_screenshot --target url:example --renderWidth 1920 --renderHeight 1080
cdp lighthouse_audit --url https://example.com --json '{"categories":["performance"]}'
```

**Argument parsing:** the first positional token is the tool name. `--json '<obj>'` merges a JSON object into the args (applied first). `--target <sel>` sets `args.target`. Repeated `--key value` pairs become `args.key`, coerced (`true`/`false` → boolean, numeric strings → number, else string); a bare `--flag` is `true`. Explicit flags override keys from `--json`. Output is `JSON.stringify(result, null, 2)` on stdout (exit 0); on any throw, `{"error":"<message>"}` goes to stderr and the process exits 1.

**`--help`/`-h`** are recognized anywhere in argv, ahead of every other flag, and are never treated as a tool argument or a tool name — as of 1.9.3, `<tool> --help` used to run the tool instead. With no tool named, `cdp --help` prints the usage above. With a tool named, `cdp <tool> --help` prints that tool's arguments (name, type, required/optional, description) read from its schema, and exits 0 having made no CDP connection, taken no lease, and written no file.

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
| `CDP_REQUIRE_LEASE` | off | Strict mode, MCP server only (inert under the CLI regardless of value). Turns leasing from optional into mandatory: a call against an unheld tab acquires a lease instead of driving it lease-free, and `list_pages`/`list_leases` close tabs an abandoned agent left behind. See "Parallel tabs" below. |
| `CDP_TOOL_PROFILE` | `full` | MCP server only. Startup-only filter on what `tools/list` advertises, read once and fixed for the life of the process. `full` (the default, and what unset/empty means) lists every group; `core` lists just the 12 everyday tools plus `describe_tool`; or a comma-separated group list, e.g. `core,network,console` (`core` is always included). An unknown group name is a configuration error: the server prints `CDP_TOOL_PROFILE: unknown tool group 'x'. Known: full, core, input, …` and exits 1. Tools the profile leaves out stay callable by name. See "Progressive disclosure" below. |
| `CDP_REAP_GRACE_MS` | `2700000` | Extra grace (on top of `CDP_LEASE_TTL_MS`) before an `expired` lease's tab is actually destroyed by reap; `dead-pid` tabs are reaped immediately regardless. See "Reap" below. |
| `CDP_FIREFOX_MARIONETTE_PORT` | `2828` | Firefox backend only. The Marionette side-channel port used to force-clear Firefox's orphaned BiDi session during orphan-session recovery (a blind `WebDriver:DeleteSession`). Only effective when that Firefox was launched with `--marionette`. See "Firefox" below. |
| `CDP_FIREFOX_SESSION_WAIT_MS` | `10000` | Firefox backend only. How long a second process waits for a live holder to release Firefox's one BiDi session before returning the distinguishable "held by a live process" error. See "Firefox" below. |

## Progressive disclosure

The MCP server publishes **one complete, deterministic, cacheable `tools/list`**: `describe_tool` first, then every tool the selected browser can actually run whose group the startup profile advertises, in manifest order. It is computed once at startup and frozen — byte-identical on every call, on every connection, and unchangeable by anything a client does mid-session — and on a 2026-era connection it carries cache hints (`ttlMs: 3600000`, `cacheScope: "public"`) so a client can hold it for an hour instead of re-fetching. `capabilities.tools.listChanged` is `false`: nothing will ever notify, because nothing ever changes.

That shape is deliberate. The MCP **2026-07-28** revision puts lazy discovery on the *host* side — the client runs its own catalog → inspect → execute funnel across the servers it has connected — and a server cooperates by publishing a complete, deterministic, cacheable list rather than by mutating its own. The revision makes it a MUST that a server's tool set not change as a side effect of other requests on the connection. See [Build an MCP server](https://modelcontextprotocol.io/docs/2026-07-28/develop/build-server) and [Client best practices](https://modelcontextprotocol.io/docs/2026-07-28/develop/clients/client-best-practices); the latter also notes that adding or removing tool definitions mid-conversation invalidates the host's prompt cache — which a list that never changes never does. 2.0.0's `browser_tools` runtime activation toggle was exactly that anti-pattern and is **removed in 2.1**: calling it now returns `unknown tool: browser_tools`.

**`describe_tool` is the inspect layer.** The listing carries terse one-liners; the full description and per-parameter docs load on demand, for *any* tool — listed or not:

```json
{"tool": "describe_tool", "arguments": {"name": "wait_for_download"}}
{"tool": "describe_tool", "arguments": {}}
```

With no `name` it returns the grouped catalog of everything this server can run. The whole 45-tool surface costs 1,141 characters:

```
cdp-toolkit 2.1.0 · browser=chrome · 45 tools available, 46 in tools/list (CDP_TOOL_PROFILE=full)
[listed] core (12): list_pages, new_page, close_page, select_page, navigate_page, wait_for, take_snapshot, click, fill, type_text, evaluate_script, take_screenshot
[listed] input (7): hover, drag, scroll, dispatch_mouse, press_key, fill_form, upload_file
[listed] cookies (3): list_cookies, set_cookie, delete_cookies
[listed] network (2): list_network_requests, get_network_request
[listed] console (2): list_console_messages, get_console_message
[listed] mocking (3): mock_request, list_mocks, clear_mocks
[listed] emulation (2): emulate, resize_page
[listed] performance (6): performance_start_trace, performance_stop_trace, performance_analyze_insight, performance_trace, take_heapsnapshot, lighthouse_audit
[listed] recording (2): start_screen_recording, stop_screen_recording
[listed] leases (3): claim_page, release_page, list_leases
[listed] permissions (1): grant_permissions
[listed] dialogs (1): handle_dialog
[listed] downloads (1): wait_for_download
Unlisted tools are callable by name; describe_tool {name} documents any of them.
```

Under a narrower profile the groups it leaves out read `[hidden]` instead of `[listed]`, and the header's second count drops accordingly.

**`CDP_TOOL_PROFILE` is the only filter, and it is startup-only** — set once by whoever configures the server, then fixed for the life of the process. Measured over raw stdio (bytes = compact JSON of the `tools` array, tokens ≈ bytes ÷ 4):

| `CDP_TOOL_PROFILE` | entries in `tools/list` | bytes | ≈ tokens |
|---|---|---|---|
| unset / `full` — the default | 46 | 33,886 | ≈8,471 |
| `core` | 13 | 9,066 | ≈2,266 |
| `core,network,console` | 17 | 11,893 | ≈2,973 |
| `full` under `CDP_BROWSER=firefox` | 35 | 26,533 | ≈6,633 |

For comparison, 1.x advertised 45 tools with full prose at roughly 20,200 tokens. So the default listing is **−58% vs 1.x**, and `core` is **−89%**.

The default flipped from `core` (2.0.0) to `full` in 2.1 for three reasons: the standard puts discovery on the host, and a host that defers schemas — Claude Code lists MCP tool *names* and loads schemas on demand — pays little for a complete list; consumers that hold per-tool allowlists or per-tool interception keyed on the tool *name* for non-core tools (the console and network readers, `performance_analyze_insight`) were silently broken by a `core` default, because those tools were simply absent from `tools/list`; and a list that never changes never invalidates the host's prompt cache. Keep `CDP_TOOL_PROFILE=core` if your client eagerly loads every schema — that is where the ≈2.3k-token surface is worth the round trips.

Three rules worth knowing:

- **Unlisted does not mean blocked.** Only discovery is filtered. `tools/call` checks backend availability, not group membership, so an agent that names an unlisted-but-available tool still executes it; only a tool the selected browser cannot run at all is refused by name.
- **`describe_tool` works for any tool by name, unlisted ones included** — the full description and per-parameter docs behind the terse one-liner `tools/list` carries.
- **Profiles and `describe_tool` are MCP-only.** They are MCP-server concepts: `cdp describe_tool` fails with `unknown tool 'describe_tool'`, and the CLI keeps exposing all 45 tools no matter how `CDP_TOOL_PROFILE` is set.

### MCP protocol eras

The server serves **both** eras off the same stdio transport, and the era is pinned per connection by how the client opens:

- A modern client opens with **`server/discover`** and gets `protocolVersion` `2026-07-28`, `resultType: "complete"`, the `_meta['io.modelcontextprotocol/serverInfo']` envelope, and the `ttlMs`/`cacheScope` cache hints on both `server/discover` and `tools/list`.
- A 2025-era client opens with **`initialize`** and gets `protocolVersion` `2025-11-25`, exactly as before — this upgrade is invisible to it.

Measured 2026-09-01: Claude Code 2.1.258 and Codex CLI 0.147.0 both connect and both pin the **legacy** era — their binaries carry the 2026-07-28 client strings, but neither opens with `server/discover` by default, and the MCP SDK's own `Client` behaves the same unless it opts in. So serving both eras is load-bearing, not courtesy, and today the `ttlMs`/`cacheScope` hints reach only clients that ask for the modern era. The static listing pays off on either one — no mid-session tool churn, and no prompt-cache invalidation.

## Firefox (WebDriver BiDi)

cdp-toolkit ships a second backend, Firefox over [WebDriver BiDi](https://w3c.github.io/webdriver-bidi/), behind the same tool surface. Chrome stays the default and its behavior is unchanged, opt in explicitly to reach Firefox:

```bash
cdp --browser firefox take_snapshot                 # CLI: explicit flag
CDP_BROWSER=firefox cdp take_snapshot                # CLI: env var (same precedence, lower priority)
cdp --capabilities --browser firefox                 # see what's available and why the rest isn't
```

Backend selection precedence: `--browser chrome|firefox` flag, then `CDP_BROWSER`, then `chrome`. For the MCP server, set `CDP_BROWSER=firefox` (or pass `--browser firefox` in its launch args) in your MCP client config; the backend is fixed for the life of that server process.

Firefox runs in one of **two modes**, and the difference between them is process ownership.

**LAUNCH (default): a fresh throwaway-profile Firefox, launched and killed per session.** `--browser firefox` with no `--connect`/`CDP_FIREFOX_ENDPOINT` starts a brand-new Firefox process with an empty profile — a login wall for anything that needs a real, already-authenticated session:

- **CLI** (one process per invocation): each command launches Firefox, runs exactly one tool call, and disposes the session and kills the process before exiting, win or lose. State does not carry between separate CLI invocations: there is no running Firefox left afterward for a second command to find.
- **MCP server** (long-lived): the first Firefox tool call launches one Firefox process and memoizes its BiDi session for the life of the server; every later Firefox call reuses it. The session is torn down on `SIGINT`/`SIGTERM`/stdin close. Multi-step Firefox workflows (navigate, then snapshot, then click) need the MCP server, not the CLI, for exactly this reason.

**ATTACH (`--connect <port|host:port|ws-url>` / `CDP_FIREFOX_ENDPOINT`): connect to a Firefox YOU already started.** Launch a Firefox with its debug port open yourself, and cdp-toolkit connects to that process's BiDi endpoint instead of spawning a throwaway one — so tools see your real, logged-in profile, cookies and all. This process never launches or kills that Firefox: dispose only ends the BiDi session (`session.end`), never the browser.

```bash
# 1. Start YOUR Firefox with the debug port open (a separate, empty --no-remote profile
#    is recommended so it doesn't collide with a Firefox you already have open; drop
#    -profile/-no-remote to attach to your everyday profile instead, once nothing else
#    is holding its BiDi session). --marionette enables cdp-toolkit's orphaned-session
#    auto-recovery over the Marionette side channel; without it, a killed client's
#    wedged session can only be cleared by restarting Firefox (see "one session" below):
firefox --remote-debugging-port 9223 --marionette --no-remote -profile /tmp/ff-attach-profile &

# 2. CLI: --connect implies --browser firefox, so it doesn't need to be passed too
bun run src/cli.ts --connect 9223 take_snapshot
cdp --connect 127.0.0.1:9223 take_snapshot          # host:port also works
cdp --connect ws://127.0.0.1:9223/session take_snapshot   # or the full ws:// URL
```

3. MCP client config: set the env var instead of a flag (the endpoint doesn't belong in `args`):

```json
{
  "mcpServers": {
    "cdp-toolkit": {
      "command": "npx",
      "args": ["-y", "cdp-toolkit"],
      "env": { "CDP_BROWSER": "firefox", "CDP_FIREFOX_ENDPOINT": "9223" }
    }
  }
}
```

`<endpoint>` accepts three spellings, all normalized to a ws URL: a bare port (`9223`), `host:port` (`127.0.0.1:9223`), or a full `ws://`/`wss://` URL. `--connect`/`CDP_FIREFOX_ENDPOINT` implies the Firefox backend on its own and errors against an explicit `--browser chrome`.

**On Linux, and over SSH to a remote host.** Attach is a plain loopback WebSocket, so it is byte-identical on every OS; only the *launch* half is platform-specific. On Linux the binary is `firefox` on `PATH` (or `/usr/bin/firefox`), and the same `--remote-debugging-port 9223 --marionette` opens the endpoint (keep `--marionette` for the orphan-recovery reason above). One catch worth stating plainly: if your everyday Firefox is already running, relaunching it with the flag just focuses the open window and opens no port (see "Attaching is not relaunching" below). To attach to your real logged-in profile, quit Firefox first and reopen it with the flag; to run beside your daily browser instead, use the separate `--no-remote -profile` instance shown above.

When Firefox runs on a different host than cdp-toolkit (a remote box, a container), its debug port binds to loopback *there*, so forward the port and attach to localhost:

```bash
ssh -L 9223:127.0.0.1:9223 you@the-box     # forward the remote debug port
cdp --connect 9223 take_snapshot           # then attach as if it were local
```

For Claude Code, register the MCP server with the endpoint in one line (the env var implies the Firefox backend):

```bash
claude mcp add cdp-toolkit -e CDP_FIREFOX_ENDPOINT=9223 -- npx -y cdp-toolkit
```

**Firefox allows only one active WebDriver BiDi session at a time.** A second `session.new` against the same endpoint fails outright while a first session is open. Disposing cleanly (the normal exit path — normal exit, `SIGINT`/`SIGTERM`, stdin close) sends `session.end` first, which frees the slot for the next process cross-process. When several cdp-toolkit processes attach to the **same** user Firefox endpoint, they now coordinate that single session slot through a file-based lease (a sibling of the tab-lease mechanism), so a collision no longer hard-wedges both sides:

- **Two genuinely live processes** are serialized rather than both wedging: the second waits up to `CDP_FIREFOX_SESSION_WAIT_MS` (default `10000`ms) for the slot to free, then returns a distinguishable, fast error naming the live holder — "Firefox's single WebDriver BiDi session on `<endpoint>` is held by a LIVE process `<label>` (pid N) … wait & retry, or point this server at a different endpoint/browser" — instead of hanging.
- **An orphaned session from a dead holder** — the classic wedge, a client `SIGKILL`ed or crashed without `session.end`, which Firefox does not reap on its own — is now **auto-recovered**: cdp-toolkit force-clears the orphaned session over the **Marionette side channel** (a blind `WebDriver:DeleteSession` on port `2828`, `CDP_FIREFOX_MARIONETTE_PORT`) **without** killing or restarting Firefox, then retries. This works **only** if that Firefox was launched with `--marionette` (verified against FF153: `--remote-debugging-port` alone does **not** start Marionette). When Marionette is absent it degrades to a clear, actionable error ("orphaned … could not be auto-cleared. Marionette recovery needs Firefox launched with `--marionette` …; otherwise restart Firefox") rather than the old dead-end.

This coordinates and recovers **around** Firefox's one-session limit; it does not remove it. Two live holders still cannot share the slot at once — one is served, the other waits or is told, by name, who holds it.

**Attaching is not relaunching.** The one thing that is genuinely impossible is handing a debug port to an *already-running* Firefox process after the fact: the `--remote-debugging-port` flag only takes effect on a process's original launch, so relaunching the `firefox` binary against a running instance hands off to it and exits silently, opening no port (verified against Firefox 153.0.3). That is a real, narrow limitation of the Firefox binary itself. It is not the same claim as "Firefox cannot be attached to" — a Firefox that was launched *with* the debug port open, whether by this toolkit or by your own hand, exposes a plain BiDi endpoint that any number of fresh clients can connect to later, which is exactly what `--connect`/`CDP_FIREFOX_ENDPOINT` does.

**Tool availability is filtered per backend**, not per call: `tools/list` (MCP) and `--list`/`--capabilities` (CLI) only ever advertise a tool the selected browser can actually run. A tool is never listed and then thrown from at call time. On the MCP server a second filter composes on top: a tool is listed only when the backend can run it *and* its group is in the startup profile — backend availability first, `CDP_TOOL_PROFILE` second (see [Progressive disclosure](#progressive-disclosure)). Under Firefox, six capability areas are absent because Firefox 153's BiDi implementation has no equivalent domain:

- `performance_start_trace`, `performance_stop_trace`, `performance_analyze_insight`, `performance_trace` (needs `trace.performance`)
- `take_heapsnapshot` (needs `heap.snapshot`)
- `lighthouse_audit` (needs `audit.lighthouse`)
- `start_screen_recording`, `stop_screen_recording` (needs `capture.screencast`): BiDi has no streamed-frame primitive at all, only the one-shot `browsingContext.captureScreenshot`.
- `dispatch_mouse` (needs `input.raw`): the raw move/down/up primitive is a direct `Input.dispatchMouseEvent` wrapper with no BiDi analogue.
- `wait_for_download`, `grant_permissions` (need `browser.downloads` / `browser.permissions`): both drive Chrome's `Browser.*` domain; WebDriver BiDi has no command to redirect a download or pre-grant a permission.

Everything else, including `mock_request`/`list_mocks`/`clear_mocks` (Firefox's `network.addIntercept` covers the same fake-backend use case as Chrome's `Fetch` domain), the `claim_page`/`release_page`/`list_leases` lease group, and the new `scroll` tool (Chrome dispatches `Input.dispatchMouseEvent{type:'mouseWheel'}`, Firefox uses BiDi's `wheel` input source — both live-verified), is available under both backends: 34 of the 45 tools. Under `CDP_BROWSER=firefox` the MCP server's default (`full`) listing is therefore 35 entries — those 34 plus `describe_tool` — and a narrower `CDP_TOOL_PROFILE` trims it further, the profile filter applying after this backend filter. One asymmetry to know before expecting Chrome-style concurrency: the lease group fences *tabs* on both backends, but Firefox permits only **one BiDi session per browser instance**, so multiple agents under Firefox share and serialize on that single session (coordinated by the cross-process session lease above), not the independent concurrent sessions Chrome's unlimited CDP connections allow — see "Parallel tabs" below.

**Honest capability gaps, not oversold parity:**

- **No accessibility tree.** `take_snapshot` under Chrome reads a native a11y tree (`Accessibility.getFullAXTree`). Firefox 153's BiDi has no equivalent domain, so the Firefox snapshot is a DOM-heuristic walk that infers roles from tag/attribute conventions. It is good enough to find and click things; it is not a substitute for a real accessibility audit.
- **No atomic text insert.** Chrome's `fill`/`type_text` commit a value in one `Input.insertText` call. BiDi has no equivalent primitive, so Firefox always synthesizes real per-character keystrokes via `input.performActions` (one `<select>` exception: an exact-match value/index assignment, since typeahead-by-first-letter cannot reliably commit an arbitrary option).
- **Thin emulation.** Only viewport size/DPR and `userAgent` are applied. CPU throttling, media-feature emulation (e.g. `prefers-color-scheme`), and network-condition throttling are not available: Firefox 153 does not implement the underlying BiDi commands.
- **No tracing, heap snapshots, or Lighthouse.** See the capability list above; there is no BiDi equivalent for any of the three.
- **`locate.text` is not available** (Firefox 153's `browsingContext.locateNodes` rejects the `innerText` locator type as unsupported), unlike Chrome, which has it via `DOM.performSearch`.
- **No modifier-key clicks.** `click`'s `modifiers` (Alt/Control/Meta/Shift) is a Chrome-only *parameter* on an otherwise-universal tool: a non-empty `modifiers` array throws under `--browser firefox` rather than being silently dropped. A plain click still works on both backends.
- **No real HTML5 drag-and-drop mode.** `drag`'s `mode:"html5"` requires capability `input.html5Drag` and is rejected with a clear error under Firefox; `mode:"mouse"` (the default) works on both.
- **No per-capture screenshot `scale`; band tiling is a Chrome-only workaround Firefox has no use for.** Two *parameters* on an otherwise-universal tool, for two different reasons. `scale` (`screenshot.scale`) is a genuine protocol gap: `browsingContext.captureScreenshot` has no scale parameter at all, and the refusal points at `emulate {deviceScaleFactor}` + a scale-1 capture instead — Firefox captures are always 1x. `tile:true` (`screenshot.tile`) is **not** a Firefox gap: measured against Firefox 153.0.3, `take_screenshot --fullPage true` on a 20,000px-tall page returned one 1366×20000 PNG at scale 1 from a single BiDi `captureScreenshot(origin:"document")` call — verified complete top-to-bottom (a marker at y=0, a marker at y=20000, an unbroken ruler through the middle, no truncation). Chrome's banding exists solely to route around its 16384-device-px encode cap; Firefox has no such cap, so there is nothing for tiling to work around, and auto-tiling correctly never fires there — a Firefox `fullPage` capture is already the whole page in one shot, however long. **`renderWidth`/`renderHeight` (`screenshot.renderSize`) are available on both backends** — that one is not a gap.

## The tools (29 parity + 16 superset = 45)

This table is the **full-profile view** — all 45 tools, which is what `cdp --list` and the MCP server's default listing (`CDP_TOOL_PROFILE=full`) both show. They are partitioned into 13 static profile groups: `core` (12: list_pages, new_page, close_page, select_page, navigate_page, wait_for, take_snapshot, click, fill, type_text, evaluate_script, take_screenshot), `input` (7: hover, drag, scroll, dispatch_mouse, press_key, fill_form, upload_file), `cookies` (3: list/set/delete_cookies), `network` (2: list/get_network_request), `console` (2: list/get_console_message), `mocking` (3: mock_request, list_mocks, clear_mocks), `emulation` (2: emulate, resize_page), `performance` (6: the four trace tools, take_heapsnapshot, lighthouse_audit), `recording` (2: start/stop_screen_recording), `leases` (3: claim_page, release_page, list_leases), `permissions` (1: grant_permissions), `dialogs` (1: handle_dialog), `downloads` (1: wait_for_download). `CDP_TOOL_PROFILE=core` narrows the MCP listing to the first group; any group it leaves out stays callable by name. See [Progressive disclosure](#progressive-disclosure).

The 29 parity tools are 1:1 with `chrome-devtools-mcp`; the 16 superset tools (`performance_trace`, the `list_cookies`/`set_cookie`/`delete_cookies` cookie group, the `mock_request`/`list_mocks`/`clear_mocks` group, the `claim_page`/`release_page`/`list_leases` lease group, the `start_screen_recording`/`stop_screen_recording` screen-recording pair, `scroll`, `dispatch_mouse`, `wait_for_download`, and `grant_permissions`) are toolkit additions. Each row notes the underlying CDP method(s) and the precise parity gaps.

| MCP name | CDP method(s) | Parity notes / gaps |
|---|---|---|
| `list_pages` | `GET /json/list` | `all` flag also exposes worker/background targets; MCP lists only page tabs. Each row additionally carries `origin` (`agent` or `unknown`, never `human`) plus `label`/`createdAt` for tabs this toolkit created, and, for a tab under an active lease of this backend, a `lease:{label,pid,idleMs,expiresAt,stale}` field (unconditional on `probe`). `probe:true` pings each page-type target's renderer (one bounded 500ms `Runtime.evaluate`, never more) and adds `responsive:boolean` plus `humanActiveMs` where that round trip found human-attributed input; a wedged/unreachable tab reports `responsive:false`, never an error for the whole call. Under `CDP_REQUIRE_LEASE` also reaps abandoned agent tabs first (destructively, only once a lease is `CDP_REAP_GRACE_MS` past its TTL — see "Staleness" below), reporting closures in an additive `reaped` array. |
| `new_page` | `Target.createTarget` (+ lease file) | Returns `{targetId,url}`; does not await navigation (use `navigate_page`). `claim:true` also claims the new tab and returns a `lease` token (`label`/`ttlMs` optional). Under `CDP_REQUIRE_LEASE` the tab is claimed and a `lease` returned even without `claim:true`. |
| `close_page` | `Target.closeTarget` (+ lease file) | Reports `success:true` on the empty result newer Chromium returns. A successful close also releases that tab's lease; a failed close leaves it in place. |
| `select_page` | `Target.activateTarget` + selected-state file | Writes a flat-file selected target; `resolveTarget` does not read it, so `active` still means `index:0` unless a tool opts in. |
| `navigate_page` | `Page.navigate` / `Page.reload` + load events, or `history:'back'\|'forward'` (Chrome: `Page.getNavigationHistory` + `Page.navigateToHistoryEntry`; Firefox: `browsingContext.traverseHistory`) | Returns `{url,frameId,waitedFor}` (no auto-snapshot; a history move also returns `traversed:'back'\|'forward'`). `waitUntil` supports `load`/`domcontentloaded`. `reload:true` (+ `ignoreCache:true` for a hard reload). `url`/`reload`/`history` are mutually exclusive; going back from the first entry (or forward from the last) is an error naming the direction, never a silent no-op. Works on both backends. |
| `wait_for` | `Runtime.evaluate` (poll `innerText`) | Text-substring waiting only; throws on timeout rather than returning `{found:false}`. |
| `evaluate_script` | `Runtime.evaluate` / `callFunctionOn` | No live `page`/element handle; `args` are plain JSON. Main-world context only. Toolkit addition: optional `savePath` writes the value to a JSON file and keeps it out of the response entirely. If `expression` is missing/empty and the call instead carries `function`/`code`/`js`/`script`/`fn`/`body`, the error names the wrong key and points at `expression`. One of four tools that also accept `target: "worker:<substring>"` (Chrome only, capability `worker.targets`) to reach an MV3 extension's background service worker — see "Driving MV3 extensions" below. |
| `list_cookies` *(superset)* | `Network.getCookies` | Reads the target page's cookie store, httpOnly cookies included, which `document.cookie` and therefore `evaluate_script` cannot see. Page-scoped on purpose, not the browser-wide jar (`Storage.getCookies`), so it answers for the tab you named. Optional `domain`/`name` filters; optional `savePath` writes the array to a JSON file and returns `{path,bytes,count,target}` with no cookie value in the response. |
| `set_cookie` *(superset)* | `Network.setCookie` | Writes one cookie, httpOnly and secure ones included, which `document.cookie` cannot create. Either `url` or `domain` is required and the call is refused with an error when neither is given. Chrome's `success:false` refusal is raised as an error rather than reported as a write. Answers `{set:true,target}` and never echoes the value back. `path` is passed through as given, never defaulted. |
| `delete_cookies` *(superset)* | `Network.deleteCookies` | Removes the named cookie, httpOnly ones included. Requires `name` plus `url` or `domain`, so a name-only call cannot sweep the store; optional `path` narrows further. Answers `{deleted:true,target}` with no count, because neither protocol reports one; read `list_cookies` before and after for a real count. |
| `take_snapshot` | `Accessibility.getFullAXTree` | uid is the raw `backendDOMNodeId` (stateless, non-sequential). Full tree in one shot; frames flattened. `interactiveOnly` is a toolkit addition. |
| `click` | `Input.dispatchMouseEvent` | No implicit auto-wait/retry; resolves and acts once; re-snapshot between steps. `clickCount:3` triple-clicks (selects a paragraph/line in most editors). `modifiers` (Alt/Control/Meta/Shift) holds keys for the press and release, e.g. a shift-click — **Chrome-only param**: a non-empty array throws under `--browser firefox`. |
| `hover` | `Input.dispatchMouseEvent` (`mouseMoved`) | Same single-shot model as `click`. |
| `scroll` *(superset)* | Chrome: `Input.dispatchMouseEvent{type:'mouseWheel'}`; Firefox: BiDi's `wheel` input source | Anchor at `uid`/`selector`/`x`+`y`, or the viewport center if all three are omitted; an element anchor is scrolled into view first. At least one of `deltaX`/`deltaY` is required (positive `deltaY` scrolls down, positive `deltaX` scrolls right — wheel convention). Returns `{x,y,deltaX,deltaY,target}`. Works on both backends. |
| `drag` | Chrome: `Input.dispatchMouseEvent` (press→move→release), or `mode:"html5"`: `Input.setInterceptDrags` + `Input.dispatchDragEvent` | `mode:"mouse"` (default) sends a synthetic mouse drag; Chrome does turn this into a real HTML5 drag too, but which `dragenter`/`dragover`/`drop` events reach the page depends on where the interpolated pointer path lands — at the default `steps:2`, a standard HTML5 drop zone (`preventDefault` inside `dragover`) sees zero `dragover` events and refuses the drop. `mode:"html5"` replays the page's own drag data as `dragEnter`/`dragOver`/`drop` exactly at the destination, so it works regardless of pointer path — **Chrome-only** (`input.html5Drag`), rejected with a clear error under Firefox. `steps` (default 2) sets the interpolated-move count for mouse mode. Destination is `to:{uid\|selector\|x,y}` or a new `by:{dx,dy}` offset (sliders, map panning); exactly one of `to`/`by` is required. |
| `dispatch_mouse` *(superset)* | `Input.dispatchMouseEvent` (one event per call) | The raw primitive: dispatch exactly one `move`/`down`/`up` at absolute viewport coordinates (`x`/`y` required on every call — CDP has no notion of a "current pointer position"). Compose your own move/down/move/up sequences for anything a physical mouse can do that `click`/`drag`'s fixed sequences can't: canvas drag-painting, marquee/rubber-band selection, a custom-hit-testing widget. Takes the same `button`/`clickCount`/`modifiers` as `click`. **Chrome-only** (`input.raw`): absent from `tools/list` under `--browser firefox`, never present-and-throwing. |
| `fill` | `Input.insertText` | Atomic paste-like commit, not per-character keystrokes. |
| `fill_form` | per field: `callFunctionOn` + `insertText` | Array of `{uid|selector,value}`; same insertText caveat. |
| `type_text` | `Input.insertText` | Appends (does not clear first); insertText, not per-key. |
| `press_key` | `Input.dispatchKeyEvent` | Curated named-key table + single chars; not the full Puppeteer KeyInput enum. |
| `upload_file` | `DOM.setFileInputFiles` | Requires a resolvable `<input type=file>` (uid or selector). |
| `take_screenshot` | `Page.captureScreenshot` (+ `Page.getLayoutMetrics` on **every** capture) | Full-page uses `captureBeyondViewport` + a layout-metrics clip. `scale` (>0, ≤8, **Chrome-only**) multiplies output pixels for one capture: output px = `ceil(css × scale × devicePixelRatio)`, and the page is never told (`devicePixelRatio`/`innerWidth` are unmoved). `renderWidth`+`renderHeight` (**both backends**, required together) emulate a viewport for one capture and restore it after — media queries flip, so this is how you shoot a responsive page at 1920×1080 from a tab that isn't. Chrome cannot encode past **16384 device px per side** and does not refuse politely there, so past the cap the capture is taken as vertical bands and stitched losslessly into one PNG (`tile`, auto by default; `tiled`/`bands` on the result): a 140,982 CSS px page returns 2780×281964 px in 18 bands instead of hanging and wedging the tab. Banding is vertical only (an over-wide projection is refused, not split), PNG-only, and never with `returnBase64`; content the page loads only on real scroll renders blank past the first viewport. `width`/`height` are decoded from the encoded bytes and omitted when undecodable. |
| `start_screen_recording` *(superset)* | `Page.startScreencast` / `Page.screencastFrame` / `Page.screencastFrameAck` | **Toolkit addition; chrome-devtools-mcp has no screen-recording tool.** Opens a persistent per-target connection and spools frames to a ledger on disk; pairs with `stop_screen_recording` in the SAME process, for the same cross-process reason as `performance_start_trace`. ffmpeg is probed here so a missing encoder fails before a recording is captured. Chrome only: absent from `tools/list` under `--browser firefox` (needs `capture.screencast`, which BiDi has no primitive for). |
| `stop_screen_recording` *(superset)* | `Page.stopScreencast` (+ ffmpeg encode) | Assembles the spooled frames into an H.265 (`hevc_videotoolbox`, falling back to `h264_videotoolbox` → `libx265` → `libx264`) MP4 using per-frame durations from the capture ledger, coalesced onto ffmpeg's 40ms concat-demuxer grid. Returns `{path,bytes,durationMs,frameCount,encodedFrames,codec,encoder,width,height,droppedFrames,target}` (`frameCount` captured vs. `encodedFrames` in the video). On an ffmpeg failure the spool is kept and the exact re-run command is named in the error. |
| `emulate` | `Emulation.*` / `Network.emulateNetworkConditions` | Stateless: UA/CPU/media/network overrides reset when the per-call connection closes. No named device presets. |
| `resize_page` | `Emulation.setDeviceMetricsOverride` | Verifies via `window.innerWidth/innerHeight`. Override persists on the target. |
| `handle_dialog` | `Page.javascriptDialogOpening` / `handleJavaScriptDialog` | Caller arms first and triggers out-of-band (or `handleDialogForExpression` to trigger-and-handle atomically). Supports wait-for-next and auto-handle-for-N-ms. |
| `list_console_messages` | `Runtime`/`Log` events (+ `Page.reload`, or LISTEN for `durationMs` on a worker target) | `reload:true` records console+network into a unique per-capture file; default read returns the latest. Args flattened best-effort. Accepts `target: "worker:<substring>"` (Chrome only) to capture an MV3 service worker's `console.log` — see "Driving MV3 extensions" below. |
| `get_console_message` | reads the shared "latest" buffer | Index into the latest capture; throws if out of range. Resolves a worker-keyed buffer too, but is deliberately not advertised as worker-capable (see CHANGELOG 1.9.1). |
| `list_network_requests` | `Network.*` events (+ `Page.reload`, or LISTEN for `durationMs` on a worker target) | Correlated rows from the per-capture buffer; redirect chains collapse to the first row. No timing breakdown / POST data. Accepts `target: "worker:<substring>"` (Chrome only) to capture the requests an MV3 service worker itself makes — see "Driving MV3 extensions" below. |
| `get_network_request` | above + `Network.getResponseBody` | Bodies only via a fresh capture (CDP serves bodies from the live session); `includeBody` matches by **url**. Worker-capable, same as `list_network_requests`. |
| `performance_start_trace` | `Tracing.start` / `dataCollected` | Works ONLY within one process; a live trace buffer is bound to its connection. Use `performance_trace` for robustness. |
| `performance_stop_trace` | `Tracing.end` / `tracingComplete` | Must run in the SAME process as `performance_start_trace`; throws a clear error otherwise. |
| `performance_analyze_insight` | parses a trace JSON file | A **CDP-native approximation** of the MCP insight analyzer (FCP/LCP/CLS/TBT/long-tasks); close but not byte-identical. Requires an explicit `tracePath`. |
| `take_heapsnapshot` | `HeapProfiler.takeHeapSnapshot` | Returns `{path,bytes,chunks,target}`; does not parse the snapshot (load the `.heapsnapshot` in the DevTools Memory panel). |
| `lighthouse_audit` | **none (non-CDP)**, spawns `npx --yes lighthouse …` | The toolkit's sole non-CDP tool. Defaults to the desktop preset. Returns numeric category scores (full report on disk). |
| `performance_trace` *(superset)* | `Tracing.*` (+ `Page.reload`) | **Toolkit convenience.** A robust single-call trace: start → optional reload → capture for `durationMs` → end → write the trace JSON → return `{path,bytes,events,metrics}`. Preferred over the `start`/`stop` pair (CDP tracing is browser-global and bound to one connection). |
| `mock_request` *(superset)* | `Fetch.*` (+ `Page.reload`) | **A fake backend.** Registers a rule on a target's persistent session: fulfill with a canned response, fail, or continue (with optional `delayMs`/`failRate`). Persists across reloads until `clear_mocks`. Request-stage only. Cached requests aren't intercepted (use `reload:true`). |
| `list_mocks` *(superset)* | `Runtime.evaluate` (liveness probe) | Lists active mock sessions with rules + hit counts; prunes sessions whose tab closed. |
| `clear_mocks` *(superset)* | `Fetch.disable` | Tears down the resolved target's mock session (or all with `all:true`). |
| `claim_page` *(superset)* | `Target.createTarget` + lease file | Opens a fresh tab and claims it (no `target`/`targetId`), or takes over a tab that is already open (`target`, any selector, or the exact-id `targetId`) and returns an opaque lease token plus `opened` (true only when this call created the tab). Never steals a tab another live process holds. Also returns `humanActiveMs` (ms since input this server did not dispatch; `null` means no data, never "no human") and, on a takeover of a tab a human used within the last 30s, a `contention` warning — the claim is never refused for it. MCP only; the CLI refuses it. The `describe_tool` meta-tool is likewise MCP-only. |
| `release_page` *(superset)* | lease file | Gives a lease back via `lease` (the token) or `target` (a selector, for a lease the gate auto-acquired and so never handed out a token for). Idempotent. Closes the tab by default when this toolkit's creation ledger says it opened it; leaves a merely-claimed tab open. Override either way with `close`. |
| `list_leases` *(superset)* | lease file | Who holds what, with pid liveness and reclaimability, plus computed `idleMs`/`expiresAt` and, where the tab's beacon answers, `humanActiveMs` (absent, not null, when there's no answer). Needs no token; never returns the nonce. A lease file that could not be read or parsed is reported as an `unreadable` row instead of being skipped (with `idleMs`/`expiresAt` omitted). Under `CDP_REQUIRE_LEASE` also reaps abandoned agent tabs, reporting closures in an additive `reaped` array. |
| `wait_for_download` *(superset)* | `Browser.setDownloadBehavior` + `Browser.downloadWillBegin`/`downloadProgress` on a standing browser-endpoint connection | Waits for a download to finish and returns it as a real file on disk: `{path,suggestedFilename,bytes,url,target}`. **Ordering rule, not optional:** call `wait_for_download{arm:true}` *before* the click that starts the download, then click, then call `wait_for_download` again to collect it — arming this late is not a preference, it's because Chrome reverts the download-behavior override the instant the arming client disconnects, and denies an unarmed download outright. **Browser-global side effect:** while armed, *every* download in the browser is redirected into the toolkit's downloads directory. **MCP-server only:** the arm lives on a connection this server process holds open; the one-shot CLI's connection dies with the process, so nothing is captured there. Chrome-only (`browser.downloads`). |
| `grant_permissions` *(superset)* | `Browser.grantPermissions` / `Browser.resetPermissions` on the same standing connection | Grants permissions (`geolocation`, `notifications`, `clipboardReadWrite`, ...) for an origin up front, so a page doesn't show a prompt no agent can click. Keyed by **origin**, not tab — every tab on that origin is affected, including ones opened later. `reset:true` clears this server's previous grants first (or instead); note CDP's reset is not origin-scoped, so it clears every origin at once. Same MCP-server-only reasoning as `wait_for_download`: Chrome discards the grant the moment the granting connection closes. Chrome-only (`browser.permissions`). |

## Driving MV3 extensions

An MV3 extension's logic lives in a background **service worker**, not a page, so `chrome.storage.local`, `chrome.runtime`, and everything else the extension owns is unreachable through a page-typed selector. Four tools accept `target: "worker:<substring>"` (Chrome only, capability `worker.targets`) — `evaluate_script`, and, as of 1.9.1, `list_network_requests`, `get_network_request`, and `list_console_messages` — any substring of the worker's url, so `worker:<extension-id>` and `worker:background.js` both work:

```json
{"tool": "evaluate_script", "arguments": {"target": "worker:ekgaohljhieodkfggjkfgmmamfpngdhn", "expression": "chrome.storage.local.get()", "args": []}}
```

A few facts worth knowing before you reach for it, all measured against a real browser rather than assumed:

- **An idle MV3 worker is evicted within seconds of its last activity, and once evicted it is invisible to every target listing** — not "stopped and still visible," genuinely absent from `/json/list` and `Target.getTargets` under any filter. So a `worker:` miss almost always means "asleep," not "wrong id," and the error says so.
- **`wake` defaults to `true`:** a selector that matches nothing, or a known-but-stopped worker, is started for you first, then re-resolved. Pass `wake:false` to fail fast instead — the error then teaches the eviction fact rather than reading like a typo.
- **A wake is verified by re-reading the target list, never by the start command's own result** — Chrome's start command reports success even for a scope that doesn't exist, so nothing here trusts it.
- **Worker targets bypass the lease gate entirely.** `claim_page`/strict mode never mint a lease for a worker-targeted call, on any of the four tools; a worker id is Chrome's to create and destroy, not this toolkit's to fence.
- **If you're loading your own unpacked extension for testing, `--load-extension` does nothing on recent Chrome**, even with the documented unblock flag. Use `Extensions.loadUnpacked` over CDP instead (what this toolkit's own extension smoke does).
- **The extension id is a hash of the unpacked extension's absolute path**, so it's deterministic across loads from the same directory but differs from the id a packed/store install would get — don't hardcode an id copied from a different machine's path.
- **Before deep-debugging something that looks like "the toolkit can't see it," check you're driving the build you think you are:** `evaluate_script {target:"worker:<id>", expression:"chrome.runtime.getManifest().version"}`. Chrome keeps serving a stale unpacked build's worker until you explicitly reload the extension, and an outdated loaded build mimics every symptom below.

### Watching what a worker sends and logs (1.9.1)

`list_network_requests`, `get_network_request`, and `list_console_messages` record a worker the same way they record a page — over the worker's own CDP session, the same `Network`/`Runtime` domains, the same `get_*` follow-up for bodies — with one difference: a worker capture can't be driven by reload. Measured against Chrome 151.0.7922.109: `Page.enable`/`Page.reload` don't exist on a worker session (`-32601 'Page.enable' wasn't found`), so a worker capture LISTENS for `durationMs` instead of reloading; `Network.requestWillBeSent`/`responseReceived`/`loadingFinished` and `Runtime.consoleAPICalled` all arrive on that same session, and `Network.getResponseBody` serves the body, exactly like a page capture.

```json
{"tool": "list_network_requests", "arguments": {"target": "worker:ekgaohljhieodkfggjkfgmmamfpngdhn", "reload": true, "durationMs": 5000}}
```

- **Recording a worker keeps it alive for the length of the capture — a documented side effect, not a bug.** A held CDP session suppresses MV3 idle eviction (measured: alive and still emitting events at 60s held; evicted ~30s after the recorder detaches). Watch a worker and Chrome won't put it to sleep out from under you until you stop.
- **`wake` (default `true` on a capture) is refused on a read-only call and on a bare target id**, rather than accepted and quietly doing nothing useful. A worker that idle-evicts and restarts comes back under a brand-new target id (measured: re-minted on every restart), and the buffer is keyed by id, so waking on a *read* would hand back a live worker with an empty buffer — "0 requests" for a capture that really did record some, a zero shaped like an answer. Re-run with `reload:true` to record a fresh capture instead.
- **A worker woken by the capture has already run its top-level code by the time the recorder attaches**, so a fetch it makes at startup can be missed. Trigger the request you want to observe (a message, an alarm) after the capture starts rather than relying on the worker's own boot-time fetch.
- **A `self.fetch` monkeypatch via `evaluate_script` won't reliably intercept a worker's requests, and reading a module-scoped value from `evaluate_script` won't reliably work either — both for ordinary JavaScript reasons, not a service-worker-specific one.** A value bound at module top level is not visible from `evaluate_script`'s global scope (plain lexical scoping, identical in a page); assigning `self.fetch` cannot rebind a `fetch` reference the module already captured (closure semantics, also identical in a page). `list_network_requests`/`get_network_request` observe the `Network` domain on the worker's own session directly and need neither.

`worker:` is deliberately absent everywhere else — `close_page`/`select_page`/`release_page` and `claim_page`'s `target` stay page-only, refusing the arm by name rather than silently missing, and Firefox refuses it with a capability error (`worker.targets`), since WebDriver BiDi has no extension-service-worker target to map onto.

## Parallel tabs: many agents, one browser

Two agents pointed at the same Chrome both resolve `target: active` to whatever tab the human last focused. Nothing errors. Each one gets plausible, well-formed output from the wrong page: a snapshot of someone else's form, a fill that lands in someone else's field. A crash gets caught; a silent wrong-tab success does not.

`claim_page` fixes that by handing you an opaque lease token for one tab:

```json
{"tool": "claim_page", "arguments": {"url": "https://example.com", "label": "checkout-agent"}}
```

```json
{"lease": "chrome:1A2B...:0f3c...", "targetId": "1A2B...", "url": "https://example.com", "label": "checkout-agent", "ttlMs": 900000, "expiresAt": 1754400000000}
```

Pass that token as `lease` on every later call against the tab. `new_page` with `claim: true` does the open-and-claim in one call. `release_page` gives it back and, by default, closes the tab if this toolkit opened it (see "Close on release" below). `list_leases` shows who holds what.

**Firefox: the ceiling is one BiDi session per browser instance.** The `claim_page`/`release_page`/`list_leases` tab-lease group works under both backends, but a real asymmetry sits underneath it. Chrome accepts unlimited concurrent CDP connections, so "many agents, one browser" there means many genuinely independent sessions. Firefox permits only **one** WebDriver BiDi session per browser instance (see [Firefox](#firefox-webdriver-bidi)), so under Firefox "many agents, one browser" means many agents *sharing and serialized on that single session* — coordinated by the cross-process session lease, not running as independent sessions. Expect Chrome-style multi-session concurrency on Chrome only; on Firefox the tabs are still leasable, but the session beneath them is a single shared slot.

**Opt in, and only ever a refusal — this is the default, with `CDP_REQUIRE_LEASE` unset.** A tab nobody claimed behaves exactly as it did before. Omitting `lease` is identical to pre-1.2 behavior in every respect: no default changed, no return shape changed, no previously legal call now needs a new argument. This is why it was 1.2 and not 2.0.

### Strict mode: `CDP_REQUIRE_LEASE`

The default above is opt-in on purpose, but opt-in means an agent that never learns the protocol never gets the protection either. `CDP_REQUIRE_LEASE=1` (also `true`/`yes`/`on`, case-insensitively), read only by a long-lived MCP server process (never the CLI, see below), turns holding a lease from optional into mandatory: any call that resolves to a tab nobody holds now **acquires** a lease on it instead of driving it lease-free, so "you cannot drive a tab you do not hold" becomes literally true rather than a convention an agent can forget. `new_page` claims the tab it just created even without `claim:true`, for the same reason: a tab nobody holds the instant it exists is a tab the very next call would have to auto-acquire anyway.

That auto-acquired lease is a weaker tier than an explicit one, and the difference is what keeps strict mode ergonomic instead of a second protocol to learn:

- **Auto** (acquired by the gate, or by `new_page` without `claim:true`): owned by a *process*. Any later call from the same pid passes with no `lease` argument at all; only another process is refused.
- **Explicit** (`claim_page`, or `new_page{claim:true}`): still demands its token on every call, even from the process that claimed it. This is how one subagent fences a tab off from sibling subagents that share its pid, since a Claude Code session's subagents all run inside one MCP server process.

An unleased tab under strict mode is still refused to a different process exactly as under the default: the tab's whole selector surface (`active`, no target, `index:N`, `url:`, `title:`, `label:`, a bare targetId) all resolve through the same gate, so there is no selector form that quietly bypasses acquisition. Turning `CDP_REQUIRE_LEASE` off never locks a process out of leases it already holds: the pid-only check on an auto lease is not itself gated on the flag, only the *acquiring* is.

**Strict mode is MCP-only, unconditionally, not by convention.** The CLI never reads `CDP_REQUIRE_LEASE` as true no matter how it is set, because a CLI invocation is one process per call: a lease it auto-acquired would be reclaimable by the dead-pid rule the instant that process exited, which is a worse position than no lease at all, and reap (below) would then read that instantly-dead-pid record as an abandoned agent tab and could close it the next time anything lists pages.

**What can newly fail.** Any call that resolves to a leased tab without presenting that tab's token is refused, naming the tab, its url, and the label of whoever holds it. That is every selector form, not one of them: `active` or no target at all, `index:N`, `url:<substring>`, `title:<substring>`, `label:<name>`, and a bare targetId all reach the same check. The case worth singling out is `active` (or no target) against a leased tab index 0, because there you did not name the tab and before 1.2 the call silently succeeded against whatever tab happened to be first. That refusal is the point of the feature, and it is called out here rather than left to be discovered.

**Reclamation.** A lease is reclaimable when its owning process is gone, or when `lastUsedAt` is older than `ttlMs` (default 15 minutes, `CDP_LEASE_TTL_MS`). Those two are the whole list. A lease whose tab is no longer open is *reported* by `list_leases` as `target-gone`, which is useful to see, but that report is not what frees it: such a record is freed by the same two rules as any other, whichever lands first. Every checked call refreshes `lastUsedAt`, so an agent that is working never expires and no heartbeat is needed. Reclaiming mints a fresh nonce, which invalidates the previous owner's token: a stalled agent that comes back cannot keep driving a tab someone else now owns. This applies equally to an auto lease and an explicit one; the tier only changes who may use the lease without a token, never how or when it goes stale.

### Taking over a tab that is already open

`claim_page` had one mode before: open a fresh tab (or claim an exact `targetId`) and return a token for it. Neither covers "work in the tab I already have open", the ordinary shape of a human handing an agent a task in a tab that is already sitting in front of them, since a human does not have a targetId to hand over. `target` is that path — the toolkit's whole selector grammar, resolved against the tab that is actually there:

```json
{"tool": "claim_page", "arguments": {"target": "active", "label": "continuing-agent"}}
```

```json
{"lease": "chrome:9F1A...:7b2e...", "targetId": "9F1A...", "url": "https://app.example.com/inbox", "label": "continuing-agent", "ttlMs": 900000, "expiresAt": 1754400000000, "opened": false}
```

`opened: false` says this call took over a tab rather than creating one; it is `true` only from the fresh-tab mode. That flag matters because `release_page` reads the same distinction: a tab `claim_page{target}` took over has no creation-ledger record (this toolkit did not open it), so releasing it always leaves it open, regardless of `close`. Two safety properties hold without exception: **a selector that matches nothing is an error, never a silently substituted new tab** (`target` given means the fresh-tab branch is unreachable), and **there is no force or steal** — a tab another live process holds, auto-acquired or explicit, is refused with the same conflict error `claim_page` has always thrown, naming the holder. The tab this exists to take over is a human's, and a human's tab carries no lease to begin with.

### Close on release

`release_page` used to only ever give the lease back. It now also closes the tab, **by default and without any flag**, when the creation ledger says this toolkit opened it — the one thing a caller sees change without setting `CDP_REQUIRE_LEASE` at all:

- A tab `new_page` or `claim_page` created is closed on release.
- A tab that was already open, and merely claimed (`claim_page{targetId}` or `claim_page{target}`), is released and left exactly alone.
- `close: false` opts a call out of closing; `close: true` forces a close either way.
- A release that did not actually happen — already released, reclaimed, or expired — never closes anything, because the tab may belong to a different agent by then. That is the one rule here that is a safety property, not a convenience, and it holds regardless of `close`.

Under `CDP_REQUIRE_LEASE`, `release_page{target}` is how you give back a lease the gate acquired for you automatically, since that path never hands out a token to pass to `lease`.

### Reap: abandoned agent tabs get closed on read

`release_page` closes a tab an agent gives back; it does nothing for a tab whose agent crashed, was killed, or simply stopped calling; a timeout ending an agent is more common than a clean shutdown. Under `CDP_REQUIRE_LEASE`, `list_pages` and `list_leases` reap first: a tab is closed only when **all four** hold — its lease is for the browser being listed and is actually readable (an `unreadable` row is never touched), the lease is stale for `dead-pid` or `expired` (never `target-gone`, already closed, or a healthy lease), the target is still genuinely open, and **the toolkit both opened the tab and leased it**. That last condition is the one that matters most: an agent-created tab with no lease at all is never reaped, because that is exactly what `new_page` produces for a caller who never touches leases, and closing those would be data loss dressed as cleanup. Closed tabs are reported in an additive `reaped` array (`{targetId, label, reason}`), present only when something actually closed, so the common-case response shape is unchanged; a close that fails is silently left for the next read to retry rather than reported as done. Reap is strict-mode only, for the same reason auto-acquire is: outside a long-lived process, a dead-pid record proves nothing about abandonment.

**Reclaimable and destroyed are two different moments, on purpose (`CDP_REAP_GRACE_MS`).** A lease reads `stale`/reclaimable in `list_leases` the instant its `ttlMs` elapses — cheap and reversible, since another agent may simply take it over. Reap's *close*, the destructive half, waits longer: an `expired` lease only qualifies for reap once `now - lastUsedAt > ttlMs + CDP_REAP_GRACE_MS` (default `2700000`, 45 minutes, so 60 minutes total after last use). An agent 20 minutes into a build between tool calls does not come back to find its tab destroyed just because another agent could, in principle, have reclaimed the lease. `dead-pid` is unaffected by grace and reaps immediately — that process is never coming back, so there is nothing to wait for.

**Unreadable lease files.** A row in `list_leases` can carry `unreadable`, holding the errno (for example `EACCES`) or `"unparseable"`, when the lease file exists but could not be read or parsed. On such a row `label`, `pid`, `createdAt`, `lastUsedAt`, and `ttlMs` are zero placeholders, not real values, since they live inside the file that could not be read. `stale` is always `false` on that row, deliberately: `stale` is what a reader treats as free to take, and an unreadable lease must never read that way.

**Verifying it against a real browser.** `bun run lease:smoke` (`test/lease-smoke.ts`) is the end-to-end harness for this feature, and `bun test` cannot reach any of it: a lease is keyed on the claiming pid, so only a second genuinely separate OS process can collide with the first, and reap only ever fires from a long-lived process. It drives a REAL browser on `CDP_BASE` (default `http://127.0.0.1:9222`) and spawns real child OS processes to play a tokenless stranger, a doomed child that claims a tab and exits, and a corpse that exists only to donate a genuinely dead pid. Under the default (flag off): it asserts the owner can act, a tokenless stranger is refused with the `LeaseConflictError` type, `targetId` and `holder` intact and NOT coded `no-such-target`, the refusal actually prevented the side effect (proved by reading a marker back, not by the throw), a genuinely missing target still reports `no-such-target`, the stranger is admitted after `release_page`, and an orphaned lease from a real dead child is reclaimable with a fresh nonce. It then turns `CDP_REQUIRE_LEASE` on for the rest of the run and asserts: a second strict process with no token is refused the same way; an ordinary ungated call auto-acquires a lease, marked `auto` and owned by that pid; `release_page{target}` closes a tab this toolkit opened and leaves alone one with no creation record, even when explicitly claimed; and reap closes a tab with a genuinely dead-pid lease, names it in `reaped` with `reason:"dead-pid"`, and leaves every other tab the run opened untouched. A final scenario takes over a stand-in for a human's tab (open, unleased, no creation record) via `claim_page{target}`, drives it with the returned token, releases it, and confirms it is still open, then confirms a target that matches nothing is refused and opens no tab. It is safe to point at a browser with real tabs open: every tab it touches is one it opened itself, addressed only by its own target id, and it never calls `Browser.close`. It captures its own baseline tab listing at runtime and fails only if a tab that existed before the run went missing; tabs you open mid-run are ignored. Lease and origin files go to a private temp dir that is removed on exit, and reap — the single most destructive path exercised here — only ever considers a tab with both a lease record and an origin record in that private directory, which no pre-existing tab has.

### Staleness: is a human already using this tab?

`lastUsedAt` measures TOOLKIT calls only, so a tab a person has been typing in for ten minutes looks perfectly idle by that field — exactly the case that matters once `claim_page{target}` lets an agent take over a tab a human already has open. 1.8.0 adds an in-page activity beacon and surfaces what it sees, without ever refusing anything because of it.

**The beacon.** A capture-phase, passive listener on `pointerdown`/`mousedown`/`keydown`/`wheel`/`touchstart` records `window.__cdpToolkitLastInput = Date.now()`. It's injected at claim time on both `claim_page` modes and `new_page{claim:true}`. On Chrome, `Page.addScriptToEvaluateOnNewDocument` alone does not survive navigation under this toolkit's per-call connection lifetime: the registration dies the instant the installing connection closes, which is every tool call. So the driver holds one connection open per beaconed tab purely to keep the registration alive across navigations (bounded at 32 tabs, oldest-first eviction; an evicted tab still answers for input on its current document, only the next navigation's re-arm is lost). Firefox needs none of this — its BiDi session lives for the whole process, so a `script.addPreloadScript` registration survives navigation for free.

**Telling a person from the toolkit itself.** CDP-dispatched input is `isTrusted:true` too, so the beacon alone can't distinguish a human click from the toolkit's own — every input-dispatching call (`click`, `drag`, `scroll`, `fill`, `fill_form`, `type_text`, `press_key`, `dispatch_mouse`) writes through one dispatch-log choke point, and a beacon timestamp counts as human only when it postdates the toolkit's own last dispatch on that tab by more than 1500ms. Known blind spots: input inside a cross-origin iframe is invisible to it, and a *second* MCP server process's dispatches read as human to this one.

**Surfacing.** `claim_page` and `list_leases` both return `humanActiveMs` — milliseconds since input this server did not dispatch. **`null` (or an absent field) means NO DATA — no beacon on that tab yet, or every input on it was this server's own — it never means "no human."** On a `claim_page` takeover of a tab a human used within the last 30 seconds, the result also carries a `contention` warning string. **The claim is never refused for this**: taking over a person's tab is what takeover mode is for, so by the time you'd read the warning you already hold the lease and the tab is yours to drive — it just tells you that driving it now means fighting a live person for the keyboard and mouse, so you can open your own tab instead or ask first. `list_pages{probe:true}` adds a third read on top: one bounded (500ms) renderer ping per page-type target, annotating `responsive:boolean` (false on a timeout or a wedged tab, never an error for the whole call) and, where that same round trip found one, `humanActiveMs`.

### Which tab did an agent open? (`origin`)

A lease answers "who is *driving* this tab right now". It cannot answer "who *opened* it", and that second question outlives the first: the moment an agent releases, expires, or dies, its abandoned tab is indistinguishable from one you opened yourself. Diffing two `list_pages` snapshots does not settle it either, since a tab you opened a minute ago looks exactly like a stray agent tab.

So every tab this toolkit creates is written to a creation ledger, and `list_pages` reports it:

```json
{"id": "1A2B...", "url": "https://example.com", "title": "Example", "type": "page",
 "origin": "agent", "label": "checkout-agent", "createdAt": 1754400000000}
```

- `origin: "agent"` means cdp-toolkit created the tab, via `new_page` or via `claim_page` with no `targetId`. The row then also carries the creating `label` (the same value a lease would show, defaulting to `pid-<pid>`) and `createdAt`.
- `origin: "unknown"` means there is no creation record. **It never says `"human"`.** The toolkit cannot prove a person opened a tab: no record is equally consistent with a tab opened before the server started, a tab restored from a previous session, another tool driving the same Chrome, or a record that could not be written. `unknown` is the honest word, and reading it as "safe, a human opened this" is the one mistake this field exists to prevent.

**It outlives the lease, deliberately.** `release_page`, expiry, and reclamation all leave the record alone. Only the tab going away removes it: the ledger is reaped when it is read, dropping records for targets the browser no longer has, so it stays self-cleaning with nothing scheduled. Under `CDP_REQUIRE_LEASE`, the record is also what authorizes a *close*: `list_pages`/`list_leases` reap an abandoned agent's tab only when it has both this origin record and a stale (`dead-pid`/`expired`) lease, never on the origin record alone, and `release_page` (or reap) consults it to decide whether closing this specific tab is this toolkit's call to make. See "Reap" above.

**Claiming a tab you did not open records nothing.** `claim_page` with an explicit `targetId`, or with `target` (the takeover path), takes ownership of an existing tab without creating one; that tab keeps reporting `origin: "unknown"`, because provenance is not ownership. That is also why `release_page` leaves such a tab open no matter how it was claimed.

**Unreadable records.** If a target has a creation record that could not be read or parsed, its row reports `origin: "unknown"` plus `originUnreadable` (the errno, for example `EACCES`, or `"unparseable"`). Same principle as `list_leases`' `unreadable` rows: a broken record must never be indistinguishable from no record at all. A missing or unreadable ledger never fails `list_pages`; every page simply reports `unknown`.

**Backward compatible.** `id`, `url`, `title`, and `type` are unchanged. The provenance fields are purely additive.

**What this does not do.**

- No fan-out. Every call still names exactly one tab. An agent that wants several drives them a call at a time and holds a separate lease per tab; a single call acting on many tabs is a different feature and is not addressed.
- No isolation. Two leased tabs on one Chrome still share cookies, `localStorage`, and every other origin-scoped store. A lease is ownership of a tab, not isolation of the browser under it.
- No protection from humans. The lease is enforced against cdp-toolkit's own tool calls. It cannot stop someone clicking into the tab.
- Not for the CLI. A CLI invocation is one process per call, so a lease it claimed would be reclaimable immediately by the dead-pid rule. `claim_page` is refused there. CLI calls can still present a token minted by the MCP server with `--lease`. Strict mode (`CDP_REQUIRE_LEASE`) is likewise MCP-only and for the same underlying reason, doubled: an auto-acquired lease would be reclaimable on arrival, worse than no lease at all, and reap would then be free to read that instantly-dead-pid record as an abandoned tab and close it on the next listing.

## How it's built

```
src/
  client.ts          # CdpConnection, openPage/withPage/openBrowser, resolveTarget, timeouts
  types.ts           # Target, TargetSelector, Uid, CDP envelopes
  index.ts           # TOOLS registry (45) + re-exported client primitives
  cli.ts             # the Bun CLI
  mcp.ts             # stdio MCP server, dual-era (serveStdio): static cacheable tools/list
  version.ts         # the VERSION constant, single source of truth with package.json
  manifest.ts        # JSON Schemas advertised by the MCP server (one per tool)
  toolGroups.ts      # tool-to-group map + CDP_TOOL_PROFILE resolution (startup-only filter)
  toolDocs.ts        # full per-tool prose served on demand by describe_tool
  leases.ts          # lease records, staleness, reclamation, assertLeaseOk, CDP_REQUIRE_LEASE
  leases-tools.ts    # claim_page / release_page / list_leases
  origins.ts         # tab creation ledger: who OPENED a tab, outliving its lease
  reap.ts            # closes abandoned agent tabs on list_pages / list_leases (strict mode)
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
