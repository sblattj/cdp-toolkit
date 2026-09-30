/**
 * CDP_TOOL_PROFILE parsing (src/toolGroups.ts), unit level: no server, no spawn.
 *
 * resolveProfile is the whole of the 2.1 listing filter, read once at startup, so its
 * spelling tolerance and its canonical label are contract, not incidental behavior —
 * the label appears on the ready line and in the describe_tool catalog header, and two
 * equivalent spellings must produce the same one.
 */
import { describe, expect, test } from "bun:test";
import { GATEWAY_TOOLS, PROFILES, TOOL_GROUPS, isListed, resolveProfile, type ToolGroup } from "../src/toolGroups.ts";

const groups = (spec: string | undefined): ToolGroup[] => [...resolveProfile(spec).groups].sort() as ToolGroup[];
const ALL = [...TOOL_GROUPS].sort();

describe("resolveProfile", () => {
  test("an absent or blank profile is the 3.0 gateway: the 5 GATEWAY_TOOLS, no whole group", () => {
    for (const spec of [undefined, "", "   ", "gateway", " Gateway "]) {
      const p = resolveProfile(spec);
      expect(groups(spec)).toEqual([]);
      expect([...p.tools].sort()).toEqual([...GATEWAY_TOOLS].sort());
      expect(p.label).toBe("gateway");
    }
  });

  test("gateway lists exactly its 5 tools and nothing else from their group", () => {
    const p = resolveProfile(undefined);
    for (const name of GATEWAY_TOOLS) expect(isListed(p, name)).toBe(true);
    // Control: core-group siblings of the gateway tools stay unlisted.
    expect(isListed(p, "new_page")).toBe(false);
    expect(isListed(p, "take_screenshot")).toBe(false);
  });

  test("'full' advertises every group", () => {
    for (const spec of ["full", "FULL"]) {
      expect(groups(spec)).toEqual(ALL);
      expect(resolveProfile(spec).label).toBe("full");
    }
  });

  test("gateway plus groups adds those groups without forcing core in", () => {
    const p = resolveProfile("network, gateway");
    expect(groups("network, gateway")).toEqual(["network"]);
    expect(p.label).toBe("gateway,network");
    expect(isListed(p, "list_network_requests")).toBe(true);
    expect(isListed(p, "click")).toBe(true);
    expect(isListed(p, "new_page")).toBe(false);
  });

  test("'core' narrows to core alone", () => {
    expect(groups("core")).toEqual(["core"]);
    expect(resolveProfile("core").label).toBe("core");
  });

  test("core is always included, so a list can never strand the basics", () => {
    expect(groups("network")).toEqual(["core", "network"].sort());
    expect(resolveProfile("network").label).toBe("core,network");
  });

  test("tokens are trimmed and case-insensitive, and the label is canonical order", () => {
    // Input order is console-then-network; the label is TOOL_GROUPS order regardless.
    expect(resolveProfile(" Console , network ").label).toBe("core,network,console");
    expect(groups(" Console , network ")).toEqual(["console", "core", "network"]);
    // Control: the label is not simply the input echoed back.
    expect(resolveProfile("network,console").label).toBe("core,network,console");
  });

  test("an empty token in the list is tolerated", () => {
    expect(groups("core,,network")).toEqual(["core", "network"]);
    expect(resolveProfile("core,,network").label).toBe("core,network");
  });

  test("'full' anywhere in a list wins", () => {
    expect(groups("core,full")).toEqual(ALL);
    expect(resolveProfile("core,full").label).toBe("full");
  });

  test("naming every group collapses back to the 'full' label", () => {
    const spec = TOOL_GROUPS.join(",");
    expect(groups(spec)).toEqual(ALL);
    expect(resolveProfile(spec).label).toBe("full");
  });

  test("an unknown group is a configuration error naming the known ones", () => {
    expect(() => resolveProfile("bogus")).toThrow(/unknown tool group 'bogus'/);
    expect(() => resolveProfile("bogus")).toThrow(/Known: gateway, full, core, input/);
    // Control: a valid neighbour of the same shape must NOT throw, or the matcher
    // above would pass for a function that rejects everything.
    expect(() => resolveProfile("cookies")).not.toThrow();
  });
});

describe("PROFILES", () => {
  test("the named profiles are gateway (no whole group), core-only, and everything", () => {
    expect(PROFILES.gateway).toEqual([]);
    expect(PROFILES.core).toEqual(["core"]);
    expect([...PROFILES.full].sort()).toEqual(ALL);
    expect(PROFILES.full.length).toBe(TOOL_GROUPS.length);
  });
});
