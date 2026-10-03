/**
 * Regression test for the 3.0.2 CLI coercion fix.
 *
 * Before 3.0.2, parseArgv coerced every `--key value` that looked numeric into a
 * number, regardless of the tool's schema. CDP mints fetch/XHR requestIds like
 * "91775.34", so `get_network_request --requestId 91775.34` handed the tool the
 * NUMBER 91775.34, which never `===`-matched the string id in the buffer, and
 * "91775.10" was mangled outright into 91775.1. Every such lookup failed with
 * "no network request matched", while the same id via --json worked.
 *
 * parseArgv now consults the tool's MANIFEST inputSchema: a key typed "string"
 * keeps its raw text; everything else is coerced as before.
 */
import { describe, expect, test } from "bun:test";
import { parseArgv } from "../src/cli.ts";

describe("cli parseArgv schema-aware coercion", () => {
  test("a numeric-looking requestId stays a string, trailing zero intact", () => {
    const { args } = parseArgv(["get_network_request", "--requestId", "91775.10"]);
    expect(args.requestId).toBe("91775.10");
  });

  test("the tool name may follow the flags and still drive coercion", () => {
    const { tool, args } = parseArgv(["--requestId", "91775.34", "get_network_request"]);
    expect(tool).toBe("get_network_request");
    expect(args.requestId).toBe("91775.34");
  });

  test("a string-typed key keeps 'true' verbatim rather than becoming a boolean", () => {
    const { args } = parseArgv(["list_network_requests", "--filterUrl", "true"]);
    expect(args.filterUrl).toBe("true");
  });

  test("number- and boolean-typed keys are still coerced", () => {
    const { args } = parseArgv([
      "get_network_request",
      "--url",
      "/api",
      "--includeBody",
      "true",
      "--durationMs",
      "2500",
    ]);
    expect(args.includeBody).toBe(true);
    expect(args.durationMs).toBe(2500);
    expect(args.url).toBe("/api");
  });

  test("keys the schema does not declare fall back to the old coercion", () => {
    const { args } = parseArgv(["get_network_request", "--notInSchema", "42"]);
    expect(args.notInSchema).toBe(42);
  });

  test("--target is always raw, and a bare flag is boolean true", () => {
    const { args } = parseArgv(["list_network_requests", "--target", "index:0", "--reload"]);
    expect(args.target).toBe("index:0");
    expect(args.reload).toBe(true);
  });
});
