# River

River is a game dev harness for branching stories and game frames. It works with any engine.

- **Story map.** Stories are Twee 3 text files in your game repo. The map shows passages and branches, the path list shows every route to each ending, and the linter catches broken links, dead ends and conditions that can never be true.
- **Typed game state.** You declare variables once (`stories/state.json`). Passages and choices read them with `@when` and change them with `@set`.
- **Playtest and export.** Play a story as text with live state, then export JSON that your engine loads.
- **Frame review.** Capture deterministic shots from your engine, comment on a frame, and compare before and after.
- **In-app agent.** The agent drafts branches and writes change plans for frame comments. An implementer edits only the files that the approved plan names. Every turn starts from a git checkpoint.
- **MCP server.** `river-mcp` gives Claude Code the same tools.

River reads and writes Twee 3 and imports Twine 2 archives, using the published specs. It is not affiliated with Twine.

## Agent backends

The in-app agent runs in one of two ways. Pick one in Settings; the model can change on every turn.

- **Claude Code (your Claude sign-in).** River runs your own installed `claude` CLI ([install it](https://code.claude.com/docs/en/setup)) in headless mode. You sign in to Claude Code itself: the Sign in button opens a terminal running `claude auth login`, Anthropic's own flow. River never reads, stores or forwards your sign-in, and it removes `ANTHROPIC_API_KEY` and `ANTHROPIC_AUTH_TOKEN` from the CLI's environment so the CLI uses that sign-in. Settings shows only whether you are signed in and your plan type. The CLI runs without your user or project settings, with only River's MCP server and the Read, Glob and Grep tools. Each permission prompt goes to River through `river-mcp`'s `approval_prompt` tool.
- **Anthropic API key.** River runs the Claude Agent SDK with a key you paste in Settings. The key is encrypted with the system's secure storage.

Both use the same permission policy: reads stay inside the game repo, every write asks you first, and anything else is denied.

## Status

Early development. See `examples/park-walk` for a small story.

## Development

```sh
pnpm install
# if apps/desktop cannot find Electron, fetch its binary once:
#   node node_modules/.pnpm/electron@*/node_modules/electron/install.js
pnpm typecheck
pnpm test
pnpm river lint examples/park-walk
pnpm --filter @river/desktop build
pnpm --filter @river/desktop exec electron .   # RIVER_PROJECT=<game repo> to open one
```

## Licence

MIT
