# cdp-toolkit demo — a 30-second terminal cast of driving one Chrome tab over raw CDP.
#
# Render:  vhs docs/demo.tape          → writes docs/demo.gif (referenced by the README)
# Install: brew install vhs            (https://github.com/charmbracelet/vhs)
# Prereq:  a Chrome/Chromium running with --remote-debugging-port=9222
#            open -a "Google Chrome" --args --remote-debugging-port=9222
#          and `bun install` already run in this checkout.
#
# Tip for the strongest demo: instead of the CLI below, screen-record a real
# Claude Code session calling mcp__cdp-toolkit__take_snapshot and
# mcp__cdp-toolkit__mock_request — that shows the value in the exact context
# the target audience uses it.

Output docs/demo.gif

Set Shell bash
Set FontSize 18
Set Width 1200
Set Height 760
Set Padding 24
Set Theme "Dracula"
Set TypingSpeed 45ms

Type "# cdp-toolkit: drive ONE known Chrome tab over raw CDP — no fan-out, no hang"
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

Type "# build a UI before its backend exists — mock the API and reload"
Enter
Sleep 800ms
Type `bun run src/cli.ts mock_request --urlPattern '*/api/*' --body '{"results":[]}' --reload true`
Enter
Sleep 3000ms

Type "# 33 tools, one direct WebSocket, a bounded timeout on every call."
Enter
Sleep 2200ms
