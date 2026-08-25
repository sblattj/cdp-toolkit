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
    "description": "Enumerate browser page targets (GET /json/list); page-type tabs only unless all=true. Each entry carries its targetId plus an origin field: 'agent' means this toolkit created it (also carries the creating label/createdAt, and stays 'agent' after the lease is released or the creator dies, making stray agent tabs findable), 'unknown' means no creation record - it never says 'human', the honest word for any tab it did not create; a record that exists but won't read adds originUnreadable. An entry under an active, readable lease also carries a 'lease' object {label,pid,idleMs,expiresAt,stale}, with idleMs and expiresAt computed fresh every call (never off disk), independent of probe. Under CDP_REQUIRE_LEASE this call also reaps abandoned agent tabs into an additive reaped array - but a lease reads reclaimable the moment its TTL elapses, while the tab is CLOSED only after a further grace (CDP_REAP_GRACE_MS, default 2700000ms/45min, so 60min total after last use); a dead-pid lease is reaped at once, a tab with no lease never. With probe, each page-type entry also gets 'responsive' (and humanActiveMs where human input is seen); both are absent, never false/null, without probe.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "lease": {
          "type": "string",
          "description": "Lease token from claim_page. Omit for a tab this process holds; required for a tab held by another process or one claimed explicitly. Auto-acquired under CDP_REQUIRE_LEASE (then pass target, not lease). See server instructions."
        },
        "all": {
          "type": "boolean",
          "description": "Include non-page targets (service/shared workers, background pages); default false lists page-type tabs only."
        },
        "probe": {
          "type": "boolean",
          "description": "Ping each page-type renderer before returning, one bounded 500ms check per target and never more, so a wedged tab can't stall the listing. Adds 'responsive' (false on timeout/exception/unreachable, never an error for the whole call) and, where the same round trip finds human input, humanActiveMs. Default false. On a backend that cannot answer the ping, responsive is absent too (not false)."
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
          "description": "Lease token from claim_page. Omit for a tab this process holds; required for a tab held by another process or one claimed explicitly. Auto-acquired under CDP_REQUIRE_LEASE (then pass target, not lease). See server instructions."
        },
        "url": {
          "type": "string",
          "description": "URL to open in the new tab; defaults to about:blank."
        },
        "claim": {
          "type": "boolean",
          "description": "Claim the new tab atomically and return a lease token alongside {targetId,url}. Under CDP_REQUIRE_LEASE the tab is claimed and a lease returned even without claim:true; claim:true makes it an EXPLICIT lease that demands its token on every later call, even from this process. Default false."
        },
        "label": {
          "type": "string",
          "description": "Agent label recorded on the lease when the tab is claimed; surfaced in conflict errors and list_leases. Defaults to pid-<pid>."
        },
        "ttlMs": {
          "type": "number",
          "description": "How long a claimed lease survives without use before it is reclaimable. Defaults to CDP_LEASE_TTL_MS, else 900000 (15min); every checked call refreshes it. Ignored when not claiming."
        }
      },
      "required": [],
      "additionalProperties": false
    }
  },
  {
    "name": "close_page",
    "description": "Close a page target via Target.closeTarget. Requires an explicit, resolvable target; errors rather than guessing when the selector matches nothing.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "lease": {
          "type": "string",
          "description": "Lease token from claim_page. Omit for a tab this process holds; required for a tab held by another process or one claimed explicitly. Auto-acquired under CDP_REQUIRE_LEASE (then pass target, not lease). See server instructions."
        },
        "target": {
          "type": "string",
          "description": "Page selector: 'active' (default), 'index:N', 'url:<substr>', 'title:<substr>', 'label:<name>', or a 32-hex '<targetId>'. Grammar: see server instructions."
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
          "description": "Lease token from claim_page. Omit for a tab this process holds; required for a tab held by another process or one claimed explicitly. Auto-acquired under CDP_REQUIRE_LEASE (then pass target, not lease). See server instructions."
        },
        "target": {
          "type": "string",
          "description": "Page selector: 'active' (default), 'index:N', 'url:<substr>', 'title:<substr>', 'label:<name>', or a 32-hex '<targetId>'. Grammar: see server instructions."
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
          "description": "Lease token from claim_page. Omit for a tab this process holds; required for a tab held by another process or one claimed explicitly. Auto-acquired under CDP_REQUIRE_LEASE (then pass target, not lease). See server instructions."
        },
        "target": {
          "type": "string",
          "description": "Page selector: 'active' (default), 'index:N', 'url:<substr>', 'title:<substr>', 'label:<name>', or a 32-hex '<targetId>'. Grammar: see server instructions."
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
          "description": "Traverse this tab's session history instead of loading a url: 'back' and 'forward' are the browser's Back and Forward buttons. Mutually exclusive with 'url' and 'reload' — passing two of the three is refused by name, not resolved by precedence. Works on BOTH backends and waits for the same load milestone as an ordinary navigation. Going back from the first entry, or forward from the last, is an ERROR naming the direction — never a silent no-op. The result carries traversed:'back'|'forward' alongside the resulting url."
        },
        "ignoreCache": {
          "type": "boolean",
          "description": "On reload, bypass the HTTP cache (hard reload) so subresources are refetched. Ignored unless reload:true. Chrome only: Firefox's WebDriver-BiDi rejects the ignoreCache argument outright, so reload+ignoreCache on Firefox throws a clear unsupported error instead (a plain reload works). Default false."
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
    "description": "Poll the target until the substring appears in document.body.innerText (Runtime.evaluate on a fixed interval), or throw on timeout. Text-substring only -- no aria/role/selector or event variants; throws rather than returning {found:false}.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "lease": {
          "type": "string",
          "description": "Lease token from claim_page. Omit for a tab this process holds; required for a tab held by another process or one claimed explicitly. Auto-acquired under CDP_REQUIRE_LEASE (then pass target, not lease). See server instructions."
        },
        "target": {
          "type": "string",
          "description": "Page selector: 'active' (default), 'index:N', 'url:<substr>', 'title:<substr>', 'label:<name>', or a 32-hex '<targetId>'. Grammar: see server instructions."
        },
        "text": {
          "type": "string",
          "description": "Substring to wait for in document.body.innerText. Required."
        },
        "timeoutMs": {
          "type": "number",
          "description": "Total time budget in ms. Default 15000."
        },
        "pollMs": {
          "type": "number",
          "description": "Poll interval in ms. Default 250."
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
    "description": "Run arbitrary JavaScript in the target's main-world context over raw CDP and return the evaluated value (returnByValue). With no 'args', 'expression' is a raw expression; with 'args' it must be a function literal (arrow or classic) invoked on globalThis with args passed positionally. A thrown exception surfaces as an error; non-serializable returns (DOM nodes, functions) come back as their CDP description string. savePath writes the value to a JSON file instead -- the response then carries only {path,bytes,type,target} and the value never appears in it, the way to read a credential (a JWT/session token from localStorage) without putting the secret in the transcript. This is the one tool that EVALUATES inside an MV3 extension's background SERVICE WORKER rather than OBSERVING it (Chrome, Capability 'worker.targets'): a worker: target reads chrome.storage.local, chrome.runtime and the worker's own globals directly, with an idle-evicted worker started first (see 'wake').",
    "inputSchema": {
      "type": "object",
      "properties": {
        "lease": {
          "type": "string",
          "description": "Lease token from claim_page. Omit for a tab this process holds; required for a tab held by another process or one claimed explicitly. Auto-acquired under CDP_REQUIRE_LEASE (then pass target, not lease). See server instructions."
        },
        "target": {
          "type": "string",
          "description": "Page selector: 'active' (default), 'index:N', 'url:<substr>', 'title:<substr>', 'label:<name>', '<targetId>'; plus 'worker:<substring>' to reach a service/shared worker (e.g. an MV3 extension background worker). The worker: arm is CHROME-ONLY (Capability 'worker.targets'). Grammar: see server instructions."
        },
        "wake": {
          "type": "boolean",
          "description": "Worker targets only, when starting a capture. Default true: an idle-evicted MV3 service worker exists in no target listing, so it is started first (ServiceWorker.startWorker) and re-confirmed; false fails fast. Rejected on a page target, a bare target id, or a read-only call. See server instructions."
        },
        "expression": {
          "type": "string",
          "description": "JavaScript to run. Evaluated as an expression when 'args' is omitted; must be a function literal (arrow or classic) whose parameters receive 'args' when provided. REQUIRED -- the code always goes in this key, never in 'function', 'code', 'js', 'script', 'fn' or 'body'; a call using one of those is rejected with an error naming the wrong key."
        },
        "awaitPromise": {
          "type": "boolean",
          "description": "Await the result if it is a Promise. Default true."
        },
        "args": {
          "type": "array",
          "description": "Positional JSON-serializable arguments passed to the expression (treated as a function). No live element/page handle is bound."
        },
        "savePath": {
          "type": "string",
          "description": "Write the evaluated value to this file as JSON and KEEP IT OUT OF THE RESPONSE: the result is {path,bytes,type,target} only, with no copy, preview or truncation of the value -- read credentials without putting them in a transcript. An absolute path (starting with /) is used as-is; a relative path resolves under the artifact dir (/tmp/cdp-toolkit); missing parents are created. Omit to get the value back inline."
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
    "description": "Read the target page's cookie store INCLUDING httpOnly cookies, which document.cookie (and therefore evaluate_script) cannot see. Page-scoped, not browser-wide: returns cookies of the resolved tab, so point at a page on the site you want. Each cookie carries name, value, domain, path, expires (Unix seconds, -1 for a session cookie), size, httpOnly, secure, sameSite ('strict'|'lax'|'none'|'default'), session. Filter with 'domain' and/or 'name'. Pass 'savePath' to write the array to a JSON file instead: the response is then {path,bytes,count,target} with no cookie value in any form, the way to capture a session cookie without putting the credential in the transcript.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "lease": {
          "type": "string",
          "description": "Lease token from claim_page. Omit for a tab this process holds; required for a tab held by another process or one claimed explicitly. Auto-acquired under CDP_REQUIRE_LEASE (then pass target, not lease). See server instructions."
        },
        "target": {
          "type": "string",
          "description": "Page selector: 'active' (default), 'index:N', 'url:<substr>', 'title:<substr>', 'label:<name>', or a 32-hex '<targetId>'. Grammar: see server instructions."
        },
        "domain": {
          "type": "string",
          "description": "Keep only cookies for this domain. A leading dot is ignored on both sides and subdomains match too, so 'example.test' matches '.example.test' and 'app.example.test'. No wildcards."
        },
        "name": {
          "type": "string",
          "description": "Keep only the cookie with exactly this name. Exact match, not a substring."
        },
        "savePath": {
          "type": "string",
          "description": "Write the cookie array here as JSON and KEEP THE VALUES OUT OF THE RESPONSE: the result is {path,bytes,count,target} only, with no preview or truncation of any value. An absolute path (starting with /) is used as-is; a relative path resolves under the artifact dir (/tmp/cdp-toolkit); missing parents are created. Omit to get the cookies back inline."
        }
      },
      "required": [],
      "additionalProperties": false
    }
  },
  {
    "name": "set_cookie",
    "description": "Write one cookie into the target page's cookie store, INCLUDING httpOnly or secure cookies that document.cookie (and therefore evaluate_script) cannot create. Either 'url' or 'domain' is REQUIRED: the call is refused when neither is given, rather than guessing the page origin. The response is {set:true,target} and never echoes the value back. A 'set:true' is earned, not assumed: Chrome raises an error when it declines the cookie (a domain the url does not belong to, a secure cookie on an insecure origin, an oversized value). On Firefox 'domain' is derived from 'url' when only the url was given (BiDi has no url parameter), and a url with no host such as about:blank or a data URL is an error, not a silent no-op. Read the result back with list_cookies when you need proof.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "lease": {
          "type": "string",
          "description": "Lease token from claim_page. Omit for a tab this process holds; required for a tab held by another process or one claimed explicitly. Auto-acquired under CDP_REQUIRE_LEASE (then pass target, not lease). See server instructions."
        },
        "target": {
          "type": "string",
          "description": "Page selector: 'active' (default), 'index:N', 'url:<substr>', 'title:<substr>', 'label:<name>', or a 32-hex '<targetId>'. Grammar: see server instructions."
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
          "description": "URL the cookie is set for, e.g. 'https://example.com/'. Chrome derives domain, path and secure from it; Firefox derives only the domain from its host. Give this or 'domain'."
        },
        "domain": {
          "type": "string",
          "description": "Cookie domain, e.g. 'example.com' or '.example.com' for subdomains. Give this or 'url'. When both are given, this wins on Firefox and Chrome applies its own url plus domain consistency rule."
        },
        "path": {
          "type": "string",
          "description": "Cookie path, passed through exactly as given and NOT defaulted to '/': with a 'url' Chrome derives the path from it, so an invented default here would widen a cookie you meant to scope narrowly."
        },
        "expires": {
          "type": "number",
          "description": "Expiry as Unix time in SECONDS, matching what list_cookies reports. Omit for a session cookie, which is what both backends do when no expiry is supplied."
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
          "enum": [
            "strict",
            "lax",
            "none",
            "default"
          ],
          "description": "SameSite attribute, lowercase, matching what list_cookies reports. 'default' means the attribute is not set at all."
        }
      },
      "required": [
        "name",
        "value"
      ],
      "additionalProperties": false
    }
  },
  {
    "name": "delete_cookies",
    "description": "Delete the named cookie from the target page's cookie store, httpOnly cookies included. Both 'name' and one of 'url' or 'domain' are REQUIRED: without a site constraint it would delete by name across the whole partition, so it is refused with an error instead. Narrow further with 'path'. The response is {deleted:true,target} and carries NO count, because neither protocol reports how many cookies it removed and a number here would be invented; call list_cookies before and after for a real count. 'deleted:true' means the backend accepted and performed the deletion, not that a matching cookie existed, since deleting an absent cookie succeeds on both backends.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "lease": {
          "type": "string",
          "description": "Lease token from claim_page. Omit for a tab this process holds; required for a tab held by another process or one claimed explicitly. Auto-acquired under CDP_REQUIRE_LEASE (then pass target, not lease). See server instructions."
        },
        "target": {
          "type": "string",
          "description": "Page selector: 'active' (default), 'index:N', 'url:<substr>', 'title:<substr>', 'label:<name>', or a 32-hex '<targetId>'. Grammar: see server instructions."
        },
        "name": {
          "type": "string",
          "description": "Exact cookie name to delete. Required and non-empty. No wildcards: this removes a named cookie, not a swathe of them."
        },
        "url": {
          "type": "string",
          "description": "Delete cookies matching this URL, e.g. 'https://example.com/'. Give this or 'domain'. On Firefox only the host is used, because BiDi's filter has no url field."
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
      "required": [
        "name"
      ],
      "additionalProperties": false
    }
  },
  {
    "name": "take_snapshot",
    "description": "Captures the page's accessibility tree as an indented text tree, each line prefixed [uid] (a CDP backendDOMNodeId). Every interaction tool (click/hover/fill/etc.) resolves that uid via DOM.resolveNode — run this first to discover uids to act on.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "lease": {
          "type": "string",
          "description": "Lease token from claim_page. Omit for a tab this process holds; required for a tab held by another process or one claimed explicitly. Auto-acquired under CDP_REQUIRE_LEASE (then pass target, not lease). See server instructions."
        },
        "target": {
          "type": "string",
          "description": "Page selector: 'active' (default), 'index:N', 'url:<substr>', 'title:<substr>', 'label:<name>', or a 32-hex '<targetId>'. Grammar: see server instructions."
        },
        "interactiveOnly": {
          "type": "boolean",
          "description": "When true, emit only interactive/meaningful nodes as a flat list; default false returns the full hierarchical tree."
        }
      },
      "required": [],
      "additionalProperties": false
    }
  },
  {
    "name": "click",
    "description": "Click an element via a synthetic mouse press/release at its scrolled-into-view center. Give exactly one of uid or selector. modifiers (Alt/Control/Meta/Shift) throws on the Firefox backend — use --browser chrome for a modifier-click. clickCount:3 triple-clicks (selects a line/paragraph in most editors).",
    "inputSchema": {
      "type": "object",
      "properties": {
        "lease": {
          "type": "string",
          "description": "Lease token from claim_page. Omit for a tab this process holds; required for a tab held by another process or one claimed explicitly. Auto-acquired under CDP_REQUIRE_LEASE (then pass target, not lease). See server instructions."
        },
        "target": {
          "type": "string",
          "description": "Page selector: 'active' (default), 'index:N', 'url:<substr>', 'title:<substr>', 'label:<name>', or a 32-hex '<targetId>'. Grammar: see server instructions."
        },
        "uid": {
          "type": "number",
          "description": "CDP backendDOMNodeId of the element to click, from take_snapshot. Exactly one of uid or selector."
        },
        "selector": {
          "type": "string",
          "description": "CSS selector for the element to click (document.querySelector). Exactly one of uid or selector."
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
          "description": "Number of clicks: 1 (default), 2 = double-click, 3 = triple-click."
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
          "description": "Modifier keys held for the click's press and release, e.g. ['Shift']. Non-empty on the Firefox backend throws — not supported over BiDi."
        }
      },
      "required": [],
      "additionalProperties": false
    }
  },
  {
    "name": "hover",
    "description": "Hovers the mouse over an element by dispatching a mouseMoved event at its scrolled-into-view center, firing framework hover handlers. Give exactly one of uid or selector.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "lease": {
          "type": "string",
          "description": "Lease token from claim_page. Omit for a tab this process holds; required for a tab held by another process or one claimed explicitly. Auto-acquired under CDP_REQUIRE_LEASE (then pass target, not lease). See server instructions."
        },
        "target": {
          "type": "string",
          "description": "Page selector: 'active' (default), 'index:N', 'url:<substr>', 'title:<substr>', 'label:<name>', or a 32-hex '<targetId>'. Grammar: see server instructions."
        },
        "uid": {
          "type": "number",
          "description": "CDP backendDOMNodeId of the element to hover, from take_snapshot. Exactly one of uid or selector."
        },
        "selector": {
          "type": "string",
          "description": "CSS selector for the element to hover (document.querySelector). Exactly one of uid or selector."
        }
      },
      "required": [],
      "additionalProperties": false
    }
  },
  {
    "name": "drag",
    "description": "Drags from a source element to a destination or by an offset. mode:'mouse' (default) dispatches synthetic mouse press/move/release; at the default steps:2 an HTML5 drop zone (dragover preventDefault) gets ZERO dragover events and refuses the drop. mode:'html5' replays real dragstart/dragEnter/dragOver/drop with the page's own dataTransfer instead — deterministic regardless of pointer path, but CHROME-ONLY (rejected with a clear error on the Firefox backend). 'from' takes uid or selector; destination is exactly one of 'to' (uid/selector/x+y) or 'by' ({dx,dy} offset — sliders, map panning, resize handles).",
    "inputSchema": {
      "type": "object",
      "properties": {
        "lease": {
          "type": "string",
          "description": "Lease token from claim_page. Omit for a tab this process holds; required for a tab held by another process or one claimed explicitly. Auto-acquired under CDP_REQUIRE_LEASE (then pass target, not lease). See server instructions."
        },
        "target": {
          "type": "string",
          "description": "Page selector: 'active' (default), 'index:N', 'url:<substr>', 'title:<substr>', 'label:<name>', or a 32-hex '<targetId>'. Grammar: see server instructions."
        },
        "from": {
          "type": "object",
          "description": "Source element to drag from. Exactly one of uid or selector.",
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
          "description": "Where the drag ends: exactly one of uid, selector, or x+y. Mutually exclusive with 'by'; exactly one of to/by required.",
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
          "description": "Offset from the source element's center: at least one of dx/dy (other defaults to 0). Mutually exclusive with 'to'; exactly one of to/by required. For sliders (by:{dx:40}), map panning, resize handles.",
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
          "description": "'mouse' (default): synthetic mouse press/move/release — at steps:2 an HTML5 drop zone sees zero dragover events and refuses the drop. 'html5': real HTML5 drag-and-drop, deterministic regardless of pointer path, CHROME-ONLY (rejected on Firefox)."
        },
        "steps": {
          "type": "number",
          "description": "Number of interpolated mouse-move events between source and destination, evenly spaced, last landing on the destination. Integer 1-500, default 2. Raise for DnD libraries with a movement threshold or per-frame sampling."
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
    "description": "Dispatches a wheel/scroll event at an anchor point — element (uid/selector) or x+y, scrolled into view first if an element; omit all three for viewport center. At least one of deltaX/deltaY required: positive deltaY scrolls DOWN, positive deltaX scrolls RIGHT (wheel-event convention — easy to invert). Returns the resolved anchor {x,y} plus the delta actually dispatched.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "lease": {
          "type": "string",
          "description": "Lease token from claim_page. Omit for a tab this process holds; required for a tab held by another process or one claimed explicitly. Auto-acquired under CDP_REQUIRE_LEASE (then pass target, not lease). See server instructions."
        },
        "target": {
          "type": "string",
          "description": "Page selector: 'active' (default), 'index:N', 'url:<substr>', 'title:<substr>', 'label:<name>', or a 32-hex '<targetId>'. Grammar: see server instructions."
        },
        "uid": {
          "type": "number",
          "description": "CDP backendDOMNodeId of the element to scroll into view and anchor at, from take_snapshot. At most one of uid, selector, or x+y."
        },
        "selector": {
          "type": "string",
          "description": "CSS selector for the element to anchor at (document.querySelector). At most one of uid, selector, or x+y."
        },
        "x": {
          "type": "number",
          "description": "Absolute viewport x-coordinate to anchor at; must be given with y. At most one of uid, selector, or x+y."
        },
        "y": {
          "type": "number",
          "description": "Absolute viewport y-coordinate to anchor at; must be given with x. At most one of uid, selector, or x+y."
        },
        "deltaX": {
          "type": "number",
          "description": "Horizontal scroll delta; positive scrolls RIGHT. At least one of deltaX/deltaY required."
        },
        "deltaY": {
          "type": "number",
          "description": "Vertical scroll delta; positive scrolls DOWN. At least one of deltaX/deltaY required."
        }
      },
      "required": [],
      "additionalProperties": false
    }
  },
  {
    "name": "dispatch_mouse",
    "description": "Dispatches one raw mouse event (move/down/up) at absolute viewport coordinates — the toolkit's lowest-level input primitive. Compose move/down/move/up calls yourself for anything click/drag's fixed sequences can't reach: canvas drag-painting, marquee/rubber-band selection, custom hit-testing widgets. Chrome-only: absent from tools/list under the Firefox backend, never present-and-throwing.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "lease": {
          "type": "string",
          "description": "Lease token from claim_page. Omit for a tab this process holds; required for a tab held by another process or one claimed explicitly. Auto-acquired under CDP_REQUIRE_LEASE (then pass target, not lease). See server instructions."
        },
        "target": {
          "type": "string",
          "description": "Page selector: 'active' (default), 'index:N', 'url:<substr>', 'title:<substr>', 'label:<name>', or a 32-hex '<targetId>'. Grammar: see server instructions."
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
          "description": "Viewport x-coordinate. Required every call — CDP has no 'current pointer position' to default from."
        },
        "y": {
          "type": "number",
          "description": "Viewport y-coordinate. Required every call."
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
          "description": "Click-run length for a 'down' or 'up' event (2 = second half of a double-click, 3 = triple-click). Ignored for 'move'; defaults to 1."
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
    "description": "Wait for a file download to finish and return it as a real file on disk: {path,suggestedFilename,bytes,url,target}, written under the artifact dir's downloads/. ORDERING RULE, not optional: capture must be ARMED BEFORE the click that starts the download — call wait_for_download{arm:true} first (returns {armed:true,downloadPath,pending}), then click, then call again to collect the file. The download-behavior override is per-connection state Chrome REVERTS the moment the arming client disconnects, and an unarmed headless Chrome denies the download outright, so one triggered before arming is lost. SIDE EFFECT, browser-global: arming redirects EVERY download in this browser (all tabs, all origins) into the toolkit's downloads dir until this server exits — they no longer land in the user's normal Downloads folder. The arm lives on a connection this server holds open (an MCP-server capability): under the one-shot CLI the connection dies with the process and nothing is captured. Chrome-only (capability 'browser.downloads'): absent from tools/list under Firefox.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "lease": {
          "type": "string",
          "description": "Lease token from claim_page. Omit for a tab this process holds; required for a tab held by another process or one claimed explicitly. Auto-acquired under CDP_REQUIRE_LEASE (then pass target, not lease). See server instructions."
        },
        "target": {
          "type": "string",
          "description": "Names the tab for the lease check and the echoed target — a download is browser-scoped, so this does not pick which download is returned. Grammar: server instructions."
        },
        "arm": {
          "type": "boolean",
          "description": "Arm download capture and return immediately instead of waiting: {armed:true,downloadPath,pending}. Call this BEFORE the click that triggers the download. 'pending' counts downloads that already completed and have not been collected yet, so an arm call doubles as a peek."
        },
        "timeoutMs": {
          "type": "number",
          "description": "How long to wait for a download to complete, in milliseconds. Default 30000. Ignored with arm:true. A download that already completed and was not yet collected is returned immediately, so this only bounds the wait for one still in flight."
        }
      },
      "required": [],
      "additionalProperties": false
    }
  },
  {
    "name": "grant_permissions",
    "description": "Grant browser permissions for an origin up front, so a page asking for geolocation / notifications / clipboard gets an answer instead of a prompt no agent can click. 'permissions' takes CDP PermissionType values ('geolocation','notifications','clipboardReadWrite','camera',...); an unknown name is refused by Chrome, quoting the bad value. Returns {granted,origin,target}, or {reset:true,target} for a reset-only call. Grants are keyed by ORIGIN, not by tab: every tab on that origin is affected, including ones opened later. reset:true clears this server's previous grants first (or instead, when no permissions are given) — CDP's reset is not origin-scoped, so it clears them for every origin at once. The grant lives on a connection this server holds open and Chrome DISCARDS IT when that connection closes: an MCP-server capability, so under the one-shot CLI the grant dies with the process. Chrome-only (capability 'browser.permissions'): absent from tools/list under Firefox, never present-and-throwing.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "lease": {
          "type": "string",
          "description": "Lease token from claim_page. Omit for a tab this process holds; required for a tab held by another process or one claimed explicitly. Auto-acquired under CDP_REQUIRE_LEASE (then pass target, not lease). See server instructions."
        },
        "target": {
          "type": "string",
          "description": "Also the origin source when 'origin' is omitted. Grammar: server instructions."
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
    "description": "Fills an element by focusing it, clearing existing content, then inserting value via Input.insertText (atomic paste-like commit, not per-character keystrokes — won't fire per-keypress handlers). Give exactly one of uid or selector.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "lease": {
          "type": "string",
          "description": "Lease token from claim_page. Omit for a tab this process holds; required for a tab held by another process or one claimed explicitly. Auto-acquired under CDP_REQUIRE_LEASE (then pass target, not lease). See server instructions."
        },
        "target": {
          "type": "string",
          "description": "Page selector: 'active' (default), 'index:N', 'url:<substr>', 'title:<substr>', 'label:<name>', or a 32-hex '<targetId>'. Grammar: see server instructions."
        },
        "uid": {
          "type": "number",
          "description": "CDP backendDOMNodeId of the field to fill, from take_snapshot. Exactly one of uid or selector."
        },
        "selector": {
          "type": "string",
          "description": "CSS selector for the field to fill (document.querySelector). Exactly one of uid or selector."
        },
        "value": {
          "type": "string",
          "description": "Text value to set; the field is cleared first, overwriting existing content."
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
    "description": "Fills multiple form fields in one call; each is focused, cleared, then set via Input.insertText (overwrites existing content, same as fill). Each entry in the non-empty 'fields' array takes exactly one of uid or selector plus a string value.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "lease": {
          "type": "string",
          "description": "Lease token from claim_page. Omit for a tab this process holds; required for a tab held by another process or one claimed explicitly. Auto-acquired under CDP_REQUIRE_LEASE (then pass target, not lease). See server instructions."
        },
        "target": {
          "type": "string",
          "description": "Page selector: 'active' (default), 'index:N', 'url:<substr>', 'title:<substr>', 'label:<name>', or a 32-hex '<targetId>'. Grammar: see server instructions."
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
    "description": "Focuses an element and appends text via Input.insertText without clearing first — closest primitive to typing, but still atomic (not per-character keystrokes). Give exactly one of uid or selector.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "lease": {
          "type": "string",
          "description": "Lease token from claim_page. Omit for a tab this process holds; required for a tab held by another process or one claimed explicitly. Auto-acquired under CDP_REQUIRE_LEASE (then pass target, not lease). See server instructions."
        },
        "target": {
          "type": "string",
          "description": "Page selector: 'active' (default), 'index:N', 'url:<substr>', 'title:<substr>', 'label:<name>', or a 32-hex '<targetId>'. Grammar: see server instructions."
        },
        "uid": {
          "type": "number",
          "description": "CDP backendDOMNodeId of the element to type into, from take_snapshot. Exactly one of uid or selector."
        },
        "selector": {
          "type": "string",
          "description": "CSS selector for the element to type into (document.querySelector). Exactly one of uid or selector."
        },
        "text": {
          "type": "string",
          "description": "Text to insert; appended to existing content rather than overwriting it."
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
    "description": "Dispatches a keyDown/keyUp pair for one key with optional modifiers. 'key' is a named key (Enter, Tab, Escape, ArrowDown, Backspace, etc.) or a single printable character — the named-key table is curated, with no F-keys, numpad, or IME support.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "lease": {
          "type": "string",
          "description": "Lease token from claim_page. Omit for a tab this process holds; required for a tab held by another process or one claimed explicitly. Auto-acquired under CDP_REQUIRE_LEASE (then pass target, not lease). See server instructions."
        },
        "target": {
          "type": "string",
          "description": "Page selector: 'active' (default), 'index:N', 'url:<substr>', 'title:<substr>', 'label:<name>', or a 32-hex '<targetId>'. Grammar: see server instructions."
        },
        "key": {
          "type": "string",
          "description": "Key to press: a named key (Enter, Tab, Escape, ArrowDown, Backspace, ...) or a single printable character."
        },
        "modifiers": {
          "type": "array",
          "description": "Modifier names held during the press: 'Control'/'Ctrl', 'Shift', 'Alt', 'Meta'/'Cmd'.",
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
    "description": "Attaches one or more files to an <input type=file> element via DOM.setFileInputFiles. Give exactly one of uid or selector for the input; 'files' is an array of absolute path(s) — wrap a single path in an array too.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "lease": {
          "type": "string",
          "description": "Lease token from claim_page. Omit for a tab this process holds; required for a tab held by another process or one claimed explicitly. Auto-acquired under CDP_REQUIRE_LEASE (then pass target, not lease). See server instructions."
        },
        "target": {
          "type": "string",
          "description": "Page selector: 'active' (default), 'index:N', 'url:<substr>', 'title:<substr>', 'label:<name>', or a 32-hex '<targetId>'. Grammar: see server instructions."
        },
        "uid": {
          "type": "number",
          "description": "CDP backendDOMNodeId of the file input element, from take_snapshot. Exactly one of uid or selector."
        },
        "selector": {
          "type": "string",
          "description": "CSS selector for the file input element (document.querySelector). Exactly one of uid or selector."
        },
        "files": {
          "type": "array",
          "items": {
            "type": "string"
          },
          "description": "Absolute path(s) to attach to the <input type=file>, as an array — wrap a single path too, e.g. [\"/tmp/a.pdf\"]. Array-only because some model APIs (Google Gemini function calling) reject union-typed parameters."
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
    "description": "Captures the viewport (default), the full scrollable page (fullPage), or one element (uid or selector, mutually exclusive) via CDP Page.captureScreenshot. Past 16384 device px per side Chrome can hang rather than refuse, so size is checked first via Page.getLayoutMetrics; an oversized capture is auto-tiled into vertical bands stitched losslessly into one PNG (see tile) instead of wedging the tab. Writes PNG/JPEG to /tmp/cdp-toolkit (override savePath, dir auto-created); returns {path,bytes,format,target,scale} plus width/height measured from the encoded bytes (omitted if undecodable). renderSize/renderRestored(+renderRestoreError) accompany a renderWidth/renderHeight capture, tiled/bands a banded one. returnBase64 adds raw bytes to the result but is refused on a banded capture. quality applies to jpeg only.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "lease": {
          "type": "string",
          "description": "Lease token from claim_page. Omit for a tab this process holds; required for a tab held by another process or one claimed explicitly. Auto-acquired under CDP_REQUIRE_LEASE (then pass target, not lease). See server instructions."
        },
        "target": {
          "type": "string",
          "description": "Page selector: 'active' (default), 'index:N', 'url:<substr>', 'title:<substr>', 'label:<name>', or a 32-hex '<targetId>'. Grammar: see server instructions."
        },
        "format": {
          "type": "string",
          "enum": [
            "png",
            "jpeg"
          ],
          "description": "Image format, default png. quality applies only to jpeg."
        },
        "quality": {
          "type": "number",
          "description": "JPEG quality 0-100, default 80; ignored for png."
        },
        "fullPage": {
          "type": "boolean",
          "description": "Capture the full scrollable height (via Page.getLayoutMetrics), not just the viewport."
        },
        "scale": {
          "type": "number",
          "description": "Output-pixel multiplier for this capture only (0<scale<=8, default 1): output px = ceil(css px x scale x devicePixelRatio); the page is never told anything changed. Chrome only (screenshot.scale) — Firefox BiDi has no scale param, use emulate{deviceScaleFactor} then scale:1. A projection over 16384 device px/side is refused up front, naming the largest scale that fits."
        },
        "renderWidth": {
          "type": "number",
          "description": "Emulates this viewport width (CSS px, 1-16384) for one capture, then restores it. Required with renderHeight. Unlike scale, this changes what the page believes (media queries re-flow) — e.g. capture a responsive page at 1920x1080 from a differently-sized tab. Restore only works for an override this toolkit itself set; check result.renderRestored (false = still emulated, fix via emulate). Works on both backends (capability screenshot.renderSize)."
        },
        "renderHeight": {
          "type": "number",
          "description": "Emulates this viewport height (CSS px, 1-16384) for one capture. Required with renderWidth — a viewport is two numbers. A narrow renderWidth often reflows pages TALLER, which is the usual way a render-size capture trips the 16384px encode limit."
        },
        "tile": {
          "type": "boolean",
          "description": "Whether to allow vertical-band stitching: omitted=AUTO (band only if a single shot wouldn't fit), false=never band (refuse instead), true=always band (Chrome-only capability). Banded output is PNG-only, can't returnBase64, and only bands on HEIGHT (oversized WIDTH is refused, not split). Bands are a faithful crop, but lazy/virtualized content the real viewport never scrolled to renders blank."
        },
        "uid": {
          "type": "number",
          "description": "Element to clip to: a backendDOMNodeId from take_snapshot. Mutually exclusive with selector."
        },
        "selector": {
          "type": "string",
          "description": "CSS selector to clip the capture to. Mutually exclusive with uid."
        },
        "savePath": {
          "type": "string",
          "description": "Override the output path (default /tmp/cdp-toolkit/screenshot-<id>-<stamp>.<ext>, stamped at capture START). Directory is created from this path's dirname."
        },
        "returnBase64": {
          "type": "boolean",
          "description": "Also return raw base64 bytes in the result. Refused on a banded capture (see tile) — a stitched image can run to hundreds of MB; read the file at the returned path instead."
        }
      },
      "required": [],
      "additionalProperties": false
    }
  },
  {
    "name": "emulate",
    "description": "Applies any subset of Chrome emulation overrides in one call: device metrics (width+height together, +deviceScaleFactor/mobile), userAgent, cpuThrottlingRate(>=1), media type+features, networkConditions. Device-metrics overrides PERSIST on the target until cleared or the renderer navigates/reloads; every other override is session-scoped and resets when this call's connection closes. clearOverrides:true resets everything (ignoring other fields) and, as of 1.9.2, genuinely clears a device-metrics override set by a DIFFERENT process — Chrome's clearDeviceMetricsOverride is normally a no-op unless the clearing connection also set the override, so the driver re-asserts the tab's current size first, then clears, throwing rather than reporting cleared:true if it can't verify.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "lease": {
          "type": "string",
          "description": "Lease token from claim_page. Omit for a tab this process holds; required for a tab held by another process or one claimed explicitly. Auto-acquired under CDP_REQUIRE_LEASE (then pass target, not lease). See server instructions."
        },
        "target": {
          "type": "string",
          "description": "Page selector: 'active' (default), 'index:N', 'url:<substr>', 'title:<substr>', 'label:<name>', or a 32-hex '<targetId>'. Grammar: see server instructions."
        },
        "width": {
          "type": "number",
          "description": "Device-metrics viewport width in CSS px. Must be paired with height."
        },
        "height": {
          "type": "number",
          "description": "Device-metrics viewport height in CSS px. Must be paired with width."
        },
        "deviceScaleFactor": {
          "type": "number",
          "description": "Device pixel ratio for the device-metrics override; 0 = platform default."
        },
        "mobile": {
          "type": "boolean",
          "description": "Emulate a mobile device (viewport meta, scrollbars, etc.) for the device-metrics override."
        },
        "userAgent": {
          "type": "string",
          "description": "User-Agent string override (Emulation.setUserAgentOverride)."
        },
        "cpuThrottlingRate": {
          "type": "number",
          "description": "CPU throttling multiplier: 1=none, 2=2x slower, etc. Must be >=1."
        },
        "media": {
          "type": "string",
          "description": "Emulated CSS media type: 'screen' | 'print' | '' (clear)."
        },
        "mediaFeatures": {
          "type": "array",
          "description": "Emulated media features, e.g. [{name:'prefers-color-scheme', value:'dark'}].",
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
          "description": "Network overrides applied via Network.emulateNetworkConditions.",
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
          "description": "Reset every override (metrics, UA, CPU, media, network) to browser default; ignores all other fields when true."
        }
      },
      "required": [],
      "additionalProperties": false
    }
  },
  {
    "name": "resize_page",
    "description": "Sets the page's device-metrics width/height (the narrow case of emulate), optionally deviceScaleFactor/mobile, then verifies by reading back window.innerWidth/innerHeight after applying. Requires positive width and height. The override PERSISTS on the target until cleared (emulate{clearOverrides:true}) or the renderer navigates/reloads.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "lease": {
          "type": "string",
          "description": "Lease token from claim_page. Omit for a tab this process holds; required for a tab held by another process or one claimed explicitly. Auto-acquired under CDP_REQUIRE_LEASE (then pass target, not lease). See server instructions."
        },
        "target": {
          "type": "string",
          "description": "Page selector: 'active' (default), 'index:N', 'url:<substr>', 'title:<substr>', 'label:<name>', or a 32-hex '<targetId>'. Grammar: see server instructions."
        },
        "width": {
          "type": "number",
          "description": "Viewport width in CSS px (required, must be positive)."
        },
        "height": {
          "type": "number",
          "description": "Viewport height in CSS px (required, must be positive)."
        },
        "deviceScaleFactor": {
          "type": "number",
          "description": "Device pixel ratio; 0 = platform default."
        },
        "mobile": {
          "type": "boolean",
          "description": "Emulate a mobile device for the device-metrics override."
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
    "description": "Wait for the next JavaScript dialog (alert/confirm/prompt/beforeunload) on a page and respond via Page.handleJavaScriptDialog, accepting or dismissing it. Default mode resolves with the first handled dialog or throws on timeout; set autoMs to handle every dialog opening during a fixed window and resolve with the list. Trigger the dialog out-of-band (e.g. click a button) — a blocking dialog freezes the renderer, so it cannot be triggered inline.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "lease": {
          "type": "string",
          "description": "Lease token from claim_page. Omit for a tab this process holds; required for a tab held by another process or one claimed explicitly. Auto-acquired under CDP_REQUIRE_LEASE (then pass target, not lease). See server instructions."
        },
        "target": {
          "type": "string",
          "description": "Page selector: 'active' (default), 'index:N', 'url:<substr>', 'title:<substr>', 'label:<name>', or a 32-hex '<targetId>'. Grammar: see server instructions."
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
          "description": "How long to wait for the next dialog, in milliseconds (default 15000)."
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
    "description": "Read console output (logs, warnings, exceptions) captured for the target. Reads the existing shared buffer by default (empty if no capture ran); reload:true reloads and records a fresh capture (console+network together, so a network reload never wipes console history). WORKER capture (Chrome, Capability 'worker.targets'): a worker: target records an MV3 background service worker -- its console.log arrives as Runtime.consoleAPICalled, its outbound requests from CDP's Network domain on the worker's own session -- so the two tricks callers try first fail for plain JS reasons, not worker ones: a value bound at module top level is not visible from evaluate_script's global scope, and assigning self.fetch cannot rebind a fetch the module already captured. A worker has no reload: reload:true means 'listen for durationMs while it runs', so trigger its work (tool call, message, alarm) during the window; a worker woken by the call already ran its top-level code, so a startup message can be missed. SIDE EFFECT: the CDP session KEEPS THE WORKER ALIVE for the capture (an idle MV3 worker is evicted in seconds); Chrome resumes evicting after.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "lease": {
          "type": "string",
          "description": "Lease token from claim_page. Omit for a tab this process holds; required for a tab held by another process or one claimed explicitly. Auto-acquired under CDP_REQUIRE_LEASE (then pass target, not lease). See server instructions."
        },
        "target": {
          "type": "string",
          "description": "Page selector: 'active' (default), 'index:N', 'url:<substr>', 'title:<substr>', 'label:<name>', '<targetId>'; plus 'worker:<substring>' to reach a service/shared worker (e.g. an MV3 extension background worker). The worker: arm is CHROME-ONLY (Capability 'worker.targets'). Grammar: see server instructions."
        },
        "reload": {
          "type": "boolean",
          "description": "Record fresh by reloading the page and capturing a window. Default false (read existing buffer). With a worker: target nothing reloads -- records for durationMs while the worker runs and keeps it alive until the capture stops."
        },
        "durationMs": {
          "type": "number",
          "description": "Capture window for reload mode, in ms. Default 2500."
        },
        "wake": {
          "type": "boolean",
          "description": "Worker targets only, when starting a capture. Default true: an idle-evicted MV3 service worker exists in no target listing, so it is started first (ServiceWorker.startWorker) and re-confirmed; false fails fast. Rejected on a page target, a bare target id, or a read-only call. See server instructions."
        }
      },
      "required": [],
      "additionalProperties": false
    }
  },
  {
    "name": "get_console_message",
    "description": "Return one console entry by zero-based index from the target's existing console buffer. Throws if the index is out of range; run list_console_messages (optionally reload:true) first to populate the buffer.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "lease": {
          "type": "string",
          "description": "Lease token from claim_page. Omit for a tab this process holds; required for a tab held by another process or one claimed explicitly. Auto-acquired under CDP_REQUIRE_LEASE (then pass target, not lease). See server instructions."
        },
        "target": {
          "type": "string",
          "description": "Page selector: 'active' (default), 'index:N', 'url:<substr>', 'title:<substr>', 'label:<name>', or a 32-hex '<targetId>'. Grammar: see server instructions."
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
    "description": "Return correlated network rows (one per requestId; status/headers/state) for the target. Reads the existing buffer by default; reload:true records a fresh both-domains capture window. filterUrl keeps only URLs containing a substring. WORKER capture (Chrome, Capability 'worker.targets'): a worker: target records an MV3 background service worker's outbound requests from CDP's Network domain on the worker's own session -- what the code ACTUALLY SENT -- so the two tricks callers try first fail for plain JS reasons, not worker ones: a value bound at module top level is not visible from evaluate_script's global scope, and assigning self.fetch cannot rebind a fetch the module already captured. A worker has no reload: reload:true means 'listen for durationMs while it runs', so trigger its work (tool call, message, alarm) during the window; a worker woken by the call already ran its top-level code, so a startup request can be missed. SIDE EFFECT: the CDP session KEEPS THE WORKER ALIVE for the capture (an idle MV3 worker is evicted in seconds); Chrome resumes evicting after.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "lease": {
          "type": "string",
          "description": "Lease token from claim_page. Omit for a tab this process holds; required for a tab held by another process or one claimed explicitly. Auto-acquired under CDP_REQUIRE_LEASE (then pass target, not lease). See server instructions."
        },
        "target": {
          "type": "string",
          "description": "Page selector: 'active' (default), 'index:N', 'url:<substr>', 'title:<substr>', 'label:<name>', '<targetId>'; plus 'worker:<substring>' to reach a service/shared worker (e.g. an MV3 extension background worker). The worker: arm is CHROME-ONLY (Capability 'worker.targets'). Grammar: see server instructions."
        },
        "reload": {
          "type": "boolean",
          "description": "Record fresh by reloading the page and capturing a window. Default false (read existing buffer). With a worker: target nothing reloads -- records for durationMs while the worker runs and keeps it alive until the capture stops."
        },
        "durationMs": {
          "type": "number",
          "description": "Capture window for reload mode, in ms. Default 2500."
        },
        "filterUrl": {
          "type": "string",
          "description": "Return only requests whose URL contains this substring."
        },
        "wake": {
          "type": "boolean",
          "description": "Worker targets only, when starting a capture. Default true: an idle-evicted MV3 service worker exists in no target listing, so it is started first (ServiceWorker.startWorker) and re-confirmed; false fails fast. Rejected on a page target, a bare target id, or a read-only call. See server instructions."
        }
      },
      "required": [],
      "additionalProperties": false
    }
  },
  {
    "name": "get_network_request",
    "description": "Return one network request (matched by exact requestId, else url substring) with status/headers. Requires requestId or url (throws otherwise). includeBody:true drives a fresh capture (page reload, or worker listen window) matched by url ONLY -- a fresh capture re-mints requestIds, so a carried-over requestId returns metadata plus bodyUnavailableReason. WORKER capture (Chrome, Capability 'worker.targets'): a worker: target records an MV3 background service worker's outbound requests from CDP's Network domain on the worker's own session -- what the code ACTUALLY SENT -- so the two tricks callers try first fail for plain JS reasons, not worker ones: a value bound at module top level is not visible from evaluate_script's global scope, and assigning self.fetch cannot rebind a fetch the module already captured. A worker has no reload: reload means 'listen for durationMs while it runs', so trigger its work (tool call, message, alarm) during the window; a worker woken by the call already ran its top-level code, so a startup request can be missed. SIDE EFFECT: the CDP session KEEPS THE WORKER ALIVE for the capture (an idle MV3 worker is evicted in seconds); Chrome resumes evicting after.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "lease": {
          "type": "string",
          "description": "Lease token from claim_page. Omit for a tab this process holds; required for a tab held by another process or one claimed explicitly. Auto-acquired under CDP_REQUIRE_LEASE (then pass target, not lease). See server instructions."
        },
        "target": {
          "type": "string",
          "description": "Page selector: 'active' (default), 'index:N', 'url:<substr>', 'title:<substr>', 'label:<name>', '<targetId>'; plus 'worker:<substring>' to reach a service/shared worker (e.g. an MV3 extension background worker). The worker: arm is CHROME-ONLY (Capability 'worker.targets'). Grammar: see server instructions."
        },
        "requestId": {
          "type": "string",
          "description": "Match by exact requestId (metadata only; cannot fetch a body, since a reload re-mints requestIds)."
        },
        "url": {
          "type": "string",
          "description": "Match by URL substring (first match). Required for body fetch (includeBody), since url is stable across reload."
        },
        "includeBody": {
          "type": "boolean",
          "description": "Also fetch the response body; drives a fresh capture and requires the url selector."
        },
        "durationMs": {
          "type": "number",
          "description": "Capture window for the body-fetch reload, in ms. Default 2500."
        },
        "wake": {
          "type": "boolean",
          "description": "Worker targets only, when starting a capture. Default true: an idle-evicted MV3 service worker exists in no target listing, so it is started first (ServiceWorker.startWorker) and re-confirmed; false fails fast. Rejected on a page target, a bare target id, or a read-only call. See server instructions."
        }
      },
      "required": [],
      "additionalProperties": false
    }
  },
  {
    "name": "performance_start_trace",
    "description": "Starts a CDP trace recording on the target and holds the recording connection in-process; you MUST call performance_stop_trace from the SAME PROCESS to end it, or use performance_trace instead for a robust cross-call trace. Throws if a trace is already in progress for this target.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "lease": {
          "type": "string",
          "description": "Lease token from claim_page. Omit for a tab this process holds; required for a tab held by another process or one claimed explicitly. Auto-acquired under CDP_REQUIRE_LEASE (then pass target, not lease). See server instructions."
        },
        "target": {
          "type": "string",
          "description": "Page selector: 'active' (default), 'index:N', 'url:<substr>', 'title:<substr>', 'label:<name>', or a 32-hex '<targetId>'. Grammar: see server instructions."
        },
        "categories": {
          "type": "array",
          "items": {
            "type": "string"
          },
          "description": "Trace categories to record. Defaults to timeline + user-timing + loading + disabled-by-default timeline tracks carrying LCP/LayoutShift/RunTask."
        }
      },
      "required": [],
      "additionalProperties": false
    }
  },
  {
    "name": "performance_stop_trace",
    "description": "Stops the in-process trace started by performance_start_trace and writes it as JSON under /tmp/cdp-toolkit, returning {path,bytes,events,metrics}. Throws if no live trace exists in THIS process (e.g. start ran in a different process) — use performance_trace instead. The target arg is accepted only for API symmetry; at most one trace is ever live per process.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "lease": {
          "type": "string",
          "description": "Lease token from claim_page. Omit for a tab this process holds; required for a tab held by another process or one claimed explicitly. Auto-acquired under CDP_REQUIRE_LEASE (then pass target, not lease). See server instructions."
        },
        "target": {
          "type": "string",
          "description": "Page selector: 'active' (default), 'index:N', 'url:<substr>', 'title:<substr>', 'label:<name>', or a 32-hex '<targetId>'. Grammar: see server instructions."
        }
      },
      "required": [],
      "additionalProperties": false
    }
  },
  {
    "name": "performance_analyze_insight",
    "description": "Reads a trace JSON file (from performance_trace/performance_stop_trace) at tracePath and returns headline metrics: FCP/LCP/CLS/TBT, long tasks, layout shifts. Requires an EXPLICIT tracePath — there is no implicit 'latest trace'. Numbers approximate DevTools's insight analyzer (no main-thread attribution or frame-scoped LCP).",
    "inputSchema": {
      "type": "object",
      "properties": {
        "lease": {
          "type": "string",
          "description": "Lease token from claim_page. Omit for a tab this process holds; required for a tab held by another process or one claimed explicitly. Auto-acquired under CDP_REQUIRE_LEASE (then pass target, not lease). See server instructions."
        },
        "tracePath": {
          "type": "string",
          "description": "Path to a trace JSON file (bare array or {traceEvents:[...]}) written by performance_trace or performance_stop_trace. Required."
        }
      },
      "required": [],
      "additionalProperties": false
    }
  },
  {
    "name": "performance_trace",
    "description": "RECOMMENDED entry point: one-shot trace that starts tracing, optionally reloads or navigates the page, waits durationMs (default 3000ms), stops, and writes JSON under /tmp/cdp-toolkit — returns {path,bytes,events,metrics,target}. Holds one connection open for the whole window, so unlike start/stop it is NOT limited to a single process.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "lease": {
          "type": "string",
          "description": "Lease token from claim_page. Omit for a tab this process holds; required for a tab held by another process or one claimed explicitly. Auto-acquired under CDP_REQUIRE_LEASE (then pass target, not lease). See server instructions."
        },
        "target": {
          "type": "string",
          "description": "Page selector: 'active' (default), 'index:N', 'url:<substr>', 'title:<substr>', 'label:<name>', or a 32-hex '<targetId>'. Grammar: see server instructions."
        },
        "durationMs": {
          "type": "number",
          "description": "How long to record after the optional reload/navigate, in ms. Default 3000."
        },
        "reload": {
          "type": "boolean",
          "description": "Reload the page after starting the trace, to capture full navigation timing."
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
          "description": "Trace categories to record. Defaults to timeline + user-timing + loading + disabled-by-default timeline tracks carrying LCP/LayoutShift/RunTask."
        }
      },
      "required": [],
      "additionalProperties": false
    }
  },
  {
    "name": "start_screen_recording",
    "description": "Starts recording the target tab to video via CDP Page.startScreencast, holding one persistent connection and spooling every frame to disk — MUST be paired with stop_screen_recording WITHIN THE SAME PROCESS (frames are connection-scoped and cannot be reattached from another process, so this only works under the MCP server, not the one-process-per-call CLI). Chrome only: WebDriver BiDi has no screencast primitive, so both tools are absent under --browser firefox. Frames arrive ON REPAINT not on a clock (variable rate); each is timestamped into a ledger that stop_screen_recording turns into per-frame display durations, so a still page holds one long frame instead of racing. ffmpeg is probed here (not at stop) so a missing encoder fails before frames are captured and thrown away. Throws if the target already has a recording in progress; different targets record concurrently.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "lease": {
          "type": "string",
          "description": "Lease token from claim_page. Omit for a tab this process holds; required for a tab held by another process or one claimed explicitly. Auto-acquired under CDP_REQUIRE_LEASE (then pass target, not lease). See server instructions."
        },
        "target": {
          "type": "string",
          "description": "Page selector: 'active' (default), 'index:N', 'url:<substr>', 'title:<substr>', 'label:<name>', or a 32-hex '<targetId>'. Grammar: see server instructions."
        },
        "format": {
          "type": "string",
          "enum": [
            "jpeg",
            "png"
          ],
          "description": "Frame format, default jpeg (much smaller per repaint); png is lossless. quality applies to jpeg only."
        },
        "quality": {
          "type": "number",
          "description": "JPEG frame quality 0-100. Ignored for png; omitted leaves Chrome's own default."
        },
        "maxWidth": {
          "type": "number",
          "description": "Caps the streamed frame width in px; also pins frame size if the viewport may change mid-recording."
        },
        "maxHeight": {
          "type": "number",
          "description": "Caps the streamed frame height in px."
        },
        "everyNthFrame": {
          "type": "number",
          "description": "Capture only every Nth repaint (1=every frame), to shrink spool size on a busy page; per-frame durations keep playback at wallclock speed either way."
        },
        "bringToFront": {
          "type": "boolean",
          "description": "Activate the tab (Page.bringToFront) before recording, default false. A backgrounded/occluded tab may never repaint, yielding a 0-frame recording."
        }
      },
      "required": [],
      "additionalProperties": false
    }
  },
  {
    "name": "stop_screen_recording",
    "description": "Stops the recording started by start_screen_recording, assembling spooled frames into an MP4 via ffmpeg with PER-FRAME durations (frame N held until N+1 painted; last frame held until this call) — capped at 25fps by ffmpeg's concat demuxer, so frames under 40ms apart are deliberately coalesced (frameCount=captured, encodedFrames=what reached the video, never silently dropped). Returns {path,bytes,durationMs,frameCount,encodedFrames,codec,encoder,width,height,droppedFrames,target}; durationMs sums encoded durations, the file runs one 40ms step longer (final frame repeated). Encoder ladder (probed at start): hevc_videotoolbox>h264_videotoolbox>libx265>libx264 (+hvc1 tag, faststart, yuv420p, even dims). target: omit with one recording in flight, required with several (avoids guessing which to stop). Throws if nothing is recording in this process, or if 0 frames arrived (no silent empty video). On ffmpeg failure the spooled frames are KEPT — spool path + exact command are in the error.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "lease": {
          "type": "string",
          "description": "Lease token from claim_page. Omit for a tab this process holds; required for a tab held by another process or one claimed explicitly. Auto-acquired under CDP_REQUIRE_LEASE (then pass target, not lease). See server instructions."
        },
        "target": {
          "type": "string",
          "description": "Which recording to stop — 'active' valid only when exactly one recording is in flight. Grammar: server instructions."
        },
        "savePath": {
          "type": "string",
          "description": "Override the output path (default /tmp/cdp-toolkit/screen-recording-<targetIdShort>-<stamp>.mp4)."
        }
      },
      "required": [],
      "additionalProperties": false
    }
  },
  {
    "name": "take_heapsnapshot",
    "description": "Captures a V8 heap snapshot of the target page over CDP and writes it as a .heapsnapshot JSON file (loadable in the DevTools Memory panel) under /tmp/cdp-toolkit unless savePath is given. Returns {path,bytes,chunks,target} only — does NOT parse or summarize the snapshot.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "lease": {
          "type": "string",
          "description": "Lease token from claim_page. Omit for a tab this process holds; required for a tab held by another process or one claimed explicitly. Auto-acquired under CDP_REQUIRE_LEASE (then pass target, not lease). See server instructions."
        },
        "target": {
          "type": "string",
          "description": "Page selector: 'active' (default), 'index:N', 'url:<substr>', 'title:<substr>', 'label:<name>', or a 32-hex '<targetId>'. Grammar: see server instructions."
        },
        "savePath": {
          "type": "string",
          "description": "Override the output path. Absolute paths (starting with /) are used as-is; relative paths resolve under the artifact dir (/tmp/cdp-toolkit). Defaults to an auto-named take_heapsnapshot-<targetId>-<timestamp>.heapsnapshot file."
        }
      },
      "required": [],
      "additionalProperties": false
    }
  },
  {
    "name": "lighthouse_audit",
    "description": "Runs a Lighthouse audit against a URL by shelling out to `npx --yes lighthouse` (the toolkit's only non-CDP tool) — it attaches to the already-running Chrome and audits its OWN about:blank tab, NOT any live user tab you've navigated. Writes a JSON report under /tmp/cdp-toolkit; returns {path,bytes} plus per-category scores (0..1 or null).",
    "inputSchema": {
      "type": "object",
      "properties": {
        "lease": {
          "type": "string",
          "description": "Lease token from claim_page. Omit for a tab this process holds; required for a tab held by another process or one claimed explicitly. Auto-acquired under CDP_REQUIRE_LEASE (then pass target, not lease). See server instructions."
        },
        "url": {
          "type": "string",
          "description": "The URL to audit. Required — never points at a user tab implicitly."
        },
        "categories": {
          "type": "array",
          "items": {
            "type": "string"
          },
          "description": "Lighthouse categories to run (--only-categories). Defaults to the full set, e.g. [\"performance\"] or [\"performance\",\"accessibility\",\"seo\"]."
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
          "description": "\"desktop\" (default, uses --preset=desktop to avoid heavy mobile throttling) or \"mobile\"."
        },
        "timeoutMs": {
          "type": "number",
          "description": "Overall budget for the lighthouse process, in ms. Default 120000."
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
    "description": "Register a mock rule on a target's persistent fake-backend session (CDP Fetch domain): match requests by urlPattern and fulfill with a canned response, fail (abort), or continue -- optionally with fault injection (delayMs/failRate). The session survives reloads/navigations and lives until clear_mocks; call repeatedly to mock several endpoints on one target. reload:true applies it immediately. Persistent across calls only via the MCP server, not the one-shot CLI.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "lease": {
          "type": "string",
          "description": "Lease token from claim_page. Omit for a tab this process holds; required for a tab held by another process or one claimed explicitly. Auto-acquired under CDP_REQUIRE_LEASE (then pass target, not lease). See server instructions."
        },
        "target": {
          "type": "string",
          "description": "Which page's mock session. Defaults to the active page. Grammar: server instructions."
        },
        "urlPattern": {
          "type": "string",
          "description": "CDP Fetch urlPattern glob: '*' any run of chars, '?' exactly one, '\\' escapes. Only matching URLs are paused. e.g. \"*/api/users*\"."
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
          "description": "fulfill: HTTP status for the canned response. Default 200."
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
          "description": "Only mock this HTTP method (e.g. \"POST\"); others pass through."
        },
        "delayMs": {
          "type": "number",
          "description": "Fault injection: artificial latency in ms before responding."
        },
        "failRate": {
          "type": "number",
          "description": "Fault injection: probability 0..1 of failing a matched request regardless of action."
        },
        "reload": {
          "type": "boolean",
          "description": "Reload the target after arming so the mock catches traffic immediately."
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
    "description": "List active fake-backend sessions (one per target) with their rules and hit counts. Prunes sessions whose tab has closed.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "lease": {
          "type": "string",
          "description": "Lease token from claim_page. Omit for a tab this process holds; required for a tab held by another process or one claimed explicitly. Auto-acquired under CDP_REQUIRE_LEASE (then pass target, not lease). See server instructions."
        },
        "target": {
          "type": "string",
          "description": "Unused filter placeholder; returns all active sessions."
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
          "description": "Lease token from claim_page. Omit for a tab this process holds; required for a tab held by another process or one claimed explicitly. Auto-acquired under CDP_REQUIRE_LEASE (then pass target, not lease). See server instructions."
        },
        "target": {
          "type": "string",
          "description": "Which page's mock session to clear. Defaults to the active page; ignored when all:true. Grammar: server instructions."
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
    "description": "Take exclusive ownership of a browser tab, returning an opaque lease token (needed once under CDP_REQUIRE_LEASE for any tab you drive). Two modes: FRESH TAB (no target - opens one, optionally at url, and claims it: 'give me my own tab' in one call) and TAKEOVER (target - claims an already-open tab, e.g. the human's, resolving the selector against the live page list, creating nothing). The opened flag is true only when this call created the tab, and release_page consults that record, so a taken-over tab is left open on release. Refused from the CLI (its per-call process would make the lease instantly reclaimable). The answer carries humanActiveMs, ms since input this server did not dispatch; null is NO DATA (no activity beacon, or every input was this server's own) and never means 'no human'; absent on a backend that cannot answer. On takeover of a tab a human used within 30s it adds contention, a warning - but THE CLAIM IS NEVER REFUSED FOR THIS: takeover is its purpose, you already hold the lease; it only warns you're fighting a live person, so open your own tab or ask first. Limits: input inside a cross-origin iframe is invisible, and a second MCP server's clicks read as human.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "target": {
          "type": "string",
          "description": "Take over an already-open tab (e.g. one the human has open). Resolved against the LIVE page list only, so it never opens a tab — a selector matching nothing is an error. Left open on release. Refused if another live process holds it (including a lease auto-acquired under CDP_REQUIRE_LEASE): takes over unleased human tabs, never steals from a live agent. Mutually exclusive with targetId. Selector grammar: server instructions."
        },
        "targetId": {
          "type": "string",
          "description": "Exact target id (not a selector) of an already-open page to claim instead of opening one. Back-compat only; prefer target, which also accepts an exact id. Mutually exclusive with target."
        },
        "url": {
          "type": "string",
          "description": "When opening a fresh tab, navigate it here. Ignored when target or targetId is given."
        },
        "label": {
          "type": "string",
          "description": "Agent label recorded on the lease; surfaced in conflict errors and list_leases. Defaults to pid-<pid>."
        },
        "ttlMs": {
          "type": "number",
          "description": "How long the lease survives without use before it is reclaimable. Defaults to CDP_LEASE_TTL_MS, else 900000 (15min); every checked call refreshes it."
        }
      },
      "required": [],
      "additionalProperties": false
    }
  },
  {
    "name": "release_page",
    "description": "Give a lease back, closing the tab only if this toolkit opened it. Take exactly one of lease (the token) or target (a selector for a tab this process holds - use this to release a lease the gate acquired for you automatically, since that path never handed you a token). A tab with a creation record from this toolkit is closed; a tab that was already open and merely claimed is released and left alone - override either way with close. Idempotent: an already-released, reclaimed, or expired lease reports released:false and closes nothing (by then the tab may belong to another agent). Answers {released, closed, targetId}.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "lease": {
          "type": "string",
          "description": "Token from claim_page / new_page{claim:true}. Mutually exclusive with 'target'. Under CDP_REQUIRE_LEASE an auto-acquired lease never produced a token — give 'target' instead."
        },
        "target": {
          "type": "string",
          "description": "A tab THIS process holds (grammar: server instructions). Mutually exclusive with 'lease'. Refused if another process holds the tab."
        },
        "close": {
          "type": "boolean",
          "description": "Force the close decision instead of letting the creation record decide: true closes even a tab this toolkit did not open; false keeps an agent-created tab open. Omit to close only tabs this toolkit created."
        }
      },
      "required": [],
      "additionalProperties": false
    }
  },
  {
    "name": "list_leases",
    "description": "Enumerate every active lease for diagnosis - backend, target id, label, pid, createdAt, lastUsedAt, ttlMs, whether the owning process is alive, and whether the lease is reclaimable and why. No token required; it never returns the lease nonce, so it cannot be used to forge one. An unreadable or unparseable lease row instead carries unreadable, with label, pid and timestamps zeroed and stale forced false (an unreadable lease must never read as free to take). Under CDP_REQUIRE_LEASE it reaps abandoned agent tabs exactly as list_pages does, into an additive reaped array, omitting their rows. Where the tab can answer, a row also carries humanActiveMs, ms since input this server did not dispatch - note lastUsedAt tracks TOOLKIT calls only, so a tab a person has typed in for ten minutes looks idle, which is what this exposes; the field is absent, never null, when the tab cannot answer, and that absence means 'no answer', never 'nobody is there'. idleMs (now - lastUsedAt) and expiresAt (lastUsedAt + ttlMs) are computed fresh each call and omitted on an unreadable row.",
    "inputSchema": {
      "type": "object",
      "properties": {},
      "required": [],
      "additionalProperties": false
    }
  }
];
