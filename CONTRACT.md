# cdp-toolkit — implementation contract

**Single source of truth for every tool module.** The goal: replicate each of the
29 `chrome-devtools-mcp` tools over raw CDP on a direct WebSocket
(`ws://127.0.0.1:9222/...`), no Puppeteer / MCP layer. Read this fully before
writing a module.

## Hard rules

1. **Zero runtime dependencies.** Use Node's global `WebSocket` (Node ≥ 22; we run 25.9) and `fetch`. The only allowed devDeps are `typescript` + `@types/node` (already installed). `lighthouse.ts` is the sole exception and shells out to a subprocess — see its section.
2. **Build only on `src/client.ts` and `src/types.ts`.** Do not open raw `new WebSocket` yourself. Use `openPage`, `withPage`, `openBrowser`, `resolveTarget`, `CdpConnection`. This is what gives us the per-command timeout that prevents the wedged-tab hang.
3. **TypeScript strict.** `tsc --noEmit` must pass with `strict`, `noUncheckedIndexedAccess`, `verbatimModuleSyntax`. Import types with `import type`. Use `.ts` extensions in imports (e.g. `import { withPage } from "../client.ts"`).
4. **One module per assigned bundle.** Write only the files you are assigned. Never edit `client.ts`, `types.ts`, or another agent's file.
5. **Tool fn naming = camelCase of the MCP tool name.** `take_snapshot` → `export async function takeSnapshot(...)`. `list_network_requests` → `listNetworkRequests`. The integration step maps mechanically, so the names must be exact.

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

- Artifacts (PNG, trace, heapsnapshot, lighthouse report): write under `ARTIFACT_DIR` = `process.env.CDP_ARTIFACT_DIR ?? "/tmp/cdp-toolkit"`. `mkdir -p` it. Filenames: `<tool>-<targetIdShort>-<isoish>.<ext>` where you derive a stamp from `Date.now()` at call time (allowed in normal runtime; only the Workflow *script* sandbox forbids it — modules run normally).
- Selected-target state file (for `select_page`): `process.env.CDP_STATE_DIR ?? "/tmp/cdp-toolkit"` + `/selected`. Contains a bare targetId. `resolveTarget` does NOT read it; tools may read it as a fallback default if you choose, but the simplest correct behavior is fine.
- Recorder buffers: `${ARTIFACT_DIR}/rec-<targetId>.jsonl`.

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
| `src/tools/screenshot.ts` | `take_screenshot`→`takeScreenshot` | `Page.captureScreenshot`. Support `{ format:'png'|'jpeg', quality, fullPage, uid?/selector? (element clip via getBoxModel), savePath? }`. Write to ARTIFACT_DIR, return `{ path, bytes, format }` and optionally base64 when `{ returnBase64:true }`. |
| `src/tools/emulation.ts` | `emulate`→`emulate`, `resize_page`→`resizePage` | `Emulation.setDeviceMetricsOverride` (width,height,deviceScaleFactor,mobile), `Emulation.setUserAgentOverride`, `Emulation.setCPUThrottlingRate`, `Emulation.setEmulatedMedia`, `Network`-based throttling via `Network.emulateNetworkConditions`. `resize_page` = device metrics width/height. |
| `src/tools/dialogs.ts` | `handle_dialog`→`handleDialog` | `Page.enable`, subscribe `Page.javascriptDialogOpening`, respond with `Page.handleJavaScriptDialog({ accept, promptText })`. Support a "wait for next dialog then handle" mode and an "auto-handle for N ms" mode. |
| `src/tools/recorder.ts` + `src/tools/console.ts` + `src/tools/network.ts` | console: `list_console_messages`→`listConsoleMessages`, `get_console_message`→`getConsoleMessage`; network: `list_network_requests`→`listNetworkRequests`, `get_network_request`→`getNetworkRequest` | **Owned by one agent.** `recorder.ts` exports `startRecorder(target, {network,console}): Promise<{stop()}>` that opens a persistent `openPage` conn, enables `Network`+`Runtime`(+`Log`), and appends events to `rec-<targetId>.jsonl`. console/network `list_*` read that file (and support a one-shot `{ reload:true, durationMs }` mode that records fresh by reloading the page and capturing for a window, then returns). `get_*` filter by id/url. Document the recorder model at the top of `recorder.ts`. |
| `src/tools/performance.ts` | `performance_start_trace`→`performanceStartTrace`, `performance_stop_trace`→`performanceStopTrace`, `performance_analyze_insight`→`performanceAnalyzeInsight` | `Tracing.start`(categories incl. `devtools.timeline`,`blink.user_timing`,`loading`,`-*`), collect `Tracing.dataCollected`, `Tracing.end`→`Tracing.tracingComplete`, write trace JSON to ARTIFACT_DIR. start/stop need a persistent conn — use a state file to hold the in-flight trace path/connection target. `performance_analyze_insight` parses a trace file for LCP, FCP/navigation timing, long tasks (>50ms), layout shifts (CLS), total blocking time; return structured metrics. **Mark in a top comment that this is a CDP-native approximation of the MCP's insight analyzer.** |
| `src/tools/heap.ts` | `take_heapsnapshot`→`takeHeapsnapshot` | `HeapProfiler.enable` → `HeapProfiler.takeHeapSnapshot`, assemble `HeapProfiler.addHeapSnapshotChunk` events into a `.heapsnapshot` file under ARTIFACT_DIR; return `{ path, bytes }`. |
| `src/tools/lighthouse.ts` | `lighthouse_audit`→`lighthouseAudit` | **Not pure CDP.** Spawn `npx --yes lighthouse <url> --port=9222 --output=json --output-path=<artifact> --chrome-flags=...` via `node:child_process`. If lighthouse/npx unavailable, throw a clear `CdpError` explaining the dependency. Return `{ path, categories: {performance, accessibility, ...scores} }` parsed from the JSON. Top comment must state this is the one non-CDP tool. |
| `src/tools/network_mock.ts` | `mock_request`→`mockRequest`, `list_mocks`→`listMocks`, `clear_mocks`→`clearMocks` | **Toolkit addition (not MCP parity) — a persistent fake backend.** Holds a per-target session (module-level `Map`, like `recorder.ts`) with a persistent `openPage` conn and `Fetch.enable` (patterns). `Fetch.requestPaused` → `selectRule` → `Fetch.fulfillRequest`/`failRequest`/`continueRequest` (default-continue unmatched, or page hangs). Pure logic (`urlMatches`/`selectRule`/`buildFulfillParams`/`effectiveAction`) is unit-tested; I/O via `test/mock-smoke.ts`. Persistence is MCP-server-process-scoped (CLI is one-shot). Request-stage only. |

## Each module's footer

End every module with a brief block comment listing the exact CDP methods/domains used and any parity gaps vs the MCP tool (one line each). The verification phase reads these.

## Integration (built after all modules exist)

`src/index.ts` exports a `TOOLS` registry: `Record<mcpToolName, (args) => Promise<unknown>>` importing every fn. `src/cli.ts`: `bun run src/cli.ts <tool> [--target <sel>] [--json '<obj>'] [--<k> <v> ...]` → parse args, call `TOOLS[tool]`, print JSON result or `{ error }`, exit non-zero on throw. `README.md`: the full 29-tool mapping table + usage + the "why direct CDP beats MCP for known targets" rationale.
