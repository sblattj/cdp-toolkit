/**
 * Unit tests for src/bidi/snapshot.ts. happy-dom is not installed and
 * CONTRACT.md forbids adding a runtime dependency for a devDep-only need, so
 * these tests cover the PURE logic exported for that purpose (stamp
 * reuse/uniqueness, name truncation, tree-line formatting, the generated
 * source's shape, and result coercion) rather than driving a constructed DOM
 * in-process. The generated function source was exercised against real
 * Firefox (via src/bidi/launch.ts + src/bidi/client.ts) as part of manual
 * acceptance and is not repeated here since that path needs a browser.
 */
import { describe, expect, test } from "bun:test";
import {
  STAMP_ATTR,
  MAX_NAME_LENGTH,
  reuseOrMintStamp,
  truncateName,
  formatSnapshotLine,
  buildSnapshotFunctionSource,
  coerceSnapshotResult,
} from "../src/bidi/snapshot.ts";

describe("STAMP_ATTR", () => {
  test("matches the driver.ts UID_STAMP_ATTR contract", () => {
    expect(STAMP_ATTR).toBe("data-cdp-uid");
  });
});

describe("reuseOrMintStamp", () => {
  test("reuses an existing stamp instead of minting a new one", () => {
    let minted = 0;
    const mint = () => {
      minted += 1;
      return `new-${minted}`;
    };
    expect(reuseOrMintStamp("abc123", mint)).toBe("abc123");
    expect(minted).toBe(0);
  });

  test("mints a fresh stamp when none exists", () => {
    const stamp = reuseOrMintStamp(undefined, () => "minted-1");
    expect(stamp).toBe("minted-1");
  });

  test("mints when the existing stamp is an empty string", () => {
    const stamp = reuseOrMintStamp("", () => "minted-2");
    expect(stamp).toBe("minted-2");
  });

  test("repeated mint calls are unique across many nodes", () => {
    let counter = 0;
    const mint = () => `s${counter++}`;
    const stamps = new Set<string>();
    for (let i = 0; i < 500; i++) stamps.add(reuseOrMintStamp(undefined, mint));
    expect(stamps.size).toBe(500);
  });
});

describe("truncateName", () => {
  test("collapses internal whitespace and trims", () => {
    expect(truncateName("  hello   world  \n\t")).toBe("hello world");
  });

  test("leaves short names untouched", () => {
    expect(truncateName("Submit")).toBe("Submit");
  });

  test("truncates long names with an ellipsis, respecting maxLength", () => {
    const long = "x".repeat(200);
    const truncated = truncateName(long, 20);
    expect(truncated.length).toBe(20);
    expect(truncated.endsWith("…")).toBe(true);
  });

  test("default max length matches MAX_NAME_LENGTH", () => {
    const long = "y".repeat(MAX_NAME_LENGTH + 50);
    expect(truncateName(long).length).toBe(MAX_NAME_LENGTH);
  });
});

describe("formatSnapshotLine", () => {
  test("matches Chrome's [uid] role \"name\" [extra] shape", () => {
    const line = formatSnapshotLine("f1a2b3", "button", "Submit", [], 0);
    expect(line).toBe('[f1a2b3] button "Submit"');
  });

  test("omits the name quote block when name is absent", () => {
    const line = formatSnapshotLine("f1", "form", undefined, [], 0);
    expect(line).toBe("[f1] form");
  });

  test("renders extras in brackets", () => {
    const line = formatSnapshotLine("f2", "checkbox", "Agree", ["checked=true"], 1);
    expect(line).toBe('  [f2] checkbox "Agree" [checked=true]');
  });

  test("indents by two spaces per depth level", () => {
    const line = formatSnapshotLine("f3", "textbox", "Name", [], 3);
    expect(line.startsWith("      [f3]")).toBe(true);
  });
});

describe("buildSnapshotFunctionSource", () => {
  test("returns a self-contained zero-argument function expression", () => {
    const src = buildSnapshotFunctionSource();
    expect(src.trim().startsWith("function()")).toBe(true);
    expect(src).toContain(JSON.stringify(STAMP_ATTR));
  });

  test("carries no em dash or en dash", () => {
    expect(/—|–/.test(buildSnapshotFunctionSource())).toBe(false);
  });

  test("is valid JavaScript (parses without throwing)", () => {
    // Wrapping in parens makes the function expression a valid top-level
    // expression statement for the Function constructor to parse.
    expect(() => new Function(`return (${buildSnapshotFunctionSource()});`)).not.toThrow();
  });
});

describe("coerceSnapshotResult", () => {
  test("passes through a well-shaped result", () => {
    const result = coerceSnapshotResult({ snapshot: "[f1] button \"Go\"", nodeCount: 1 });
    expect(result).toEqual({ snapshot: "[f1] button \"Go\"", nodeCount: 1 });
  });

  test("throws on a missing snapshot field", () => {
    expect(() => coerceSnapshotResult({ nodeCount: 1 })).toThrow();
  });

  test("throws on a non-object", () => {
    expect(() => coerceSnapshotResult("not an object")).toThrow();
  });

  test("throws on a wrong-typed nodeCount", () => {
    expect(() => coerceSnapshotResult({ snapshot: "x", nodeCount: "1" })).toThrow();
  });
});
