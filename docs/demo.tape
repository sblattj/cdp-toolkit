# cdp-toolkit demo: a 30-second terminal cast of driving named Chrome tabs over raw CDP.
#
# Render:  vhs docs/demo.tape          → writes docs/demo.gif (referenced by the README)
# Install: brew install vhs            (https://github.com/charmbracelet/vhs)
# Prereq:  a DEDICATED, throwaway Chrome/Chromium for recording only, never your
#          daily-driver browser, with --remote-debugging-port matching the hidden
#          `export CDP_BASE=...` line below (currently a scratch port, not 9222,
#          since 9222 is commonly someone's live browser):
#            open -a "Google Chrome" --args --headless=new --remote-debugging-port=9414 \
#              --user-data-dir=/tmp/cdp-toolkit-demo-chrome
#          and `bun install` already run in this checkout.
#
# Tip for the strongest demo: instead of the CLI below, screen-record a real
# Claude Code session calling mcp__cdp-toolkit__take_snapshot and
# mcp__cdp-toolkit__mock_request, since that shows the value in the exact context
# the target audience uses it.

Output docs/demo.gif

Set Shell bash
Set FontSize 18
Set Width 1200
Set Height 760
Set Padding 24
Set Theme "Dracula"
Set TypingSpeed 45ms

# Point the CLI at the dedicated recording Chrome above, not whatever's on 9222.
# `clear` before Show: Hide only skips capturing frames, it does not erase the
# pty's own scrollback, so the export line would otherwise still be visible
# once recording resumes.
Hide
Type "export CDP_BASE=http://127.0.0.1:9414"
Enter
Sleep 500ms
Type "clear"
Enter
Sleep 300ms
Show

Type "# cdp-toolkit: drive the Chrome tabs you name over raw CDP, no fan-out, no hang"
Enter
Sleep 1200ms

Type "bun run src/cli.ts navigate_page --target index:0 --url https://example.com"
Enter
Sleep 2500ms

Type "# read the page as an accessibility tree (stateless uid = backendDOMNodeId)"
Enter
Sleep 800ms
Type "bun run src/cli.ts take_snapshot --target url:example --interactiveOnly true"
Enter
Sleep 2800ms

Type "# build a UI before its backend exists, mock the API and reload"
Enter
Sleep 800ms
Type `bun run src/cli.ts mock_request --urlPattern '*/api/*' --body '{"results":[]}' --reload true`
Enter
Sleep 3000ms

Type "# 45 tools, one direct WebSocket per call, a bounded timeout on every call."
Enter
Sleep 2200ms
