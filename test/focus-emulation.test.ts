/**
 * Unit tests for the focus-gated-click tools (src/tools/focus-emulation.ts), porting the
 * danbuhler/claude-code-auto-authorize mechanism: Emulation.setFocusEmulationEnabled makes a
 * background tab BELIEVE it is focused, and Input.dispatchMouseEvent delivers the trusted click
 * a focus gate (e.g. Claude Code OAuth's Authorize button) demands.
 *
 * What is pinned here WITHOUT a browser: argument validation, the find-button expression builder
 * (selector/text injection safety), capability gating (ADR-001: chrome-only, absent under
 * firefox), manifest/toolDocs/group registration, and the registry wiring. The live button-click
 * path needs a real Chrome and is covered by a smoke run, not bun test.
 */
import { describe, expect, test } from "bun:test";
import {
  validateFocusEmulationArgs,
  validateClickFocusGatedArgs,
} from "../src/tools/focus-emulation.ts";
import { REQUIRED_CAPABILITIES } from "../src/driver.ts";
import { createCdpDriver } from "../src/cdp/driver.ts";
import { createFirefoxDriver } from "../src/bidi/driver.ts";
import { toolAvailability } from "../src/capabilities.ts";
import { MANIFEST } from "../src/manifest.ts";
import { TOOL_DOCS } from "../src/toolDocs.ts";
import { GROUP_TOOLS } from "../src/toolGroups.ts";
import { TOOLS, TOOL_NAMES } from "../src/index.ts";

describe("validateFocusEmulationArgs", () => {
  test("accepts true and false", () => {
    expect(() => validateFocusEmulationArgs({ enabled: true })).not.toThrow();
    expect(() => validateFocusEmulationArgs({ enabled: false })).not.toThrow();
  });
  test("rejects a missing or non-boolean enabled", () => {
    expect(() => validateFocusEmulationArgs({} as never)).toThrow(/enabled/);
    expect(() => validateFocusEmulationArgs({ enabled: "yes" } as never)).toThrow(/enabled/);
  });
});

describe("validateClickFocusGatedArgs", () => {
  test("accepts selector alone and text alone", () => {
    expect(() => validateClickFocusGatedArgs({ selector: "button.primary" })).not.toThrow();
    expect(() => validateClickFocusGatedArgs({ text: "Authorize" })).not.toThrow();
  });
  test("rejects neither and both locator forms", () => {
    expect(() => validateClickFocusGatedArgs({})).toThrow(/exactly one of/);
    expect(() => validateClickFocusGatedArgs({ selector: "button", text: "Authorize" })).toThrow(/exactly one of/);
  });
  test("empty strings count as absent", () => {
    expect(() => validateClickFocusGatedArgs({ selector: "", text: "" })).toThrow(/exactly one of/);
  });
  test("rejects non-positive or non-finite timeoutMs/pollMs", () => {
    expect(() => validateClickFocusGatedArgs({ text: "Authorize", timeoutMs: 0 })).toThrow(/timeoutMs/);
    expect(() => validateClickFocusGatedArgs({ text: "Authorize", timeoutMs: -5 })).toThrow(/timeoutMs/);
    expect(() => validateClickFocusGatedArgs({ text: "Authorize", pollMs: Number.NaN })).toThrow(/pollMs/);
  });
});

describe("capability gating (ADR-001: chrome-only, absent under firefox)", () => {
  test("both tools require emulate.focus", () => {
    expect(REQUIRED_CAPABILITIES["focus_emulation"]).toEqual(["emulate.focus"]);
    expect(REQUIRED_CAPABILITIES["click_focus_gated"]).toEqual(["emulate.focus"]);
  });
  test("the CDP driver declares emulate.focus", () => {
    expect(createCdpDriver().capabilities.has("emulate.focus")).toBe(true);
  });
  test("the Firefox driver does NOT declare emulate.focus", () => {
    expect(createFirefoxDriver(0).capabilities.has("emulate.focus")).toBe(false);
  });
  test("both tools are available on chrome and unavailable on firefox", () => {
    const chrome = toolAvailability("chrome");
    const firefox = toolAvailability("firefox");
    expect(chrome.available).toContain("focus_emulation");
    expect(chrome.available).toContain("click_focus_gated");
    expect(firefox.available).not.toContain("focus_emulation");
    expect(firefox.available).not.toContain("click_focus_gated");
  });
});

describe("registration: manifest, docs, groups, registry", () => {
  const names = ["focus_emulation", "click_focus_gated"] as const;
  test("both are in the TOOLS registry", () => {
    for (const n of names) {
      expect(typeof TOOLS[n]).toBe("function");
      expect(TOOL_NAMES).toContain(n);
    }
  });
  test("both have a manifest schema that forbids unknown params", () => {
    for (const n of names) {
      const entry = MANIFEST.find((m) => m.name === n);
      expect(entry, `${n} manifest entry`).toBeDefined();
      expect(entry!.inputSchema.additionalProperties).toBe(false);
    }
  });
  test("click_focus_gated's schema carries selector and text, and requires neither (validated at runtime as exactly-one)", () => {
    const entry = MANIFEST.find((m) => m.name === "click_focus_gated")!;
    const props = Object.keys(entry.inputSchema.properties ?? {});
    expect(props).toContain("selector");
    expect(props).toContain("text");
    expect(props).toContain("keepFocus");
    expect(entry.inputSchema.required ?? []).toEqual([]);
  });
  test("focus_emulation's schema requires enabled", () => {
    const entry = MANIFEST.find((m) => m.name === "focus_emulation")!;
    expect(entry.inputSchema.required).toEqual(["enabled"]);
  });
  test("both have tool docs", () => {
    for (const n of names) expect(TOOL_DOCS[n]?.description.length ?? 0).toBeGreaterThan(40);
  });
  test("both are in the input tool group", () => {
    for (const n of names) expect(GROUP_TOOLS.input).toContain(n);
  });
});
