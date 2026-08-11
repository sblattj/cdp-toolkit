# cdp-toolkit implementation contract

**Single source of truth for every tool module.** The goal: replicate each of the
29 `chrome-devtools-mcp` tools over raw CDP on a direct WebSocket
(`ws://127.0.0.1:9222/...`), no Puppeteer / MCP layer. Read this fully before
writing a module.

## Hard rules

1. **Zero runtime dependencies.** Use Node's global `WebSocket` (Node ≥ 22; we run 25.9) and `fetch`. The only allowed devDeps are `typescript` + `@types/node` (already installed). `lighthouse.ts` is the sole exception and shells out to a subprocess, see its section. `tsconfig.json` deliberately does NOT pull in `bun-types`, so any test or script that touches `Bun.serve` or another `Bun` global fails `tsc --noEmit` with `Cannot find name 'Bun'`. The convention is to hand-write a minimal ambient declaration in that file, scoped to just the API it uses (e.g. `declare const Bun: { serve(opts: { port: number; fetch(req: Request): Response | Promise<Response> }): { port: number; stop(): void } };`), never to add the devDependency.
2. **Build only on `src/client.ts` and `src/types.ts`.** Do not open raw `new WebSocket` yourself. Use `openPage`, `withPage`, `openBrowser`, `resolveTarget`, `CdpConnection`. This is what gives us the per-command timeout that prevents the wedged-tab hang.
3. **TypeScript strict.** `tsc --noEmit` must pass with `strict`, `noUncheckedIndexedAccess`, `verbatimModuleSyntax`. Import types with `import type`. Use `.ts` extensions in imports (e.g. `import { withPage } from "../client.ts"`).
4. **One module per assigned bundle.** Write only the files you are assigned. Never edit `client.ts`, `types.ts`, or another agent's file.
5. **Tool fn naming = camelCase of the MCP tool name.** `take_snapshot` → `export async function takeSnapshot(...)`. `list_network_requests` → `listNetworkRequests`. The integration step maps mechanically, so the names must be exact.
6. **Never re-resolve a target outside a choke point.** There are exactly three functions that turn a `TargetSelector` into a concrete tab, and all three call `assertLeaseOk`: `resolveTarget` (`src/client.ts`, Chrome), `resolveContext` (`src/bidi/driver.ts`, Firefox), and `resolvePage` (`src/shared-tools.ts`, used by `close_page`, `select_page`, and `release_page`'s `target` argument). A new tool must go through one of them. If you add a fourth resolution path, it must call `assertLeaseOk` too, or every tool on that path silently loses lease protection. Do NOT add a lease check to an individual tool: that puts the burden on every future contributor to remember it, and one forgotten tool defeats the feature for that tool. A lease conflict throws `LeaseConflictError` rather than being modelled as a capability gap under ADR-001. That departure is deliberate and reviewed: a runtime ownership collision between two agents is not a missing backend capability, so it cannot be discovered at `tools/list` time and must surface at call time. If you touch any of those three choke points, or the error handling above them, re-run `bun run lease:smoke` (`test/lease-smoke.ts`): `bun test` cannot reach this, because a lease is keyed on the claiming pid and only a second live OS process can collide with the first. That harness spawns one, drives a real browser, and asserts the refusal keeps its type, its `targetId` and its `holder` and actually blocks the side effect. It is safe against a browser with real tabs open: one throwaway tab, addressed and closed by its own id, with a runtime-captured baseline diffed at the end.

   **Under `CDP_REQUIRE_LEASE` the gate does not only check, it can ACQUIRE.** `assertLeaseOk` calls `claimLease` itself when the resolved tab is unheld and strict mode is on (see `requireLease()` and the `auto` tier in `src/leases.ts`). A fourth resolution path that skipped the choke point used to lose only enforcement; under strict mode it also loses acquisition, so a tab reached that way is silently never protected even after the flag is on. `lease:smoke`'s strict-mode phase (`CDP_REQUIRE_LEASE=1`, run as a second live process) is what actually exercises this; `bun test` cannot, since acquisition is keyed on the calling pid the same way enforcement is.

   **`claim_page{target}` is a deliberate, reviewed exception to this rule, not a violation of it.** Its target resolution goes through `pickPage` (`src/shared-tools.ts`), which is exported *specifically* for this one caller and does **not** call `assertLeaseOk`. Routing a claim through `resolvePage` instead would, under strict mode, auto-acquire a lease on the way in and then collide with the explicit claim right behind it, one call claiming the same tab against itself twice. The protection is not dropped, only relocated one layer down: `claimLease`'s own conflict check still refuses a tab any live process holds, auto-acquired or explicit, so a stranger's tab is still refused, only later and by a different function. `pickPage` must never gain a second caller without re-deriving this argument for that caller too; if it does not need gate-free resolution, it needs `resolvePage`, not `pickPage`.

   **A worker-typed hit inside `resolveTarget` is the other deliberate exception, added in 1.9.0.** A `worker:<substring>` selector (Chrome only, capability `worker.targets`; one tool in 1.9.0, `evaluate_script` — four as of 1.9.1, see `WORKER_CAPABLE_TOOLS` in `src/workers.ts`) resolves to a service/shared worker target, and `resolveTarget` returns it before reaching `assertLeaseOk` — see the comment at the top of that branch in `src/client.ts`. A lease answers "who is driving this tab"; a worker is not a tab, has no reap-meaningful close, and strict-mode auto-acquire on it would mint a lease file keyed on an id that vanishes the moment Chrome idles the worker out, garbage the page-only reap set (`ReapInput.livePageIds`) can never collect. This also cannot be used to bypass a lease on an actual tab: there is no tab a worker resolution could stand in for. **The three console/network reader tools take a parallel path, not this one** — `resolveRecorderTarget`/`resolveWorkerSelector` in `src/tools/recorder.ts`/`src/cdp/workers.ts` — but the same reasoning holds: neither touches `assertLeaseOk`, tested by asserting zero lease files on a worker read with a page control in the same strict-mode window.

   **The `TargetSelector` grammar itself also has three independent copies, a separate fact from the lease choke points above** — `pickTarget` (`src/client.ts`, what `resolveTarget` calls, and what most tools reach through), `pickPage` (`src/shared-tools.ts`), and `pickContext` (`src/bidi/driver.ts`, Firefox). A prefix arm added to one does not exist for callers routed through another; `label:` (1.9.0) was first wired into only `pickPage` and passed every unit test while `evaluate_script` still rejected it, because `evaluate_script` calls `pickTarget`, not `pickPage`, and only the live smoke caught the gap. The shared lookup core for an arm that needs identical semantics everywhere (as `label:` does) belongs in its own module — see `resolveLiveLabel` in `src/origins.ts` — wired into all three call sites, each keeping its own error class (`CdpError` / `SharedToolError` / `DriverError`). `test/manifest-grammar-drift.test.ts` structurally asserts a completeness property (every `title:` mention also mentions `label:`) and, separately, an exclusion property for `worker:` (only a tool in the `WORKER_CAPABLE_TOOLS` allowlist — four as of 1.9.1 — may name it) — grep `startsWith("title:")` across `src/` before adding a new arm, and extend or scope that test for it.

7. **Never dispatch `Input.*` outside `sendInput`.** As of 1.8.0 there is exactly one function that writes a synthesized input command to a Chrome connection: `sendInput(conn, backend, targetId, method, params)` in `src/activity.ts`. `CdpPageDriver.dispatchInput` (the per-driver choke point every interaction method already had to go through) delegates to it, and any tool built outside the Driver abstraction (`dispatch_mouse`, in `src/tools/dispatch-mouse.ts`, is the precedent) must call it directly rather than opening its own `conn.send("Input....", ...)`. This is what keeps the activity beacon's human/agent discrimination (`src/activity.ts`'s dispatch log) correct: a new input path that bypasses `sendInput` will typecheck, pass its own unit tests, and pass `bun test` in full, while silently making the toolkit's own input read as a human using the tab — exactly the 1.8.0 merge bug `test/input-dispatch-wiring.test.ts` now exists to catch (it walks every `.ts` under `src/`, strips comment-only lines, and fails on any line that both sends and names `Input.`). On the Firefox side, `BidiPageDriver.performActions` is the twin choke point and already calls `recordDispatch`; a new BiDi input path goes through it the same way `CdpPageDriver.dispatchInput` is used on Chrome. Mode-toggle commands that dispatch no page input themselves (`Input.setInterceptDrags`'s arm/disarm around HTML5 drag) are still sent through `sendInput` but are on a denylist that skips recording them — classify a new such command explicitly; the default for anything unclassified is to be logged, since over-warning a human is recoverable and silently misattributing their input to "agent" is not.

## Core client API (from `src/client.ts`)

```ts
const BASE: string;                    // http://127.0.0.1:9222 (env CDP_BASE)
const DEFAULT_TIMEOUT_MS: number;      // 15000 (env CDP_TIMEOUT_MS)
class CdpError extends Error {}

class CdpConnection {
  send<T>(method: string, params?: object, opts?: {timeoutMs?: number; sessionId?: string}): Promise<T>; // resolves to result, rejects on CDP error/timeout
  on(method: string, handler: (params, sessionId?) => void): () => void;     // returns unsubscribe; "*" = all events
  waitFor<P>(method: string, predicate?: (p: P) => boolean, timeoutMs?): Promise<P>;
  close(): void;
}

function listTargets(): Promise<Target[]>;          // GET /json/list
function browserWsUrl(): Promise<string>;           // GET /json/version -> browser endpoint
function resolveTarget(sel: TargetSelector): Promise<Target>;
function openBrowser(opts?): Promise<CdpConnection>;                 // Target.* / Browser.*
function openPage(sel, opts?): Promise<{conn: CdpConnection; target: Target}>;
function withPage<T>(sel, fn: (conn, target) => Promise<T>, opts?): Promise<T>;  // opens, runs, always closes
```

`send` returns the CDP `result` object directly. Example:
```ts
const { data } = await conn.send<{ data: string }>("Page.captureScreenshot", { format: "png" });
```

## Tool function signature convention

Every tool is an exported async function:

```ts
export interface ClickArgs { target?: TargetSelector; uid: Uid; /* ... */ }
export async function click(args: ClickArgs): Promise<unknown>;
```

- First/only param is a single typed args object. Always include `target?: TargetSelector` for page-scoped tools (defaults to the active page via `resolveTarget(undefined)`).
- **Return natural data** (plain JSON-serializable objects). For artifacts (screenshots, traces, heap snapshots) write the file and return `{ path, bytes, ... }`.
- **Throw `CdpError` (or any Error) on failure.** The dispatcher catches and wraps. Do not return error sentinels.
- Use `withPage` for stateless one-shot tools. Use a persistent `openPage` + `conn.close()` only when you must subscribe to events across time (recorder).
- Keep functions stateless except where the recorder / selected-target state file is explicitly specified below.

## Artifact + state locations

- Artifacts (PNG, trace, heapsnapshot, lighthouse report): write under `ARTIFACT_DIR` = `process.env.CDP_ARTIFACT_DIR ?? "/tmp/cdp-toolkit"`. `mkdir -p` it. Filenames: `<tool>-<targetIdShort>-<isoish>.<ext>` where you derive a stamp from `Date.now()` at call time (allowed in normal runtime; only the Workflow *script* sandbox forbids it, modules run normally). **`mkdir -p` the DIRNAME OF THE PATH BEING WRITTEN, not `ARTIFACT_DIR` unconditionally** (1.9.2): a tool taking a caller-supplied destination (`take_screenshot`'s `savePath`) otherwise creates a directory nobody writes to and then fails `ENOENT` on the one that matters.
- Selected-target state file (for `select_page`): `process.env.CDP_STATE_DIR ?? "/tmp/cdp-toolkit"` + `/selected`. Contains a bare targetId. `resolveTarget` does NOT read it; tools may read it as a fallback default if you choose, but the simplest correct behavior is fine.
- Recorder buffers: `${ARTIFACT_DIR}/rec-<targetId>.jsonl`.
- Screencast spool: `${ARTIFACT_DIR}/screencast-<targetIdShort>-<isoish>/` holding `frame-NNNNNN.jpg|png` plus the generated `frames.ffconcat`. Deleted on a successful encode; **kept, and named in the error, when ffmpeg fails**, so the frames can be re-encoded by hand instead of lost. Output video: `${ARTIFACT_DIR}/screen-recording-<targetIdShort>-<isoish>.mp4`.
- Lease files: `${ARTIFACT_DIR}/lease-<backend>-<targetId>.json`, one per leased tab, backend is `chrome` or `firefox`. Written with the `wx` exclusive-create flag so two simultaneous claims cannot both win. Keyed by backend plus id because a CDP targetId and a BiDi context id are not disjoint by construction. Carries an `auto?: boolean` field (absent, and read as `false`, on any record older than 1.7.0): `true` means the gate itself acquired it under `CDP_REQUIRE_LEASE` and it is usable by any call from the owning pid with no token; `false` means it was claimed explicitly (`claim_page` or `new_page{claim:true}`) and demands its token even from that same pid.
- Viewport records (`src/driver.ts`, added 1.9.2): `${ARTIFACT_DIR}/viewport-<scheme>-<targetId>.json`, one per target whose device-metrics override this toolkit applied, written by both drivers' `emulate()` and cleared by a confirmed `clearOverrides`. Keyed by uid scheme for the same reason lease files are keyed by backend: a CDP targetId and a BiDi context id are not disjoint by construction. It exists because `take_screenshot`'s `renderWidth`/`renderHeight` must restore the caller's PREVIOUS override, and neither a private field nor the connection can hold that: a `PageDriver` is `lifetime: "per-call"` (under the CLI, one process per call) while a device-metrics override **outlives the connection that set it** — measured, an override set in one process reads back in another. Note the honest limit this record defines: the driver can only restore an override it recorded, so one applied by the DevTools UI, another client, or a pre-1.9.2 build leaves no file and a render-size capture resets it to the real device. There is no CDP or BiDi command that reads a device-metrics override back, so a driver genuinely cannot discover it.
- Origin files (`src/origins.ts`): `${ARTIFACT_DIR}/origin-<backend>-<targetId>.json`, one per tab this toolkit itself created (never written for a tab merely claimed). Same exclusive-create discipline as lease files, same directory, and it deliberately OUTLIVES the lease: `release_page`, expiry, and reclamation never touch it, only the tab closing does (reaped on the next `list_pages`/`list_origins` read). This is what `release_page` and reap both consult to decide whether closing a given tab is this toolkit's call to make; see `src/reap.ts`'s header for the four conditions that gate a reap close. As of 1.8.0 an `expired` lease qualifies for that close only past `ttlMs + CDP_REAP_GRACE_MS` (default 45 extra minutes) — `list_leases`' `stale`/reclaimable reading is unchanged at `ttlMs`; only the destructive close moved later. `dead-pid` is unaffected by grace.
- Beacon sessions (`src/activity.ts`, `src/cdp/driver.ts`): a `BeaconSessions` pool of held Chrome connections, one per tab with an installed activity beacon, bounded at 32 with oldest-first eviction — the same module-scope pattern `recorder.ts`/`network_mock.ts` already use for their own persistent per-target sessions. Exists only because `Page.addScriptToEvaluateOnNewDocument`'s registration dies with the connection that made it (verified against a live browser, not assumed), so surviving navigation under this toolkit's per-call lifetime requires holding a connection open; eviction degrades (the current document's listeners keep answering, only the next navigation's re-arm is lost) rather than breaking. Firefox needs no equivalent: its `LifetimeModel` is `"session"`, so a `script.addPreloadScript` registration on the one memoized BiDi connection per port already lives as long as that connection does.
- The browser-session connection (`src/tools/browser-session.ts`): one lazily-opened, module-scoped connection to the CDP browser endpoint (not a page endpoint), held open for the process's life, backing `wait_for_download` and `grant_permissions`. Opened only on first use of either tool, so a session that never touches downloads or permissions pays nothing. Exists because `Browser.setDownloadBehavior` and `Browser.grantPermissions` were measured — probed against a real browser before either tool was written — to NOT persist past the arming/granting client's disconnect, which this toolkit's per-call connection lifetime would otherwise hit on every single call. Both tools are therefore MCP-server-only capabilities, the same category as `performance_start_trace`/`stop_screen_recording`'s persistent-connection requirement, for the same underlying reason.

## Firefox backend: launch vs. attach (`src/backend.ts`, `src/bidi/driver.ts`)

The Firefox/BiDi backend runs in one of two modes, selected by `resolveBackend(argv, env)`
(`src/backend.ts`) and shared by `cli.ts` and `mcp.ts`. The two modes differ in exactly one
thing — process ownership — and that difference must never blur:

- **LAUNCH** (default, no endpoint resolved): `startFirefoxSession()` calls `launchFirefox()`
  (`src/bidi/launch.ts`), which owns the spawned process end to end. `dispose()` closes the BiDi
  driver **then** kills the process, in that order, so no invocation can leak a process.
- **ATTACH** (an endpoint was resolved): `startFirefoxSession({ endpoint })` calls
  `createFirefoxDriverForEndpoint(wsUrl)` (`src/bidi/driver.ts`) directly — no `launchFirefox`,
  no process handle at all. `dispose()` is `driver.dispose()` only: it sends `session.end` (see
  below) then closes the socket. **It must never call a process `close()`; there is no process
  to close.** The Firefox the user started outlives every attach session against it.

**Config surface** (`resolveFirefoxEndpoint`, `normalizeBidiEndpoint`, `resolveBackend` in
`src/backend.ts`):

- env `CDP_FIREFOX_ENDPOINT`, CLI flag `--connect <endpoint>` — flag beats env (same precedence
  as `--browser`/`CDP_BROWSER`). An empty env value counts as unset, so an exported-but-blank
  `CDP_FIREFOX_ENDPOINT` does not force attach mode.
- `<endpoint>` accepts three spellings, all normalized by `normalizeBidiEndpoint` to a ws URL:
  bare port (`9223` → `ws://127.0.0.1:9223/session`), `host:port` (`127.0.0.1:9223` → same
  shape), or a full `ws://`/`wss://` URL (used verbatim; a bare origin with no path or `/` gets
  `/session` appended, since Firefox serves BiDi there). Invalid input (bad URL, non-numeric,
  port outside 1–65535) throws with the accepted spellings named in the message rather than
  reaching the transport as an opaque connect timeout.
- An endpoint **implies** `kind: "firefox"` in the returned `BackendSelection` — there is nothing
  else `--connect`/`CDP_FIREFOX_ENDPOINT` could mean. `resolveBackend` throws
  (`"--connect / CDP_FIREFOX_ENDPOINT is a Firefox attach option and is not valid with the
  chrome backend"`) when an endpoint is present **and** the browser was explicitly set to chrome
  (`--browser chrome` or `CDP_BROWSER=chrome`); an endpoint alongside no explicit `--browser` (or
  an explicit `--browser firefox`) silently selects Firefox as always.
- `stripConnectFlag` mirrors `stripBrowserFlag`: `cli.ts` strips `--connect <value>` out of argv
  before tool-arg parsing so it never reaches a tool's own args.

**The single-BiDi-session constraint.** Firefox allows exactly one active WebDriver BiDi session
per process; a second `session.new` against the same Firefox fails with `session.new: Maximum
number of active sessions` (verified against Firefox 153.0.3). `getConnection` in
`src/bidi/driver.ts` catches that specific message and rethrows via the local `driverError`
helper (code `"disconnected"`) naming the endpoint and explaining the fix (close the other
client, or restart Firefox), instead of letting the raw wire message reach the caller. Closing the BiDi socket alone does
**not** free the slot — only `session.end` does, which is why `BidiBrowserDriver.dispose()`
sends `session.end` (best-effort, swallowing any error — harmless if the socket is already gone)
**before** closing the connection. A client that dies without a clean dispose (e.g. `SIGKILL`)
leaves the slot occupied until Firefox restarts: this toolkit does not and cannot force-end a
session it does not own, since there is no id to end. This is why a colliding attach now fails
fast with an actionable error instead of hanging forever (the pre-1.9.4 behavior).

**Driver identity moved from port to endpoint.** `BidiBrowserDriver` is keyed by a BiDi ws
endpoint string (`this.endpoint`), not a `port: number`: a launched Firefox's endpoint is
`ws://127.0.0.1:${port}/session` (via `createFirefoxDriver(port)`), while an attach endpoint may
carry a different host, port, or path entirely (via `createFirefoxDriverForEndpoint(wsUrl)`).
Both funnel into the same `connections: Map<string, BidiConnection>` keyed by that string. Any
future change to connection identity must account for both call shapes.

## The element-reference scheme (READ if you touch snapshot or input)

A `Uid` **is** a CDP `backendDOMNodeId` (a number). This makes refs stateless:

- `take_snapshot` calls `Accessibility.getFullAXTree` (enable `Accessibility` first), walks nodes, and emits a compact indented text tree. Each interactable/meaningful node line carries its `backendDOMNodeId` as the uid, e.g.:
  ```
  [<uid>] <role> "<name>" [extra: value/checked/url]
  ```
  Return `{ snapshot: string, target: {id,url,title}, nodeCount }`.
- **Shared helper, exported from `snapshot.ts`:**
  ```ts
  export async function resolveUid(conn: CdpConnection, uid: Uid): Promise<{ objectId: string }>;
  // DOM.resolveNode({ backendNodeId: uid }) -> { object: { objectId } }
  ```
- Interaction tools (`input.ts`) import `resolveUid`, then `Runtime.callFunctionOn` on that objectId to scroll into view + read `getBoundingClientRect`, compute the center, and dispatch via `Input.dispatchMouseEvent` / `Input.dispatchKeyEvent`. Pattern for click:
  ```ts
  const { objectId } = await resolveUid(conn, uid);
  const { result } = await conn.send("Runtime.callFunctionOn", {
    objectId,
    functionDeclaration: "function(){this.scrollIntoView({block:'center',inline:'center'});const r=this.getBoundingClientRect();return {x:r.left+r.width/2,y:r.top+r.height/2};}",
    returnByValue: true,
  });
  const { x, y } = result.value;
  await conn.send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1 });
  await conn.send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1 });
  ```
  Some tools also accept a CSS `selector` as an alternative to `uid` (resolve via `Runtime.evaluate`/`DOM.querySelector`). Support both: `{ uid?: Uid; selector?: string }`, require exactly one.

## Module / tool assignments

| Module file | Tools (MCP name → fn) | Notes |
|---|---|---|
| `src/tools/pages.ts` | `list_pages`→`listPages`, `new_page`→`newPage`, `close_page`→`closePage`, `select_page`→`selectPage` | **Browser endpoint** (`openBrowser`, `Target.*`). `new_page`=`Target.createTarget`. `close_page`=`Target.closeTarget`. `select_page`=`Target.activateTarget` + write selected state file. `list_pages` may reuse `listTargets()`. |
| `src/tools/navigation.ts` | `navigate_page`→`navigatePage`, `wait_for`→`waitForText` (export as `waitFor` too) | `Page.enable` then `Page.navigate` (or `Page.reload` + `Page.getFrameTree` when `reload:true`; `ignoreCache:true` = hard reload); await `Page.frameStoppedLoading`/`Page.loadEventFired`. `wait_for` polls `Runtime.evaluate` for `document.body.innerText.includes(text)` with timeout, OR waits for a given event. |
| `src/tools/evaluate.ts` | `evaluate_script`→`evaluateScript` | `Runtime.enable` + `Runtime.evaluate` (`returnByValue`, `awaitPromise`). Support optional `args` via `Runtime.callFunctionOn` on a uid/selector. Surface `exceptionDetails` as thrown error. |
| `src/tools/snapshot.ts` | `take_snapshot`→`takeSnapshot` **+ export `resolveUid`** | a11y tree + ref scheme above. |
| `src/tools/input.ts` | `click`→`click`, `hover`→`hover`, `drag`→`drag`, `fill`→`fill`, `fill_form`→`fillForm`, `type_text`→`typeText`, `press_key`→`pressKey`, `upload_file`→`uploadFile` | imports `resolveUid` from `./snapshot.ts`. `hover`=mouseMoved. `drag`=press→move→release. `fill`/`type_text`=focus + `Input.insertText` (fast) or `dispatchKeyEvent`. `press_key`=`Input.dispatchKeyEvent` (support modifiers + named keys). `upload_file`=`DOM.setFileInputFiles` on resolved node. `fill_form`=array of {uid|selector,value}. |
| `src/tools/screenshot.ts` | `take_screenshot`→`takeScreenshot` | `Page.captureScreenshot`. Support `{ format:'png'|'jpeg', quality, fullPage, uid?/selector? (element clip via getBoxModel), savePath? }`. Write to ARTIFACT_DIR, return `{ path, bytes, format }` and optionally base64 when `{ returnBase64:true }`. **As of 1.9.2 also `scale` (Chrome-only capability `screenshot.scale`, rides `clip.scale`), `renderWidth`/`renderHeight` (BOTH backends, `screenshot.renderSize`, an `Emulation.setDeviceMetricsOverride` held for one capture and undone in a `finally` against the viewport record above), and `tile` (three-valued, `true` costs `screenshot.tile`).** Firefox declares neither `screenshot.scale` (BiDi's `captureScreenshot` has no scale parameter, so Firefox captures are always 1x) nor `screenshot.tile` — but the tile gap is moot, not a limitation: Firefox has no Chrome-style 16384-device-px encode cap to band around, so `browsingContext.captureScreenshot(origin:"document")` returns an arbitrarily long `fullPage` capture in one shot. Measured against Firefox 153.0.3: a 20,000px-tall page came back as a single 1366×20000 PNG at scale 1, verified complete top-to-bottom (no truncation). Two rules the size arithmetic imposes on anyone touching this path. **(a) Guard the projection, not the knob:** output px are `ceil(css × scale × devicePixelRatio)`, Chrome cannot encode past 16384 device px per side, and past that `Page.captureScreenshot` NEVER ANSWERS while `captureBeyondViewport` (hardcoded true) leaves the renderer resized to the clip — a wedged tab a `finally` cannot undo, because the client-side timeout fires while Chrome's command is still running. So `Page.getLayoutMetrics` is fetched and the projection checked on EVERY capture, including the plain no-clip one; a guard conditioned on the feature that motivated it (`scale !== 1`) has already let two wedges through. **(b) Bands are lazy and vertical:** past the cap the driver hands the tool layer a `BandedCapture` whose Nth `Page.captureScreenshot` runs only when the Nth band is pulled (accumulating them into an array would typecheck, pass on a small page, and hold 1.4 GB on a large one), stitched by `stitchPngBandsToFile` in `src/png.ts` — a zero-dependency streaming PNG stitcher (`node:zlib`), not an MCP tool and deliberately absent from the `TOOLS` registry. Vertical only: PNG scanlines are the one axis concatenable without decoding the image, so an over-WIDE projection is refused, never split. |
| `src/tools/emulation.ts` | `emulate`→`emulate`, `resize_page`→`resizePage` | `Emulation.setDeviceMetricsOverride` (width,height,deviceScaleFactor,mobile), `Emulation.setUserAgentOverride`, `Emulation.setCPUThrottlingRate`, `Emulation.setEmulatedMedia`, `Network`-based throttling via `Network.emulateNetworkConditions`. `resize_page` = device metrics width/height. |
| `src/tools/dialogs.ts` | `handle_dialog`→`handleDialog` | `Page.enable`, subscribe `Page.javascriptDialogOpening`, respond with `Page.handleJavaScriptDialog({ accept, promptText })`. Support a "wait for next dialog then handle" mode and an "auto-handle for N ms" mode. |
| `src/tools/recorder.ts` + `src/tools/console.ts` + `src/tools/network.ts` | console: `list_console_messages`→`listConsoleMessages`, `get_console_message`→`getConsoleMessage`; network: `list_network_requests`→`listNetworkRequests`, `get_network_request`→`getNetworkRequest` | **Owned by one agent.** `recorder.ts` exports `startRecorder(target, {network,console}): Promise<{stop()}>` that opens a persistent `openPage` conn, enables `Network`+`Runtime`(+`Log`), and appends events to `rec-<targetId>.jsonl`. console/network `list_*` read that file (and support a one-shot `{ reload:true, durationMs }` mode that records fresh by reloading the page and capturing for a window, then returns). `get_*` filter by id/url. Document the recorder model at the top of `recorder.ts`. **As of 1.9.1, the same three tools also accept a `worker:<substring>` target** (Chrome only, capability `worker.targets`; MV3 service/shared workers), resolved via `resolveRecorderTarget`/`resolveWorkerSelector` in `src/workers.ts` rather than `resolveTarget`. Because `Page.enable`/`Page.reload` do not exist on a worker session (measured: `-32601`), `captureWindow()` skips the reload for a worker-typed resolution and LISTENS on the held connection for `durationMs` instead — keyed off the resolved target's type, not the selector's shape, so a bare worker id takes the same branch as a `worker:` selector. Holding that session is a deliberate side effect, the same pattern as the beacon sessions below: it SUPPRESSES the worker's MV3 idle eviction for as long as the capture runs (measured: alive and still emitting events at 60s held, evicted ~30s after detach). `wake` (default `true` on a capture) restarts an evicted worker first, but is refused on a read-only call and on a bare target id, because a restart mints a NEW target id and the buffer is keyed by the old one — see `workerWakeMisuseMessage` in `src/workers.ts`. |
| `src/tools/performance.ts` | `performance_start_trace`→`performanceStartTrace`, `performance_stop_trace`→`performanceStopTrace`, `performance_analyze_insight`→`performanceAnalyzeInsight` | `Tracing.start`(categories incl. `devtools.timeline`,`blink.user_timing`,`loading`,`-*`), collect `Tracing.dataCollected`, `Tracing.end`→`Tracing.tracingComplete`, write trace JSON to ARTIFACT_DIR. start/stop need a persistent conn, so use a state file to hold the in-flight trace path/connection target. `performance_analyze_insight` parses a trace file for LCP, FCP/navigation timing, long tasks (>50ms), layout shifts (CLS), total blocking time; return structured metrics. **Mark in a top comment that this is a CDP-native approximation of the MCP's insight analyzer.** |
| `src/tools/screencast.ts` | `start_screen_recording`→`startScreenRecording`, `stop_screen_recording`→`stopScreenRecording` | **Toolkit addition (not MCP parity): a tab captured to an H.265 MP4.** Persistent `openPage` conn parked in a module-level `Map` keyed by targetId (recorder.ts's statefulness, performance.ts's registry), `Page.startScreencast` → `Page.screencastFrame` → **ack from the handler, before the disk write** (an unacked frame stalls the stream) → spool file + ledger row `{file,timestamp,width,height}`. Frames arrive on repaint only, so playback timing MUST come from per-frame ffconcat `duration`s off the ledger, never a fixed rate. Encoder ladder probed once from `ffmpeg -encoders`: `hevc_videotoolbox`→`h264_videotoolbox`→`libx265`→`libx264`, `-tag:v hvc1` on HEVC, always `+faststart`/`yuv420p`/even dims. ffmpeg is probed at START (fail before capturing, not after). Pure parts (`frameDurationsMs`/`buildConcatManifest`/`selectEncoder`/`buildFfmpegArgs`/`imageSize`) are unit-tested; live capture via `test/screencast-smoke.ts`. |
| `src/tools/heap.ts` | `take_heapsnapshot`→`takeHeapsnapshot` | `HeapProfiler.enable` → `HeapProfiler.takeHeapSnapshot`, assemble `HeapProfiler.addHeapSnapshotChunk` events into a `.heapsnapshot` file under ARTIFACT_DIR; return `{ path, bytes }`. |
| `src/tools/lighthouse.ts` | `lighthouse_audit`→`lighthouseAudit` | **Not pure CDP.** Spawn `npx --yes lighthouse <url> --port=9222 --output=json --output-path=<artifact> --chrome-flags=...` via `node:child_process`. If lighthouse/npx unavailable, throw a clear `CdpError` explaining the dependency. Return `{ path, categories: {performance, accessibility, ...scores} }` parsed from the JSON. Top comment must state this is the one non-CDP tool. |
| `src/tools/network_mock.ts` | `mock_request`→`mockRequest`, `list_mocks`→`listMocks`, `clear_mocks`→`clearMocks` | **Toolkit addition (not MCP parity): a persistent fake backend.** Holds a per-target session (module-level `Map`, like `recorder.ts`) with a persistent `openPage` conn and `Fetch.enable` (patterns). `Fetch.requestPaused` → `selectRule` → `Fetch.fulfillRequest`/`failRequest`/`continueRequest` (default-continue unmatched, or page hangs). Pure logic (`urlMatches`/`selectRule`/`buildFulfillParams`/`effectiveAction`) is unit-tested; I/O via `test/mock-smoke.ts`. Persistence is MCP-server-process-scoped (CLI is one-shot). Request-stage only. |

## Each module's footer

End every module with a brief block comment listing the exact CDP methods/domains used and any parity gaps vs the MCP tool (one line each). The verification phase reads these.

## Integration (built after all modules exist)

`src/index.ts` exports a `TOOLS` registry: `Record<mcpToolName, (args) => Promise<unknown>>` importing every fn. `src/cli.ts`: `bun run src/cli.ts <tool> [--target <sel>] [--json '<obj>'] [--<k> <v> ...]` → parse args, call `TOOLS[tool]`, print JSON result or `{ error }`, exit non-zero on throw. `README.md`: the full tool mapping table + usage + the "why direct CDP beats MCP for known targets" rationale.
