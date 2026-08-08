# Lease-required mode and close-on-release — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make an agent unable to drive a tab without holding its lease, close the tab when the lease is released, and stop dead agents from leaking open tabs.

**Architecture:** One env switch (`CDP_REQUIRE_LEASE`, MCP-only) gates three additions — auto-acquire inside the existing `assertLeaseOk` choke point, `new_page` auto-claim, and reap-on-list. A new `auto` field on `LeaseRecord` splits leases into two tiers: gate-acquired leases pass for any call from the owning pid, explicitly-claimed leases still require their token. `release_page` gains a `target` mode and closes tabs the origin ledger says the toolkit opened.

**Tech Stack:** TypeScript (strict, `noUncheckedIndexedAccess`, `verbatimModuleSyntax`), Bun test runner, zero runtime dependencies, Node globals only.

**Design spec:** `docs/design/2026-08-08-lease-required-and-close-on-release.md`. Read it before starting. Every "why" question this plan does not answer is answered there.

## Global Constraints

- **Zero runtime dependencies.** Node's global `WebSocket`/`fetch` only. Only `typescript` + `@types/node` as devDeps (CONTRACT.md rule 1).
- **`bun run typecheck` must pass** with `strict`, `noUncheckedIndexedAccess`, `verbatimModuleSyntax`. Import types with `import type`. Use `.ts` extensions in imports.
- **Never add a fourth target-resolution path** and never add a lease check to an individual tool (CONTRACT.md rule 6). All enforcement stays inside `assertLeaseOk`.
- **With `CDP_REQUIRE_LEASE` unset, behavior must be byte-identical to 1.4.0.** The existing `test/leases.test.ts` suite must pass **unmodified** — you may add tests to that file, but you may not change or delete an existing one. If an existing test fails, your change is wrong; do not edit the test.
- **Comment density matches the surrounding code.** `leases.ts` and `origins.ts` explain *why* at length, including what each choice costs. Match that. A comment that only restates the code is noise here; a comment that names the failure mode a choice prevents is the house style.
- **Commit message trailer.** Every commit ends with the block below. Substitute your own session UUID and model name; do not copy an example UUID.

  ```
  🤖 Authored with Claude Code

  Claude-Session-Id: <your session uuid>

  — <your model name> via Claude Code
  ```

  Build it with a **quoted heredoc** into a file and `git commit -F <file>`, never inside a double-quoted `-m` string. Stage by explicit pathspec; never `git add -A`.
- **Branch:** `feat/lease-required-and-close-on-release`. Do **not** push and do **not** merge to `main`.

---

### Task 1: The switch and the `auto` tier

**Files:**
- Modify: `src/leases.ts` (add `markLongLivedProcess`/`requireLease`; extend `LeaseRecord` and `ClaimOptions`; write `auto` in `claimLease`)
- Modify: `src/mcp.ts` (call `markLongLivedProcess()` at startup)
- Test: `test/leases.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `markLongLivedProcess(value?: boolean): void`, `requireLease(): boolean`, `LeaseRecord.auto?: boolean`, `ClaimOptions.auto?: boolean`.

- [ ] **Step 1: Write the failing tests**

Append to `test/leases.test.ts`. Note the `markLongLivedProcess(false)` reset in `afterEach` — without it, one strict test leaks into every later test in the file.

```ts
describe("requireLease (the strict-mode switch)", () => {
  const originalRequire = process.env.CDP_REQUIRE_LEASE;
  afterEach(() => {
    if (originalRequire === undefined) delete process.env.CDP_REQUIRE_LEASE;
    else process.env.CDP_REQUIRE_LEASE = originalRequire;
    markLongLivedProcess(false);
  });

  test("is false in a CLI process no matter what the env says", () => {
    process.env.CDP_REQUIRE_LEASE = "1";
    // markLongLivedProcess deliberately NOT called: this is cli.ts's state.
    expect(requireLease()).toBe(false);
  });

  test("accepts 1, true, yes, on, case-insensitively, in a long-lived process", () => {
    markLongLivedProcess();
    for (const raw of ["1", "true", "TRUE", " True ", "yes", "on"]) {
      process.env.CDP_REQUIRE_LEASE = raw;
      expect(requireLease()).toBe(true);
    }
  });

  test("rejects unset, 0, false, and garbage", () => {
    markLongLivedProcess();
    delete process.env.CDP_REQUIRE_LEASE;
    expect(requireLease()).toBe(false);
    for (const raw of ["0", "false", "no", "off", "", "maybe"]) {
      process.env.CDP_REQUIRE_LEASE = raw;
      expect(requireLease()).toBe(false);
    }
  });
});

describe("LeaseRecord.auto", () => {
  test("claimLease defaults to an explicit (auto:false) lease", async () => {
    await claimLease("chrome", "TIER-A", { label: "a" });
    expect((await readLease("chrome", "TIER-A"))?.auto).toBe(false);
  });

  test("claimLease records auto:true when asked", async () => {
    await claimLease("chrome", "TIER-B", { label: "b", auto: true });
    expect((await readLease("chrome", "TIER-B"))?.auto).toBe(true);
  });

  test("a 1.4.0 record with no auto key reads as explicit, not auto", async () => {
    // Exactly what <=1.4.0 wrote: no auto key at all. It must NOT be treated as
    // an auto lease, or upgrading would silently downgrade a held lease's
    // protection from token-required to pid-only.
    const rec: LeaseRecord = {
      backend: "chrome", targetId: "TIER-C", nonce: "a".repeat(24),
      pid: process.pid, label: "legacy", createdAt: 1, lastUsedAt: 1, ttlMs: 900_000,
    };
    await writeFile(leaseFile("chrome", "TIER-C"), JSON.stringify(rec));
    expect((await readLease("chrome", "TIER-C"))?.auto ?? false).toBe(false);
  });
});
```

Add `afterEach` to the `bun:test` import, and `markLongLivedProcess`, `requireLease` to the `../src/leases.ts` import.

- [ ] **Step 2: Run to verify it fails**

Run: `bun test test/leases.test.ts`
Expected: FAIL — `markLongLivedProcess is not a function` / `requireLease is not a function`.

- [ ] **Step 3: Implement**

In `src/leases.ts`, after `leaseTtlMs()`:

```ts
/**
 * Whether THIS process is the long-lived MCP server rather than a one-shot CLI
 * invocation. Module state, which this file's header otherwise forbids: that
 * prohibition is about state describing OTHER processes' ownership, which must
 * live on disk because two MCP servers drive one browser. This describes this
 * process's own role, which no other process can observe or contend for, so a
 * module flag is the correct scope rather than a violation of the rule.
 */
let longLived = false;

/** Called once by mcp.ts at startup. cli.ts never calls it. The parameter
 *  exists so a test can put the module back into CLI state. */
export function markLongLivedProcess(value = true): void {
  longLived = value;
}

/**
 * Strict mode: every tool call acquires a lease for the tab it resolves, and
 * stale agent tabs are reaped on read. Off by default, so 1.4.0 consumers are
 * unaffected.
 *
 * ALWAYS FALSE UNDER THE CLI, regardless of the env var, and that is not a
 * convenience. cli.ts already refuses claim_page because a CLI invocation is
 * one process per call, so its lease is reclaimable by the dead-pid rule the
 * moment the process exits, and "a lease that is reclaimable on arrival is
 * worse than no lease". Auto-acquire would mint exactly such a lease on every
 * call. The sharper danger is reap: those dead-pid records would read as
 * orphaned agent tabs, so a CLI user running list_pages twice could watch the
 * second run close the tabs the first run leased. Read per call, like
 * leaseDir(), so a test can flip it.
 */
export function requireLease(): boolean {
  if (!longLived) return false;
  const raw = (process.env.CDP_REQUIRE_LEASE ?? "").trim().toLowerCase();
  return raw === "1" || raw === "true" || raw === "yes" || raw === "on";
}
```

Extend `LeaseRecord` (after `ttlMs`):

```ts
  /**
   * How this lease was taken, and therefore who may use it without a token.
   *   true  - the gate acquired it implicitly; passes for any call from `pid`.
   *   false - claim_page or new_page{claim:true}; the token is required, even
   *           from the owning process.
   * Absent on records written by <=1.4.0 and read as false, so an upgrade never
   * downgrades a held lease from token-required to pid-only.
   */
  auto?: boolean;
```

Extend `ClaimOptions`:

```ts
  /** Marks the lease gate-acquired. See LeaseRecord.auto. Defaults to false:
   *  an unmarked claim is an explicit one, which is the stricter reading. */
  auto?: boolean;
```

In `claimLease`, add to the `record` literal, after `ttlMs`:

```ts
      auto: opts.auto === true,
```

In `src/mcp.ts`, import `markLongLivedProcess` from `./leases.ts` and call it once at startup, next to the existing manifest-drift check:

```ts
// This process is the long-lived MCP server, which is what makes strict mode
// (CDP_REQUIRE_LEASE) safe to honor here and unsafe in cli.ts. See requireLease.
markLongLivedProcess();
```

- [ ] **Step 4: Run to verify it passes**

Run: `bun test test/leases.test.ts && bun run typecheck`
Expected: PASS, including every pre-existing test in the file.

- [ ] **Step 5: Commit**

```bash
git add src/leases.ts src/mcp.ts test/leases.test.ts
git commit -F <message file>
```

Subject: `feat(leases): CDP_REQUIRE_LEASE switch and the auto lease tier`

---

### Task 2: Auto-acquire inside `assertLeaseOk`

**Files:**
- Modify: `src/leases.ts` (`assertLeaseOk` only)
- Test: `test/leases.test.ts`

**Interfaces:**
- Consumes: `requireLease()`, `markLongLivedProcess()`, `ClaimOptions.auto` (Task 1).
- Produces: no signature change. `assertLeaseOk` stays `Promise<void>`.

This is the core of the feature. Read spec §3 first, especially the table of three cases that must **not** auto-acquire.

- [ ] **Step 1: Write the failing tests**

```ts
describe("assertLeaseOk auto-acquire (strict mode)", () => {
  const originalRequire = process.env.CDP_REQUIRE_LEASE;
  beforeEach(() => {
    markLongLivedProcess();
    process.env.CDP_REQUIRE_LEASE = "1";
  });
  afterEach(() => {
    if (originalRequire === undefined) delete process.env.CDP_REQUIRE_LEASE;
    else process.env.CDP_REQUIRE_LEASE = originalRequire;
    markLongLivedProcess(false);
  });

  test("an unleased tab with no token is ACQUIRED, not waved through", async () => {
    await assertLeaseOk("chrome", "AUTO-1");
    const rec = await readLease("chrome", "AUTO-1");
    expect(rec?.auto).toBe(true);
    expect(rec?.pid).toBe(process.pid);
    expect(rec?.label).toBe(`pid-${process.pid}`);
  });

  test("our own auto lease passes without a token and refreshes lastUsedAt", async () => {
    await claimLease("chrome", "AUTO-2", { label: "x", auto: true, now: 1000 });
    await assertLeaseOk("chrome", "AUTO-2", { now: 5000 });
    expect((await readLease("chrome", "AUTO-2"))?.lastUsedAt).toBe(5000);
  });

  test("our own EXPLICIT lease still demands its token, even same-process", async () => {
    // The whole point of the two tiers: a subagent that claimed explicitly is
    // protected from its siblings, which share this pid.
    await claimLease("chrome", "AUTO-3", { label: "sibling" });
    await expect(assertLeaseOk("chrome", "AUTO-3")).rejects.toThrow(LeaseConflictError);
  });

  test("another live pid's auto lease is refused", async () => {
    // pid 1 is alive on every platform this runs on, so isPidAlive is true and
    // the record is not stale for the dead-pid reason.
    const rec: LeaseRecord = {
      backend: "chrome", targetId: "AUTO-4", nonce: "b".repeat(24),
      pid: 1, label: "other-agent", createdAt: Date.now(), lastUsedAt: Date.now(),
      ttlMs: 900_000, auto: true,
    };
    await writeFile(leaseFile("chrome", "AUTO-4"), JSON.stringify(rec));
    await expect(assertLeaseOk("chrome", "AUTO-4")).rejects.toThrow(LeaseConflictError);
  });

  test("a token for TAB-A causes an unrelated unleased TAB-C to be acquired", async () => {
    const { token } = await claimLease("chrome", "AUTO-5-A", { label: "holder" });
    await assertLeaseOk("chrome", "AUTO-5-C", { lease: token });
    expect((await readLease("chrome", "AUTO-5-C"))?.auto).toBe(true);
  });

  test("a token naming THIS tab, when the tab is unleased, still throws and mints nothing", async () => {
    // The caller asserted it holds a specific lease and is wrong. Minting one
    // here would turn a real error into a silent success.
    const { token } = await claimLease("chrome", "AUTO-6", { label: "gone" });
    await releaseLease(token);
    await expect(assertLeaseOk("chrome", "AUTO-6", { lease: token })).rejects.toThrow(LeaseConflictError);
    expect(await readLease("chrome", "AUTO-6")).toBeUndefined();
  });

  test("a malformed token throws and mints nothing", async () => {
    await expect(assertLeaseOk("chrome", "AUTO-7", { lease: "not-a-token" })).rejects.toThrow(LeaseConflictError);
    expect(await readLease("chrome", "AUTO-7")).toBeUndefined();
  });

  test("an auto lease from a DEAD pid is reclaimed, not inherited", async () => {
    const rec: LeaseRecord = {
      backend: "chrome", targetId: "AUTO-8", nonce: "c".repeat(24),
      pid: 999_999, label: "dead-agent", createdAt: 1, lastUsedAt: 1,
      ttlMs: 900_000, auto: true,
    };
    await writeFile(leaseFile("chrome", "AUTO-8"), JSON.stringify(rec));
    await assertLeaseOk("chrome", "AUTO-8");
    const after = await readLease("chrome", "AUTO-8");
    expect(after?.pid).toBe(process.pid);
    expect(after?.nonce).not.toBe("c".repeat(24));
  });
});

describe("assertLeaseOk with strict mode OFF (1.4.0 regression guard)", () => {
  test("an unleased tab with no token is left completely untouched", async () => {
    // markLongLivedProcess is not called, so requireLease() is false.
    await assertLeaseOk("chrome", "OFF-1");
    expect(await readLease("chrome", "OFF-1")).toBeUndefined();
  });

  test("our own auto lease still passes with the flag off", async () => {
    // Line 2 of the gate is deliberately NOT flag-gated: turning strict off
    // must not lock this process out of leases it is still holding.
    markLongLivedProcess();
    process.env.CDP_REQUIRE_LEASE = "1";
    await assertLeaseOk("chrome", "OFF-2");
    markLongLivedProcess(false);
    delete process.env.CDP_REQUIRE_LEASE;
    await assertLeaseOk("chrome", "OFF-2");  // must not throw
    expect((await readLease("chrome", "OFF-2"))?.auto).toBe(true);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `bun test test/leases.test.ts`
Expected: FAIL — the acquire tests find `readLease` returning `undefined`; the explicit-tier test does not throw.

- [ ] **Step 3: Implement**

In `src/leases.ts`, replace the `if (token === undefined) { ... }` block of `assertLeaseOk` with:

```ts
  if (token === undefined) {
    if (!held) {
      // STRICT MODE: acquire rather than wave through. This is the change that
      // makes "you cannot drive a tab you do not hold" true, and it is done
      // here rather than by refusing because refusing would force every caller
      // to learn a claim/release protocol to do what used to just work.
      // Marked auto:true, which is what lets a later call from this same
      // process pass with no token. A LeaseConflictError from claimLease (two
      // processes racing to acquire the same tab, resolved by the "wx"
      // exclusive create) propagates: the loser is genuinely refused.
      if (requireLease()) {
        await claimLease(backend, targetId, { label: defaultLabel(), ttlMs: leaseTtlMs(), auto: true, now });
      }
      return; // unleased, or leased-but-reclaimable: today's behavior
    }
    // An auto lease is owned by a PROCESS, not by a token, so any call from the
    // owning pid passes. NOT gated on requireLease(): an auto:true record can
    // only exist because strict mode created it, and gating this too would mean
    // turning the flag off locks this process out of leases it still holds. It
    // cannot regress 1.4.0, where no auto:true record can exist at all.
    if (held.auto === true && held.pid === process.pid) {
      await touchLease(held, now);
      return;
    }
    throw new LeaseConflictError(
      `${where} is leased by '${held.label}' (pid ${held.pid}). Pass that lease's token as the 'lease' argument, or call release_page to free it. list_leases shows every active lease.`,
      targetId,
      held.label,
    );
  }
```

Then, in the wrong-tab-token branch further down, change:

```ts
  if (parts.backend !== backend || parts.targetId !== targetId) {
    if (!held) return;
```

to:

```ts
  if (parts.backend !== backend || parts.targetId !== targetId) {
    // The token is about a different tab, so it says nothing about this one.
    // Under strict mode this tab still has to be acquired: an agent holding
    // tab A that reaches into unleased tab C is exactly the case the feature
    // exists to cover, and it is the COMMON case under the ambient dispatch
    // scope, not an edge one.
    if (!held) {
      if (requireLease()) {
        await claimLease(backend, targetId, { label: defaultLabel(), ttlMs: leaseTtlMs(), auto: true, now });
      }
      return;
    }
```

Leave the rest of the function exactly as it is. In particular do **not** touch the `if (!held)` throw that follows the "token names THIS tab" comment, and do **not** touch the malformed-token branch.

- [ ] **Step 4: Run to verify it passes**

Run: `bun test test/leases.test.ts && bun run typecheck`
Expected: PASS, all tests, including every pre-existing one.

- [ ] **Step 5: Commit**

```bash
git add src/leases.ts test/leases.test.ts
git commit -F <message file>
```

Subject: `feat(leases): auto-acquire a lease at the gate under strict mode`

---

### Task 3: `new_page` auto-claims under strict mode

**Files:**
- Modify: `src/shared-tools.ts` (`newPage`, lines ~194-210)
- Test: `test/leases.test.ts`

**Interfaces:**
- Consumes: `requireLease()` (Task 1), `ClaimOptions.auto` (Task 1).
- Produces: `newPage` returns `{targetId, url, lease, label, expiresAt}` under strict even without `claim:true`.

- [ ] **Step 1: Write the failing test**

`test/leases.test.ts` already has a fake driver pattern for `newPage`/`closePage`/`selectPage` — reuse it rather than inventing a second one. Find the existing fake `BrowserDriver` in the file and use the same construction.

```ts
describe("new_page under strict mode", () => {
  const originalRequire = process.env.CDP_REQUIRE_LEASE;
  afterEach(() => {
    if (originalRequire === undefined) delete process.env.CDP_REQUIRE_LEASE;
    else process.env.CDP_REQUIRE_LEASE = originalRequire;
    markLongLivedProcess(false);
  });

  test("claims the tab and returns a token even without claim:true", async () => {
    markLongLivedProcess();
    process.env.CDP_REQUIRE_LEASE = "1";
    const driver = makeFakeDriver([]);           // same helper the file already uses
    const res = await newPage(driver, {});
    expect(res.lease).toBeTypeOf("string");
    expect((await readLease("chrome", res.targetId))?.auto).toBe(true);
  });

  test("claim:true stays EXPLICIT under strict mode", async () => {
    markLongLivedProcess();
    process.env.CDP_REQUIRE_LEASE = "1";
    const driver = makeFakeDriver([]);
    const res = await newPage(driver, { claim: true });
    expect((await readLease("chrome", res.targetId))?.auto).toBe(false);
  });

  test("with the flag off, no claim and no lease field (1.4.0 shape)", async () => {
    const driver = makeFakeDriver([]);
    const res = await newPage(driver, {});
    expect(res.lease).toBeUndefined();
    expect(await readLease("chrome", res.targetId)).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `bun test test/leases.test.ts`
Expected: FAIL — `res.lease` is `undefined` in the first test.

- [ ] **Step 3: Implement**

Replace the body of `newPage` after the `newTrackedPage` call:

```ts
  // Under strict mode a tab nobody holds is a tab nobody may drive, so creating
  // one without claiming it would hand back a target the very next call has to
  // auto-acquire anyway. Doing it here means the tab is never briefly unowned
  // AND the caller is handed a token it can release with, which matters because
  // an auto-acquired lease never returns one.
  const explicit = args.claim === true;
  if (!explicit && !requireLease()) return { targetId: p.id, url: p.url };
  // Atomic in the sense that matters: the tab is claimed before this call
  // returns, so no other agent can see it unclaimed and take it first.
  const { record, token } = await claimLease(backendOf(driver), p.id, {
    label,
    ttlMs: typeof args.ttlMs === "number" && args.ttlMs > 0 ? args.ttlMs : leaseTtlMs(),
    // An explicit claim:true stays explicit under strict mode: the caller asked
    // for the strong tier and must keep getting it, or turning strict on would
    // silently WEAKEN every existing claim:true call site to pid-only.
    auto: !explicit,
  });
  return { targetId: p.id, url: p.url, lease: token, label: record.label, expiresAt: record.lastUsedAt + record.ttlMs };
```

Add `requireLease` to the existing `./leases.ts` import in `src/shared-tools.ts`.

- [ ] **Step 4: Run to verify it passes**

Run: `bun test test/leases.test.ts && bun run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/shared-tools.ts test/leases.test.ts
git commit -F <message file>
```

Subject: `feat(new_page): auto-claim the created tab under strict mode`

---

### Task 4: `release_page` takes a target and closes the tab

**Files:**
- Modify: `src/shared-tools.ts` (export `resolvePage`)
- Modify: `src/leases-tools.ts` (`releasePage`)
- Test: `test/leases.test.ts`

**Interfaces:**
- Consumes: `resolvePage(driver, selector?)` (newly exported), `readOrigin(backend, targetId)` from `./origins.ts`, `releaseLease`, `releaseLeaseFor`, `tokenParts`.
- Produces: `releasePage(driver, {lease?, target?, close?}) => Promise<{released: boolean; closed: boolean; targetId?: string}>`.

Read spec §4 before starting, especially the two hard rules.

- [ ] **Step 1: Write the failing tests**

```ts
describe("release_page: argument validation", () => {
  test("neither lease nor target is refused", async () => {
    await expect(releasePage(makeFakeDriver([]), {})).rejects.toThrow(/exactly one/i);
  });

  test("both lease and target is refused", async () => {
    const { token } = await claimLease("chrome", "REL-0", { label: "x" });
    await expect(releasePage(makeFakeDriver([]), { lease: token, target: "REL-0" }))
      .rejects.toThrow(/exactly one/i);
  });
});

describe("release_page: close-on-release", () => {
  test("closes a tab the toolkit opened", async () => {
    const driver = makeFakeDriver([]);
    const created = await newPage(driver, { claim: true });   // writes an origin record
    const res = await releasePage(driver, { lease: created.lease! });
    expect(res).toEqual({ released: true, closed: true, targetId: created.targetId });
    expect(driver.closed).toContain(created.targetId);
  });

  test("releases but does NOT close a tab the toolkit did not open", async () => {
    // No origin record: a tab the human already had open, which an agent claimed.
    const driver = makeFakeDriver([{ id: "HUMAN-1", url: "https://x", title: "t", type: "page" }]);
    const { token } = await claimLease("chrome", "HUMAN-1", { label: "agent" });
    const res = await releasePage(driver, { lease: token });
    expect(res).toEqual({ released: true, closed: false, targetId: "HUMAN-1" });
    expect(driver.closed).toEqual([]);
  });

  test("close:true forces a close on a tab with no origin record", async () => {
    const driver = makeFakeDriver([{ id: "HUMAN-2", url: "https://x", title: "t", type: "page" }]);
    const { token } = await claimLease("chrome", "HUMAN-2", { label: "agent" });
    const res = await releasePage(driver, { lease: token, close: true });
    expect(res.closed).toBe(true);
  });

  test("close:false keeps an agent-created tab open", async () => {
    const driver = makeFakeDriver([]);
    const created = await newPage(driver, { claim: true });
    const res = await releasePage(driver, { lease: created.lease!, close: false });
    expect(res).toEqual({ released: true, closed: false, targetId: created.targetId });
    expect(driver.closed).toEqual([]);
  });

  test("a RECLAIMED lease releases nothing and closes nothing", async () => {
    // The tab may belong to someone else now. Closing it would kill their tab.
    const driver = makeFakeDriver([]);
    const created = await newPage(driver, { claim: true });
    await claimLease("chrome", created.targetId, { label: "new-owner", now: Date.now() + 10_000_000 });
    const res = await releasePage(driver, { lease: created.lease! });
    expect(res).toEqual({ released: false, closed: false });
    expect(driver.closed).toEqual([]);
  });

  test("a malformed token releases nothing and does not throw", async () => {
    const res = await releasePage(makeFakeDriver([]), { lease: "not-a-token" });
    expect(res).toEqual({ released: false, closed: false });
  });

  test("a failed close still reports the release as done", async () => {
    const driver = makeFakeDriver([]);
    const created = await newPage(driver, { claim: true });
    driver.failClose = true;
    const res = await releasePage(driver, { lease: created.lease! });
    expect(res).toEqual({ released: true, closed: false, targetId: created.targetId });
  });
});

describe("release_page: target mode", () => {
  test("releases and closes an agent tab addressed by selector", async () => {
    markLongLivedProcess();
    process.env.CDP_REQUIRE_LEASE = "1";
    const driver = makeFakeDriver([]);
    const created = await newPage(driver, {});     // auto-claimed under strict
    driver.pages.push({ id: created.targetId, url: "about:blank", title: "", type: "page" });
    const res = await releasePage(driver, { target: created.targetId });
    expect(res).toEqual({ released: true, closed: true, targetId: created.targetId });
    markLongLivedProcess(false);
    delete process.env.CDP_REQUIRE_LEASE;
  });

  test("with the flag off, an unleased tab is a no-op, not a licence to close", async () => {
    const driver = makeFakeDriver([{ id: "FREE-1", url: "https://x", title: "t", type: "page" }]);
    const res = await releasePage(driver, { target: "FREE-1" });
    expect(res).toEqual({ released: false, closed: false, targetId: "FREE-1" });
    expect(driver.closed).toEqual([]);
  });

  test("a tab held by another live pid is refused", async () => {
    const rec: LeaseRecord = {
      backend: "chrome", targetId: "OTHER-1", nonce: "d".repeat(24),
      pid: 1, label: "other-agent", createdAt: Date.now(), lastUsedAt: Date.now(),
      ttlMs: 900_000, auto: true,
    };
    await writeFile(leaseFile("chrome", "OTHER-1"), JSON.stringify(rec));
    const driver = makeFakeDriver([{ id: "OTHER-1", url: "https://x", title: "t", type: "page" }]);
    await expect(releasePage(driver, { target: "OTHER-1" })).rejects.toThrow(LeaseConflictError);
    expect(driver.closed).toEqual([]);
  });
});
```

The fake driver needs `closed: string[]` and a `failClose` flag. Extend the file's existing fake rather than adding a second one; if the existing fake has no `closePage` recording, add it there so every test shares one fake.

- [ ] **Step 2: Run to verify it fails**

Run: `bun test test/leases.test.ts`
Expected: FAIL — `releasePage` ignores `target`, never closes, and returns `{released}` with no `closed` key.

- [ ] **Step 3: Implement**

In `src/shared-tools.ts`, change `async function resolvePage(` to `export async function resolvePage(` and add to its doc comment:

```ts
/** Exported for leases-tools.ts's release_page{target}, which needs exactly this
 *  gate: resolving through here is what authorizes the release. */
```

Replace `releasePage` in `src/leases-tools.ts`:

```ts
/**
 * Give a lease back, and close the tab if this toolkit opened it.
 *
 * TWO WAYS IN, because an auto-acquired lease never handed the caller a token:
 * `lease` is the 1.4.0 path, `target` resolves through shared-tools' resolvePage
 * and is authorized by the same gate as any other call. Exactly one is required;
 * accepting both would leave it ambiguous which one authorizes the close.
 *
 * WHY PROVENANCE DECIDES THE CLOSE. A lease says who is driving a tab, never who
 * opened it. Closing on release is right for a tab this toolkit opened for an
 * agent and wrong for a tab the human already had open and an agent merely
 * claimed. origins.ts records exactly that distinction and its records outlive
 * the lease, so the answer is still there at release time.
 *
 * A RELEASE THAT DID NOT HAPPEN NEVER CLOSES. An already-released or reclaimed
 * lease reports released:false, and the tab may well belong to another agent by
 * then; closing it would destroy a tab someone else is driving. This is the one
 * rule in this function that is a safety property rather than a convenience.
 */
export async function releasePage(
  driver: BrowserDriver,
  args: { lease?: LeaseToken; target?: TargetSelector; close?: boolean } = {},
): Promise<{ released: boolean; closed: boolean; targetId?: string }> {
  const hasLease = typeof args.lease === "string" && args.lease.length > 0;
  const hasTarget = typeof args.target === "string" && args.target.length > 0;
  if (hasLease === hasTarget) {
    throw new LeaseToolError(
      "release_page takes exactly one of 'lease' (the token claim_page returned) or 'target' (a selector for a tab this process holds)",
    );
  }

  const backend = backendOf(driver);
  let targetId: string;
  let released: boolean;

  if (hasLease) {
    const parts = tokenParts(args.lease as LeaseToken);
    // A malformed token names no tab, so there is nothing to release and
    // nothing to close. Idempotent rather than throwing, as in 1.4.0.
    if (!parts) return { released: false, closed: false };
    targetId = parts.targetId;
    released = (await releaseLease(args.lease as LeaseToken)).released;
  } else {
    // resolvePage runs assertLeaseOk, which IS the authorization: a tab held by
    // another process throws here, and under strict mode an unleased tab is
    // acquired first, so the caller holds it by the time we release it.
    const page = await resolvePage(driver, args.target);
    targetId = page.id;
    released = (await releaseLeaseFor(backend, targetId)).released;
  }

  if (!released) return { released: false, closed: false, ...(hasTarget ? { targetId } : {}) };

  const shouldClose =
    args.close === false ? false
    : args.close === true ? true
    : (await readOrigin(backend, targetId)) !== undefined;
  if (!shouldClose) return { released: true, closed: false, targetId };

  // The release already succeeded and is not undone by a failed close: the
  // caller has genuinely given the lease back either way, and throwing here
  // would report a release that did happen as an error.
  const res = await driver.closePage(targetId).catch(() => ({ success: false }));
  return { released: true, closed: res.success === true, targetId };
}
```

Update the imports at the top of `src/leases-tools.ts`: add `releaseLeaseFor`, `tokenParts` to the `./leases.ts` import, add `readOrigin` to the `./origins.ts` import, add `import { resolvePage } from "./shared-tools.ts";` and `import type { TargetSelector } from "./types.ts";`.

> **Import-cycle check:** `shared-tools.ts` must not import `leases-tools.ts`. Verify with `grep -n "leases-tools" src/shared-tools.ts` — it must print nothing.

Note the malformed-token early return omits `targetId`, and the lease-mode `released:false` return omits it too, because a token that matched nothing names no tab we are willing to vouch for. Target mode always knows its `targetId`, so it always reports one.

- [ ] **Step 4: Run to verify it passes**

Run: `bun test test/leases.test.ts && bun run typecheck && grep -c "leases-tools" src/shared-tools.ts`
Expected: tests PASS, typecheck clean, grep prints `0`.

- [ ] **Step 5: Commit**

```bash
git add src/leases-tools.ts src/shared-tools.ts test/leases.test.ts
git commit -F <message file>
```

Subject: `feat(release_page): accept a target selector and close agent-created tabs`

---

### Task 5: `src/reap.ts` — the pure selector

**Files:**
- Create: `src/reap.ts`
- Test: `test/leases.test.ts`

**Interfaces:**
- Consumes: `LeaseSummary`, `LeaseBackend` from `./leases.ts`; `OriginSummary` from `./origins.ts`.
- Produces: `staleAgentTabs(input): ReapedTab[]` and `interface ReapedTab { targetId: string; label: string; reason: "dead-pid" | "expired" }`.

Read spec §5. The four conditions are the whole task; getting condition 4 wrong is a data-loss bug.

- [ ] **Step 1: Write the failing tests**

```ts
import { staleAgentTabs } from "../src/reap.ts";
import type { OriginSummary } from "../src/origins.ts";
import type { LeaseSummary } from "../src/leases.ts";

describe("staleAgentTabs", () => {
  const origin = (id: string): [string, OriginSummary] =>
    [id, { backend: "chrome", targetId: id, label: "agent-x", pid: 4242, createdAt: 1 }];
  const lease = (id: string, stale: LeaseSummary["stale"], over: Partial<LeaseSummary> = {}): LeaseSummary => ({
    backend: "chrome", targetId: id, label: "agent-x", pid: 4242, createdAt: 1,
    lastUsedAt: 1, ttlMs: 900_000, pidAlive: false, stale, ...over,
  });
  const run = (leases: LeaseSummary[], origins: [string, OriginSummary][], livePageIds: string[]) =>
    staleAgentTabs({ backend: "chrome", livePageIds, origins: new Map(origins), leases });

  test("reaps an agent tab whose owner died", () => {
    expect(run([lease("T1", "dead-pid")], [origin("T1")], ["T1"]))
      .toEqual([{ targetId: "T1", label: "agent-x", reason: "dead-pid" }]);
  });

  test("reaps an agent tab whose lease expired", () => {
    expect(run([lease("T2", "expired")], [origin("T2")], ["T2"])[0]?.reason).toBe("expired");
  });

  test("NEVER reaps an agent tab with no lease at all", () => {
    // This is what new_page produces for a user who never touches leases.
    // Closing these would be a data-loss bug, not a cleanup.
    expect(run([], [origin("T3")], ["T3"])).toEqual([]);
  });

  test("never reaps a healthy lease", () => {
    expect(run([lease("T4", false, { pidAlive: true })], [origin("T4")], ["T4"])).toEqual([]);
  });

  test("never reaps target-gone: there is no tab left to close", () => {
    expect(run([lease("T5", "target-gone")], [origin("T5")], ["T5"])).toEqual([]);
  });

  test("never reaps a tab with no origin record", () => {
    expect(run([lease("T6", "dead-pid")], [], ["T6"])).toEqual([]);
  });

  test("never reaps a target absent from the PAGE listing", () => {
    // Guards the page-only rule: a worker or iframe can carry a lease via
    // pickPage's bare-id branch, and "close the stale tab" is meaningless there.
    expect(run([lease("T7", "dead-pid")], [origin("T7")], [])).toEqual([]);
  });

  test("never reaps an unreadable lease row", () => {
    expect(run([lease("T8", "dead-pid", { unreadable: "EACCES" })], [origin("T8")], ["T8"])).toEqual([]);
  });

  test("ignores leases belonging to the other backend", () => {
    expect(run([lease("T9", "dead-pid", { backend: "firefox" })], [origin("T9")], ["T9"])).toEqual([]);
  });

  test("selects several tabs in one pass", () => {
    const out = run(
      [lease("A", "dead-pid"), lease("B", "expired"), lease("C", false, { pidAlive: true })],
      [origin("A"), origin("B"), origin("C")],
      ["A", "B", "C"],
    );
    expect(out.map((r) => r.targetId).sort()).toEqual(["A", "B"]);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `bun test test/leases.test.ts`
Expected: FAIL — cannot resolve module `../src/reap.ts`.

- [ ] **Step 3: Implement**

Create `src/reap.ts`:

```ts
/**
 * Closing tabs whose agent died, without a background sweeper.
 *
 * WHY REAP AT ALL. release_page closes a tab an agent gives back, but an agent
 * that crashes, is killed, or simply stops calling never gives anything back.
 * Its tab stays open forever with a lease file nobody will ever release. That
 * is the failure this module exists for, and it is the common one: a timeout is
 * a more likely end to an agent than a clean shutdown.
 *
 * WHY REAP-ON-READ AND NOT A SWEEPER. Same reasoning as origins.ts's ledger: a
 * background sweeper is a second lifetime to reason about and a process that
 * has to be running. list_pages and list_leases already hold the browser's
 * target list and the lease directory at the moment they run, so doing it there
 * costs one extra pass over data already in hand and needs nothing scheduled.
 *
 * WHY THE SELECTION IS A PURE FUNCTION. Every mistake in this module closes a
 * tab someone wanted. A pure selector over plain data is testable across the
 * whole matrix of {provenance} x {lease state} x {liveness} with no browser and
 * no filesystem, which is the only way to be confident about a destructive
 * operation. The impure wrapper below does nothing but call it and act.
 */
import type { BrowserDriver } from "./driver.ts";
import { listLeases, releaseLeaseFor, type LeaseBackend, type LeaseSummary } from "./leases.ts";
import { originIndex, type OriginSummary } from "./origins.ts";

export interface ReapedTab {
  targetId: string;
  label: string;
  /** Why it was reaped. Deliberately narrower than LeaseStaleReason: see below. */
  reason: "dead-pid" | "expired";
}

export interface ReapInput {
  backend: LeaseBackend;
  /**
   * Ids from the PAGE-ONLY listing, never from an `all:true` listing. A worker,
   * iframe or background page can carry a lease (pickPage's bare-id branch
   * resolves non-page targets), and "close the stale tab" is meaningless for
   * one. This is a different set from the one shared-tools' reapSet feeds to the
   * origin ledger, which deliberately uses the unfiltered listing so a live but
   * filtered-out target does not lose its provenance record. Two reaps, two
   * questions, two id sets: do not merge them.
   */
  livePageIds: readonly string[];
  origins: ReadonlyMap<string, OriginSummary>;
  leases: readonly LeaseSummary[];
}

/**
 * Select the tabs that may be closed. PURE: no I/O, no driver, no clock.
 *
 * All four conditions must hold, and condition 4 is the load-bearing one:
 *
 *  1. the lease row is for this backend and READABLE. An `unreadable` row is
 *     never reaped for the same reason listLeases reports it as stale:false -
 *     we cannot see who owns it, and a guess in the destructive direction is
 *     the one guess that cannot be undone.
 *  2. it is stale for `dead-pid` or `expired`. NOT `target-gone`, which means
 *     the tab is already closed and there is nothing to do, and obviously not
 *     `false`.
 *  3. the target is actually still open, per livePageIds.
 *  4. the toolkit OPENED it. An agent-created tab with NO lease is deliberately
 *     never reaped: that is exactly what new_page produces for a user who never
 *     touches leases, and closing those would be a data-loss bug rather than a
 *     cleanup. Only a tab that was claimed and then abandoned qualifies.
 */
export function staleAgentTabs(input: ReapInput): ReapedTab[] {
  const live = new Set(input.livePageIds);
  const out: ReapedTab[] = [];
  for (const row of input.leases) {
    if (row.backend !== input.backend) continue;
    if (row.unreadable !== undefined) continue;
    if (row.stale !== "dead-pid" && row.stale !== "expired") continue;
    if (!live.has(row.targetId)) continue;
    const origin = input.origins.get(row.targetId);
    if (origin === undefined || origin.unreadable !== undefined) continue;
    out.push({ targetId: row.targetId, label: row.label, reason: row.stale });
  }
  return out;
}
```

If `typecheck` reports `BrowserDriver`, `listLeases`, `releaseLeaseFor` or `originIndex` as unused at this point, leave them out and add them back in Task 6, which uses all four.

- [ ] **Step 4: Run to verify it passes**

Run: `bun test test/leases.test.ts && bun run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/reap.ts test/leases.test.ts
git commit -F <message file>
```

Subject: `feat(reap): pure selector for stale agent tabs`

---

### Task 6: Wire reap into `list_pages` and `list_leases`

**Files:**
- Modify: `src/reap.ts` (add the impure wrapper)
- Modify: `src/shared-tools.ts` (`listPages`)
- Modify: `src/leases-tools.ts` (`listLeasesTool`)
- Test: `test/leases.test.ts`

**Interfaces:**
- Consumes: `staleAgentTabs` (Task 5), `requireLease` (Task 1).
- Produces: `reapStaleAgentTabs(driver, backend): Promise<ReapedTab[]>`; `listPages` and `listLeasesTool` both gain an optional `reaped?: ReapedTab[]`.

- [ ] **Step 1: Write the failing tests**

```ts
describe("reap wiring", () => {
  const originalRequire = process.env.CDP_REQUIRE_LEASE;
  afterEach(() => {
    if (originalRequire === undefined) delete process.env.CDP_REQUIRE_LEASE;
    else process.env.CDP_REQUIRE_LEASE = originalRequire;
    markLongLivedProcess(false);
  });

  /** An agent tab whose owning process is gone: origin record + dead-pid lease. */
  async function abandonedAgentTab(driver: ReturnType<typeof makeFakeDriver>, id: string) {
    await recordOrigin("chrome", id, { label: "dead-agent" });
    const rec: LeaseRecord = {
      backend: "chrome", targetId: id, nonce: "e".repeat(24), pid: 999_999,
      label: "dead-agent", createdAt: 1, lastUsedAt: 1, ttlMs: 900_000, auto: true,
    };
    await writeFile(leaseFile("chrome", id), JSON.stringify(rec));
    driver.pages.push({ id, url: "about:blank", title: "", type: "page" });
  }

  test("list_pages closes the abandoned tab, reports it, and omits it from pages", async () => {
    markLongLivedProcess();
    process.env.CDP_REQUIRE_LEASE = "1";
    const driver = makeFakeDriver([]);
    await abandonedAgentTab(driver, "REAP-1");
    const res = await listPages(driver, {});
    expect(driver.closed).toEqual(["REAP-1"]);
    expect(res.reaped).toEqual([{ targetId: "REAP-1", label: "dead-agent", reason: "dead-pid" }]);
    expect(res.pages.map((p) => p.id)).not.toContain("REAP-1");
    expect(res.count).toBe(res.pages.length);
    expect(await readLease("chrome", "REAP-1")).toBeUndefined();
  });

  test("list_pages omits the reaped key entirely when nothing was reaped", async () => {
    markLongLivedProcess();
    process.env.CDP_REQUIRE_LEASE = "1";
    const driver = makeFakeDriver([{ id: "KEEP-1", url: "https://x", title: "t", type: "page" }]);
    const res = await listPages(driver, {});
    expect("reaped" in res).toBe(false);
  });

  test("with the flag off, nothing is reaped", async () => {
    const driver = makeFakeDriver([]);
    await abandonedAgentTab(driver, "REAP-2");
    const res = await listPages(driver, {});
    expect(driver.closed).toEqual([]);
    expect(res.pages.map((p) => p.id)).toContain("REAP-2");
  });

  test("list_leases reaps too and drops the reaped row", async () => {
    markLongLivedProcess();
    process.env.CDP_REQUIRE_LEASE = "1";
    const driver = makeFakeDriver([]);
    await abandonedAgentTab(driver, "REAP-3");
    const res = await listLeasesTool(driver);
    expect(driver.closed).toEqual(["REAP-3"]);
    expect(res.leases.map((l) => l.targetId)).not.toContain("REAP-3");
    expect(res.count).toBe(res.leases.length);
  });

  test("a tab whose close FAILS is not reported as reaped and keeps its row", async () => {
    markLongLivedProcess();
    process.env.CDP_REQUIRE_LEASE = "1";
    const driver = makeFakeDriver([]);
    await abandonedAgentTab(driver, "REAP-4");
    driver.failClose = true;
    const res = await listPages(driver, {});
    expect(res.reaped).toBeUndefined();
    expect(res.pages.map((p) => p.id)).toContain("REAP-4");
  });
});
```

Import `recordOrigin` from `../src/origins.ts`, `listPages` from `../src/shared-tools.ts`, and `listLeasesTool` from `../src/leases-tools.ts`.

- [ ] **Step 2: Run to verify it fails**

Run: `bun test test/leases.test.ts`
Expected: FAIL — `driver.closed` is empty; `res.reaped` is `undefined` in the first test.

- [ ] **Step 3: Implement**

Append to `src/reap.ts`:

```ts
/**
 * Select, close, and drop the leases. Returns ONLY the tabs actually closed.
 *
 * A close that fails is not reported, and that asymmetry is deliberate: the
 * caller filters its listing by this array, so reporting a tab we failed to
 * close would hide a tab that is still open. Failing quietly leaves the tab
 * visible and the lease in place, and the next read tries again.
 *
 * The lease file is unlinked; the ORIGIN record is not. listOrigins already
 * reaps records for targets the browser no longer has, so the record disappears
 * on the next listing. One lifetime rule for origin records, not three.
 */
export async function reapStaleAgentTabs(driver: BrowserDriver, backend: LeaseBackend): Promise<ReapedTab[]> {
  // The PAGE-ONLY listing: see ReapInput.livePageIds.
  const livePageIds = (await driver.listPages()).map((p) => p.id);
  const [origins, leases] = await Promise.all([
    // undefined liveIds = reap nothing from the ledger here. Reaping origin
    // records is list_pages' job and it uses a DIFFERENT id set (the unfiltered
    // listing); doing it here too would delete records for targets that are
    // live but filtered out of the page-only view.
    originIndex(backend, undefined),
    listLeases({ liveIds: livePageIds, liveBackend: backend }).catch(() => [] as LeaseSummary[]),
  ]);
  const candidates = staleAgentTabs({ backend, livePageIds, origins, leases });
  const closed: ReapedTab[] = [];
  for (const c of candidates) {
    const res = await driver.closePage(c.targetId).catch(() => ({ success: false }));
    if (res.success !== true) continue;
    await releaseLeaseFor(backend, c.targetId);
    closed.push(c);
  }
  return closed;
}
```

In `src/shared-tools.ts`, replace the body of `listPages`:

```ts
export async function listPages(
  driver: BrowserDriver,
  args: { all?: boolean } = {},
): Promise<{ pages: ListedPage[]; count: number; reaped?: ReapedTab[] }> {
  // Reap FIRST, so a tab this call is about to close never appears in the
  // listing it returns. Under strict mode only: see requireLease.
  const reaped = requireLease() ? await reapStaleAgentTabs(driver, backendOf(driver)) : [];
  const reapedIds = new Set(reaped.map((r) => r.targetId));
  const pages = (await driver.listPages({ all: args.all })).filter((p) => !reapedIds.has(p.id));
  // Never let provenance break the listing: originIndex does not throw, and a
  // missing or unreadable ledger yields an empty map, so every page falls back
  // to origin "unknown" exactly as a pre-ledger consumer always saw.
  const ledger = await originIndex(backendOf(driver), await reapSet(driver, pages, args.all));
  const annotated: ListedPage[] = pages.map((p) => {
    const rec = ledger.get(p.id);
    if (!rec) return { ...p, origin: "unknown" };
    if (rec.unreadable !== undefined) return { ...p, origin: "unknown", originUnreadable: rec.unreadable };
    return { ...p, origin: "agent", label: rec.label, createdAt: rec.createdAt };
  });
  // `reaped` is present only when it has something to say, so the common-case
  // shape is byte-identical to 1.4.0. Silently closing a tab is not acceptable:
  // if a read closed something, the read says so.
  return { pages: annotated, count: annotated.length, ...(reaped.length ? { reaped } : {}) };
}
```

Note the `driver.listPages` call moved *after* the reap, so the listing reflects the closes. Add `import { reapStaleAgentTabs, type ReapedTab } from "./reap.ts";` to `shared-tools.ts`.

In `src/leases-tools.ts`, replace `listLeasesTool`:

```ts
export async function listLeasesTool(
  driver: BrowserDriver,
  _args: Record<string, never> = {} as Record<string, never>,
): Promise<{ leases: LeaseSummary[]; count: number; reaped?: ReapedTab[] }> {
  const backend = backendOf(driver);
  // Same reap as list_pages, and for the same reason: this is the other tool an
  // operator runs when tabs look wrong, so it must not report a lease it is
  // about to delete. Strict mode only.
  const reaped = requireLease() ? await reapStaleAgentTabs(driver, backend) : [];
  const reapedIds = new Set(reaped.map((r) => r.targetId));
  const liveIds = (await driver.listPages()).map((p) => p.id);
  // liveBackend scopes the target-gone test to the browser these ids came from,
  // so leases held on the OTHER backend are not mislabeled as reclaimable.
  const all = await listLeases({ liveIds, liveBackend: backend });
  const leases = all.filter((l) => !(l.backend === backend && reapedIds.has(l.targetId)));
  return { leases, count: leases.length, ...(reaped.length ? { reaped } : {}) };
}
```

Add `requireLease` to the `./leases.ts` import and `import { reapStaleAgentTabs, type ReapedTab } from "./reap.ts";` to `leases-tools.ts`.

> **Import-cycle check:** `reap.ts` must import only from `driver.ts`, `leases.ts`, `origins.ts`. It must NOT import `shared-tools.ts` or `leases-tools.ts`. Verify: `grep -nE "shared-tools|leases-tools" src/reap.ts` prints nothing.

- [ ] **Step 4: Run to verify it passes**

Run: `bun test && bun run typecheck`
Expected: PASS, whole suite.

- [ ] **Step 5: Commit**

```bash
git add src/reap.ts src/shared-tools.ts src/leases-tools.ts test/leases.test.ts
git commit -F <message file>
```

Subject: `feat(reap): close abandoned agent tabs on list_pages and list_leases`

---

### Task 7: MCP schemas

**Files:**
- Modify: `src/manifest.ts`
- Test: `test/leases.test.ts` (the file already imports `TOOL_NAMES` and `MANIFEST` for a drift check — extend it)

**Interfaces:**
- Consumes: the arg shapes from Tasks 3, 4, 6.
- Produces: no code interface; this is the contract agents actually read.

- [ ] **Step 1: Write the failing test**

```ts
describe("manifest reflects the lease-required surface", () => {
  const spec = (name: string) => MANIFEST.find((s) => s.name === name);

  test("no tool still claims unleased tabs behave exactly as before", () => {
    // That sentence is false under CDP_REQUIRE_LEASE and appeared on 36 tools.
    const stale = MANIFEST.filter((s) =>
      JSON.stringify(s.inputSchema).includes("which behave exactly as before"));
    expect(stale.map((s) => s.name)).toEqual([]);
  });

  test("release_page advertises target and close, and requires neither key", () => {
    const s = spec("release_page")!;
    expect(Object.keys(s.inputSchema.properties ?? {}).sort()).toEqual(["close", "lease", "target"]);
    expect(s.inputSchema.required ?? []).toEqual([]);
    expect(s.description.toLowerCase()).not.toContain("does not close the tab");
  });

  test("every lease-bearing tool mentions CDP_REQUIRE_LEASE", () => {
    const bearing = MANIFEST.filter((s) => "lease" in (s.inputSchema.properties ?? {}));
    expect(bearing.length).toBeGreaterThan(30);
    for (const s of bearing) {
      const d = JSON.stringify((s.inputSchema.properties as Record<string, { description?: string }>).lease?.description);
      expect(d).toContain("CDP_REQUIRE_LEASE");
    }
  });

  test("list_pages and list_leases document reaped", () => {
    expect(spec("list_pages")!.description).toContain("reaped");
    expect(spec("list_leases")!.description).toContain("reaped");
  });

  test("new_page documents the strict-mode auto-claim", () => {
    const claim = (spec("new_page")!.inputSchema.properties as Record<string, { description?: string }>).claim;
    expect(claim?.description).toContain("CDP_REQUIRE_LEASE");
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `bun test test/leases.test.ts`
Expected: FAIL — 36 tools carry the stale sentence; `release_page` has only `lease` and `required:["lease"]`.

- [ ] **Step 3: Implement**

Replace **every** occurrence of the two existing `lease` descriptions in `src/manifest.ts` with this exact string (both the variant ending "which behave exactly as before." and the shorter one ending "omit it for unleased tabs."):

```
Opaque lease token from claim_page. Omit it for a tab this process already holds: under CDP_REQUIRE_LEASE the gate acquires a lease automatically and one acquired that way passes for any later call from the same process. Required when the tab is held by ANOTHER process, and required for a tab claimed explicitly via claim_page or new_page{claim:true}, which always demands its own token. Without CDP_REQUIRE_LEASE an unleased tab needs no token at all.
```

Update `release_page`:

```json
{
  "name": "release_page",
  "description": "Give a lease back, and close the tab if this toolkit opened it. Takes exactly one of 'lease' (the token claim_page returned) or 'target' (a selector for a tab this process holds, which is how you release a lease the gate acquired for you automatically, since that path never hands you a token). A tab with a creation record from this toolkit is closed; a tab that was already open and merely claimed is released and left alone. Override either way with 'close'. Idempotent: an already-released, reclaimed, or expired lease reports released:false, and a release that did not happen never closes anything, because by then the tab may belong to another agent. Answers {released, closed, targetId}.",
  "inputSchema": {
    "type": "object",
    "properties": {
      "lease": {
        "type": "string",
        "description": "The opaque token claim_page (or new_page with claim:true) returned. Mutually exclusive with 'target'."
      },
      "target": {
        "type": "string",
        "description": "Target selector for a tab this process holds: active | index:N | url:<substr> | title:<substr> | <targetId>. Mutually exclusive with 'lease'. Refused if another process holds the tab."
      },
      "close": {
        "type": "boolean",
        "description": "Force the close decision instead of letting the creation ledger decide. true closes even a tab this toolkit did not open; false keeps an agent-created tab open. Omit for the default, which closes only tabs this toolkit created."
      }
    },
    "required": [],
    "additionalProperties": false
  }
}
```

`required` is `[]` rather than an `anyOf`, because MCP clients handle `anyOf` inconsistently; the one-of rule is enforced at runtime by `releasePage` and stated in the description.

Append to `list_pages`' description:

```
Under CDP_REQUIRE_LEASE this call also reaps: a tab this toolkit created whose lease is stale because the owning process died or the TTL elapsed is closed, and the closed tabs are reported in an additive 'reaped' array ({targetId,label,reason}) that is present only when something was actually closed. A tab with no lease is never reaped, so tabs opened by a caller that never uses leases are untouched.
```

Append to `list_leases`' description:

```
Under CDP_REQUIRE_LEASE this call reaps abandoned agent tabs exactly as list_pages does, reporting them in an additive 'reaped' array and omitting their rows from the listing.
```

Append to `new_page`'s `claim` description:

```
Under CDP_REQUIRE_LEASE the new tab is claimed and a lease returned even without claim:true, because a tab nobody holds is a tab nobody may drive; passing claim:true additionally makes the lease an explicit one, which requires its token on every later call even from this same process.
```

- [ ] **Step 4: Run to verify it passes**

Run: `bun test && bun run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/manifest.ts test/leases.test.ts
git commit -F <message file>
```

Subject: `docs(manifest): schemas for strict mode, release_page target, and reaped`

---

### Task 8: The live smoke harness

**Files:**
- Modify: `test/lease-smoke.ts`

**Interfaces:**
- Consumes: everything from Tasks 1-7.
- Produces: nothing importable; this is the only test that can prove the cross-process behavior.

`bun test` **cannot** reach these cases: a lease is keyed on the claiming pid, and a sequence of in-process calls can never collide because there is only one pid. Read the existing harness fully before adding to it — it already spawns a second OS process, captures a runtime baseline, and diffs it at exit.

- [ ] **Step 1: Add the three scenarios**

Follow the file's existing structure exactly (same helpers, same assertion style, same reporting). Add:

1. **Strict cross-process refusal.** Parent, with `CDP_REQUIRE_LEASE=1`, opens a throwaway tab and touches it with an ordinary tool call (NOT `claim_page`) so the lease is auto-acquired. Spawn the child with `CDP_REQUIRE_LEASE=1` and no token; assert it is refused, that the error keeps `LeaseConflictError` with `targetId` and `holder` intact and is NOT coded `no-such-target`, and — the part that matters — that **the side effect did not happen**, proved by reading the marker back, not by the throw.
2. **Release closes an agent tab, and only an agent tab.** Open a tab via `new_page` under strict, then `release_page{target:<id>}`; assert the tab is gone from `list_pages`. Then take a tab with **no** origin record (open one, then delete its origin record from `CDP_ARTIFACT_DIR`), claim it, `release_page` it, and assert it is still open.
3. **Reap closes an abandoned tab.** Open a tab via `new_page` under strict, overwrite its lease file with a record carrying a dead pid, run `list_pages`, and assert the tab is gone AND `reaped` names it with `reason:"dead-pid"`.

- [ ] **Step 2: Verify the safety property still holds**

The harness must remain safe to point at a browser with real tabs open. Every tab it creates is addressed and closed **by its own target id**; it never closes the browser; it captures its own baseline listing at runtime and fails only if a tab that existed before the run went missing.

**Scenario 3 is the most dangerous test in this repo** — it deliberately triggers a code path whose job is to close tabs. Its lease files must go to a private temp `CDP_ARTIFACT_DIR` (the harness already does this), and the baseline diff must run after it. If the baseline assertion is missing or weakened, the task is not done.

- [ ] **Step 3: Run against a real browser**

Run: `bun run lease:smoke`
Expected: PASS, and the final baseline diff reports no pre-existing tab lost.

If no browser is listening on `CDP_BASE`, start one first; do **not** skip this step or report the task complete on `bun test` alone. CONTRACT.md rule 6 requires this harness to run because all three choke points were touched.

- [ ] **Step 4: Commit**

```bash
git add test/lease-smoke.ts
git commit -F <message file>
```

Subject: `test(lease-smoke): strict cross-process refusal, close-on-release, reap`

---

### Task 9: Documentation and the version bump

**Files:**
- Modify: `README.md`, `CONTRACT.md`, `CHANGELOG.md`, `package.json`, `skills/using-cdp-toolkit/SKILL.md`

**Interfaces:**
- Consumes: the finished behavior from Tasks 1-8.

Do this task **last**, and describe what the code actually does, not what this plan said it would.

- [ ] **Step 1: README**

- Add `CDP_REQUIRE_LEASE` to the env-var table (near `CDP_LEASE_TTL_MS`, ~line 200): default off, MCP-only, one line on what it turns on.
- Line 279's `release_page` row currently says "Idempotent, and does not close the tab." — now false.
- Line 296 ("`release_page` gives it back") and line 298 ("**Opt in, and only ever a refusal.**") both need the strict-mode qualification. Keep the existing opt-in paragraph as the description of default behavior and add strict mode alongside it; do not delete the 1.2-compatibility story, it is still true with the flag off.
- Line 322 ("It outlives the lease, deliberately") — still true for the ledger, but reap now closes tabs, so add the reap rule and its four conditions.
- Line 335's "Not for the CLI" bullet: add that strict mode is likewise MCP-only, and why (a lease reclaimable on arrival, plus reap turning that into closed tabs).
- Add `reap.ts` to the source-tree listing (~line 347).

- [ ] **Step 2: CONTRACT.md rule 6**

Rule 6 lists the three choke points and says a fourth resolution path must call `assertLeaseOk`. Add: the gate may now **acquire** a lease, not only check one, so a new resolution path that skips it loses acquisition as well as enforcement. Keep the existing `lease:smoke` requirement.

- [ ] **Step 3: CHANGELOG**

New `## [1.5.0] - <today>` section above `[1.4.0]`, in the file's existing prose style (dense paragraphs explaining the why and the cost, not terse bullets). Required content:

- **Added:** `CDP_REQUIRE_LEASE`, the `auto` tier, `new_page` auto-claim, `release_page{target}`, reap-on-list and its four conditions, why it is MCP-only.
- **Changed (behavior, no flag):** `release_page` now closes tabs this toolkit opened. State plainly that this is the one change a 1.4.0 consumer sees without opting in, that it is scoped by the creation ledger, and that `close:false` opts out.
- **Residuals**, copied from the spec: auto leases do not isolate subagents sharing one MCP process; reap closes an idle-but-alive agent's tab after `ttlMs`; a read has a side effect.

- [ ] **Step 4: `package.json`**

`"version": "1.4.0"` → `"1.5.0"`. Do not touch the `description` field.

- [ ] **Step 5: `skills/using-cdp-toolkit/SKILL.md`**

This is the agent-facing reference, and both halves of its lease guidance are now wrong. Update the claim/release workflow it teaches: under strict mode an agent does not need to claim before acting, but it **should** `release_page` when finished so its tab closes, and `release_page{target}` is the form to use when it never held a token. Mention that an explicit `claim_page` is the way for one seat to protect a tab from sibling seats in the same session.

- [ ] **Step 6: Verify the whole suite**

```bash
bun run typecheck && bun test && bun run lease:smoke
```
Expected: all three PASS. Paste the real output into the task report; do not summarize it as "tests pass".

- [ ] **Step 7: Commit**

```bash
git add README.md CONTRACT.md CHANGELOG.md package.json skills/using-cdp-toolkit/SKILL.md
git commit -F <message file>
```

Subject: `docs: 1.5.0 — lease-required mode, close-on-release, tab reaping`

---

## Task dependency order

```
1 ──> 2 ──> 3
      │     4
      └──>  5 ──> 6
                  │
    (1-6) ──────> 7 ──> 8 ──> 9
```

Tasks 3, 4 and 5 are independent of each other once 2 lands and may run in parallel. 7 needs the arg shapes from 3, 4 and 6. 8 needs everything. 9 is last because it documents observed behavior.

## Out of scope

Named explicitly so nobody adds them opportunistically:

- Any background sweeper or scheduled cleanup.
- Isolating subagents that share one MCP server process beyond explicit `claim_page`.
- Changing the nonce / exclusive-create model in `leases.ts`.
- Flipping `CDP_REQUIRE_LEASE` on by default. That is a 2.0 conversation.
- Pushing or merging to `main`.
