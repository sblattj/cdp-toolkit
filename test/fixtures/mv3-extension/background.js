/**
 * Background service worker for the MV3 harness fixture.
 *
 * Everything here exists to be READ BACK over CDP from a test:
 *   - chrome.storage.local carries a known marker, which is the field agent's
 *     exact use case ("evaluate chrome.storage.local from my extension's SW").
 *     storage.local is persistent, so it survives idle eviction and a restart.
 *   - `starts` counts service-worker STARTUPS. It is the only observable that
 *     distinguishes "the worker was woken" from "the worker never died", so the
 *     wake-after-eviction assertion reads this and nothing else.
 *   - `__cdpToolkitFixture` is a plain global on the worker scope: it lives only
 *     in the worker's memory, so reading it proves the evaluation really landed
 *     in the WORKER context and not in some page.
 */
globalThis.__cdpToolkitFixture = "sw-alive";

// Bump the start counter. get/set is not atomic, but only one worker instance
// per extension ever runs, and the harness never races two startups.
chrome.storage.local.get({ starts: 0 }).then(({ starts }) => {
  chrome.storage.local.set({ probe: "mv3-fixture-ok", starts: starts + 1 });
});

/**
 * THE OUTBOUND REQUEST. `__cdpToolkitFetch` is the fixture's triggerable fetch:
 * the 1.9.1 network/console feature exists so that the request an MV3 background
 * worker makes to a real backend is observable, and this is the stand-in for it.
 * It is a function rather than a top-level fetch on purpose — a startup fetch
 * would race the recorder's attach, and the whole point is to observe a request
 * the worker makes WHILE something is watching.
 *
 * Host permission for http://127.0.0.1/* is in the manifest: without it the
 * worker's cross-origin fetch is blocked before a single Network event fires,
 * which looks exactly like "CDP does not see worker traffic".
 */
globalThis.__cdpToolkitFetch = async (url) => {
  const res = await fetch(url);
  const text = await res.text();
  // Logged so ONE trigger exercises both domains the recorder enables.
  console.log("mv3-fixture fetched", url, res.status, text.length);
  return { status: res.status, bytes: text.length };
};

/** Emit a console line on demand (console capture without any network traffic). */
globalThis.__cdpToolkitLog = (message) => {
  console.log("mv3-fixture says:", message);
  return "logged";
};

// A trivial message endpoint: gives a test a way to wake the worker through
// ordinary extension machinery rather than through CDP, if it ever needs one.
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg === "ping") sendResponse("pong");
  return true;
});
