/**
 * End-to-end smoke for network mocking (mock_request / list_mocks / clear_mocks)
 * against the live Chrome on CDP_BASE (default http://127.0.0.1:9222).
 *
 * HERMETIC: it mocks https://mock.invalid/* — CDP Fetch intercepts at the REQUEST
 * stage (before DNS), so the canned response is served with no real network. The
 * page fetches that URL; we assert it receives the mocked body, that list_mocks
 * reports the active session + hit, that clear_mocks tears it down, and that the
 * fetch then genuinely fails (proving interception stopped).
 *
 * SAFETY: creates its OWN throwaway tab and clears mocks + closes it in finally.
 * Run with `bun run mock:smoke`.
 */
import { TOOLS } from "../src/index.ts";

type Check = { name: string; ok: boolean; detail: string };
const checks: Check[] = [];
function record(name: string, ok: boolean, detail: string): void {
  checks.push({ name, ok, detail });
  console.log(`${ok ? "✅" : "❌"} ${name} — ${detail}`);
}

// A page that, on load, fetches the (to-be-mocked) URL and stashes the result.
const FETCH_PAGE =
  "data:text/html,<title>mock-smoke</title><script>window.__m='PENDING';" +
  "fetch('https://mock.invalid/api/test').then(r=>r.json()).then(d=>{window.__m=JSON.stringify(d)})" +
  ".catch(e=>{window.__mErr=String(e)})</script>";

/** Poll a page expression until it is set (not undefined/null/'PENDING') or timeout. */
async function poll(target: string, expression: string, timeoutMs = 4000): Promise<unknown> {
  const start = Date.now();
  let v: unknown;
  do {
    v = await TOOLS.evaluate_script({ target, expression });
    if (v !== undefined && v !== null && v !== "PENDING") return v;
    await new Promise((r) => setTimeout(r, 100));
  } while (Date.now() - start < timeoutMs);
  return v;
}

let targetId = "";
try {
  const created = (await TOOLS.new_page({ url: "about:blank" })) as { targetId: string };
  targetId = created.targetId;
  record("new_page", !!targetId, `targetId=${targetId.slice(0, 8)}`);

  // --- arm the fake backend BEFORE the page makes the request ---
  const armed = (await TOOLS.mock_request({
    target: targetId,
    urlPattern: "*mock.invalid*",
    body: '{"ok":true,"from":"mock"}',
    headers: { "Access-Control-Allow-Origin": "*" }, // data: origin is "null" → needs ACAO
  })) as { ruleCount: number; pattern: string };
  record("mock_request (arm)", armed.ruleCount === 1 && armed.pattern === "*mock.invalid*", `ruleCount=${armed.ruleCount}`);

  // --- navigate to a page that fetches the mocked URL, then read the result ---
  await TOOLS.navigate_page({ target: targetId, url: FETCH_PAGE });
  const got = await poll(targetId, "window.__m");
  let parsed: { ok?: boolean; from?: string } | undefined;
  try {
    parsed = JSON.parse(String(got));
  } catch {
    /* leave undefined */
  }
  record("fulfilled with canned body", parsed?.ok === true && parsed?.from === "mock", `window.__m=${got}`);

  // --- list_mocks reports the active session and a hit ---
  const list = (await TOOLS.list_mocks({})) as { count: number; mocks: Array<{ hits: number }> };
  record(
    "list_mocks shows active session w/ hit",
    list.count === 1 && (list.mocks[0]?.hits ?? 0) >= 1,
    `count=${list.count}, hits=${list.mocks[0]?.hits}`,
  );

  // --- clear everything ---
  const cleared = (await TOOLS.clear_mocks({ all: true })) as { cleared: number };
  record("clear_mocks", cleared.cleared === 1, `cleared=${cleared.cleared}`);
  const list2 = (await TOOLS.list_mocks({})) as { count: number };
  record("list_mocks empty after clear", list2.count === 0, `count=${list2.count}`);

  // --- prove interception stopped: mock.invalid now fails to resolve ---
  await TOOLS.navigate_page({ target: targetId, url: FETCH_PAGE });
  const err = await poll(targetId, "window.__mErr");
  record("interception stopped after clear", typeof err === "string" && err.length > 0, `window.__mErr=${err}`);
} catch (err) {
  record("FATAL", false, err instanceof Error ? err.message : String(err));
} finally {
  try {
    await TOOLS.clear_mocks({ all: true });
  } catch {
    /* ignore */
  }
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
console.log("MOCK SMOKE OK");
