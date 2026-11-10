import { describe, expect, test } from "bun:test";
import { TOOLS } from "../src/index.ts";
import {
  META_TOOLS,
  MUTATING_TOOLS,
  PolicyError,
  READ_TOOLS,
  assertAllowed,
  isReadTool,
  toolAnnotations,
} from "../src/policy.ts";

const RO = { name: "teams", readOnly: true };
const RW = { name: "browser", readOnly: false };

describe("policy classification", () => {
  test("every registry tool is in exactly one of READ / MUTATING", () => {
    const names = Object.keys(TOOLS);
    expect(names.length).toBeGreaterThan(0);
    const unclassified = names.filter((n) => !READ_TOOLS.has(n) && !MUTATING_TOOLS.has(n));
    const both = names.filter((n) => READ_TOOLS.has(n) && MUTATING_TOOLS.has(n));
    expect({ unclassified, both }).toEqual({ unclassified: [], both: [] });
  });

  test("the sets hold no names outside the registry and the meta tools", () => {
    const known = new Set([...Object.keys(TOOLS), ...META_TOOLS]);
    const stray = [...READ_TOOLS, ...MUTATING_TOOLS].filter((n) => !known.has(n));
    expect(stray).toEqual([]);
  });

  test("no name appears in two sets", () => {
    const all = [...READ_TOOLS, ...MUTATING_TOOLS, ...META_TOOLS];
    expect(all.length).toBe(new Set(all).size);
  });

  test("meta tools are covered", () => {
    for (const n of ["call_tool", "search_tools"]) expect(META_TOOLS.has(n)).toBe(true);
  });

  test("evaluate_script is READ by decision", () => {
    expect(isReadTool("evaluate_script")).toBe(true);
    expect(toolAnnotations("evaluate_script")).toEqual({ readOnlyHint: true });
    expect(toolAnnotations("click")).toEqual({ readOnlyHint: false });
    expect(toolAnnotations("no_such_tool")).toEqual({ readOnlyHint: false });
  });
});

describe("assertAllowed", () => {
  test("refuses every mutating tool on a read-only endpoint, naming tool and endpoint", () => {
    for (const tool of MUTATING_TOOLS) {
      let err: unknown;
      try {
        assertAllowed(tool, RO);
      } catch (e) {
        err = e;
      }
      expect(err).toBeInstanceOf(PolicyError);
      const pe = err as PolicyError;
      expect(pe.code).toBe("read_only_endpoint");
      expect(pe.message).toContain(tool);
      expect(pe.message).toContain("teams");
    }
  });

  test("passes READ tools, including evaluate_script, and meta tools on a read-only endpoint", () => {
    for (const tool of [...READ_TOOLS, ...META_TOOLS]) {
      expect(() => assertAllowed(tool, RO)).not.toThrow();
    }
    expect(() => assertAllowed("evaluate_script", RO)).not.toThrow();
  });

  test("passes everything on a non-read-only endpoint", () => {
    for (const tool of [...READ_TOOLS, ...MUTATING_TOOLS, ...META_TOOLS, "unknown_tool"]) {
      expect(() => assertAllowed(tool, RW)).not.toThrow();
    }
  });

  test("an unknown name is denied on a read-only endpoint", () => {
    expect(() => assertAllowed("totally_new_tool", RO)).toThrow(PolicyError);
  });

  test("READ tools with a state-changing argument are refused when args are passed", () => {
    expect(() => assertAllowed("list_console_messages", RO, { reload: true })).toThrow(PolicyError);
    expect(() => assertAllowed("list_network_requests", RO, { reload: true })).toThrow(PolicyError);
    expect(() => assertAllowed("get_network_request", RO, { url: "x", includeBody: true })).toThrow(PolicyError);
    expect(() => assertAllowed("take_screenshot", RO, { renderWidth: 800 })).toThrow(PolicyError);
    // controls: the same tools without the escalating argument pass
    expect(() => assertAllowed("list_console_messages", RO, { reload: false })).not.toThrow();
    expect(() => assertAllowed("take_screenshot", RO, {})).not.toThrow();
  });
});
