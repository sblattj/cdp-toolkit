/**
 * Shared in-memory BrowserDriver stub used by the lease, release, and reap
 * test files. Extracted here so those files share one definition instead of
 * each keeping its own divergent copy, which would let their behavior drift
 * out of sync with real CdpDriver semantics (e.g. a failed close silently
 * removing the page in one copy but not another) without any test catching it.
 */
import type { BrowserDriver, PageInfo } from "../../src/driver.ts";

/**
 * Minimal BrowserDriver stand-in: only the five members the three tools under
 * test touch. `hidden` models targets that appear ONLY in the `all:true`
 * listing (a worker, an iframe), which is the one resolvePage branch whose hit
 * is not a member of the page list.
 */
export function stubDriver(opts: { scheme?: string; pages?: PageInfo[]; hidden?: PageInfo[]; failClose?: boolean } = {}) {
  const pages: PageInfo[] = [...(opts.pages ?? [])];
  const hidden: PageInfo[] = [...(opts.hidden ?? [])];
  const closed: string[] = [];
  const activated: string[] = [];
  let created = 0;
  const driver = {
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
  return { driver: driver as unknown as BrowserDriver, closed, activated, pages };
}

export const page = (id: string, url = `https://example.test/${id}`): PageInfo => ({ id, url, title: id, type: "page" });
