/**
 * Gate for live Firefox 160+ tests: an explicit FIREFOX_BIN or the macOS app, and its version is 160 or
 * newer. A bare `firefox` on PATH (a CI runner's stub) can take longer than the launch timeout to open its
 * debug port on a cold start; a runner image that ships an older Firefox fails every 160-only feature.
 */
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";

const MAC_APP = "/Applications/Firefox.app/Contents/MacOS/firefox";

export function firefoxMajor(bin: string): number | null {
  try {
    const out = execFileSync(bin, ["--version"], { timeout: 10_000, encoding: "utf8" });
    const m = /(\d+)\.\d+/.exec(out);
    return m ? Number(m[1]) : null;
  } catch {
    return null;
  }
}

const bin = process.env.FIREFOX_BIN || (existsSync(MAC_APP) ? MAC_APP : "");
const major = bin ? firefoxMajor(bin) : null;
/** True when a Firefox 160+ binary is available for live tests. Unknown version: trust an explicit FIREFOX_BIN. */
export const HAVE_FIREFOX_160 = Boolean(bin) && (major === null ? Boolean(process.env.FIREFOX_BIN) : major >= 160);
