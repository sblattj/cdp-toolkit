/**
 * Firefox accessibility-style snapshot, built by walking the live DOM in-page.
 *
 * Chrome gets take_snapshot for free from Accessibility.getFullAXTree. BiDi
 * has no equivalent domain at all, so this module assembles the same shape
 * of output (see src/tools/snapshot.ts, the format spec) by generating a
 * self-contained JavaScript function SOURCE and handing it to whatever
 * `evaluate` the caller supplies. This file never opens a socket and never
 * imports a transport: takeStampedSnapshot is testable with a fake evaluate,
 * which is the whole point of the split (driver.ts owns BiDi wiring).
 *
 * Per ADR-001 (src/driver.ts), Firefox uids are PAGE STATE, not protocol
 * state: every emitted node gets a stamp written onto it as the STAMP_ATTR
 * attribute, and that stamp (not a script/browsingContext handle) is what
 * survives a dropped socket, a fresh session, and a fresh CLI process.
 */

/** Attribute stamped onto every emitted element, mirroring driver.ts UID_STAMP_ATTR. */
export const STAMP_ATTR = "data-cdp-uid";

export interface StampedSnapshot {
  snapshot: string;
  nodeCount: number;
}

/**
 * Take a snapshot of the current page by evaluating a generated JS function
 * in it. `evaluate` is handed the function SOURCE, not a closure: the source
 * is stringified and must not reference anything outside itself. It must
 * resolve to whatever that function returns.
 */
export async function takeStampedSnapshot(
  evaluate: (functionDeclaration: string) => Promise<unknown>,
): Promise<StampedSnapshot> {
  const raw = await evaluate(buildSnapshotFunctionSource());
  return coerceSnapshotResult(raw);
}

/** Validate + narrow the untyped evaluate() return into a StampedSnapshot. */
export function coerceSnapshotResult(raw: unknown): StampedSnapshot {
  if (
    typeof raw !== "object" ||
    raw === null ||
    typeof (raw as { snapshot?: unknown }).snapshot !== "string" ||
    typeof (raw as { nodeCount?: unknown }).nodeCount !== "number"
  ) {
    throw new Error("takeStampedSnapshot: evaluate() returned an unexpected shape");
  }
  return { snapshot: (raw as StampedSnapshot).snapshot, nodeCount: (raw as StampedSnapshot).nodeCount };
}

/**
 * The in-page function source. Zero-argument, self-contained: no closures
 * over TypeScript scope, no imports, nothing but plain DOM/ARIA calls that
 * exist in every browser this ships against. Kept as one string builder
 * (rather than a literal template) so MAX_NAME_LENGTH and the STAMP_ATTR
 * value are injected once instead of duplicated between TS and JS.
 */
export function buildSnapshotFunctionSource(): string {
  return `function() {
    var STAMP_ATTR = ${JSON.stringify(STAMP_ATTR)};
    var MAX_NAME_LENGTH = ${MAX_NAME_LENGTH};
    var lines = [];
    var nodeCount = 0;

    // THE UID CODEC (driver.ts) documents a bidi payload as exactly 12 lowercase hex chars,
    // /^[0-9a-f]{12}$/. Build it from two padded random blocks so the length is exact regardless
    // of the random value drawn, never from string concatenation that could come up short.
    function nextStamp() {
      var hi = Math.floor(Math.random() * 0x100000000).toString(16).padStart(8, "0");
      var lo = Math.floor(Math.random() * 0x10000).toString(16).padStart(4, "0");
      return hi + lo;
    }

    function stampOf(el) {
      var existing = el.getAttribute(STAMP_ATTR);
      if (existing) return existing;
      var stamp = nextStamp();
      el.setAttribute(STAMP_ATTR, stamp);
      return stamp;
    }

    // skipSizeCheck exempts <option>/<optgroup> from the zero-size prune: a
    // closed select's popup is unpainted (0x0) though its options are still
    // present and pickable. Other visibility rules still apply to them.
    function isVisible(el, skipSizeCheck) {
      if (el.hidden) return false;
      if (el.getAttribute("aria-hidden") === "true") return false;
      var style;
      try {
        style = el.ownerDocument.defaultView.getComputedStyle(el);
      } catch (e) {
        style = null;
      }
      if (style) {
        if (style.display === "none" || style.visibility === "hidden") return false;
      }
      if (!skipSizeCheck) {
        var rect = el.getBoundingClientRect();
        if (rect.width === 0 && rect.height === 0) return false;
      }
      return true;
    }

    function truncate(s) {
      s = s.trim().replace(/\\s+/g, " ");
      if (s.length > MAX_NAME_LENGTH) return s.slice(0, MAX_NAME_LENGTH - 1) + "\\u2026";
      return s;
    }

    function textOf(el) {
      return el.textContent || "";
    }

    function idRefsText(doc, ids) {
      var parts = [];
      var list = ids.trim().split(/\\s+/);
      for (var i = 0; i < list.length; i++) {
        var ref = doc.getElementById(list[i]);
        if (ref) parts.push(textOf(ref));
      }
      return parts.join(" ").trim();
    }

    // Text of a <label>, minus any nested form control's own content: a
    // label that WRAPS its control ("<label>Color <select>...</select></label>")
    // would otherwise include every option's text in the control's own name.
    function labelOwnText(label) {
      var clone = label.cloneNode(true);
      var controls = clone.querySelectorAll("input, select, textarea, button");
      for (var i = 0; i < controls.length; i++) {
        controls[i].parentNode.removeChild(controls[i]);
      }
      return textOf(clone);
    }

    // Guard: without this, an <option> inside a labelled <select> would
    // inherit the select's own label via closest("label"), not its text.
    var LABELABLE_TAGS = { INPUT: 1, TEXTAREA: 1, SELECT: 1, BUTTON: 1, METER: 1, OUTPUT: 1, PROGRESS: 1 };

    function nativeLabelText(el) {
      if (!LABELABLE_TAGS[el.tagName]) return "";
      var doc = el.ownerDocument;
      if (el.id) {
        var forLabel = doc.querySelector('label[for="' + el.id + '"]');
        if (forLabel) return labelOwnText(forLabel);
      }
      var ancestor = el.closest ? el.closest("label") : null;
      if (ancestor) return labelOwnText(ancestor);
      return "";
    }

    // Reduced accname: aria-labelledby, then aria-label, then native label,
    // then alt/title/placeholder, then trimmed own text for content-named
    // elements. Not the full W3C accname algorithm (no recursive traversal
    // rules for nested presentational content) but covers the common cases.
    function accessibleName(el, contentNamed) {
      var doc = el.ownerDocument;
      var labelledby = el.getAttribute("aria-labelledby");
      if (labelledby) {
        var viaIds = idRefsText(doc, labelledby);
        if (viaIds) return truncate(viaIds);
      }
      var ariaLabel = el.getAttribute("aria-label");
      if (ariaLabel && ariaLabel.trim()) return truncate(ariaLabel);
      var native = nativeLabelText(el);
      if (native && native.trim()) return truncate(native);
      var alt = el.getAttribute("alt");
      if (alt && alt.trim()) return truncate(alt);
      var title = el.getAttribute("title");
      if (title && title.trim()) return truncate(title);
      var placeholder = el.getAttribute("placeholder");
      if (placeholder && placeholder.trim()) return truncate(placeholder);
      if (contentNamed) {
        var text = textOf(el);
        if (text && text.trim()) return truncate(text);
      }
      return "";
    }

    var IMPLICIT_ROLE_BY_TAG = {
      A: "link", BUTTON: "button", NAV: "navigation", MAIN: "main", FORM: "form", DIALOG: "dialog",
      UL: "list", OL: "list", LI: "listitem", TABLE: "table", TR: "row", TD: "cell", TH: "columnheader",
      SELECT: "combobox", OPTION: "option", TEXTAREA: "textbox", IMG: "img",
      H1: "heading", H2: "heading", H3: "heading", H4: "heading", H5: "heading", H6: "heading",
      PROGRESS: "progressbar", METER: "meter"
    };

    var INPUT_TYPE_ROLE = {
      button: "button", submit: "button", reset: "button", checkbox: "checkbox", radio: "radio",
      range: "slider", number: "spinbutton", search: "searchbox", email: "textbox", tel: "textbox",
      url: "textbox", password: "textbox", text: "textbox", image: "button"
    };

    var CONTENT_NAMED_ROLES = {
      button: true, link: true, heading: true, option: true, cell: true,
      columnheader: true, listitem: true, menuitem: true, tab: true
    };

    function implicitRole(el) {
      var explicit = el.getAttribute("role");
      if (explicit) return explicit;
      var tag = el.tagName;
      if (tag === "INPUT") {
        var type = (el.getAttribute("type") || "text").toLowerCase();
        return INPUT_TYPE_ROLE[type] || "textbox";
      }
      if (tag === "A" && !el.getAttribute("href")) return "";
      if (Object.prototype.hasOwnProperty.call(IMPLICIT_ROLE_BY_TAG, tag)) {
        return IMPLICIT_ROLE_BY_TAG[tag];
      }
      // Deliberate divergence: Chrome's real AX tree says "generic" here,
      // but "textbox" is the useful signal an agent needs. Chrome is out of
      // step, do not "fix" this toward parity.
      if (el.isContentEditable) return "textbox";
      return "";
    }

    function headingLevel(el) {
      var m = /^H([1-6])$/.exec(el.tagName);
      return m ? m[1] : null;
    }

    function currentValue(el) {
      var tag = el.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") {
        return el.value;
      }
      if (el.isContentEditable) return textOf(el);
      return undefined;
    }

    function isChecked(el) {
      var tag = el.tagName;
      if (tag === "INPUT") {
        var type = (el.getAttribute("type") || "").toLowerCase();
        if (type === "checkbox" || type === "radio") return !!el.checked;
      }
      var aria = el.getAttribute("aria-checked");
      if (aria === "true") return true;
      return false;
    }

    function describeNode(el, role) {
      var contentNamed = !!CONTENT_NAMED_ROLES[role];
      var name = accessibleName(el, contentNamed);
      var extras = [];
      var value = currentValue(el);
      if (value !== undefined && value !== "") extras.push("value=" + JSON.stringify(String(value)));
      if (isChecked(el)) extras.push("checked=true");
      if (el.tagName === "OPTION" && el.selected) extras.push("selected");
      var href = el.getAttribute("href");
      if (href) extras.push("url=" + href);
      if (el.disabled || el.getAttribute("aria-disabled") === "true") extras.push("disabled");
      var level = headingLevel(el);
      if (level) extras.push("level=" + level);
      var label = name ? " " + JSON.stringify(name) : "";
      var extra = extras.length ? " [" + extras.join(" ") + "]" : "";
      return { role: role, label: label, extra: extra, name: name };
    }

    // Traverses light DOM, open shadow roots, and same-origin iframe documents.
    // A cross-origin iframe throws on contentDocument access; caught and
    // skipped rather than aborting the whole walk, and noted in a comment
    // here rather than silently vanishing from the tree without a trace.
    function walk(root, depth) {
      var children = root.children ? Array.prototype.slice.call(root.children) : [];
      for (var i = 0; i < children.length; i++) {
        var el = children[i];
        var isSelectChild = el.tagName === "OPTION" || el.tagName === "OPTGROUP";
        if (!isVisible(el, isSelectChild)) continue;

        var role = implicitRole(el);
        var isLandmarkOrControl = !!role;
        var described = null;
        if (isLandmarkOrControl) {
          described = describeNode(el, role);
        }

        var hasContent = described && (described.name || described.extra);
        var isStructural = isLandmarkOrControl && (hasContent || isInteractiveRole(role) || isLandmarkRole(role));

        // Role-less visible leaf text (measured vs Chrome's take_snapshot,
        // which keeps a StaticText under a generic wrapper for this case,
        // e.g. a plain status <div>). Only a leaf (no element children, so
        // its text is not already captured by a nested control/label).
        var hasElementChildren = !!(el.children && el.children.length > 0);
        var leafName = !isStructural && !hasElementChildren ? truncate(textOf(el)) : "";
        var isLeafText = !!leafName;

        var nextDepth = depth;
        if (isStructural || isLeafText) {
          var stamp = stampOf(el);
          var indent = new Array(depth + 1).join("  ");
          var lineTail = isStructural
            ? described.role + described.label + described.extra
            : "text " + JSON.stringify(leafName);
          lines.push(indent + "[" + stamp + "] " + lineTail);
          nodeCount += 1;
          nextDepth = depth + 1;
        }

        if (el.shadowRoot) {
          walk(el.shadowRoot, nextDepth);
        } else if (el.tagName === "IFRAME") {
          try {
            var doc = el.contentDocument;
            if (doc && doc.body) walk(doc.body, nextDepth);
          } catch (e) {
            // cross-origin iframe: intentionally skipped, not silently merged
            // into the parent tree as though it were empty.
          }
        } else {
          walk(el, nextDepth);
        }
      }
    }

    function isInteractiveRole(role) {
      return (
        role === "button" ||
        role === "link" ||
        role === "textbox" ||
        role === "searchbox" ||
        role === "checkbox" ||
        role === "radio" ||
        role === "combobox" ||
        role === "listbox" ||
        role === "option" ||
        role === "slider" ||
        role === "spinbutton" ||
        role === "progressbar" ||
        role === "meter"
      );
    }

    function isLandmarkRole(role) {
      return (
        role === "navigation" ||
        role === "main" ||
        role === "form" ||
        role === "dialog" ||
        role === "region" ||
        role === "heading" ||
        role === "list" ||
        role === "listitem" ||
        role === "table" ||
        role === "row" ||
        role === "cell" ||
        role === "columnheader" ||
        role === "img"
      );
    }

    walk(document.body, 0);
    return { snapshot: lines.join("\\n"), nodeCount: nodeCount };
  }`;
}

/** Truncation length applied to accessible names, shared by TS tests and the JS source above. */
export const MAX_NAME_LENGTH = 120;

/* -------------------------- pure helpers (unit-testable) -------------------------- */

/**
 * Mirrors the in-page stamp-reuse rule: reuse a stamp an element already
 * carries so a second snapshot in the same document does not renumber uids
 * the caller may still be holding from the first one.
 */
export function reuseOrMintStamp(existing: string | undefined, mint: () => string): string {
  return existing && existing.length > 0 ? existing : mint();
}

/** Same truncation rule the in-page source applies to accessible names. */
export function truncateName(raw: string, maxLength: number = MAX_NAME_LENGTH): string {
  const collapsed = raw.trim().replace(/\s+/g, " ");
  if (collapsed.length > maxLength) return `${collapsed.slice(0, maxLength - 1)}…`;
  return collapsed;
}

/** Assembles one Chrome-format tree line, matching src/tools/snapshot.ts's formatNode shape. */
export function formatSnapshotLine(
  uid: string,
  role: string,
  name: string | undefined,
  extras: string[],
  depth: number,
): string {
  const indent = "  ".repeat(depth);
  const label = name ? ` ${JSON.stringify(name)}` : "";
  const extra = extras.length ? ` [${extras.join(" ")}]` : "";
  return `${indent}[${uid}] ${role}${label}${extra}`;
}

/*
 * DOM APIs used by the generated in-page function: getComputedStyle,
 * getBoundingClientRect, getAttribute/setAttribute, closest, getElementById,
 * shadowRoot, contentDocument. No CDP or BiDi calls happen in this file at
 * all; the transport is entirely the caller's `evaluate` parameter.
 * Parity gaps vs Chrome's Accessibility.getFullAXTree:
 *   - Role coverage is a deliberate subset (interactive controls + the
 *     landmark/heading/list/table roles that matter for driving a page), not
 *     the full HTML-AAM/ARIA-AAM mapping Chrome's native tree implements.
 *   - Name computation is a reduced accname order (labelledby, label,
 *     native label, alt/title/placeholder, content text) and skips the
 *     full recursive "name from content" traversal rules for nested
 *     presentational descendants.
 *   - Shadow DOM: open shadow roots are walked; closed shadow roots are
 *     invisible to this code by construction (no API reaches them).
 *   - Iframes: same-origin iframes are walked; cross-origin iframes are
 *     skipped (contentDocument throws) rather than silently merged in.
 *   - Stamps are minted with Math.random(), not a CSPRNG; adequate for
 *     page-local uniqueness, not adequate as a security token.
 *   - Role-less visible leaf text (e.g. a plain status <div>) is emitted as
 *     a synthetic "text" role, matching a measured behavior of Chrome's
 *     take_snapshot (StaticText under a generic wrapper); a non-leaf
 *     element's own direct text (siblings of nested elements) is not
 *     walked, so mixed inline content only surfaces its element children.
 */
