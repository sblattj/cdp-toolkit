/**
 * Unit tests for 1.8.0 Track P3: navigate_page's `history` param, the `wait_for_download` tool, and
 * the `grant_permissions` tool. Everything here runs on a pure function, a manifest entry, or a
 * stub driver — never a real browser. The live end-to-end proof is test/input-smoke.ts.
 *
 * Four properties carry this slice:
 *
 * 1. THREE-WAY EXCLUSIVITY (navigate_page). url / reload / history is the first argument group in
 *    this tool with three mutually exclusive members, and "resolve by precedence" would silently
 *    navigate somewhere the caller did not ask for. resolveNavigateMode is split out of the tool
 *    for exactly this, mirroring resolveScrollAnchor / resolveDragDestination from Track P1/P2.
 * 2. UNTRUSTED FILENAMES (wait_for_download). `suggestedFilename` is page-controlled — an <a
 *    download> attribute or a Content-Disposition header on a site the agent does not own — and it
 *    is about to be joined onto a directory path. safeFilename's traversal cases are a security
 *    boundary, not a tidiness rule, so every one of them is pinned here.
 * 3. ARGUMENT REFUSALS. Both new tools validate before touching the browser (and, for
 *    grant_permissions, before the standing connection is even opened), so the refusals are
 *    testable with no browser and no network.
 * 4. CAPABILITY GATING (ADR-001). Both new tools must be chrome-only, and navigate_page must stay
 *    universal even though it gained a param — asserted against the REAL
 *    createFirefoxDriver(0).capabilities set, the way P2 pinned drag's html5 gap.
 */
import { describe, expect, test } from "bun:test";
import type { BrowserDriver, NavigateOptions, NavigateResult, PageDriver, PageInfo } from "../src/driver.ts";
import { REQUIRED_CAPABILITIES } from "../src/driver.ts";
import { navigatePage, resolveNavigateMode } from "../src/shared-tools.ts";
import { createCdpDriver } from "../src/cdp/driver.ts";
import { createFirefoxDriver } from "../src/bidi/driver.ts";
import { nextFreeName, safeFilename, validateWaitForDownloadArgs } from "../src/tools/downloads.ts";
import { originOf, validateGrantPermissionsArgs } from "../src/tools/permissions.ts";
import { toolAvailability } from "../src/capabilities.ts";
import { MANIFEST } from "../src/manifest.ts";
import { TOOL_DOCS } from "../src/toolDocs.ts";

/* ============================ navigate_page: history mode ============================ */

describe("resolveNavigateMode (url / reload / history exclusivity)", () => {
  test("url alone is url mode", () => {
    expect(resolveNavigateMode({ url: "https://example.test/" })).toEqual({ mode: "url", url: "https://example.test/" });
  });
  test("reload alone is reload mode", () => {
    expect(resolveNavigateMode({ reload: true })).toEqual({ mode: "reload" });
  });
  test("history:'back' and history:'forward' are history mode", () => {
    expect(resolveNavigateMode({ history: "back" })).toEqual({ mode: "history", history: "back" });
    expect(resolveNavigateMode({ history: "forward" })).toEqual({ mode: "history", history: "forward" });
  });

  test("url + history is refused, naming BOTH keys rather than picking one", () => {
    expect(() => resolveNavigateMode({ url: "https://example.test/", history: "back" })).toThrow(/mutually exclusive/);
    expect(() => resolveNavigateMode({ url: "https://example.test/", history: "back" })).toThrow(/url \+ history/);
  });
  test("reload + history is refused", () => {
    expect(() => resolveNavigateMode({ reload: true, history: "forward" })).toThrow(/reload \+ history/);
  });
  test("url + reload is refused", () => {
    expect(() => resolveNavigateMode({ url: "https://example.test/", reload: true })).toThrow(/url \+ reload/);
  });
  test("all three at once names all three", () => {
    expect(() => resolveNavigateMode({ url: "https://example.test/", reload: true, history: "back" }))
      .toThrow(/url \+ reload \+ history/);
  });

  test("a history value that is not back/forward names the bad value", () => {
    expect(() => resolveNavigateMode({ history: "sideways" })).toThrow(/sideways/);
    expect(() => resolveNavigateMode({ history: "Back" })).toThrow(/Back/); // the enum is exact, not case-insensitive
    expect(() => resolveNavigateMode({ history: -1 })).toThrow(/back.*forward/);
  });

  test("nothing at all still tells the caller about all three options", () => {
    expect(() => resolveNavigateMode({})).toThrow(/'url' is required/);
    expect(() => resolveNavigateMode({})).toThrow(/history/);
  });
  test("an empty-string url counts as absent, not as a url (matching scroll's empty-selector rule)", () => {
    expect(() => resolveNavigateMode({ url: "" })).toThrow(/'url' is required/);
    expect(resolveNavigateMode({ url: "", history: "back" })).toEqual({ mode: "history", history: "back" });
  });
  test("reload:false is not 'reload given', so it does not collide with history", () => {
    expect(resolveNavigateMode({ reload: false, history: "back" })).toEqual({ mode: "history", history: "back" });
  });
});

/* ------------------------------ navigate_page wiring ------------------------------ */

const INFO: PageInfo = { id: "TAB-1", url: "https://example.test/b", title: "B", type: "page" };

/** Minimal driver stand-in recording every navigate() call, mirroring input-parity.test.ts's stub. */
function stubNavDriver(result: NavigateResult) {
  const calls: NavigateOptions[] = [];
  const page = {
    info: INFO,
    async navigate(opts: NavigateOptions): Promise<NavigateResult> {
      calls.push(opts);
      return result;
    },
    async release(): Promise<void> {},
  };
  const driver = { scheme: "cdp", async page(): Promise<PageDriver> { return page as unknown as PageDriver; } };
  return { driver: driver as unknown as BrowserDriver, calls };
}

describe("shared-tools navigatePage() wiring", () => {
  test("history reaches the driver and 'traversed' is echoed back in the result", async () => {
    const { driver, calls } = stubNavDriver({ url: "https://example.test/a", contextId: "F1", traversed: "back", waitedFor: "load" });
    const result = await navigatePage(driver, { history: "back" });
    expect(calls[0]?.history).toBe("back");
    expect(result).toEqual({ url: "https://example.test/a", frameId: "F1", traversed: "back", waitedFor: "load" });
  });

  test("an ordinary navigation carries neither reloaded nor traversed", async () => {
    const { driver, calls } = stubNavDriver({ url: "https://example.test/x", contextId: "F1", waitedFor: "load" });
    const result = await navigatePage(driver, { url: "https://example.test/x" });
    expect(calls[0]?.history).toBeUndefined();
    expect(result).toEqual({ url: "https://example.test/x", frameId: "F1", waitedFor: "load" });
  });

  test("a reload still reports reloaded and never traversed", async () => {
    const { driver } = stubNavDriver({ url: "https://example.test/b", contextId: "F1", reloaded: true, waitedFor: "load" });
    const result = await navigatePage(driver, { reload: true });
    expect(result).toEqual({ url: "https://example.test/b", frameId: "F1", reloaded: true, waitedFor: "load" });
  });

  test("an exclusivity violation throws BEFORE the page is ever acquired", async () => {
    const { driver, calls } = stubNavDriver({ url: "u", contextId: "F1", waitedFor: "load" });
    await expect(navigatePage(driver, { url: "https://example.test/", history: "back" })).rejects.toThrow(/mutually exclusive/);
    expect(calls).toEqual([]);
  });

  test("the BiDi 'timeout' waitedFor a traversal can return maps onto the legacy vocabulary", async () => {
    // settleAfterTraversal returns "timeout" when it cannot confirm the milestone; the tool must
    // still answer with the legacy word ("navigate-only"), never leak the Driver's own vocabulary.
    const { driver } = stubNavDriver({ url: "https://example.test/a", contextId: "C1", traversed: "forward", waitedFor: "timeout" });
    const result = await navigatePage(driver, { history: "forward" });
    expect(result.waitedFor).toBe("navigate-only");
    expect(result.traversed).toBe("forward");
  });
});

/* ============================ wait_for_download: pure helpers ============================ */

describe("safeFilename (page-controlled name -> safe to join onto a directory)", () => {
  test("an ordinary filename survives untouched", () => {
    expect(safeFilename("report.csv")).toBe("report.csv");
    expect(safeFilename("My Report (final).xlsx")).toBe("My Report (final).xlsx");
  });
  test("relative traversal cannot escape the downloads directory", () => {
    expect(safeFilename("../../../../etc/cron.d/pwn")).toBe("pwn");
    expect(safeFilename("../secrets.env")).toBe("secrets.env");
  });
  test("an absolute path is reduced to its last segment", () => {
    expect(safeFilename("/etc/passwd")).toBe("passwd");
    expect(safeFilename("/tmp/a/b/c.txt")).toBe("c.txt");
  });
  test("a windows-style path cannot survive on a posix host", () => {
    expect(safeFilename("..\\..\\Windows\\System32\\drivers\\etc\\hosts")).toBe("hosts");
    expect(safeFilename("C:\\Users\\me\\report.csv")).toBe("report.csv");
  });
  test("a name that is only traversal falls back to a fixed name rather than an empty path", () => {
    expect(safeFilename("..")).toBe("download");
    expect(safeFilename(".")).toBe("download");
    expect(safeFilename("/")).toBe("download");
    expect(safeFilename("")).toBe("download");
    expect(safeFilename(undefined)).toBe("download");
    expect(safeFilename("   ")).toBe("download");
  });
  test("control characters are stripped (a newline in a Content-Disposition header)", () => {
    expect(safeFilename("re\u0000port.csv")).toBe("report.csv");
    expect(safeFilename("a\nb.txt")).toBe("ab.txt");
  });
  test("the result never contains a path separator, for any input", () => {
    for (const bad of ["../../x", "/a/b", "a\\b", "..", "", "\u0000/etc/passwd"]) {
      const out = safeFilename(bad);
      expect(out.includes("/"), bad).toBe(false);
      expect(out.includes("\\"), bad).toBe(false);
      expect(out.length).toBeGreaterThan(0);
    }
  });
});

describe("nextFreeName (collision suffixing)", () => {
  test("an unused name is returned unchanged", () => {
    expect(nextFreeName("report.csv", new Set())).toBe("report.csv");
    expect(nextFreeName("report.csv", new Set(["other.csv"]))).toBe("report.csv");
  });
  test("the suffix goes BEFORE the extension so the file type is preserved", () => {
    expect(nextFreeName("report.csv", new Set(["report.csv"]))).toBe("report-1.csv");
  });
  test("consecutive collisions count up", () => {
    expect(nextFreeName("report.csv", new Set(["report.csv", "report-1.csv"]))).toBe("report-2.csv");
    expect(nextFreeName("r.csv", new Set(["r.csv", "r-1.csv", "r-2.csv", "r-3.csv"]))).toBe("r-4.csv");
  });
  test("an extensionless name just gets the suffix appended", () => {
    expect(nextFreeName("LICENSE", new Set(["LICENSE"]))).toBe("LICENSE-1");
  });
  test("a multi-dot name only splits on the LAST extension", () => {
    expect(nextFreeName("archive.tar.gz", new Set(["archive.tar.gz"]))).toBe("archive.tar-1.gz");
  });
});

describe("validateWaitForDownloadArgs", () => {
  test("no args, and each valid arg, pass", () => {
    expect(() => validateWaitForDownloadArgs({})).not.toThrow();
    expect(() => validateWaitForDownloadArgs({ timeoutMs: 1000 })).not.toThrow();
    expect(() => validateWaitForDownloadArgs({ arm: true })).not.toThrow();
    expect(() => validateWaitForDownloadArgs({ arm: false, timeoutMs: 5 })).not.toThrow();
  });
  test("a non-positive or non-numeric timeoutMs is refused", () => {
    expect(() => validateWaitForDownloadArgs({ timeoutMs: 0 })).toThrow(/positive number/);
    expect(() => validateWaitForDownloadArgs({ timeoutMs: -1 })).toThrow(/positive number/);
    expect(() => validateWaitForDownloadArgs({ timeoutMs: Number.NaN })).toThrow(/positive number/);
    expect(() => validateWaitForDownloadArgs({ timeoutMs: "30s" as never })).toThrow(/positive number/);
  });
  test("a non-boolean arm is refused rather than coerced", () => {
    expect(() => validateWaitForDownloadArgs({ arm: "yes" as never })).toThrow(/must be a boolean/);
  });
});

/* ============================ grant_permissions: pure helpers ============================ */

describe("originOf (the default origin for a grant)", () => {
  test("an http(s) url yields its origin, port included", () => {
    expect(originOf("https://example.com/a/b?c=1")).toBe("https://example.com");
    expect(originOf("http://127.0.0.1:9613/page")).toBe("http://127.0.0.1:9613");
  });
  test("an opaque origin is undefined, NOT the string 'null'", () => {
    // These are exactly the urls a smoke/test page tends to have, so the tool has to refuse them
    // with an actionable message rather than pass "null" to CDP.
    expect(originOf("data:text/html,<title>x</title>")).toBeUndefined();
    expect(originOf("about:blank")).toBeUndefined();
  });
  test("an unparseable url is undefined rather than a throw", () => {
    expect(originOf("")).toBeUndefined();
    expect(originOf("not a url")).toBeUndefined();
  });
});

describe("validateGrantPermissionsArgs", () => {
  test("a non-empty permissions array passes", () => {
    expect(() => validateGrantPermissionsArgs({ permissions: ["geolocation"] })).not.toThrow();
    expect(() => validateGrantPermissionsArgs({ permissions: ["geolocation", "notifications"], origin: "https://a.test" })).not.toThrow();
  });
  test("omitting permissions is refused unless reset:true (reset-only is the one legal no-grant call)", () => {
    expect(() => validateGrantPermissionsArgs({})).toThrow(/'permissions' is required/);
    expect(() => validateGrantPermissionsArgs({ reset: true })).not.toThrow();
  });
  test("an EMPTY permissions array is refused rather than reported as a successful no-op", () => {
    expect(() => validateGrantPermissionsArgs({ permissions: [] })).toThrow(/must not be empty/);
    // ...except alongside reset:true, where the call still does something real.
    expect(() => validateGrantPermissionsArgs({ permissions: [], reset: true })).not.toThrow();
  });
  test("a non-array permissions value is refused", () => {
    expect(() => validateGrantPermissionsArgs({ permissions: "geolocation" as never })).toThrow(/must be an array/);
  });
  test("a non-string or empty entry is refused, showing the bad entry", () => {
    expect(() => validateGrantPermissionsArgs({ permissions: ["geolocation", 7 as never] })).toThrow(/non-empty string/);
    expect(() => validateGrantPermissionsArgs({ permissions: [""] })).toThrow(/non-empty string/);
  });
  test("a non-boolean reset is refused rather than coerced", () => {
    expect(() => validateGrantPermissionsArgs({ permissions: ["geolocation"], reset: "yes" as never })).toThrow(/must be a boolean/);
  });
});

/* ============================== capability gating (ADR-001) ============================== */

describe("capability gating (absent from tools/list, never present-and-throwing)", () => {
  const chromeCaps = createCdpDriver().capabilities;
  const firefoxCaps = createFirefoxDriver(0).capabilities;
  const chrome = toolAvailability("chrome");
  const firefox = toolAvailability("firefox");

  test("wait_for_download is chrome-only", () => {
    expect(chrome.available).toContain("wait_for_download");
    expect(firefox.available).not.toContain("wait_for_download");
    expect(firefox.unavailable.find((u) => u.name === "wait_for_download")?.missing).toEqual(["browser.downloads"]);
  });
  test("grant_permissions is chrome-only", () => {
    expect(chrome.available).toContain("grant_permissions");
    expect(firefox.available).not.toContain("grant_permissions");
    expect(firefox.unavailable.find((u) => u.name === "grant_permissions")?.missing).toEqual(["browser.permissions"]);
  });

  test("the REAL driver capability sets back those gates", () => {
    // Asserted against the drivers themselves, not against toolAvailability's view of them, so a
    // capability quietly added to BIDI_CAPABILITIES cannot make these tools appear under Firefox
    // while this test still passes.
    expect(chromeCaps.has("browser.downloads")).toBe(true);
    expect(chromeCaps.has("browser.permissions")).toBe(true);
    expect(firefoxCaps.has("browser.downloads")).toBe(false);
    expect(firefoxCaps.has("browser.permissions")).toBe(false);
  });

  test("navigate_page stays UNIVERSAL even though it gained a param", () => {
    // history is implemented on both backends, so this is a whole-tool capability question with the
    // answer "no capability at all" — the opposite of drag's chrome-only html5 param gap.
    expect(chrome.available).toContain("navigate_page");
    expect(firefox.available).toContain("navigate_page");
    expect(REQUIRED_CAPABILITIES.navigate_page).toBeUndefined();
  });

  test("REQUIRED_CAPABILITIES names exactly one capability for each new tool", () => {
    expect(REQUIRED_CAPABILITIES.wait_for_download).toEqual(["browser.downloads"]);
    expect(REQUIRED_CAPABILITIES.grant_permissions).toEqual(["browser.permissions"]);
  });
});

/* ================================== manifest contract ================================== */

describe("manifest entries for Track P3", () => {
  const spec = (name: string) => MANIFEST.find((s) => s.name === name);

  test("both new tools have a manifest schema", () => {
    expect(MANIFEST.map((s) => s.name)).toContain("wait_for_download");
    expect(MANIFEST.map((s) => s.name)).toContain("grant_permissions");
  });

  test("navigate_page advertises history as a back/forward enum and documents the traversed field", () => {
    const s = spec("navigate_page")!;
    const history = (s.inputSchema.properties as Record<string, { enum?: string[] }>).history;
    expect(history?.enum).toEqual(["back", "forward"]);
    const d = TOOL_DOCS["navigate_page"].description;
    expect(d).toContain("history:'back'|'forward'");
    expect(d).toContain("traversed");
    // The exclusivity rule has to be discoverable from the description, since the schema cannot
    // express "exactly one of these three".
    expect(d).toContain("Exactly one of url / reload / history");
  });

  test("wait_for_download documents the arm-before-click ordering AND the browser-global side effect", () => {
    // Both are load-bearing for a caller: the first decides whether they get a file at all, the
    // second is a change to where EVERY download in the browser lands, including the user's own.
    const d = TOOL_DOCS["wait_for_download"].description;
    expect(d).toContain("ARMED BEFORE");
    expect(d).toContain("browser-global");
    expect(d).toMatch(/every download in this browser/i);
    expect(d).toContain("arm:true");
    expect(d).toContain("browser.downloads");
  });

  test("grant_permissions documents origin-keying, reset semantics, and the per-connection lifetime", () => {
    const d = TOOL_DOCS["grant_permissions"].description;
    expect(d).toMatch(/keyed by ORIGIN/i);
    expect(d).toContain("reset:true");
    expect(d).toMatch(/DISCARDS IT when that connection closes/i);
    expect(d).toContain("browser.permissions");
  });

  test("neither new tool makes any argument required", () => {
    // wait_for_download{} and grant_permissions{reset:true} are both complete calls; a required
    // key here would break them at the schema layer before the runtime validators ever ran.
    expect(spec("wait_for_download")!.inputSchema.required ?? []).toEqual([]);
    expect(spec("grant_permissions")!.inputSchema.required ?? []).toEqual([]);
  });
});
