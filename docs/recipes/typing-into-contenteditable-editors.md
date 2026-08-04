# Recipe: typing into rich-text `contenteditable` editors (Lexical, ProseMirror, Slate, Draft.js)

**Problem.** You call `fill` / `type_text` (or set `.textContent` and dispatch an
`input` event yourself) on a rich-text editor and the text either doesn't appear,
appears duplicated/garbled, or appears but the editor's own autosave / change
handlers never fire. Plain `<input>` and `<textarea>` are unaffected — this is
specific to **controlled `contenteditable` editors** where a framework owns the
editor state and treats the DOM as a *render target*, not the source of truth.

Lexical (Meta), ProseMirror, Slate, and Draft.js all work this way. They maintain
an internal document model; on every change they reconcile the real DOM back to
that model. If your text arrives through a path the editor doesn't recognise as a
real user edit, the reconciler **overwrites it** — so it vanishes or corrupts, and
no `onChange` / debounced-save fires.

## Root cause

The editor only mutates its internal model in response to **trusted input applied
at a real editor selection**. Two things have to be true:

1. **A real caret/selection must exist inside a text node of the editor** — set by a
   *trusted* `Input.dispatchMouseEvent` click, not by `element.focus()`. `focus()`
   alone does not give Lexical/ProseMirror a document selection to anchor an edit to,
   so a subsequent insert has nowhere to land.
2. **The text must arrive as trusted input** — `Input.insertText` or trusted key
   events. A synthetic `element.dispatchEvent(new InputEvent('input'))` is
   `isTrusted === false`; the editor ignores it and reconciles your `textContent`
   mutation away.

## What actually works

```
trusted mouse click (place the caret)  →  Input.insertText  →  text lands, onChange fires
```

Concretely, over raw CDP (the same primitives `cdp-toolkit`'s `click` and `fill`
use under the hood):

```jsonc
// 1. focus + get the editor's on-screen coordinates (aim ~30–40px in from the
//    left edge and ~14–18px down, so the click lands ON a text node, not padding)
Input.dispatchMouseEvent { "type":"mousePressed",  "x":X, "y":Y, "button":"left", "clickCount":1 }
Input.dispatchMouseEvent { "type":"mouseReleased", "x":X, "y":Y, "button":"left", "clickCount":1 }

// 2. now a real selection exists — insert trusted text
Input.insertText { "text":"the note body" }
```

With `cdp-toolkit` this is: `click` the editor first (which sends the trusted
`dispatchMouseEvent`), **then** `fill` / `type_text` (which sends `Input.insertText`).
The ordering is the whole trick — `fill` on its own, without a preceding trusted
click that seats the caret in a text node, is the failure case.

## Measured behaviour (Lexical playground, `playground.lexical.dev`)

Three input methods, same editor, caret pre-seated with a trusted click where noted:

| Method | Result |
|---|---|
| **Synthetic** — `el.textContent = 'X'; el.dispatchEvent(new InputEvent('input'))` | ❌ Duplicated / orphaned text (`"XX"`, wrong position); on some apps nothing renders at all and the reconciler clears it. `onChange` does **not** fire. |
| **`Input.insertText`** after a **trusted click** | ✅ Clean single insertion at the caret; `onChange` / autosave fires. **Use this.** |
| **`Input.insertText`** after only `element.focus()` (no trusted click, empty editor) | ❌ No text — there is no selection to insert at. |
| **Per-char keys sending BOTH `keyDown{text}` AND a separate `char` event** | ❌ Every character **doubled** (`"KKEEYYSS"`). |

### The doubling gotcha

If you drive keystrokes manually, send **either** a `keyDown` carrying `text`
**or** a separate `char` event — **never both**. Chromium turns a `keyDown` that
carries `text` into a character insertion on its own; adding an explicit `char`
event inserts it a second time. `cdp-toolkit`'s `press_key` and `fill` already do
the right thing; this only bites hand-rolled `Input.dispatchKeyEvent` sequences.

## Why `fill`'s "atomic paste, not per-character" note matters here

The tool table flags that `fill` / `type_text` use `Input.insertText` — an atomic,
paste-like commit rather than per-character keystrokes. For a controlled
`contenteditable` that's the *right* primitive (it goes through the trusted input
path), **provided the caret is already seated**. The per-character-handler caveat
(input masks, per-key listeners) is real for plain inputs but is not what breaks
rich-text editors — the missing trusted selection is.

## If you must faithfully replay a rich-text edit

Prefer capturing and replaying the **application's own save request** over
re-typing the text. Controlled editors debounce-POST their content (e.g. an
autosave endpoint); that network write is a far more faithful replay unit than
reconstructing keystrokes, and it sidesteps the selection/trust problem entirely.
Re-typing is best reserved for interactive driving where a human-visible result in
the editor is the goal.

## Quick self-check

Before assuming the editor is broken, verify the two preconditions:

```jsonc
// after your trusted click, confirm a real selection exists inside the editor:
evaluate_script { "expression":
  "(()=>{const s=getSelection();const a=document.activeElement;return {ranges:s.rangeCount, anchor:s.anchorNode&&s.anchorNode.nodeName, contentEditable:a&&a.isContentEditable};})()" }
// want: { ranges: 1, anchor: "#text", contentEditable: true }
```

`ranges: 0` or `anchor` not a `#text` node means the click didn't seat a caret —
re-aim it further into the visible text, then insert.
