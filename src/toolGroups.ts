export const TOOL_GROUPS = [
  "core", "input", "cookies", "network", "console", "mocking",
  "emulation", "performance", "recording", "leases", "permissions",
  "dialogs", "downloads",
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
    "upload_file",
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
} as const;

export const TOOL_GROUP: Record<string, ToolGroup> = {};

for (const group of TOOL_GROUPS) {
  for (const tool of GROUP_TOOLS[group]) {
    TOOL_GROUP[tool] = group;
  }
}

export const PROFILES = {
  core: ["core"],
  full: [...TOOL_GROUPS],
} as const;

export type ProfileName = keyof typeof PROFILES;

/**
 * Resolve CDP_TOOL_PROFILE into the set of groups whose tools tools/list advertises.
 *
 * The profile is a STARTUP filter, read once: the listing it selects is fixed for the
 * life of the process (2.1 dropped the runtime `browser_tools` toggle, so the tool set
 * can never change as a side effect of another request — a spec MUST). Accepted
 * spellings: unset/empty or "full" (everything), "core" (the lean everyday set), or a
 * comma-separated list of group names. `core` is always included, so a list can never
 * strand the basics.
 */
export function resolveProfile(spec: string | undefined): { groups: ReadonlySet<ToolGroup>; label: string } {
  const all = (): { groups: ReadonlySet<ToolGroup>; label: string } => ({ groups: new Set(TOOL_GROUPS), label: "full" });
  const raw = (spec ?? "").trim();
  if (raw === "" || raw.toLowerCase() === "full") return all();

  const tokens = raw.split(",").map((t) => t.trim().toLowerCase()).filter((t) => t !== "");
  if (tokens.includes("full")) return all();

  const known = new Set<string>(TOOL_GROUPS);
  const picked = new Set<ToolGroup>(["core"]);
  for (const token of tokens) {
    if (!known.has(token)) {
      throw new Error(`CDP_TOOL_PROFILE: unknown tool group '${token}'. Known: full, core, ${TOOL_GROUPS.filter((g) => g !== "core").join(", ")}`);
    }
    picked.add(token as ToolGroup);
  }
  if (picked.size === TOOL_GROUPS.length) return all();
  // Canonical label: TOOL_GROUPS order, not the order the caller typed, so the ready
  // line and the catalog header read the same for every equivalent spelling.
  return { groups: picked, label: TOOL_GROUPS.filter((g) => picked.has(g)).join(",") };
}
