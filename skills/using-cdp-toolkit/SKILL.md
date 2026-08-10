---
name: using-cdp-toolkit
description: Use when driving Chrome (or Firefox) tabs from an AI agent through the cdp-toolkit MCP tools (mcp__cdp-toolkit__*) or its `cdp` CLI — opening and naming a target, reading/clicking/typing on a page, claiming a tab so parallel agents don't collide, mocking a backend, reading a secret without leaking it, or when a call returns empty {}, reads the page too early, or a leased-tab call is refused by name.
---

# Using cdp-toolkit

## Overview

cdp-toolkit drives the Chrome tab you **name**, over one raw DevTools-Protocol socket per call, with a bounded timeout on every command. It is *not* Puppeteer: there is **no auto-wait and no retry**. Every call fires once, reads the immediate result, and returns. A returned value means "this came back at that instant," never "the page finished reacting."

Two consequences drive everything below:

1. **You name one target per call.** Nothing broadcasts to all tabs.
2. **Nothing settles for you.** After anything asynchronous, you wait on a sentinel yourself before reading.

## Prerequisites

Chrome must be listening on the DevTools port (default `9222`, override with `CDP_BASE`):

```bash
open -a "Google Chrome" --args --remote-debugging-port=9222   # Linux: google-chrome --remote-debugging-port=9222
curl -s http://127.0.0.1:9222/json/version                    # smoke-check the port
```

If **every** call errors `Unable to connect`, the port is dead — Chrome was relaunched without the flag. Launch args are ignored on an already-running Chrome, so you must fully quit and relaunch.

## Target selectors

Every page-scoped tool takes `target`:

| Selector | Means |
|---|---|
| omitted / `active` | first page target (tab index 0) |
| `index:N` | Nth page target, 0-based |
| `url:<substr>` | first tab whose URL contains substr |
| `title:<substr>` | first tab whose title contains substr |
| `<32-hex targetId>` | that exact tab |

**Resolve by a `targetId` you created, never by `title:`/`url:` on a busy or shared browser** — a lookalike tab (staging copy, the human's own tab) matches with no error and plausible output. See "Parallel agents."

## The core loop: act, then wait on a sentinel

`navigate_page`, `new_page`, a click that triggers a route change, `mock_request({reload:true})` — all return before the page's own async work finishes. Do **not** read in the next call. Spend one cheap call waiting on something the async work itself produces:

- `wait_for({text})` — polls `innerText` for a substring (throws on timeout; matches the *rendered* case, so CSS `text-transform:uppercase` makes `Approvals` match as `APPROVALS`).
- `take_snapshot` again — uids shift after a re-render; a uid from before the render is stale.
- an `evaluate_script` returning a sentinel (`img.complete && img.naturalHeight>0`, a rendered row count).

Verify by that sentinel, **never** by the previous tool's return value.

## Elements: snapshot → uid → act

A `uid` **is** a CDP `backendDOMNodeId` (a raw number), so refs are stateless.

1. `take_snapshot` (add `interactiveOnly:true` to shrink) → an indented a11y tree; each line carries `[uid] role "name"`.
2. `click`/`hover`/`fill`/`type_text`/`press_key`/`upload_file` take `{uid}` **or** `{selector}` (CSS, plain — no `:has-text()` pseudo-selectors).

There is no implicit wait — re-`take_snapshot` between steps. `type_text`/`fill` commit via `Input.insertText` (an atomic paste, not per-key), which some framework-controlled inputs ignore; if a value shows but the form stays "empty," set it via the native value setter and dispatch `input`/`change`.

## evaluate_script: invoke, don't just define

The param is **`expression`** (a string). With **no `args`** it's evaluated as a raw expression, so a bare `() => {...}` returns the *function object* (`{}`) — it is never called. Wrap it:

```js
(() => { return document.title; })()          // no args → IIFE
(async () => { return await f(); })()          // async still needs the IIFE
(name) => { return find(name); }               // WITH args → bare literal, cdp calls it
```

An IIFE **plus** `args` throws ("does not evaluate to a function"). Empty `args:[]` counts as no args. Returns must be JSON-serializable (DOM nodes come back as a description string).

## Leases: opt-in ownership for parallel agents

Two agents on one Chrome both resolve `active` to the human's focused tab and silently drive the wrong page. A **lease** fixes that — and by default it is **opt-in**:

- A tab **nobody** claimed behaves exactly as before; no `lease` argument needed.
- The lease is enforced against **other** callers, and against **yourself once you hold it**: after you claim a tab, **every** later call to that tab must pass the `lease` token, or it is refused by name — `active`, `index:N`, `url:`, `title:`, and bare targetId all hit the same check.

```
claim_page {url?, label?}            → {lease, targetId, url, opened, ...}  (opens+claims, or claims an existing targetId)
claim_page {target, label?}          → {lease, targetId, url, opened:false} (TAKES OVER a tab already open — see below)
new_page {url, claim:true}           → {targetId, lease}                   (open+claim in one call)
<any tool> {target, lease}           → pass the token every time
release_page {lease}                 → give it back (idempotent)
release_page {target}                → give it back by selector, for a lease you were never handed a token for
list_leases                          → who holds what (needs no token; never returns the nonce)
```

**`release_page` closes the tab, by default, if this toolkit opened it.** A tab `claim_page` or `new_page` created is closed on release; a tab you merely claimed (`targetId` or `target`, see below) is released and left exactly as you found it. Pass `close:false` to release without closing an agent-created tab, or `close:true` to force a close either way.

### Working in a tab the human already has open

If the human says "use the tab I have open" / "continue in my browser" / points you at a specific tab, do **not** open a new one — take it over:

```
claim_page {target: "active", label: "continuing-agent"}     → claims whatever tab is in front of them
claim_page {target: "url:app.example.com", label: "..."}     → claims by url/title/index, same grammar as everywhere else
```

`target` accepts the full selector grammar (`active | index:N | url:<substr> | title:<substr> | <targetId>`) and only ever resolves against a tab that already exists — it never opens one, so a selector that matches nothing is an error, not a silent new tab. The result's `opened:false` confirms it took over rather than created, and because of that, **`release_page` leaves it open when you are done, no matter what** — the toolkit did not create it, so it is not the toolkit's tab to close. It is still refused if another live agent already holds it; there is no steal.

### Strict mode: `CDP_REQUIRE_LEASE`

If the MCP server is running with `CDP_REQUIRE_LEASE` set, leasing stops being opt-in: any call you make against a tab nobody holds **quietly claims it for you** rather than refusing or waiting on you to call `claim_page` first, so most tool calls need no behavior change from you at all. Two things do change:

- **Call `release_page` when you are done with a tab you did not explicitly claim**, so it actually closes instead of sitting open forever. You were never handed a token for it (an auto-acquired lease doesn't mint one), so release it by selector: `release_page {target: "<the tab you were using>"}`.
- **Use an explicit `claim_page` when you need a tab protected from your own sibling subagents**, not just from other sessions. Everything auto-claimed is owned per-*process*, and a Claude Code session's subagents all share one MCP server process, so they pass each other's auto-claimed leases freely. `claim_page` (or `new_page{claim:true}`) demands its token on every later call, even from a sibling in the same process, which is what actually fences a tab off.

You cannot turn strict mode on or off yourself — it is an environment setting on the MCP server. If a call you expected to succeed lease-free instead comes back refused by another holder, someone else (a sibling subagent, most likely) already has that tab; `list_leases` shows who.

**Reclamation** — a lease is reclaimable only when its owning process is gone **or** `lastUsedAt` is older than `ttlMs` (default 15 min, `CDP_LEASE_TTL_MS`). Every checked call refreshes it, so a working agent never expires. Reclaiming mints a fresh nonce, invalidating the old token, so a stalled agent can't resume driving a reclaimed tab. **The CLI can't claim** (one process per call → instantly dead-pid, and strict mode never applies there either); it may still pass an MCP-minted token with `--lease`.

**One browser, one writer per flow.** Don't run two seats driving the same Chrome concurrently unless each holds its own lease on its own tab.

## Provenance: `origin` on list_pages

`list_pages` tags each tab `origin: "agent"` (with the creating `label`) for tabs this toolkit opened, else `"unknown"`. It **never says `"human"`** — a released/expired agent tab is indistinguishable from one a person opened, so `"unknown"` is the honest word. Don't read `"unknown"` as "safe, a human opened this."

## Reading a secret without leaking it

A read that would return a credential takes `savePath`: the value is written to a JSON file and the response carries only `{path,bytes,type,target}` — the secret never enters the transcript.

```
evaluate_script {expression:"localStorage.getItem('auth')", savePath:"auth.json"}
list_cookies {name:"session", savePath:"cookies.json"}     # httpOnly cookies too, which document.cookie can't see
```

A broad `take_snapshot`/`innerText` dump on a credentials page serializes revealed values into the transcript — snapshot before expanding a secret panel, or read lengths/prefixes only.

## Network mocking: a fake backend

`mock_request` arms a persistent per-target interception session (fulfill / fail / continue, optional `delayMs`/`failRate`); mocks survive reloads and navigations until `clear_mocks`. Cached requests aren't intercepted — pass `reload:true` to apply-and-observe.

## Quick reference

| Need | Tool |
|---|---|
| list tabs (+ provenance) | `list_pages` |
| open / close / focus a tab | `new_page` / `close_page` / `select_page` |
| go to a URL / reload | `navigate_page` (`reload:true`, `ignoreCache:true`) |
| wait for text | `wait_for` |
| read the a11y tree | `take_snapshot` |
| run JS | `evaluate_script` |
| click / type / key / upload | `click` `type_text` `press_key` `upload_file` |
| screenshot | `take_screenshot` (`fullPage`, `uid`/`selector` clip) |
| cookies (httpOnly incl.) | `list_cookies` / `set_cookie` / `delete_cookies` |
| console / network | `list_console_messages` / `list_network_requests` (`reload:true` to record fresh) |
| claim / release / inspect a tab | `claim_page` / `release_page` / `list_leases` |
| mock a backend | `mock_request` / `list_mocks` / `clear_mocks` |

## Common mistakes

- **Reading in the call right after a navigation/reload.** Race. Wait on a sentinel first.
- **Trusting `clicked:true` / `filled:true` / a returned value as proof.** It only means the command dispatched. Verify the outcome.
- **A bare arrow in `evaluate_script` returning `{}`.** You defined a function and never called it — use the IIFE form.
- **`title:`/`url:` to *find* a tab on a shared browser.** Matches a lookalike silently. Use a targetId you created.
- **Reusing a long-held targetId after a gap.** Tabs close/navigate/reorder; confirm `location.href` first, or open your own `new_page`.
- **`list_network_requests` returning nothing.** Without `reload:true` it reads a buffer nobody recorded — pass `reload:true`.
- **Claiming a tab then omitting the token later.** Every subsequent call to a leased tab needs `lease`, including from the same session.
