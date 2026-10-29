// new_page must not hand back a tab before the browser has adopted it: Vivaldi
// wedges a tab that is attached to in its first milliseconds. createSettledTarget
// waits for the tab's first Target.targetInfoChanged, capped.
import { expect, test } from "bun:test";
import { createSettledTarget } from "../src/cdp/driver.ts";

type Handler = (params: Record<string, unknown>) => void;

function fakeConn(opts: { id?: string; eventBeforeResponse?: boolean; eventAfterMs?: number; otherIdFirst?: boolean }) {
  const handlers = new Map<string, Set<Handler>>();
  const sent: string[] = [];
  const emit = (id: string) => handlers.get("Target.targetInfoChanged")?.forEach((h) => h({ targetInfo: { targetId: id } }));
  const id = opts.id ?? "T1";
  return {
    sent,
    listenerCount: () => handlers.get("Target.targetInfoChanged")?.size ?? 0,
    on(method: string, h: Handler) {
      if (!handlers.has(method)) handlers.set(method, new Set());
      handlers.get(method)!.add(h);
      return () => handlers.get(method)!.delete(h);
    },
    async send<T>(method: string): Promise<T> {
      sent.push(method);
      if (method !== "Target.createTarget") return {} as T;
      if (opts.otherIdFirst) emit("OTHER");
      if (opts.eventBeforeResponse) emit(id);
      if (opts.eventAfterMs !== undefined) setTimeout(() => emit(id), opts.eventAfterMs);
      return { targetId: id } as T;
    },
  };
}

test("waits for the new tab's targetInfoChanged before returning", async () => {
  const conn = fakeConn({ eventAfterMs: 80 });
  const t0 = Date.now();
  expect(await createSettledTarget(conn as never, "https://example.com/", 2000)).toBe("T1");
  const waited = Date.now() - t0;
  expect(waited).toBeGreaterThanOrEqual(70);
  expect(waited).toBeLessThan(1000);
  expect(conn.sent).toEqual(["Target.setDiscoverTargets", "Target.createTarget"]);
  expect(conn.listenerCount()).toBe(0);
});

test("an event that beats the createTarget response is not missed", async () => {
  const conn = fakeConn({ eventBeforeResponse: true });
  const t0 = Date.now();
  expect(await createSettledTarget(conn as never, "about:blank", 2000)).toBe("T1");
  expect(Date.now() - t0).toBeLessThan(200);
});

test("another tab's event does not count; the cap bounds a browser that never sends one", async () => {
  const conn = fakeConn({ otherIdFirst: true });
  const t0 = Date.now();
  expect(await createSettledTarget(conn as never, "about:blank", 150)).toBe("T1");
  expect(Date.now() - t0).toBeGreaterThanOrEqual(140);
  expect(conn.listenerCount()).toBe(0);
});

test("a createTarget with no targetId still throws and unsubscribes", async () => {
  const conn = fakeConn({});
  conn.send = (async (m: string) => { conn.sent.push(m); return {}; }) as never;
  await expect(createSettledTarget(conn as never, "about:blank", 100)).rejects.toThrow("no targetId");
  expect(conn.listenerCount()).toBe(0);
});
