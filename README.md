# River

River is a game dev harness for branching stories and game frames. It works with any engine.

- **Story map.** Stories are Twee 3 text files in your game repo. The map shows passages and branches, the path list shows every route to each ending, and the linter catches broken links, dead ends and conditions that can never be true.
- **Typed game state.** You declare variables once (`stories/state.json`). Passages and choices read them with `@when` and change them with `@set`.
- **Playtest and export.** Play a story as text with live state, then export JSON that your engine loads.
- **Frame review.** Capture deterministic shots from your engine, comment on a frame, and compare before and after.
- **In-app agent.** The agent drafts branches and writes change plans for frame comments. An implementer edits only the files that the approved plan names. Every turn starts from a git checkpoint.
- **MCP server.** `river-mcp` gives Claude Code the same tools.

River reads and writes Twee 3 and imports Twine 2 archives, using the published specs. It is not affiliated with Twine.

## Status

Early development. See `examples/park-walk` for a small story.

## Development

```sh
pnpm install
pnpm typecheck
pnpm test
pnpm river lint examples/park-walk
```

## Licence

MIT
