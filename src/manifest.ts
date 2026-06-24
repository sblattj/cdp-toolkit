/**
 * MCP tool manifest — the JSON Schemas the cdp-toolkit MCP server advertises via
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
    "description": "Enumerate browser page targets via the CDP browser endpoint (GET /json/list). By default returns only page-type tabs; set 'all' to also include workers and background pages. Each entry carries the targetId used as a target selector elsewhere.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "all": {
          "type": "boolean",
          "description": "Include non-page targets (service/shared workers, background pages) when true; otherwise only page-type tabs are listed."
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
        "url": {
          "type": "string",
          "description": "URL to open in the new tab; defaults to about:blank."
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
    "description": "Navigate a target page to a URL (Page.navigate) OR reload it (reload:true) over raw CDP, then wait for the load milestone with a bounded timeout so a wedged renderer can't hang. Returns {url,frameId,waitedFor} (plus reloaded:true on a reload); waitUntil supports 'load'|'domcontentloaded' only (no 'networkidle'), and there is no auto-snapshot of the new page. Pass reload:true with ignoreCache:true for a hard reload that refetches every subresource (e.g. to pick up a freshly-deployed, non-content-hashed bundle the HTTP cache would serve stale).",
    "inputSchema": {
      "type": "object",
      "properties": {
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
    "description": "Poll a target page until the given substring appears in document.body.innerText (Runtime.evaluate on a fixed interval), or throw on timeout. Text-substring waiting only — no aria/role/selector or event variants; throws rather than returning {found:false}.",
    "inputSchema": {
      "type": "object",
      "properties": {
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
    "description": "Run arbitrary JavaScript in the target page's main-world context over raw CDP and return the evaluated value (returnByValue). With no 'args' the 'expression' is evaluated as a raw expression; when 'args' is provided 'expression' must be a function literal (arrow or classic) invoked on globalThis with the args passed positionally. A thrown exception surfaces as an error; non-serializable returns (DOM nodes, functions) come back as their CDP description string.",
    "inputSchema": {
      "type": "object",
      "properties": {
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
        }
      },
      "required": [
        "expression"
      ],
      "additionalProperties": false
    }
  },
  {
    "name": "take_snapshot",
    "description": "Capture the page's accessibility tree (Accessibility.getFullAXTree) as a compact indented text tree where each line is prefixed with [uid] — the node's CDP backendDOMNodeId. These uids are the stateless element references that every interaction tool (click/hover/fill/etc.) feeds back to resolve a live DOM node (via DOM.resolveNode({ backendNodeId: uid })), so run this first to discover uids.",
    "inputSchema": {
      "type": "object",
      "properties": {
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
    "description": "Click an element via a synthetic mouse press/release at the element's scrolled-into-view bounding-rect center. Target the element with exactly one of 'uid' (a CDP backendDOMNodeId from take_snapshot) or 'selector' (a CSS selector).",
    "inputSchema": {
      "type": "object",
      "properties": {
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
          "description": "Number of clicks: 1 = single (default), 2 = double-click."
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
    "description": "Drag from a source element to a destination element via synthetic mouse press/move/release (approximates HTML5 drag-and-drop; not guaranteed for every custom DnD library). 'from' and 'to' each take exactly one of uid (a CDP backendDOMNodeId from take_snapshot) or selector.",
    "inputSchema": {
      "type": "object",
      "properties": {
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
          "description": "Destination element to drag to. Provide exactly one of uid or selector.",
          "properties": {
            "uid": {
              "type": "number",
              "description": "CDP backendDOMNodeId of the destination element, obtained from take_snapshot."
            },
            "selector": {
              "type": "string",
              "description": "CSS selector for the destination element (resolved via document.querySelector)."
            }
          },
          "additionalProperties": false
        }
      },
      "required": [
        "from",
        "to"
      ],
      "additionalProperties": false
    }
  },
  {
    "name": "fill",
    "description": "Fill an element by focusing it, clearing existing content, then inserting 'value' via Input.insertText (atomic paste-like commit, not per-character keystrokes). Target with exactly one of 'uid' (a CDP backendDOMNodeId from take_snapshot) or 'selector' (a CSS selector).",
    "inputSchema": {
      "type": "object",
      "properties": {
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
    "description": "Capture the viewport (default), the full scrollable page (fullPage), or a single element (uid or selector — exactly one, mutually exclusive) via raw CDP Page.captureScreenshot. Writes a PNG/JPEG under /tmp/cdp-toolkit (override with savePath) and returns {path,bytes,format,target}; raw base64 is only included when returnBase64 is set. quality applies to jpeg only.",
    "inputSchema": {
      "type": "object",
      "properties": {
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
          "description": "Element to clip to — a CDP backendDOMNodeId obtained from take_snapshot. Mutually exclusive with selector."
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
    "description": "Return a single console entry by zero-based index from the target's existing console buffer. Throws if the index is out of range — run list_console_messages (optionally with reload:true) first to populate the buffer.",
    "inputSchema": {
      "type": "object",
      "properties": {
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
    "description": "Return one network request (matched by exact requestId, else by url substring) including status/headers. Requires at least one of requestId or url (throws otherwise). With includeBody:true the body fetch drives a fresh reload capture and is matched by url ONLY (reload re-mints requestIds, so a carried-over requestId cannot fetch a body — it returns metadata plus bodyUnavailableReason).",
    "inputSchema": {
      "type": "object",
      "properties": {
        "target": {
          "type": "string",
          "description": "Target page selector: 'active' (default) | '<targetId>' | 'index:N' | 'url:<substring>' | 'title:<substring>'."
        },
        "requestId": {
          "type": "string",
          "description": "Match by exact requestId (metadata only — cannot fetch a body, since reload re-mints requestIds)."
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
    "description": "Stop the in-process trace started by performance_start_trace, drain buffered Tracing.dataCollected events, write the trace JSON under /tmp/cdp-toolkit, and return {path,bytes,events,metrics}. Throws if no live trace exists in this process (e.g. start ran in a different process) — use performance_trace instead. The 'target' arg is accepted only for API symmetry; at most one trace is ever live per process.",
    "inputSchema": {
      "type": "object",
      "properties": {
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
    "description": "CDP-native approximation of the DevTools insight analyzer: read a trace JSON file (bare array or {traceEvents:[...]}) at the given tracePath and return headline metrics (FCP/LCP/CLS/TBT, long tasks, layout shifts). Requires an explicit tracePath returned by performance_trace/performance_stop_trace — there is no implicit 'latest trace'. Numbers approximate DevTools (no main-thread attribution or frame-scoped LCP).",
    "inputSchema": {
      "type": "object",
      "properties": {
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
    "description": "PRIMARY one-shot trace: start tracing, optionally reload or navigate the page, wait durationMs (default 3000), end the trace, write the trace JSON under /tmp/cdp-toolkit, and return {path,bytes,events,metrics,target}. Holds one connection open for the whole window, so it is immune to the cross-process limitation of start/stop — the recommended entry point.",
    "inputSchema": {
      "type": "object",
      "properties": {
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
    "name": "take_heapsnapshot",
    "description": "Capture a V8 heap snapshot of the selected page target over raw CDP (HeapProfiler.takeHeapSnapshot, accumulating addHeapSnapshotChunk events) and write it as a .heapsnapshot JSON file loadable by the DevTools Memory panel; returns {path,bytes,chunks,target} only and does not parse/summarize the snapshot. Writes under /tmp/cdp-toolkit (CDP_ARTIFACT_DIR) unless savePath is given.",
    "inputSchema": {
      "type": "object",
      "properties": {
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
        "url": {
          "type": "string",
          "description": "The URL to audit. Required — never points at a user tab implicitly."
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
    "description": "Register a mock rule on a target's persistent fake-backend session (CDP Fetch domain): intercept requests whose URL matches urlPattern and fulfill them with a canned response, fail (abort) them, or continue them — optionally with fault injection (delayMs/failRate). The session survives reloads and navigations and lives until clear_mocks. Call repeatedly to mock several endpoints on the same target. Pass reload:true to apply immediately. Persistent across calls only via the MCP server (not the one-shot CLI).",
    "inputSchema": {
      "type": "object",
      "properties": {
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
  }
];
