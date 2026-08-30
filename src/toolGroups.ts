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
