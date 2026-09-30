export const TOOL_GROUPS = [
  "core", "input", "cookies", "network", "console", "mocking",
  "emulation", "performance", "recording", "leases", "permissions",
  "dialogs", "downloads", "extraction",
] as const;

export type ToolGroup = (typeof TOOL_GROUPS)[number];

export const GROUP_TOOLS: Record<ToolGroup, readonly string[]> = {
  core: [
    "list_pages", "new_page", "close_page", "select_page", "navigate_page",
    "wait_for", "take_snapshot", "click", "fill", "type_text",
    "evaluate_script", "take_screenshot",
  ],
  input: [
    "hover", "drag", "scroll", "dispatch_mouse", "press_key", "fill_form",
    "upload_file", "focus_emulation", "click_focus_gated",
  ],
  cookies: ["list_cookies", "set_cookie", "delete_cookies"],
  network: ["list_network_requests", "get_network_request"],
  console: ["list_console_messages", "get_console_message"],
  mocking: ["mock_request", "list_mocks", "clear_mocks"],
  emulation: ["emulate", "resize_page"],
  performance: [
    "performance_start_trace", "performance_stop_trace",
    "performance_analyze_insight", "performance_trace", "take_heapsnapshot",
    "lighthouse_audit",
  ],
  recording: ["start_screen_recording", "stop_screen_recording"],
  leases: ["claim_page", "release_page", "list_leases"],
  permissions: ["grant_permissions"],
  dialogs: ["handle_dialog"],
  downloads: ["wait_for_download"],
  extraction: ["extract_page"],
} as const;

export const TOOL_GROUP: Record<string, ToolGroup> = {};

for (const group of TOOL_GROUPS) {
  for (const tool of GROUP_TOOLS[group]) {
    TOOL_GROUP[tool] = group;
  }
}

/**
 * The 3.0 default listing: the five tools nearly every browser task touches. Everything
 * else is reached through the search_tools / call_tool meta-tools (src/mcp.ts), so an
 * eagerly-loading host pays for 7 schemas instead of 49. evaluate_script is the escape
 * hatch that covers most of what the other 43 do.
 */
export const GATEWAY_TOOLS = ["navigate_page", "take_snapshot", "click", "fill", "evaluate_script"] as const;

export const PROFILES = {
  gateway: [],
  core: ["core"],
  full: [...TOOL_GROUPS],
} as const;

export type ProfileName = keyof typeof PROFILES;

/** What tools/list advertises: every tool in `groups`, plus the individual `tools`. */
export interface ResolvedProfile {
  groups: ReadonlySet<ToolGroup>;
  tools: ReadonlySet<string>;
  label: string;
}

/** True when a profile advertises `name` in tools/list. */
export function isListed(profile: ResolvedProfile, name: string): boolean {
  const group = TOOL_GROUP[name];
  return profile.tools.has(name) || (group !== undefined && profile.groups.has(group));
}

/**
 * Resolve CDP_TOOL_PROFILE into what tools/list advertises.
 *
 * The profile is a STARTUP filter, read once: the listing it selects is fixed for the
 * life of the process (2.1 dropped the runtime `browser_tools` toggle, so the tool set
 * can never change as a side effect of another request — a spec MUST). Accepted
 * spellings: unset/empty or "gateway" (the 5 GATEWAY_TOOLS; the 3.0 default), "full"
 * (everything), "core" (the 12-tool everyday group), or a comma-separated list of group
 * names, optionally including "gateway". A group list without "gateway" always includes
 * `core`, so it can never strand the basics.
 */
export function resolveProfile(spec: string | undefined): ResolvedProfile {
  const all = (): ResolvedProfile => ({ groups: new Set(TOOL_GROUPS), tools: new Set(), label: "full" });
  const raw = (spec ?? "").trim();
  if (raw === "") return { groups: new Set(), tools: new Set(GATEWAY_TOOLS), label: "gateway" };
  if (raw.toLowerCase() === "full") return all();

  const tokens = raw.split(",").map((t) => t.trim().toLowerCase()).filter((t) => t !== "");
  if (tokens.includes("full")) return all();

  const gateway = tokens.includes("gateway");
  const known = new Set<string>(TOOL_GROUPS);
  const picked = new Set<ToolGroup>(gateway ? [] : ["core"]);
  for (const token of tokens) {
    if (token === "gateway") continue;
    if (!known.has(token)) {
      throw new Error(`CDP_TOOL_PROFILE: unknown tool group '${token}'. Known: gateway, full, core, ${TOOL_GROUPS.filter((g) => g !== "core").join(", ")}`);
    }
    picked.add(token as ToolGroup);
  }
  if (picked.size === TOOL_GROUPS.length) return all();
  // Canonical label: TOOL_GROUPS order, not the order the caller typed, so the ready
  // line and the catalog header read the same for every equivalent spelling.
  const groupLabel = TOOL_GROUPS.filter((g) => picked.has(g));
  return {
    groups: picked,
    tools: new Set(gateway ? GATEWAY_TOOLS : []),
    label: (gateway ? ["gateway", ...groupLabel] : groupLabel).join(","),
  };
}
