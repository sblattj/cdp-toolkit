/**
 * Unit tests for evaluate_script's `savePath` file sink.
 *
 * The property that matters is a NEGATIVE one: with `savePath` set, the
 * evaluated value must not appear ANYWHERE in the returned object. A test that
 * only checks `result.path` is right would pass while the value rode along in
 * some other field, so every suppression test here serializes the WHOLE result
 * and searches it for the secret, rather than asserting on one field.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BrowserDriver, PageDriver, PageInfo } from "../src/driver.ts";
import { evaluateScript } from "../src/shared-tools.ts";

const ARTIFACT_DIR = process.env.CDP_ARTIFACT_DIR ?? "/tmp/cdp-toolkit";

let dir = "";

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "cdp-evaluate-save-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const INFO: PageInfo = { id: "TAB-1", url: "https://example.test/app", title: "App", type: "page" };

/** Minimal driver stand-in: only the members evaluate_script touches. */
function stubDriver(value: unknown, opts: { throws?: Error } = {}) {
  let released = 0;
  const page = {
    info: INFO,
    async evaluate(): Promise<unknown> {
      if (opts.throws) throw opts.throws;
      return value;
    },
    async release(): Promise<void> {
      released += 1;
    },
  };
  const driver = {
    scheme: "cdp",
    async page(): Promise<PageDriver> {
      return page as unknown as PageDriver;
    },
  };
  return { driver: driver as unknown as BrowserDriver, releases: () => released };
}

describe("savePath keeps the evaluated value out of the response", () => {
  test("the value is written to the given path and appears NOWHERE in the result", async () => {
    const secret = "eyJhbGciOiJIUzI1NiJ9.SENTINEL-TOKEN-VALUE.sig";
    const path = join(dir, "token.json");
    const { driver } = stubDriver(secret);

    const result = (await evaluateScript(driver, {
      expression: "localStorage.getItem('auth')",
      savePath: path,
    })) as Record<string, unknown>;

    // The file has it.
    expect(JSON.parse(await readFile(path, "utf8"))).toBe(secret);

    // The response does not, in any field, at any depth, in any substring form.
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain("SENTINEL-TOKEN-VALUE");
    expect(serialized).not.toContain(secret);
    // Not even a prefix of it: a secret half returned is a secret returned.
    expect(serialized).not.toContain(secret.slice(0, 12));
    expect(Object.keys(result).sort()).toEqual(["bytes", "path", "target", "type"]);
    expect(result.path).toBe(path);
    expect(result.type).toBe("string");
    expect(result.bytes).toBe((await stat(path)).size);
    expect(result.target).toEqual({ id: INFO.id, url: INFO.url, title: INFO.title });
  });

  test("an object value is suppressed too, including its nested secret fields", async () => {
    const path = join(dir, "creds.json");
    const value = { user: "abc", session: { jwt: "SENTINEL-NESTED-SECRET" } };
    const { driver } = stubDriver(value);

    const result = await evaluateScript(driver, { expression: "readCreds()", savePath: path });

    expect(JSON.stringify(result)).not.toContain("SENTINEL-NESTED-SECRET");
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual(value);
    expect((result as Record<string, unknown>).type).toBe("object");
  });

  test("null reports type 'null' rather than 'object'", async () => {
    const path = join(dir, "null.json");
    const { driver } = stubDriver(null);
    const result = await evaluateScript(driver, { expression: "null", savePath: path });
    expect((result as Record<string, unknown>).type).toBe("null");
    expect(await readFile(path, "utf8")).toBe("null");
  });

  test("an expression with no result writes JSON null and reports type 'undefined'", async () => {
    const path = join(dir, "undef.json");
    const { driver } = stubDriver(undefined);
    const result = await evaluateScript(driver, { expression: "void 0", savePath: path });
    expect((result as Record<string, unknown>).type).toBe("undefined");
    expect(await readFile(path, "utf8")).toBe("null");
  });

  test("a non-serializable return (a DOM node or function) is saved as its CDP description string", async () => {
    // The driver hands back the CDP description string for these, so the sink
    // writes that string. It never writes a live handle and never throws.
    const path = join(dir, "node.json");
    const { driver } = stubDriver("HTMLDivElement");
    const result = await evaluateScript(driver, { expression: "document.body.firstElementChild", savePath: path });
    expect(JSON.parse(await readFile(path, "utf8"))).toBe("HTMLDivElement");
    expect((result as Record<string, unknown>).type).toBe("string");
  });
});

describe("savePath resolution and directories", () => {
  test("a missing parent directory is created rather than throwing", async () => {
    const path = join(dir, "deep", "nested", "value.json");
    const { driver } = stubDriver({ ok: true });
    const result = await evaluateScript(driver, { expression: "1", savePath: path });
    expect((result as Record<string, unknown>).path).toBe(path);
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual({ ok: true });
  });

  test("a bare filename resolves under the artifact dir, matching take_heapsnapshot", async () => {
    const name = `evaluate-save-test-${process.pid}.json`;
    const { driver } = stubDriver("relative-ok");
    const result = (await evaluateScript(driver, { expression: "1", savePath: name })) as Record<string, unknown>;
    try {
      expect(result.path).toBe(join(ARTIFACT_DIR, name));
      expect(JSON.parse(await readFile(result.path as string, "utf8"))).toBe("relative-ok");
    } finally {
      await rm(result.path as string, { force: true });
    }
  });
});

describe("without savePath, nothing changes", () => {
  test("the value comes back exactly as before (regression guard)", async () => {
    const value = { token: "PLAIN-VALUE", n: 42, list: [1, 2, 3] };
    const { driver } = stubDriver(value);
    expect(await evaluateScript(driver, { expression: "readCreds()" })).toEqual(value);
  });

  test("a primitive comes back as the primitive, not wrapped in an object", async () => {
    const { driver } = stubDriver(7);
    expect(await evaluateScript(driver, { expression: "3+4" })).toBe(7);
  });

  test("an empty savePath is treated as absent, so the value is returned inline", async () => {
    const { driver } = stubDriver("inline");
    expect(await evaluateScript(driver, { expression: "'inline'", savePath: "" })).toBe("inline");
  });
});

describe("errors keep their current behavior", () => {
  test("a page-side exception still rejects and is never swallowed into the file", async () => {
    const path = join(dir, "never-written.json");
    const { driver } = stubDriver(undefined, { throws: new Error("Uncaught ReferenceError: nope is not defined") });
    await expect(evaluateScript(driver, { expression: "nope()", savePath: path })).rejects.toThrow("nope is not defined");
    await expect(readFile(path, "utf8")).rejects.toThrow();
  });

  test("an empty expression still rejects, with or without savePath", async () => {
    const { driver } = stubDriver("x");
    await expect(evaluateScript(driver, { expression: "", savePath: join(dir, "x.json") })).rejects.toThrow("non-empty string");
    await expect(evaluateScript(driver, { expression: "" })).rejects.toThrow("non-empty string");
  });

  test("a missing expression, with no alias key present, keeps the unchanged plain error", async () => {
    const { driver } = stubDriver("x");
    await expect(evaluateScript(driver, { other: "irrelevant" } as never)).rejects.toThrow("evaluateScript: 'expression' must be a non-empty string");
  });

  test("the page is released on both the save path and the error path", async () => {
    const ok = stubDriver("v");
    await evaluateScript(ok.driver, { expression: "1", savePath: join(dir, "released.json") });
    expect(ok.releases()).toBe(1);

    const bad = stubDriver(undefined, { throws: new Error("boom") });
    await expect(evaluateScript(bad.driver, { expression: "1", savePath: join(dir, "no.json") })).rejects.toThrow("boom");
    expect(bad.releases()).toBe(1);
  });
});

describe("evaluate_script key-echo: a wrong-key call names the key it should have used", () => {
  const ALIASES = ["function", "code", "js", "script", "fn", "body"] as const;

  for (const alias of ALIASES) {
    test(`'${alias}' instead of 'expression' is named in the error`, async () => {
      const { driver } = stubDriver("unreached");
      await expect(evaluateScript(driver, { [alias]: "() => 1" } as never)).rejects.toThrow(
        new RegExp(`you passed '${alias}'; the key is 'expression'`),
      );
    });
  }

  test("the message teaches where function literals go", async () => {
    const { driver } = stubDriver("unreached");
    await expect(evaluateScript(driver, { function: "() => 1" } as never)).rejects.toThrow(
      "function literals go in 'expression', invoked with 'args'",
    );
  });

  test("an alias key alongside a genuinely empty expression still triggers the echo, not the plain error", async () => {
    const { driver } = stubDriver("unreached");
    await expect(evaluateScript(driver, { expression: "", code: "1+1" } as never)).rejects.toThrow(/you passed 'code'/);
  });

  test("a present, non-empty expression is used even when an alias key also happens to be set", async () => {
    const { driver } = stubDriver(42);
    // The alias key is noise once 'expression' is valid: it must never surface
    // in the result or change resolution.
    expect(await evaluateScript(driver, { expression: "6*7", code: "ignored" } as never)).toBe(42);
  });
});
