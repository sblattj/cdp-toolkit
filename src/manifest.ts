/**
 * MCP tool manifest: the JSON Schemas the cdp-toolkit MCP server advertises via
 * `tools/list`. Each entry's `name` matches a key in the TOOLS registry
 * (src/index.ts) and its `inputSchema` mirrors that tool's TypeScript Args.
 *
 * Generated from the real Args interfaces (extracted + adversarially verified by
 * workflow cdp-toolkit-mcp-schemas). Regenerate if a tool's Args change.
 */

/** A JSON-Schema object describing one tool's arguments. */
export interface ToolInputSchema {
  type: "object";
  properties?: Record<string, unknown>;
  required?: string[];
  additionalProperties?: boolean;
}

/** One MCP tool advertisement. */
export interface ToolSpec {
  name: string;
  description: string;
  inputSchema: ToolInputSchema;
}

export const MANIFEST: ToolSpec[] = [
  {
    "name": "list_pages",
    "description": "Enumerate browser page targets via the CDP browser endpoint (GET /json/list). By default returns only page-type tabs; set 'all' to also include workers and background pages. Each entry carries the targetId used as a target selector elsewhere, plus an 'origin' field recording where the tab came from: 'agent' means this toolkit created it (the entry then also carries the creating 'label' and 'createdAt'), and this stays true after the creating agent releases its lease or dies, which is what makes a stray agent tab findable later. 'unknown' means there is no creation record. It never says 'human': the toolkit cannot prove a person opened a tab, so 'unknown' is the honest word for a tab it did not create, one opened before the toolkit ran, or one whose record could not be written. A tab whose record exists but could not be read reports origin 'unknown' plus 'originUnreadable', so a broken record is never mistaken for no record. Under CDP_REQUIRE_LEASE this call also reaps abandoned agent tabs, but reap-CLOSE and lease-RECLAIMABLE (list_leases' 'stale') now fire at different times: a lease reads reclaimable the moment its TTL elapses, cheap and reversible since another agent may simply take it, while this call only CLOSES the tab, destructively, after an ADDITIONAL grace period past that TTL (CDP_REAP_GRACE_MS, default 2700000ms/45 minutes, so 60 minutes total after last use) — a tab an agent is mid-build between calls on is not destroyed out from under it. A dead-pid lease is reaped immediately regardless of grace: that process is never coming back. Closed tabs are reported in an additive 'reaped' array ({targetId,label,reason}) present only when something was actually closed; a tab with no lease is never reaped. Every entry under an active, readable lease of this backend also carries 'lease': {label, pid, idleMs, expiresAt, stale} — idleMs and expiresAt are computed fresh on every call (now-lastUsedAt and lastUsedAt+ttlMs), never read off disk, and this is unconditional on 'probe'. Set 'probe' to true to also ping each page-type target's renderer: one bounded (500ms) check per target, never more, so a single wedged tab cannot stall the listing beyond its own budget. This adds 'responsive' (true iff the ping answered in time; false on a timeout, a page-side exception, or an unreachable target — never an error for the whole call) and, where that same round trip found human-attributed input, 'humanActiveMs' (see claim_page and list_leases for what that field means and cannot prove). 'responsive' and 'humanActiveMs' are both ABSENT — never false/null — when 'probe' is not set, and 'responsive' is likewise absent on a backend that cannot answer this ping at all.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "lease": {
          "type": "string",
          "description": "Opaque lease token from claim_page. Omit it for a tab this process already holds: under CDP_REQUIRE_LEASE the gate acquires a lease automatically and one acquired that way passes for any later call from the same process. Required when the tab is held by ANOTHER process, and required for a tab claimed explicitly via claim_page or new_page{claim:true}, which always demands its own token. Without CDP_REQUIRE_LEASE an unleased tab needs no token at all."
        },
        "all": {
          "type": "boolean",
          "description": "Include non-page targets (service/shared workers, background pages) when true; otherwise only page-type tabs are listed."
        },
        "probe": {
          "type": "boolean",
          "description": "Ping each page-type target's renderer before returning: one bounded (500ms) Runtime.evaluate per target, never more. Adds 'responsive' to every page-type entry and, where the same round trip finds human-attributed input, 'humanActiveMs'. A wedged or unreachable tab reports responsive:false rather than failing the call. Defaults to false, which is byte-identical to the pre-1.8.0 shape."
        }
      },
      "required": [],
      "additionalProperties": false
    }
  },
  {
    "name": "new_page",
    "description": "Open a new browser tab via Target.createTarget and return {targetId,url}. Defaults to about:blank; navigation is not awaited here (use navigate_page to load and wait).",
    "inputSchema": {
      "type": "object",
      "properties": {
        "lease": {
          "type": "string",
          "description": "Opaque lease token from claim_page. Omit it for a tab this process already holds: under CDP_REQUIRE_LEASE the gate acquires a lease automatically and one acquired that way passes for any later call from the same process. Required when the tab is held by ANOTHER process, and required for a tab claimed explicitly via claim_page or new_page{claim:true}, which always demands its own token. Without CDP_REQUIRE_LEASE an unleased tab needs no token at all."
        },
        "url": {
          "type": "string",
          "description": "URL to open in the new tab; defaults to about:blank."
        },
        "claim": {
          "type": "boolean",
          "description": "Claim the new tab atomically as part of creating it and return a lease token alongside {targetId,url}. Default false, which is byte-identical to the pre-1.2 behavior. Under CDP_REQUIRE_LEASE the new tab is claimed and a lease returned even without claim:true, because a tab nobody holds is a tab nobody may drive; passing claim:true additionally makes the lease an explicit one, which requires its token on every later call even from this same process."
        },
        "label": {
          "type": "string",
          "description": "Agent label recorded on the lease when claim:true, surfaced in conflict errors and list_leases. Defaults to pid-<pid>."
        },
        "ttlMs": {
          "type": "number",
          "description": "How long the lease taken by claim:true survives without use before it is reclaimable. Defaults to CDP_LEASE_TTL_MS, else 900000 (15 minutes). Every checked call refreshes it, so an active agent never expires. Ignored without claim:true."
        }
      },
      "required": [],
      "additionalProperties": false
    }
  },
  {
    "name": "close_page",
    "description": "Close a page target via Target.closeTarget. Requires an explicit, resolvable target; refuses to guess and errors if the selector matches no target.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "lease": {
          "type": "string",
          "description": "Opaque lease token from claim_page. Omit it for a tab this process already holds: under CDP_REQUIRE_LEASE the gate acquires a lease automatically and one acquired that way passes for any later call from the same process. Required when the tab is held by ANOTHER process, and required for a tab claimed explicitly via claim_page or new_page{claim:true}, which always demands its own token. Without CDP_REQUIRE_LEASE an unleased tab needs no token at all."
        },
        "target": {
          "type": "string",
          "description": "Target page selector: 'active' (default) | 'index:N' | 'url:<substr>' | 'title:<substr>' | '<targetId>'."
        }
      },
      "required": [
        "target"
      ],
      "additionalProperties": false
    }
  },
  {
    "name": "select_page",
    "description": "Activate/focus a page target via Target.activateTarget and persist its bare targetId to the selected-state file (CDP_STATE_DIR/selected). Requires an explicit, resolvable target.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "lease": {
          "type": "string",
          "description": "Opaque lease token from claim_page. Omit it for a tab this process already holds: under CDP_REQUIRE_LEASE the gate acquires a lease automatically and one acquired that way passes for any later call from the same process. Required when the tab is held by ANOTHER process, and required for a tab claimed explicitly via claim_page or new_page{claim:true}, which always demands its own token. Without CDP_REQUIRE_LEASE an unleased tab needs no token at all."
        },
        "target": {
          "type": "string",
          "description": "Target page selector: 'active' (default) | 'index:N' | 'url:<substr>' | 'title:<substr>' | '<targetId>'."
        }
      },
      "required": [
        "target"
      ],
      "additionalProperties": false
    }
  },
  {
    "name": "navigate_page",
    "description": "Navigate a target page to a URL (Page.navigate), reload it (reload:true), OR go back/forward in its session history (history:'back'|'forward'), then wait for the load milestone with a bounded timeout so a wedged renderer can't hang. Exactly one of url / reload / history per call. Returns {url,frameId,waitedFor} (plus reloaded:true on a reload, traversed:'back'|'forward' on a history move); waitUntil supports 'load'|'domcontentloaded' only (no 'networkidle'), and there is no auto-snapshot of the new page. Pass reload:true with ignoreCache:true for a hard reload that refetches every subresource (e.g. to pick up a freshly-deployed, non-content-hashed bundle the HTTP cache would serve stale).",
    "inputSchema": {
      "type": "object",
      "properties": {
        "lease": {
          "type": "string",
          "description": "Opaque lease token from claim_page. Omit it for a tab this process already holds: under CDP_REQUIRE_LEASE the gate acquires a lease automatically and one acquired that way passes for any later call from the same process. Required when the tab is held by ANOTHER process, and required for a tab claimed explicitly via claim_page or new_page{claim:true}, which always demands its own token. Without CDP_REQUIRE_LEASE an unleased tab needs no token at all."
        },
        "target": {
          "type": "string",
          "description": "Target page selector: 'active' (default) | 'index:N' | 'url:<substr>' | 'title:<substr>' | '<targetId>'."
        },
        "url": {
          "type": "string",
          "description": "Destination URL to navigate to. Required unless reload:true."
        },
        "reload": {
          "type": "boolean",
          "description": "Reload the current page (Page.reload) instead of navigating to url. Default false."
        },
        "history": {
          "type": "string",
          "enum": [
            "back",
            "forward"
          ],
          "description": "Traverse this tab's session history instead of loading a url: 'back' and 'forward' are the browser's Back and Forward buttons. Mutually exclusive with 'url' and 'reload' — passing two of the three is refused by name rather than resolved by precedence. Works on BOTH backends (Chrome: Page.getNavigationHistory + Page.navigateToHistoryEntry; Firefox: browsingContext.traverseHistory) and waits for the same load milestone as an ordinary navigation. Going back from the first entry, or forward from the last, is an ERROR naming the direction — never a silent success that navigated nowhere. The result carries traversed:'back'|'forward' alongside the resulting url."
        },
        "ignoreCache": {
          "type": "boolean",
          "description": "On reload, bypass the HTTP cache (hard reload) so subresources are refetched. Ignored unless reload:true. Default false."
        },
        "waitUntil": {
          "type": "string",
          "enum": [
            "load",
            "domcontentloaded"
          ],
          "description": "Which load milestone to wait for. Defaults to 'load'. No 'networkidle' support."
        },
        "timeoutMs": {
          "type": "number",
          "description": "Override the navigation timeout in milliseconds."
        }
      },
      "additionalProperties": false
    }
  },
  {
    "name": "wait_for",
    "description": "Poll a target page until the given substring appears in document.body.innerText (Runtime.evaluate on a fixed interval), or throw on timeout. Text-substring waiting only: no aria/role/selector or event variants; throws rather than returning {found:false}.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "lease": {
          "type": "string",
          "description": "Opaque lease token from claim_page. Omit it for a tab this process already holds: under CDP_REQUIRE_LEASE the gate acquires a lease automatically and one acquired that way passes for any later call from the same process. Required when the tab is held by ANOTHER process, and required for a tab claimed explicitly via claim_page or new_page{claim:true}, which always demands its own token. Without CDP_REQUIRE_LEASE an unleased tab needs no token at all."
        },
        "target": {
          "type": "string",
          "description": "Target page selector: 'active' (default) | 'index:N' | 'url:<substr>' | 'title:<substr>' | '<targetId>'."
        },
        "text": {
          "type": "string",
          "description": "Substring to wait for in document.body.innerText. Required."
        },
        "timeoutMs": {
          "type": "number",
          "description": "Total time budget in milliseconds. Defaults to 15000."
        },
        "pollMs": {
          "type": "number",
          "description": "Poll interval in milliseconds. Defaults to 250."
        }
      },
      "required": [
        "text"
      ],
      "additionalProperties": false
    }
  },
  {
    "name": "evaluate_script",
    "description": "Run arbitrary JavaScript in the target page's main-world context over raw CDP and return the evaluated value (returnByValue). With no 'args' the 'expression' is evaluated as a raw expression; when 'args' is provided 'expression' must be a function literal (arrow or classic) invoked on globalThis with the args passed positionally. A thrown exception surfaces as an error; non-serializable returns (DOM nodes, functions) come back as their CDP description string. Pass 'savePath' to write the evaluated value to a JSON file instead: the response then carries only {path,bytes,type,target} and the value itself never appears in it, in any form. That is the way to read a credential (a JWT or session token out of localStorage, for example) without putting the secret into the caller's transcript.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "lease": {
          "type": "string",
          "description": "Opaque lease token from claim_page. Omit it for a tab this process already holds: under CDP_REQUIRE_LEASE the gate acquires a lease automatically and one acquired that way passes for any later call from the same process. Required when the tab is held by ANOTHER process, and required for a tab claimed explicitly via claim_page or new_page{claim:true}, which always demands its own token. Without CDP_REQUIRE_LEASE an unleased tab needs no token at all."
        },
        "target": {
          "type": "string",
          "description": "Page selector: 'active' (or omit) -> first page-type target | '<32-hex targetId>' -> exact target by id | 'index:N' -> Nth page-type target (0-based) | 'url:<substring>' -> first page whose url contains substring | 'title:<substring>' -> first page whose title contains substring."
        },
        "expression": {
          "type": "string",
          "description": "JavaScript to run. Evaluated as an expression when 'args' is omitted; must be a function literal (arrow or classic) whose parameters receive 'args' when 'args' is provided."
        },
        "awaitPromise": {
          "type": "boolean",
          "description": "Await the result if it is a Promise (default true)."
        },
        "args": {
          "type": "array",
          "description": "Positional JSON-serializable arguments to pass to the expression, treating it as a function. No live element/page handle is bound."
        },
        "savePath": {
          "type": "string",
          "description": "Write the evaluated value to this file as JSON and KEEP IT OUT OF THE RESPONSE: with savePath set the result is {path,bytes,type,target} only, with no copy, preview or truncation of the value. Use it to read credentials without putting them in a transcript. An absolute path (starting with /) is used as-is; a relative path is resolved under the artifact dir (/tmp/cdp-toolkit). Missing parent directories are created. Omit it to get the value back inline, exactly as before."
        }
      },
      "required": [
        "expression"
      ],
      "additionalProperties": false
    }
  },
  {
    "name": "list_cookies",
    "description": "Read the cookie store for the target page, INCLUDING httpOnly cookies, which document.cookie cannot see and an evaluate_script call therefore cannot reach. Each cookie carries name, value, domain, path, expires (Unix seconds, -1 for a session cookie), size, httpOnly, secure, sameSite ('strict'|'lax'|'none'|'default') and session. The read is page-scoped, not browser-wide: it returns the cookies of the resolved tab (Chrome: Network.getCookies; Firefox: storage.getCookies partitioned by that browsing context), so point at a page on the site whose cookies you want. Filter with 'domain' and/or 'name'. Pass 'savePath' to write the cookie array to a JSON file instead: the response is then {path,bytes,count,target} only, with no cookie value in it in any form, which is how to capture a session cookie without putting the credential in the caller's transcript.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "lease": {
          "type": "string",
          "description": "Opaque lease token from claim_page. Omit it for a tab this process already holds: under CDP_REQUIRE_LEASE the gate acquires a lease automatically and one acquired that way passes for any later call from the same process. Required when the tab is held by ANOTHER process, and required for a tab claimed explicitly via claim_page or new_page{claim:true}, which always demands its own token. Without CDP_REQUIRE_LEASE an unleased tab needs no token at all."
        },
        "target": {
          "type": "string",
          "description": "Target page selector: 'active' (default) | '<targetId>' | 'index:N' | 'url:<substring>' | 'title:<substring>'."
        },
        "domain": {
          "type": "string",
          "description": "Keep only cookies for this domain. A leading dot is ignored on both sides and subdomains of the given domain match too, so 'example.test' matches '.example.test' and 'app.example.test'. No wildcards."
        },
        "name": {
          "type": "string",
          "description": "Keep only the cookie with exactly this name. Exact match, not a substring."
        },
        "savePath": {
          "type": "string",
          "description": "Write the cookie array to this file as JSON and KEEP THE VALUES OUT OF THE RESPONSE: with savePath set the result is {path,bytes,count,target} only, with no copy, preview or truncation of any cookie value. An absolute path (starting with /) is used as-is; a relative path is resolved under the artifact dir (/tmp/cdp-toolkit). Missing parent directories are created. Omit it to get the cookies back inline."
        }
      },
      "required": [],
      "additionalProperties": false
    }
  },
  {
    "name": "set_cookie",
    "description": "Write one cookie into the target page's cookie store, INCLUDING an httpOnly or secure cookie, which document.cookie cannot create and an evaluate_script call therefore cannot either. Chrome uses Network.setCookie, Firefox uses storage.setCookie partitioned by the resolved browsing context. Either 'url' or 'domain' is REQUIRED: a cookie has to be attributed to a site and the call is refused with an error when neither is given, rather than guessing the current page's origin. The response is {set:true,target} and never echoes the value back, so a credential you just supplied does not land in the transcript twice. A 'set:true' is earned, not assumed: Chrome answers Network.setCookie with success:false when it declines a cookie (a domain the url does not belong to, a secure cookie on an insecure origin, an oversized value) and that refusal is raised as an error. On Firefox, 'domain' is derived from 'url' when only the url was given, because BiDi has no url parameter; a url with no host, such as about:blank or a data URL, is an error rather than a silent no-op. Read the result back with list_cookies when you need proof.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "lease": {
          "type": "string",
          "description": "Opaque lease token from claim_page. Omit it for a tab this process already holds: under CDP_REQUIRE_LEASE the gate acquires a lease automatically and one acquired that way passes for any later call from the same process. Required when the tab is held by ANOTHER process, and required for a tab claimed explicitly via claim_page or new_page{claim:true}, which always demands its own token. Without CDP_REQUIRE_LEASE an unleased tab needs no token at all."
        },
        "target": {
          "type": "string",
          "description": "Target page selector: 'active' (default) | '<targetId>' | 'index:N' | 'url:<substring>' | 'title:<substring>'."
        },
        "name": {
          "type": "string",
          "description": "Cookie name. Required and non-empty."
        },
        "value": {
          "type": "string",
          "description": "Cookie value. Required. It is not echoed back in the response."
        },
        "url": {
          "type": "string",
          "description": "The URL the cookie is set for, for example 'https://example.com/'. Chrome derives domain, path and secure from it. Firefox derives only the domain from its host. Give this or 'domain'."
        },
        "domain": {
          "type": "string",
          "description": "Cookie domain, for example 'example.com' or '.example.com' for subdomains. Give this or 'url'. When both are given, this wins on Firefox and Chrome applies its own url plus domain consistency rule."
        },
        "path": {
          "type": "string",
          "description": "Cookie path. Passed through exactly as given and NOT defaulted to '/': with a 'url' Chrome derives the path from it, so an invented default here would widen a cookie you meant to scope narrowly."
        },
        "expires": {
          "type": "number",
          "description": "Expiry as Unix time in SECONDS, matching what list_cookies reports. Omit it for a session cookie, which is what both backends do when no expiry is supplied."
        },
        "httpOnly": {
          "type": "boolean",
          "description": "Set the httpOnly flag, making the cookie invisible to document.cookie. Only a protocol write like this one can create such a cookie."
        },
        "secure": {
          "type": "boolean",
          "description": "Set the secure flag. Chrome declines a secure cookie on an insecure origin, and that refusal surfaces as an error."
        },
        "sameSite": {
          "type": "string",
          "enum": ["strict", "lax", "none", "default"],
          "description": "SameSite attribute, lowercase, matching what list_cookies reports. 'default' means the attribute is not set at all."
        }
      },
      "required": ["name", "value"],
      "additionalProperties": false
    }
  },
  {
    "name": "delete_cookies",
    "description": "Delete the named cookie from the target page's cookie store, httpOnly cookies included. Chrome uses Network.deleteCookies, Firefox uses storage.deleteCookies with a filter, partitioned by the resolved browsing context. Both 'name' and one of 'url' or 'domain' are REQUIRED: without a site constraint the call would delete by name across the whole partition, so it is refused with an error instead. Narrow further with 'path'. The response is {deleted:true,target} and carries NO count, because neither protocol reports how many cookies it removed and a number here would be invented; call list_cookies before and after when you need a real count. 'deleted:true' means the backend accepted and performed the deletion, not that a matching cookie existed, since deleting an absent cookie is a success on both backends.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "lease": {
          "type": "string",
          "description": "Opaque lease token from claim_page. Omit it for a tab this process already holds: under CDP_REQUIRE_LEASE the gate acquires a lease automatically and one acquired that way passes for any later call from the same process. Required when the tab is held by ANOTHER process, and required for a tab claimed explicitly via claim_page or new_page{claim:true}, which always demands its own token. Without CDP_REQUIRE_LEASE an unleased tab needs no token at all."
        },
        "target": {
          "type": "string",
          "description": "Target page selector: 'active' (default) | '<targetId>' | 'index:N' | 'url:<substring>' | 'title:<substring>'."
        },
        "name": {
          "type": "string",
          "description": "Exact cookie name to delete. Required and non-empty. No wildcards: this removes a named cookie, not a swathe of them."
        },
        "url": {
          "type": "string",
          "description": "Delete cookies matching this URL, for example 'https://example.com/'. Give this or 'domain'. On Firefox only the host is used, because BiDi's filter has no url field."
        },
        "domain": {
          "type": "string",
          "description": "Delete cookies with this exact domain. Give this or 'url'."
        },
        "path": {
          "type": "string",
          "description": "Narrow the deletion to cookies with this exact path. Omit to match any path allowed by the other constraints."
        }
      },
      "required": ["name"],
      "additionalProperties": false
    }
  },
  {
    "name": "take_snapshot",
    "description": "Capture the page's accessibility tree (Accessibility.getFullAXTree) as a compact indented text tree where each line is prefixed with [uid], the node's CDP backendDOMNodeId. These uids are the stateless element references that every interaction tool (click/hover/fill/etc.) feeds back to resolve a live DOM node (via DOM.resolveNode({ backendNodeId: uid })), so run this first to discover uids.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "lease": {
          "type": "string",
          "description": "Opaque lease token from claim_page. Omit it for a tab this process already holds: under CDP_REQUIRE_LEASE the gate acquires a lease automatically and one acquired that way passes for any later call from the same process. Required when the tab is held by ANOTHER process, and required for a tab claimed explicitly via claim_page or new_page{claim:true}, which always demands its own token. Without CDP_REQUIRE_LEASE an unleased tab needs no token at all."
        },
        "target": {
          "type": "string",
          "description": "Target page selector: 'active' (default, = first page-type target) | 'index:N' (Nth page-type target, 0-based) | 'url:<substring>' | 'title:<substring>' | '<32-hex targetId>' (exact target by id)."
        },
        "interactiveOnly": {
          "type": "boolean",
          "description": "When true, emit only interactive/meaningful nodes flattened into a readable list; default false returns the full hierarchical a11y tree."
        }
      },
      "required": [],
      "additionalProperties": false
    }
  },
  {
    "name": "click",
    "description": "Click an element via a synthetic mouse press/release at the element's scrolled-into-view bounding-rect center. Target the element with exactly one of 'uid' (a CDP backendDOMNodeId from take_snapshot) or 'selector' (a CSS selector). clickCount:3 triple-clicks (selects a paragraph/line in most editors). 'modifiers' holds Alt/Control/Meta/Shift for the press and release, like a real modifier-click; on the Firefox backend a non-empty 'modifiers' throws (not yet supported over BiDi), so a modifier click there needs --browser chrome.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "lease": {
          "type": "string",
          "description": "Opaque lease token from claim_page. Omit it for a tab this process already holds: under CDP_REQUIRE_LEASE the gate acquires a lease automatically and one acquired that way passes for any later call from the same process. Required when the tab is held by ANOTHER process, and required for a tab claimed explicitly via claim_page or new_page{claim:true}, which always demands its own token. Without CDP_REQUIRE_LEASE an unleased tab needs no token at all."
        },
        "target": {
          "type": "string",
          "description": "Target page selector: 'active' (default) | 'index:N' | 'url:<substr>' | 'title:<substr>' | '<targetId>'."
        },
        "uid": {
          "type": "number",
          "description": "CDP backendDOMNodeId of the element to click, obtained from take_snapshot. Provide exactly one of uid or selector."
        },
        "selector": {
          "type": "string",
          "description": "CSS selector for the element to click (resolved via document.querySelector). Provide exactly one of uid or selector."
        },
        "button": {
          "type": "string",
          "enum": [
            "left",
            "right",
            "middle"
          ],
          "description": "Mouse button: 'left' (default), 'right', or 'middle'."
        },
        "clickCount": {
          "type": "number",
          "description": "Number of clicks: 1 = single (default), 2 = double-click, 3 = triple-click."
        },
        "modifiers": {
          "type": "array",
          "items": {
            "type": "string",
            "enum": [
              "Alt",
              "Control",
              "Meta",
              "Shift"
            ]
          },
          "description": "Modifier keys held for the click's press and release, e.g. ['Shift'] for a shift-click. Not supported on the Firefox backend: passing a non-empty array there throws."
        }
      },
      "required": [],
      "additionalProperties": false
    }
  },
  {
    "name": "hover",
    "description": "Hover the mouse over an element by dispatching a mouseMoved event at its scrolled-into-view center, firing framework hover handlers. Target with exactly one of 'uid' (a CDP backendDOMNodeId from take_snapshot) or 'selector' (a CSS selector).",
    "inputSchema": {
      "type": "object",
      "properties": {
        "lease": {
          "type": "string",
          "description": "Opaque lease token from claim_page. Omit it for a tab this process already holds: under CDP_REQUIRE_LEASE the gate acquires a lease automatically and one acquired that way passes for any later call from the same process. Required when the tab is held by ANOTHER process, and required for a tab claimed explicitly via claim_page or new_page{claim:true}, which always demands its own token. Without CDP_REQUIRE_LEASE an unleased tab needs no token at all."
        },
        "target": {
          "type": "string",
          "description": "Target page selector: 'active' (default) | 'index:N' | 'url:<substr>' | 'title:<substr>' | '<targetId>'."
        },
        "uid": {
          "type": "number",
          "description": "CDP backendDOMNodeId of the element to hover, obtained from take_snapshot. Provide exactly one of uid or selector."
        },
        "selector": {
          "type": "string",
          "description": "CSS selector for the element to hover (resolved via document.querySelector). Provide exactly one of uid or selector."
        }
      },
      "required": [],
      "additionalProperties": false
    }
  },
  {
    "name": "drag",
    "description": "Drag from a source element to a destination. 'from' takes exactly one of uid (a CDP backendDOMNodeId from take_snapshot) or selector. The destination is exactly one of 'to' (an element via uid/selector, or an absolute viewport point via x+y) or 'by' ({dx,dy} offset from the source point — sliders, map panning, resize handles). mode:'mouse' (default) dispatches synthetic mouse press/move/release: right for widgets built on raw pointer events, and Chrome does turn it into a real drag, but WHICH drag events reach the page depends on where the interpolated pointer path happens to land — measured on Chrome 151, the default steps:2 delivers ZERO dragover events, so an HTML5 drop zone written the standard way (preventDefault inside dragover) refuses the drop entirely. mode:'html5' performs the drag deterministically instead: Chrome's drag interception hands back the DragData the page's own dragstart built, and the toolkit replays it as dragEnter/dragOver/drop exactly at the destination, so a draggable=\"true\" / dataTransfer drop zone works regardless of the pointer path. mode:'html5' is CHROME-ONLY: it requires capability 'input.html5Drag' and is rejected with a clear error under the Firefox backend, where the tool itself remains available for mouse-mode drags. 'steps' (default 2) sets how many interpolated mouse-move events are dispatched between source and destination; raise it for DnD libraries with a movement threshold or per-frame sampling.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "lease": {
          "type": "string",
          "description": "Opaque lease token from claim_page. Omit it for a tab this process already holds: under CDP_REQUIRE_LEASE the gate acquires a lease automatically and one acquired that way passes for any later call from the same process. Required when the tab is held by ANOTHER process, and required for a tab claimed explicitly via claim_page or new_page{claim:true}, which always demands its own token. Without CDP_REQUIRE_LEASE an unleased tab needs no token at all."
        },
        "target": {
          "type": "string",
          "description": "Target page selector: 'active' (default) | 'index:N' | 'url:<substr>' | 'title:<substr>' | '<targetId>'."
        },
        "from": {
          "type": "object",
          "description": "Source element to drag from. Provide exactly one of uid or selector.",
          "properties": {
            "uid": {
              "type": "number",
              "description": "CDP backendDOMNodeId of the source element, obtained from take_snapshot."
            },
            "selector": {
              "type": "string",
              "description": "CSS selector for the source element (resolved via document.querySelector)."
            }
          },
          "additionalProperties": false
        },
        "to": {
          "type": "object",
          "description": "Where the drag ends: exactly one of uid, selector, or x+y. Mutually exclusive with 'by'; exactly one of to/by is required.",
          "properties": {
            "uid": {
              "type": "number",
              "description": "CDP backendDOMNodeId of the destination element, obtained from take_snapshot."
            },
            "selector": {
              "type": "string",
              "description": "CSS selector for the destination element (resolved via document.querySelector)."
            },
            "x": {
              "type": "number",
              "description": "Absolute viewport x-coordinate to drop at. Must be given together with 'y'. Use this when there is no droppable element to name (a canvas, a slider track)."
            },
            "y": {
              "type": "number",
              "description": "Absolute viewport y-coordinate to drop at. Must be given together with 'x'."
            }
          },
          "additionalProperties": false
        },
        "by": {
          "type": "object",
          "description": "Drag by an offset from the source element's center instead of to a destination: at least one of dx/dy, the other defaults to 0. Mutually exclusive with 'to'; exactly one of to/by is required. Use for sliders (by:{dx:40}), map panning, and resize handles.",
          "properties": {
            "dx": {
              "type": "number",
              "description": "Horizontal offset in CSS pixels; positive drags RIGHT."
            },
            "dy": {
              "type": "number",
              "description": "Vertical offset in CSS pixels; positive drags DOWN."
            }
          },
          "additionalProperties": false
        },
        "mode": {
          "type": "string",
          "enum": [
            "mouse",
            "html5"
          ],
          "description": "'mouse' (default): synthetic mouse press/move/release, right for widgets built on raw pointer events. Chrome does turn this into a real HTML5 drag too, but WHICH drag events reach the page depends on the interpolated pointer path: at the default steps:2, an HTML5 drop zone written the standard way (preventDefault inside dragover) sees zero dragover events and refuses the drop. 'html5': real HTML5 drag-and-drop (dragstart/dragEnter/dragOver/drop with the page's own dataTransfer), deterministic regardless of pointer path. 'html5' is CHROME-ONLY and is rejected with a clear error under the Firefox backend."
        },
        "steps": {
          "type": "number",
          "description": "Number of interpolated mouse-move events dispatched between the source and destination points, evenly spaced, the last landing exactly on the destination. Integer 1-500, default 2 (midpoint then destination). Raise it for DnD libraries with a movement threshold or per-frame sampling."
        }
      },
      "required": [
        "from"
      ],
      "additionalProperties": false
    }
  },
  {
    "name": "scroll",
    "description": "Dispatch a wheel/scroll event at an anchor point: provide at most one of 'uid', 'selector', or 'x'+'y'; omit all three to scroll at the viewport center. An element anchor ('uid' or 'selector') is scrolled into view first, the same as click/hover. At least one of 'deltaX'/'deltaY' is required; positive 'deltaY' scrolls DOWN and positive 'deltaX' scrolls RIGHT (wheel-event convention). Chrome dispatches Input.dispatchMouseEvent{type:'mouseWheel'}; Firefox dispatches WebDriver BiDi's 'wheel' input source. Returns the resolved anchor point ({x,y}) plus the delta actually dispatched.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "lease": {
          "type": "string",
          "description": "Opaque lease token from claim_page. Omit it for a tab this process already holds: under CDP_REQUIRE_LEASE the gate acquires a lease automatically and one acquired that way passes for any later call from the same process. Required when the tab is held by ANOTHER process, and required for a tab claimed explicitly via claim_page or new_page{claim:true}, which always demands its own token. Without CDP_REQUIRE_LEASE an unleased tab needs no token at all."
        },
        "target": {
          "type": "string",
          "description": "Target page selector: 'active' (default) | 'index:N' | 'url:<substr>' | 'title:<substr>' | '<targetId>'."
        },
        "uid": {
          "type": "number",
          "description": "CDP backendDOMNodeId of the element to scroll into view and anchor at, obtained from take_snapshot. Provide at most one of uid, selector, or x+y; omit all three to scroll at the viewport center."
        },
        "selector": {
          "type": "string",
          "description": "CSS selector for the element to scroll into view and anchor at (resolved via document.querySelector). Provide at most one of uid, selector, or x+y; omit all three to scroll at the viewport center."
        },
        "x": {
          "type": "number",
          "description": "Absolute viewport x-coordinate to anchor the scroll at. Must be given together with 'y'. Provide at most one of uid, selector, or x+y."
        },
        "y": {
          "type": "number",
          "description": "Absolute viewport y-coordinate to anchor the scroll at. Must be given together with 'x'. Provide at most one of uid, selector, or x+y."
        },
        "deltaX": {
          "type": "number",
          "description": "Horizontal scroll delta; positive scrolls RIGHT. At least one of deltaX/deltaY is required."
        },
        "deltaY": {
          "type": "number",
          "description": "Vertical scroll delta; positive scrolls DOWN. At least one of deltaX/deltaY is required."
        }
      },
      "required": [],
      "additionalProperties": false
    }
  },
  {
    "name": "dispatch_mouse",
    "description": "Dispatch exactly one raw mouse event ('move', 'down', or 'up') at absolute viewport coordinates: the toolkit's lowest-level input primitive. Compose move/down/move/up calls yourself to reach anything a physical mouse can do that click/drag's fixed sequences cannot — canvas drag-painting, marquee/rubber-band selection, a custom widget with its own hit-testing. Chrome-only (capability 'input.raw'): absent from tools/list under the Firefox backend, never present-and-throwing.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "lease": {
          "type": "string",
          "description": "Opaque lease token from claim_page. Omit it for a tab this process already holds: under CDP_REQUIRE_LEASE the gate acquires a lease automatically and one acquired that way passes for any later call from the same process. Required when the tab is held by ANOTHER process, and required for a tab claimed explicitly via claim_page or new_page{claim:true}, which always demands its own token. Without CDP_REQUIRE_LEASE an unleased tab needs no token at all."
        },
        "target": {
          "type": "string",
          "description": "Target page selector: 'active' (default) | 'index:N' | 'url:<substr>' | 'title:<substr>' | '<targetId>'."
        },
        "action": {
          "type": "string",
          "enum": [
            "move",
            "down",
            "up"
          ],
          "description": "Which raw event to dispatch: 'move' (mouseMoved), 'down' (mousePressed), or 'up' (mouseReleased)."
        },
        "x": {
          "type": "number",
          "description": "Viewport x-coordinate. Required on every call: CDP has no notion of a 'current pointer position' to default from."
        },
        "y": {
          "type": "number",
          "description": "Viewport y-coordinate. Required on every call."
        },
        "button": {
          "type": "string",
          "enum": [
            "left",
            "right",
            "middle"
          ],
          "description": "Mouse button: 'left' (default), 'right', or 'middle'."
        },
        "clickCount": {
          "type": "number",
          "description": "Click-run length for a 'down' or 'up' event (2 = the second half of a double-click, 3 = triple-click). Ignored for 'move'; defaults to 1."
        },
        "modifiers": {
          "type": "array",
          "items": {
            "type": "string",
            "enum": [
              "Alt",
              "Control",
              "Meta",
              "Shift"
            ]
          },
          "description": "Modifier keys held for this one event, e.g. ['Shift']."
        }
      },
      "required": [
        "action",
        "x",
        "y"
      ],
      "additionalProperties": false
    }
  },
  {
    "name": "wait_for_download",
    "description": "Wait for a file download to finish and return it as a real file on disk: {path,suggestedFilename,bytes,url,target}. The file is written under the artifact dir's downloads/ folder and renamed from Chrome's internal guid to the page's own filename, collision-suffixed (report.csv, report-1.csv, ...). ORDERING RULE, and it is not optional: download capture must be ARMED BEFORE the click that starts the download — call wait_for_download{arm:true} first (it arms and returns immediately, reporting {armed:true,downloadPath,pending}), then click, then call wait_for_download to collect the finished file. This is Chrome's behavior, not a preference: the download-behavior override is per-connection state that Chrome REVERTS the moment the arming client disconnects, and an unarmed headless Chrome denies the download outright, so a download triggered before anything armed is lost with no file anywhere. SIDE EFFECT, browser-global: arming redirects EVERY download in this browser (all tabs, all origins) into the toolkit's downloads directory for as long as this server runs, and downloads no longer land in the user's normal Downloads folder. Because the arm lives on a connection this server process holds open, this is an MCP-server capability: under the one-shot CLI the connection dies with the process and nothing is captured. Chrome-only (capability 'browser.downloads'): absent from tools/list under the Firefox backend, never present-and-throwing, because WebDriver BiDi has no command to redirect a download to a chosen directory.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "lease": {
          "type": "string",
          "description": "Opaque lease token from claim_page. Omit it for a tab this process already holds: under CDP_REQUIRE_LEASE the gate acquires a lease automatically and one acquired that way passes for any later call from the same process. Required when the tab is held by ANOTHER process, and required for a tab claimed explicitly via claim_page or new_page{claim:true}, which always demands its own token. Without CDP_REQUIRE_LEASE an unleased tab needs no token at all."
        },
        "target": {
          "type": "string",
          "description": "Target page selector: 'active' (default) | 'index:N' | 'url:<substr>' | 'title:<substr>' | '<targetId>'. A download is browser-scoped, so this names the tab for the lease check and for the echoed target, not which download is returned."
        },
        "arm": {
          "type": "boolean",
          "description": "Arm download capture and return immediately instead of waiting: {armed:true,downloadPath,pending}. Call this BEFORE the click that triggers the download. 'pending' counts downloads that already completed and have not been collected yet, so an arm call doubles as a peek."
        },
        "timeoutMs": {
          "type": "number",
          "description": "How long to wait for a download to complete, in milliseconds. Default 30000. Ignored with arm:true. A download that already completed and was not yet collected is returned immediately, so this only bounds the wait for a download still in flight."
        }
      },
      "required": [],
      "additionalProperties": false
    }
  },
  {
    "name": "grant_permissions",
    "description": "Grant browser permissions for an origin up front, so a page asking for geolocation / notifications / clipboard gets an answer instead of showing a prompt no agent can click. 'permissions' takes CDP PermissionType values ('geolocation', 'notifications', 'clipboardReadWrite', 'camera', 'microphone', 'midi', ...); an unknown name is refused by Chrome with the bad value in the message. Returns {granted,origin,target}, or {reset:true,target} for a reset-only call. Grants are keyed by ORIGIN, not by tab: every tab on that origin is affected, including ones opened later. reset:true clears this server's previous grants first (or instead, when no permissions are given) — note CDP's reset is not origin-scoped, so it clears them for every origin at once. The grant lives on a connection this server process holds open and Chrome DISCARDS IT when that connection closes, so this is an MCP-server capability: under the one-shot CLI the grant dies with the process. Chrome-only (capability 'browser.permissions'): absent from tools/list under the Firefox backend, never present-and-throwing.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "lease": {
          "type": "string",
          "description": "Opaque lease token from claim_page. Omit it for a tab this process already holds: under CDP_REQUIRE_LEASE the gate acquires a lease automatically and one acquired that way passes for any later call from the same process. Required when the tab is held by ANOTHER process, and required for a tab claimed explicitly via claim_page or new_page{claim:true}, which always demands its own token. Without CDP_REQUIRE_LEASE an unleased tab needs no token at all."
        },
        "target": {
          "type": "string",
          "description": "Target page selector: 'active' (default) | 'index:N' | 'url:<substr>' | 'title:<substr>' | '<targetId>'. Used for the lease check and, when 'origin' is omitted, as the source of the origin to grant for."
        },
        "permissions": {
          "type": "array",
          "items": {
            "type": "string"
          },
          "description": "CDP PermissionType values to grant, e.g. ['geolocation'] or ['clipboardReadWrite','clipboardSanitizedWrite']. Required unless reset:true. An empty array is refused rather than treated as a successful no-op."
        },
        "origin": {
          "type": "string",
          "description": "Origin the grant applies to, e.g. 'https://example.com'. Defaults to the target tab's own origin. Required explicitly when that tab has no grantable origin (data:, blob:, about:blank all serialize to the opaque origin 'null'), which is refused with a message naming the tab's url."
        },
        "reset": {
          "type": "boolean",
          "description": "Clear this server's previous permission grants (Browser.resetPermissions). With 'permissions' it resets FIRST and then grants, so the result is exactly the listed permissions; on its own it is a reset-only call answering {reset:true}. Not scoped to 'origin': CDP resets every origin at once."
        }
      },
      "required": [],
      "additionalProperties": false
    }
  },
  {
    "name": "fill",
    "description": "Fill an element by focusing it, clearing existing content, then inserting 'value' via Input.insertText (atomic paste-like commit, not per-character keystrokes). Target with exactly one of 'uid' (a CDP backendDOMNodeId from take_snapshot) or 'selector' (a CSS selector).",
    "inputSchema": {
      "type": "object",
      "properties": {
        "lease": {
          "type": "string",
          "description": "Opaque lease token from claim_page. Omit it for a tab this process already holds: under CDP_REQUIRE_LEASE the gate acquires a lease automatically and one acquired that way passes for any later call from the same process. Required when the tab is held by ANOTHER process, and required for a tab claimed explicitly via claim_page or new_page{claim:true}, which always demands its own token. Without CDP_REQUIRE_LEASE an unleased tab needs no token at all."
        },
        "target": {
          "type": "string",
          "description": "Target page selector: 'active' (default) | 'index:N' | 'url:<substr>' | 'title:<substr>' | '<targetId>'."
        },
        "uid": {
          "type": "number",
          "description": "CDP backendDOMNodeId of the field to fill, obtained from take_snapshot. Provide exactly one of uid or selector."
        },
        "selector": {
          "type": "string",
          "description": "CSS selector for the field to fill (resolved via document.querySelector). Provide exactly one of uid or selector."
        },
        "value": {
          "type": "string",
          "description": "The text value to set; the field is cleared first so this overwrites existing content."
        }
      },
      "required": [
        "value"
      ],
      "additionalProperties": false
    }
  },
  {
    "name": "fill_form",
    "description": "Fill multiple form fields in one call; each field is focused, cleared, then set via Input.insertText. Each field in the non-empty 'fields' array takes exactly one of uid (a CDP backendDOMNodeId from take_snapshot) or selector, plus its string value.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "lease": {
          "type": "string",
          "description": "Opaque lease token from claim_page. Omit it for a tab this process already holds: under CDP_REQUIRE_LEASE the gate acquires a lease automatically and one acquired that way passes for any later call from the same process. Required when the tab is held by ANOTHER process, and required for a tab claimed explicitly via claim_page or new_page{claim:true}, which always demands its own token. Without CDP_REQUIRE_LEASE an unleased tab needs no token at all."
        },
        "target": {
          "type": "string",
          "description": "Target page selector: 'active' (default) | 'index:N' | 'url:<substr>' | 'title:<substr>' | '<targetId>'."
        },
        "fields": {
          "type": "array",
          "description": "Non-empty array of fields to fill, each with exactly one of uid or selector plus a string value.",
          "items": {
            "type": "object",
            "properties": {
              "uid": {
                "type": "number",
                "description": "CDP backendDOMNodeId of the field, obtained from take_snapshot. Provide exactly one of uid or selector."
              },
              "selector": {
                "type": "string",
                "description": "CSS selector for the field (resolved via document.querySelector). Provide exactly one of uid or selector."
              },
              "value": {
                "type": "string",
                "description": "The text value to set; the field is cleared first so this overwrites existing content."
              }
            },
            "required": [
              "value"
            ],
            "additionalProperties": false
          }
        }
      },
      "required": [
        "fields"
      ],
      "additionalProperties": false
    }
  },
  {
    "name": "type_text",
    "description": "Focus an element and append 'text' via Input.insertText without clearing first (closest to typing). Target with exactly one of 'uid' (a CDP backendDOMNodeId from take_snapshot) or 'selector' (a CSS selector).",
    "inputSchema": {
      "type": "object",
      "properties": {
        "lease": {
          "type": "string",
          "description": "Opaque lease token from claim_page. Omit it for a tab this process already holds: under CDP_REQUIRE_LEASE the gate acquires a lease automatically and one acquired that way passes for any later call from the same process. Required when the tab is held by ANOTHER process, and required for a tab claimed explicitly via claim_page or new_page{claim:true}, which always demands its own token. Without CDP_REQUIRE_LEASE an unleased tab needs no token at all."
        },
        "target": {
          "type": "string",
          "description": "Target page selector: 'active' (default) | 'index:N' | 'url:<substr>' | 'title:<substr>' | '<targetId>'."
        },
        "uid": {
          "type": "number",
          "description": "CDP backendDOMNodeId of the element to type into, obtained from take_snapshot. Provide exactly one of uid or selector."
        },
        "selector": {
          "type": "string",
          "description": "CSS selector for the element to type into (resolved via document.querySelector). Provide exactly one of uid or selector."
        },
        "text": {
          "type": "string",
          "description": "The text to insert; appended to existing content rather than overwriting it."
        }
      },
      "required": [
        "text"
      ],
      "additionalProperties": false
    }
  },
  {
    "name": "press_key",
    "description": "Dispatch a keyDown/keyUp pair for a single key with optional modifiers. 'key' is a named key (Enter, Tab, Escape, ArrowDown, Backspace, etc.) or a single printable character; the named-key table is curated (no F-keys/numpad/IME).",
    "inputSchema": {
      "type": "object",
      "properties": {
        "lease": {
          "type": "string",
          "description": "Opaque lease token from claim_page. Omit it for a tab this process already holds: under CDP_REQUIRE_LEASE the gate acquires a lease automatically and one acquired that way passes for any later call from the same process. Required when the tab is held by ANOTHER process, and required for a tab claimed explicitly via claim_page or new_page{claim:true}, which always demands its own token. Without CDP_REQUIRE_LEASE an unleased tab needs no token at all."
        },
        "target": {
          "type": "string",
          "description": "Target page selector: 'active' (default) | 'index:N' | 'url:<substr>' | 'title:<substr>' | '<targetId>'."
        },
        "key": {
          "type": "string",
          "description": "Key to press: a named key like 'Enter', 'Tab', 'Escape', 'ArrowDown', 'Backspace', or a single printable character. Required."
        },
        "modifiers": {
          "type": "array",
          "description": "Optional modifier names held during the press: 'Control'/'Ctrl', 'Shift', 'Alt', 'Meta'/'Cmd'.",
          "items": {
            "type": "string"
          }
        }
      },
      "required": [
        "key"
      ],
      "additionalProperties": false
    }
  },
  {
    "name": "upload_file",
    "description": "Attach one or more files to an <input type=file> element via DOM.setFileInputFiles. Target the input with exactly one of 'uid' (a CDP backendDOMNodeId from take_snapshot) or 'selector'; 'files' is an absolute path or array of absolute paths.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "lease": {
          "type": "string",
          "description": "Opaque lease token from claim_page. Omit it for a tab this process already holds: under CDP_REQUIRE_LEASE the gate acquires a lease automatically and one acquired that way passes for any later call from the same process. Required when the tab is held by ANOTHER process, and required for a tab claimed explicitly via claim_page or new_page{claim:true}, which always demands its own token. Without CDP_REQUIRE_LEASE an unleased tab needs no token at all."
        },
        "target": {
          "type": "string",
          "description": "Target page selector: 'active' (default) | 'index:N' | 'url:<substr>' | 'title:<substr>' | '<targetId>'."
        },
        "uid": {
          "type": "number",
          "description": "CDP backendDOMNodeId of the file input element, obtained from take_snapshot. Provide exactly one of uid or selector."
        },
        "selector": {
          "type": "string",
          "description": "CSS selector for the file input element (resolved via document.querySelector). Provide exactly one of uid or selector."
        },
        "files": {
          "type": [
            "string",
            "array"
          ],
          "items": {
            "type": "string"
          },
          "description": "Absolute path, or array of absolute paths, to the file(s) to attach to the <input type=file>. Accepts a single string or an array of strings."
        }
      },
      "required": [
        "files"
      ],
      "additionalProperties": false
    }
  },
  {
    "name": "take_screenshot",
    "description": "Capture the viewport (default), the full scrollable page (fullPage), or a single element (uid or selector, exactly one and mutually exclusive) via raw CDP Page.captureScreenshot. Writes a PNG/JPEG under /tmp/cdp-toolkit (override with savePath) and returns {path,bytes,format,target}; raw base64 is only included when returnBase64 is set. quality applies to jpeg only.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "lease": {
          "type": "string",
          "description": "Opaque lease token from claim_page. Omit it for a tab this process already holds: under CDP_REQUIRE_LEASE the gate acquires a lease automatically and one acquired that way passes for any later call from the same process. Required when the tab is held by ANOTHER process, and required for a tab claimed explicitly via claim_page or new_page{claim:true}, which always demands its own token. Without CDP_REQUIRE_LEASE an unleased tab needs no token at all."
        },
        "target": {
          "type": "string",
          "description": "Target page selector. undefined or 'active' -> first page target; '<32-hex targetId>' -> exact target by id; 'index:N' -> Nth page target (0-based); 'url:<substring>' -> first page whose url contains substring; 'title:<substring>' -> first page whose title contains substring."
        },
        "format": {
          "type": "string",
          "enum": [
            "png",
            "jpeg"
          ],
          "description": "Image format. Defaults to png. quality applies only to jpeg."
        },
        "quality": {
          "type": "number",
          "description": "JPEG quality 0-100 (default 80). Ignored for png."
        },
        "fullPage": {
          "type": "boolean",
          "description": "Capture the full scrollable content height computed from Page.getLayoutMetrics, not just the viewport."
        },
        "uid": {
          "type": "number",
          "description": "Element to clip to: a CDP backendDOMNodeId obtained from take_snapshot. Mutually exclusive with selector."
        },
        "selector": {
          "type": "string",
          "description": "CSS selector to clip the capture to. Mutually exclusive with uid."
        },
        "savePath": {
          "type": "string",
          "description": "Override the output file path. Default: /tmp/cdp-toolkit/screenshot-<id>-<stamp>.<ext>."
        },
        "returnBase64": {
          "type": "boolean",
          "description": "Also return the raw base64 image bytes in the result, in addition to writing the file."
        }
      },
      "required": [],
      "additionalProperties": false
    }
  },
  {
    "name": "emulate",
    "description": "Apply any subset of Chrome emulation overrides in one call: device metrics (width/height together, plus deviceScaleFactor/mobile), userAgent, cpuThrottlingRate (>=1), emulated media type + mediaFeatures, and networkConditions. Pass clearOverrides:true to reset every override to the browser default (ignores all other fields). Non-metrics overrides are session-scoped and reset when the per-call connection closes; device-metrics overrides persist on the target until cleared or the renderer navigates/reloads.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "lease": {
          "type": "string",
          "description": "Opaque lease token from claim_page. Omit it for a tab this process already holds: under CDP_REQUIRE_LEASE the gate acquires a lease automatically and one acquired that way passes for any later call from the same process. Required when the tab is held by ANOTHER process, and required for a tab claimed explicitly via claim_page or new_page{claim:true}, which always demands its own token. Without CDP_REQUIRE_LEASE an unleased tab needs no token at all."
        },
        "target": {
          "type": "string",
          "description": "Target page selector: 'active' (default) | 'index:N' | 'url:<substr>' | 'title:<substr>' | '<targetId>'."
        },
        "width": {
          "type": "number",
          "description": "Device-metrics viewport width in CSS pixels. Must be supplied together with height."
        },
        "height": {
          "type": "number",
          "description": "Device-metrics viewport height in CSS pixels. Must be supplied together with width."
        },
        "deviceScaleFactor": {
          "type": "number",
          "description": "Device pixel ratio (DPR) for the device-metrics override; 0 uses the platform default."
        },
        "mobile": {
          "type": "boolean",
          "description": "Whether to emulate a mobile device (affects viewport meta handling, scrollbars, etc.) for the device-metrics override."
        },
        "userAgent": {
          "type": "string",
          "description": "User-Agent string to override via Emulation.setUserAgentOverride."
        },
        "cpuThrottlingRate": {
          "type": "number",
          "description": "CPU throttling multiplier: 1 = no throttle, 2 = 2x slower, etc. Must be >= 1."
        },
        "media": {
          "type": "string",
          "description": "Emulated CSS media type: 'screen' | 'print' | '' (clear)."
        },
        "mediaFeatures": {
          "type": "array",
          "description": "Emulated media features, e.g. [{ name: 'prefers-color-scheme', value: 'dark' }].",
          "items": {
            "type": "object",
            "properties": {
              "name": {
                "type": "string",
                "description": "Media feature name, e.g. 'prefers-color-scheme'."
              },
              "value": {
                "type": "string",
                "description": "Media feature value, e.g. 'dark'."
              }
            },
            "required": [
              "name",
              "value"
            ],
            "additionalProperties": false
          }
        },
        "networkConditions": {
          "type": "object",
          "description": "Network condition overrides applied via Network.emulateNetworkConditions.",
          "properties": {
            "offline": {
              "type": "boolean",
              "description": "True to simulate offline."
            },
            "latency": {
              "type": "number",
              "description": "Additional round-trip latency in milliseconds."
            },
            "downloadThroughput": {
              "type": "number",
              "description": "Max download throughput in bytes/sec (-1 = no limit)."
            },
            "uploadThroughput": {
              "type": "number",
              "description": "Max upload throughput in bytes/sec (-1 = no limit)."
            },
            "connectionType": {
              "type": "string",
              "description": "Connection type: 'none' | 'cellular2g' | 'cellular3g' | 'cellular4g' | 'bluetooth' | 'ethernet' | 'wifi' | 'wimax' | 'other'."
            }
          },
          "additionalProperties": false
        },
        "clearOverrides": {
          "type": "boolean",
          "description": "Reset every override (device metrics, UA, CPU, media, network) to the browser default; ignores all other fields when true."
        }
      },
      "required": [],
      "additionalProperties": false
    }
  },
  {
    "name": "resize_page",
    "description": "Set the page's device-metrics width/height (the narrow case of emulate), optionally with deviceScaleFactor and mobile, then verify by reading back window.innerWidth/innerHeight after the override is applied. Requires positive numeric width and height. The device-metrics override persists on the target until cleared or the renderer navigates/reloads.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "lease": {
          "type": "string",
          "description": "Opaque lease token from claim_page. Omit it for a tab this process already holds: under CDP_REQUIRE_LEASE the gate acquires a lease automatically and one acquired that way passes for any later call from the same process. Required when the tab is held by ANOTHER process, and required for a tab claimed explicitly via claim_page or new_page{claim:true}, which always demands its own token. Without CDP_REQUIRE_LEASE an unleased tab needs no token at all."
        },
        "target": {
          "type": "string",
          "description": "Target page selector: 'active' (default) | 'index:N' | 'url:<substr>' | 'title:<substr>' | '<targetId>'."
        },
        "width": {
          "type": "number",
          "description": "Viewport width in CSS pixels (must be positive)."
        },
        "height": {
          "type": "number",
          "description": "Viewport height in CSS pixels (must be positive)."
        },
        "deviceScaleFactor": {
          "type": "number",
          "description": "Device pixel ratio (DPR); 0 uses the platform default."
        },
        "mobile": {
          "type": "boolean",
          "description": "Whether to emulate a mobile device for the device-metrics override."
        }
      },
      "required": [
        "width",
        "height"
      ],
      "additionalProperties": false
    }
  },
  {
    "name": "handle_dialog",
    "description": "Wait for the next JavaScript dialog (alert/confirm/prompt/beforeunload) on a page and respond via Page.handleJavaScriptDialog, accepting or dismissing it. Default mode resolves with the first handled dialog or throws on timeout; set autoMs to handle every dialog opening during a fixed window and resolve with the list. The dialog must be triggered out-of-band (e.g. by clicking a button), since a blocking dialog freezes the renderer.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "lease": {
          "type": "string",
          "description": "Opaque lease token from claim_page. Omit it for a tab this process already holds: under CDP_REQUIRE_LEASE the gate acquires a lease automatically and one acquired that way passes for any later call from the same process. Required when the tab is held by ANOTHER process, and required for a tab claimed explicitly via claim_page or new_page{claim:true}, which always demands its own token. Without CDP_REQUIRE_LEASE an unleased tab needs no token at all."
        },
        "target": {
          "type": "string",
          "description": "Target page selector: 'active' (or omitted) for the first page-type target | 'index:N' (0-based) | 'url:<substring>' | 'title:<substring>' | a 32-hex <targetId>."
        },
        "accept": {
          "type": "boolean",
          "description": "Whether to accept (OK) or dismiss (Cancel) the dialog."
        },
        "promptText": {
          "type": "string",
          "description": "Text to enter for a prompt() dialog when accepting."
        },
        "timeoutMs": {
          "type": "number",
          "description": "How long to wait for the next dialog in milliseconds (default 15000)."
        },
        "autoMs": {
          "type": "number",
          "description": "Auto-handle mode: keep handling every dialog that opens for this many milliseconds, then resolve with the list of handled dialogs (an empty list is valid; never throws on 'no dialog')."
        }
      },
      "required": [
        "accept"
      ],
      "additionalProperties": false
    }
  },
  {
    "name": "list_console_messages",
    "description": "Read console output (logs, warnings, exceptions) captured for the target page. By default reads the target's existing shared buffer and returns parsed console entries (empty if no capture has run); with reload:true it reloads the page and records a fresh capture window (both console+network) so a network reload never wipes console history.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "lease": {
          "type": "string",
          "description": "Opaque lease token from claim_page. Omit it for a tab this process already holds: under CDP_REQUIRE_LEASE the gate acquires a lease automatically and one acquired that way passes for any later call from the same process. Required when the tab is held by ANOTHER process, and required for a tab claimed explicitly via claim_page or new_page{claim:true}, which always demands its own token. Without CDP_REQUIRE_LEASE an unleased tab needs no token at all."
        },
        "target": {
          "type": "string",
          "description": "Target page selector: 'active' (default) | '<targetId>' | 'index:N' | 'url:<substring>' | 'title:<substring>'."
        },
        "reload": {
          "type": "boolean",
          "description": "Record fresh by reloading the page and capturing for a window. Default false (read the existing buffer)."
        },
        "durationMs": {
          "type": "number",
          "description": "Capture window for reload mode, in milliseconds. Default 2500."
        }
      },
      "required": [],
      "additionalProperties": false
    }
  },
  {
    "name": "get_console_message",
    "description": "Return a single console entry by zero-based index from the target's existing console buffer. Throws if the index is out of range; run list_console_messages (optionally with reload:true) first to populate the buffer.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "lease": {
          "type": "string",
          "description": "Opaque lease token from claim_page. Omit it for a tab this process already holds: under CDP_REQUIRE_LEASE the gate acquires a lease automatically and one acquired that way passes for any later call from the same process. Required when the tab is held by ANOTHER process, and required for a tab claimed explicitly via claim_page or new_page{claim:true}, which always demands its own token. Without CDP_REQUIRE_LEASE an unleased tab needs no token at all."
        },
        "target": {
          "type": "string",
          "description": "Target page selector: 'active' (default) | '<targetId>' | 'index:N' | 'url:<substring>' | 'title:<substring>'."
        },
        "index": {
          "type": "number",
          "description": "Zero-based index into the parsed console entries. Default 0."
        }
      },
      "required": [],
      "additionalProperties": false
    }
  },
  {
    "name": "list_network_requests",
    "description": "Return correlated network request rows (one per requestId, with status/headers/state) for the target page. By default reads the target's existing buffer; with reload:true it reloads and records a fresh both-domains capture window. Use filterUrl to keep only requests whose URL contains a substring.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "lease": {
          "type": "string",
          "description": "Opaque lease token from claim_page. Omit it for a tab this process already holds: under CDP_REQUIRE_LEASE the gate acquires a lease automatically and one acquired that way passes for any later call from the same process. Required when the tab is held by ANOTHER process, and required for a tab claimed explicitly via claim_page or new_page{claim:true}, which always demands its own token. Without CDP_REQUIRE_LEASE an unleased tab needs no token at all."
        },
        "target": {
          "type": "string",
          "description": "Target page selector: 'active' (default) | '<targetId>' | 'index:N' | 'url:<substring>' | 'title:<substring>'."
        },
        "reload": {
          "type": "boolean",
          "description": "Record fresh by reloading the page and capturing for a window. Default false (read the existing buffer)."
        },
        "durationMs": {
          "type": "number",
          "description": "Capture window for reload mode, in milliseconds. Default 2500."
        },
        "filterUrl": {
          "type": "string",
          "description": "Only return requests whose URL contains this substring."
        }
      },
      "required": [],
      "additionalProperties": false
    }
  },
  {
    "name": "get_network_request",
    "description": "Return one network request (matched by exact requestId, else by url substring) including status/headers. Requires at least one of requestId or url (throws otherwise). With includeBody:true the body fetch drives a fresh reload capture and is matched by url ONLY (reload re-mints requestIds, so a carried-over requestId cannot fetch a body, so it returns metadata plus bodyUnavailableReason).",
    "inputSchema": {
      "type": "object",
      "properties": {
        "lease": {
          "type": "string",
          "description": "Opaque lease token from claim_page. Omit it for a tab this process already holds: under CDP_REQUIRE_LEASE the gate acquires a lease automatically and one acquired that way passes for any later call from the same process. Required when the tab is held by ANOTHER process, and required for a tab claimed explicitly via claim_page or new_page{claim:true}, which always demands its own token. Without CDP_REQUIRE_LEASE an unleased tab needs no token at all."
        },
        "target": {
          "type": "string",
          "description": "Target page selector: 'active' (default) | '<targetId>' | 'index:N' | 'url:<substring>' | 'title:<substring>'."
        },
        "requestId": {
          "type": "string",
          "description": "Match by exact requestId (metadata only, cannot fetch a body, since reload re-mints requestIds)."
        },
        "url": {
          "type": "string",
          "description": "Match by URL substring (first match). Required for body fetch (includeBody), since url is stable across reload."
        },
        "includeBody": {
          "type": "boolean",
          "description": "Also fetch the response body; drives a fresh reload capture and must be used with the `url` selector."
        },
        "durationMs": {
          "type": "number",
          "description": "Capture window for the reload-driven body fetch, in milliseconds. Default 2500."
        }
      },
      "required": [],
      "additionalProperties": false
    }
  },
  {
    "name": "performance_start_trace",
    "description": "Start a performance trace on the target page over raw CDP (Tracing.start) and park the recording connection in-process. Must be paired with performance_stop_trace WITHIN THE SAME PROCESS; for a robust cross-call trace use performance_trace instead. Throws if a trace is already in progress for the target.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "lease": {
          "type": "string",
          "description": "Opaque lease token from claim_page. Omit it for a tab this process already holds: under CDP_REQUIRE_LEASE the gate acquires a lease automatically and one acquired that way passes for any later call from the same process. Required when the tab is held by ANOTHER process, and required for a tab claimed explicitly via claim_page or new_page{claim:true}, which always demands its own token. Without CDP_REQUIRE_LEASE an unleased tab needs no token at all."
        },
        "target": {
          "type": "string",
          "description": "Target page selector: 'active' (default) | 'index:N' | 'url:<substr>' | 'title:<substr>' | '<targetId>'."
        },
        "categories": {
          "type": "array",
          "items": {
            "type": "string"
          },
          "description": "Trace categories to include. Defaults to the timeline + user-timing + loading + disabled-by-default timeline tracks that carry LCP/LayoutShift/RunTask."
        }
      },
      "required": [],
      "additionalProperties": false
    }
  },
  {
    "name": "performance_stop_trace",
    "description": "Stop the in-process trace started by performance_start_trace, drain buffered Tracing.dataCollected events, write the trace JSON under /tmp/cdp-toolkit, and return {path,bytes,events,metrics}. Throws if no live trace exists in this process (e.g. start ran in a different process); use performance_trace instead. The 'target' arg is accepted only for API symmetry; at most one trace is ever live per process.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "lease": {
          "type": "string",
          "description": "Opaque lease token from claim_page. Omit it for a tab this process already holds: under CDP_REQUIRE_LEASE the gate acquires a lease automatically and one acquired that way passes for any later call from the same process. Required when the tab is held by ANOTHER process, and required for a tab claimed explicitly via claim_page or new_page{claim:true}, which always demands its own token. Without CDP_REQUIRE_LEASE an unleased tab needs no token at all."
        },
        "target": {
          "type": "string",
          "description": "Target page selector: 'active' (default) | 'index:N' | 'url:<substr>' | 'title:<substr>' | '<targetId>'."
        }
      },
      "required": [],
      "additionalProperties": false
    }
  },
  {
    "name": "performance_analyze_insight",
    "description": "CDP-native approximation of the DevTools insight analyzer: read a trace JSON file (bare array or {traceEvents:[...]}) at the given tracePath and return headline metrics (FCP/LCP/CLS/TBT, long tasks, layout shifts). Requires an explicit tracePath returned by performance_trace/performance_stop_trace; there is no implicit 'latest trace'. Numbers approximate DevTools (no main-thread attribution or frame-scoped LCP).",
    "inputSchema": {
      "type": "object",
      "properties": {
        "lease": {
          "type": "string",
          "description": "Opaque lease token from claim_page. Omit it for a tab this process already holds: under CDP_REQUIRE_LEASE the gate acquires a lease automatically and one acquired that way passes for any later call from the same process. Required when the tab is held by ANOTHER process, and required for a tab claimed explicitly via claim_page or new_page{claim:true}, which always demands its own token. Without CDP_REQUIRE_LEASE an unleased tab needs no token at all."
        },
        "tracePath": {
          "type": "string",
          "description": "Filesystem path to a trace JSON file written by performance_trace or performance_stop_trace (bare array OR {traceEvents:[...]}). Required."
        }
      },
      "required": [],
      "additionalProperties": false
    }
  },
  {
    "name": "performance_trace",
    "description": "PRIMARY one-shot trace: start tracing, optionally reload or navigate the page, wait durationMs (default 3000), end the trace, write the trace JSON under /tmp/cdp-toolkit, and return {path,bytes,events,metrics,target}. Holds one connection open for the whole window, so it is immune to the cross-process limitation of start/stop, and it is the recommended entry point.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "lease": {
          "type": "string",
          "description": "Opaque lease token from claim_page. Omit it for a tab this process already holds: under CDP_REQUIRE_LEASE the gate acquires a lease automatically and one acquired that way passes for any later call from the same process. Required when the tab is held by ANOTHER process, and required for a tab claimed explicitly via claim_page or new_page{claim:true}, which always demands its own token. Without CDP_REQUIRE_LEASE an unleased tab needs no token at all."
        },
        "target": {
          "type": "string",
          "description": "Target page selector: 'active' (default) | 'index:N' | 'url:<substr>' | 'title:<substr>' | '<targetId>'."
        },
        "durationMs": {
          "type": "number",
          "description": "How long to record after the optional reload/navigate, in milliseconds. Default 3000."
        },
        "reload": {
          "type": "boolean",
          "description": "Reload the page after starting the trace to capture full navigation timing."
        },
        "navigateTo": {
          "type": "string",
          "description": "Navigate to this URL after starting the trace (alternative to reload)."
        },
        "categories": {
          "type": "array",
          "items": {
            "type": "string"
          },
          "description": "Trace categories to include. Defaults to the timeline + user-timing + loading + disabled-by-default timeline tracks that carry LCP/LayoutShift/RunTask."
        }
      },
      "required": [],
      "additionalProperties": false
    }
  },
  {
    "name": "start_screen_recording",
    "description": "Start recording the target tab to video over raw CDP (Page.startScreencast), holding one persistent connection open and spooling every Page.screencastFrame to disk. Chrome emits a frame ON REPAINT, not on a clock, so the stream is variable-rate: each frame is timestamped into a ledger and stop_screen_recording turns those timestamps into per-frame display durations, which is what makes a still page hold one long frame instead of the video racing or freezing. Every frame is acked immediately (an unacked frame stalls the stream). ffmpeg is probed here, not at stop, so a missing encoder fails before a recording is captured and thrown away. Must be paired with stop_screen_recording WITHIN THE SAME PROCESS (the frames are events on this connection and cannot be re-attached from another process, so the pair works under the MCP server, not the one-process-per-call CLI). Throws if a recording is already in progress for the target; recordings on DIFFERENT targets run concurrently. Chrome only: WebDriver BiDi has no screencast primitive, so both tools are absent under --browser firefox.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "lease": {
          "type": "string",
          "description": "Opaque lease token from claim_page. Omit it for a tab this process already holds: under CDP_REQUIRE_LEASE the gate acquires a lease automatically and one acquired that way passes for any later call from the same process. Required when the tab is held by ANOTHER process, and required for a tab claimed explicitly via claim_page or new_page{claim:true}, which always demands its own token. Without CDP_REQUIRE_LEASE an unleased tab needs no token at all."
        },
        "target": {
          "type": "string",
          "description": "Target page selector: 'active' (default) | 'index:N' | 'url:<substr>' | 'title:<substr>' | '<targetId>'."
        },
        "format": {
          "type": "string",
          "enum": [
            "jpeg",
            "png"
          ],
          "description": "Frame image format. Defaults to jpeg (far smaller per repaint); png is lossless. quality applies to jpeg only."
        },
        "quality": {
          "type": "number",
          "description": "JPEG frame quality 0-100. Ignored for png. Omitted by default, which leaves Chrome's own default in place."
        },
        "maxWidth": {
          "type": "number",
          "description": "Cap the streamed frame width in pixels. Also the way to pin frame size if the viewport might change mid-recording."
        },
        "maxHeight": {
          "type": "number",
          "description": "Cap the streamed frame height in pixels."
        },
        "everyNthFrame": {
          "type": "number",
          "description": "Capture only every Nth repaint (1 = every frame). Reduces spool size on a busy page; per-frame durations keep playback at wallclock speed either way."
        },
        "bringToFront": {
          "type": "boolean",
          "description": "Activate the tab (Page.bringToFront) before recording. Default false. A fully backgrounded or occluded tab may never repaint, and a recording of one captures 0 frames."
        }
      },
      "required": [],
      "additionalProperties": false
    }
  },
  {
    "name": "stop_screen_recording",
    "description": "Stop the recording started by start_screen_recording, assemble the spooled frames into an MP4 with ffmpeg using PER-FRAME durations from the ledger (frame N is held until frame N+1 painted; the last frame is held until this call), and return {path,bytes,durationMs,frameCount,encodedFrames,codec,encoder,width,height,droppedFrames,target}. Encoder ladder, probed once at start: hevc_videotoolbox then h264_videotoolbox then libx265 then libx264, with -tag:v hvc1 on HEVC so QuickTime plays it, +faststart, yuv420p, and even dimensions forced. With one recording in flight 'target' may be omitted; with several it is required, because guessing which to stop can lose another agent's recording. Throws if nothing is recording in this process, and throws rather than writing a silent empty video when 0 frames arrived. On an ffmpeg failure the spooled frames are KEPT and the spool path plus the exact command are named in the error. Encoded video tops out at 25 fps: ffmpeg's concat demuxer represents image timestamps on a 1/25s grid, so frames captured less than 40ms apart are coalesced deliberately (frameCount reports what was captured, encodedFrames what reached the video) instead of being dropped silently by ffmpeg. durationMs is the sum of the encoded durations; the file itself runs one 40ms step longer, because the concat demuxer needs the final frame repeated for its hold to count.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "lease": {
          "type": "string",
          "description": "Opaque lease token from claim_page. Omit it for a tab this process already holds: under CDP_REQUIRE_LEASE the gate acquires a lease automatically and one acquired that way passes for any later call from the same process. Required when the tab is held by ANOTHER process, and required for a tab claimed explicitly via claim_page or new_page{claim:true}, which always demands its own token. Without CDP_REQUIRE_LEASE an unleased tab needs no token at all."
        },
        "target": {
          "type": "string",
          "description": "Which recording to stop: 'active' (default, valid only when exactly one recording is in flight) | 'index:N' | 'url:<substr>' | 'title:<substr>' | '<targetId>'."
        },
        "savePath": {
          "type": "string",
          "description": "Override the output file path. Default: /tmp/cdp-toolkit/screen-recording-<targetIdShort>-<stamp>.mp4."
        }
      },
      "required": [],
      "additionalProperties": false
    }
  },
  {
    "name": "take_heapsnapshot",
    "description": "Capture a V8 heap snapshot of the selected page target over raw CDP (HeapProfiler.takeHeapSnapshot, accumulating addHeapSnapshotChunk events) and write it as a .heapsnapshot JSON file loadable by the DevTools Memory panel; returns {path,bytes,chunks,target} only and does not parse/summarize the snapshot. Writes under /tmp/cdp-toolkit (CDP_ARTIFACT_DIR) unless savePath is given.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "lease": {
          "type": "string",
          "description": "Opaque lease token from claim_page. Omit it for a tab this process already holds: under CDP_REQUIRE_LEASE the gate acquires a lease automatically and one acquired that way passes for any later call from the same process. Required when the tab is held by ANOTHER process, and required for a tab claimed explicitly via claim_page or new_page{claim:true}, which always demands its own token. Without CDP_REQUIRE_LEASE an unleased tab needs no token at all."
        },
        "target": {
          "type": "string",
          "description": "Target page selector: 'active' (default) | 'index:N' | 'url:<substr>' | 'title:<substr>' | '<targetId>'."
        },
        "savePath": {
          "type": "string",
          "description": "Override the output path. An absolute path (starting with /) is used as-is; a relative path is resolved under the artifact dir (/tmp/cdp-toolkit). Defaults to an auto-named take_heapsnapshot-<targetId>-<timestamp>.heapsnapshot file."
        }
      },
      "required": [],
      "additionalProperties": false
    }
  },
  {
    "name": "lighthouse_audit",
    "description": "Run a Lighthouse audit against a URL by shelling out to `npx --yes lighthouse` (the toolkit's sole non-CDP tool); Lighthouse attaches to the already-running Chrome on the remote-debugging port and audits its own about:blank tab rather than any live user tab. Writes a JSON report under /tmp/cdp-toolkit and returns {path, bytes} plus per-category scores (0..1 or null).",
    "inputSchema": {
      "type": "object",
      "properties": {
        "lease": {
          "type": "string",
          "description": "Opaque lease token from claim_page. Omit it for a tab this process already holds: under CDP_REQUIRE_LEASE the gate acquires a lease automatically and one acquired that way passes for any later call from the same process. Required when the tab is held by ANOTHER process, and required for a tab claimed explicitly via claim_page or new_page{claim:true}, which always demands its own token. Without CDP_REQUIRE_LEASE an unleased tab needs no token at all."
        },
        "url": {
          "type": "string",
          "description": "The URL to audit. Required, and never points at a user tab implicitly."
        },
        "categories": {
          "type": "array",
          "items": {
            "type": "string"
          },
          "description": "Lighthouse categories to run (passed as --only-categories). Defaults to the full set, e.g. [\"performance\"] or [\"performance\",\"accessibility\",\"seo\"]."
        },
        "savePath": {
          "type": "string",
          "description": "Override the report output path; defaults to a timestamped file under /tmp/cdp-toolkit."
        },
        "formFactor": {
          "type": "string",
          "enum": [
            "desktop",
            "mobile"
          ],
          "description": "Form factor: \"desktop\" (default, uses --preset=desktop to avoid heavy mobile throttling) or \"mobile\"."
        },
        "timeoutMs": {
          "type": "number",
          "description": "Overall budget for the lighthouse process in milliseconds. Default 120000."
        }
      },
      "required": [
        "url"
      ],
      "additionalProperties": false
    }
  },
  {
    "name": "mock_request",
    "description": "Register a mock rule on a target's persistent fake-backend session (CDP Fetch domain): intercept requests whose URL matches urlPattern and fulfill them with a canned response, fail (abort) them, or continue them, optionally with fault injection (delayMs/failRate). The session survives reloads and navigations and lives until clear_mocks. Call repeatedly to mock several endpoints on the same target. Pass reload:true to apply immediately. Persistent across calls only via the MCP server (not the one-shot CLI).",
    "inputSchema": {
      "type": "object",
      "properties": {
        "lease": {
          "type": "string",
          "description": "Opaque lease token from claim_page. Omit it for a tab this process already holds: under CDP_REQUIRE_LEASE the gate acquires a lease automatically and one acquired that way passes for any later call from the same process. Required when the tab is held by ANOTHER process, and required for a tab claimed explicitly via claim_page or new_page{claim:true}, which always demands its own token. Without CDP_REQUIRE_LEASE an unleased tab needs no token at all."
        },
        "target": {
          "type": "string",
          "description": "Target selector: active | index:N | url:<substr> | title:<substr> | <targetId>. Defaults to the active page."
        },
        "urlPattern": {
          "type": "string",
          "description": "CDP Fetch urlPattern glob: '*' matches any run of characters, '?' exactly one, '\\' escapes. Only matching request URLs are paused. e.g. \"*/api/users*\"."
        },
        "action": {
          "type": "string",
          "enum": [
            "fulfill",
            "fail",
            "continue"
          ],
          "description": "What to do with a matched request. Default \"fulfill\"."
        },
        "status": {
          "type": "number",
          "description": "fulfill: HTTP status code for the canned response. Default 200."
        },
        "body": {
          "type": "string",
          "description": "fulfill: response body string (base64-encoded for CDP internally)."
        },
        "contentType": {
          "type": "string",
          "description": "fulfill: Content-Type header. Default \"application/json\"."
        },
        "headers": {
          "type": "object",
          "description": "fulfill: extra response headers (name->value); override Content-Type case-insensitively. Add \"Access-Control-Allow-Origin\" for cross-origin fetches."
        },
        "errorReason": {
          "type": "string",
          "description": "fail: CDP Network.ErrorReason, e.g. \"Failed\" (default), \"BlockedByClient\", \"ConnectionRefused\", \"TimedOut\"."
        },
        "method": {
          "type": "string",
          "description": "Only mock requests with this HTTP method (e.g. \"POST\"); other methods pass through."
        },
        "delayMs": {
          "type": "number",
          "description": "Fault injection: artificial latency in ms before responding."
        },
        "failRate": {
          "type": "number",
          "description": "Fault injection: probability 0..1 of failing a matched request regardless of action (resilience testing)."
        },
        "reload": {
          "type": "boolean",
          "description": "Reload the target after arming so the mock immediately catches traffic."
        }
      },
      "required": [
        "urlPattern"
      ],
      "additionalProperties": false
    }
  },
  {
    "name": "list_mocks",
    "description": "List active fake-backend sessions (one per target) with their rules and hit counts. Prunes sessions whose tab has closed. Use to see what is currently being mocked.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "lease": {
          "type": "string",
          "description": "Opaque lease token from claim_page. Omit it for a tab this process already holds: under CDP_REQUIRE_LEASE the gate acquires a lease automatically and one acquired that way passes for any later call from the same process. Required when the tab is held by ANOTHER process, and required for a tab claimed explicitly via claim_page or new_page{claim:true}, which always demands its own token. Without CDP_REQUIRE_LEASE an unleased tab needs no token at all."
        },
        "target": {
          "type": "string",
          "description": "Unused filter placeholder; list_mocks returns all active sessions."
        }
      },
      "required": [],
      "additionalProperties": false
    }
  },
  {
    "name": "clear_mocks",
    "description": "Tear down fake-backend sessions (Fetch.disable + close the connection). Clears the resolved target's session by default, or every active session with all:true.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "lease": {
          "type": "string",
          "description": "Opaque lease token from claim_page. Omit it for a tab this process already holds: under CDP_REQUIRE_LEASE the gate acquires a lease automatically and one acquired that way passes for any later call from the same process. Required when the tab is held by ANOTHER process, and required for a tab claimed explicitly via claim_page or new_page{claim:true}, which always demands its own token. Without CDP_REQUIRE_LEASE an unleased tab needs no token at all."
        },
        "target": {
          "type": "string",
          "description": "Target selector whose mock session to clear. Defaults to the active page. Ignored when all:true."
        },
        "all": {
          "type": "boolean",
          "description": "Clear every active mock session instead of just the resolved target's."
        }
      },
      "required": [],
      "additionalProperties": false
    }
  },
  {
    "name": "claim_page",
    "description": "Take exclusive ownership of a browser tab and return an opaque lease token. Two modes. FRESH TAB: with no target and no targetId, opens a new tab (optionally at url) and claims it, so 'give me my own tab' is one call. TAKEOVER: with target, claims a tab that is already open — this is how you work in a tab the human already has open when they ask you to, instead of opening your own — resolving any target selector against the live page list and never creating anything. The answer's 'opened' flag says which happened (true only when this call created the tab), and that same creation record is what release_page consults, so a tab you took over is left open when you release it. Any later tool call against a leased tab must carry the matching token in its 'lease' argument or it is refused, naming the holder. The lease is reclaimable once its owning process dies, its ttlMs elapses without use, or its tab is closed. Refused from the CLI: a CLI invocation is one process per call, so its lease would be reclaimable immediately. IS SOMEBODY ELSE IN THIS TAB: the answer also carries 'humanActiveMs', milliseconds since input that this server did not dispatch — i.e. since a person last clicked, typed, or scrolled here. null means NO DATA (the tab carries no activity beacon, which is normal the first time anyone claims a person's tab, or every input on it was this server's own); it never means 'no human'. The field is absent entirely on a backend that cannot answer. On a takeover of a tab a human used within the last 30 seconds the answer additionally carries 'contention', a warning string. THE CLAIM IS NEVER REFUSED FOR THIS: taking over a person's tab is what takeover mode is for, so by the time you read the warning you already hold the lease and the tab is yours to drive. It tells you that driving it now means fighting a live person for the keyboard and mouse, so you can open your own tab instead or ask first. Known limits: input inside a cross-origin iframe is invisible to it, and a second MCP server's clicks read as human to this one.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "target": {
          "type": "string",
          "description": "Take over an already-open tab, e.g. one the human has open, when asked to: pass any target selector — active | index:N | url:<substr> | title:<substr> | <targetId>. Resolved against the live page list only, so it NEVER opens a tab: a selector that matches nothing is an error, not a new blank tab. The tab is left open on release because the toolkit did not create it. Refused if another live process holds it, including a lease the gate acquired for that process automatically under CDP_REQUIRE_LEASE: this takes over unleased (human) tabs and never steals one from a live agent. Mutually exclusive with targetId."
        },
        "targetId": {
          "type": "string",
          "description": "Claim this already-open page target instead of opening a new tab. Must be an exact target id, not a selector. Kept for back-compat: prefer 'target', which accepts an exact id too plus every other selector form. Mutually exclusive with target."
        },
        "url": {
          "type": "string",
          "description": "When opening a fresh tab, navigate it here. Ignored when target or targetId is given, since both of those claim a tab that is already open."
        },
        "label": {
          "type": "string",
          "description": "Agent label recorded on the lease and surfaced in conflict errors and list_leases. Defaults to pid-<pid>."
        },
        "ttlMs": {
          "type": "number",
          "description": "How long the lease survives without use before it is reclaimable. Defaults to CDP_LEASE_TTL_MS, else 900000 (15 minutes). Every checked call refreshes it, so an active agent never expires."
        }
      },
      "required": [],
      "additionalProperties": false
    }
  },
  {
    "name": "release_page",
    "description": "Give a lease back, and close the tab if this toolkit opened it. Takes exactly one of 'lease' (the token claim_page returned) or 'target' (a selector for a tab this process holds, which is how you release a lease the gate acquired for you automatically, since that path never hands you a token). A tab with a creation record from this toolkit is closed; a tab that was already open and merely claimed is released and left alone. Override either way with 'close'. Idempotent: an already-released, reclaimed, or expired lease reports released:false, and a release that did not happen never closes anything, because by then the tab may belong to another agent. Answers {released, closed, targetId}.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "lease": {
          "type": "string",
          "description": "The opaque token claim_page (or new_page with claim:true) returned. Mutually exclusive with 'target'. Under CDP_REQUIRE_LEASE a lease the gate acquired for you automatically never produced a token in the first place, so give 'target' instead."
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
  },
  {
    "name": "list_leases",
    "description": "Enumerate every active lease for diagnosis: backend, target id, agent label, pid, createdAt, lastUsedAt, ttlMs, whether the owning process is still alive, and whether the lease is reclaimable and why. Requires no token. Never returns the lease nonce, so this cannot be used to forge a token. A row for a lease file that could not be read or parsed instead carries `unreadable` (the errno, or \"unparseable\"), with label, pid, and the timestamp fields as zero placeholders and stale always false, since stale is what marks a lease free to take and an unreadable one must never read that way. Under CDP_REQUIRE_LEASE this call reaps abandoned agent tabs exactly as list_pages does (see that tool's description for the grace period between a lease reading reclaimable and its tab actually being closed), reporting them in an additive 'reaped' array and omitting their rows from the listing. A row also carries 'humanActiveMs' — milliseconds since input this server did not dispatch, i.e. since a person last used that tab — WHERE THE TAB CAN ANSWER. The field is ABSENT rather than null when it cannot: no activity beacon on that tab, every input on it accounted for by this server, a row belonging to the other backend, a tab no longer open, or a page that would not evaluate. Absence therefore means 'no answer', never 'nobody is there'. Note that lastUsedAt measures TOOLKIT calls only, so a tab a person has been typing in for ten minutes looks perfectly idle by that field and is exactly the case humanActiveMs exists to expose. Two further fields are computed fresh on every call, never read off disk: 'idleMs' (now minus lastUsedAt) and 'expiresAt' (lastUsedAt plus ttlMs — the same value claim_page already returns under that name). Both are omitted on an 'unreadable' row, whose lastUsedAt and ttlMs are the zeroed placeholders described above.",
    "inputSchema": {
      "type": "object",
      "properties": {},
      "required": [],
      "additionalProperties": false
    }
  }
];
