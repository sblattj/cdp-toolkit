# Changelog

All notable changes to cdp-toolkit are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.9.1] - 2026-08-10

`list_network_requests`, `get_network_request`, and `list_console_messages` now
observe MV3 background service workers, not just pages: the outbound fetch a
worker makes to a real backend is a first-class capture target, not something
you have to fake with an `evaluate_script` monkeypatch. Tool count stays 45 —
the three tools grow a `worker:` arm, no new tool. One seat (N1) landed it,
every protocol claim below probed against a live Chrome 151 before being built
on.

### Added

- **The three console/network reader tools accept `target: "worker:<substring>"`
  or a bare worker target id**, alongside the page selectors they already took.
  Chrome only (capability `worker.targets`) — Firefox refuses the arm from its
  real capability set before launching a browser that could never have served
  the call. The allowlist that grants the arm, `WORKER_CAPABLE_TOOLS` in
  `src/workers.ts`, now names four tools (`evaluate_script` plus these three);
  it is the single source of truth for both the refusal messages and
  `test/manifest-grammar-drift.test.ts`'s exclusion property, so a fifth tool
  cannot silently advertise `worker:` without a deliberate edit here.

- **A worker capture LISTENS instead of reloading.** Measured on Chrome
  151.0.7922.109: `Network.enable` and `Runtime.consoleAPICalled` work
  identically on a direct worker session to how they work on a page — all four
  events the recorder persists (`requestWillBeSent`, `responseReceived`,
  `loadingFinished`, `loadingFailed`) arrive, and `Network.getResponseBody`
  serves the body — but `Page.enable`/`Page.reload` **do not exist** on a
  worker session (`-32601 'Page.enable' wasn't found`). A page capture is
  reload-driven; a worker capture cannot be, so it opens the worker's own CDP
  session and listens for `durationMs` instead. `captureWindow()`'s branch is
  keyed off the resolved target's type, not the selector's shape, so a bare
  worker id takes the listen path too.

- **Recording a worker keeps it alive for the length of the capture — a
  deliberate side effect, not a bug.** A held CDP session suppresses MV3 idle
  eviction; measured in both directions with the same polling loop so
  "stayed alive" isn't an artifact of how the poll works: with the recorder's
  session held, the worker is still present in `/json/list` and still emits a
  fresh `Network.requestWillBeSent` for a triggered fetch at t+60s; once the
  session detaches, the same worker idle-evicts within ~30s. Documented in the
  three tools' manifest descriptions and asserted in both directions by the
  live smoke, not left implicit.

- **`wake` (default `true` on a capture) is REFUSED on a read-only call and on
  a bare target id, rather than accepted and ignored.** Measured: a worker
  that idle-evicts and restarts comes back under a brand-new target id (probed
  restart: `C43F0A18...` → `1F7D3C59...` for the same extension). The recorder
  keys its buffer file by target id, so waking a worker on a *read* would hand
  back a live worker with an empty buffer — "0 requests" for a capture that
  really did record some, a zero shaped like an answer. A wake therefore only
  makes sense when a capture is being started, and only from a
  `worker:<substring>` selector, since an evicted worker's old id no longer
  exists to name. The refusal messages (`workerWakeMisuseMessage`,
  `workerBufferReadMissMessage` in `src/workers.ts`) teach the id-re-mint fact
  rather than just rejecting the argument.

- **Known limitation, stated rather than silently absent: a worker woken BY a
  capture has already run its top-level code by the time the recorder
  attaches**, so a fetch the worker makes at startup can be missed. Trigger
  the request you want to observe (a message, an alarm) after the capture
  starts rather than relying on the worker's own boot-time fetch. Fixing this
  needs `Target.setAutoAttach{waitForDebuggerOnStart}` on a held browser
  session, a different feature; the limitation is documented in
  `recorder.ts`'s header and in the three manifest descriptions instead.

- **`get_console_message` reads the same worker-keyed buffer (so its miss
  message matches what it reads) but is deliberately NOT in
  `WORKER_CAPABLE_TOOLS`** — it already resolved worker targets through the
  1.9.0 arm, routing it through the read-path resolver only sharpens its miss
  message; advertising it as worker-capable was out of scope, and the drift
  test pins the advertised list at four.

### Measured, not assumed — the protocol facts this release ships on

- **`Page.enable`/`Page.reload` are `-32601` on a worker session** — the
  single measurement that shapes the implementation: a worker window cannot
  be reload-driven, so it listens.
- **A held session suppresses MV3 idle eviction; detach restores it** —
  confirmed in both directions with the same polling loop, including a
  post-hold evaluate and a fresh `Network.requestWillBeSent` at t+60s, so
  "alive" means genuinely live, not a stale listing entry.
- **A worker's target id is re-minted on every restart, never stable** — this
  is why `wake` is refused on reads and on bare ids rather than silently doing
  the wrong thing.
- **Monkeypatching `self.fetch` via `evaluate_script` to intercept a worker's
  requests is structurally unreliable, and the reason is ordinary JS scoping,
  not a broken realm.** A module that captured a reference to `fetch` at
  import time keeps calling that reference; reassigning `self.fetch`
  afterward cannot rebind it (closure semantics — true of a page too, not
  SW-specific folklore). `Network`-domain recording observes what the code
  actually sends and needs neither a monkeypatch nor visibility into module
  state. (An earlier field report of "eval realm hides module state" was a
  misdiagnosis of an outdated loaded extension build, not a real capability
  gap — see the stale-build tip below.)

### Notes

- Tool count is unchanged at **45** — this release grew the `target` grammar
  on three existing tools, not the tool list.
- `docs/social-preview.html` and `docs/demo.tape` carry no version string and
  needed no re-render for this release.
- Before deep-debugging an extension that "the toolkit can't see": verify the
  loaded build is current with
  `evaluate_script {target:"worker:<id>", expression:"chrome.runtime.getManifest().version"}`.
  An outdated unpacked build left over from a prior load mimics every symptom
  in this release's "measured facts" section above.
- New tests: 20 in `test/worker-capture.test.ts`, 3 more in
  `test/manifest-grammar-drift.test.ts` (allowlist rescoped from an
  evaluate_script-only exclusion to the four-tool `WORKER_CAPABLE_TOOLS`
  allowlist), and new live scenarios in `test/extension-smoke.ts` covering the
  worker fetch/console capture, the eviction pair in both directions, and the
  capture-path wake (proven by the fixture's own start counter, `starts: 2 ->
  3`, never by `ServiceWorker.startWorker`'s result, which reports empty
  success even for a scope that doesn't exist) — 31/31 assertions, up from the
  1.9.0 baseline of 20.

## [1.9.0] - 2026-08-09

Four complaints from a field agent driving an MV3 extension, closed without adding
a tool: the surface grows inside `evaluate_script`, the `target` selector
grammar, and error DX. Tool count stays 45. Two seats landed sequentially —
W2 (`label:` + key-echo) first, W1 (worker targets + idle-wake) on top of it —
and every protocol assertion below was probed against a live Chrome 151 before
being built on, because five 1.8.0 premises were folklore that measured false.

### Added

- **`label:<name>` in the target-selector grammar, universal across every
  page-taking tool.** Resolves an exact label match against BOTH the origin
  ledger (tabs this toolkit created) and live lease records (a tab taken over
  and claimed with a label, which has no origin record) — so a tab you named
  is findable by that name regardless of which path put you in it. A miss
  enumerates the labels that DO exist, deduped across both sources; an
  ambiguity (the same label on two live targets) names both ids rather than
  silently picking the first. **The grammar turned out to have three
  independent copies** — `pickPage` (`src/shared-tools.ts`), `pickTarget`
  (`src/client.ts`, the one `evaluate_script`/`click`/`hover`/… actually call),
  and `pickContext` (`src/bidi/driver.ts`, Firefox) — a fact the live smoke
  caught immediately when `label:` worked in `claim_page` but not in
  `evaluate_script`. The lookup core is now one function, `resolveLiveLabel`
  in `src/origins.ts`, wired into all three call sites, each keeping its own
  error class. A new structural test, `test/manifest-grammar-drift.test.ts`,
  asserts every manifest description that names `title:` also names `label:`,
  so a fourth resolver copy (or a stale description) can't slip past review
  silently again.

- **Key-echo validation on `evaluate_script`.** When `expression` is missing
  or empty and the call instead carries `function`, `code`, `js`, `script`,
  `fn`, or `body`, the error names the wrong key by value and says the right
  one is `expression` — and, when the value looks like a function literal,
  that function literals go in `expression` with `args`. One line, saving the
  round trip the field complaint measured.

- **`evaluate_script` can now evaluate inside an MV3 extension's background
  SERVICE WORKER, not just a page — no raw-CDP escape hatch needed.** Pass
  `target: "worker:<extension-id>"` (or any substring of the worker's url,
  e.g. `worker:background.js`) and read `chrome.storage.local`,
  `chrome.runtime`, and the worker's own globals directly. Chrome-only
  (capability `worker.targets`) and accepted by `evaluate_script` alone —
  `worker:` is deliberately absent from `pickPage`'s page-only grammar
  (closing/selecting/releasing a worker is meaningless) and refused there by
  name, and a new drift-test arm asserts no OTHER tool's manifest description
  ever names `worker:<`, so a later sweep can't advertise a Chrome-only,
  one-tool selector as universal grammar. Firefox refuses the arm with a
  capability-gap error naming `worker.targets`, per ADR-001 — WebDriver BiDi
  has no extension-service-worker target concept to map onto.
  **`wake` (default `true`)** asks Chrome to start the worker first when the
  selector matches nothing or a known-but-stopped worker, then re-resolves;
  `wake:false` fails fast with an error that teaches the MV3 eviction fact
  instead of a bare "not found". Worker targets bypass the lease gate
  entirely (`assertLeaseOk` is skipped for a worker-typed resolution in
  `client.ts`): reap's "close the stale tab" is meaningless for a target
  Chrome starts and stops on its own, and strict mode auto-acquiring a lease
  per evaluate would mint a file keyed on an id that vanishes at the next
  idle — garbage the page-only reap set can never collect. The page-only id
  set reap and leases already keep (`ReapInput.livePageIds`) was left
  unmerged on purpose.

### Measured, not assumed — the protocol facts this release ships on

Every one of these was a hypothesis in the spec and a measurement against a
live Chrome 151.0.7922.109 before any line of feature code was written:

- **`evaluate_script` against a worker never needs a flattened browser
  session.** `/json/list` exposes a running service worker with its own
  `webSocketDebuggerUrl`, and a direct WebSocket connect + `Runtime.evaluate`
  with `awaitPromise` works there exactly as it does against a page — proven
  by `self.constructor.name === "ServiceWorkerGlobalScope"` in the same
  round trip. The feature rides the existing per-target connect path with no
  new connection model.
- **The "awaited value is lost over a flattened session" folklore is false on
  Chrome 151, measured anyway even though it turned out not to matter.**
  `Target.attachToTarget{flatten:true}` against the same worker returns the
  real awaited value too. **No warning was shipped for a loss that cannot be
  triggered.**
- **A stopped MV3 worker is invisible to every target listing — `/json/list`
  and `Target.getTargets` under any filter — so "no such worker" almost
  always means "idle-evicted," not "wrong id."** The only place a stopped
  worker is visible at all is the registration inventory
  `ServiceWorker.enable` pushes as events, which is why the miss/wake error
  text says so explicitly.
- **`ServiceWorker.enable`/`startWorker` do not exist on the browser
  endpoint** (`-32601 wasn't found`) — **they work on a flattened session over
  any page**, including a plain `about:blank` tab with no relationship to the
  extension. That's the wake mechanism: attach to whichever page target
  happens to be open, enable the domain there, start the matched scope.
- **`startWorker` reports empty success for a scope that does not exist at
  all** — its return value is worthless as proof a worker woke. A wake is
  therefore verified only by re-reading the target list until the worker
  reappears (bounded, 30 × 300ms), never by the command's own result.
- **`--load-extension` is inert on Chrome 151**, even with the documented
  `--disable-features=DisableLoadExtensionCommandLineSwitch` unblock flag —
  confirmed by checking the ServiceWorker registration inventory, which would
  show a stopped-but-installed extension even if nothing were running, and
  showed nothing at all. `Extensions.loadUnpacked` over CDP is the install
  path that actually works, and is what the new extension smoke and any
  future extension testing with this toolkit should use. `--headless=new` is
  fine for driving an extension; no headed instance is required.

### Notes

- Tool count is unchanged at **45** — this release grew `evaluate_script` and
  the target-selector grammar, not the tool list.
- `docs/social-preview.html` and `docs/demo.tape` carry no version string and
  needed no re-render for this release.
- New tests: `test/label-selector.test.ts`, `test/worker-selector.test.ts`,
  two new arms in `test/manifest-grammar-drift.test.ts` (inclusion for
  `label:`, exclusion for `worker:`), and a new live smoke,
  `test/extension-smoke.ts`, against a fixture MV3 extension in
  `test/fixtures/mv3-extension/` — 20/20 assertions, including a genuine idle
  eviction (worker absence from `/json/list` asserted before waking) and a
  strict-mode check that a worker evaluate mints zero lease files while a
  page evaluate in the same run still mints one.

## [1.8.0] - 2026-08-09

Two tracks land together, merged onto one integration branch. Track S closes the
gap 1.7.0's takeover mode opened: an agent can now claim a human's open tab, but
nothing detected the human was still there, and reap could destroy an
agent-abandoned tab the moment it went idle. Track P is four groups of input
parity chrome-devtools-mcp already had and this toolkit didn't: a wheel/scroll
tool, a raw mouse primitive, real HTML5 drag-and-drop, and navigation
history/downloads/permissions. Tool count moves 41 → 45. Every new
input-dispatching path (Track P) was wired through Track S's dispatch log as
part of the merge, not left as a follow-up — see "Changed" below.

### Added

- **An activity beacon: `claim_page` and `list_leases` now know when a human is
  already using a tab (`src/activity.ts`).** A tiny in-page script records the
  timestamp of the last `pointerdown`/`mousedown`/`keydown`/`wheel`/`touchstart`,
  installed at claim time on both `claim_page` modes and
  `new_page{claim:true}`. On Chrome, `Page.addScriptToEvaluateOnNewDocument`
  alone does **not** survive navigation under this toolkit's per-call connection
  lifetime — the registration dies with the connection that made it, which is
  every tool call, a fact verified against a live browser before anything was
  built on it (`addScriptToEvaluateOnNewDocument` → new connection → navigate →
  `null`). So the CDP driver now holds one connection open per beaconed tab
  purely to keep the registration alive across navigations, bounded at 32
  tabs with oldest-first eviction; an evicted tab still answers for input on
  its current document, only the next navigation's re-arm is lost. Firefox
  needs none of this — its BiDi session lives for the whole process, so a
  `script.addPreloadScript` registration survives navigation for free, and was
  implemented and live-verified rather than left absent, since the spec's
  Firefox carve-out only applied if the plumbing was intractable and it wasn't.
  CDP-dispatched input is `isTrusted:true` too, so the beacon alone cannot tell
  a human click from the toolkit's own: every input-dispatching call writes to
  an in-process dispatch log, and a beacon timestamp counts as human only when
  it postdates this server's last dispatch on that tab by more than 1500ms.
  `claim_page`/`list_leases` surface it as `humanActiveMs` — milliseconds since
  input this server did not dispatch. **`null`/absent means NO DATA, never "no
  human"**: a fresh tab, a tab whose every input was this server's own, and a
  backend that cannot answer at all are all indistinguishable from each other
  and from silence. A `claim_page` takeover of a tab a human used within the
  last 30 seconds additionally carries a `contention` warning string, and **the
  claim is never refused for it** — taking over a person's tab is what
  takeover mode is for, so the warning informs a caller who already holds the
  lease, it does not gate anything. Known blind spots, stated rather than
  designed away: input inside a cross-origin iframe is invisible to the
  beacon, and a *second* MCP server process's dispatches read as human to this
  one, since dispatch-log correlation is scoped to this process.

- **Split reap horizon: reclaimable and destroyed are different moments, now
  separated by `CDP_REAP_GRACE_MS`.** Before this release, `list_pages` and
  `list_leases` closed an agent's tab the instant its lease read `expired`,
  which is also the instant another agent becomes *entitled* to take it —
  fine for handing the lease to someone else, destructive when applied to the
  tab itself. An agent 20 minutes into a build between tool calls does not
  expect to come back to a destroyed tab just because it could, in principle,
  have been reclaimed. `staleAgentTabs` (`src/reap.ts`) stays a pure function
  but now takes `now`/`reapGraceMs`: an `expired` lease qualifies for the
  destructive close only once `now - lastUsedAt > ttlMs + reapGraceMs`.
  `CDP_REAP_GRACE_MS` defaults to `2700000` (45 minutes), for a 60-minute total
  fuse after last use. Lease *reclaimability* — `list_leases`' `stale` field —
  is byte-for-byte unchanged at `ttlMs`; only the destructive close moved.
  `dead-pid` is unaffected by grace and reaps immediately, because that
  process is never coming back and there is nothing to wait for.

- **Renderer ping and lease observability on `list_pages`/`list_leases`.**
  `list_pages` gains `probe?: boolean` (default false, byte-identical shape
  when omitted): one bounded (500ms) `Runtime.evaluate` per page-type target,
  run concurrently so one wedged tab cannot stall the rest of the listing
  beyond its own budget. Adds `responsive: boolean` (false on a timeout, a
  page-side exception, or an unreachable target — never an error for the
  whole call) and, where the same round trip finds human-attributed input,
  `humanActiveMs`, reusing the beacon's own discrimination rule rather than a
  second implementation of it. Separately and unconditional on `probe`,
  `list_leases` rows gain computed `idleMs` (now−lastUsedAt) and `expiresAt`
  (lastUsedAt+ttlMs, the same value `claim_page` already returns under that
  name), and `list_pages` entries for a tab under an active, readable lease of
  the driver's own backend gain `lease: {label,pid,idleMs,expiresAt,stale}`.
  Both are computed fresh in the tool layer on every call, never stored.

- **`scroll`, a new wheel-dispatch tool, on both backends.** Anchor at
  `uid`/`selector`/`x`+`y` (element anchors are scrolled into view first, same
  as `click`), or the viewport center if all three are omitted; at least one
  of `deltaX`/`deltaY` is required, positive `deltaY` scrolling down and
  positive `deltaX` scrolling right (wheel convention). Chrome dispatches
  `Input.dispatchMouseEvent{type:"mouseWheel"}`; Firefox dispatches WebDriver
  BiDi's `wheel` input source — both live-verified against a real browser, not
  left on "it typechecks." A real bug surfaced along the way: Chrome
  smooth-scrolls a wheel dispatch, so the command's ack resolves once the
  event is *queued*, not once the resulting scroll has *settled*, and a
  caller reading `scrollTop` immediately after could see the pre-scroll
  value. Fixed with a capture-phase `scroll` listener armed before dispatch
  (window-level, since `scroll` doesn't bubble but a capture-phase listener on
  `window` still sees it), debounced 60ms with a 500ms hard cap rather than a
  blind sleep sized wrong for both large and small deltas.

- **`dispatch_mouse`, the raw move/down/up primitive, Chrome-only.** Dispatch
  exactly one `move`/`down`/`up` mouse event at absolute viewport coordinates
  (`x`/`y` required on every call — CDP has no notion of a current pointer
  position to default from); compose your own move/down/move/up sequences for
  anything a physical mouse can do that `click`/`drag`'s fixed sequences
  can't — canvas drag-painting, marquee/rubber-band selection, a custom
  hit-testing widget. Takes the same `button`/`clickCount`/`modifiers` as
  `click`. Lives outside the Driver abstraction by design, alongside
  `heap.ts`/`screencast.ts`'s other chrome-only-tool modules, but is
  lease-gated through the exact same choke point every other interaction tool
  uses. Chrome-only, capability `input.raw`: absent from `tools/list` under
  `--browser firefox`, never present-and-throwing.

- **`click` gains `modifiers` and `clickCount:3`.** `modifiers` (Alt/Control/
  Meta/Shift, CDP bits 1/2/4/8) is held for both press and release, e.g.
  `["Shift"]` for a shift-click; `clickCount:3` triple-clicks, selecting a
  paragraph/line in most editors. `modifiers` is a **Chrome-only parameter on
  an otherwise-universal tool**: a non-empty array throws a clear error under
  `--browser firefox` rather than being silently dropped or ignored — a
  documented param-level gap under ADR-001, not a missing tool.

- **Real HTML5 drag-and-drop (`drag mode:"html5"`), plus `steps`, `to:{x,y}`,
  and `by:{dx,dy}` on the existing mouse-mode drag.** The spec's premise —
  that synthetic mouse events cannot drive HTML5 drag-and-drop at all — is
  **false**, measured against Chrome 151: `mode:"mouse"` (the default) does
  start a real drag and can fire `dragstart`/`dragover`/`drop`. The actual gap
  is that *which* `dragover` events reach the page depends on where the
  interpolated pointer path happens to land, because mouse mode's drag
  events follow that path rather than being dispatched at fixed points. At
  the default `steps:2`, a drop zone written the standard way (`preventDefault`
  only inside `dragover`, the HTML spec's own pattern) sees **zero** `dragover`
  events and refuses the drop outright — a coin flip decided by geometry, not
  a reliable "it doesn't work." `mode:"html5"` closes that gap deterministically:
  `Input.setInterceptDrags(true)` arms interception, the mouse press/move
  sequence runs, `Input.dragIntercepted` hands back the page's own `dragstart`
  DragData, and the toolkit replays it as `dragEnter`→`dragOver`→`drop` exactly
  at the destination — path-independent, and interception is always disabled
  in a `finally`. Missing the intercepted event within 5 seconds (e.g. the
  source isn't `draggable="true"`) is an actionable error, never a silent
  no-op. `mode:"html5"` is Chrome-only (capability `input.html5Drag`, absent
  from `REQUIRED_CAPABILITIES` so `drag` itself stays available on both
  backends) and is rejected with a clear error under Firefox rather than
  silently downgrading to mouse mode, which would report a drop that never
  happened. `steps` (default 2, matching the exact pre-1.8.0 dispatch) sets
  the interpolated-move count for mouse mode; `to` now also accepts an
  absolute `{x,y}` alongside `uid`/`selector`, and a new top-level `by:{dx,dy}`
  offsets from the source point instead (sliders, map panning, resize
  handles) — exactly one of `to`/`by` is required, refused rather than
  resolved by precedence when both or neither are given.

- **`navigate_page` gains `history: "back"|"forward"`, on both backends.**
  Traverses this tab's session history like the browser's own Back/Forward
  buttons: Chrome via `Page.getNavigationHistory` + `Page.navigateToHistoryEntry`,
  Firefox via BiDi's `browsingContext.traverseHistory{delta:±1}`. Mutually
  exclusive with `url`/`reload` — passing two of the three is refused by name,
  never resolved by precedence. Going back from the first entry, or forward
  from the last, is an **error naming the direction**, never a silent
  no-op that navigates nowhere; both backends were made to raise the same
  sentence (Firefox's own error never names a direction, so the BiDi driver
  rewraps it). Waits for the same load milestone as an ordinary navigation.

- **`wait_for_download`, capture a real file download as a file on disk,
  Chrome-only and MCP-server-only.** Returns `{path,suggestedFilename,bytes,
  url,target}`, renaming Chrome's internal guid to the page's own filename
  (collision-suffixed: `report.csv`, `report-1.csv`, ...). Two premises in the
  original design were probed against a real browser before anything was
  built, and both were **false**: `Browser.setDownloadBehavior` does **not**
  persist past the arming client's disconnect (measured: an armed-then-closed
  connection followed by a click landed zero files, no events, anywhere — the
  download is *denied*, not merely misdirected), and the toolkit's per-call
  CDP lifetime means every tool call is exactly such a disconnect. The fix is
  `src/tools/browser-session.ts`: one lazily-opened, module-scoped connection
  to the browser endpoint, held open for the process's life, arming download
  capture once and keeping a ring buffer of completions — opened only when
  `wait_for_download` or `grant_permissions` is first called, so a session
  that never downloads pays nothing. **Ordering rule, not optional:** call
  `wait_for_download{arm:true}` *before* the click that starts the download
  (it arms and returns immediately: `{armed:true,downloadPath,pending}`), then
  click, then call `wait_for_download` again to collect the finished file —
  arming late loses the download with no file anywhere to recover it from.
  **Browser-global side effect:** while armed, *every* download in the
  browser, all tabs and origins, is redirected into the toolkit's downloads
  directory for as long as the server runs. **MCP-server only, not a
  preference:** the arm lives on a connection this server process holds open;
  under the one-shot CLI that connection dies with the process before a
  download could ever complete, so the tool needs the long-lived server the
  same way `performance_start_trace`/`start_screen_recording` already do.
  Chrome-only, capability `browser.downloads`: WebDriver BiDi has no command
  to redirect a download to a chosen directory.

- **`grant_permissions`, pre-answer permission prompts for an origin,
  Chrome-only and MCP-server-only.** `permissions: string[]` takes CDP
  PermissionType values (`geolocation`, `notifications`, `clipboardReadWrite`,
  `camera`, `microphone`, `midi`, ...; an unknown name is refused by Chrome
  with the bad value in the message), keyed by **origin**, not tab — every
  tab on that origin is affected, including ones opened later. `reset:true`
  clears this server's previous grants first, or instead when no permissions
  are given; CDP's reset is not itself origin-scoped, so it clears every
  origin at once. The same probe that falsified `wait_for_download`'s
  persistence assumption was run against `Browser.grantPermissions` on
  spec, since the same per-connection-state trap applies here too, and it
  sprang: a grant also does **not** survive the granting client's disconnect.
  Shares `browser-session.ts`'s standing connection with `wait_for_download`
  for exactly that reason. Chrome-only, capability `browser.permissions`:
  absent from `tools/list` under Firefox, never present-and-throwing.

### Changed (behavior, no flag)

- **Every input-dispatching path, old and new, now writes through one choke
  point, closing a real bug the individual branches could not see.** Track P
  was built against pre-1.8.0 main, before Track S's dispatch log existed, so
  its `scroll` and html5-drag paths sent `Input.*` straight down the
  connection. Merged as-is, this compiles, typechecks, and passes both
  branches' full test suites while the activity beacon reports the toolkit's
  own scroll as a human using the tab — an agent warned about contention with
  itself, the exact failure the beacon exists to prevent, invisible to either
  branch's own tests because neither branch could see the other's code.
  `dispatch_mouse` lives outside the Driver abstraction and has no
  `dispatchInput` to call, so the write moved to a new shared function,
  `sendInput(conn, backend, targetId, method, params)` in `src/activity.ts`;
  `CdpPageDriver.dispatchInput` now delegates to it and `dispatch-mouse.ts`
  calls it directly. `Input.setInterceptDrags` (html5 drag's arm and its
  `finally`) is sent but deliberately **not** recorded: it synthesizes no
  page input, and logging it would suppress a real human input landing in the
  same 1500ms window — classified by denylist, so an `Input.*` command nobody
  thought to classify defaults to being logged, because over-warning is
  recoverable and silent misattribution is the bug this feature exists to
  avoid. Firefox needed no code change: Track P built its BiDi scroll and drag
  on `performActions`, which already called `recordDispatch`, so it inherited
  the log for free — the whole argument for having a choke point in the first
  place. The invariant — nothing in `src/` sends `Input.*` except through
  `sendInput` — is grep-verified post-merge and is now also a test
  (`test/input-dispatch-wiring.test.ts`), mutation-checked by reverting
  `scroll` to a raw send and confirming the test names the exact line and the
  live smoke reproduces the bug (`humanActiveMs=202` on the toolkit's own
  scroll, instead of `undefined`).

### Residuals

- **A stale claim in `drag`'s own manifest description was caught and fixed
  during integration, not by a fresh reader later.** An earlier pass on the
  top-level `drag` description already stated the measured mouse-vs-html5
  finding, but the `mode` property's own enum description still read "does
  nothing on HTML5 draggable elements" — the exact folklore the rest of this
  release measured false. Corrected to match; no test pinned the stale
  string.
- **Second-MCP-server blind spot, stated plainly.** Two MCP server processes
  driving the same browser cannot see each other's dispatch logs, so one
  server's tool calls read as human activity to the other. Accepted: the
  discrimination rule is honest about what it can and cannot see, and the
  alternative (a shared dispatch log across processes) is a much larger
  feature for a scenario this toolkit does not otherwise support (see
  "Parallel tabs" — one writer per flow).
- **Cross-origin iframe input is invisible to the beacon,** since the
  listener is installed on the top document only. Under-warning here is the
  same accepted direction as the denylist above: a missed human input reads
  as agent-only, never the reverse.
- **`dispatch_mouse`'s `modifiers` and `click`'s `modifiers` are two separate
  parameters that happen to share an enum,** not one modifier system: each
  tool validates and documents its own Firefox behavior independently.
- **Firefox's BiDi `scroll` path shipped once and was verified twice, in two
  different seats.** It typechecked and passed unit tests against the real
  BiDi capability set when Track P landed, but no Firefox was available to
  that seat to run it live; the integration seat had one, ran it, and it
  passed unmodified — the implementation was correct the first time, only the
  live evidence was missing. Recorded here so "typechecks" is never mistaken
  for "verified" on the next capability that ships without a live check.

### Notes

- Tool count is now 45 (29 parity + 16 superset: `performance_trace`, the
  cookie group, the network-mocking group, the lease group, the
  screen-recording pair, `scroll`, `dispatch_mouse`, `wait_for_download`, and
  `grant_permissions`); 34 under Firefox, which lacks the eleven
  capability-gated tools — the pre-1.8.0 eight (tracing, heap-snapshot,
  Lighthouse, screen-recording) plus `dispatch_mouse`, `wait_for_download`,
  and `grant_permissions`. `scroll` and the extended `navigate_page`/`click`/
  `drag` params ship on both backends; only `click`'s `modifiers` and `drag`'s
  `mode:"html5"` stay Chrome-only, and only at the parameter level — the
  tools themselves are universal.
- Two new live-smoke scripts, `bun run staleness:smoke` and `bun run
  input:smoke`, are each a single process talking to a single browser:
  `CDP_BASE` is a module-level constant captured at import time, so one
  process cannot address two browsers on two ports. Each is therefore
  env-driven — `staleness:smoke` honors `STALENESS_SMOKE_PORT` (default
  9501), `input:smoke` honors `CDP_SMOKE_PORT` (default 9513) — so the two
  can run against separate scratch Chromes without colliding.

## [1.7.0] - 2026-08-09

Four things land on top of 1.2's opt-in lease model, all under one new switch
plus one default that moves without it. `CDP_REQUIRE_LEASE` turns leasing from
optional into mandatory for a long-lived MCP server: every call auto-acquires
the tab it touches instead of driving it lease-free. `release_page` now closes
a tab this toolkit opened, the one behavior a caller sees without opting into
anything. Reap closes tabs an agent abandoned instead of leaking them forever.
And `claim_page` gained a `target` mode so an agent can take over a tab a human
already has open, not just claim one it created itself.

### Added

- **`CDP_REQUIRE_LEASE`, a switch that makes holding a lease mandatory instead
  of optional, and the `auto` tier that makes it livable.** Off by default, so
  a 1.6.0 consumer is unaffected. On, in a long-lived MCP server process only:
  `assertLeaseOk` now *acquires* a lease on an unheld tab instead of waving the
  call through, which is what makes "you cannot drive a tab you do not hold"
  actually true rather than aspirational. That acquired lease is marked
  `auto: true` on the `LeaseRecord` (absent, and therefore `false`, on every
  record a pre-1.7.0 toolkit ever wrote, so an upgrade never downgrades a held
  lease's protection), and an auto lease is owned by a *process*: any later
  call from the same pid passes with no token, while a lease taken explicitly
  via `claim_page` or `new_page{claim:true}` still demands its token even from
  that same process. That two-tier split is what lets an ordinary tool call
  keep working with zero protocol changes while still giving one subagent a
  way to fence off a tab from its siblings, which share its pid. `new_page`
  auto-claims the tab it just created under strict mode, even without
  `claim:true`, because a tab nobody holds the instant it exists is a tab the
  very next call would have to auto-acquire anyway; `claim:true` still yields
  the stronger, explicit tier. **Strict mode is MCP-only, deliberately and
  unconditionally**, not just by convention: `requireLease()` reads a
  per-process flag that only `mcp.ts` sets at startup, so `CDP_REQUIRE_LEASE=1`
  in a CLI invocation's environment is inert no matter what. A CLI call is one
  process per invocation, so a lease it auto-acquired would be reclaimable by
  the dead-pid rule the instant that process exited, and "a lease that is
  reclaimable on arrival" is worse protection than none; the sharper danger is
  reap, which would then read that instantly-dead-pid record as an abandoned
  agent tab and could close it on the very next `list_pages` call.

- **`release_page{target}`, the counterpart an auto-acquired lease needs**,
  because the gate mints those without ever handing the caller a token to give
  back with `lease`. `target` takes the same selector grammar as everywhere
  else and resolves through `resolvePage`, which is itself the authorization:
  it runs `assertLeaseOk`, so a tab another live process holds is refused
  there and, under strict mode, an unheld tab is acquired on the way in, which
  means the caller genuinely holds it by the time it is released. `lease` and
  `target` are mutually exclusive and exactly one is required.

- **Reap: `list_pages` and `list_leases` close tabs an agent abandoned,
  instead of leaking them forever.** `release_page` only closes a tab an agent
  gives back, and an agent that crashes, is killed, or just stops calling
  never gives anything back; a timeout is a more likely end for an agent than
  a clean shutdown. Rather than a background sweeper (a second lifetime to
  reason about, and a process that has to be running), reap runs on read: the
  two list tools already hold the browser's live target list and the lease
  directory in hand at that moment, so checking costs one extra pass over data
  already fetched. The selection itself, `staleAgentTabs` in the new
  `src/reap.ts`, is a pure function so the four conditions that gate a close
  can be tested exhaustively with no browser and no filesystem, which matters
  because every mistake in this code closes a tab someone wanted: (1) the
  lease row is for this backend and actually readable — an `unreadable` row is
  never a candidate, because a guess in the destructive direction is the one
  guess that cannot be undone; (2) it is stale for `dead-pid` or `expired`,
  never `target-gone` (nothing to close) or a healthy lease; (3) the target is
  still genuinely open, per the live page listing; and (4), the load-bearing
  one, **the toolkit both opened the tab AND leased it** — an origin record by
  itself is not enough. An agent-created tab that never went through
  `claim_page`/`new_page{claim:true}` and was never auto-leased has no lease
  row at all, and that is exactly what `new_page` produces for a caller who
  never touches leases; reaping those would be a data-loss bug wearing a
  cleanup's clothes, not a cleanup. Closed tabs are reported in an additive
  `reaped` array (`{targetId, label, reason}`) present only when something was
  actually closed, so the common-case response shape is byte-identical to
  1.6.0; a close that fails is not reported and the lease is left in place, so
  the next read tries again rather than lying about what is still open.
  Strict-mode gated, for the same MCP-only reason as auto-acquire: a CLI user
  running `list_pages` twice would otherwise watch the second run close the
  tabs the first run's now-dead process just leased.

- **`claim_page{target}`, a takeover path for a tab that is already open.**
  With neither `target` nor `targetId`, `claim_page` still opens a fresh tab,
  which was its only mode before; `targetId` still claims an exact existing
  target id, kept for back-compat. Neither of those covers "work in the tab I
  already have open" when the caller does not have that tab's id to hand,
  which is the ordinary shape of a human asking an agent to continue in a tab
  that is sitting right in front of them. `target` takes the toolkit's whole
  selector grammar (`active | index:N | url:<substr> | title:<substr> |
  <targetId>`) and resolves it against the live page list only: an unmatched
  selector is an error, never a silently substituted new tab, because "the tab
  I asked for is not there" and "here is an empty one instead" are answers a
  caller has to be able to tell apart. The result gained `opened: boolean`,
  true only when this call actually created the tab, which is the same
  distinction the creation ledger records and is what keeps close-on-release
  safe through this new path: a tab taken over this way has no creation
  record, so `release_page` releases it and leaves it open. **Resolution here
  is deliberately gate-free** — it goes through `pickPage`, not `resolvePage`
  — because under strict mode `resolvePage` would auto-acquire a lease on an
  unheld tab on the way in, and the explicit claim right behind it would then
  collide with the lease it had just minted for itself. The protection this
  skips is not lost, only moved one layer down: `claimLease`'s own conflict
  check still refuses a tab any live process holds, auto-acquired or explicit.
  **There is deliberately no force or steal option.** A tab another live agent
  holds is refused with the same conflict error as ever; the tab this feature
  exists to take over is a human's, and a human's tab carries no lease at all.

### Changed (behavior, no flag)

- **`release_page` now closes a tab this toolkit opened, by default.** This is
  the one thing a 1.6.0 caller sees without setting `CDP_REQUIRE_LEASE`:
  previously `release_page` only ever gave the lease back and never touched
  the tab. The close is scoped by the creation ledger from `origins.ts`, which
  answers "did this toolkit open it" independently of the lease, and only
  independently of the lease could it answer that at release time: a tab this
  toolkit opened for an agent is closed, a tab a human already had open and an
  agent merely claimed is released and left exactly alone, and `close: false`
  opts out of a close per call while `close: true` forces one either way. A
  release that did not actually happen — already released, reclaimed, or
  expired — never closes anything, because by then the tab may belong to
  another agent entirely; that is the one rule here that is a safety property
  rather than a convenience, not a default that can be overridden.

### Residuals

Stated plainly rather than designed away, most inherited from strict mode's
design doc, one new to the takeover path:

- **Auto leases do not isolate subagents sharing one MCP server process.** All
  of a session's subagents share one pid, so they pass each other's auto
  leases freely. The escape hatch is an explicit `claim_page`, which demands
  its token even same-process; that is the accepted cost of keeping the
  ordinary path ergonomic.
- **Reap closes an idle-but-alive agent's tab after `ttlMs` elapses.**
  `expired` means reclaimable, so another agent could already have taken the
  tab by the time reap runs; closing it is consistent with that, but it is
  still a close the original agent did not ask for. Tunable via
  `CDP_LEASE_TTL_MS` (default 15 minutes).
- **A read can have a side effect.** `list_pages` and `list_leases` can close
  tabs under strict mode. Mitigated only by reporting every close in `reaped`.
- **`release_page{target}` under strict mode, on an unleased agent tab,**
  auto-acquires it and then closes it in the same call, closing a tab the
  caller itself never drove a single command against. Accepted because under
  strict mode an unleased agent tab means nobody is actually driving it.
- **Auto-acquire can mint a lease on a non-page target.** `pickPage`'s bare-id
  branch searches the full `all:true` listing, so an exact id for a worker or
  an iframe still resolves and gets leased. Harmless, since a lease is just a
  file, but it will show up as a row in `list_leases`.

### Notes

- Tool count is unchanged at 41 (29 parity + 12 superset); 33 under Firefox.
  `claim_page`, `release_page`, and `list_leases` gain arguments and result
  fields, none of them removed or renamed.

## [1.6.0] - 2026-08-09

This release skips 1.5.0 (reserved for in-flight work on another branch).

### Added

- **`start_screen_recording` and `stop_screen_recording`, a tab-to-video capture
  pair.** `take_screenshot` answers "what did the page look like"; nothing in
  the toolkit answered "what did it DO", so proving a flow worked meant
  stitching stills together by hand or shelling out to a desktop recorder that
  captures the whole screen instead of the tab it was told to drive. The pair
  records one named target over `Page.startScreencast`, keyed by targetId like
  network mocking, so several agents can record different tabs in the same
  browser at once. `start_screen_recording` opens a persistent page connection,
  probes ffmpeg, and returns `{target, format, spoolDir, encoder, codec,
  startedAt, note}`; `stop_screen_recording` tears the stream down, encodes the
  spooled frames with ffmpeg, and returns `{path, bytes, durationMs,
  frameCount, encodedFrames, codec, encoder, width, height, droppedFrames,
  target}`. Like `performance_start_trace`/`performance_stop_trace`, the pair
  must run WITHIN THE SAME PROCESS: the frames are events on the connection
  that started the screencast and cannot be re-attached from a fresh process,
  so this needs the MCP server rather than the one-process-per-call CLI.

- **Chrome only, and absent rather than throwing on Firefox.** WebDriver BiDi
  has no streamed-frame primitive at all (the spec offers only the one-shot
  `browsingContext.captureScreenshot`), so both tools declare a new capability,
  `capture.screencast`, that the BiDi driver never offers. Per the toolkit's
  ADR-001 pattern, a capability a backend cannot run means the tool is missing
  from `tools/list` under `--browser firefox`, not present and failing mid-call.

- **Frames are acked before the disk write, not after.** Chrome will not send
  screencast frame N+1 until frame N is acknowledged with
  `Page.screencastFrameAck`, so the ack fires from the event handler before
  the frame's bytes are written to the spool; anything awaited before the ack
  becomes the frame rate. An unacked frame stalls the whole stream.

- **Variable frame rate handled with a timestamped ledger, not a fixed
  encoding rate.** Chrome emits a screencast frame on repaint, not on a clock:
  a still page emits nothing and an animating one emits at whatever rate it
  paints. Every captured frame is timestamped into an in-memory ledger, and on
  stop that ledger is rendered as an ffconcat manifest with an explicit
  per-frame duration, so a still page holds one long frame and the total video
  duration tracks wallclock rather than racing or freezing.

- **Frames are coalesced onto the encoder's 40ms PTS grid, deliberately and
  visibly.** ffmpeg's concat demuxer takes its stream time_base from the first
  file's sub-demuxer, and image files arrive through `image2` at its default
  25fps, so every frame's presentation timestamp is silently snapped to a
  1/25s grid no matter what the manifest's `duration` lines say — `-vsync vfr`
  then drops every frame that collides with an earlier one on that grid, with
  no warning on stderr. A first pass caught this the hard way: a 373-frame
  capture encoded to 102 frames with every check green. Three other fixes were
  measured and rejected: `-r` before `-i` overrides the durations outright (a
  1.000s clip became 0.101s), `-framerate` is not an option the concat demuxer
  accepts, and `settb`/`-video_track_timescale` change only the output
  timebase. The toolkit now snaps the ledger onto the 40ms grid itself before
  handing it to ffmpeg, keeping the first frame per slot, and reports both
  numbers instead of letting them silently differ: `frameCount` is what was
  captured off the wire, `encodedFrames` is what actually reached the video.

- **Encoder ladder, probed once per process from `ffmpeg -hide_banner
  -encoders`, matched on the name column only:** `hevc_videotoolbox` →
  `h264_videotoolbox` → `libx265` → `libx264`. Both HEVC rungs get `-tag:v
  hvc1`, without which QuickTime refuses to play the MP4 it just wrote.
  Matching only the encoder-name column (not the raw text) matters because
  ffmpeg repeats a family name inside a sibling encoder's description — a
  substring match on `libx264` also hits `libx264rgb`, an RGB-only encoder
  that cannot write the `yuv420p` file the tool just promised.

- **ffmpeg is probed at START, with an actionable error, not at stop.** A
  missing ffmpeg now fails before a recording is captured and thrown away,
  rather than after. The error names the two install commands
  (`brew install ffmpeg` / `apt install ffmpeg`) and `CDP_FFMPEG`, the env var
  that points the toolkit at a binary not on `PATH`.

- **A failed encode keeps the spool and hands back the exact re-run
  command.** If ffmpeg exits non-zero, the spooled frames and the generated
  `frames.ffconcat` manifest are kept on disk (named in the error) instead of
  being deleted with the failed attempt, along with the literal ffmpeg
  command line to re-run by hand.

- **`start_screen_recording` takes the same capture knobs as the underlying
  CDP call:** `format` (`jpeg` default, or `png`), `quality` (JPEG 0-100),
  `maxWidth`/`maxHeight` (also pins frame size against a mid-recording
  viewport change), and `everyNthFrame` to skip repaints on a high-framerate
  page before they're coalesced away. `stop_screen_recording` takes
  `savePath` to override the default `<artifact dir>/screen-recording-
  <targetIdShort>-<stamp>.mp4` output path.

### Notes
- Tool count is now 41 (29 parity + 12 superset); 33 under Firefox, which
  lacks the eight capability-gated tools (`start_screen_recording` /
  `stop_screen_recording` join the tracing, heap-snapshot, and Lighthouse
  groups already absent there).

## [1.4.0] - 2026-08-06

This is the first npm release since 1.2.0. Both `v1.2.1` and `v1.3.0` were
tagged and pushed to GitHub but never reached npm, because the release runs
through GitHub Actions with OIDC trusted publishing and Actions was down. Their
changes are folded in here rather than published separately, so 1.4.0 on npm
carries the lease-conflict fix (1.2.1), the tab-origin ledger (1.3.0), and the
cookie group plus the `evaluate_script` file sink below. See the [1.3.0] and
[1.2.1] sections for the folded-in details.

### Added

- **`set_cookie` and `delete_cookies`, the WRITE half of the cookie group.**
  `list_cookies` made the store readable; these make it writable, including the
  httpOnly and secure cookies `document.cookie` can neither create nor remove,
  so seeding an authenticated session or clearing one is a tool call rather
  than a hand-rolled raw CDP detour. `set_cookie` takes `{name, value}` plus
  the usual cookie attributes (`url`, `domain`, `path`, `expires` in Unix
  seconds, `httpOnly`, `secure`, `sameSite`) and answers `{set:true, target}`;
  `delete_cookies` takes `{name}` plus `url` or `domain` and an optional
  `path`, and answers `{deleted:true, target}`. Chrome rides `Network.setCookie`
  and `Network.deleteCookies`, Firefox rides `storage.setCookie` and
  `storage.deleteCookies` partitioned by the resolved browsing context.
  Three deliberate refusals, all of which exist because the alternative is a
  call that looks like it worked. First, either `url` or `domain` is required
  on both tools: a cookie has to be attributed to a site, and guessing the
  current page's origin would write a real cookie somewhere the caller never
  named, while a name-only delete would sweep the whole partition. Second,
  Chrome answers `Network.setCookie` with `success:false` rather than an error
  when it declines a cookie (a domain the url does not cover, a secure cookie
  on an insecure origin, an oversized value), so that false is raised as an
  error instead of being reported as `set:true`. Third, BiDi has no `url`
  parameter and requires a `domain`, so the Firefox driver derives one from the
  url's host and throws on a url with no host (`about:blank`, a `data:` URL)
  rather than sending a call Firefox answers cleanly while writing nothing.
  Two things are deliberately absent: the response never echoes the value back,
  since the value is usually the credential the caller just supplied, and
  `delete_cookies` reports no count, because neither protocol says how many
  cookies it removed and a number here would be invented. Read `list_cookies`
  before and after when a real count is needed. `path` is passed through
  exactly as given and never defaulted to `/`, since Chrome derives the path
  from `url` and an invented default would widen a deliberately narrow cookie.

- **`list_cookies`, a new tool that reads the target page's cookie store,
  httpOnly cookies included.** There was no cookie tool at all before this, so
  reading an httpOnly session cookie, exactly the set `document.cookie` cannot
  see and `evaluate_script` therefore cannot reach, meant dropping to raw CDP
  by hand: a fallback that fights the very contention this toolkit exists to
  avoid, since a page target accepts a second websocket and then never answers
  on it while another client is attached. Each cookie carries `name`, `value`,
  `domain`, `path`, `expires` (Unix seconds, `-1` for a session cookie),
  `size`, `httpOnly`, `secure`, `sameSite` and `session`. The read is
  page-scoped, not browser-wide: Chrome uses `Network.getCookies` rather than
  the whole-profile `Storage.getCookies`, and Firefox uses `storage.getCookies`
  partitioned by that browsing context, so a call naming one tab never returns
  every other site's credentials. Both backends are supported, with the same
  shape: the BiDi differences (a bytes-value that may be base64, an absent
  `expiry` meaning a session cookie, a lowercase `sameSite`) are normalized in
  the driver. Optional `domain` and `name` filters narrow the result: `name` is
  an exact match, `domain` ignores a leading dot on either side and also
  matches subdomains, and that is the entire matching rule. Optional `savePath`
  behaves exactly as `evaluate_script`'s does: the cookie array is written to
  that file as JSON and the response carries only `{path, bytes, count,
  target}`, with no cookie value in any form, no preview and no truncation,
  which is how to capture a session cookie without putting the credential in
  the calling agent's transcript. Tab leases are respected the same way every
  sibling tool respects them, at target resolution.

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

[1.9.1]: https://github.com/sblattj/cdp-toolkit/releases/tag/v1.9.1
[1.9.0]: https://github.com/sblattj/cdp-toolkit/releases/tag/v1.9.0
[1.8.0]: https://github.com/sblattj/cdp-toolkit/releases/tag/v1.8.0
[1.7.0]: https://github.com/sblattj/cdp-toolkit/releases/tag/v1.7.0
[1.6.0]: https://github.com/sblattj/cdp-toolkit/releases/tag/v1.6.0
[1.0.0]: https://github.com/sblattj/cdp-toolkit/releases/tag/v1.0.0
