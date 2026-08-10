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

  /**
   * The 1.9.0 "worker:<substring>" arm is NOT part of the universal grammar and
   * must never be swept into it the way "label:" deliberately was. It is
   * resolved only by Chrome's pickTarget, accepted only by evaluate_script, and
   * refused on Firefox and by the page-only resolvers. So the drift guard here
   * is the OPPOSITE of the one above: an inclusion test, not a completeness one.
   * A future sweep that adds "worker:" to every selector description would be
   * advertising a grammar three quarters of the tools reject, and this fails it.
   */
  test("'worker:' is advertised ONLY by evaluate_script, never as universal grammar", () => {
    const offenders: string[] = [];
    for (const tool of MANIFEST) {
      if (tool.name === "evaluate_script") continue;
      const props = (tool.inputSchema as { properties?: Record<string, { description?: string }> }).properties ?? {};
      for (const [key, schema] of Object.entries(props)) {
        if (/worker:</.test(schema?.description ?? "")) offenders.push(`${tool.name}.${key}`);
      }
      if (/worker:</.test(tool.description ?? "")) offenders.push(`${tool.name}.description`);
    }
    expect(offenders).toEqual([]);
  });

  test("evaluate_script documents the worker: arm, its chrome-only gate, and the wake argument", () => {
    const tool = MANIFEST.find((t) => t.name === "evaluate_script");
    expect(tool).toBeDefined();
    const props = (tool!.inputSchema as { properties: Record<string, { type?: string; description?: string }> }).properties;
    const target = props.target?.description ?? "";
    expect(target).toContain("worker:<substring>");
    // The capability gate has to be IN the description a caller reads, not only
    // in the error they hit after trying it on Firefox.
    expect(target).toMatch(/CHROME-ONLY|Chrome only/);
    expect(props.wake?.type).toBe("boolean");
    // The eviction fact is the whole teaching; a `wake` description that did not
    // state it would leave the caller with a flag and no model of what it fixes.
    expect(props.wake?.description ?? "").toMatch(/idle-evicted/);
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
