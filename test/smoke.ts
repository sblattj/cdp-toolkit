/**
 * Safe end-to-end smoke test. Exercises a representative subset of the toolkit
 * against the live Chrome on CDP_BASE (default http://127.0.0.1:9222).
 *
 * SAFETY: creates its OWN throwaway page (about:blank) and operates only on it,
 * then closes it. It never touches an existing/user tab. Run with `bun run smoke`.
 */
import { TOOLS } from "../src/index.ts";

type Check = { name: string; ok: boolean; detail: string };
const checks: Check[] = [];
function record(name: string, ok: boolean, detail: string): void {
  checks.push({ name, ok, detail });
  console.log(`${ok ? "✅" : "❌"} ${name} — ${detail}`);
}

const DATA_URL =
  'data:text/html,<title>cdp-smoke</title><button id="b" onclick="window.__c=(window.__c||0)+1">go</button>' +
  '<input id="i"><script>console.log("SMOKE_CONSOLE_OK")</script>';

let targetId = "";
try {
  // --- create a throwaway page ---
  const created = (await TOOLS.new_page({ url: "about:blank" })) as { targetId: string };
  targetId = created.targetId;
  record("new_page", !!targetId, `targetId=${targetId.slice(0, 8)}`);

  // --- navigate to a self-contained data: URL ---
  await TOOLS.navigate_page({ target: targetId, url: DATA_URL });
  record("navigate_page", true, "loaded data: URL");

  // --- evaluate ---
  const ev = (await TOOLS.evaluate_script({ target: targetId, expression: "6*7" })) as unknown;
  record("evaluate_script", ev === 42, `6*7 => ${JSON.stringify(ev)}`);

  // --- snapshot + ref-based click ---
  const snap = (await TOOLS.take_snapshot({ target: targetId })) as { snapshot: string; nodeCount: number };
  record("take_snapshot", snap.nodeCount > 0, `${snap.nodeCount} a11y nodes`);
  await TOOLS.click({ target: targetId, selector: "#b" });
  const clicked = (await TOOLS.evaluate_script({ target: targetId, expression: "window.__c||0" })) as number;
  record("click (selector)", clicked === 1, `onclick counter => ${clicked}`);

  // --- reload (hard, ignoreCache) actually reloads: window.__c resets to 0 ---
  const rl = (await TOOLS.navigate_page({ target: targetId, reload: true, ignoreCache: true })) as {
    reloaded?: boolean;
    waitedFor: string;
  };
  const afterReload = (await TOOLS.evaluate_script({ target: targetId, expression: "window.__c||0" })) as number;
  record(
    "navigate_page (reload, ignoreCache)",
    rl.reloaded === true && afterReload === 0,
    `reloaded=${rl.reloaded}, counter ${clicked}→${afterReload}, waitedFor=${rl.waitedFor}`,
  );

  // --- type into the input ---
  await TOOLS.type_text({ target: targetId, selector: "#i", text: "hi-cdp" });
  const typed = (await TOOLS.evaluate_script({
    target: targetId,
    expression: "document.getElementById('i').value",
  })) as string;
  record("type_text", typed === "hi-cdp", `input value => ${JSON.stringify(typed)}`);

  // --- screenshot ---
  const shot = (await TOOLS.take_screenshot({ target: targetId })) as { bytes: number };
  record("take_screenshot", shot.bytes > 1000, `${shot.bytes} bytes`);

  // --- console capture via reload ---
  const con = (await TOOLS.list_console_messages({ target: targetId, reload: true, durationMs: 1500 })) as {
    count: number;
    messages: Array<{ text: string }>;
  };
  const sawConsole = con.messages.some((m) => m.text.includes("SMOKE_CONSOLE_OK"));
  record("list_console_messages (reload)", sawConsole, `count=${con.count}, marker=${sawConsole}`);

  // --- console NOT clobbered by a network capture (regression guard) ---
  await TOOLS.list_network_requests({ target: targetId, reload: true, durationMs: 1500 });
  const conAfter = (await TOOLS.list_console_messages({ target: targetId })) as {
    count: number;
    messages: Array<{ text: string }>;
  };
  const stillThere = conAfter.messages.some((m) => m.text.includes("SMOKE_CONSOLE_OK"));
  record("console survives network capture", stillThere, `default read count=${conAfter.count}`);

  // --- performance one-shot trace ---
  const trace = (await TOOLS.performance_trace({ target: targetId, durationMs: 1500 })) as {
    bytes: number;
    events: number;
  };
  record("performance_trace", trace.bytes > 0 && trace.events > 0, `${trace.bytes}B / ${trace.events} events`);

  // --- heap snapshot ---
  const heap = (await TOOLS.take_heapsnapshot({ target: targetId })) as { bytes: number };
  record("take_heapsnapshot", heap.bytes > 10000, `${heap.bytes} bytes`);
} catch (err) {
  record("FATAL", false, err instanceof Error ? err.message : String(err));
} finally {
  if (targetId) {
    try {
      await TOOLS.close_page({ target: targetId });
      record("close_page (cleanup)", true, "throwaway page closed");
    } catch (err) {
      record("close_page (cleanup)", false, err instanceof Error ? err.message : String(err));
    }
  }
}

const failed = checks.filter((c) => !c.ok);
console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`);
if (failed.length) {
  console.error(`FAILED: ${failed.map((c) => c.name).join(", ")}`);
  process.exit(1);
}
console.log("SMOKE OK");
