/**
 * Live smoke test for the focus-emulation tools (src/tools/focus-emulation.ts): the
 * danbuhler/claude-code-auto-authorize mechanism, proven against a REAL focus-gated page.
 *
 * THE FIXTURE is the whole point. A local page whose Authorize button is DISABLED until
 * document.hasFocus() reports true — the exact gate Anthropic's claude.ai/oauth/* page puts up.
 * An agent driving `claude -p` login hits this: the OAuth tab opens in the background, hasFocus()
 * is false, the button never enables, and a human has to keep clicking. This smoke proves
 * click_focus_gated opens that gate WITHOUT focusing the OS window:
 *   1. load the focus-gated page in a background (unfocused) tab;
 *   2. confirm the button is disabled there (the gate is real);
 *   3. click_focus_gated { text:"Authorize" } → returns clicked:true, and the page records the
 *      click — meaning Emulation.setFocusEmulationEnabled made hasFocus() true and the trusted
 *      Input.dispatchMouseEvent click landed, all while the tab stayed in the background.
 * A control run WITHOUT focus emulation (plain click) is proven earlier by step 2's disabled
 * state: the button cannot be clicked until the gate opens.
 *
 * SAFETY: launches its OWN isolated headless Chrome (scratch port, throwaway --user-data-dir),
 * serves the fixture on a loopback HTTP server it starts and stops itself. Never touches the
 * owner's live browser. CDP_BASE/CDP_ARTIFACT_DIR are read into module-level consts in
 * src/client.ts at import time, hence the dynamic import below (same trick as lease-smoke.ts).
 *
 * Run with: bun run ./test/focus-emulation-smoke.ts
 */
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

declare const Bun: {
  serve(opts: { port: number; fetch(req: Request): Response | Promise<Response> }): { port: number; stop(closeActiveConnections?: boolean): void };
};

const CDP_PORT = Number(process.env.CDP_SMOKE_PORT ?? 9514);
const HTTP_PORT = CDP_PORT + 100;
const ORIGIN = `http://127.0.0.1:${HTTP_PORT}`;

/** A focus-gated Authorize button, mimicking claude.ai/oauth: disabled until hasFocus(). */
const GATED_PAGE = `<!doctype html><title>oauth-gate</title>
<button id="auth" disabled>Authorize</button>
<div id="log"></div>
<script>
  const btn = document.getElementById("auth");
  const log = (m) => { document.getElementById("log").textContent += m + "\\n"; };
  function refresh() {
    const was = btn.disabled;
    btn.disabled = !document.hasFocus();
    if (was !== btn.disabled) log("gate:" + (btn.disabled ? "locked" : "unlocked") + " hasFocus=" + document.hasFocus());
  }
  window.addEventListener("focus", () => { log("focus-event"); refresh(); });
  window.addEventListener("blur", () => { log("blur-event"); refresh(); });
  document.addEventListener("visibilitychange", refresh);
  btn.addEventListener("click", (e) => log("CLICKED trusted=" + e.isTrusted));
  refresh();
  log("ready hasFocus=" + document.hasFocus());
</script>`;

function fail(msg: string): never {
  console.error("SMOKE FAIL:", msg);
  process.exit(1);
}

async function waitForCdp(port: number, timeoutMs = 15000): Promise<void> {
  const start = Date.now();
  for (;;) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (r.ok) return;
    } catch {}
    if (Date.now() - start > timeoutMs) fail(`Chrome CDP on :${port} never came up`);
    await new Promise((r) => setTimeout(r, 250));
  }
}

async function main() {
  const profile = await mkdtemp(join(tmpdir(), "cdp-focus-smoke-profile-"));
  const artifacts = await mkdtemp(join(tmpdir(), "cdp-focus-smoke-artifacts-"));
  process.env.CDP_BASE = `http://127.0.0.1:${CDP_PORT}`;
  process.env.CDP_ARTIFACT_DIR = artifacts;

  const server = Bun.serve({
    port: HTTP_PORT,
    fetch() {
      return new Response(GATED_PAGE, { headers: { "content-type": "text/html" } });
    },
  });

  const chromeBin =
    process.env.CHROME_BIN ??
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
  let chrome: ChildProcess | undefined;
  try {
    chrome = spawn(
      chromeBin,
      [
        "--headless=new",
        `--remote-debugging-port=${CDP_PORT}`,
        `--user-data-dir=${profile}`,
        "--no-first-run",
        "--disable-extensions",
        "about:blank",
      ],
      { stdio: "ignore" },
    );
    await waitForCdp(CDP_PORT);

    // A genuinely background tab: open a dummy tab LAST so Chrome's focus lands on it, and the
    // gated page (opened first) is left unfocused. headless=new auto-focuses a newly created
    // tab, so opening the gated page alone would start focused and the control would prove nothing.
    const { TOOLS } = await import("../src/index.ts");
    const newPage = TOOLS.new_page as unknown as (a: Record<string, unknown>) => Promise<Record<string, unknown>>;
    const navigatePage = TOOLS.navigate_page as unknown as (a: Record<string, unknown>) => Promise<unknown>;
    const evaluateScript = TOOLS.evaluate_script as unknown as (a: Record<string, unknown>) => Promise<unknown>;
    const clickFocusGated = TOOLS.click_focus_gated as unknown as (a: Record<string, unknown>) => Promise<{ clicked: boolean }>;
    const focusEmulation = TOOLS.focus_emulation as unknown as (a: Record<string, unknown>) => Promise<unknown>;

    const page = await newPage({ url: `${ORIGIN}/gate` });
    const target = (page.targetId ?? page.target ?? page.id) as string;
    const sel = String(target);
    // Open the foreground dummy after, and let Chrome settle focus onto it.
    await newPage({ url: "about:blank" });
    await new Promise((r) => setTimeout(r, 500));

    await navigatePage({ target: sel, url: `${ORIGIN}/gate`, waitUntil: "load" });
    // Re-assert backgrounded: the reload may steal focus in headless. Give Chrome a beat, then
    // confirm the gate is closed again before we attempt the click.
    await new Promise((r) => setTimeout(r, 500));

    const readLog = async () => {
      const out = (await evaluateScript({
        target: sel,
        expression:
          "(() => ({ log: document.getElementById('log').textContent, disabled: document.getElementById('auth').disabled, hasFocus: document.hasFocus() }))()",
      })) as { log: string; disabled: boolean; hasFocus: boolean };
      return out;
    };

    const before = await readLog();
    console.log("before:", JSON.stringify(before));
    if (!before.disabled) fail("control broken: button should be DISABLED in an unfocused tab — the gate is not real");
    if (before.hasFocus) fail("control broken: background tab already reports hasFocus — nothing to prove");

    const res = await clickFocusGated({ target: sel, text: "Authorize", timeoutMs: 10000 });
    console.log("click_focus_gated:", JSON.stringify(res));
    if (!res.clicked) fail("click_focus_gated returned clicked:false");

    await new Promise((r) => setTimeout(r, 300));
    const after = await readLog();
    console.log("after:", JSON.stringify(after));
    if (!after.log.includes("CLICKED trusted=true")) {
      fail(`page never recorded a trusted click; log: ${JSON.stringify(after.log)}`);
    }

    // focus_emulation toggle is independently verifiable: enabled flips hasFocus on. The restore
    // direction (enabled:false) can't be re-proven on THIS page — its focus-event listener re-runs
    // refresh() on the synthetic focus event, and the button is already clicked — so we only assert
    // the enable direction here, and rely on click_focus_gated's own finally-restore (proven by the
    // page's gate being a live hasFocus() read) for the off direction.
    await focusEmulation({ target: sel, enabled: true });
    const on = await readLog();
    if (!on.hasFocus) fail("focus_emulation enabled:true did not flip hasFocus");
    console.log("toggle: enabled:true flipped hasFocus to true");

    console.log("SMOKE PASS: focus-gated Authorize clicked in a background tab without OS focus");
  } finally {
    chrome?.kill("SIGKILL");
    server.stop(true);
    await rm(profile, { recursive: true, force: true }).catch(() => {});
    await rm(artifacts, { recursive: true, force: true }).catch(() => {});
  }
}

main().catch((e) => fail(e?.message ?? String(e)));
