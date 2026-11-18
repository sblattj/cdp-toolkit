/**
 * Keep the user's frontmost app in front when a background tab opens (macOS).
 *
 * Measured on a Chromium-based browser: Target.createTarget {background:true} leaves the user's
 * active tab alone but still brings the browser APP in front of whatever app the user is in.
 * CDP has no flag for that, so on macOS the driver notes the frontmost process before the call
 * and, if it changed afterwards, puts it back (System Events, by pid). Off-mac this is a no-op.
 * CDP_RESTORE_FRONT_APP=0 turns it off. Read per call so tests can flip it.
 */
import { execFile } from "node:child_process";

export interface FrontAppOps {
  front(): Promise<number | null>;
  setFront(pid: number): Promise<void>;
}

function run(cmd: string, args: string[]): Promise<string> {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: 2_000 }, (err, stdout) => resolve(err ? "" : String(stdout)));
  });
}

export const macFrontAppOps: FrontAppOps = {
  async front() {
    // lsappinfo needs no Automation consent and answers in a few ms.
    const asn = (await run("lsappinfo", ["front"])).trim();
    if (!asn) return null;
    const m = /"?pid"?\s*=\s*(\d+)/.exec(await run("lsappinfo", ["info", "-only", "pid", asn]));
    return m ? Number(m[1]) : null;
  },
  async setFront(pid) {
    await run("osascript", ["-e", `tell application "System Events" to set frontmost of (first process whose unix id is ${pid}) to true`]);
  },
};

export function restoreFrontAppEnabled(platform: string = process.platform): boolean {
  return platform === "darwin" && (process.env.CDP_RESTORE_FRONT_APP ?? "").trim() !== "0";
}

/**
 * Run `fn` (which may raise the browser app) and put the prior frontmost app back if it lost
 * the front. Checks again after `recheckMs`, since the raise can land just after the CDP reply.
 */
export async function keepFrontApp<T>(
  fn: () => Promise<T>,
  opts: { ops?: FrontAppOps; enabled?: boolean; recheckMs?: number } = {},
): Promise<T> {
  const enabled = opts.enabled ?? restoreFrontAppEnabled();
  if (!enabled) return fn();
  const ops = opts.ops ?? macFrontAppOps;
  const before = await ops.front().catch(() => null);
  const result = await fn();
  if (before === null) return result;
  const fix = async (): Promise<void> => {
    const now = await ops.front().catch(() => null);
    if (now !== null && now !== before) await ops.setFront(before).catch(() => undefined);
  };
  await fix();
  await new Promise((r) => setTimeout(r, opts.recheckMs ?? 250));
  await fix();
  return result;
}
