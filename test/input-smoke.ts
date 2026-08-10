/**
 * Live end-to-end smoke test for 1.8.0 Track P1: scroll, dispatch_mouse, and click's
 * modifiers/clickCount:3 upgrade. (P2/P3 seats extend this same file with their own scenarios.)
 *
 * SAFETY: this launches its OWN isolated headless Chrome — never the owner's live browser on
 * port 9222. Scratch port 9511, a throwaway --user-data-dir, and a throwaway CDP_ARTIFACT_DIR are
 * all created fresh under a private temp dir and torn down in `finally`. Every page this script
 * touches is one it created itself via data: URLs; nothing pre-existing is read, clicked, or
 * closed. Run with `bun run input:smoke`.
 *
 * CDP_BASE is read into a module-level const inside src/client.ts, so it (and CDP_ARTIFACT_DIR)
 * must be set in the environment BEFORE src/index.ts is ever imported — hence the dynamic import
 * below, the same trick test/lease-smoke.ts uses for the same reason.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const PORT = 9511;
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
} catch (err) {
  record("FATAL", false, err instanceof Error ? (err.stack ?? err.message) : String(err));
} finally {
  if (targetId) {
    try {
      const { TOOLS } = await import("../src/index.ts");
      await TOOLS.close_page({ target: targetId });
      record("close_page (cleanup)", true, "throwaway page closed");
    } catch (err) {
      record("close_page (cleanup)", false, err instanceof Error ? err.message : String(err));
    }
  }
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
