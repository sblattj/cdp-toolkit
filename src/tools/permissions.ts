/**
 * permissions.ts: `grant_permissions` — answer the browser's permission prompts up front, so a page
 * that asks for geolocation / notifications / clipboard gets a decision instead of a modal an
 * agent cannot click (1.8.0 Track P3).
 *
 * WHY THIS IS CHROME-ONLY (capability "browser.permissions"), NOT a PageDriver method
 * ==================================================================================
 * Browser.grantPermissions and Browser.resetPermissions are browser-endpoint commands keyed by
 * ORIGIN, not by tab: a grant made "for" one tab applies to every tab on that origin, including
 * ones opened later. There is no page-scoped concept to put on the Driver interface, so this stays
 * a raw-CDP module like dispatch-mouse.ts. WebDriver BiDi's permission handling lives in an
 * optional module this driver does not negotiate, so under Firefox the tool is absent from
 * tools/list per ADR-001 rather than present and throwing.
 *
 * THE STANDING-CONNECTION REQUIREMENT (measured, not assumed)
 * ----------------------------------------------------------
 * A grant is bound to the CDP client that issued it and is REVERTED when that client disconnects.
 * Measured on isolated headless Chrome 151: grant geolocation for an origin, close the granting
 * connection, then query `navigator.permissions.query({name:"geolocation"}).state` over a fresh
 * connection — the answer is "prompt", not "granted". Identical result granting from the page
 * endpoint instead of the browser endpoint. A per-call implementation of this tool would therefore
 * report `{granted:["geolocation"]}` and leave the browser in exactly the state it started in,
 * which is the worst possible outcome: a caller acting on a grant that does not exist.
 *
 * So every command here goes through browser-session.ts's standing connection, and the grant lasts
 * as long as that connection does — the life of the MCP server process. Under the stateless CLI
 * (one process per command) the grant dies with the process, which makes this an MCP-server
 * capability like network_mock.ts's fake backends. That limit is stated in the manifest description
 * rather than papered over.
 *
 * Lease gate: `target` is resolved through client.ts's resolveTarget (which calls assertLeaseOk)
 * before anything is granted — both to keep the gate on the path and because the resolved tab's URL
 * is what `origin` defaults to.
 */
import { resolveTarget } from "../client.ts";
import type { TargetSelector } from "../types.ts";
import { browserSend } from "./browser-session.ts";

export interface GrantPermissionsArgs {
  target?: TargetSelector;
  /** CDP PermissionType values, e.g. "geolocation", "notifications", "clipboardReadWrite". */
  permissions?: string[];
  /** Origin the grant applies to, e.g. "https://example.com". Defaults to the target tab's origin. */
  origin?: string;
  /** Reset every permission this session granted before granting (or, with no `permissions`, instead). */
  reset?: boolean;
}

export interface GrantPermissionsResult {
  granted?: string[];
  origin?: string;
  reset?: true;
  target: { id: string; url: string; title: string };
}

/**
 * The origin a permission grant should default to for a tab at `url`, or undefined when the tab has
 * no grantable origin.
 *
 * `data:`, `blob:`, `about:blank` and friends all serialize to the opaque origin "null", which
 * Browser.grantPermissions cannot key on. Returning undefined (rather than the string "null") is
 * what lets the caller be told to pass `origin` explicitly, instead of getting a protocol error
 * about a value they never supplied. Pure, and exported for the unit tests.
 */
export function originOf(url: string): string | undefined {
  try {
    const o = new URL(url).origin;
    return o && o !== "null" ? o : undefined;
  } catch {
    return undefined;
  }
}

/** Validation split out so every refusal is pinned by a unit test without a browser. */
export function validateGrantPermissionsArgs(args: GrantPermissionsArgs): void {
  const reset = args.reset === true;
  if (args.reset !== undefined && typeof args.reset !== "boolean") {
    throw new Error(`grant_permissions: 'reset' must be a boolean (got ${JSON.stringify(args.reset)})`);
  }
  if (args.permissions === undefined) {
    // reset-only is the one legal way to call this with nothing to grant.
    if (!reset) throw new Error("grant_permissions: 'permissions' is required (or pass reset:true to clear previous grants)");
    return;
  }
  if (!Array.isArray(args.permissions)) {
    throw new Error(`grant_permissions: 'permissions' must be an array of CDP PermissionType strings (got ${JSON.stringify(args.permissions)})`);
  }
  // An empty array is refused rather than treated as "grant nothing": it is a caller who built the
  // list dynamically and got zero entries, and answering {granted:[]} would report success for a
  // call that changed nothing.
  if (args.permissions.length === 0 && !reset) {
    throw new Error("grant_permissions: 'permissions' must not be empty (pass reset:true if the intent is to clear grants)");
  }
  for (const p of args.permissions) {
    if (typeof p !== "string" || p.length === 0) {
      throw new Error(`grant_permissions: every entry of 'permissions' must be a non-empty string (got ${JSON.stringify(p)})`);
    }
  }
}

/**
 * Grant browser permissions for an origin, and/or reset previously granted ones.
 *
 * `reset:true` with `permissions` resets FIRST and then grants, so the result is exactly the listed
 * permissions rather than the listed ones unioned with whatever was granted earlier. Note that
 * Browser.resetPermissions takes no origin — CDP resets this client's grants for every origin at
 * once — so a reset is not scoped to `origin` even though a grant is.
 */
export async function grantPermissions(args: GrantPermissionsArgs = {}): Promise<GrantPermissionsResult> {
  validateGrantPermissionsArgs(args);
  const t = await resolveTarget(args.target);
  const target = { id: t.id, url: t.url, title: t.title };
  const reset = args.reset === true;
  const permissions = args.permissions ?? [];

  if (reset) await browserSend("Browser.resetPermissions", {});
  if (permissions.length === 0) return { reset: true, target };

  const origin = args.origin ?? originOf(t.url);
  if (!origin) {
    throw new Error(
      `grant_permissions: cannot derive an origin from the target tab's url (${JSON.stringify(t.url)}); pass 'origin' explicitly, e.g. origin:"https://example.com"`,
    );
  }
  // Chrome rejects an unknown PermissionType by name ("Unknown permission type: ..."), so a typo
  // surfaces as a clear protocol error rather than a silently-ignored entry. No local allowlist is
  // kept here: it would go stale against Chrome's own enum and start refusing valid permissions.
  await browserSend("Browser.grantPermissions", { origin, permissions });
  return { granted: [...permissions], origin, ...(reset ? { reset: true as const } : {}), target };
}
