/**
 * The complete Firefox tool registry: the 23 tools shared with Chrome (src/shared-tools.ts), the
 * 7 Firefox-only console/network/mock tools (src/bidi-tools.ts), the 3 lease tools
 * (src/leases-tools.ts), and extract_page (src/tools/extract.ts), which is backend-neutral by
 * construction (its page work runs entirely through Driver.evaluate). This is what src/neutral.ts
 * used to be; it now composes four files instead of reimplementing everything in one.
 */
import type { BrowserDriver } from "./driver.ts";
import type { ToolName } from "./index.ts";
import { SHARED_TOOLS } from "./shared-tools.ts";
import { BIDI_ONLY_TOOLS } from "./bidi-tools.ts";
import { LEASE_TOOLS } from "./leases-tools.ts";
import { extractPage } from "./tools/extract.ts";

export const FIREFOX_TOOLS: Partial<Record<ToolName, (driver: BrowserDriver, args: never) => Promise<unknown>>> = {
  ...SHARED_TOOLS,
  ...BIDI_ONLY_TOOLS,
  ...LEASE_TOOLS,
  extract_page: extractPage,
};
