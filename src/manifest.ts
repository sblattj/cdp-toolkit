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
    "description": "List browser page targets; optionally include non-page targets and probe responsiveness.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "lease": {
          "type": "string",
          "description": "Lease token; omit for a tab this process already holds. See server instructions."
        },
        "all": {
          "type": "boolean",
          "description": "Include non-page targets."
        },
        "probe": {
          "type": "boolean",
          "description": "Probe renderer responsiveness."
        }
      },
      "required": [],
      "additionalProperties": false
    }
  },
  {
    "name": "new_page",
    "description": "Open a browser tab, optionally claim it; navigation is not awaited.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "lease": {
          "type": "string",
          "description": "Lease token; omit for a tab this process already holds. See server instructions."
        },
        "url": {
          "type": "string",
          "description": "URL value."
        },
        "claim": {
          "type": "boolean",
          "description": "Claim the new tab."
        },
        "label": {
          "type": "string",
          "description": "Agent lease label."
        },
        "ttlMs": {
          "type": "number",
          "description": "Lease TTL in milliseconds."
        }
      },
      "required": [],
      "additionalProperties": false
    }
  },
  {
    "name": "close_page",
    "description": "Close a selected page; target must resolve explicitly.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "lease": {
          "type": "string",
          "description": "Lease token; omit for a tab this process already holds. See server instructions."
        },
        "target": {
          "type": "string",
          "description": "Page selector (index:/url:/title:/label:/targetId, default active); grammar in server instructions."
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
    "description": "Focus a selected page and persist it as active; target must resolve explicitly.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "lease": {
          "type": "string",
          "description": "Lease token; omit for a tab this process already holds. See server instructions."
        },
        "target": {
          "type": "string",
          "description": "Page selector (index:/url:/title:/label:/targetId, default active); grammar in server instructions."
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
    "description": "Navigate, reload, or traverse page history; choose exactly one operation.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "lease": {
          "type": "string",
          "description": "Lease token; omit for a tab this process already holds. See server instructions."
        },
        "target": {
          "type": "string",
          "description": "Page selector (index:/url:/title:/label:/targetId, default active); grammar in server instructions."
        },
        "url": {
          "type": "string",
          "description": "URL value."
        },
        "reload": {
          "type": "boolean",
          "description": "Reload before capture."
        },
        "history": {
          "type": "string",
          "enum": [
            "back",
            "forward"
          ],
          "description": "History direction."
        },
        "ignoreCache": {
          "type": "boolean",
          "description": "Bypass cache on reload."
        },
        "waitUntil": {
          "type": "string",
          "enum": [
            "load",
            "domcontentloaded"
          ],
          "description": "Load milestone."
        },
        "timeoutMs": {
          "type": "number",
          "description": "Timeout in milliseconds."
        }
      },
      "additionalProperties": false
    }
  },
  {
    "name": "wait_for",
    "description": "Wait for a text substring in document.body.innerText; timeout throws.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "lease": {
          "type": "string",
          "description": "Lease token; omit for a tab this process already holds. See server instructions."
        },
        "target": {
          "type": "string",
          "description": "Page selector (index:/url:/title:/label:/targetId, default active); grammar in server instructions."
        },
        "text": {
          "type": "string",
          "description": "Text substring."
        },
        "timeoutMs": {
          "type": "number",
          "description": "Timeout in milliseconds."
        },
        "pollMs": {
          "type": "number",
          "description": "Polling interval in milliseconds."
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
    "description": "Evaluate JavaScript in a page or Chrome worker; args require a function literal.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "lease": {
          "type": "string",
          "description": "Lease token; omit for a tab this process already holds. See server instructions."
        },
        "target": {
          "type": "string",
          "description": "Page selector (index:/url:/title:/label:/targetId, default active); grammar in server instructions."
        },
        "wake": {
          "type": "boolean",
          "description": "Wake worker before capture."
        },
        "expression": {
          "type": "string",
          "description": "JavaScript expression or function."
        },
        "awaitPromise": {
          "type": "boolean",
          "description": "Await Promise results."
        },
        "args": {
          "type": "array",
          "items": {},
          "description": "Positional JSON arguments."
        },
        "savePath": {
          "type": "string",
          "description": "Output file path."
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
    "description": "Read cookies for a selected page, including httpOnly values; savePath keeps values out of the response.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "lease": {
          "type": "string",
          "description": "Lease token; omit for a tab this process already holds. See server instructions."
        },
        "target": {
          "type": "string",
          "description": "Page selector (index:/url:/title:/label:/targetId, default active); grammar in server instructions."
        },
        "domain": {
          "type": "string",
          "description": "Cookie domain."
        },
        "name": {
          "type": "string",
          "description": "Cookie name."
        },
        "savePath": {
          "type": "string",
          "description": "Output file path."
        }
      },
      "required": [],
      "additionalProperties": false
    }
  },
  {
    "name": "set_cookie",
    "description": "Set one page cookie, including httpOnly or secure flags; provide url or domain.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "lease": {
          "type": "string",
          "description": "Lease token; omit for a tab this process already holds. See server instructions."
        },
        "target": {
          "type": "string",
          "description": "Page selector (index:/url:/title:/label:/targetId, default active); grammar in server instructions."
        },
        "name": {
          "type": "string",
          "description": "Cookie name."
        },
        "value": {
          "type": "string",
          "description": "Cookie value."
        },
        "url": {
          "type": "string",
          "description": "URL value."
        },
        "domain": {
          "type": "string",
          "description": "Cookie domain."
        },
        "path": {
          "type": "string",
          "description": "Cookie path."
        },
        "expires": {
          "type": "number",
          "description": "Expiry Unix time in seconds."
        },
        "httpOnly": {
          "type": "boolean",
          "description": "Set HttpOnly flag."
        },
        "secure": {
          "type": "boolean",
          "description": "Set Secure flag."
        },
        "sameSite": {
          "type": "string",
          "enum": [
            "strict",
            "lax",
            "none",
            "default"
          ],
          "description": "SameSite attribute."
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
    "description": "Delete a named page cookie; provide name and url or domain.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "lease": {
          "type": "string",
          "description": "Lease token; omit for a tab this process already holds. See server instructions."
        },
        "target": {
          "type": "string",
          "description": "Page selector (index:/url:/title:/label:/targetId, default active); grammar in server instructions."
        },
        "name": {
          "type": "string",
          "description": "Cookie name."
        },
        "url": {
          "type": "string",
          "description": "URL value."
        },
        "domain": {
          "type": "string",
          "description": "Cookie domain."
        },
        "path": {
          "type": "string",
          "description": "Cookie path."
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
    "description": "Capture the page accessibility tree with interaction UIDs.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "lease": {
          "type": "string",
          "description": "Lease token; omit for a tab this process already holds. See server instructions."
        },
        "target": {
          "type": "string",
          "description": "Page selector (index:/url:/title:/label:/targetId, default active); grammar in server instructions."
        },
        "interactiveOnly": {
          "type": "boolean",
          "description": "Only interactive nodes."
        }
      },
      "required": [],
      "additionalProperties": false
    }
  },
  {
    "name": "click",
    "description": "Click an element by UID or CSS selector; provide exactly one.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "lease": {
          "type": "string",
          "description": "Lease token; omit for a tab this process already holds. See server instructions."
        },
        "target": {
          "type": "string",
          "description": "Page selector (index:/url:/title:/label:/targetId, default active); grammar in server instructions."
        },
        "uid": {
          "type": "number",
          "description": "Element backendDOMNodeId."
        },
        "selector": {
          "type": "string",
          "description": "CSS selector."
        },
        "button": {
          "type": "string",
          "enum": [
            "left",
            "right",
            "middle"
          ],
          "description": "Mouse button."
        },
        "clickCount": {
          "type": "number",
          "description": "Click count."
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
          "description": "Modifier keys: Control|Ctrl|Shift|Alt|Meta|Cmd."
        }
      },
      "required": [],
      "additionalProperties": false
    }
  },
  {
    "name": "hover",
    "description": "Hover an element by UID or CSS selector; provide exactly one.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "lease": {
          "type": "string",
          "description": "Lease token; omit for a tab this process already holds. See server instructions."
        },
        "target": {
          "type": "string",
          "description": "Page selector (index:/url:/title:/label:/targetId, default active); grammar in server instructions."
        },
        "uid": {
          "type": "number",
          "description": "Element backendDOMNodeId."
        },
        "selector": {
          "type": "string",
          "description": "CSS selector."
        }
      },
      "required": [],
      "additionalProperties": false
    }
  },
  {
    "name": "drag",
    "description": "Drag from an element to a destination or offset; html5 mode is Chrome-only.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "lease": {
          "type": "string",
          "description": "Lease token; omit for a tab this process already holds. See server instructions."
        },
        "target": {
          "type": "string",
          "description": "Page selector (index:/url:/title:/label:/targetId, default active); grammar in server instructions."
        },
        "from": {
          "type": "object",
          "description": "Drag source.",
          "properties": {
            "uid": {
              "type": "number",
              "description": "Element backendDOMNodeId."
            },
            "selector": {
              "type": "string",
              "description": "CSS selector."
            }
          },
          "additionalProperties": false
        },
        "to": {
          "type": "object",
          "description": "Drag destination.",
          "properties": {
            "uid": {
              "type": "number",
              "description": "Element backendDOMNodeId."
            },
            "selector": {
              "type": "string",
              "description": "CSS selector."
            },
            "x": {
              "type": "number",
              "description": "Viewport x-coordinate."
            },
            "y": {
              "type": "number",
              "description": "Viewport y-coordinate."
            }
          },
          "additionalProperties": false
        },
        "by": {
          "type": "object",
          "description": "Drag offset.",
          "properties": {
            "dx": {
              "type": "number",
              "description": "Horizontal drag offset."
            },
            "dy": {
              "type": "number",
              "description": "Vertical drag offset."
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
          "description": "Drag mode."
        },
        "steps": {
          "type": "number",
          "description": "Interpolation steps."
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
    "description": "Dispatch a wheel event at an element or coordinate anchor; provide deltaX or deltaY.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "lease": {
          "type": "string",
          "description": "Lease token; omit for a tab this process already holds. See server instructions."
        },
        "target": {
          "type": "string",
          "description": "Page selector (index:/url:/title:/label:/targetId, default active); grammar in server instructions."
        },
        "uid": {
          "type": "number",
          "description": "Element backendDOMNodeId."
        },
        "selector": {
          "type": "string",
          "description": "CSS selector."
        },
        "x": {
          "type": "number",
          "description": "Viewport x-coordinate."
        },
        "y": {
          "type": "number",
          "description": "Viewport y-coordinate."
        },
        "deltaX": {
          "type": "number",
          "description": "Horizontal scroll delta."
        },
        "deltaY": {
          "type": "number",
          "description": "Vertical scroll delta."
        }
      },
      "required": [],
      "additionalProperties": false
    }
  },
  {
    "name": "dispatch_mouse",
    "description": "Dispatch one raw mouse event at viewport coordinates; Chrome-only.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "lease": {
          "type": "string",
          "description": "Lease token; omit for a tab this process already holds. See server instructions."
        },
        "target": {
          "type": "string",
          "description": "Page selector (index:/url:/title:/label:/targetId, default active); grammar in server instructions."
        },
        "action": {
          "type": "string",
          "enum": [
            "move",
            "down",
            "up"
          ],
          "description": "Mouse action."
        },
        "x": {
          "type": "number",
          "description": "Viewport x-coordinate."
        },
        "y": {
          "type": "number",
          "description": "Viewport y-coordinate."
        },
        "button": {
          "type": "string",
          "enum": [
            "left",
            "right",
            "middle"
          ],
          "description": "Mouse button."
        },
        "clickCount": {
          "type": "number",
          "description": "Click count."
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
          "description": "Modifier keys: Control|Ctrl|Shift|Alt|Meta|Cmd."
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
    "description": "Arm or collect a browser download; arm capture before triggering the download.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "lease": {
          "type": "string",
          "description": "Lease token; omit for a tab this process already holds. See server instructions."
        },
        "target": {
          "type": "string",
          "description": "Page selector (index:/url:/title:/label:/targetId, default active); grammar in server instructions."
        },
        "arm": {
          "type": "boolean",
          "description": "Arm download capture."
        },
        "timeoutMs": {
          "type": "number",
          "description": "Timeout in milliseconds."
        }
      },
      "required": [],
      "additionalProperties": false
    }
  },
  {
    "name": "grant_permissions",
    "description": "Grant or reset browser permissions; permissions are origin-scoped and Chrome-only.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "lease": {
          "type": "string",
          "description": "Lease token; omit for a tab this process already holds. See server instructions."
        },
        "target": {
          "type": "string",
          "description": "Page selector (index:/url:/title:/label:/targetId, default active); grammar in server instructions."
        },
        "permissions": {
          "type": "array",
          "items": {
            "type": "string"
          },
          "description": "CDP PermissionType values, e.g. geolocation|notifications|clipboardReadWrite."
        },
        "origin": {
          "type": "string",
          "description": "Permission origin."
        },
        "reset": {
          "type": "boolean",
          "description": "Reset permission grants."
        }
      },
      "required": [],
      "additionalProperties": false
    }
  },
  {
    "name": "fill",
    "description": "Replace an element contents; provide exactly one of UID or selector.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "lease": {
          "type": "string",
          "description": "Lease token; omit for a tab this process already holds. See server instructions."
        },
        "target": {
          "type": "string",
          "description": "Page selector (index:/url:/title:/label:/targetId, default active); grammar in server instructions."
        },
        "uid": {
          "type": "number",
          "description": "Element backendDOMNodeId."
        },
        "selector": {
          "type": "string",
          "description": "CSS selector."
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
    "description": "Fill multiple elements atomically; each field needs a UID or selector.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "lease": {
          "type": "string",
          "description": "Lease token; omit for a tab this process already holds. See server instructions."
        },
        "target": {
          "type": "string",
          "description": "Page selector (index:/url:/title:/label:/targetId, default active); grammar in server instructions."
        },
        "fields": {
          "type": "array",
          "description": "Form fields to fill.",
          "items": {
            "type": "object",
            "properties": {
              "uid": {
                "type": "number",
                "description": "Element backendDOMNodeId."
              },
              "selector": {
                "type": "string",
                "description": "CSS selector."
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
    "description": "Append text to an element; input is atomic and does not clear existing content.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "lease": {
          "type": "string",
          "description": "Lease token; omit for a tab this process already holds. See server instructions."
        },
        "target": {
          "type": "string",
          "description": "Page selector (index:/url:/title:/label:/targetId, default active); grammar in server instructions."
        },
        "uid": {
          "type": "number",
          "description": "Element backendDOMNodeId."
        },
        "selector": {
          "type": "string",
          "description": "CSS selector."
        },
        "text": {
          "type": "string",
          "description": "Text substring."
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
    "description": "Press one named key or printable character with modifiers; no F-keys or IME.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "lease": {
          "type": "string",
          "description": "Lease token; omit for a tab this process already holds. See server instructions."
        },
        "target": {
          "type": "string",
          "description": "Page selector (index:/url:/title:/label:/targetId, default active); grammar in server instructions."
        },
        "key": {
          "type": "string",
          "description": "Named key or printable character; e.g. Enter|Tab|Escape|ArrowDown|Backspace."
        },
        "modifiers": {
          "type": "array",
          "description": "Modifier keys: Control|Ctrl|Shift|Alt|Meta|Cmd.",
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
    "description": "Attach absolute file paths to a file input; provide an array.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "lease": {
          "type": "string",
          "description": "Lease token; omit for a tab this process already holds. See server instructions."
        },
        "target": {
          "type": "string",
          "description": "Page selector (index:/url:/title:/label:/targetId, default active); grammar in server instructions."
        },
        "uid": {
          "type": "number",
          "description": "Element backendDOMNodeId."
        },
        "selector": {
          "type": "string",
          "description": "CSS selector."
        },
        "files": {
          "type": "array",
          "items": {
            "type": "string"
          },
          "description": "Absolute file paths."
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
    "description": "Capture a viewport, full page, or element to PNG/JPEG; oversized captures may be tiled.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "lease": {
          "type": "string",
          "description": "Lease token; omit for a tab this process already holds. See server instructions."
        },
        "target": {
          "type": "string",
          "description": "Page selector (index:/url:/title:/label:/targetId, default active); grammar in server instructions."
        },
        "format": {
          "type": "string",
          "enum": [
            "png",
            "jpeg"
          ],
          "description": "Image/frame format."
        },
        "quality": {
          "type": "number",
          "description": "JPEG quality 0-100."
        },
        "fullPage": {
          "type": "boolean",
          "description": "Capture full scrollable page."
        },
        "scale": {
          "type": "number",
          "description": "Output scale (0<scale<=8)."
        },
        "renderWidth": {
          "type": "number",
          "description": "Rendered viewport width."
        },
        "renderHeight": {
          "type": "number",
          "description": "Rendered viewport height."
        },
        "tile": {
          "type": "boolean",
          "description": "Vertical-band stitching."
        },
        "uid": {
          "type": "number",
          "description": "Element backendDOMNodeId."
        },
        "selector": {
          "type": "string",
          "description": "CSS selector."
        },
        "savePath": {
          "type": "string",
          "description": "Output file path."
        },
        "returnBase64": {
          "type": "boolean",
          "description": "Return base64 bytes."
        }
      },
      "required": [],
      "additionalProperties": false
    }
  },
  {
    "name": "emulate",
    "description": "Apply browser emulation overrides; width and height must be paired.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "lease": {
          "type": "string",
          "description": "Lease token; omit for a tab this process already holds. See server instructions."
        },
        "target": {
          "type": "string",
          "description": "Page selector (index:/url:/title:/label:/targetId, default active); grammar in server instructions."
        },
        "width": {
          "type": "number",
          "description": "Viewport width; pair with height."
        },
        "height": {
          "type": "number",
          "description": "Viewport height; pair with width."
        },
        "deviceScaleFactor": {
          "type": "number",
          "description": "Device pixel ratio."
        },
        "mobile": {
          "type": "boolean",
          "description": "Mobile emulation."
        },
        "userAgent": {
          "type": "string",
          "description": "User-Agent override."
        },
        "cpuThrottlingRate": {
          "type": "number",
          "description": "CPU throttling rate (>=1)."
        },
        "media": {
          "type": "string",
          "description": "CSS media: screen|print|blank."
        },
        "mediaFeatures": {
          "type": "array",
          "description": "CSS media feature overrides.",
          "items": {
            "type": "object",
            "properties": {
              "name": {
                "type": "string",
                "description": "Media feature name, e.g. 'prefers-color-scheme'."
              },
              "value": {
                "type": "string",
                "description": "Feature value, e.g. 'dark'."
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
          "description": "Network condition overrides.",
          "properties": {
            "offline": {
              "type": "boolean",
              "description": "Simulate offline."
            },
            "latency": {
              "type": "number",
              "description": "Network latency in milliseconds."
            },
            "downloadThroughput": {
              "type": "number",
              "description": "Download throughput; -1 unlimited."
            },
            "uploadThroughput": {
              "type": "number",
              "description": "Upload throughput; -1 unlimited."
            },
            "connectionType": {
              "type": "string",
              "description": "Connection: none|cellular2g|cellular3g|cellular4g|bluetooth|ethernet|wifi|wimax|other."
            }
          },
          "additionalProperties": false
        },
        "clearOverrides": {
          "type": "boolean",
          "description": "Clear all emulation overrides."
        }
      },
      "required": [],
      "additionalProperties": false
    }
  },
  {
    "name": "resize_page",
    "description": "Set and verify page viewport metrics; width and height are required.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "lease": {
          "type": "string",
          "description": "Lease token; omit for a tab this process already holds. See server instructions."
        },
        "target": {
          "type": "string",
          "description": "Page selector (index:/url:/title:/label:/targetId, default active); grammar in server instructions."
        },
        "width": {
          "type": "number",
          "description": "Viewport width; pair with height."
        },
        "height": {
          "type": "number",
          "description": "Viewport height; pair with width."
        },
        "deviceScaleFactor": {
          "type": "number",
          "description": "Device pixel ratio."
        },
        "mobile": {
          "type": "boolean",
          "description": "Mobile emulation."
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
    "description": "Handle the next JavaScript dialog; autoMs switches to timed multi-dialog mode.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "lease": {
          "type": "string",
          "description": "Lease token; omit for a tab this process already holds. See server instructions."
        },
        "target": {
          "type": "string",
          "description": "Page selector (index:/url:/title:/label:/targetId, default active); grammar in server instructions."
        },
        "accept": {
          "type": "boolean",
          "description": "Accept or dismiss dialog."
        },
        "promptText": {
          "type": "string",
          "description": "Prompt response text."
        },
        "timeoutMs": {
          "type": "number",
          "description": "Timeout in milliseconds."
        },
        "autoMs": {
          "type": "number",
          "description": "Multi-dialog window in milliseconds."
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
    "description": "Read or recapture console messages for a page or worker; worker capture is Chrome-only.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "lease": {
          "type": "string",
          "description": "Lease token; omit for a tab this process already holds. See server instructions."
        },
        "target": {
          "type": "string",
          "description": "Page selector (index:/url:/title:/label:/targetId, default active); grammar in server instructions."
        },
        "reload": {
          "type": "boolean",
          "description": "Reload before capture."
        },
        "durationMs": {
          "type": "number",
          "description": "Capture duration in milliseconds."
        },
        "wake": {
          "type": "boolean",
          "description": "Wake worker before capture."
        }
      },
      "required": [],
      "additionalProperties": false
    }
  },
  {
    "name": "get_console_message",
    "description": "Return one console entry by zero-based index from the existing buffer.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "lease": {
          "type": "string",
          "description": "Lease token; omit for a tab this process already holds. See server instructions."
        },
        "target": {
          "type": "string",
          "description": "Page selector (index:/url:/title:/label:/targetId, default active); grammar in server instructions."
        },
        "index": {
          "type": "number",
          "description": "Zero-based entry index."
        }
      },
      "required": [],
      "additionalProperties": false
    }
  },
  {
    "name": "list_network_requests",
    "description": "Read or recapture correlated network requests; worker capture is Chrome-only.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "lease": {
          "type": "string",
          "description": "Lease token; omit for a tab this process already holds. See server instructions."
        },
        "target": {
          "type": "string",
          "description": "Page selector (index:/url:/title:/label:/targetId, default active); grammar in server instructions."
        },
        "reload": {
          "type": "boolean",
          "description": "Reload before capture."
        },
        "durationMs": {
          "type": "number",
          "description": "Capture duration in milliseconds."
        },
        "filterUrl": {
          "type": "string",
          "description": "URL substring filter."
        },
        "wake": {
          "type": "boolean",
          "description": "Wake worker before capture."
        }
      },
      "required": [],
      "additionalProperties": false
    }
  },
  {
    "name": "get_network_request",
    "description": "Return a network request by ID or URL; body capture requires URL.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "lease": {
          "type": "string",
          "description": "Lease token; omit for a tab this process already holds. See server instructions."
        },
        "target": {
          "type": "string",
          "description": "Page selector (index:/url:/title:/label:/targetId, default active); grammar in server instructions."
        },
        "requestId": {
          "type": "string",
          "description": "Exact request ID."
        },
        "url": {
          "type": "string",
          "description": "URL value."
        },
        "includeBody": {
          "type": "boolean",
          "description": "Include response body."
        },
        "durationMs": {
          "type": "number",
          "description": "Capture duration in milliseconds."
        },
        "wake": {
          "type": "boolean",
          "description": "Wake worker before capture."
        }
      },
      "required": [],
      "additionalProperties": false
    }
  },
  {
    "name": "performance_start_trace",
    "description": "Start an in-process trace; stop it from the same process.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "lease": {
          "type": "string",
          "description": "Lease token; omit for a tab this process already holds. See server instructions."
        },
        "target": {
          "type": "string",
          "description": "Page selector (index:/url:/title:/label:/targetId, default active); grammar in server instructions."
        },
        "categories": {
          "type": "array",
          "items": {
            "type": "string"
          },
          "description": "Trace categories."
        }
      },
      "required": [],
      "additionalProperties": false
    }
  },
  {
    "name": "performance_stop_trace",
    "description": "Stop the in-process trace and write JSON; a live trace is required.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "lease": {
          "type": "string",
          "description": "Lease token; omit for a tab this process already holds. See server instructions."
        },
        "target": {
          "type": "string",
          "description": "Page selector (index:/url:/title:/label:/targetId, default active); grammar in server instructions."
        }
      },
      "required": [],
      "additionalProperties": false
    }
  },
  {
    "name": "performance_analyze_insight",
    "description": "Analyze a trace JSON file for key performance metrics; tracePath is required.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "lease": {
          "type": "string",
          "description": "Lease token; omit for a tab this process already holds. See server instructions."
        },
        "tracePath": {
          "type": "string",
          "description": "Trace JSON file path."
        }
      },
      "required": [],
      "additionalProperties": false
    }
  },
  {
    "name": "performance_trace",
    "description": "Run a one-shot trace with optional navigation and write JSON; durationMs controls capture time.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "lease": {
          "type": "string",
          "description": "Lease token; omit for a tab this process already holds. See server instructions."
        },
        "target": {
          "type": "string",
          "description": "Page selector (index:/url:/title:/label:/targetId, default active); grammar in server instructions."
        },
        "durationMs": {
          "type": "number",
          "description": "Capture duration in milliseconds."
        },
        "reload": {
          "type": "boolean",
          "description": "Reload before capture."
        },
        "navigateTo": {
          "type": "string",
          "description": "Navigation URL."
        },
        "categories": {
          "type": "array",
          "items": {
            "type": "string"
          },
          "description": "Trace categories."
        }
      },
      "required": [],
      "additionalProperties": false
    }
  },
  {
    "name": "start_screen_recording",
    "description": "Start a tab screen recording; stop it from the same process.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "lease": {
          "type": "string",
          "description": "Lease token; omit for a tab this process already holds. See server instructions."
        },
        "target": {
          "type": "string",
          "description": "Page selector (index:/url:/title:/label:/targetId, default active); grammar in server instructions."
        },
        "format": {
          "type": "string",
          "enum": [
            "jpeg",
            "png"
          ],
          "description": "Image/frame format."
        },
        "quality": {
          "type": "number",
          "description": "JPEG quality 0-100."
        },
        "maxWidth": {
          "type": "number",
          "description": "Maximum frame width."
        },
        "maxHeight": {
          "type": "number",
          "description": "Maximum frame height."
        },
        "everyNthFrame": {
          "type": "number",
          "description": "Capture every Nth frame."
        },
        "bringToFront": {
          "type": "boolean",
          "description": "Activate tab before recording."
        }
      },
      "required": [],
      "additionalProperties": false
    }
  },
  {
    "name": "stop_screen_recording",
    "description": "Stop a screen recording and encode MP4; target is required when multiple recordings exist.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "lease": {
          "type": "string",
          "description": "Lease token; omit for a tab this process already holds. See server instructions."
        },
        "target": {
          "type": "string",
          "description": "Page selector (index:/url:/title:/label:/targetId, default active); grammar in server instructions."
        },
        "savePath": {
          "type": "string",
          "description": "Output file path."
        }
      },
      "required": [],
      "additionalProperties": false
    }
  },
  {
    "name": "take_heapsnapshot",
    "description": "Capture a V8 heap snapshot to JSON; the snapshot is not parsed.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "lease": {
          "type": "string",
          "description": "Lease token; omit for a tab this process already holds. See server instructions."
        },
        "target": {
          "type": "string",
          "description": "Page selector (index:/url:/title:/label:/targetId, default active); grammar in server instructions."
        },
        "savePath": {
          "type": "string",
          "description": "Output file path."
        }
      },
      "required": [],
      "additionalProperties": false
    }
  },
  {
    "name": "lighthouse_audit",
    "description": "Run Lighthouse against a URL in its own tab; it does not audit a user tab.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "lease": {
          "type": "string",
          "description": "Lease token; omit for a tab this process already holds. See server instructions."
        },
        "url": {
          "type": "string",
          "description": "URL value."
        },
        "categories": {
          "type": "array",
          "items": {
            "type": "string"
          },
          "description": "Lighthouse categories to run (--only-categories)."
        },
        "savePath": {
          "type": "string",
          "description": "Output file path."
        },
        "formFactor": {
          "type": "string",
          "enum": [
            "desktop",
            "mobile"
          ],
          "description": "Lighthouse form factor."
        },
        "timeoutMs": {
          "type": "number",
          "description": "Timeout in milliseconds."
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
    "description": "Register a persistent request mock; urlPattern is required.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "lease": {
          "type": "string",
          "description": "Lease token; omit for a tab this process already holds. See server instructions."
        },
        "target": {
          "type": "string",
          "description": "Page selector (index:/url:/title:/label:/targetId, default active); grammar in server instructions."
        },
        "urlPattern": {
          "type": "string",
          "description": "URL glob (*, ?; \\ escapes)."
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
          "description": "Mock HTTP status."
        },
        "body": {
          "type": "string",
          "description": "Mock response body."
        },
        "contentType": {
          "type": "string",
          "description": "Response Content-Type."
        },
        "headers": {
          "type": "object",
          "description": "Extra response headers."
        },
        "errorReason": {
          "type": "string",
          "description": "CDP Network.ErrorReason, e.g. Failed|BlockedByClient|ConnectionRefused|TimedOut."
        },
        "method": {
          "type": "string",
          "description": "HTTP method."
        },
        "delayMs": {
          "type": "number",
          "description": "Artificial delay in milliseconds."
        },
        "failRate": {
          "type": "number",
          "description": "Failure probability 0..1."
        },
        "reload": {
          "type": "boolean",
          "description": "Reload before capture."
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
    "description": "List active request-mocking sessions and hit counts.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "lease": {
          "type": "string",
          "description": "Lease token; omit for a tab this process already holds. See server instructions."
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
    "description": "Clear the selected or all request-mocking sessions.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "lease": {
          "type": "string",
          "description": "Lease token; omit for a tab this process already holds. See server instructions."
        },
        "target": {
          "type": "string",
          "description": "Page selector (index:/url:/title:/label:/targetId, default active); grammar in server instructions."
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
    "description": "Claim an existing tab or open a fresh one; CLI use is refused.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "target": {
          "type": "string",
          "description": "Page selector (index:/url:/title:/label:/targetId, default active); grammar in server instructions."
        },
        "targetId": {
          "type": "string",
          "description": "Exact target ID."
        },
        "url": {
          "type": "string",
          "description": "URL value."
        },
        "label": {
          "type": "string",
          "description": "Agent lease label."
        },
        "ttlMs": {
          "type": "number",
          "description": "Lease TTL in milliseconds."
        }
      },
      "required": [],
      "additionalProperties": false
    }
  },
  {
    "name": "release_page",
    "description": "Release a page lease and optionally close its tab; provide lease or target.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "lease": {
          "type": "string",
          "description": "Lease token; omit for a tab this process already holds. See server instructions."
        },
        "target": {
          "type": "string",
          "description": "Page selector (index:/url:/title:/label:/targetId, default active); grammar in server instructions."
        },
        "close": {
          "type": "boolean",
          "description": "Override close behavior."
        }
      },
      "required": [],
      "additionalProperties": false
    }
  },
  {
    "name": "list_leases",
    "description": "List active leases for diagnosis without exposing lease tokens.",
    "inputSchema": {
      "type": "object",
      "properties": {},
      "required": [],
      "additionalProperties": false
    }
  }
];
