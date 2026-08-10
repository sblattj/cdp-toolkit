/**
 * Live end-to-end smoke test for 1.8.0 Track P: P1 (scroll, dispatch_mouse, click's
 * modifiers/clickCount:3), P2 (drag's mode:"html5", steps, to:{x,y}, by:{dx,dy}) and P3
 * (navigate_page's history:"back"|"forward", wait_for_download, grant_permissions).
 *
 * SAFETY: this launches its OWN isolated headless Chrome — never the owner's live browser on
 * port 9222. A scratch port, a throwaway --user-data-dir, and a throwaway CDP_ARTIFACT_DIR are
 * all created fresh under a private temp dir and torn down in `finally`. Every page this script
 * touches is one it created itself, via data: URLs and a loopback HTTP server this file starts and
 * stops itself; nothing pre-existing is read, clicked, or closed. Run with `bun run input:smoke`.
 *
 * ON THE PORT. The 1.8.0 spec assigns each Track P seat its own scratch port (9511/9512/9513 for
 * P1/P2/P3) so concurrent seats cannot collide. One RUN of this file can only use one of them:
 * CDP_BASE is captured into a module-level const inside src/client.ts at import time, so a second
 * browser on a second port would be unreachable from the same process. The port is therefore
 * overridable (CDP_SMOKE_PORT) and defaults to the current seat's assignment — P1 was verified on
 * 9511, P2 on 9512, P3 (and this default) on 9513.
 *
 * WHY P3 NEEDS AN HTTP ORIGIN, when P1/P2 got by on data: URLs alone. Two of P3's three features
 * are origin-scoped and simply cannot be exercised from a data: URL: `grant_permissions` keys a
 * grant by origin and a data: URL's origin is the opaque "null", and a blob download needs a real
 * document origin to be created from. So this file serves one tiny page on 127.0.0.1 (CDP port +
 * 100) for the download and permission sections, and keeps using data: URLs everywhere else.
 *
 * CDP_BASE is read into a module-level const inside src/client.ts, so it (and CDP_ARTIFACT_DIR)
 * must be set in the environment BEFORE src/index.ts is ever imported — hence the dynamic import
 * below, the same trick test/lease-smoke.ts uses for the same reason.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Minimal ambient shape for the bit of the Bun global this file uses, copied from
// test/firefox-smoke.ts's header rationale: CONTRACT.md forbids adding a bun-types devDep for a
// devDep-only need, and this is the runtime-provided global under `tsc --noEmit`'s "node" + "DOM" libs.
declare const Bun: {
  serve(opts: { port: number; fetch(req: Request): Response | Promise<Response> }): { port: number; stop(closeActiveConnections?: boolean): void };
};

const PORT = Number(process.env.CDP_SMOKE_PORT ?? 9513);
const HTTP_PORT = PORT + 100;
const ORIGIN = `http://127.0.0.1:${HTTP_PORT}`;

/** The payload the blob download carries. Its byte length is asserted against the file on disk. */
const DOWNLOAD_PAYLOAD = "HELLO-DOWNLOAD-PAYLOAD-0123456789";

/** The one page served over a real origin: a blob <a download> trigger plus a permission probe. */
const ORIGIN_PAGE = `<!doctype html><title>p3</title>
<a id="dl" href="#">download</a>
<script>
document.getElementById('dl').addEventListener('click', function(e){
  e.preventDefault();
  var b = new Blob([${JSON.stringify(DOWNLOAD_PAYLOAD)}], {type:'text/plain'});
  var a = document.createElement('a');
  a.href = URL.createObjectURL(b); a.download = 'parcel.txt';
  document.body.appendChild(a); a.click();
});
</script>`;
const CHROME_BIN =
  process.env.CDP_SMOKE_CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

type Check = { name: string; ok: boolean; detail: string };
const checks: Check[] = [];
function record(name: string, ok: boolean, detail: string): void {
  checks.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"} ${name}: ${detail}`);
}

/** Poll the DevTools HTTP endpoint until it answers or `timeoutMs` elapses. */
async function waitForChrome(base: string, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const res = await fetch(`${base}/json/version`);
      if (res.ok) return;
    } catch {
      // not up yet
    }
    if (Date.now() > deadline) throw new Error(`chrome did not open the CDP port at ${base} within ${timeoutMs}ms`);
    await new Promise((r) => setTimeout(r, 150));
  }
}

let chrome: ChildProcess | undefined;
let userDataDir = "";
let artifactDir = "";
let targetId = "";
let freshTargetId = "";

// One page, one origin, started before Chrome so the first navigation cannot race it.
const server = Bun.serve({
  port: HTTP_PORT,
  fetch: () => new Response(ORIGIN_PAGE, { headers: { "content-type": "text/html" } }),
});

try {
  userDataDir = await mkdtemp(join(tmpdir(), "cdp-input-smoke-profile-"));
  artifactDir = await mkdtemp(join(tmpdir(), "cdp-input-smoke-artifacts-"));

  chrome = spawn(
    CHROME_BIN,
    [
      "--headless=new",
      `--remote-debugging-port=${PORT}`,
      `--user-data-dir=${userDataDir}`,
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-extensions",
      "--disable-gpu",
      "about:blank",
    ],
    { stdio: "ignore" },
  );
  chrome.on("error", (e) => record("FATAL", false, `failed to spawn chrome: ${e.message}`));

  const base = `http://127.0.0.1:${PORT}`;
  await waitForChrome(base);
  record("chrome launch", true, `isolated headless chrome up on ${base}, profile ${userDataDir}`);

  process.env.CDP_BASE = base;
  process.env.CDP_ARTIFACT_DIR = artifactDir;
  process.env.CDP_STATE_DIR = artifactDir;
  const { TOOLS } = await import("../src/index.ts");

  // --- scroll: scrollable overflow div, uid/selector anchor ---
  const SCROLL_PAGE =
    "data:text/html,<title>scroll</title>" +
    "<div id=\"box\" style=\"width:200px;height:200px;overflow:auto;border:1px solid\">" +
    "<div style=\"width:2000px;height:2000px\">content</div></div>" +
    "<div style=\"height:3000px\">tall body for viewport scroll</div>";
  const created = (await TOOLS.new_page({ url: SCROLL_PAGE })) as { targetId: string };
  targetId = created.targetId;
  record("new_page", !!targetId, `targetId=${targetId.slice(0, 8)}`);

  await TOOLS.navigate_page({ target: targetId, url: SCROLL_PAGE });

  const scrollBoxResult = (await TOOLS.scroll({ target: targetId, selector: "#box", deltaY: 400, deltaX: 150 })) as {
    x: number; y: number; deltaX: number; deltaY: number;
  };
  const boxScroll = (await TOOLS.evaluate_script({
    target: targetId,
    expression: "({top: document.getElementById('box').scrollTop, left: document.getElementById('box').scrollLeft})",
  })) as { top: number; left: number };
  record(
    "scroll (selector anchor scrolls the element)",
    boxScroll.top > 0 && boxScroll.left > 0 && scrollBoxResult.deltaY === 400 && scrollBoxResult.deltaX === 150,
    `#box scrollTop=${boxScroll.top} scrollLeft=${boxScroll.left}, returned delta=(${scrollBoxResult.deltaX},${scrollBoxResult.deltaY})`,
  );

  const beforeWindowScroll = (await TOOLS.evaluate_script({ target: targetId, expression: "window.scrollY" })) as number;
  await TOOLS.scroll({ target: targetId, deltaY: 500 });
  const afterWindowScroll = (await TOOLS.evaluate_script({ target: targetId, expression: "window.scrollY" })) as number;
  record(
    "scroll (no anchor scrolls the viewport at its center)",
    afterWindowScroll > beforeWindowScroll,
    `window.scrollY ${beforeWindowScroll} -> ${afterWindowScroll}`,
  );

  let scrollThrew = false;
  try {
    await TOOLS.scroll({ target: targetId });
  } catch {
    scrollThrew = true;
  }
  record("scroll (no deltaX/deltaY throws)", scrollThrew, "scroll with no deltas rejected as expected");

  // --- dispatch_mouse: coordinate/button/modifier logger page ---
  const LOGGER_PAGE =
    "data:text/html,<title>logger</title><style>html,body{margin:0}</style>" +
    "<div id=\"log\"></div><script>" +
    "window.__events = [];" +
    "for (const t of ['mousedown','mouseup','mousemove']) {" +
    "  document.addEventListener(t, (e) => window.__events.push({" +
    "    type: t, x: e.clientX, y: e.clientY, button: e.button," +
    "    shift: e.shiftKey, ctrl: e.ctrlKey, alt: e.altKey, meta: e.metaKey" +
    "  }));" +
    "}</script>";
  await TOOLS.navigate_page({ target: targetId, url: LOGGER_PAGE });

  await TOOLS.dispatch_mouse({ target: targetId, action: "move", x: 40, y: 60 });
  await TOOLS.dispatch_mouse({ target: targetId, action: "down", x: 40, y: 60, modifiers: ["Shift"] });
  await TOOLS.dispatch_mouse({ target: targetId, action: "move", x: 80, y: 100 });
  await TOOLS.dispatch_mouse({ target: targetId, action: "up", x: 80, y: 100, modifiers: ["Shift"] });
  const events = (await TOOLS.evaluate_script({ target: targetId, expression: "window.__events" })) as Array<{
    type: string; x: number; y: number; shift: boolean;
  }>;
  const move1 = events.find((e) => e.type === "mousemove" && e.x === 40 && e.y === 60);
  const down = events.find((e) => e.type === "mousedown" && e.x === 40 && e.y === 60);
  const move2 = events.find((e) => e.type === "mousemove" && e.x === 80 && e.y === 100);
  const up = events.find((e) => e.type === "mouseup" && e.x === 80 && e.y === 100);
  record(
    "dispatch_mouse (move/down/move/up lands at the right coords)",
    !!move1 && !!down && !!move2 && !!up,
    `events=${JSON.stringify(events)}`,
  );
  record(
    "dispatch_mouse (modifiers set event.shiftKey)",
    down?.shift === true && up?.shift === true,
    `down.shift=${down?.shift}, up.shift=${up?.shift}`,
  );

  let dispatchMouseThrew = false;
  try {
    await TOOLS.dispatch_mouse({ target: targetId, action: "spin" as never, x: 1, y: 1 });
  } catch {
    dispatchMouseThrew = true;
  }
  record("dispatch_mouse (invalid action throws)", dispatchMouseThrew, "bad action rejected as expected");

  // --- click: shift-click + triple-click ---
  const CLICK_PAGE =
    "data:text/html,<title>click</title>" +
    "<p id=\"para\" onclick=\"window.__click={shift:event.shiftKey,detail:event.detail}\">" +
    "The quick brown fox jumps over the lazy dog.</p>";
  await TOOLS.navigate_page({ target: targetId, url: CLICK_PAGE });

  await TOOLS.click({ target: targetId, selector: "#para", modifiers: ["Shift"] });
  const clickInfo = (await TOOLS.evaluate_script({ target: targetId, expression: "window.__click" })) as { shift: boolean; detail: number };
  record("click (shift-click sets event.shiftKey)", clickInfo?.shift === true, `event.shiftKey=${clickInfo?.shift}`);

  await TOOLS.click({ target: targetId, selector: "#para", clickCount: 3 });
  const selectionLength = (await TOOLS.evaluate_script({
    target: targetId,
    expression: "window.getSelection().toString().length",
  })) as number;
  record("click (clickCount:3 triple-click selects the paragraph)", selectionLength > 0, `selection length=${selectionLength}`);

  /* ============================= Track P2: drag ============================= */

  /**
   * Bounded read-back poll. P1's scroll finding generalises: a CDP input dispatch is acked when
   * the event has been handed to the renderer, not when whatever it triggered has finished, so a
   * DOM read immediately after can observe the pre-event state. Polling to a deadline is honest
   * for BOTH directions — it returns as soon as the expectation holds, and for a NEGATIVE check
   * (mouse mode must NOT fire a drop) it burns the whole window before concluding "never
   * happened", which is exactly the evidence that claim needs. A blind sleep would be a guess in
   * both cases.
   */
  async function readUntil<T>(expression: string, ok: (v: T) => boolean, timeoutMs: number): Promise<T> {
    const deadline = Date.now() + timeoutMs;
    let last = (await TOOLS.evaluate_script({ target: targetId, expression })) as T;
    while (!ok(last) && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 25));
      last = (await TOOLS.evaluate_script({ target: targetId, expression })) as T;
    }
    return last;
  }

  /**
   * The HTML5 drop zone, written EXACTLY the way the HTML spec says to write one: a
   * draggable="true" source that stocks the dataTransfer in dragstart, and a zone that marks
   * itself a valid drop target by calling preventDefault inside `dragover` (MDN's canonical
   * pattern) — nothing else. No mousedown/mouseup/mousemove handler anywhere, so nothing here can
   * respond to a pointer gesture that is not a real drag; and no preventDefault in dragenter,
   * because a page that only does it in dragover is the normal case, not a corner case.
   *
   * That last detail is the whole test. Chrome 151 DOES start a real drag from synthetic mouse
   * events, so mouse mode is not inert the way the folklore says — but which drag events the page
   * receives follows the interpolated pointer path, and at the default steps:2 this page gets
   * ZERO dragover events, so the drop is refused. html5 mode dispatches dragEnter/dragOver/drop
   * explicitly at the destination and always lands. (Measured, both ways, below. steps:1 and
   * steps:8 happen to produce a dragover on this geometry and DO drop under mouse mode — which is
   * exactly why "it worked once" is not evidence and mode:"html5" is the deterministic answer.)
   */
  const DND_PAGE =
    "data:text/html,<title>dnd</title><style>html,body{margin:0}</style>" +
    "<div id='src' draggable='true' style='position:absolute;left:20px;top:20px;width:120px;height:60px;background:orange'>DRAG ME</div>" +
    "<div id='zone' style='position:absolute;left:320px;top:200px;width:200px;height:120px;background:lightgray'>EMPTY</div>" +
    "<script>" +
    "window.__dnd = {dragstart:0, dragover:0, drop:0, payload:null};" +
    "var src = document.getElementById('src'), zone = document.getElementById('zone');" +
    "src.addEventListener('dragstart', function(e){ window.__dnd.dragstart++; e.dataTransfer.setData('text/plain','PARCEL-42'); });" +
    "zone.addEventListener('dragover', function(e){ e.preventDefault(); window.__dnd.dragover++; });" +
    "zone.addEventListener('drop', function(e){ e.preventDefault(); window.__dnd.drop++;" +
    "  window.__dnd.payload = e.dataTransfer.getData('text/plain'); zone.textContent = 'DROPPED:' + window.__dnd.payload; });" +
    "</script>";
  const resetDnd = () =>
    TOOLS.evaluate_script({ target: targetId, expression: "window.__dnd = {dragstart:0, dragover:0, drop:0, payload:null}" });
  await TOOLS.navigate_page({ target: targetId, url: DND_PAGE });

  // (a1) The negative half of the proof: mode:"mouse" does NOT get the drop accepted.
  await TOOLS.drag({ target: targetId, from: { selector: "#src" }, to: { selector: "#zone" } });
  const afterMouseDrag = await readUntil<{ dragstart: number; dragover: number; drop: number }>(
    "window.__dnd", (v) => v.drop > 0, 750,
  );
  const zoneAfterMouse = (await TOOLS.evaluate_script({ target: targetId, expression: "document.getElementById('zone').textContent" })) as string;
  record(
    "drag mode:'mouse' does NOT get an HTML5 drop accepted (the gap html5 mode closes)",
    afterMouseDrag.drop === 0 && zoneAfterMouse === "EMPTY",
    `after a full mouse drag polled for 750ms: dragstart=${afterMouseDrag.dragstart} dragover=${afterMouseDrag.dragover} drop=${afterMouseDrag.drop}, zone.textContent=${JSON.stringify(zoneAfterMouse)} (the drag DID start; with no dragover the zone never became a valid drop target)`,
  );

  // (a2) The positive half: the same drag with mode:"html5" must really drop, with the payload.
  await resetDnd();
  const html5Result = (await TOOLS.drag({
    target: targetId, from: { selector: "#src" }, to: { selector: "#zone" }, mode: "html5",
  })) as { dragged: true; mode: string; steps: number; from: { x: number; y: number }; to: { x: number; y: number } };
  const afterHtml5 = await readUntil<{ dragstart: number; dragover: number; drop: number; payload: string | null }>(
    "window.__dnd", (v) => v.drop > 0, 3000,
  );
  const zoneText = (await TOOLS.evaluate_script({ target: targetId, expression: "document.getElementById('zone').textContent" })) as string;
  record(
    "drag mode:'html5' fires real dragstart/dragover/drop and carries the dataTransfer payload",
    afterHtml5.dragstart >= 1 && afterHtml5.dragover >= 1 && afterHtml5.drop === 1 && afterHtml5.payload === "PARCEL-42" && zoneText === "DROPPED:PARCEL-42",
    `dnd=${JSON.stringify(afterHtml5)}, zone.textContent=${JSON.stringify(zoneText)}, result mode=${html5Result.mode} steps=${html5Result.steps} from=(${html5Result.from.x},${html5Result.from.y}) to=(${html5Result.to.x},${html5Result.to.y})`,
  );

  // (a3) A non-draggable source must fail with the actionable error, not hang or claim success —
  // and the tab must stay usable afterwards (the finally that disables drag interception).
  let html5Error = "";
  try {
    await TOOLS.drag({ target: targetId, from: { selector: "#zone" }, to: { selector: "#src" }, mode: "html5" });
  } catch (err) {
    html5Error = err instanceof Error ? err.message : String(err);
  }
  record(
    "drag mode:'html5' on a non-draggable source fails with an actionable error",
    /never started a drag/.test(html5Error) && /draggable/.test(html5Error),
    `error=${JSON.stringify(html5Error)}`,
  );

  await resetDnd();
  await TOOLS.drag({ target: targetId, from: { selector: "#src" }, to: { selector: "#zone" }, mode: "html5" });
  const afterRecovery = await readUntil<{ drop: number }>("window.__dnd", (v) => v.drop > 0, 3000);
  record(
    "drag mode:'html5' still works after a failed html5 drag (interception is not left wedged)",
    afterRecovery.drop === 1,
    `second html5 drag after the failure: drop=${afterRecovery.drop}`,
  );

  // (a5) html5 mode is INDEPENDENT of the pointer path: the dragEnter/dragOver/drop triple is
  // dispatched at the destination whatever `steps` is. Mouse mode is not — steps:2 refuses the
  // drop on this page while steps:8 lands it, which is the coin flip html5 mode removes.
  await resetDnd();
  await TOOLS.drag({ target: targetId, from: { selector: "#src" }, to: { selector: "#zone" }, mode: "html5", steps: 1 });
  const html5Steps1 = await readUntil<{ dragover: number; drop: number }>("window.__dnd", (v) => v.drop > 0, 3000);
  await resetDnd();
  await TOOLS.drag({ target: targetId, from: { selector: "#src" }, to: { selector: "#zone" }, steps: 8 });
  const mouseSteps8 = await readUntil<{ dragover: number; drop: number }>("window.__dnd", (v) => v.drop > 0, 3000);
  record(
    "drag mode:'html5' drops regardless of steps, while mouse mode's outcome swings with the pointer path",
    html5Steps1.drop === 1 && mouseSteps8.drop === 1 && afterMouseDrag.drop === 0,
    `html5 steps:1 -> dragover=${html5Steps1.dragover} drop=${html5Steps1.drop}; mouse steps:8 -> dragover=${mouseSteps8.dragover} drop=${mouseSteps8.drop}; mouse steps:2 (default) -> drop=${afterMouseDrag.drop}`,
  );

  // (b) by:{dx,dy} and to:{x,y} against an absolutely-positioned pointer-event handle. Exact
  // pixel assertions: the handle tracks the pointer with a fixed grab offset, so a dx/dy offset
  // drag must land it exactly dx/dy from where it started.
  const HANDLE_PAGE =
    "data:text/html,<title>handle</title><style>html,body{margin:0}</style>" +
    "<div id='handle' style='position:absolute;left:60px;top:80px;width:40px;height:40px;background:teal'></div>" +
    "<script>" +
    "var h = document.getElementById('handle'), dragging = false, ox = 0, oy = 0;" +
    "h.addEventListener('mousedown', function(e){ dragging = true; ox = e.clientX - h.offsetLeft; oy = e.clientY - h.offsetTop; });" +
    "document.addEventListener('mousemove', function(e){ if (!dragging) return; h.style.left = (e.clientX - ox) + 'px'; h.style.top = (e.clientY - oy) + 'px'; });" +
    "document.addEventListener('mouseup', function(){ dragging = false; });" +
    "</script>";
  await TOOLS.navigate_page({ target: targetId, url: HANDLE_PAGE });

  const posExpr = "({left: document.getElementById('handle').offsetLeft, top: document.getElementById('handle').offsetTop})";
  const posBefore = (await TOOLS.evaluate_script({ target: targetId, expression: posExpr })) as { left: number; top: number };
  await TOOLS.drag({ target: targetId, from: { selector: "#handle" }, by: { dx: 120, dy: 60 } });
  const posAfterBy = await readUntil<{ left: number; top: number }>(posExpr, (v) => v.left === posBefore.left + 120, 2000);
  record(
    "drag by:{dx,dy} moves the handle exactly that offset",
    posAfterBy.left === posBefore.left + 120 && posAfterBy.top === posBefore.top + 60,
    `handle (${posBefore.left},${posBefore.top}) -> (${posAfterBy.left},${posAfterBy.top}), expected (${posBefore.left + 120},${posBefore.top + 60})`,
  );

  // to:{x,y}: drop the handle's CENTER on an absolute viewport point, so its top-left lands at
  // (x - 20, y - 20) for the 40x40 box.
  await TOOLS.drag({ target: targetId, from: { selector: "#handle" }, to: { x: 400, y: 300 } });
  const posAfterXY = await readUntil<{ left: number; top: number }>(posExpr, (v) => v.left === 380, 2000);
  record(
    "drag to:{x,y} drops the handle at an absolute viewport point",
    posAfterXY.left === 380 && posAfterXY.top === 280,
    `handle -> (${posAfterXY.left},${posAfterXY.top}), expected (380,280) for a 40x40 box centered on (400,300)`,
  );

  let byAndToThrew = false;
  try {
    await TOOLS.drag({ target: targetId, from: { selector: "#handle" }, to: { x: 1, y: 1 }, by: { dx: 1 } });
  } catch {
    byAndToThrew = true;
  }
  record("drag with both 'to' and 'by' throws", byAndToThrew, "to+by rejected as expected");

  // (c) steps: more interpolated moves must reach the page as more mousemove events.
  const MOVES_PAGE =
    "data:text/html,<title>moves</title><style>html,body{margin:0}</style>" +
    "<div id='a' style='position:absolute;left:10px;top:10px;width:30px;height:30px;background:orange'></div>" +
    "<div id='b' style='position:absolute;left:420px;top:320px;width:30px;height:30px;background:purple'></div>" +
    "<script>window.__moves = 0; document.addEventListener('mousemove', function(){ window.__moves++; });</script>";
  await TOOLS.navigate_page({ target: targetId, url: MOVES_PAGE });

  await TOOLS.evaluate_script({ target: targetId, expression: "window.__moves = 0" });
  await TOOLS.drag({ target: targetId, from: { selector: "#a" }, to: { selector: "#b" } });
  const movesDefault = await readUntil<number>("window.__moves", (v) => v > 0, 2000);

  await TOOLS.evaluate_script({ target: targetId, expression: "window.__moves = 0" });
  const steps8 = (await TOOLS.drag({ target: targetId, from: { selector: "#b" }, to: { selector: "#a" }, steps: 8 })) as { steps: number };
  const movesSteps8 = await readUntil<number>("window.__moves", (v) => v > movesDefault, 2000);
  record(
    "drag steps:8 dispatches more intermediate mousemove events than the default",
    movesSteps8 > movesDefault && steps8.steps === 8,
    `default(steps:2) fired ${movesDefault} mousemove events, steps:8 fired ${movesSteps8} (result.steps=${steps8.steps})`,
  );

  let badStepsThrew = false;
  try {
    await TOOLS.drag({ target: targetId, from: { selector: "#a" }, to: { selector: "#b" }, steps: 0 });
  } catch {
    badStepsThrew = true;
  }
  record("drag steps:0 throws", badStepsThrew, "steps:0 rejected as expected");

  /* ====================== Track P3: history / downloads / permissions ====================== */

  // --- navigate_page history: A -> B -> back lands on A, forward lands on B ---
  const PAGE_A = "data:text/html,<title>A</title>PAGE-A";
  const PAGE_B = "data:text/html,<title>B</title>PAGE-B";
  await TOOLS.navigate_page({ target: targetId, url: PAGE_A });
  await TOOLS.navigate_page({ target: targetId, url: PAGE_B });
  const atB = (await TOOLS.evaluate_script({ target: targetId, expression: "location.href" })) as string;

  const backResult = (await TOOLS.navigate_page({ target: targetId, history: "back" })) as {
    url: string; traversed?: string; waitedFor: string;
  };
  const atA = (await TOOLS.evaluate_script({ target: targetId, expression: "location.href" })) as string;
  record(
    "navigate_page history:'back' lands on the previous page",
    atA === PAGE_A && backResult.traversed === "back" && backResult.url === PAGE_A,
    `location ${JSON.stringify(atB)} -> ${JSON.stringify(atA)}; result.url=${JSON.stringify(backResult.url)} traversed=${backResult.traversed} waitedFor=${backResult.waitedFor}`,
  );

  const forwardResult = (await TOOLS.navigate_page({ target: targetId, history: "forward" })) as {
    url: string; traversed?: string;
  };
  const backAtB = (await TOOLS.evaluate_script({ target: targetId, expression: "location.href" })) as string;
  record(
    "navigate_page history:'forward' returns to the page we came back from",
    backAtB === PAGE_B && forwardResult.traversed === "forward" && forwardResult.url === PAGE_B,
    `location -> ${JSON.stringify(backAtB)}; result.url=${JSON.stringify(forwardResult.url)} traversed=${forwardResult.traversed}`,
  );

  let historyExclusiveThrew = "";
  try {
    await TOOLS.navigate_page({ target: targetId, url: PAGE_A, history: "back" });
  } catch (err) {
    historyExclusiveThrew = err instanceof Error ? err.message : String(err);
  }
  record(
    "navigate_page refuses url + history together",
    /mutually exclusive/.test(historyExclusiveThrew),
    `error=${JSON.stringify(historyExclusiveThrew)}`,
  );

  // back at the very start of the history stack must ERROR, never silently succeed. Needs a tab
  // with no history behind it, so this runs on a throwaway page of its own.
  const fresh = (await TOOLS.new_page({ url: "about:blank" })) as { targetId: string };
  freshTargetId = fresh.targetId;
  let backAtStartError = "";
  try {
    await TOOLS.navigate_page({ target: freshTargetId, history: "back" });
  } catch (err) {
    backAtStartError = err instanceof Error ? err.message : String(err);
  }
  const freshStillThere = (await TOOLS.evaluate_script({ target: freshTargetId, expression: "location.href" })) as string;
  record(
    "navigate_page history:'back' at the start of history ERRORS naming the direction (never a silent no-op)",
    /no history entry to go back to/.test(backAtStartError) && freshStillThere === "about:blank",
    `error=${JSON.stringify(backAtStartError)}, tab still at ${JSON.stringify(freshStillThere)}`,
  );
  await TOOLS.close_page({ target: freshTargetId });
  freshTargetId = "";

  // --- wait_for_download: arm, click in ONE tool call, collect in a LATER one ---
  await TOOLS.navigate_page({ target: targetId, url: ORIGIN });

  const armed = (await TOOLS.wait_for_download({ target: targetId, arm: true })) as {
    armed: boolean; downloadPath: string; pending: number;
  };
  record(
    "wait_for_download{arm:true} arms without waiting",
    armed.armed === true && typeof armed.downloadPath === "string" && armed.downloadPath.endsWith("/downloads"),
    `armed=${armed.armed} downloadPath=${armed.downloadPath} pending=${armed.pending}`,
  );

  // THE ordering the per-call design has to survive: the click is its own tool call (its CDP
  // connection opens and closes inside it), and the download completes while NO tool call is
  // running. Only the standing browser connection can have seen it.
  await TOOLS.click({ target: targetId, selector: "#dl" });
  const got = (await TOOLS.wait_for_download({ target: targetId, timeoutMs: 15_000 })) as {
    path: string; suggestedFilename: string; bytes: number; url?: string;
  };
  const onDisk = await readFile(got.path, "utf8");
  record(
    "wait_for_download returns a REAL file after a click made in a previous tool call",
    got.suggestedFilename === "parcel.txt" &&
      got.path.endsWith("/downloads/parcel.txt") &&
      onDisk === DOWNLOAD_PAYLOAD &&
      got.bytes === DOWNLOAD_PAYLOAD.length,
    `path=${got.path} suggestedFilename=${got.suggestedFilename} bytes=${got.bytes} (payload is ${DOWNLOAD_PAYLOAD.length} bytes), file content matches=${onDisk === DOWNLOAD_PAYLOAD}, url=${got.url?.slice(0, 24)}`,
  );

  // A second download of the SAME filename must not overwrite the first.
  await TOOLS.click({ target: targetId, selector: "#dl" });
  const got2 = (await TOOLS.wait_for_download({ target: targetId, timeoutMs: 15_000 })) as { path: string; bytes: number };
  const firstStillThere = await readFile(got.path, "utf8").catch(() => "");
  record(
    "a second download of the same name is collision-suffixed, leaving the first intact",
    got2.path.endsWith("/downloads/parcel-1.txt") && got2.bytes === DOWNLOAD_PAYLOAD.length && firstStillThere === DOWNLOAD_PAYLOAD,
    `second path=${got2.path} bytes=${got2.bytes}; first file still readable and unchanged=${firstStillThere === DOWNLOAD_PAYLOAD}`,
  );

  let downloadTimeoutError = "";
  try {
    await TOOLS.wait_for_download({ target: targetId, timeoutMs: 800 });
  } catch (err) {
    downloadTimeoutError = err instanceof Error ? err.message : String(err);
  }
  record(
    "wait_for_download times out with an actionable message when nothing downloads",
    /no download completed within 800ms/.test(downloadTimeoutError) && /arm:true/.test(downloadTimeoutError),
    `error=${JSON.stringify(downloadTimeoutError)}`,
  );

  // --- grant_permissions: geolocation flips navigator.permissions.query to "granted" ---
  const QUERY_GEO = "navigator.permissions.query({name:'geolocation'}).then(p => p.state)";
  const beforeGrant = (await TOOLS.evaluate_script({ target: targetId, expression: QUERY_GEO })) as string;
  const grantResult = (await TOOLS.grant_permissions({ target: targetId, permissions: ["geolocation"] })) as {
    granted?: string[]; origin?: string;
  };
  const afterGrant = (await TOOLS.evaluate_script({ target: targetId, expression: QUERY_GEO })) as string;
  record(
    "grant_permissions flips navigator.permissions.query(geolocation) from prompt to granted",
    beforeGrant === "prompt" && afterGrant === "granted" && grantResult.granted?.[0] === "geolocation" && grantResult.origin === ORIGIN,
    `state ${JSON.stringify(beforeGrant)} -> ${JSON.stringify(afterGrant)}; result granted=${JSON.stringify(grantResult.granted)} origin=${grantResult.origin}`,
  );

  const resetResult = (await TOOLS.grant_permissions({ target: targetId, reset: true })) as { reset?: boolean };
  const afterReset = (await TOOLS.evaluate_script({ target: targetId, expression: QUERY_GEO })) as string;
  record(
    "grant_permissions{reset:true} clears the grant again",
    resetResult.reset === true && afterReset === "prompt",
    `result=${JSON.stringify(resetResult)}, state after reset=${JSON.stringify(afterReset)}`,
  );

  let emptyPermsThrew = false;
  try {
    await TOOLS.grant_permissions({ target: targetId, permissions: [] });
  } catch {
    emptyPermsThrew = true;
  }
  record("grant_permissions with an empty permissions array throws", emptyPermsThrew, "empty permissions rejected as expected");

  // A data: URL tab has the opaque origin "null", which cannot be granted for: the refusal must
  // name the tab's url rather than surface a CDP error about a value the caller never passed.
  await TOOLS.navigate_page({ target: targetId, url: PAGE_A });
  let opaqueOriginError = "";
  try {
    await TOOLS.grant_permissions({ target: targetId, permissions: ["geolocation"] });
  } catch (err) {
    opaqueOriginError = err instanceof Error ? err.message : String(err);
  }
  record(
    "grant_permissions on an opaque-origin tab refuses with an actionable message",
    /cannot derive an origin/.test(opaqueOriginError) && /pass 'origin' explicitly/.test(opaqueOriginError),
    `error=${JSON.stringify(opaqueOriginError)}`,
  );
} catch (err) {
  record("FATAL", false, err instanceof Error ? (err.stack ?? err.message) : String(err));
} finally {
  if (freshTargetId) {
    try {
      const { TOOLS } = await import("../src/index.ts");
      await TOOLS.close_page({ target: freshTargetId });
    } catch {
      /* the history section may already have closed it */
    }
  }
  if (targetId) {
    try {
      const { TOOLS } = await import("../src/index.ts");
      await TOOLS.close_page({ target: targetId });
      record("close_page (cleanup)", true, "throwaway page closed");
    } catch (err) {
      record("close_page (cleanup)", false, err instanceof Error ? err.message : String(err));
    }
  }
  // P3's two tools hold a standing browser-endpoint connection open by design (see
  // src/tools/browser-session.ts). An open WebSocket keeps the event loop alive, so without this
  // the script would print its results and then hang forever instead of exiting.
  try {
    const { disposeBrowserSession } = await import("../src/tools/browser-session.ts");
    await disposeBrowserSession();
  } catch {
    /* never opened */
  }
  server.stop(true);
  if (chrome && !chrome.killed) chrome.kill();
  if (userDataDir) await rm(userDataDir, { recursive: true, force: true }).catch(() => undefined);
  if (artifactDir) await rm(artifactDir, { recursive: true, force: true }).catch(() => undefined);
}

const failed = checks.filter((c) => !c.ok);
console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`);
if (failed.length) {
  console.error(`FAILED: ${failed.map((c) => c.name).join(", ")}`);
  process.exit(1);
}
console.log("INPUT SMOKE OK");
