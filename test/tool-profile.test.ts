/**
 * CDP_TOOL_PROFILE parsing (src/toolGroups.ts), unit level: no server, no spawn.
 *
 * resolveProfile is the whole of the 2.1 listing filter, read once at startup, so its
 * spelling tolerance and its canonical label are contract, not incidental behavior —
 * the label appears on the ready line and in the describe_tool catalog header, and two
 * equivalent spellings must produce the same one.
 */
import { describe, expect, test } from "bun:test";
import { PROFILES, TOOL_GROUPS, resolveProfile, type ToolGroup } from "../src/toolGroups.ts";

const groups = (spec: string | undefined): ToolGroup[] => [...resolveProfile(spec).groups].sort() as ToolGroup[];
const ALL = [...TOOL_GROUPS].sort();

describe("resolveProfile", () => {
  test("an absent, blank, or 'full' profile advertises every group", () => {
    for (const spec of [undefined, "", "   ", "full", "FULL"]) {
      expect(groups(spec)).toEqual(ALL);
      expect(resolveProfile(spec).label).toBe("full");
    }
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
    expect(() => resolveProfile("bogus")).toThrow(/Known: full, core, input/);
    // Control: a valid neighbour of the same shape must NOT throw, or the matcher
    // above would pass for a function that rejects everything.
    expect(() => resolveProfile("cookies")).not.toThrow();
  });
});

describe("PROFILES", () => {
  test("the two named profiles are core-only and everything", () => {
    expect(PROFILES.core).toEqual(["core"]);
    expect([...PROFILES.full].sort()).toEqual(ALL);
    expect(PROFILES.full.length).toBe(TOOL_GROUPS.length);
  });
});
