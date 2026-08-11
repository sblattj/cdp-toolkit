---
name: using-cdp-toolkit
description: Use when driving Chrome (or Firefox) tabs from an AI agent through the cdp-toolkit MCP tools (mcp__cdp-toolkit__*) or its `cdp` CLI — opening and naming a target, reading/clicking/typing on a page, scrolling or dragging (incl. real HTML5 drag-and-drop), capturing a file download, granting a permission, claiming a tab so parallel agents don't collide (and knowing whether a human is already in it), mocking a backend, reading a secret without leaking it, screenshotting a page that is very long or needs another viewport/resolution, or when a call returns empty {}, reads the page too early, a leased-tab call is refused by name, or a tab is stuck at the size of a capture that never finished.
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

### Firefox: launch vs. attach

`--browser firefox` (or `CDP_BROWSER=firefox`) picks the Firefox/BiDi backend. By default it
**launches** a fresh throwaway-profile Firefox per session — fine for anonymous browsing, but a
login wall for anything that needs a real, already-authenticated session.

To drive a Firefox you already have logged in, **attach** instead: start that Firefox with
`--remote-debugging-port <port>` yourself, then pass `--connect <port|host:port|ws-url>` (or set
`CDP_FIREFOX_ENDPOINT`) — implies the Firefox backend on its own, no need to also pass
`--browser firefox`:

```bash
cdp --connect 9223 take_snapshot
CDP_FIREFOX_ENDPOINT=9223 cdp take_snapshot   # MCP config: set this as an env var instead
```

This toolkit never launches or kills a Firefox you attach to; it only opens and, on dispose,
ends the BiDi session (`session.end`). **Firefox allows only one active BiDi session at a time** —
a second attach against the same Firefox while a session is still open now fails fast with a
clear error (it used to hang) rather than colliding silently; if a prior client died without
disposing cleanly (e.g. was killed), close it or restart Firefox to free the slot.

## Target selectors

Every page-scoped tool takes `target`:

| Selector | Means |
|---|---|
| omitted / `active` | first page target (tab index 0) |
| `index:N` | Nth page target, 0-based |
| `url:<substr>` | first tab whose URL contains substr |
| `title:<substr>` | first tab whose title contains substr |
| `label:<name>` | the tab with exactly this label — checked against both tabs this toolkit opened and tabs claimed under that label, so it works even for a takeover with no creation record |
| `<32-hex targetId>` | that exact tab |

**Resolve by a `targetId` you created, or by the `label:` you gave it, never by `title:`/`url:` on a busy or shared browser** — a lookalike tab (staging copy, the human's own tab) matches `title:`/`url:` with no error and plausible output; `label:` is an exact match against a name only you assigned, so it can't collide with someone else's tab the way a substring can. See "Parallel agents."

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

**Wrong key name → the error names it.** If you pass `function`/`code`/`js`/`script`/`fn`/`body` instead of `expression`, the error says which of those you used and that the right key is `expression`.

## MV3 extension service workers: don't hand-roll raw CDP

An MV3 extension's logic lives in a background **service worker**, not a page — `chrome.storage.local`, `chrome.runtime`, and the worker's own globals are unreachable through any page-typed `target`. Don't reach for a raw `Target.attachToTarget`/`Runtime.evaluate` script to work around this: `evaluate_script`, `list_network_requests`, `get_network_request`, and `list_console_messages` all accept `target: "worker:<substring>"` directly (Chrome only, capability `worker.targets`), matching any substring of the worker's url — `worker:<extension-id>` or `worker:background.js` both work:

```
evaluate_script {target:"worker:ekgaohljhieodkfggjkfgmmamfpngdhn", expression:"chrome.storage.local.get()", args:[]}
```

- **An idle worker is evicted within seconds and then invisible to every target listing.** `wake` defaults to `true` on `evaluate_script` and on a capture (`reload:true`) of the three reader tools: a miss is started for you and re-resolved before failing. Pass `wake:false` to fail fast instead. `wake` is **refused**, not merely defaulted false, on a read of the three reader tools and on a bare worker target id — see the diagnostic flow below.
- **A worker-selected evaluate never touches the lease system** — no `claim_page`, no strict-mode auto-acquire, nothing to `release_page` afterward. There is no tab involved. Same for a worker-targeted network/console read or capture.
- **Firefox refuses `worker:` outright** (capability gap, not a bug) — extension service workers over WebDriver BiDi aren't a thing this backend can address.
- Testing your own unpacked extension: **`--load-extension` is a no-op on recent Chrome**, even with the unblock flag. Load it via `Extensions.loadUnpacked` over CDP instead.

### Diagnostic flow: watch a worker's outbound request end-to-end

Before assuming CDP "can't see" what your extension's background worker is doing, walk this order:

1. **Check you're driving the build you think you are.** `evaluate_script {target:"worker:<id>", expression:"chrome.runtime.getManifest().version"}`. Chrome keeps serving a stale unpacked build's worker until you explicitly reload the extension in `chrome://extensions`, and an outdated loaded build mimics every symptom below — rule it out first, it's one call.
2. **Don't monkeypatch `self.fetch` via `evaluate_script` to intercept the worker's requests, and don't expect a module-scoped value to show up in a plain `evaluate_script` read either.** Both fail for ordinary JavaScript reasons, identical in a page and in a worker: a value bound at module top level is not visible from `evaluate_script`'s global scope (plain lexical scoping), and assigning `self.fetch` cannot rebind a `fetch` reference the module already captured (closure semantics). The mechanism below needs neither a monkeypatch nor visibility into module state — it reads the `Network` domain directly.
3. **Capture with the Network domain instead:** `list_network_requests {target:"worker:<id>", reload:true, durationMs:5000}` (or `worker:<url-substring>` if you don't have the id), then trigger the request you want to see — a message or alarm the worker handles — *after* the capture starts. A worker capture LISTENS rather than reloading (`Page.reload` doesn't exist on a worker session), so nothing you trigger before the window opens will show up; a worker woken by the capture itself has already run its top-level code, so its own boot-time fetch can be missed the same way.
4. **`get_network_request`/`get_console_message` filter that same capture** by id/url once you have it — same read-path resolver, same worker-keyed buffer.
5. **Remember the capture keeps the worker alive while it runs**, and Chrome resumes evicting it the moment the capture stops — a documented side effect, not a leak.
6. **On a read (no `reload:true`) or a bare worker id, `wake` is refused, not defaulted false.** A restarted worker gets a brand-new target id, and the buffer is keyed by the old one, so waking on a read would hand back an empty capture disguised as an answer. Re-run with `reload:true` for a fresh one instead of expecting a stale id to wake into anything.

## Scroll, raw mouse, real drag

- `scroll {uid|selector|x+y, deltaX?, deltaY?}` — dispatches a wheel event; positive `deltaY` scrolls down, positive `deltaX` scrolls right. Omit the anchor to scroll the viewport. Works on both backends.
- `click`/`dispatch_mouse` take `modifiers: ["Alt"|"Control"|"Meta"|"Shift"]` (a shift-click, etc.) and `click` also takes `clickCount:3` for a triple-click. **`modifiers` is Chrome-only** — a non-empty array throws under `--browser firefox`.
- `dispatch_mouse {action:"move"|"down"|"up", x, y}` is the raw primitive, Chrome-only (absent under Firefox, not throwing). Compose your own move/down/move/up sequence for anything `click`/`drag` can't do directly: canvas drag-painting, marquee selection, a custom-hit-testing widget.
- `drag`'s default `mode:"mouse"` **can** trigger real HTML5 drag-and-drop (`draggable="true"` elements) — it is not a no-op there — but whether the drop is accepted depends on the interpolated pointer path landing on a `dragover`. If a drop you expect to work keeps failing silently (`dragstart` fires, `drop` doesn't), use `mode:"html5"` (Chrome-only): it replays the page's own drag data as `dragEnter`/`dragOver`/`drop` deterministically, independent of pointer path. `steps` (mouse mode) and `by:{dx,dy}` (offset drags: sliders, panning) are also available.

## Screenshots: the 16384 px wall, and which knob you actually want

**Take the plain screenshot first.** `take_screenshot {target}` and `{target, fullPage:true}` handle the long-page case by themselves as of 1.9.2: past Chrome's encode limit the capture is taken as vertical bands and stitched into one lossless PNG, and the result tells you it happened (`tiled:true`, `bands:18`). You do not pass `tile` to get that. Reach for a knob only when the default's answer is wrong for your purpose:

| Want | Argument | Not this |
|---|---|---|
| More pixels in the same layout (read small text, zoom in later) | `scale` (>0, ≤8, **Chrome only**) | not `renderWidth` — that reflows the page |
| The page as it looks at another viewport (mobile layout, desktop layout) | `renderWidth`+`renderHeight`, **required together** (both backends) | not `scale` — the page's layout does not change |
| A permanent viewport change for several calls | `emulate {width,height}` | not `renderWidth` — that lasts exactly one capture |
| Fail loudly instead of writing a 10 MB banded PNG | `tile:false` | not "capture and check the size" |

**The wall, and why it is worth knowing.** Chrome cannot encode an image past **16384 device px on either side**, and it does not refuse politely there: `Page.captureScreenshot` never answers, and `captureBeyondViewport` leaves the tab resized to the clip it was capturing, so every later screenshot on that tab times out too. Output px are `ceil(css × scale × devicePixelRatio)`, so on a ratio-2 display the cap lands at ~8192 CSS px per side. The toolkit measures the projection before every capture, so you get a refusal or bands rather than a hang — but the arithmetic is worth carrying, because it is what the refusals are telling you:

- `scale 3` on a 1390×3250 CSS page projects 8340×19500 and is refused, naming the largest scale that fits (2.52). Ask for less, or drop `fullPage`.
- A projected **width** past the cap is refused, not tiled — bands stack top to bottom because scanlines are the only unit a PNG can be concatenated on. Lower `scale`, narrow `renderWidth`, or clip to an element.
- A **narrow `renderWidth` reflows most documents taller**, which is the usual way a render-size capture hits the cap. 420 CSS px wide turned a 2880 px page into 10800.
- A banded capture is PNG-only and cannot `returnBase64`. Both are refused before any band is captured, so asking is cheap — but if you need base64, capture a region small enough for one shot.

**When NOT to reach for these:**

- **Don't pass `tile:true`.** It forces banding even when one shot would have fitted (it deliberately splits a fitting region in two). It exists so the band path is testable; auto already bands when banding is needed.
- **Don't use a screenshot to read text you could read.** `take_snapshot` or `evaluate_script` returning `innerText` costs a fraction of the tokens of a scaled PNG. `scale` is for pixels you will look at, not for text you want parsed.
- **Don't tile a lazy/virtualized page and trust it.** Bands past the real viewport render **blank** on any page that loads content on scroll (infinite lists, viewport-triggered images, virtualized grids): `captureBeyondViewport` does not trigger an `IntersectionObserver`, and this is not fixable in the stitcher. Pre-drive a real `scroll` pass (or disable virtualization) first, then capture. `tiled:true` in the result is your cue to think about this.
- **Don't reach for `renderWidth` when the tab should stay resized.** It restores the previous viewport on every exit path; if you want the next five calls to see a mobile layout, `emulate` once instead.

**If a tab is already wedged** (an older build, another tool, or a capture that timed out): `emulate --clearOverrides` does **not** fix it and will report success anyway — the renderer's *real* viewport is what the abandoned capture resized, so "clear to the real device" lands on the wrong size. `emulate {width, height}` masks it, and `navigate_page {reload:true}` actually clears it.

**Reading the result.** `width`/`height` are decoded from the bytes that were actually written, and are **absent** rather than guessed when the image cannot be decoded — an absent size means "undecodable", never "zero". `renderRestored:false` (with `renderRestoreError`) means the tab is still emulated and you have to fix it with `emulate`; it rides back on a *successful* capture, so do not skip reading it.

## Downloads and permissions need the long-lived MCP server

`wait_for_download` and `grant_permissions` are Chrome-only **and MCP-server-only** — under the one-shot CLI, the connection they need dies with the process before it could ever matter, so both throw or are absent there. Same category as `performance_start_trace`/`start_screen_recording`.

- **Arm before you click, not after.** `wait_for_download{arm:true}` first (returns immediately), then the click that triggers the download, then `wait_for_download` again to collect `{path,suggestedFilename,bytes,url}`. Arming late loses the download — Chrome denies an unarmed download outright, it doesn't just misplace the file.
- **Arming has a browser-global side effect:** every download in the browser, all tabs, gets redirected into the toolkit's downloads folder for as long as the server is armed.
- `grant_permissions {permissions:["geolocation",...], origin?, reset?}` answers a permission prompt before the page ever shows one. Grants are keyed by **origin**, not by tab.

## Leases: opt-in ownership for parallel agents

Two agents on one Chrome both resolve `active` to the human's focused tab and silently drive the wrong page. A **lease** fixes that — and by default it is **opt-in**:

- A tab **nobody** claimed behaves exactly as before; no `lease` argument needed.
- The lease is enforced against **other** callers, and against **yourself once you hold it**: after you claim a tab, **every** later call to that tab must pass the `lease` token, or it is refused by name — `active`, `index:N`, `url:`, `title:`, `label:`, and bare targetId all hit the same check.

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

`target` accepts the full selector grammar (`active | index:N | url:<substr> | title:<substr> | label:<name> | <targetId>`) and only ever resolves against a tab that already exists — it never opens one, so a selector that matches nothing is an error, not a silent new tab. The result's `opened:false` confirms it took over rather than created, and because of that, **`release_page` leaves it open when you are done, no matter what** — the toolkit did not create it, so it is not the toolkit's tab to close. It is still refused if another live agent already holds it; there is no steal.

**Check `humanActiveMs`/`contention` before you drive a taken-over tab.** The claim result (and every `list_leases` row) carries `humanActiveMs`: milliseconds since input the server itself did not dispatch. **`null`/absent means no data — never "no human"** (a fresh tab, or a tab whose every input was this server's own, look identical). If the tab was used within the last 30 seconds, the result also carries a `contention` warning — the claim still succeeds and you hold the lease, but driving it now means fighting a live person for the keyboard and mouse. Prefer your own tab, or ask first, when you see it.

### Strict mode: `CDP_REQUIRE_LEASE`

If the MCP server is running with `CDP_REQUIRE_LEASE` set, leasing stops being opt-in: any call you make against a tab nobody holds **quietly claims it for you** rather than refusing or waiting on you to call `claim_page` first, so most tool calls need no behavior change from you at all. Two things do change:

- **Call `release_page` when you are done with a tab you did not explicitly claim**, so it actually closes instead of sitting open forever. You were never handed a token for it (an auto-acquired lease doesn't mint one), so release it by selector: `release_page {target: "<the tab you were using>"}`.
- **Use an explicit `claim_page` when you need a tab protected from your own sibling subagents**, not just from other sessions. Everything auto-claimed is owned per-*process*, and a Claude Code session's subagents all share one MCP server process, so they pass each other's auto-claimed leases freely. `claim_page` (or `new_page{claim:true}`) demands its token on every later call, even from a sibling in the same process, which is what actually fences a tab off.

You cannot turn strict mode on or off yourself — it is an environment setting on the MCP server. If a call you expected to succeed lease-free instead comes back refused by another holder, someone else (a sibling subagent, most likely) already has that tab; `list_leases` shows who.

**Reclamation** — a lease is reclaimable only when its owning process is gone **or** `lastUsedAt` is older than `ttlMs` (default 15 min, `CDP_LEASE_TTL_MS`). Every checked call refreshes it, so a working agent never expires. Reclaiming mints a fresh nonce, invalidating the old token, so a stalled agent can't resume driving a reclaimed tab. **The CLI can't claim** (one process per call → instantly dead-pid, and strict mode never applies there either); it may still pass an MCP-minted token with `--lease`.

**Reclaimable ≠ destroyed.** An idle-past-TTL lease is reclaimable right away, but reap only destroys that tab an additional `CDP_REAP_GRACE_MS` later (default 45 min, 60 min total after last use) — a long gap between your calls isn't a race against your own tab getting closed out from under you. A `dead-pid` tab (the owning process is gone) is the exception: reaped immediately, no grace.

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
| run JS in an MV3 extension's service worker | `evaluate_script {target:"worker:<ext-id>"}` (chrome-only) |
| click / type / key / upload | `click` `type_text` `press_key` `upload_file` |
| scroll / raw mouse / drag | `scroll` / `dispatch_mouse` (chrome-only) / `drag` (`mode:"html5"` for real HTML5 DnD, chrome-only) |
| back / forward in history | `navigate_page {history:"back"\|"forward"}` |
| wait for / capture a download | `wait_for_download` (MCP-server-only, arm before you click) |
| pre-answer a permission prompt | `grant_permissions` (MCP-server-only) |
| screenshot | `take_screenshot` (`fullPage`, `uid`/`selector` clip; a page past Chrome's 16384 device px limit is auto-banded and stitched — `tiled`/`bands` on the result) |
| screenshot at more pixels / at another viewport | `take_screenshot {scale}` (chrome-only) / `{renderWidth,renderHeight}` (both, required together, restored after) |
| cookies (httpOnly incl.) | `list_cookies` / `set_cookie` / `delete_cookies` |
| console / network | `list_console_messages` / `list_network_requests` (`reload:true` to record fresh; also `target:"worker:<substring>"`, chrome-only) |
| claim / release / inspect a tab (+ is a human there?) | `claim_page` / `release_page` / `list_leases` (`humanActiveMs`/`contention`) |
| mock a backend | `mock_request` / `list_mocks` / `clear_mocks` |

## Common mistakes

- **Reading in the call right after a navigation/reload.** Race. Wait on a sentinel first.
- **Trusting `clicked:true` / `filled:true` / a returned value as proof.** It only means the command dispatched. Verify the outcome.
- **A bare arrow in `evaluate_script` returning `{}`.** You defined a function and never called it — use the IIFE form.
- **`title:`/`url:` to *find* a tab on a shared browser.** Matches a lookalike silently. Use a targetId you created, or `label:` a tab you claimed.
- **Hand-rolling raw CDP (`Target.attachToTarget` + `Runtime.evaluate`) to reach an MV3 extension's service worker.** Use `evaluate_script {target:"worker:<substring>"}` instead — it also handles idle-wake and lease-fencing for you.
- **Reusing a long-held targetId after a gap.** Tabs close/navigate/reorder; confirm `location.href` first, or open your own `new_page`.
- **`list_network_requests` returning nothing.** Without `reload:true` it reads a buffer nobody recorded — pass `reload:true`.
- **Claiming a tab then omitting the token later.** Every subsequent call to a leased tab needs `lease`, including from the same session.
- **Calling `wait_for_download` after the click, with no `arm:true` first.** The download is denied outright, not just misfiled — there is no file to recover afterward.
- **Assuming `drag`'s default mode never fires real HTML5 drag events.** It can and often does; the actual gap is a drop getting silently refused because of the pointer path. Reach for `mode:"html5"` when a drop keeps failing, not because mouse mode "doesn't do HTML5 DnD."
- **Passing `tile:true` to get a long page captured.** Auto already bands when banding is needed; `tile:true` forces bands even when one shot would have fitted. The only thing you ever need to pass for a long page is nothing.
- **Trusting a tiled capture of a lazy-loading or virtualized page.** Bands the real viewport never reached come back blank — `captureBeyondViewport` triggers no `IntersectionObserver`. Scroll the content in first.
- **Using `emulate --clearOverrides` to un-wedge a tab stuck at a capture's size.** It reports success and changes nothing (the *real* viewport was resized, not an override). Use `emulate {width,height}` to mask it, or a reload to actually clear it.
- **Reading `humanActiveMs: null` as "nobody's here."** It means no data — verify with the plain fact that you haven't seen a `contention` warning either, not by treating null as a green light.
