<!-- Thanks for contributing to cdp-toolkit! Keep PRs focused and small where possible. -->

## What & why

<!-- What does this change, and what problem does it solve? Link any issue: Closes #123 -->

## Type

- [ ] Bug fix (a tool returns wrong/incomplete data, or a parity gap)
- [ ] New tool / capability
- [ ] Docs / examples
- [ ] Internal / refactor (no behavior change)

## Checklist

- [ ] `bun run typecheck` passes
- [ ] `bun test` passes
- [ ] If a tool changed, I updated its module footer comment (CDP methods + parity gaps) and the README tool table
- [ ] If it touches CDP behavior, I ran the relevant smoke against a real Chrome (`bun run smoke` / `bun run mock:smoke` / `bun run mcp:smoke`)
- [ ] Change is consistent with the design rules in [`CONTRACT.md`](../CONTRACT.md)

## Notes for reviewers

<!-- Anything non-obvious: a tradeoff, a CDP quirk, a parity decision. -->
