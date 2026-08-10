# Changelog

All notable changes to cdp-toolkit are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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

[1.7.0]: https://github.com/sblattj/cdp-toolkit/releases/tag/v1.7.0
[1.6.0]: https://github.com/sblattj/cdp-toolkit/releases/tag/v1.6.0
[1.0.0]: https://github.com/sblattj/cdp-toolkit/releases/tag/v1.0.0
