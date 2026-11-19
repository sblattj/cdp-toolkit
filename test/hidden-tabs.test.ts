// Hidden tabs (CDP_HIDDEN_TABS=1, MCP server only): new_page opens a {background:true, hidden:true}
// target on one held owner connection, so the browser app never comes to the front.
// Unit half: HiddenTabOwner against a fake connection. Driver half: the real CdpBrowserDriver
// against FakeCdpServer, with the gate off, env-only (CLI), and on.
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSettledTarget, CdpBrowserDriver } from "../src/cdp/driver.ts";
import {
  DEFAULT_HIDDEN_TABS_MAX,
  disposeHiddenTabs,
  HiddenTabCapError,
  HiddenTabOwner,
  hiddenTabsMax,
  markHiddenTargets,
  type OwnerConnection,
} from "../src/cdp/hiddenTabs.ts";
import { chromeLeaseBackend, markLongLivedProcess, readLease, withLeaseScope } from "../src/leases.ts";
import { withEndpointScope, type Endpoint } from "../src/endpoints.ts";
import { readOrigin } from "../src/origins.ts";
import { listPages, newPage, selectPage, closePage } from "../src/shared-tools.ts";
import { claimPage } from "../src/leases-tools.ts";
import type { Target } from "../src/types.ts";
import { FakeCdpServer } from "./helpers/fake-cdp-server.ts";

/* --------------------------------- fake owner connection --------------------------------- */

type Handler = (params: Record<string, unknown>, sessionId?: string) => void;
interface Sent { method: string; params: Record<string, unknown>; sessionId?: string }

function fakeOwnerConn(opts: { dpr?: unknown; failOverride?: boolean } = {}) {
  const handlers = new Map<string, Set<Handler>>();
  const sent: Sent[] = [];
  let open = true;
  let next = 0;
  const conn = {
    sent,
    closed: 0,
    get isOpen() { return open; },
    drop() { open = false; },
    emit(method: string, params: Record<string, unknown>) { handlers.get(method)?.forEach((h) => h(params)); },
    on(method: string, h: Handler) {
      if (!handlers.has(method)) handlers.set(method, new Set());
      handlers.get(method)!.add(h);
      return () => handlers.get(method)!.delete(h);
    },
    close() { open = false; conn.closed++; },
    async send<T>(method: string, params: Record<string, unknown> = {}, o: { sessionId?: string } = {}): Promise<T> {
      if (!open) throw new Error("connection not open");
      sent.push({ method, params, ...(o.sessionId ? { sessionId: o.sessionId } : {}) });
      if (method === "Target.createTarget") return { targetId: `H${++next}` } as T;
      if (method === "Target.attachToTarget") return { sessionId: `S-${params.targetId}` } as T;
      if (method === "Runtime.evaluate") return { result: { value: opts.dpr ?? 2 } } as T;
      if (method === "Emulation.setDeviceMetricsOverride" && opts.failOverride) throw new Error("override refused");
      if (method === "Target.closeTarget") return { success: true } as T;
      return {} as T;
    },
  };
  return conn;
}

/** An owner whose connections are fakeOwnerConn instances; `conns` records every one opened. */
function ownerWith(opts: { dpr?: unknown; failOverride?: boolean; max?: number; connectDelayMs?: number } = {}) {
  const conns: ReturnType<typeof fakeOwnerConn>[] = [];
  const createdParams: Record<string, unknown>[] = [];
  const owner = new HiddenTabOwner({
    async connect() {
      if (opts.connectDelayMs) await new Promise((r) => setTimeout(r, opts.connectDelayMs));
      const c = fakeOwnerConn(opts);
      conns.push(c);
      return c as unknown as OwnerConnection;
    },
    async createSettled(conn, url, o) {
      const { targetId } = await conn.send<{ targetId: string }>("Target.createTarget", { url, background: true, hidden: o.hidden });
      createdParams.push({ url, ...o });
      return targetId;
    },
    ...(opts.max !== undefined ? { max: () => opts.max! } : {}),
  });
  return { owner, conns, createdParams };
}

describe("createSettledTarget params", () => {
  function settleConn() {
    const params: Record<string, unknown>[] = [];
    const handlers = new Set<(p: Record<string, unknown>) => void>();
    return {
      params,
      on(_m: string, h: (p: Record<string, unknown>) => void) { handlers.add(h); return () => handlers.delete(h); },
      async send<T>(method: string, p: Record<string, unknown> = {}): Promise<T> {
        if (method !== "Target.createTarget") return {} as T;
        params.push(p);
        handlers.forEach((h) => h({ targetInfo: { targetId: "T1" } }));
        return { targetId: "T1" } as T;
      },
    };
  }

  test("gate off: exactly {url, background:true}, no hidden key", async () => {
    const c = settleConn();
    await createSettledTarget(c as never, "https://example.com/", 100);
    expect(c.params).toEqual([{ url: "https://example.com/", background: true }]);
  });

  test("hidden:true sends {url, background:true, hidden:true}", async () => {
    const c = settleConn();
    await createSettledTarget(c as never, "https://example.com/", 100, { hidden: true });
    expect(c.params).toEqual([{ url: "https://example.com/", background: true, hidden: true }]);
  });
});

describe("HiddenTabOwner", () => {
  test("creates a hidden tab, attaches the owner and sends the override on the owner's session", async () => {
    const { owner, conns, createdParams } = ownerWith({ dpr: 3 });
    const id = await owner.create("https://example.test/a");
    expect(id).toBe("H1");
    expect(createdParams).toEqual([{ url: "https://example.test/a", hidden: true }]);
    const sent = conns[0]!.sent;
    expect(sent.map((s) => s.method)).toEqual(["Target.createTarget", "Target.attachToTarget", "Runtime.evaluate", "Emulation.setDeviceMetricsOverride"]);
    expect(sent[1]!.params).toEqual({ targetId: "H1", flatten: true });
    expect(sent[3]).toEqual({
      method: "Emulation.setDeviceMetricsOverride",
      params: { width: 1280, height: 800, deviceScaleFactor: 3, mobile: false },
      sessionId: "S-H1",
    });
    expect(owner.has("H1")).toBe(true);
    // The owner session is KEPT: nothing detached it and the connection is still open.
    expect(sent.some((s) => s.method === "Target.detachFromTarget")).toBe(false);
    expect(conns[0]!.isOpen).toBe(true);
  });

  test("a tab that reports no usable devicePixelRatio gets 2", async () => {
    const { owner, conns } = ownerWith({ dpr: "nope" });
    await owner.create("about:blank");
    expect(conns[0]!.sent.find((s) => s.method === "Emulation.setDeviceMetricsOverride")!.params.deviceScaleFactor).toBe(2);
  });

  test("one owner connection is reused across calls, and concurrent first calls share one connect", async () => {
    const { owner, conns } = ownerWith({ connectDelayMs: 20 });
    const [a, b] = await Promise.all([owner.create("about:blank"), owner.create("about:blank")]);
    await owner.create("about:blank");
    expect(conns.length).toBe(1);
    expect(new Set([a, b]).size).toBe(2);
    expect(owner.ids()).toEqual(["H1", "H2", "H3"]);
  });

  test("owner drop forgets every hidden tab, and the next create reconnects lazily", async () => {
    const { owner, conns } = ownerWith();
    await owner.create("about:blank");
    await owner.create("about:blank");
    conns[0]!.drop();
    expect(owner.has("H1")).toBe(false);
    expect(owner.ids()).toEqual([]);
    expect(await owner.close("H1")).toEqual({ success: false });
    const id = await owner.create("about:blank");
    expect(conns.length).toBe(2);
    expect(owner.ids()).toEqual([id]);
  });

  test("Target.targetDestroyed on the owner drops that id", async () => {
    const { owner, conns } = ownerWith();
    await owner.create("about:blank");
    await owner.create("about:blank");
    conns[0]!.emit("Target.targetDestroyed", { targetId: "H1" });
    expect(owner.ids()).toEqual(["H2"]);
  });

  test("a failed override closes the new target and does not register it", async () => {
    const { owner, conns } = ownerWith({ failOverride: true });
    await expect(owner.create("about:blank")).rejects.toThrow("override refused");
    expect(conns[0]!.sent.at(-1)).toEqual({ method: "Target.closeTarget", params: { targetId: "H1" } });
    expect(owner.ids()).toEqual([]);
  });

  test("the cap refuses (never evicts), names the open ids, and frees a slot on close", async () => {
    const { owner } = ownerWith({ max: 2 });
    await owner.create("about:blank");
    await owner.create("about:blank");
    const err = await owner.create("about:blank").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HiddenTabCapError);
    expect((err as HiddenTabCapError).code).toBe("page-error");
    expect((err as Error).message).toContain("H1, H2");
    expect((err as Error).message).toContain("CDP_HIDDEN_TABS_MAX=2");
    expect(owner.ids()).toEqual(["H1", "H2"]);
    expect(await owner.close("H1")).toEqual({ success: true });
    expect(await owner.create("about:blank")).toBe("H3");
  });

  test("the cap counts creates in flight, so concurrent calls cannot overshoot it", async () => {
    const { owner } = ownerWith({ max: 2, connectDelayMs: 20 });
    const results = await Promise.allSettled([owner.create("a"), owner.create("b"), owner.create("c")]);
    expect(results.filter((r) => r.status === "fulfilled").length).toBe(2);
    expect(results.filter((r) => r.status === "rejected").length).toBe(1);
  });

  test("dispose closes every hidden tab and then the owner", async () => {
    const { owner, conns } = ownerWith();
    await owner.create("about:blank");
    await owner.create("about:blank");
    await owner.dispose();
    const closes = conns[0]!.sent.filter((s) => s.method === "Target.closeTarget").map((s) => s.params.targetId);
    expect(closes.sort()).toEqual(["H1", "H2"]);
    expect(conns[0]!.closed).toBe(1);
    expect(owner.ids()).toEqual([]);
  });

  test("CDP_HIDDEN_TABS_MAX: default 20, a positive integer overrides, junk is ignored", () => {
    const saved = process.env.CDP_HIDDEN_TABS_MAX;
    try {
      delete process.env.CDP_HIDDEN_TABS_MAX;
      expect(hiddenTabsMax()).toBe(DEFAULT_HIDDEN_TABS_MAX);
      expect(DEFAULT_HIDDEN_TABS_MAX).toBe(20);
      process.env.CDP_HIDDEN_TABS_MAX = "5";
      expect(hiddenTabsMax()).toBe(5);
      process.env.CDP_HIDDEN_TABS_MAX = "0";
      expect(hiddenTabsMax()).toBe(20);
      process.env.CDP_HIDDEN_TABS_MAX = "lots";
      expect(hiddenTabsMax()).toBe(20);
    } finally {
      if (saved === undefined) delete process.env.CDP_HIDDEN_TABS_MAX;
      else process.env.CDP_HIDDEN_TABS_MAX = saved;
    }
  });
});

describe("markHiddenTargets", () => {
  const t = (id: string, type = "page"): Target => ({ id, type, title: id, url: `https://x.test/${id}`, webSocketDebuggerUrl: "" });

  test("returns the same array when this process has no hidden tabs on the endpoint", () => {
    const list = [t("A"), t("B", "other")];
    expect(markHiddenTargets("http://127.0.0.1:1", list)).toBe(list);
  });
});

/* ------------------------------- driver against a fake CDP ------------------------------- */

describe("CdpBrowserDriver hidden tabs (FakeCdpServer)", () => {
  const fake = new FakeCdpServer();
  let ep: Endpoint;
  let dir = "";
  const saved = { hidden: process.env.CDP_HIDDEN_TABS, max: process.env.CDP_HIDDEN_TABS_MAX, artifact: process.env.CDP_ARTIFACT_DIR, state: process.env.CDP_STATE_DIR, strict: process.env.CDP_REQUIRE_LEASE };
  const driver = new CdpBrowserDriver();
  const inEp = <T>(fn: () => Promise<T>) => withEndpointScope(ep, fn);
  const browserMsgs = (method: string) => fake.messagesFor("browser").filter((m) => m.method === method);

  beforeAll(async () => {
    await fake.start();
    ep = { name: "hiddentest", base: fake.base, readOnly: false };
    dir = await mkdtemp(join(tmpdir(), "cdp-hidden-tabs-"));
    process.env.CDP_ARTIFACT_DIR = join(dir, "artifacts");
    process.env.CDP_STATE_DIR = join(dir, "state");
    delete process.env.CDP_REQUIRE_LEASE;
  });

  function arm(): void {
    fake.emitTargetInfoChanged = true;
    // A real hidden target lists as type "other"; mirror that so the relabel is exercised.
    fake.handlers["Target.createTarget"] = (p: { url?: string; hidden?: boolean }) => {
      const id = `${p.hidden ? "HID" : "VIS"}${fake.targets.length + 1}`;
      fake.targets.push({ id, type: p.hidden ? "other" : "page", title: "", url: p.url ?? "about:blank" });
      return { targetId: id };
    };
    fake.handlers["Target.attachToTarget"] = (p: { targetId: string }) => ({ sessionId: `S-${p.targetId}` });
  }

  afterEach(async () => {
    await disposeHiddenTabs();
    markLongLivedProcess(false);
    fake.reset();
    for (const [k, v] of [["CDP_HIDDEN_TABS", saved.hidden], ["CDP_HIDDEN_TABS_MAX", saved.max]] as const) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    await rm(join(dir, "artifacts"), { recursive: true, force: true });
  });

  afterAll(async () => {
    await fake.stop();
    for (const [k, v] of [["CDP_ARTIFACT_DIR", saved.artifact], ["CDP_STATE_DIR", saved.state], ["CDP_REQUIRE_LEASE", saved.strict]] as const) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    await rm(dir, { recursive: true, force: true });
  });

  test("gate off: new_page sends the unchanged visible createTarget and no owner traffic", async () => {
    arm();
    delete process.env.CDP_HIDDEN_TABS;
    markLongLivedProcess(true);
    const res = await inEp(() => newPage(driver, { url: "https://a.test/" }));
    expect(res).toEqual({ targetId: "VIS2", url: "https://a.test/" });
    expect(browserMsgs("Target.createTarget").map((m) => m.params)).toEqual([{ url: "https://a.test/", background: true }]);
    expect(browserMsgs("Target.attachToTarget")).toEqual([]);
    expect(browserMsgs("Emulation.setDeviceMetricsOverride")).toEqual([]);
  });

  test("env set but not the MCP server (the CLI): still the visible path", async () => {
    arm();
    process.env.CDP_HIDDEN_TABS = "1";
    markLongLivedProcess(false);
    await inEp(() => newPage(driver, { url: "https://a.test/" }));
    expect(browserMsgs("Target.createTarget").map((m) => m.params)).toEqual([{ url: "https://a.test/", background: true }]);
  });

  test("gate on: hidden createTarget, override on the owner session, hidden:true in the result", async () => {
    arm();
    process.env.CDP_HIDDEN_TABS = "1";
    markLongLivedProcess(true);
    const res = await inEp(() => newPage(driver, { url: "https://h.test/" }));
    expect(res).toEqual({ targetId: "HID2", url: "https://h.test/", hidden: true });
    expect(browserMsgs("Target.createTarget").map((m) => m.params)).toEqual([{ url: "https://h.test/", background: true, hidden: true }]);
    expect(browserMsgs("Target.attachToTarget").map((m) => m.params)).toEqual([{ targetId: "HID2", flatten: true }]);
    const override = browserMsgs("Emulation.setDeviceMetricsOverride");
    expect(override.length).toBe(1);
    expect(override[0]!.sessionId).toBe("S-HID2");
    expect(override[0]!.params).toEqual({ width: 1280, height: 800, deviceScaleFactor: 2, mobile: false });
  });

  test("focus:true under the gate keeps the visible foreground path", async () => {
    arm();
    process.env.CDP_HIDDEN_TABS = "1";
    markLongLivedProcess(true);
    await inEp(() => newPage(driver, { url: "https://f.test/", focus: true }));
    expect(browserMsgs("Target.createTarget").map((m) => m.params)).toEqual([{ url: "https://f.test/", background: false }]);
  });

  test("claim_page opening a fresh tab under the gate reports hidden:true", async () => {
    arm();
    process.env.CDP_HIDDEN_TABS = "1";
    markLongLivedProcess(true);
    const res = await inEp(() => claimPage(driver, { url: "https://c.test/", label: "claimer" }));
    expect(res.opened).toBe(true);
    expect(res.hidden).toBe(true);
  });

  test("list_pages marks hidden tabs as pages with hidden:true, after the visible ones", async () => {
    arm();
    process.env.CDP_HIDDEN_TABS = "1";
    markLongLivedProcess(true);
    const { targetId } = await inEp(() => newPage(driver, { url: "https://h.test/" }));
    const pages = await inEp(() => driver.listPages());
    expect(pages.map((p) => [p.id, p.type, p.hidden])).toEqual([["PAGE1", "page", undefined], [targetId, "page", true]]);
    // The tool surface carries the flag through its annotation spread.
    const listed = await inEp(() => listPages(driver, {}));
    expect(listed.pages.find((p) => p.id === targetId)?.hidden).toBe(true);
    expect(listed.pages.find((p) => p.id === "PAGE1")).not.toHaveProperty("hidden");
    // A selector arm that filters on type "page" now reaches it.
    const page = await inEp(() => driver.page(`url:h.test`));
    expect(page.info.id).toBe(targetId);
    await page.release();
  });

  test("close_page on a hidden id closes it over the owner and forgets it", async () => {
    arm();
    process.env.CDP_HIDDEN_TABS = "1";
    markLongLivedProcess(true);
    const { targetId } = await inEp(() => newPage(driver, { url: "https://h.test/" }));
    const res = await inEp(() => closePage(driver, { target: targetId }));
    expect(res).toEqual({ closed: targetId, success: true });
    expect(browserMsgs("Target.closeTarget").map((m) => m.params)).toEqual([{ targetId }]);
    expect((await inEp(() => driver.listPages())).map((p) => p.id)).toEqual(["PAGE1"]);
  });

  test("select_page focus:true on a hidden tab reveals it in a visible tab and moves its label", async () => {
    arm();
    process.env.CDP_HIDDEN_TABS = "1";
    markLongLivedProcess(true);
    const { targetId } = await inEp(() => newPage(driver, { url: "https://h.test/page", label: "revealer" }));
    const res = await inEp(() => selectPage(driver, { target: targetId, focus: true }));
    expect(res.revealedFrom).toBe(targetId);
    expect(res.focused).toBe(true);
    expect(res.selected).not.toBe(targetId);
    const creates = browserMsgs("Target.createTarget").map((m) => m.params);
    expect(creates.at(-1)).toEqual({ url: "https://h.test/page", background: false });
    expect(browserMsgs("Target.closeTarget").map((m) => m.params)).toEqual([{ targetId }]);
    expect(browserMsgs("Target.activateTarget")).toEqual([]);
    const pages = await inEp(() => driver.listPages());
    expect(pages.find((p) => p.id === res.selected)?.hidden).toBeUndefined();
    expect(pages.some((p) => p.id === targetId)).toBe(false);
    const backend = await inEp(async () => chromeLeaseBackend());
    expect((await readOrigin(backend, res.selected))?.label).toBe("revealer");
  });

  test("select_page focus:true on a hidden tab moves its lease and returns the new token", async () => {
    arm();
    process.env.CDP_HIDDEN_TABS = "1";
    markLongLivedProcess(true);
    const created = await inEp(() => newPage(driver, { url: "https://h.test/l", claim: true, label: "leaser" }));
    expect(created.lease).toBeString();
    const res = await inEp(() => withLeaseScope(created.lease, () => selectPage(driver, { target: created.targetId, focus: true })));
    expect(res.lease).toBeString();
    expect(res.lease).not.toBe(created.lease);
    const backend = await inEp(async () => chromeLeaseBackend());
    expect(await readLease(backend, created.targetId)).toBeUndefined();
    expect((await readLease(backend, res.selected))?.label).toBe("leaser");
  });

  test("activatePage on a visible tab is unchanged: Target.activateTarget, same id, no revealedFrom", async () => {
    arm();
    process.env.CDP_HIDDEN_TABS = "1";
    markLongLivedProcess(true);
    const info = await inEp(() => driver.activatePage("PAGE1"));
    expect(info).toEqual({ id: "PAGE1", url: "https://fake.test/", title: "Fake page" });
    expect(browserMsgs("Target.activateTarget").map((m) => m.params)).toEqual([{ targetId: "PAGE1" }]);
  });

  test("owner loss: hidden ids become no-such-target, and the next new_page reconnects", async () => {
    arm();
    process.env.CDP_HIDDEN_TABS = "1";
    markLongLivedProcess(true);
    const { targetId } = await inEp(() => newPage(driver, { url: "https://h.test/" }));
    // A browser restart: every socket drops and the hidden target is gone with its owner.
    const port = Number(new URL(fake.base).port);
    await fake.stop();
    fake.targets = fake.targets.filter((t) => t.id !== targetId);
    await fake.start(port);
    await new Promise((r) => setTimeout(r, 50));
    const t0 = Date.now();
    const err = await inEp(() => driver.page(targetId)).catch((e: unknown) => e);
    expect((err as { code?: string }).code).toBe("no-such-target");
    const errSelect = await inEp(() => driver.activatePage(targetId)).catch((e: unknown) => e);
    expect((errSelect as { code?: string }).code).toBe("no-such-target");
    expect(Date.now() - t0).toBeLessThan(2000);
    expect((await inEp(() => driver.listPages())).some((p) => p.hidden)).toBe(false);
    const again = await inEp(() => newPage(driver, { url: "https://h.test/2" }));
    expect(again.hidden).toBe(true);
    expect((await inEp(() => driver.listPages())).filter((p) => p.hidden).map((p) => p.id)).toEqual([again.targetId]);
  });

  test("the cap refuses new_page with a clear error and opens nothing", async () => {
    arm();
    process.env.CDP_HIDDEN_TABS = "1";
    process.env.CDP_HIDDEN_TABS_MAX = "1";
    markLongLivedProcess(true);
    const first = await inEp(() => newPage(driver, { url: "https://h.test/1" }));
    const before = fake.targets.length;
    const err = await inEp(() => newPage(driver, { url: "https://h.test/2" })).catch((e: unknown) => e);
    expect((err as Error).message).toContain("hidden-tab cap reached");
    expect((err as Error).message).toContain(first.targetId);
    expect(fake.targets.length).toBe(before);
  });

  test("dispose closes every hidden tab", async () => {
    arm();
    process.env.CDP_HIDDEN_TABS = "1";
    markLongLivedProcess(true);
    const a = await inEp(() => newPage(driver, { url: "https://h.test/1" }));
    const b = await inEp(() => newPage(driver, { url: "https://h.test/2" }));
    await driver.dispose();
    expect(browserMsgs("Target.closeTarget").map((m) => (m.params as { targetId: string }).targetId).sort()).toEqual([a.targetId, b.targetId].sort());
    expect(fake.targets.map((t) => t.id)).toEqual(["PAGE1"]);
  });
});
