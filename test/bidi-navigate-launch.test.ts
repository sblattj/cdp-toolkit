/**
 * Firefox BiDi navigation fixes: reload ignoreCache handling, the file:// access-denied
 * error mapping, and the launch-profile user.js seeding (#6).
 *
 * The reload regression being pinned here: browsingContext.reload used to send
 * `ignoreCache: false` unconditionally, and Firefox's BiDi server rejects the KEY —
 * regardless of value — with `Argument "ignoreCache" is not supported yet`. So every
 * plain reload:true on Firefox failed, not just hard reloads. The driver now omits the
 * key entirely on plain reloads and fails fast with a capability error when true.
 *
 * The file:// mapping: NS_ERROR_FILE_ACCESS_DENIED must reach the caller with the
 * snap/AppArmor explanation and the http-server way out, not the bare nsresult.
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BidiPageDriver } from "../src/bidi/driver.ts";
import { BidiError } from "../src/bidi/client.ts";
import type { BidiConnection } from "../src/bidi/client.ts";
import type { BrowserDriver, PageInfo } from "../src/driver.ts";
import { writeLaunchUserJs } from "../src/bidi/launch.ts";

interface CapturedCall {
  method: string;
  params: Record<string, unknown>;
}

/** A BidiConnection double that records every command and answers from a script. */
function fakeConn(responses: Array<(call: CapturedCall) => unknown> | ((call: CapturedCall) => unknown)) {
  const calls: CapturedCall[] = [];
  const conn = {
    async send(method: string, params: Record<string, unknown>): Promise<unknown> {
      const call = { method, params };
      calls.push(call);
      const handler = Array.isArray(responses) ? responses[Math.min(calls.length - 1, responses.length - 1)] : responses;
      return handler(call);
    },
  } as unknown as BidiConnection;
  return { conn, calls };
}

function page(conn: BidiConnection): BidiPageDriver {
  return new BidiPageDriver(
    conn,
    "ctx-1",
    { id: "ctx-1", url: "about:blank", title: "" } as unknown as PageInfo,
    {} as unknown as BrowserDriver,
  );
}

describe("bidi navigate: browsingContext.reload and ignoreCache", () => {
  test("a plain reload OMITS the ignoreCache key — Firefox rejects the key even when false", async () => {
    const { conn, calls } = fakeConn(() => ({ url: "https://example.test/" }));
    const r = await page(conn).navigate({ reload: true });
    expect(calls.map((c) => c.method)).toEqual(["browsingContext.reload"]);
    expect(Object.keys(calls[0]!.params).sort()).toEqual(["context", "wait"]);
    expect(calls[0]!.params.context).toBe("ctx-1");
    expect(calls[0]!.params.wait).toBe("complete");
    expect(r).toMatchObject({ url: "https://example.test/", reloaded: true, waitedFor: "load" });
  });

  test("reload + ignoreCache:true fails fast with a clear capability error and sends NOTHING", async () => {
    const { conn, calls } = fakeConn(() => ({ url: "https://example.test/" }));
    await expect(page(conn).navigate({ reload: true, ignoreCache: true })).rejects.toThrow(
      /ignoreCache:true \(hard reload\) is not supported on the Firefox WebDriver-BiDi backend/,
    );
    expect(calls).toEqual([]);
  });

  test("domcontentloaded maps to wait:'interactive' on reload", async () => {
    const { conn, calls } = fakeConn(() => ({ url: "https://example.test/" }));
    await page(conn).navigate({ reload: true, waitUntil: "domcontentloaded" });
    expect(calls[0]!.params.wait).toBe("interactive");
  });
});

describe("bidi navigate: NS_ERROR_FILE_ACCESS_DENIED mapping (#6)", () => {
  test("the file:// denial reaches the caller with the confinement explanation and the http workaround", async () => {
    const { conn } = fakeConn(() => {
      throw new BidiError("browsingContext.navigate: NS_ERROR_FILE_ACCESS_DENIED");
    });
    await expect(page(conn).navigate({ url: "file:///home/user/example/deck.html" })).rejects.toThrow(
      /NS_ERROR_FILE_ACCESS_DENIED[\s\S]*python3 -m http\.server[\s\S]*http:\/\/127\.0\.0\.1/,
    );
  });

  test("an unrelated navigation error still maps through untouched — no over-broad match", async () => {
    const { conn } = fakeConn(() => {
      throw new BidiError("browsingContext.navigate: no such browsing context");
    });
    await expect(page(conn).navigate({ url: "https://gone.test/" })).rejects.toThrow(
      /^browsingContext\.navigate: no such browsing context$/,
    );
  });
});

describe("writeLaunchUserJs (automation prefs for the throwaway profile)", () => {
  const withDir = (fn: (dir: string) => void) => {
    const dir = mkdtempSync(join(tmpdir(), "cdp-userjs-test-"));
    try {
      fn(dir);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };

  test("a fresh profile dir gets the three file:// automation prefs", () => {
    withDir((dir) => {
      writeLaunchUserJs(dir);
      const content = readFileSync(join(dir, "user.js"), "utf8");
      expect(content).toContain('user_pref("remote.prefs.recommended", true);');
      expect(content).toContain('user_pref("security.fileuri.strict_origin_policy", false);');
      expect(content).toContain('user_pref("dom.file.createInChild", true);');
      expect(content.split("\n").filter((l) => l.startsWith("user_pref")).length).toBe(3);
    });
  });

  test("idempotent: a second run neither duplicates nor reorders anything", () => {
    withDir((dir) => {
      writeLaunchUserJs(dir);
      const first = readFileSync(join(dir, "user.js"), "utf8");
      writeLaunchUserJs(dir);
      expect(readFileSync(join(dir, "user.js"), "utf8")).toBe(first);
    });
  });

  test("an existing user.js is merged into, never clobbered: foreign prefs survive, already-set prefs keep their value", () => {
    withDir((dir) => {
      writeFileSync(
        join(dir, "user.js"),
        'user_pref("toolkit.startup.last_places_frequency", 5);\nuser_pref("security.fileuri.strict_origin_policy", true);\n',
        "utf8",
      );
      writeLaunchUserJs(dir);
      const content = readFileSync(join(dir, "user.js"), "utf8");
      // The foreign pref survives untouched.
      expect(content).toContain('user_pref("toolkit.startup.last_places_frequency", 5);');
      // The pref the owner explicitly set is NOT overwritten (merge, not enforce)…
      expect(content.match(/user_pref\("security\.fileuri\.strict_origin_policy", true\);/)).not.toBeNull();
      expect(content.match(/user_pref\("security\.fileuri\.strict_origin_policy", false\);/)).toBeNull();
      // …while the two absent prefs are appended exactly once each.
      expect(content.match(/user_pref\("remote\.prefs\.recommended", true\);/g)).toHaveLength(1);
      expect(content.match(/user_pref\("dom\.file\.createInChild", true\);/g)).toHaveLength(1);
    });
  });
});
