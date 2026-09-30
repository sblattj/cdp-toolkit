# v3.0 — gateway default listing

Status: **implemented** in 3.0.0 (2026-09-29), code commit `1e9f25f`. Numbers below were probed over raw stdio against the real MCP entry point.

## 0. Outcome

With `CDP_TOOL_PROFILE` unset (or `gateway`), `tools/list` advertises **7 tools**, in wire order: `search_tools`, `call_tool`, `navigate_page`, `evaluate_script`, `take_snapshot`, `click`, `fill` (meta-tools first, then manifest order; `GATEWAY_TOOLS` in `src/toolGroups.ts`). It used to advertise 49.

- `search_tools {query?, limit?}`: no query returns the grouped catalog; an exact tool name returns that tool; otherwise ranks available tools by name, group, then docs and returns `{query,total,matches:[{name,group,listed,description,inputSchema}],next}`. `limit` default 8, max 20.
- `call_tool {name, arguments?}`: unwraps and re-enters the same dispatch as a direct call. Availability errors, lease handling (`lease` is read from the inner `arguments`) and error shapes are identical. It refuses to wrap a meta-tool.
- `describe_tool` is unlisted but still answered, with 2.x output.
- `CDP_TOOL_PROFILE=full` restores the 2.x listing plus the two meta-tools. `core`, group lists, and `gateway,<groups>` all work; every profile lists the two meta-tools first.
- The 48 underlying tools and the `cdp` CLI are unchanged. The listing is still static: computed once at startup, `listChanged:false`, ttlMs 3600000, cacheScope public.

## 1. Why

The request was for roughly five top browser tools plus two tools that search and execute the rest. The cost being attacked is real: hosts that load every listed tool eagerly, and small local models with tight context, pay about 9.3k tokens for the 2.7.0 listing (49 entries, 37,346 bytes) before doing anything. The 3.0 default is about 1.3k tokens (5,072 bytes).

`call_tool` is needed because a model can only invoke tools its host puts in front of it, and hosts forward `tools/list`. Merely unlisting tools would leave them reachable by SDK and CLI callers but unreachable for a model.

## 2. Why this does not repeat 2.0's `browser_tools` mistake

2.1 removed 2.0's `browser_tools` meta-tool because it mutated the listing mid-connection, which the MCP spec forbids. 3.0's listing never changes: it is computed once at startup and `listChanged` stays false. Nothing about the v2.1 static-list design changed. What 3.0 re-litigates is only the default, and its cost (next section).

## 3. What is traded away

- **Name-keyed host allowlists and per-tool permission prompts.** A tool reached via `call_tool` shows up to the host as `call_tool`, so a rule like "allow click, deny evaluate_script" cannot distinguish the 43 non-gateway tools. Anyone who needs per-tool host rules should set `CDP_TOOL_PROFILE=full`.
- **Drop-in parity with chrome-devtools-mcp's listing.** Its 29 tool names still exist and are callable with the same names, but only 5 are listed by default. `CDP_TOOL_PROFILE=full` restores a listing with all of them.
- One extra hop (`search_tools`, then `call_tool`) for a model that has not been told a tool's name. The server instructions name the groups and the `new_page` entry point to keep that short.

## 4. Numbers

Measured `tools/list` at `1e9f25f` (raw stdio probe; bytes = compact JSON of `tools`; tokens are bytes/4).

| CDP_TOOL_PROFILE | browser | entries | bytes | ≈tokens |
|---|---|---|---|---|
| unset / `gateway` — the 3.0 default | chrome | 7 | 5,072 | ≈1,268 |
| unset / `gateway` | firefox | 7 | 5,072 | ≈1,268 |
| `gateway,network,console` | chrome | 11 | 7,899 | ≈1,975 |
| `core` | chrome | 14 | 9,661 | ≈2,415 |
| `core,network,console` | chrome | 18 | 12,488 | ≈3,122 |
| `full` | chrome | 50 | 37,911 | ≈9,478 |
| `full` | firefox | 37 | 28,899 | ≈7,225 |
| 2.7.0 default (`full`, for comparison) | chrome | 49 | 37,346 | ≈9,336 |

The default listing is 86.4% smaller in bytes than 2.7.0's default. Server instructions are 1,862 chars, under Claude Code's 2 KB cap.

## 5. Evidence

- Test suite: 1020 pass, 0 fail at `1e9f25f`.
- Live lease e2e (headless Chrome 154, 2026-09-29; `bun run gateway:smoke` reproduces it), all through `call_tool`: `new_page {claim:true,label:'gw-e2e'}` returned a lease token; `call_tool navigate_page` without the lease was refused ("is leased by 'gw-e2e' ... Pass that lease's token as the 'lease' argument"); with the lease it succeeded; a direct `navigate_page` with the lease succeeded; `close_page` via `call_tool` returned `leaseReleased:true`. So the wrapper preserves lease scope and error shape.

## 6. Choice of the five

`navigate_page`, `take_snapshot`, `click`, `fill` are the read-and-act loop most tasks reduce to. `evaluate_script` is the escape hatch: with it a model can do nearly anything a hidden tool does (read state, scroll, dispatch events) even before it has learned to search, so a wrong choice among the five is cheap.

None of the five opens a tab. A model starting with no tab would otherwise have to search first, so the server instructions say it outright: "No tab yet? call_tool {name:'new_page'}".
