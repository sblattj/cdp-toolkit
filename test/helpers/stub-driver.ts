/**
 * Shared in-memory BrowserDriver stub used by the lease, release, and reap
 * test files. Extracted here so those files share one definition instead of
 * each keeping its own divergent copy, which would let their behavior drift
 * out of sync with real CdpDriver semantics (e.g. a failed close silently
 * removing the page in one copy but not another) without any test catching it.
 */
import type { BrowserDriver, PageInfo } from "../../src/driver.ts";

/**
 * How the stub answers the two OPTIONAL activity-beacon members of
 * BrowserDriver (src/activity.ts).
 *
 * PRESENCE OF THIS OPTION IS ITSELF THE FIXTURE. The members are optional on
 * the real interface, and callers branch on whether they exist (beaconSupported)
 * to decide between an absent field and a null one. So a stub built WITHOUT
 * `beacon` must not have them at all — that is the Firefox-shaped case — and one
 * built with it declares support even when it has no timestamps to report,
 * which is the "beacon installed, nobody has touched the tab" case.
 */
export interface StubBeacon {
  /** targetId -> the timestamp readActivityBeacon reports. Absent id => null. */
  reads?: Record<string, number | null>;
  /** Make readActivityBeacon reject, to prove a read failure degrades to a
   *  missing field rather than failing the whole call. */
  readThrows?: boolean;
  /** Make installActivityBeacon reject, likewise. */
  installThrows?: boolean;
}

/**
 * Minimal BrowserDriver stand-in: only the five members the three tools under
 * test touch, plus the two optional beacon members when `beacon` is given.
 * `hidden` models targets that appear ONLY in the `all:true` listing (a worker,
 * an iframe), which is the one resolvePage branch whose hit is not a member of
 * the page list.
 */
export function stubDriver(
  opts: { scheme?: string; pages?: PageInfo[]; hidden?: PageInfo[]; failClose?: boolean; beacon?: StubBeacon } = {},
) {
  const pages: PageInfo[] = [...(opts.pages ?? [])];
  const hidden: PageInfo[] = [...(opts.hidden ?? [])];
  const closed: string[] = [];
  const activated: string[] = [];
  /** Every target installActivityBeacon was called for, in call order. */
  const beaconInstalls: string[] = [];
  /** Every target readActivityBeacon was called for, in call order. */
  const beaconReads: string[] = [];
  let created = 0;
  const beaconMembers = opts.beacon
    ? {
        async installActivityBeacon(id: string): Promise<boolean> {
          beaconInstalls.push(id);
          if (opts.beacon?.installThrows) throw new Error("stub: install failed");
          return true;
        },
        async readActivityBeacon(id: string): Promise<number | null> {
          beaconReads.push(id);
          if (opts.beacon?.readThrows) throw new Error("stub: read failed");
          return opts.beacon?.reads?.[id] ?? null;
        },
      }
    : {};
  const driver = {
    ...beaconMembers,
    scheme: opts.scheme ?? "cdp",
    async listPages(o?: { all?: boolean }): Promise<PageInfo[]> {
      return o?.all ? [...pages, ...hidden] : [...pages];
    },
    async newPage(url?: string): Promise<PageInfo> {
      const p: PageInfo = { id: `NEW-${++created}`, url: url ?? "about:blank", title: "", type: "page" };
      pages.push(p);
      return p;
    },
    async closePage(id: string): Promise<{ success: boolean }> {
      closed.push(id);
      // Mirrors CdpDriver.closePage: success reflects the real
      // Target.closeTarget result and is never hardcoded, so a stub that
      // models a refused/already-gone close must not remove the page either.
      if (opts.failClose) return { success: false };
      const i = pages.findIndex((p) => p.id === id);
      if (i >= 0) pages.splice(i, 1);
      return { success: true };
    },
    async activatePage(id: string): Promise<PageInfo> {
      activated.push(id);
      return [...pages, ...hidden].find((p) => p.id === id) ?? { id, url: "", title: "" };
    },
  };
  return { driver: driver as unknown as BrowserDriver, closed, activated, pages, beaconInstalls, beaconReads };
}

export const page = (id: string, url = `https://example.test/${id}`): PageInfo => ({ id, url, title: id, type: "page" });
