/**
 * Drift guard for the target-selector grammar restated across MANIFEST tool
 * descriptions. Every tool that accepts a page selector documents the whole
 * grammar inline rather than pointing at one shared doc, so adding a new arm
 * (like "label:<name>" in 1.9.0) is a sweep across many description strings by
 * hand — exactly the kind of edit that misses a straggler. This asserts the
 * invariant structurally instead of trusting the sweep: any description that
 * mentions the "title:<substr...>" arm of the grammar must also mention
 * "label:", because the two arms were always added together.
 *
 * The second guard is its mirror image: the Chrome-only "worker:" arm may be
 * named ONLY by the tools in WORKER_CAPABLE_TOOLS (one in 1.9.0, four in 1.9.1),
 * so a sweep can never promote it to universal grammar.
 */
import { describe, expect, test } from "bun:test";
import { MANIFEST } from "../src/manifest.ts";
import { TOOL_DOCS } from "../src/toolDocs.ts";
import { WORKER_CAPABLE_TOOLS } from "../src/workers.ts";

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
   * The "worker:<substring>" arm is NOT part of the universal grammar and must
   * never be swept into it the way "label:" deliberately was. It is resolved
   * only by Chrome's pickTarget, accepted by exactly the tools in
   * WORKER_CAPABLE_TOOLS, and refused on Firefox and by the page-only
   * resolvers. So the drift guard here is the OPPOSITE of the one above: an
   * ALLOWLIST, not a completeness sweep. A later edit that adds "worker:" to
   * every selector description would be advertising a grammar most of the tools
   * reject, and this fails it.
   *
   * 1.9.1 WIDENED the allowlist from one tool to four (deliberately, per the
   * release spec) and kept its shape: a fifth tool cannot start advertising the
   * arm without an explicit edit to WORKER_CAPABLE_TOOLS, which is also what the
   * refusal messages are built from.
   */
  test("'worker:' is advertised ONLY by the worker-capable allowlist, never as universal grammar", () => {
    const allowed = new Set<string>(WORKER_CAPABLE_TOOLS);
    const offenders: string[] = [];
    for (const tool of MANIFEST) {
      if (allowed.has(tool.name)) continue;
      const props = (tool.inputSchema as { properties?: Record<string, { description?: string }> }).properties ?? {};
      for (const [key, schema] of Object.entries(props)) {
        if (/worker:</.test(schema?.description ?? "")) offenders.push(`${tool.name}.${key}`);
      }
      if (/worker:</.test(tool.description ?? "")) offenders.push(`${tool.name}.description`);
    }
    expect(offenders).toEqual([]);
  });

  test("the allowlist is exactly the four worker-capable tools, and each really is in the manifest", () => {
    // Pinned by value: widening the arm is a decision, so it has to break a test
    // that names the four rather than silently accepting a fifth.
    expect([...WORKER_CAPABLE_TOOLS]).toEqual([
      "evaluate_script",
      "list_network_requests",
      "get_network_request",
      "list_console_messages",
    ]);
    for (const name of WORKER_CAPABLE_TOOLS) {
      expect(MANIFEST.find((t) => t.name === name)).toBeDefined();
    }
  });

  /**
   * The three recorder-backed tools have to teach things a caller cannot
   * discover by trying: that the arm is Chrome-only, that recording a worker
   * KEEPS IT ALIVE (a side effect on the thing being observed), and why the two
   * tricks they would otherwise reach for do not work. Each is asserted
   * separately so a description that drops one fails on that one.
   */
  test("each recorder-backed worker tool documents the arm, the chrome-only gate and the keep-alive side effect", () => {
    for (const name of ["list_network_requests", "get_network_request", "list_console_messages"]) {
      const tool = MANIFEST.find((t) => t.name === name);
      expect(tool).toBeDefined();
      const props = (tool!.inputSchema as { properties: Record<string, { type?: string; description?: string }> }).properties;
      const docs = TOOL_DOCS[name];
      expect(docs.params.target ?? "").toContain("worker:<substring>");
      expect(docs.params.target ?? "").toMatch(/CHROME-ONLY|Chrome only/);
      expect(docs.description).toMatch(/worker\.targets/);
      expect(docs.description).toMatch(/KEEPS\s+THE\s+WORKER\s+ALIVE/);
      // wake is a real, documented argument on all three, and it names the
      // eviction fact it exists for.
      expect(props.wake?.type).toBe("boolean");
      expect(docs.params.wake ?? "").toMatch(/idle-evicted/);
    }
  });

  /**
   * THE MISDIAGNOSIS GUARD (owner correction, 2026-08-10).
   *
   * The field report that motivated this feature blamed service-worker realm
   * semantics — "evaluate can't see module state, a self.fetch patch doesn't
   * stick, so eval-based interception is structurally unreliable in a SW". That
   * diagnosis was WRONG: the real cause was an outdated extension build loaded
   * in the browser, and W1's probes read chrome.storage out of a SW eval
   * perfectly well. What survives it is narrower and is ordinary JavaScript,
   * true in a page just as much as in a worker: a module-scoped binding is not
   * on the global object evaluate_script sees, and assigning self.fetch cannot
   * rebind a reference some module already captured.
   *
   * So this pins BOTH halves. The two real reasons must be stated, and the realm
   * story must not come back on the next docs sweep — a wrong explanation in a
   * tool description is worse than none, because the caller acts on it.
   */
  test("the worker descriptions give the MEASURED reason, and never the service-worker-realm misdiagnosis", () => {
    for (const name of ["list_network_requests", "get_network_request", "list_console_messages"]) {
      const desc = TOOL_DOCS[name].description ?? "";
      expect(desc).toMatch(/Network domain/);
      expect(desc).toMatch(/global scope/);
      expect(desc).toMatch(/self\.fetch/);
      expect(desc).not.toMatch(/structurally unreliable/i);
      expect(desc).not.toMatch(/realm/i);
    }
  });

  test("get_console_message is NOT advertised as worker-capable (index-into-a-buffer is not the worker story)", () => {
    const tool = MANIFEST.find((t) => t.name === "get_console_message");
    expect(tool).toBeDefined();
    expect(WORKER_CAPABLE_TOOLS as readonly string[]).not.toContain("get_console_message");
    const props = (tool!.inputSchema as { properties: Record<string, { description?: string }> }).properties;
    expect(props.target?.description ?? "").not.toContain("worker:<");
    expect(props.wake).toBeUndefined();
  });

  test("evaluate_script documents the worker: arm, its chrome-only gate, and the wake argument", () => {
    const tool = MANIFEST.find((t) => t.name === "evaluate_script");
    expect(tool).toBeDefined();
    const props = (tool!.inputSchema as { properties: Record<string, { type?: string; description?: string }> }).properties;
    const docs = TOOL_DOCS["evaluate_script"];
    const target = docs.params.target ?? "";
    expect(target).toContain("worker:<substring>");
    // The capability gate has to be IN the description a caller reads, not only
    // in the error they hit after trying it on Firefox.
    expect(target).toMatch(/CHROME-ONLY|Chrome only/);
    expect(props.wake?.type).toBe("boolean");
    // The eviction fact is the whole teaching; a `wake` description that did not
    // state it would leave the caller with a flag and no model of what it fixes.
    expect(docs.params.wake ?? "").toMatch(/idle-evicted/);
  });

  test("evaluate_script's 'expression' description names every alias key the key-echo error covers", () => {
    const desc = TOOL_DOCS["evaluate_script"].params.expression ?? "";
    for (const alias of ["function", "code", "js", "script", "fn", "body"]) {
      expect(desc).toContain(`'${alias}'`);
    }
  });
});
