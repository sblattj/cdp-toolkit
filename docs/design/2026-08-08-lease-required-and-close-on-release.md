# Lease-required mode and close-on-release

Status: approved, not yet implemented
Date: 2026-08-08
Target release: 1.5.0

## Problem

Leases today are **advisory and opt-in**. Two facts follow from that, and both
are the ones that bite:

1. **An unleased tab is open to everyone.** `assertLeaseOk` returns early when
   the caller has no token and the tab is unleased. An agent that never calls
   `claim_page` is never refused anything, so the protection only exists between
   agents that both opted in. One agent forgetting to claim defeats it for
   everybody.
2. **`release_page` leaves the tab open.** It unlinks the lease file and stops.
   The tab stays in the browser, unattributed to anyone, and accumulates. An
   agent that dies or times out never calls `release_page` at all, so its tab
   leaks with no path back to closed.

## Goals

- An agent cannot drive a tab without holding that tab's lease.
- Releasing a lease closes the tab the toolkit opened for it.
- An agent that dies or expires does not leak an open tab forever.
- The existing npm consumers of 1.4.0 keep today's behavior unless they opt in.

## Non-goals

- No background sweeper process. Cleanup stays reap-on-read, matching the
  lifetime rule `origins.ts` already established.
- No change to the nonce/exclusive-create model in `leases.ts`. Every invariant
  in that file's header survives intact.
- No isolation between subagents that share one MCP server process, beyond what
  an explicit `claim_page` already provides. See Residuals.

## Design

### 1. One switch: `CDP_REQUIRE_LEASE`

```ts
/** Read per call, not at module load, so a test can flip it. Mirrors leaseDir(). */
export function requireLease(): boolean {
  const raw = (process.env.CDP_REQUIRE_LEASE ?? "").trim().toLowerCase();
  return raw === "1" || raw === "true" || raw === "yes" || raw === "on";
}
```

Default off. Gates three behaviors and nothing else: **auto-acquire at the
gate**, **`new_page` auto-claim**, and **reap-on-list**. Close-on-release is
deliberately *not* gated (see §4).

With the flag off, every code path in this spec must be byte-identical to 1.4.0.
That is a test requirement, not an aspiration: the existing `test/leases.test.ts`
suite must pass unmodified.

### 2. `LeaseRecord.auto` — the two-tier discriminator

```ts
export interface LeaseRecord {
  // ...unchanged fields...
  /**
   * How this lease was taken, and therefore who may use it without a token.
   *   true  - the gate acquired it implicitly. Passes for any call from `pid`.
   *   false - claim_page or new_page{claim:true}. The token is required, even
   *           from the owning process.
   * Absent on records written by <=1.4.0, and read as false.
   */
  auto?: boolean;
}
```

`ClaimOptions` gains `auto?: boolean` (default `false`). `claimLease` writes it
into the record. Because reclamation creates a *fresh* record rather than
modifying one in place, a reclaimed lease carries the new claimer's `auto`
value, which is correct by construction.

The two tiers exist because auto-acquire has to identify "the same agent"
somehow, and the only identity available to an implicit claim is the process.
That is right for casual use and wrong for a fan-out where several subagents
share one MCP server process. Rather than pick one, an *explicit* `claim_page`
keeps the strict token check it has today, so a seat that needs real isolation
from its siblings has a way to get it.

### 3. Auto-acquire at the gate

`assertLeaseOk` keeps its signature (`Promise<void>`). It does not need to
surface the minted token, because an auto lease passes by pid.

The `token === undefined` branch becomes:

```
!held                                   -> strict ? claimLease({auto:true}) : (nothing);  return
held.auto === true && held.pid === ours -> touchLease(held); return      // NOT flag-gated
otherwise                               -> LeaseConflictError            // unchanged
```

**Only the first line is flag-gated.** The auto-tier pass-through on line 2 runs
regardless of `CDP_REQUIRE_LEASE`, because an `auto:true` record can only exist
if strict mode created it. Gating it too would mean that turning the flag off
locks a process out of leases it is still holding. It cannot regress 1.4.0: a
user who never enabled strict has no `auto:true` records, so line 2 is
unreachable for them.

The wrong-tab-token branch's `if (!held) return` gets the same treatment: an
agent holding tab A that resolves unleased tab C acquires C.

Three cases explicitly do **not** auto-acquire, in strict mode or out:

| Case | Behavior | Why |
|---|---|---|
| Malformed token | throws, unchanged | the caller passed garbage; minting a lease would hide it |
| Token names *this* tab, tab is unleased | throws, unchanged | the caller asserted it holds a specific lease and is wrong. `leases.ts` already rules that "being wrong about that is an error, never a pass-through" |
| Tab held by another live pid | throws, unchanged | the conflict this feature exists to raise |

A `LeaseConflictError` thrown by `claimLease` during auto-acquire propagates:
two processes racing to auto-acquire the same tab resolve through the existing
`wx` exclusive-create, one wins, the loser is refused. No new race.

Auto-acquire uses `defaultLabel()` and `leaseTtlMs()`, and passes no `liveIds` —
matching the three choke points, which deliberately pass none.

**No call site changes.** All three choke points (`resolveTarget` in
`client.ts`, `resolveContext` in `bidi/driver.ts`, `resolvePage` in
`shared-tools.ts`) already call `assertLeaseOk`, so the new behavior reaches
every tool with no per-tool edit. CONTRACT.md rule 6 continues to hold.

### 4. `release_page`: token-or-target, and close the tab

```ts
export async function releasePage(
  driver: BrowserDriver,
  args: { lease?: LeaseToken; target?: TargetSelector; close?: boolean },
): Promise<{ released: boolean; closed: boolean; targetId?: string }>
```

**Exactly one** of `lease` / `target` is required; both or neither throws
`LeaseToolError`. `target` exists because an auto-acquired lease never handed
the agent a token, so without it a strict-mode agent could not release at all.

- **lease mode** — unchanged authorization: `releaseLease(token)` matches the
  nonce or reports `released:false`. A malformed token still returns
  `{released:false, closed:false}` rather than throwing (today's idempotence).
- **target mode** — resolve through `resolvePage`, which runs the gate. That is
  the whole authorization: a tab held by another process throws, and under
  strict an unleased tab is auto-acquired first (so the call is authorized by
  the same rule as any other). Then `releaseLeaseFor(backend, targetId)`.
  With the flag **off**, an unleased tab is not auto-acquired, so
  `releaseLeaseFor` reports `released:false` and nothing is closed. That is
  intended: outside strict mode `release_page{target}` on a tab nobody holds is
  a no-op, not a licence to close it.

`resolvePage` is currently module-private in `shared-tools.ts` and must be
exported for `leases-tools.ts` to import. No cycle results: `shared-tools.ts`
does not import `leases-tools.ts`.

Close decision, applied only after a release actually succeeded:

```
args.close === false -> false
args.close === true  -> true
otherwise            -> (await readOrigin(backend, targetId)) !== undefined
```

That is the provenance rule: **close only tabs this toolkit opened.** A tab the
human already had open, which an agent merely claimed, is released and left
alone. `origins.ts` records exactly this and its records deliberately outlive
the lease, so the answer is available at release time.

Two hard rules:

- **`released:false` never closes.** An already-released or *reclaimed* lease
  means the tab may now belong to someone else; closing it would kill their tab.
- **A failed `driver.closePage` does not throw.** The release already happened
  and succeeded; report `closed:false`.

The origin record is not unlinked here. `listOrigins` already reaps records for
targets the browser no longer has, and a second delete path would be a second
lifetime to reason about.

**Compat:** this changes `release_page` for existing 1.4.0 callers without a
flag. It is scoped to tabs the toolkit itself opened and that the caller is
explicitly releasing, `close:false` opts out, and it goes in CHANGELOG under
behavior changes.

### 5. Reap-on-list

New file `src/reap.ts`, split so the selection logic is testable with no
browser:

```ts
export interface ReapedTab { targetId: string; label: string; reason: "dead-pid" | "expired" }

/** PURE. No I/O, no driver. */
export function staleAgentTabs(input: {
  backend: LeaseBackend;
  livePageIds: readonly string[];
  origins: ReadonlyMap<string, OriginSummary>;
  leases: readonly LeaseSummary[];
}): ReapedTab[];

/** Impure wrapper: select, close, drop leases, return what was actually closed. */
export async function reapStaleAgentTabs(driver: BrowserDriver, backend: LeaseBackend): Promise<ReapedTab[]>;
```

A tab is reaped only when **all four** hold:

1. the lease row is for this `backend` and is readable (an `unreadable` row
   never reaps — same reason `listLeases` reports `stale:false` for one);
2. `stale` is `"dead-pid"` or `"expired"` — **never** `"target-gone"` (nothing
   left to close) and never `false`;
3. the target id is in `livePageIds` (the tab is really still open);
4. `origins` has a record for it — the toolkit opened it.

Condition 4 is the load-bearing one. An agent-created tab with **no** lease is
deliberately never reaped: that is exactly what `new_page` produces for a user
who never touches leases, and closing those would be a data-loss bug.

**`livePageIds` must come from the page-only listing** (`driver.listPages()`
with no `all`), never from the `all:true` listing. `list_pages{all:true}`
includes workers, iframes and background pages; "close the stale tab" is
meaningless for those, and `pickPage`'s bare-id branch means a lease can exist
on one (see Residuals). This is a different set from the one `reapSet` feeds to
the *origin ledger* reap, which deliberately uses the unfiltered listing so a
filtered-out but live target does not lose its provenance record. The two reaps
answer different questions and must not share an id set.

Wiring, under `requireLease()` only:

- `listPages` (`shared-tools.ts`): reap **before** the `originIndex` call, then
  filter the reaped ids out of both `pages` and `count`. Filtering is cheaper
  and more accurate than re-listing.
- `listLeasesTool` (`leases-tools.ts`) already has `liveIds` and the lease rows.
  Same: reap, then drop the reaped rows from the result.

Both gain an additive `reaped?: ReapedTab[]`, **present only when non-empty** so
the common-case shape is untouched. Silent tab-closing is not acceptable: if a
read closed a tab, the read says so.

Per-tab close failures are swallowed; only tabs actually closed are reported.
The reaped tab's **lease** file is unlinked (`releaseLeaseFor`); its **origin**
record is not, in either this path or §4's. Both are left to `listOrigins`'
existing reap-on-read, which drops them on the next listing. One lifetime rule
for origin records, not three.

### 6. Schema and docs

- **`manifest.ts`, the `lease` blurb repeated on 36 tools.** It currently reads
  "omit it for unleased tabs, which behave exactly as before," which is false
  under strict mode. Replace with wording valid in both modes: omitting it is
  fine for a tab this process already holds or can acquire; it is required when
  the tab is held by another process, or was claimed explicitly (which always
  requires its token).
- **`release_page` schema**: add `target` and `close`; `required` becomes `[]`
  with the one-of enforced at runtime (MCP clients handle `anyOf`
  inconsistently). Its description currently ends "Does not close the tab." —
  must change.
- **`new_page` schema**: `claim`'s description gains the strict-mode note that
  the tab is claimed and a token returned even without `claim:true`.
- **`list_pages` / `list_leases` descriptions**: document `reaped`.
- **README** lease section, **CONTRACT.md** rule 6, **CHANGELOG** 1.5.0,
  `package.json` version, and `skills/using-cdp-toolkit/SKILL.md` — the
  agent-facing reference, which teaches the claim/release workflow and is now
  wrong in both halves.

### 7. `new_page` under strict

```
wantClaim = args.claim === true || requireLease()
auto      = args.claim !== true          // explicit claim stays explicit
```

Under strict, `new_page` returns `{targetId, url, lease, label, expiresAt}` even
without `claim:true` (additive). Doing it at creation rather than leaving the
gate to auto-acquire on the next call means the agent is handed a token it can
release with, and the tab is never briefly unowned.

`claim_page` always writes `auto: false`.

## Testing

`test/leases.test.ts` — pure, no browser:

1. `requireLease()` parsing: unset, `0`, `1`, `true`, `TRUE`, `yes`, `on`, garbage.
2. `claimLease` default writes `auto:false`; `{auto:true}` writes `auto:true`;
   a `<=1.4.0` record with no `auto` key reads as `false`.
3. Strict, unleased, no token: `assertLeaseOk` resolves **and** a lease file now
   exists with `auto:true` and `pid === process.pid`.
4. Strict, our own auto lease, no token: passes, `lastUsedAt` refreshed.
5. Strict, our own **explicit** (`auto:false`) lease, no token: throws.
6. Strict, another live pid's auto lease (write a record with pid 1), no token: throws.
7. Strict, token for tab A resolving unleased tab C: C is auto-acquired.
8. Strict, token naming this tab but tab unleased: still throws, no lease minted.
9. Malformed token under strict: throws, no lease minted.
10. **Flag off: every existing test in the file passes unmodified.**
11. `staleAgentTabs` matrix: {origin present/absent} x {lease absent, fresh,
    dead-pid, expired, target-gone, unreadable} x {tab live/gone}. Exactly one
    cell reaps. Plus: a lease whose target id is absent from `livePageIds` but
    present in an `all:true` listing never reaps (guards the page-only rule).
12. `releasePage` arg validation: both, neither.
13. `releasePage` lease-mode on a reclaimed lease: `{released:false,
    closed:false}` and `driver.closePage` never called.
14. `releasePage` close scoping: origin record present -> closed; absent ->
    released, not closed; `close:false` overrides present; `close:true`
    overrides absent.

`test/lease-smoke.ts` — two live processes, real browser (a lease is keyed on
the claiming pid, so `bun test` cannot reach these):

15. Strict cross-process: A touches a tab and auto-acquires it; B without a
    token is refused, keeps `LeaseConflictError` with its `targetId`/`holder`,
    and the side effect is blocked.
16. `release_page{target}` closes an agent-created tab; a claimed non-agent tab
    is released and stays open.
17. Reap: create an agent tab, write a lease with a dead pid, run `list_pages`,
    assert the tab is gone and `reaped` names it.

Every smoke addition must keep the harness's existing safety property: its own
throwaway tab, addressed and closed by its own id, with the runtime-captured
baseline diffed at the end. Reap tests are the most dangerous thing in this
spec to run against a browser with real tabs open, so the baseline assertion is
mandatory, not optional.

`bun run typecheck` and `bun test` gate the change; `bun run lease:smoke` is
required because all three choke points and the error handling above them are
touched (CONTRACT.md rule 6).

## Residuals

Stated plainly rather than designed away:

- **Auto leases do not isolate subagents inside one Claude Code session.** All
  of a session's subagents share one MCP server process, so they share a pid and
  pass each other's auto leases. The escape hatch is an explicit `claim_page`,
  which requires its token even same-process. This is the accepted cost of
  making the common path ergonomic.
- **Reap closes an idle-but-alive agent's tab after `ttlMs`.** `expired` means
  reclaimable, so another agent could already have taken the tab; closing it is
  consistent. Tunable with `CDP_LEASE_TTL_MS` (default 15 min).
- **A read has a side effect.** `list_pages` can close tabs. Mitigated only by
  reporting them in `reaped`.
- **`release_page{target}` under strict on an unleased agent tab** auto-acquires
  it and then closes it — closing a tab the caller never drove. Acceptable
  because under strict an unleased agent tab means nobody is driving it.
- **Auto-acquire can mint a lease on a non-page target.** `pickPage`'s bare-id
  branch searches the full `all:true` listing, so a worker or iframe id
  resolves. The lease is just a file and harms nothing, but it will show up in
  `list_leases`.

## Compatibility

1.5.0, minor. With `CDP_REQUIRE_LEASE` unset, the only behavior change is
close-on-release (§4), scoped to toolkit-created tabs, opt-out via
`close:false`. Everything else is additive: one optional record field, two
optional args on `release_page`, and result fields that appear only when they
have something to say.
