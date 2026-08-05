/**
 * The complete Firefox tool registry: the 20 tools shared with Chrome (src/shared-tools.ts) plus
 * the 7 Firefox-only console/network/mock tools (src/bidi-tools.ts). This is what src/neutral.ts
 * used to be; it now composes two files instead of reimplementing everything in one.
 */
import type { BrowserDriver } from "./driver.ts";
import type { ToolName } from "./index.ts";
import { SHARED_TOOLS } from "./shared-tools.ts";
import { BIDI_ONLY_TOOLS } from "./bidi-tools.ts";

export const FIREFOX_TOOLS: Partial<Record<ToolName, (driver: BrowserDriver, args: never) => Promise<unknown>>> = {
  ...SHARED_TOOLS,
  ...BIDI_ONLY_TOOLS,
};
