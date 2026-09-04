# Firefox: many agent PROCESSES on one browser — the BiDi session multiplexer

Status: **implemented** (2026-09-04, written against `b6b0fda`, v2.1.0). §0 below is filled in
now that the harness passes.

## 1. The question, and what was measured before any design

"Can this repo drive multiple agents using multiple Firefox tabs at the same time?"

A new live harness, `test/firefox-multi-agent-smoke.ts` (`bun run firefox:multi:smoke`),
answers it through the real stdio MCP entry point (`bun src/mcp.ts`, the official SDK client,
`tools/call`), against ONE throwaway headless Firefox 153.0.3. Every agent claims its own tab
(`new_page{claim:true}`), navigates it to a per-agent fixture URL, writes an agent-private
marker, then runs R rounds that bump a per-tab counter and read marker/title/href back — so a
call that lands in another agent's tab FAILS. Every call is timestamped; the harness reports
the maximum number of DISTINCT agents with a call in flight at one instant, so concurrency is
proven rather than assumed.

**MEASURED on v2.1.0 (AGENTS=4, ROUNDS=6):**

| Shape | Result |
|---|---|
| S1 — ONE MCP server process, 4 concurrent agents, 4 tabs (Claude Code subagents share one server) | **PASS**. 40 calls, wall 902 ms vs serial sum 3133 ms, 4 distinct agents in flight at once, all reads isolated, no leaked tab. |
| S2a — 1 server PROCESS attached to the shared Firefox (control) | **PASS**. |
| S2b — 4 server PROCESSES attached to the SAME Firefox, one agent each | **FAIL**. 1 of 4 agents completes; the other three get `Firefox's single WebDriver BiDi session on ws://… is held by a LIVE process 'pid-N'` after the 8 s session wait. |

So the in-process shape already works. The cross-process shape — two Claude sessions, or
Claude + Codex, each spawning its own cdp-toolkit server against one logged-in Firefox — does
not, and the README says so ("many agents *sharing and serialized on that single session*").
"Serialized" undersells it: the second process is not queued, it is refused after a wait.

**Probed directly against Firefox 153.0.3 (`/tmp/ff-probe/probe.ts`, throwaway headless):**

- A second WebSocket to `ws://…/session/<existing-sessionId>` is refused at the HTTP upgrade
  (`Expected 101 status code`). There is no "join a session" path.
- A second `session.new` while one session is open → `session not created: Maximum number of
  active sessions` (already known).
- **Tabs SURVIVE `session.end`.** A tab created in session A is still in `browsingContext.getTree`
  under session D opened after A ended. This is what makes holder failover cheap: agents' tabs
  are browser state, not session state.

### 1.1 Second measurement: context ids are per-session

Tabs surviving `session.end` (above) makes failover look cheap — the tab is still there — but a
second probe against the same throwaway headless Firefox checked what failover costs a joiner
that already has ids CACHED, and the answer is not "free":

- A clean `session.end` followed by a fresh `session.new` keeps every tab at the same url, but
  `browsingContext.getTree` reports a **new** id for each one. Firefox regenerates every
  top-level browsing-context id whenever its one BiDi session is re-created — not only when a tab
  is created.
- A `SIGKILL`ed holder is worse: Firefox does not reap the dead session at all (still held 10s
  after an abrupt socket death), so the orphan lingers until the existing Marionette recovery
  (`src/bidi/marionette.ts`, a blind `WebDriver:DeleteSession`) force-clears it and a fresh
  session is created — at which point the ids change again.
- Confirmed live in the implemented multi-agent harness (`test/firefox-multi-agent-smoke.ts`,
  scenario S3b): after the process holding the session is `SIGKILL`ed and a new holder takes the
  slot, every surviving agent's cached target id goes stale on its very next call, even though
  the tab itself — same url, same document — is still open under the new session.

**Consequence for the design below.** Any shape where the real BiDi session's lifetime is tied to
a CLIENT process's lifetime pays this cost on every handover of that process — including a
CLEAN one. If the "holder" is whichever agent process happens to win the session-slot lease
first, that agent's own process exiting normally (the ordinary case: a first agent's session
ends while a second is still mid-task) silently invalidates the second agent's cached tab ids,
leases, and origin records, for a reason that has nothing to do with anything the second agent
did. §2.6 is why the holder ended up being a process no client governs the lifetime of.

## 2. Design: a BiDi session multiplexer, hosted by a daemon

Firefox serves exactly one BiDi session, and only one socket may own it. Therefore exactly one
process owns the real session at a time — the **holder**. The sharing mechanism is the same
regardless of who the holder is: the holder **hosts a loopback WebSocket server that speaks
BiDi** (§2.1) and advertises its endpoint in the existing cross-process session-slot lease
(`src/bidi/session-lease.ts`, §2.2). Every other process **joins** that endpoint instead of
waiting on the slot, dialing it with the same `connectBidiSessionUrl` it would use against
Firefox (§2.3). From the driver's point of view a joined connection is indistinguishable from a
real one.

**Who the holder is changed once §1.1 was measured.** The first cut of this design made the
holder whatever process wins the slot lease (`src/bidi/session-lease.ts`) — reusing the slot
lease, the pid-liveness staleness rule, and the Marionette orphan recovery unchanged, adding no
new process lifecycle to manage. Failover falls out of what already exists: the holder exits →
its dispose ends the real session and releases the slot → joined sockets close → each joiner's
next `getConnection` re-dials, one wins the slot and becomes the new holder (hosting a new mux),
the rest join it. Their tabs are still there (§1). In-flight calls during the handoff fail with a
`disconnected` error and the agent retries; nothing wedges. That is a correct failover mechanism,
but §1.1 shows what it costs on every handover, including a clean one: a client-hosted holder
ties the session's lifetime to whichever agent's process happened to attach first, so that
agent's own process exiting invalidates every OTHER client's cached ids for a reason unrelated to
anything they did. §2.6 below is why the holder ended up being a small **detached daemon**
(`CDP_FIREFOX_MUX=daemon`, the default when attaching) that no client's lifetime governs;
`CDP_FIREFOX_MUX=host` keeps the original in-process-holder behavior as an explicit opt-in, and
remains launch mode's default, where it costs nothing (§2.4).

### 2.1 `src/bidi/mux.ts` (new)

```ts
export interface BidiMux {
  /** ws://127.0.0.1:<ephemeral>/session — what joiners dial. */
  endpoint: string;
  /** Live joined client sockets. */
  clients(): number;
  /** Close every client socket (code 1001 "holder closing") and stop listening. Idempotent. */
  close(): Promise<void>;
}
/** Host a BiDi multiplexer over ONE established upstream BidiConnection (the real Firefox session).
 *  Loopback only. Zero runtime deps: RFC 6455 server over node:http upgrade + hand framing. */
export function startBidiMux(upstream: BidiConnection, opts?: { host?: string; port?: number }): Promise<BidiMux>;
```

Semantics per joined client (a `BidiConnection` on the other end):

- **`session.new`** → answered locally: `{ sessionId: "mux-<n>", capabilities: upstream.capabilities }`.
  Never forwarded (Firefox would refuse it). One virtual session per socket.
- **`session.end`** → answered locally with `{}`; drops the client's subscriptions; does NOT end
  the real session and does NOT close the client's tabs.
- **`session.subscribe` / `session.unsubscribe`** → answered locally. The mux keeps a per-client
  set of event names and refcounts the REAL subscription via `upstream.on(event, handler)`
  (which subscribes upstream on the first listener and unsubscribes on the last). A `contexts`
  argument is accepted and treated as global (this toolkit's `BidiConnection.on()` only ever
  subscribes by event name). `session.status` → `{ ready: false, message: "multiplexed" }`.
- **Every other command** → forwarded via `upstream.send(method, params, { timeoutMs: 120_000 })`
  with the client's `id` mapped back onto the reply. A `BidiError` from upstream becomes
  `{ type: "error", id, error: <code ?? "unknown error">, message }`. The long forward timeout is
  deliberate: the joiner's own `BidiConnection.send` timer (15 s default) governs, and the mux
  must not race it.
- **Events** → fanned out as `{ type: "event", method, params }` to every client subscribed to
  that event name.
- **Client socket closes** → its subscriptions are released (refcount), its pending forwards are
  dropped on reply. Tabs are untouched (the tab-lease layer governs them).
- **Upstream socket closes** (Firefox died, or the holder's own dispose) → every client socket is
  closed with 1001 and the listener stops.
- Text frames only; a binary frame or a frame > 64 MiB closes that client with 1003/1009.
  Handles masked client frames, fragmented messages, ping→pong, close handshake. Never throws
  out of a socket handler.

### 2.2 `src/bidi/session-lease.ts` (extend, no behavior change for existing callers)

- `SessionSlotRecord` gains `muxEndpoint?: string`.
- `AcquireResult` gains `joinMux?: { endpoint: string; holder: SessionSlotRecord }`. When
  `acquireSessionSlot` finds a LIVE holder whose record carries `muxEndpoint`, it returns
  `{ joinMux }` **immediately** (no `handle`, nothing written) instead of polling. It re-reads
  the record on every poll iteration, so a holder that acquired the slot a moment ago and has
  not yet advertised its mux is joined as soon as it does, within the existing wait window. A
  live holder with no mux by the deadline still throws `SessionSlotBusyError` exactly as today.
  `handle` becomes optional in the type (`handle?: SessionSlotHandle`); every existing caller
  is updated. Opt-out: `CDP_FIREFOX_MUX=off` makes acquire ignore `muxEndpoint` (behave as today).
- `export async function advertiseMux(handle: SessionSlotHandle, muxEndpoint: string): Promise<{ advertised: boolean }>`:
  re-reads the record, refuses (`advertised:false`) unless it is still OURS (same pid+createdAt,
  the release guard), and rewrites it with `muxEndpoint` added, preserving every other field.
  Atomic: write `<file>.tmp-<pid>` then `rename`.

### 2.3 `src/bidi/driver.ts` — `getConnection`, `dispose`, and the daemon spawn path

- Module state gains `muxes: Map<string /*endpoint*/, BidiMux>` and `joined: Set<string>`
  (endpoints this process reached THROUGH a mux, so dispose never sends `session.end` upstream
  for a session it does not own, and never releases a slot it never held).
- `muxMode(attached): "off" | "host" | "daemon"` reads `CDP_FIREFOX_MUX`: an explicit
  `off`/`host`/`daemon` wins; unset defaults to `daemon` when attaching (§2.6) and `host` when
  launching (§2.4 — a launched Firefox and its holder already share a lifetime, so there is
  nothing extra to leak).
- **Daemon mode (the default in attach mode).** Before running the ordinary acquire loop at all,
  `ensureMuxDaemon(endpoint)` gets a mux endpoint to join WITHOUT this process ever becoming the
  holder: read the slot record first — if it already names a live holder's `muxEndpoint`, return
  it, no spawn needed. Otherwise resolve the daemon script (`resolveDaemonScript`:
  `CDP_FIREFOX_MUX_DAEMON` override, then the source tree, then `dist/bidi/mux-daemon.js`, the
  fourth `scripts/build.ts` entrypoint) and spawn it **detached, `stdio:"ignore"`, `unref()`'d**,
  passing `<endpoint> <our pid>` as argv and `CDP_FIREFOX_MUX=host` in its env (so the daemon's
  own `getConnection` takes the holder path via `hostFirefoxMux` below, instead of recursing into
  daemon mode itself). Poll the slot record every 50ms up to `sessionWaitMs() + 5000`ms: return
  the moment it advertises a mux; if the spawned child exits first (a fast, actionable negative —
  busy slot, no Marionette, a dial error), return `undefined` immediately rather than waiting out
  the deadline, which falls this process through to the ordinary `host` path below (an
  unavailable browser still produces the existing actionable busy/Marionette errors, not a silent
  daemon retry loop); only hitting the full deadline with the child still alive throws a
  `disconnected` error naming the spawned script path and `muxDaemonLogFile(endpoint)` (§2.6) as
  where to look.
- `getConnection` create body, holder path (`host` mode — the daemon's own process under
  `CDP_FIREFOX_MUX=host`, or an explicit opt-out; unchanged acquire → Marionette → dial): after
  the real connection is established and cached, unless mode is `off`:
  `const mux = await startBidiMux(conn)`; `advertiseMux(handle, mux.endpoint)`; cache in `muxes`.
  A mux start failure is logged to stderr and otherwise ignored — the holder still works alone.
- `getConnection` create body, joiner path: whether the mux endpoint came from `ensureMuxDaemon`
  (daemon mode) or from `acquireSessionSlot` returning `joinMux` (a live holder advertising one,
  any mode), dial `connectBidiSessionUrl(muxEndpoint, dialOpts)`, cache under the FIREFOX
  endpoint key (so `page()` and the beacon map are unchanged), add the endpoint to `joined`. If
  the mux dial fails (holder dying between advertise and our dial), fall through to the ordinary
  acquire loop, which steals the now-orphaned slot record and re-runs the whole flow; a second
  failure surfaces as a `disconnected` DriverError naming the holder.
- Re-dial after a dead socket: today's `owned` branch re-dials without re-acquiring. A JOINED
  connection whose socket died must NOT take the owned branch (we own nothing): drop the endpoint
  from `joined` and run the normal acquire path (which re-enters daemon mode too), which will
  either join the new holder or win the slot.
- `dispose()`: if `muxes` has this endpoint → `mux.close()` FIRST (joiners disconnect and start
  polling the slot, which we still hold), then `session.end`, then release the slot (today's
  order). If the endpoint is in `joined` → `conn.dispose()` only (the mux answers our
  `session.end` locally anyway; sending it is harmless but skip the slot release).
- The tab-lease layer is untouched: leases are keyed by (backend, targetId) and pid, and a
  joiner's pid is its own, so cross-process tab fencing works exactly as on Chrome.
- `export async function hostFirefoxMux(endpoint, opts?: {label?: string})`: a thin wrapper over
  `getConnection`'s existing holder path (slot acquire → dead-holder steal → Marionette orphan
  force-clear → dial → `startBidiMux` → `advertiseMux`) for the daemon script to call, rather
  than a second implementation of it. Requires `CDP_FIREFOX_MUX=host` in its own environment (set
  before this module is imported, so `getConnection` takes the holder path instead of recursing
  into daemon mode and spawning a second daemon); `opts.label` overrides the slot record's label
  (the daemon uses `mux-daemon(spawned by pid N)` instead of the default `pid-<pid>`, so a human
  reading the slot file sees what actually holds their browser). Rejects — closing the socket it
  just opened — if it instead lands on the JOIN path (a racing daemon or process won the slot
  first: a daemon must never join, only ever hold or refuse), or if the mux failed to start.
  Returns `{ mux, conn, dispose() }`, where `dispose()` reuses `BidiBrowserDriver.dispose()` (mux
  close → session.end → slot release) rather than re-deriving that order, so the daemon can never
  drift from it.

### 2.4 What does NOT change

- Chrome: nothing. Launch mode: each process still launches its own Firefox (the mux only
  matters when two processes share an ENDPOINT), and hosts a mux nobody joins under `host` mode —
  launch mode's default, harmless, since that Firefox and its holder already share a process
  lifetime.
- `session-coord` unit tests and `firefox:coord:smoke`: a live holder that advertises no mux (a
  foreign or older client, or `CDP_FIREFOX_MUX=off`) is still "busy", unchanged. Landed as:
  `firefox:coord:smoke` scenarios 1–4 are pinned to `CDP_FIREFOX_MUX=off` (they specifically test
  the no-mux refusal/orphan-recovery path), and a new scenario 5 covers the mux default —
  asserting the slot is held by a detached daemon rather than a server process, a second live
  process joins instead of waiting, the daemon outlives the client that spawned it, and killing
  the daemon itself still recovers through the existing dead-holder-steal + Marionette
  force-clear path.

### 2.5 Verification (the CEV ladder)

1. `bun test` green, `tsc --noEmit` green.
2. New unit tests: `test/bidi-mux.test.ts` (two `BidiConnection` clients through a mux over a
   fake upstream that answers `session.new`, echoes commands, emits events: id mapping under
   interleaving, per-client subscription refcounting, `session.end` locality, client-close
   cleanup, upstream-close fan-out), `test/mux-daemon.test.ts` (the daemon becomes the holder,
   serves a joiner, then exits on idle, freeing the slot and ending the session exactly once; two
   daemons racing for one endpoint resolve to exactly one advertiser, the other exits non-zero
   without ever joining; a daemon pointed at a dead port exits non-zero fast and leaves no slot
   record behind), and session-lease cases for `joinMux` / `advertiseMux` / the release guard /
   `CDP_FIREFOX_MUX=off`.
3. `bun run firefox:multi:smoke` — S2b must PASS with ≥2 distinct processes in flight at once.
4. `bun run firefox:coord:smoke` — orphan recovery and live-busy semantics unchanged.
5. A holder-failover scenario in the multi smoke: kill the holder process mid-run; every joiner
   completes its remaining rounds on the SAME tab after re-dialing.

### 2.6 Why the session moved into a daemon

§1.1's measurement is the whole reason: a client-hosted holder ties the real session's lifetime
to whichever agent's process happens to attach first, and every OTHER client pays for that
process exiting — even a clean exit — because Firefox regenerates every context id when the
session is re-created. The common case makes this concrete: one Claude session ends normally
while a second is still mid-task, and the second agent's cached tab ids, leases and origin
records go stale for a reason that has nothing to do with anything it did. A daemon closes that
gap by construction: **no client's lifetime is the session's lifetime.**

The final shape, `src/bidi/mux-daemon.ts` (built to `dist/bidi/mux-daemon.js`, a fourth
`scripts/build.ts` entrypoint alongside `index`/`cli`/`mcp`):

- **Argv and env.** `<endpoint> <spawnerPid>` on argv; reads the same env the driver already
  reads (`CDP_ARTIFACT_DIR`, `CDP_FIREFOX_MARIONETTE_PORT`, `CDP_FIREFOX_SESSION_WAIT_MS`) plus
  `CDP_FIREFOX_MUX_IDLE_MS`. Sets `CDP_FIREFOX_MUX=host` on itself BEFORE importing `./driver.ts`,
  so its own `getConnection` takes the in-process holder path (`hostFirefoxMux`, §2.3) rather
  than recursing into daemon mode and spawning a second daemon.
- **No console.** Spawned `detached: true, stdio: "ignore"`, `unref()`'d by its spawner (§2.3's
  `ensureMuxDaemon`), so it has no terminal and outlives the spawner's own process tree. Every
  diagnostic goes to `muxDaemonLogFile(endpoint)` —
  `<CDP_ARTIFACT_DIR or /tmp/cdp-toolkit>/ff-mux-<safeEndpoint>.log` — one timestamped, pid-stamped
  line per event, best-effort and never throwing (a daemon must not die because a log write
  failed). This is the ONLY record of why a daemon refused to start; the driver's deadline error
  names this exact path.
- **Becoming the holder.** Calls `hostFirefoxMux(endpoint, { label: "mux-daemon(spawned by pid
  N)" })` — the same acquire → dead-holder-steal → Marionette orphan force-clear → dial →
  `startBidiMux` → `advertiseMux` path an in-process holder already used, not a second
  implementation of it. If it instead lands on the JOIN path (a racing daemon or process won the
  slot first), it exits non-zero rather than serving a session it does not own — a daemon must
  never join, only ever hold or refuse.
- **Idle exit.** A daemon nobody asked for is a leak, so it watches its own client count:
  `CDP_FIREFOX_MUX_IDLE_MS` (default 15000ms) with zero clients — the clock starts at STARTUP,
  not at the first client, so a spawner that dies before ever connecting leaves nothing behind.
  It also exits the moment the upstream Firefox connection closes, or on
  `SIGTERM`/`SIGINT`/`SIGHUP`, always through the same bounded teardown (mux close → session.end →
  slot release, capped at 10s so a client that connects mid-shutdown can never hold the daemon
  open forever — the slot record left behind in that case carries a DEAD pid, which the next
  process's existing steal-and-Marionette-force-clear path already handles).
- **The spawn side, `ensureMuxDaemon` (§2.3):** read the slot first — if a live holder already
  advertises a mux, join it, no spawn needed. This is what makes every process after the first
  cheap (measured: ~31ms, joining rather than creating a session — §0). Otherwise resolve the
  daemon script and spawn it detached + unref'd, then poll the slot every 50ms up to
  `sessionWaitMs() + 5000`ms. A child that exits before advertising (busy slot, no Marionette, a
  dial error) is a fast, actionable negative — fall through to the in-process `host` path
  immediately rather than waiting out the deadline, so an unavailable browser still produces the
  existing busy/Marionette errors instead of a silent retry loop. Only hitting the full deadline
  with the child still alive throws, naming the log file.
- **Fallback, end to end.** If the daemon script cannot be resolved at all, or the daemon exits
  before advertising, the process that tried to spawn it falls straight through to the ordinary
  `host` acquire loop and becomes the holder itself — no different from `CDP_FIREFOX_MUX=host`
  set explicitly. Daemon mode can degrade to host-mode behavior; it never produces a new failure
  class the pre-mux code did not already have.

`CDP_FIREFOX_MUX=host` remains available as an explicit opt-out of the extra process, and is what
launch mode always uses (§2.4) — a launched Firefox and its holder already share a lifetime.

## 0. Outcome — measured after implementation

Implemented as designed above, with the daemon (§2.6) as the default holder in attach mode.
Verification commands, all green:

- `bun test` — 929 pass.
- `bun run typecheck` (`tsc --noEmit`) — green.
- `bun run firefox:multi:smoke` (`test/firefox-multi-agent-smoke.ts`; headless Firefox 153.0.3,
  AGENTS=4, ROUNDS=6) — 20/20 checks.
- `bun run firefox:coord:smoke` (`test/firefox-session-coord-smoke.ts`) — 11/11 (scenarios 1–4
  pinned to `CDP_FIREFOX_MUX=off`, new scenario 5 covers the default).

**Before (v2.1.0):**

| Shape | Result |
|---|---|
| S1 — one MCP server process, 4 concurrent agents, 4 tabs | PASS: 40 calls, wall 902ms vs serial sum 3133ms, 4 distinct agents in flight at once. |
| S2b — four MCP server PROCESSES on the same Firefox | FAIL: 1 of 4 agents completes; the other 3 get `held by a LIVE process` after the 8s session wait. |

**After:**

| Shape | Result |
|---|---|
| S1 | PASS: wall 955ms vs serial 3145ms, 4 in flight. |
| S2b | PASS: 40 calls, wall 437ms vs serial 1375ms, 4 distinct processes in flight; slot held by a live detached daemon (pid not among the 4 servers). |
| S3a — SIGKILL one server process mid-run, all 4 agents parked | 3 survivors finish all rounds on their original tabs, 0 retries, 0 re-resolutions; daemon unchanged; 3 in flight after the kill. |
| S3b — SIGKILL the daemon mid-run | a new daemon takes the slot (Marionette orphan recovery + fresh session); every survivor gets the stale-target error with the recovery hint (§1.1), re-finds its tab by url via `list_pages`, re-claims it, and finishes on the SAME tab (marker and round set intact); 4 in flight after the kill; 2 retries each. |
| FINAL | the daemon exits 204ms after Firefox is killed — no leak. |

**A second measured consequence, outside the smoke harness — §1.1's context-id cost, now paid
once per daemon lifetime instead of once per invocation.** Three consecutive `cdp list_pages`
calls against one attached Firefox, measured 2026-09-04 against headless Firefox 153.0.3: in the
default (`daemon`) mode all three returned the SAME tab id (calls 2 and 3 took ~31ms, joining the
already-running daemon instead of creating a session); under `CDP_FIREFOX_MUX=off` each of the
three calls returned a DIFFERENT id for the same tab. Before this change a Firefox CLI workflow of
`list_pages` then `<tool> --target <id>` could never work by id across separate invocations —
only `url:`/`title:`/`label:` selectors survived a new session; now ids stay stable for as long
as the daemon lives (the idle window, `CDP_FIREFOX_MUX_IDLE_MS`, default 15s after the last call,
or indefinitely while any MCP server keeps a client joined to it).
