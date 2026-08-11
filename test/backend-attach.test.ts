/**
 * Unit tests for the Firefox ATTACH configuration surface in src/backend.ts:
 * normalizeBidiEndpoint, resolveFirefoxEndpoint, stripConnectFlag, resolveBackend.
 *
 * These are pure functions over (argv, env) — no browser, no sockets — and that
 * is the whole point of testing them here rather than only in the live smoke
 * (test/firefox-attach-smoke.ts, which proves the transport half against a real
 * Firefox). What can silently rot at this layer is the PRECEDENCE and the
 * REJECTIONS: a flag that stops beating the env var, a `--connect` pair that
 * leaks into tool-arg parsing, an out-of-range port that reaches the transport
 * and surfaces later as an opaque connect timeout instead of a usage error.
 *
 * EVERY resolve* call below passes an EXPLICIT `env` object. The functions
 * default to process.env, so a test that omitted it would pass or fail based on
 * whether the developer running it happens to export CDP_FIREFOX_ENDPOINT or
 * CDP_BROWSER — the exact class of environment-dependent flake these tests exist
 * to rule out.
 */
import { describe, expect, test } from "bun:test";
import {
  normalizeBidiEndpoint,
  resolveBackend,
  resolveFirefoxEndpoint,
  stripConnectFlag,
} from "../src/backend.ts";

/** A deliberately EMPTY environment: neither CDP_FIREFOX_ENDPOINT nor CDP_BROWSER set. */
const NO_ENV: NodeJS.ProcessEnv = {};

describe("normalizeBidiEndpoint", () => {
  test("a bare port becomes the loopback BiDi ws URL", () => {
    expect(normalizeBidiEndpoint("9223")).toBe("ws://127.0.0.1:9223/session");
  });

  test("host:port on loopback normalizes to the same URL as the bare port", () => {
    expect(normalizeBidiEndpoint("127.0.0.1:9223")).toBe("ws://127.0.0.1:9223/session");
  });

  test("a named host is preserved, not resolved to an address", () => {
    expect(normalizeBidiEndpoint("localhost:9223")).toBe("ws://localhost:9223/session");
  });

  test("a full ws URL with the /session path is used verbatim", () => {
    expect(normalizeBidiEndpoint("ws://127.0.0.1:9223/session")).toBe("ws://127.0.0.1:9223/session");
  });

  test("a ws URL with no path gets /session appended (bare origin means the BiDi endpoint)", () => {
    expect(normalizeBidiEndpoint("ws://127.0.0.1:9223")).toBe("ws://127.0.0.1:9223/session");
  });

  test("wss is accepted verbatim, so a proxied/tunneled endpoint is expressible", () => {
    expect(normalizeBidiEndpoint("wss://h:1/session")).toBe("wss://h:1/session");
  });

  test("surrounding whitespace is trimmed rather than producing an unparseable URL", () => {
    expect(normalizeBidiEndpoint("  9223  ")).toBe("ws://127.0.0.1:9223/session");
  });

  // The rejections. Each of these would otherwise be handed to the transport and
  // fail as a connect error with no hint that the CONFIG was the problem.
  test("empty string throws", () => {
    expect(() => normalizeBidiEndpoint("")).toThrow(/invalid Firefox endpoint/);
  });

  test("a non-port, non-host:port, non-URL string throws and names the accepted spellings", () => {
    expect(() => normalizeBidiEndpoint("abc")).toThrow(
      /expected a port \(9223\), host:port, or a ws:\/\/ URL/,
    );
  });

  test("a port above 65535 throws", () => {
    expect(() => normalizeBidiEndpoint("99999999")).toThrow(/port must be 1-65535/);
  });

  test("port 0 throws: it means 'any free port' to a listener and nothing to a client", () => {
    expect(() => normalizeBidiEndpoint("0")).toThrow(/port must be 1-65535/);
  });

  test("host:port with an out-of-range port throws too, not just the bare-port spelling", () => {
    expect(() => normalizeBidiEndpoint("127.0.0.1:70000")).toThrow(/port must be 1-65535/);
  });
});

describe("resolveFirefoxEndpoint", () => {
  test("--connect <port> in argv resolves to the normalized ws URL", () => {
    expect(resolveFirefoxEndpoint(["--connect", "9223"], NO_ENV)).toBe("ws://127.0.0.1:9223/session");
  });

  test("CDP_FIREFOX_ENDPOINT resolves when no flag is present", () => {
    expect(resolveFirefoxEndpoint([], { CDP_FIREFOX_ENDPOINT: "9224" })).toBe(
      "ws://127.0.0.1:9224/session",
    );
  });

  test("the flag BEATS the env var (same precedence as --browser over CDP_BROWSER)", () => {
    expect(resolveFirefoxEndpoint(["--connect", "9223"], { CDP_FIREFOX_ENDPOINT: "9224" })).toBe(
      "ws://127.0.0.1:9223/session",
    );
  });

  test("neither flag nor env means LAUNCH mode, i.e. undefined", () => {
    expect(resolveFirefoxEndpoint([], NO_ENV)).toBeUndefined();
  });

  test("an exported-but-blank env var counts as unset, not as a broken endpoint", () => {
    expect(resolveFirefoxEndpoint([], { CDP_FIREFOX_ENDPOINT: "" })).toBeUndefined();
  });

  test("a full ws URL passes through the flag unchanged", () => {
    expect(resolveFirefoxEndpoint(["--connect", "ws://10.0.0.5:4444/session"], NO_ENV)).toBe(
      "ws://10.0.0.5:4444/session",
    );
  });

  test("an invalid flag value throws here, at config time, not later at connect time", () => {
    expect(() => resolveFirefoxEndpoint(["--connect", "nope"], NO_ENV)).toThrow(
      /invalid Firefox endpoint/,
    );
  });
});

describe("stripConnectFlag", () => {
  test("drops the --connect pair so the value never reaches tool-arg parsing", () => {
    expect(stripConnectFlag(["--connect", "9223", "list_pages"])).toEqual(["list_pages"]);
  });

  test("leaves every other flag and arg intact, in order", () => {
    expect(stripConnectFlag(["--browser", "firefox", "--connect", "9223", "take_snapshot", "--tab", "1"])).toEqual([
      "--browser",
      "firefox",
      "take_snapshot",
      "--tab",
      "1",
    ]);
  });

  test("an argv with no --connect is returned unchanged", () => {
    expect(stripConnectFlag(["list_pages", "--tab", "2"])).toEqual(["list_pages", "--tab", "2"]);
  });
});

describe("resolveBackend", () => {
  test("an endpoint alone IMPLIES the firefox backend", () => {
    expect(resolveBackend(["--connect", "9223"], NO_ENV)).toEqual({
      kind: "firefox",
      endpoint: "ws://127.0.0.1:9223/session",
    });
  });

  test("CDP_FIREFOX_ENDPOINT alone implies firefox too", () => {
    expect(resolveBackend([], { CDP_FIREFOX_ENDPOINT: "127.0.0.1:9223" })).toEqual({
      kind: "firefox",
      endpoint: "ws://127.0.0.1:9223/session",
    });
  });

  test("an EXPLICIT --browser chrome alongside --connect throws instead of silently ignoring one half", () => {
    expect(() => resolveBackend(["--browser", "chrome", "--connect", "9223"], NO_ENV)).toThrow(
      /not valid with the chrome backend/,
    );
  });

  test("an explicit CDP_BROWSER=chrome alongside an endpoint throws for the same reason", () => {
    expect(() => resolveBackend(["--connect", "9223"], { CDP_BROWSER: "chrome" })).toThrow(
      /not valid with the chrome backend/,
    );
  });

  test("an explicit --browser firefox alongside --connect agrees, so it is accepted", () => {
    expect(resolveBackend(["--browser", "firefox", "--connect", "9223"], NO_ENV)).toEqual({
      kind: "firefox",
      endpoint: "ws://127.0.0.1:9223/session",
    });
  });

  test("--browser firefox without an endpoint is LAUNCH mode: no endpoint key at all", () => {
    expect(resolveBackend(["--browser", "firefox"], NO_ENV)).toEqual({ kind: "firefox" });
  });

  test("empty argv + empty env stays chrome, the required zero-behavior-change default", () => {
    expect(resolveBackend([], NO_ENV)).toEqual({ kind: "chrome" });
  });

  test("a bad --browser value still throws, unchanged by the attach plumbing", () => {
    expect(() => resolveBackend(["--browser", "safari"], NO_ENV)).toThrow(/unknown --browser/);
  });
});
