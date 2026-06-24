/**
 * Unit tests for the PURE logic of network_mock.ts — the bug-prone parts that
 * need no browser: CDP urlPattern glob matching, rule selection (pattern +
 * method), fulfill-param construction (header merge + base64), and the
 * fault-injection decision. The stateful CDP I/O is covered by test/mock-smoke.ts
 * against real Chrome.
 */
import { describe, expect, test } from "bun:test";
import { urlMatches, selectRule, buildFulfillParams, effectiveAction } from "../src/tools/network_mock.ts";

describe("urlMatches — CDP urlPattern glob", () => {
  test("'*' matches a run of characters", () => {
    expect(urlMatches("*/api/users*", "https://x.com/api/users?page=1")).toBe(true);
  });
  test("'*' matches zero characters", () => {
    expect(urlMatches("https://x.com/api*", "https://x.com/api")).toBe(true);
  });
  test("non-matching path returns false", () => {
    expect(urlMatches("*/api/users*", "https://x.com/api/orders")).toBe(false);
  });
  test("'?' matches exactly one character", () => {
    expect(urlMatches("https://x.com/v?/ping", "https://x.com/v2/ping")).toBe(true);
    expect(urlMatches("https://x.com/v?/ping", "https://x.com/v20/ping")).toBe(false);
  });
  test("regex metacharacters are treated literally", () => {
    // '.' must not behave like regex '.'
    expect(urlMatches("https://x.com/p", "https://xXcom/p")).toBe(false);
    // '+' is a literal plus, not one-or-more
    expect(urlMatches("https://x.com/a+b", "https://x.com/a+b")).toBe(true);
    expect(urlMatches("https://x.com/a+b", "https://x.com/aaab")).toBe(false);
  });
  test("backslash escapes a wildcard into a literal", () => {
    expect(urlMatches("https://x.com/q\\?x", "https://x.com/q?x")).toBe(true);
    expect(urlMatches("https://x.com/q\\?x", "https://x.com/qZx")).toBe(false);
  });
});

describe("selectRule — first match by order, with method filter", () => {
  const rules = [
    { urlPattern: "*/api/a*", action: "fulfill" as const },
    { urlPattern: "*/api/*", action: "fail" as const, method: "POST" },
  ];
  test("returns the first rule that matches, in order", () => {
    expect(selectRule(rules, "https://x/api/a", "GET")?.action).toBe("fulfill");
  });
  test("method filter excludes a non-matching method", () => {
    const r = selectRule([{ urlPattern: "*/api/*", action: "fail" as const, method: "POST" }], "https://x/api/b", "GET");
    expect(r).toBeUndefined();
  });
  test("method filter is case-insensitive", () => {
    const r = selectRule([{ urlPattern: "*/api/*", action: "fail" as const, method: "post" }], "https://x/api/b", "POST");
    expect(r?.action).toBe("fail");
  });
  test("no rule matches → undefined", () => {
    expect(selectRule(rules, "https://x/other", "GET")).toBeUndefined();
  });
});

describe("buildFulfillParams — headers + base64 body", () => {
  test("base64-encodes the body and carries the status", () => {
    const p = buildFulfillParams("req1", { status: 201, body: '{"ok":true}', contentType: "application/json", headers: {} });
    expect(p.requestId).toBe("req1");
    expect(p.responseCode).toBe(201);
    expect(Buffer.from(p.body, "base64").toString("utf8")).toBe('{"ok":true}');
  });
  test("includes Content-Type plus custom headers; custom overrides Content-Type", () => {
    const p = buildFulfillParams("r", {
      status: 200,
      body: "",
      contentType: "text/plain",
      headers: { "X-Test": "1", "Content-Type": "application/json" },
    });
    const map = Object.fromEntries(p.responseHeaders.map((h) => [h.name.toLowerCase(), h.value]));
    expect(map["x-test"]).toBe("1");
    expect(map["content-type"]).toBe("application/json"); // custom wins over the default
  });
  test("applies defaults when fields are omitted", () => {
    const p = buildFulfillParams("r", {});
    expect(p.responseCode).toBe(200);
    expect(Buffer.from(p.body, "base64").toString("utf8")).toBe("");
    const ct = p.responseHeaders.find((h) => h.name.toLowerCase() === "content-type");
    expect(ct?.value).toBe("application/json");
  });
});

describe("effectiveAction — fault injection", () => {
  test("failRate above the roll forces a fail", () => {
    expect(effectiveAction({ action: "fulfill", failRate: 0.5 }, 0.1)).toBe("fail");
  });
  test("failRate below the roll keeps the configured action", () => {
    expect(effectiveAction({ action: "fulfill", failRate: 0.5 }, 0.9)).toBe("fulfill");
  });
  test("no failRate keeps the configured action", () => {
    expect(effectiveAction({ action: "continue" }, 0.0)).toBe("continue");
  });
});
