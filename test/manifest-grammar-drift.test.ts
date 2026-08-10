/**
 * Drift guard for the target-selector grammar restated across MANIFEST tool
 * descriptions. Every tool that accepts a page selector documents the whole
 * grammar inline rather than pointing at one shared doc, so adding a new arm
 * (like "label:<name>" in 1.9.0) is a sweep across many description strings by
 * hand — exactly the kind of edit that misses a straggler. This asserts the
 * invariant structurally instead of trusting the sweep: any description that
 * mentions the "title:<substr...>" arm of the grammar must also mention
 * "label:", because the two arms were always added together.
 */
import { describe, expect, test } from "bun:test";
import { MANIFEST } from "../src/manifest.ts";

describe("manifest grammar drift", () => {
  test("every selector description naming 'title:' also names 'label:'", () => {
    const offenders: string[] = [];
    for (const tool of MANIFEST) {
      const props = (tool.inputSchema as { properties?: Record<string, { description?: string }> }).properties ?? {};
      for (const [key, schema] of Object.entries(props)) {
        const desc = schema?.description ?? "";
        if (/title:<substr/.test(desc) && !/label:</.test(desc)) {
          offenders.push(`${tool.name}.${key}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  test("evaluate_script's 'expression' description names every alias key the key-echo error covers", () => {
    const tool = MANIFEST.find((t) => t.name === "evaluate_script");
    expect(tool).toBeDefined();
    const desc = (tool!.inputSchema as { properties: Record<string, { description?: string }> }).properties.expression?.description ?? "";
    for (const alias of ["function", "code", "js", "script", "fn", "body"]) {
      expect(desc).toContain(`'${alias}'`);
    }
  });
});
