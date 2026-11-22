/**
 * Close-on-exit and the per-process agent-tab cap (src/ownedTabs.ts).
 *
 * The MCP server remembers which tabs IT opened. On exit (SIGTERM, SIGINT, SIGHUP, stdin EOF,
 * the parent going away) it closes those, and only those, unless a tab was opened for the human
 * (new_page focus:true, or raised later with select_page focus:true). While it runs, it refuses a
 * new background tab past CDP_MAX_AGENT_TABS.
 *
 * As in reap.test.ts, the negative tests matter most: each names a tab someone still wants open.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AgentTabCapError,
  closeOwnedTabs,
  closeOnExitEnabled,
  DEFAULT_MAX_AGENT_TABS,
  exitClosable,
  maxAgentTabs,
  moveOwnedTab,
  ownedTabIds,
  resetOwnedTabs,
  watchParent,
  type OwnedTab,
} from "../src/ownedTabs.ts";
import { leaseFile, markLongLivedProcess, readLease, type LeaseRecord, type LeaseSummary } from "../src/leases.ts";
import { recordOrigin, type OriginSummary } from "../src/origins.ts";
import { closePage, newPage, selectPage } from "../src/shared-tools.ts";
import { claimPage, releasePage } from "../src/leases-tools.ts";
import { page, stubDriver } from "./helpers/stub-driver.ts";

let dir = "";
const saved = {
  artifact: process.env.CDP_ARTIFACT_DIR,
  state: process.env.CDP_STATE_DIR,
  max: process.env.CDP_MAX_AGENT_TABS,
  exit: process.env.CDP_CLOSE_ON_EXIT,
};
function restore(key: string, value: string | undefined) {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "cdp-owned-"));
  process.env.CDP_ARTIFACT_DIR = dir;
  process.env.CDP_STATE_DIR = join(dir, "state");
});

afterAll(async () => {
  restore("CDP_ARTIFACT_DIR", saved.artifact);
  restore("CDP_STATE_DIR", saved.state);
  markLongLivedProcess(false);
  await rm(dir, { recursive: true, force: true });
});

beforeEach(async () => {
  for (const f of await readdir(dir)) await rm(join(dir, f), { recursive: true, force: true });
  resetOwnedTabs();
  markLongLivedProcess(true);
  delete process.env.CDP_MAX_AGENT_TABS;
  delete process.env.CDP_CLOSE_ON_EXIT;
});

afterEach(() => {
  restore("CDP_MAX_AGENT_TABS", saved.max);
  restore("CDP_CLOSE_ON_EXIT", saved.exit);
  markLongLivedProcess(false);
  resetOwnedTabs();
});

/* ------------------------------ pure selector ------------------------------ */

describe("exitClosable", () => {
  const ME = 5000;
  const owned = (id: string, keepOnExit = false): OwnedTab => ({ targetId: id, backend: "chrome", keepOnExit, createdAt: 1 });
  const origin = (id: string, over: Partial<OriginSummary> = {}): [string, OriginSummary] =>
    [id, { backend: "chrome", targetId: id, label: "agent-x", pid: ME, createdAt: 1, ...over }];
  const lease = (id: string, over: Partial<LeaseSummary> = {}): LeaseSummary => ({
    backend: "chrome", targetId: id, label: "agent-x", pid: ME, createdAt: 1,
    lastUsedAt: 1, ttlMs: 900_000, pidAlive: true, stale: false, ...over,
  });
  const run = (tabs: OwnedTab[], origins: [string, OriginSummary][], leases: LeaseSummary[], live: string[]) =>
    exitClosable({ owned: tabs, livePageIds: live, origins: new Map(origins), leases, pid: ME });

  test("closes a live agent tab this process opened and nobody leased", () => {
    expect(run([owned("A")], [origin("A")], [], ["A"]).map((t) => t.targetId)).toEqual(["A"]);
  });

  test("closes a tab under this process's own lease", () => {
    expect(run([owned("A")], [origin("A")], [lease("A")], ["A"]).map((t) => t.targetId)).toEqual(["A"]);
  });

  test("keeps a tab opened for the human (keepOnExit)", () => {
    expect(run([owned("H", true)], [origin("H")], [], ["H"])).toEqual([]);
  });

  test("never closes a tab with no origin record (origin 'unknown')", () => {
    expect(run([owned("U")], [], [], ["U"])).toEqual([]);
  });

  test("never closes a tab whose origin record will not read", () => {
    expect(run([owned("U")], [origin("U", { unreadable: "EACCES" })], [], ["U"])).toEqual([]);
  });

  test("never closes a tab another process now holds a lease on", () => {
    expect(run([owned("O")], [origin("O")], [lease("O", { pid: ME + 1 })], ["O"])).toEqual([]);
  });

  test("never closes a tab whose lease will not read", () => {
    expect(run([owned("O")], [origin("O")], [lease("O", { unreadable: "unparseable" })], ["O"])).toEqual([]);
  });

  test("skips a tab that is already gone", () => {
    expect(run([owned("G")], [origin("G")], [], [])).toEqual([]);
  });

  test("a lease for the same id on another backend does not count", () => {
    expect(run([owned("A")], [origin("A")], [lease("A", { backend: "firefox", pid: ME + 1 })], ["A"]).map((t) => t.targetId)).toEqual(["A"]);
  });
});

/* ------------------------------ env knobs ------------------------------ */

describe("env", () => {
  test("CDP_MAX_AGENT_TABS defaults to 20, takes a positive integer, 0 turns the cap off, junk is ignored", () => {
    expect(DEFAULT_MAX_AGENT_TABS).toBe(20);
    expect(maxAgentTabs()).toBe(20);
    process.env.CDP_MAX_AGENT_TABS = "5";
    expect(maxAgentTabs()).toBe(5);
    process.env.CDP_MAX_AGENT_TABS = "0";
    expect(maxAgentTabs()).toBe(Infinity);
    process.env.CDP_MAX_AGENT_TABS = "-3";
    expect(maxAgentTabs()).toBe(20);
    process.env.CDP_MAX_AGENT_TABS = "lots";
    expect(maxAgentTabs()).toBe(20);
  });

  test("close-on-exit is on in the MCP server, off under the CLI, and CDP_CLOSE_ON_EXIT=0 turns it off", () => {
    expect(closeOnExitEnabled()).toBe(true);
    process.env.CDP_CLOSE_ON_EXIT = "0";
    expect(closeOnExitEnabled()).toBe(false);
    process.env.CDP_CLOSE_ON_EXIT = "off";
    expect(closeOnExitEnabled()).toBe(false);
    delete process.env.CDP_CLOSE_ON_EXIT;
    markLongLivedProcess(false);
    expect(closeOnExitEnabled()).toBe(false);
  });
});

/* ------------------------------ registry wiring ------------------------------ */

describe("ownership is recorded where tabs are created and forgotten where they are given up", () => {
  test("new_page records the tab; focus:true records it as kept on exit", async () => {
    const { driver } = stubDriver();
    const a = await newPage(driver, { url: "https://example.test/a" });
    const h = await newPage(driver, { url: "https://teams.example/", focus: true });
    expect(ownedTabIds("chrome")).toEqual([a.targetId, h.targetId]);
    expect(ownedTabIds("chrome", { closableOnly: true })).toEqual([a.targetId]);
  });

  test("claim_page opening a fresh tab records it too", async () => {
    const { driver } = stubDriver();
    const c = await claimPage(driver, { url: "https://example.test/c", label: "x" });
    expect(ownedTabIds("chrome", { closableOnly: true })).toEqual([c.targetId]);
  });

  test("claim_page taking over an existing tab records nothing", async () => {
    const { driver } = stubDriver({ pages: [page("EXIST")] });
    await claimPage(driver, { targetId: "EXIST", label: "x" });
    expect(ownedTabIds("chrome")).toEqual([]);
  });

  test("close_page forgets the tab", async () => {
    const { driver } = stubDriver();
    const a = await newPage(driver, {});
    await closePage(driver, { target: a.targetId });
    expect(ownedTabIds("chrome")).toEqual([]);
  });

  test("release_page forgets the tab even when it leaves it open (close:false)", async () => {
    const { driver, pages } = stubDriver();
    const a = await newPage(driver, { claim: true });
    await releasePage(driver, { lease: a.lease!, close: false });
    expect(pages.map((p) => p.id)).toContain(a.targetId);
    expect(ownedTabIds("chrome")).toEqual([]);
  });

  test("select_page focus:true marks the tab as shown to the human, so it survives exit", async () => {
    const { driver } = stubDriver();
    const a = await newPage(driver, {});
    await selectPage(driver, { target: a.targetId, focus: true });
    expect(ownedTabIds("chrome", { closableOnly: true })).toEqual([]);
  });

  test("a hidden tab revealed as a new visible tab hands ownership over, kept on exit", async () => {
    const { driver } = stubDriver();
    const a = await newPage(driver, {});
    moveOwnedTab("chrome", a.targetId, "VISIBLE-1");
    expect(ownedTabIds("chrome")).toEqual(["VISIBLE-1"]);
    expect(ownedTabIds("chrome", { closableOnly: true })).toEqual([]);
  });

  test("under the CLI nothing is recorded (the tab must outlive the one-shot process)", async () => {
    markLongLivedProcess(false);
    const { driver } = stubDriver();
    await newPage(driver, {});
    expect(ownedTabIds("chrome")).toEqual([]);
  });
});

/* ------------------------------ closeOwnedTabs ------------------------------ */

describe("closeOwnedTabs (the shutdown path)", () => {
  test("closes this process's agent tabs, releases their leases, and leaves everything else open", async () => {
    // HUMAN: a tab nobody recorded (origin 'unknown'). PEER: another process's agent tab.
    const { driver, closed, pages } = stubDriver({ pages: [page("HUMAN"), page("PEER")] });
    await recordOrigin("chrome", "PEER", { label: "peer-lane" });
    const a = await newPage(driver, {});
    const b = await newPage(driver, { claim: true });
    const h = await newPage(driver, { focus: true });
    const res = await closeOwnedTabs(driver);
    expect(closed.sort()).toEqual([a.targetId, b.targetId].sort());
    expect(res.closed.sort()).toEqual([a.targetId, b.targetId].sort());
    expect(res.kept).toEqual([h.targetId]);
    expect(pages.map((p) => p.id).sort()).toEqual(["HUMAN", "PEER", h.targetId].sort());
    expect(await readLease("chrome", b.targetId)).toBeUndefined();
  });

  test("a tab this process opened but another process now holds is left open", async () => {
    const { driver, closed } = stubDriver();
    const a = await newPage(driver, {});
    const rec: LeaseRecord = {
      backend: "chrome", targetId: a.targetId, nonce: "e".repeat(24), pid: process.ppid,
      label: "other", createdAt: Date.now(), lastUsedAt: Date.now(), ttlMs: 900_000, auto: false,
    };
    await writeFile(leaseFile("chrome", a.targetId), JSON.stringify(rec));
    const res = await closeOwnedTabs(driver);
    expect(closed).toEqual([]);
    expect(res.skipped).toEqual([{ targetId: a.targetId, reason: "held-by-other" }]);
  });

  test("CDP_CLOSE_ON_EXIT=0 closes nothing", async () => {
    const { driver, closed } = stubDriver();
    await newPage(driver, {});
    process.env.CDP_CLOSE_ON_EXIT = "0";
    const res = await closeOwnedTabs(driver);
    expect(closed).toEqual([]);
    expect(res.closed).toEqual([]);
  });

  test("a wedged close cannot hang shutdown past the budget", async () => {
    const { driver } = stubDriver();
    await newPage(driver, {});
    (driver as { closePage: (id: string) => Promise<{ success: boolean }> }).closePage = () => new Promise(() => undefined);
    const t0 = Date.now();
    const res = await closeOwnedTabs(driver, { timeoutMs: 100 });
    expect(Date.now() - t0).toBeLessThan(2_000);
    expect(res.closed).toEqual([]);
  });

  test("a second call is a no-op (shutdown is idempotent)", async () => {
    const { driver, closed } = stubDriver();
    await newPage(driver, {});
    await closeOwnedTabs(driver);
    await closeOwnedTabs(driver);
    expect(closed.length).toBe(1);
  });
});

/* ------------------------------ the cap ------------------------------ */

describe("CDP_MAX_AGENT_TABS", () => {
  test("past the cap new_page refuses, names the open tabs, and opens nothing", async () => {
    process.env.CDP_MAX_AGENT_TABS = "2";
    const { driver, newPageOpts } = stubDriver();
    const a = await newPage(driver, {});
    const b = await newPage(driver, {});
    const err = await newPage(driver, {}).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AgentTabCapError);
    expect((err as Error).message).toContain("CDP_MAX_AGENT_TABS=2");
    expect((err as Error).message).toContain(a.targetId);
    expect((err as Error).message).toContain(b.targetId);
    expect(newPageOpts.length).toBe(2);
  });

  test("claim_page opening a tab is refused at the cap too", async () => {
    process.env.CDP_MAX_AGENT_TABS = "1";
    const { driver } = stubDriver();
    await newPage(driver, {});
    await expect(claimPage(driver, { url: "https://example.test/", label: "x" })).rejects.toBeInstanceOf(AgentTabCapError);
  });

  test("a tab for the human (focus:true) is not counted and is not refused", async () => {
    process.env.CDP_MAX_AGENT_TABS = "1";
    const { driver } = stubDriver();
    await newPage(driver, {});
    await newPage(driver, { focus: true });
    await expect(newPage(driver, {})).rejects.toBeInstanceOf(AgentTabCapError);
  });

  test("closing a tab frees a slot", async () => {
    process.env.CDP_MAX_AGENT_TABS = "1";
    const { driver } = stubDriver();
    const a = await newPage(driver, {});
    await closePage(driver, { target: a.targetId });
    await newPage(driver, {});
  });

  test("a tab closed behind our back (by the human or the browser) frees its slot", async () => {
    process.env.CDP_MAX_AGENT_TABS = "1";
    const { driver, pages } = stubDriver();
    await newPage(driver, {});
    pages.splice(0, pages.length);
    await newPage(driver, {});
  });

  test("concurrent new_page calls cannot overshoot the cap", async () => {
    process.env.CDP_MAX_AGENT_TABS = "2";
    const { driver } = stubDriver();
    const results = await Promise.allSettled([newPage(driver, {}), newPage(driver, {}), newPage(driver, {})]);
    expect(results.filter((r) => r.status === "fulfilled").length).toBe(2);
  });

  test("the CLI has no cap (it records nothing)", async () => {
    markLongLivedProcess(false);
    process.env.CDP_MAX_AGENT_TABS = "1";
    const { driver } = stubDriver();
    await newPage(driver, {});
    await newPage(driver, {});
  });
});

/* ------------------------------ parent watch ------------------------------ */

describe("watchParent", () => {
  test("fires once when the parent pid changes (reparented after the parent died)", async () => {
    let ppid = 4242;
    let fired = 0;
    const stop = watchParent(() => fired++, { intervalMs: 5, getPpid: () => ppid });
    await new Promise((r) => setTimeout(r, 20));
    expect(fired).toBe(0);
    ppid = 1;
    await new Promise((r) => setTimeout(r, 30));
    expect(fired).toBe(1);
    stop();
  });

  test("does nothing while the parent stays", async () => {
    let fired = 0;
    const stop = watchParent(() => fired++, { intervalMs: 5, getPpid: () => 4242 });
    await new Promise((r) => setTimeout(r, 30));
    stop();
    expect(fired).toBe(0);
  });
});

