/**
 * Unit tests for the cookie tools: list_cookies, set_cookie, delete_cookies.
 *
 * Two properties carry the tool. The first is POSITIVE: an httpOnly cookie must
 * come back, with its flags intact, because that is the cookie document.cookie
 * cannot read and therefore the reason this tool exists at all. The second is
 * NEGATIVE, and is tested the same way evaluate_script's sink is: with savePath
 * set, no cookie value may appear ANYWHERE in the returned object, so the whole
 * result is serialized and searched rather than one field being asserted on.
 *
 * The two WRITE tools are pinned on a third property, which is the one this
 * pair can get wrong in the most dangerous way: they must FAIL LOUDLY rather
 * than no-op. A set_cookie that resolves without writing, or a delete_cookies
 * that quietly matched nothing because its site constraint was dropped, reads
 * exactly like success at the call site. So every refusal path is asserted to
 * throw, the args reaching the driver are asserted field by field (nothing
 * invented, nothing dropped), and the Firefox url-to-domain derivation is
 * tested including the urls it must refuse.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BrowserCookie, BrowserDriver, PageDriver, PageInfo } from "../src/driver.ts";
import type { DeleteCookiesFilter, SetCookieParams } from "../src/driver.ts";
import { assertCookieSite, deleteCookies, filterCookies, listCookies, setCookie } from "../src/shared-tools.ts";
import { hostFromUrl, normalizeBidiCookie } from "../src/bidi/driver.ts";
import { cdpSameSite, normalizeCdpCookie } from "../src/cdp/driver.ts";
import { MANIFEST } from "../src/manifest.ts";
import { TOOLS } from "../src/index.ts";
import { FIREFOX_TOOLS } from "../src/firefox-tools.ts";

const ARTIFACT_DIR = process.env.CDP_ARTIFACT_DIR ?? "/tmp/cdp-toolkit";

let dir = "";

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "cdp-cookies-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const INFO: PageInfo = { id: "TAB-1", url: "https://example.test/app", title: "App", type: "page" };

/** The httpOnly session cookie this tool exists to reach. */
const SESSION_COOKIE: BrowserCookie = {
  name: "sid",
  value: "SENTINEL-SESSION-CREDENTIAL",
  domain: "example.test",
  path: "/",
  expires: -1,
  size: 30,
  httpOnly: true,
  secure: true,
  sameSite: "lax",
  session: true,
};

const PREFS_COOKIE: BrowserCookie = {
  name: "prefs",
  value: "theme=dark",
  domain: ".example.test",
  path: "/",
  expires: 1893456000,
  size: 15,
  httpOnly: false,
  secure: false,
  sameSite: "default",
  session: false,
};

const OTHER_SITE_COOKIE: BrowserCookie = {
  name: "sid",
  value: "OTHER-SITE-VALUE",
  domain: "other.test",
  path: "/",
  expires: -1,
  size: 19,
  httpOnly: true,
  secure: true,
  sameSite: "strict",
  session: true,
};

/** Minimal driver stand-in: only the members list_cookies touches. */
function stubDriver(cookies: BrowserCookie[], opts: { throws?: Error } = {}) {
  let released = 0;
  const page = {
    info: INFO,
    async getCookies(): Promise<BrowserCookie[]> {
      if (opts.throws) throw opts.throws;
      return cookies;
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

describe("cookies come back with every flag, httpOnly included", () => {
  test("an httpOnly cookie is returned and reports httpOnly true", async () => {
    const { driver } = stubDriver([SESSION_COOKIE, PREFS_COOKIE]);
    const result = (await listCookies(driver)) as { cookies: BrowserCookie[]; count: number; target: unknown };

    expect(result.count).toBe(2);
    const sid = result.cookies.find((c) => c.name === "sid");
    expect(sid).toBeDefined();
    expect(sid?.httpOnly).toBe(true);
    expect(sid?.value).toBe("SENTINEL-SESSION-CREDENTIAL");
  });

  test("every documented field is present on each cookie", async () => {
    const { driver } = stubDriver([SESSION_COOKIE]);
    const result = (await listCookies(driver)) as { cookies: BrowserCookie[] };
    expect(Object.keys(result.cookies[0]!).sort()).toEqual(
      ["domain", "expires", "httpOnly", "name", "path", "sameSite", "secure", "session", "size", "value"],
    );
    expect(result.cookies[0]).toEqual(SESSION_COOKIE);
  });

  test("the target is the legacy 3-field shape, like every sibling tool", async () => {
    const { driver } = stubDriver([]);
    const result = (await listCookies(driver)) as { target: unknown; cookies: BrowserCookie[]; count: number };
    expect(result.target).toEqual({ id: INFO.id, url: INFO.url, title: INFO.title });
    expect(result.cookies).toEqual([]);
    expect(result.count).toBe(0);
  });

  test("the page is released, on the success path and the error path alike", async () => {
    const ok = stubDriver([SESSION_COOKIE]);
    await listCookies(ok.driver);
    expect(ok.releases()).toBe(1);

    const bad = stubDriver([], { throws: new Error("boom") });
    await expect(listCookies(bad.driver)).rejects.toThrow("boom");
    expect(bad.releases()).toBe(1);
  });
});

describe("savePath keeps cookie values out of the response", () => {
  test("the array lands on disk and NO value appears in the result", async () => {
    const path = join(dir, "cookies.json");
    const { driver } = stubDriver([SESSION_COOKIE, PREFS_COOKIE]);

    const result = (await listCookies(driver, { savePath: path })) as Record<string, unknown>;

    // The file has the cookies, values and all.
    const onDisk = JSON.parse(await readFile(path, "utf8")) as BrowserCookie[];
    expect(onDisk).toEqual([SESSION_COOKIE, PREFS_COOKIE]);

    // The response has no value, at any depth, in any substring form.
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain("SENTINEL-SESSION-CREDENTIAL");
    expect(serialized).not.toContain(SESSION_COOKIE.value);
    // Not even a prefix of it: a credential half returned is a credential returned.
    expect(serialized).not.toContain(SESSION_COOKIE.value.slice(0, 8));
    expect(serialized).not.toContain(PREFS_COOKIE.value);

    expect(Object.keys(result).sort()).toEqual(["bytes", "count", "path", "target"]);
    expect(result.path).toBe(path);
    expect(result.count).toBe(2);
    expect(result.bytes).toBe((await stat(path)).size);
    expect(result.target).toEqual({ id: INFO.id, url: INFO.url, title: INFO.title });
  });

  test("the response carries no cookie NAMES either, only a count", async () => {
    const path = join(dir, "cookies.json");
    const { driver } = stubDriver([SESSION_COOKIE]);
    const result = await listCookies(driver, { savePath: path });
    expect(JSON.stringify(result)).not.toContain("sid");
  });

  test("count reflects the filtered set, not the full jar", async () => {
    const path = join(dir, "one.json");
    const { driver } = stubDriver([SESSION_COOKIE, PREFS_COOKIE, OTHER_SITE_COOKIE]);
    const result = (await listCookies(driver, { savePath: path, name: "prefs" })) as Record<string, unknown>;
    expect(result.count).toBe(1);
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual([PREFS_COOKIE]);
  });

  test("a missing parent directory is created rather than throwing", async () => {
    const path = join(dir, "deep", "nested", "cookies.json");
    const { driver } = stubDriver([PREFS_COOKIE]);
    const result = (await listCookies(driver, { savePath: path })) as Record<string, unknown>;
    expect(result.path).toBe(path);
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual([PREFS_COOKIE]);
  });

  test("a bare filename resolves under the artifact dir, matching evaluate_script", async () => {
    const name = `cookies-test-${process.pid}.json`;
    const { driver } = stubDriver([PREFS_COOKIE]);
    const result = (await listCookies(driver, { savePath: name })) as Record<string, unknown>;
    try {
      expect(result.path).toBe(join(ARTIFACT_DIR, name));
      expect(JSON.parse(await readFile(result.path as string, "utf8"))).toEqual([PREFS_COOKIE]);
    } finally {
      await rm(result.path as string, { force: true });
    }
  });

  test("an empty savePath is treated as absent, so the cookies come back inline", async () => {
    const { driver } = stubDriver([SESSION_COOKIE]);
    const result = (await listCookies(driver, { savePath: "" })) as { cookies: BrowserCookie[] };
    expect(result.cookies).toEqual([SESSION_COOKIE]);
  });
});

describe("filters narrow the result", () => {
  test("name is an exact match, not a substring", async () => {
    const { driver } = stubDriver([SESSION_COOKIE, PREFS_COOKIE]);
    const byName = (await listCookies(driver, { name: "sid" })) as { cookies: BrowserCookie[]; count: number };
    expect(byName.count).toBe(1);
    expect(byName.cookies[0]?.name).toBe("sid");

    const partial = (await listCookies(driver, { name: "si" })) as { count: number };
    expect(partial.count).toBe(0);
  });

  test("domain matches with or without a leading dot, and matches subdomains", () => {
    const jar = [SESSION_COOKIE, PREFS_COOKIE, OTHER_SITE_COOKIE];
    // "example.test" catches the host-only cookie AND the dotted one.
    expect(filterCookies(jar, { domain: "example.test" }).map((c) => c.domain).sort())
      .toEqual([".example.test", "example.test"]);
    // A leading dot on the FILTER side is ignored too.
    expect(filterCookies(jar, { domain: ".example.test" }).length).toBe(2);
    // A cookie on a subdomain matches its parent domain filter.
    const sub: BrowserCookie = { ...PREFS_COOKIE, domain: "app.example.test" };
    expect(filterCookies([sub], { domain: "example.test" }).length).toBe(1);
    // A different site does not match, and neither does a suffix coincidence.
    expect(filterCookies(jar, { domain: "other.test" }).map((c) => c.domain)).toEqual(["other.test"]);
    expect(filterCookies(jar, { domain: "ample.test" }).length).toBe(0);
  });

  test("domain and name compose", async () => {
    const { driver } = stubDriver([SESSION_COOKIE, PREFS_COOKIE, OTHER_SITE_COOKIE]);
    const both = (await listCookies(driver, { domain: "other.test", name: "sid" })) as { cookies: BrowserCookie[]; count: number };
    expect(both.count).toBe(1);
    expect(both.cookies[0]?.value).toBe("OTHER-SITE-VALUE");
  });

  test("an empty filter string is treated as no filter", async () => {
    const { driver } = stubDriver([SESSION_COOKIE, PREFS_COOKIE]);
    const result = (await listCookies(driver, { domain: "", name: "" })) as { count: number };
    expect(result.count).toBe(2);
  });
});

describe("the Chrome path normalizes CDP's cookie shape", () => {
  test("an httpOnly session cookie survives with its flags", () => {
    expect(normalizeCdpCookie({
      name: "sid", value: "SENTINEL-CDP", domain: "example.test", path: "/", expires: -1,
      size: 19, httpOnly: true, secure: true, session: true, sameSite: "Lax",
    })).toEqual({
      name: "sid", value: "SENTINEL-CDP", domain: "example.test", path: "/", expires: -1,
      size: 19, httpOnly: true, secure: true, sameSite: "lax", session: true,
    });
  });

  test("CDP's capitalized sameSite is lowercased, and an absent one becomes 'default'", () => {
    const base = { name: "a", value: "b", domain: "example.test", path: "/", expires: -1, size: 2, httpOnly: false, secure: false, session: true };
    expect(normalizeCdpCookie({ ...base, sameSite: "Strict" }).sameSite).toBe("strict");
    expect(normalizeCdpCookie({ ...base, sameSite: "None" }).sameSite).toBe("none");
    expect(normalizeCdpCookie(base).sameSite).toBe("default");
  });
});

describe("the Firefox path normalizes BiDi's cookie shape", () => {
  // list_cookies is implemented on BOTH backends: Firefox rides
  // storage.getCookies with a context partition. What differs is the wire shape,
  // so these tests pin the mapping that makes a BiDi cookie indistinguishable
  // from a CDP one at the tool boundary.
  test("a session cookie (no expiry) becomes expires -1 and session true", () => {
    expect(normalizeBidiCookie({
      name: "sid", value: { type: "string", value: "SENTINEL-BIDI" }, domain: "example.test",
      path: "/", size: 20, httpOnly: true, secure: true, sameSite: "lax",
    })).toEqual({
      name: "sid", value: "SENTINEL-BIDI", domain: "example.test", path: "/", expires: -1,
      size: 20, httpOnly: true, secure: true, sameSite: "lax", session: true,
    });
  });

  test("an expiry becomes expires, with session false", () => {
    const c = normalizeBidiCookie({
      name: "prefs", value: { type: "string", value: "theme=dark" }, domain: ".example.test",
      path: "/", size: 15, httpOnly: false, secure: false, sameSite: "none", expiry: 1893456000,
    });
    expect(c.expires).toBe(1893456000);
    expect(c.session).toBe(false);
  });

  test("a base64 value is decoded, not handed back as base64", () => {
    const c = normalizeBidiCookie({
      name: "token", value: { type: "base64", value: Buffer.from("SENTINEL-B64", "utf8").toString("base64") },
      domain: "example.test", path: "/", size: 18, httpOnly: true, secure: true, sameSite: "strict",
    });
    expect(c.value).toBe("SENTINEL-B64");
  });
});

/* --------------------------- the write tools --------------------------- */

/**
 * A driver stand-in that RECORDS the write calls instead of performing them.
 *
 * Recording rather than asserting inline is deliberate: the interesting bugs in
 * a pass-through layer are a field silently added (a defaulted path that widens
 * the cookie) or silently dropped (a lost domain that widens the deletion), and
 * both are invisible unless the exact object the driver received is compared as
 * a whole.
 */
function writeStubDriver(opts: { setThrows?: Error; deleteThrows?: Error } = {}) {
  const setCalls: SetCookieParams[] = [];
  const deleteCalls: DeleteCookiesFilter[] = [];
  let released = 0;
  const page = {
    info: INFO,
    async setCookie(params: SetCookieParams): Promise<void> {
      setCalls.push(params);
      if (opts.setThrows) throw opts.setThrows;
    },
    async deleteCookies(filter: DeleteCookiesFilter): Promise<void> {
      deleteCalls.push(filter);
      if (opts.deleteThrows) throw opts.deleteThrows;
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
  return { driver: driver as unknown as BrowserDriver, setCalls, deleteCalls, releases: () => released };
}

describe("set_cookie writes and acks without echoing the value", () => {
  test("the ack is {set,target} only, with no trace of the value", async () => {
    const { driver, setCalls } = writeStubDriver();
    const result = await setCookie(driver, {
      name: "sid", value: "WRITE-SENTINEL-CREDENTIAL", url: "https://example.test/",
    });

    expect(result).toEqual({ set: true, target: { id: INFO.id, url: INFO.url, title: INFO.title } });
    // The credential is not in the response at any depth, nor as a fragment.
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain("WRITE-SENTINEL-CREDENTIAL");
    expect(serialized).not.toContain("WRITE-SEN");
    // ...but it did reach the driver.
    expect(setCalls[0]?.value).toBe("WRITE-SENTINEL-CREDENTIAL");
  });

  test("only the fields the caller gave are forwarded, path included and NOT defaulted", async () => {
    const { driver, setCalls } = writeStubDriver();
    await setCookie(driver, { name: "sid", value: "v", url: "https://example.test/app" });
    // No invented path, no invented expires, no invented secure.
    expect(setCalls[0]).toEqual({ name: "sid", value: "v", url: "https://example.test/app" });
    expect(Object.keys(setCalls[0]!).sort()).toEqual(["name", "url", "value"]);
  });

  test("every optional field is forwarded verbatim when given", async () => {
    const { driver, setCalls } = writeStubDriver();
    await setCookie(driver, {
      name: "sid", value: "v", domain: ".example.test", path: "/app", expires: 1893456000,
      httpOnly: true, secure: true, sameSite: "strict",
    });
    expect(setCalls[0]).toEqual({
      name: "sid", value: "v", domain: ".example.test", path: "/app", expires: 1893456000,
      httpOnly: true, secure: true, sameSite: "strict",
    });
  });

  test("neither url nor domain is REFUSED, not silently accepted", async () => {
    const { driver, setCalls } = writeStubDriver();
    await expect(setCookie(driver, { name: "sid", value: "v" })).rejects.toThrow(/requires either 'url' or 'domain'/);
    // The refusal happens before the driver is touched: nothing was written.
    expect(setCalls.length).toBe(0);
  });

  test("an empty url and an empty domain count as absent", async () => {
    const { driver } = writeStubDriver();
    await expect(setCookie(driver, { name: "sid", value: "v", url: "", domain: "" }))
      .rejects.toThrow(/requires either 'url' or 'domain'/);
  });

  test("an empty name is refused", async () => {
    const { driver, setCalls } = writeStubDriver();
    await expect(setCookie(driver, { name: "", value: "v", url: "https://example.test/" }))
      .rejects.toThrow(/requires a non-empty 'name'/);
    expect(setCalls.length).toBe(0);
  });

  test("a driver refusal propagates instead of becoming set:true", async () => {
    const { driver } = writeStubDriver({ setThrows: new Error("Network.setCookie declined the cookie 'sid'.") });
    await expect(setCookie(driver, { name: "sid", value: "v", url: "https://example.test/" }))
      .rejects.toThrow(/declined the cookie/);
  });

  test("the page is released on the success path and the error path alike", async () => {
    const ok = writeStubDriver();
    await setCookie(ok.driver, { name: "sid", value: "v", url: "https://example.test/" });
    expect(ok.releases()).toBe(1);

    const bad = writeStubDriver({ setThrows: new Error("boom") });
    await expect(setCookie(bad.driver, { name: "sid", value: "v", url: "https://example.test/" })).rejects.toThrow("boom");
    expect(bad.releases()).toBe(1);
  });
});

describe("delete_cookies removes by name and acks without a count", () => {
  test("the ack is {deleted,target} and carries NO count", async () => {
    const { driver, deleteCalls } = writeStubDriver();
    const result = await deleteCookies(driver, { name: "sid", url: "https://example.test/" });
    expect(result).toEqual({ deleted: true, target: { id: INFO.id, url: INFO.url, title: INFO.title } });
    // No invented count: neither protocol reports one.
    expect(Object.keys(result).sort()).toEqual(["deleted", "target"]);
    expect(deleteCalls[0]).toEqual({ name: "sid", url: "https://example.test/" });
  });

  test("path narrows the filter and is forwarded only when given", async () => {
    const { driver, deleteCalls } = writeStubDriver();
    await deleteCookies(driver, { name: "sid", domain: "example.test", path: "/app" });
    expect(deleteCalls[0]).toEqual({ name: "sid", domain: "example.test", path: "/app" });

    await deleteCookies(driver, { name: "sid", domain: "example.test" });
    expect(Object.keys(deleteCalls[1]!).sort()).toEqual(["domain", "name"]);
  });

  test("neither url nor domain is REFUSED: a name-only delete would sweep the partition", async () => {
    const { driver, deleteCalls } = writeStubDriver();
    await expect(deleteCookies(driver, { name: "sid" })).rejects.toThrow(/requires either 'url' or 'domain'/);
    expect(deleteCalls.length).toBe(0);
  });

  test("an empty name is refused rather than matching everything", async () => {
    const { driver, deleteCalls } = writeStubDriver();
    await expect(deleteCookies(driver, { name: "", url: "https://example.test/" }))
      .rejects.toThrow(/requires a non-empty 'name'/);
    expect(deleteCalls.length).toBe(0);
  });

  test("the page is released on the success path and the error path alike", async () => {
    const ok = writeStubDriver();
    await deleteCookies(ok.driver, { name: "sid", url: "https://example.test/" });
    expect(ok.releases()).toBe(1);

    const bad = writeStubDriver({ deleteThrows: new Error("boom") });
    await expect(deleteCookies(bad.driver, { name: "sid", url: "https://example.test/" })).rejects.toThrow("boom");
    expect(bad.releases()).toBe(1);
  });

  test("assertCookieSite names the tool it refused for", () => {
    expect(() => assertCookieSite({}, "set_cookie")).toThrow(/^set_cookie requires/);
    expect(() => assertCookieSite({}, "delete_cookies")).toThrow(/^delete_cookies requires/);
    expect(() => assertCookieSite({ url: "https://example.test/" }, "set_cookie")).not.toThrow();
    expect(() => assertCookieSite({ domain: "example.test" }, "set_cookie")).not.toThrow();
  });
});

describe("the Chrome path maps sameSite back to CDP's vocabulary", () => {
  test("the three real values capitalize, and 'default' becomes an omitted field", () => {
    expect(cdpSameSite("strict")).toBe("Strict");
    expect(cdpSameSite("lax")).toBe("Lax");
    expect(cdpSameSite("none")).toBe("None");
    // CDP has no word for "default": the attribute is simply not sent.
    expect(cdpSameSite("default")).toBeUndefined();
    expect(cdpSameSite(undefined)).toBeUndefined();
  });

  test("it is the exact inverse of the read mapping", () => {
    const base = { name: "a", value: "b", domain: "example.test", path: "/", expires: -1, size: 2, httpOnly: false, secure: false, session: true };
    for (const wire of ["Strict", "Lax", "None"] as const) {
      expect(cdpSameSite(normalizeCdpCookie({ ...base, sameSite: wire }).sameSite)).toBe(wire);
    }
  });
});

describe("the Firefox path derives the domain BiDi requires, or fails loudly", () => {
  // BiDi's storage.setCookie has no 'url' and REQUIRES a domain, so a caller who
  // gave only a url needs one derived. Every case that cannot produce one throws:
  // sending the call without a domain is the silent no-op this refuses to emit.
  test("a normal url yields its host", () => {
    expect(hostFromUrl("https://example.test/app?q=1", "set_cookie")).toBe("example.test");
    expect(hostFromUrl("http://app.example.test:8080/", "set_cookie")).toBe("app.example.test");
  });

  test("an absent url throws and names the tool", () => {
    expect(() => hostFromUrl(undefined, "set_cookie")).toThrow(/set_cookie on Firefox needs a 'domain'/);
    expect(() => hostFromUrl("", "delete_cookies")).toThrow(/delete_cookies on Firefox needs a 'domain'/);
  });

  test("an unparseable url throws rather than yielding an empty domain", () => {
    expect(() => hostFromUrl("not a url", "set_cookie")).toThrow(/could not parse the url/);
  });

  test("a hostless url throws: about:blank and data: cannot carry a cookie", () => {
    expect(() => hostFromUrl("about:blank", "set_cookie")).toThrow(/has no host/);
    expect(() => hostFromUrl("data:text/html,hi", "set_cookie")).toThrow(/has no host/);
  });
});

describe("both write tools are wired through every layer", () => {
  test("registered for Chrome and for Firefox alike", () => {
    for (const name of ["set_cookie", "delete_cookies"] as const) {
      expect(Object.keys(TOOLS)).toContain(name);
      expect(Object.keys(FIREFOX_TOOLS)).toContain(name);
    }
  });

  test("each has a manifest schema requiring name, with the site fields optional in the schema", () => {
    for (const name of ["set_cookie", "delete_cookies"]) {
      const spec = MANIFEST.find((s) => s.name === name);
      expect(spec).toBeDefined();
      const schema = spec!.inputSchema as { required: string[]; properties: Record<string, unknown> };
      expect(schema.required).toContain("name");
      // url and domain are an either/or, which JSON Schema 'required' cannot
      // express, so both are optional here and the tool enforces the pair.
      expect(schema.required).not.toContain("url");
      expect(schema.required).not.toContain("domain");
      expect(Object.keys(schema.properties)).toContain("url");
      expect(Object.keys(schema.properties)).toContain("domain");
      expect(Object.keys(schema.properties)).toContain("target");
    }
    const setSpec = MANIFEST.find((s) => s.name === "set_cookie");
    expect((setSpec!.inputSchema as { required: string[] }).required).toContain("value");
  });
});
