/**
 * Browser half of `cdp install`: binary detection, debug-launch alias generation, and an
 * idempotent shell-rc append. The other half (harness/MCP config) lives in a sibling module and
 * is not this file's concern — this file only knows about browsers and shell rc files.
 *
 * Zero runtime dependencies beyond node:fs, node:fs/promises, node:os, node:path.
 */
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { delimiter, dirname, join } from "node:path";

export type BrowserChoice = "arc" | "chrome" | "firefox";

export interface BrowserInfo {
  choice: BrowserChoice;
  /**
   * The binary path or command name to launch. When a PATH-relative name (e.g. "google-chrome")
   * is the chosen candidate, this is returned UNRESOLVED — as the bare name, not an absolute path
   * scanned off today's PATH — so the alias stays portable and lets the shell re-resolve it against
   * PATH at invocation time rather than pinning it to wherever it happened to be found right now.
   */
  binary: string;
  found: boolean;
}

export interface AliasOptions {
  choice: BrowserChoice;
  port: number;
  aliasName?: string;
  profileDir?: string;
}

export interface RcAppendResult {
  rcPath: string;
  action: "created-block" | "replaced-block" | "unchanged";
}

/* ------------------------------- binary detection ------------------------------- */

/**
 * Per-choice candidate lists, built fresh on every call so env var overrides (CHROME_BIN /
 * ARC_BIN / FIREFOX_BIN) are read live rather than captured once at module load — important for
 * tests that set/restore these env vars around a single call.
 *
 * macOS-first, Linux fallback. Order mirrors the spec: env override, then the macOS .app bundle
 * path, then PATH-relative command names. Arc is macOS-mostly, so found=false on Linux (nothing
 * in this list resolves there) is expected, not a bug.
 */
const CANDIDATE_BUILDERS: Record<BrowserChoice, () => Array<string | undefined>> = {
  chrome: () => [
    process.env.CHROME_BIN,
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "google-chrome",
    "google-chrome-stable",
    "chromium",
  ],
  arc: () => [process.env.ARC_BIN, "/Applications/Arc.app/Contents/MacOS/Arc", "arc"],
  firefox: () => [
    process.env.FIREFOX_BIN,
    "/Applications/Firefox.app/Contents/MacOS/firefox",
    "firefox",
    "/usr/bin/firefox",
  ],
};

/** Scan $PATH for `cmd`. Used only to decide `found` for a bare candidate — never to rewrite it. */
function existsOnPath(cmd: string): boolean {
  const pathEnv = process.env.PATH;
  if (!pathEnv) return false;
  for (const dir of pathEnv.split(delimiter)) {
    if (!dir) continue;
    if (existsSync(join(dir, cmd))) return true;
  }
  return false;
}

/**
 * Mirrors the resolveBinary logic in src/bidi/launch.ts: an ABSOLUTE candidate counts only if it
 * exists on disk (otherwise a hardcoded macOS path would shadow a real PATH fallback on Linux and
 * yield a not-found result at spawn time); a bare PATH name is returned as-is, unresolved, for the
 * shell to resolve — but IS checked against $PATH here purely to set an accurate `found` flag.
 */
function resolveCandidate(candidates: Array<string | undefined>): { binary: string; found: boolean } {
  let lastDefined = "";
  for (const c of candidates) {
    if (!c) continue;
    lastDefined = c;
    if (c.startsWith("/")) {
      if (existsSync(c)) return { binary: c, found: true };
      continue;
    }
    if (existsOnPath(c)) return { binary: c, found: true };
  }
  return { binary: lastDefined, found: false };
}

export function detectBrowser(choice: BrowserChoice): BrowserInfo {
  const { binary, found } = resolveCandidate(CANDIDATE_BUILDERS[choice]());
  return { choice, binary, found };
}

/* ------------------------------- alias generation ------------------------------- */

function defaultProfileDir(choice: BrowserChoice): string {
  // Literal $HOME (not resolved via os.homedir()) so it survives into the alias's stored text and
  // expands fresh every time the alias runs — see the two-phase alias substitution note below.
  return `$HOME/.cdp-toolkit/${choice}-profile`;
}

export function defaultAliasName(choice: BrowserChoice): string {
  return `cdp-${choice}`;
}

/**
 * The launch flags only (no binary). Chrome and Arc are both Chromium-based and Arc accepts
 * Chrome's flags, so they share a shape: --remote-debugging-port plus a DEDICATED
 * --user-data-dir. The dedicated profile is required, not cosmetic — Chrome silently ignores
 * --remote-debugging-port when it hands off to an already-running instance on the default
 * profile, so the port never opens and there is no error, just a hung attach later.
 *
 * Firefox's --marionette flag is likewise required, not optional: cdp-toolkit's Firefox
 * orphan-recovery path (src/bidi/launch.ts's header comment) uses the Marionette side channel to
 * recover a dropped BiDi connection, and that recovery cannot fire without it.
 */
export function browserLaunchArgs(o: AliasOptions): string[] {
  const profileDir = o.profileDir ?? defaultProfileDir(o.choice);
  if (o.choice === "firefox") {
    return ["--remote-debugging-port", String(o.port), "--marionette", "--no-remote", "--profile", profileDir];
  }
  return [`--remote-debugging-port=${o.port}`, `--user-data-dir=${profileDir}`];
}

/** Quote only if needed: wrapping a plain token in quotes is harmless but unquoted-with-a-space breaks word splitting. */
function shellQuoteIfSpaced(token: string): string {
  return /\s/.test(token) ? `"${token}"` : token;
}

/**
 * A single `alias name='<binary> <flags>'` line. The whole value is wrapped in single quotes (so
 * it is stored literally, unexpanded, when the alias is DEFINED); the binary is additionally
 * double-quoted when it contains a space (the macOS "Google Chrome.app" / future spaced paths),
 * because shell alias substitution is a two-phase process — text substitution first, then a fresh
 * parse of the substituted text — so the inner double quotes and the bare $HOME in the profile
 * dir both take effect correctly at every INVOCATION of the alias, not at definition time.
 */
export function aliasLine(o: AliasOptions): string {
  const name = o.aliasName ?? defaultAliasName(o.choice);
  const { binary } = detectBrowser(o.choice);
  const parts = [shellQuoteIfSpaced(binary), ...browserLaunchArgs(o)];
  return `alias ${name}='${parts.join(" ")}'`;
}

/* ------------------------------- shell rc detection ------------------------------- */

export function detectShellRc(): string {
  const shell = process.env.SHELL ?? "";
  if (shell.endsWith("zsh")) return join(homedir(), ".zshrc");
  if (shell.endsWith("bash")) return join(homedir(), ".bashrc");
  return join(homedir(), process.platform === "darwin" ? ".zshrc" : ".bashrc");
}

/* ------------------------------- idempotent rc append ------------------------------- */

const MARKER_START = "# >>> cdp-toolkit alias >>>";
const MARKER_END = "# <<< cdp-toolkit alias <<<";

function ensureTrailingNewline(s: string): string {
  return s.endsWith("\n") ? s : `${s}\n`;
}

/**
 * Idempotently write ONE marker block into rcPath, replacing its body in place on re-runs rather
 * than accumulating duplicates. The wizard owns composing aliasBlockBody (e.g. joining several
 * browsers' alias lines with "\n") — this function only manages the single marker block, so
 * calling it again with a fuller body updates the same block rather than adding a second one.
 */
export async function appendAliasToRc(rcPath: string, aliasBlockBody: string): Promise<RcAppendResult> {
  let existing = "";
  try {
    existing = await readFile(rcPath, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }

  const block = `${MARKER_START}\n${aliasBlockBody}\n${MARKER_END}`;

  const startIdx = existing.indexOf(MARKER_START);
  const endIdx = existing.indexOf(MARKER_END);

  if (startIdx !== -1 && endIdx !== -1 && endIdx > startIdx) {
    const endOfEndLine = existing.indexOf("\n", endIdx);
    const before = existing.slice(0, startIdx);
    const after = endOfEndLine === -1 ? "" : existing.slice(endOfEndLine + 1);
    const existingBlock = existing.slice(startIdx, endOfEndLine === -1 ? existing.length : endOfEndLine);

    if (existingBlock === block) {
      return { rcPath, action: "unchanged" };
    }

    const next = ensureTrailingNewline(`${before}${block}\n${after}`);
    await writeFile(rcPath, next, "utf8");
    return { rcPath, action: "replaced-block" };
  }

  await mkdir(dirname(rcPath), { recursive: true });
  const sep = existing.length === 0 || existing.endsWith("\n") ? "" : "\n";
  const next = `${existing}${sep}${block}\n`;
  await writeFile(rcPath, next, "utf8");
  return { rcPath, action: "created-block" };
}
