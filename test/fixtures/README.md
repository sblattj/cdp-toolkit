# test/fixtures

Static HTML pages used by both the CDP and BiDi driver tests, so the same
fixture exercises Chrome and Firefox identically. No external requests, no
CDN scripts, no frameworks, no build step: every fixture renders identically
opened straight from disk.
## Files

- `form.html`: text input (prefilled, exercises clear-then-type), textarea,
  select, checkbox, radio group, submit button, `#result` element updated on
  submit. Every control has a stable `id` and `data-testid`.
- `contenteditable.html`: two `contenteditable` divs (prefilled and empty)
  plus `#live-mirror`, which reflects their real text content, so a test
  asserts what landed instead of reading back the node it just wrote.

## Loading rule

Firefox's default `about:home` context rejects a direct `data:` URL
navigation with `unsupported operation`. Create a fresh browsing context
first, then navigate to a `file://` or served URL.

## Rule

Fixtures stay static and dependency-free: no bundler, no CDN script, no
fetch to an external host. Dynamic behavior belongs inline in the fixture.
