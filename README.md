# River

River is a game dev harness for branching stories and game frames. It works with any engine.

- **Story map.** Stories are Twee 3 text files in your game repo. The map shows passages and branches, the path list shows every route to each ending, and the linter catches broken links, dead ends and conditions that can never be true.
- **Typed game state.** You declare variables once (`stories/state.json`). Passages and choices read them with `@when` and change them with `@set` and `@cost`; variables the game moves on its own are marked `engine`.
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

## Storyboard, marks and agents

The storyboard is a canvas of passage cards, notes and images. You leave requests on it as marks: circle a card and write what you want. Agents answer beside the mark, with an arrow from your request to their answer:

- **River's concept artist** answers "draw it" requests with options drawn by small Godot scripts. You read and approve the scripts before anything runs, then keep the options you like or dismiss the answer with a reason that goes into `.river/brief.md`.
- **Claude Code**, through `river-mcp`, takes the other requests: it claims a mark, reads the story and the brief, answers with notes and images, and hands drawing requests to the concept artist. See [packages/mcp/README.md](packages/mcp/README.md) to set it up, including on Windows and for headless `claude -p` runs.

From the terminal: `river card add`, `river mark add`, `river mark reply`, `river board show` and `river job ...` (`pnpm river --help` lists them).

## Set up a game

[docs/godot-setup.md](docs/godot-setup.md) makes an existing Godot repo a River project: `river.json`, the state schema, shots and their setup scripts, what to commit and what to ignore, and the story rules (`@when`, `@set`, `@cost`, `@hint`, `*=`, engine variables, `[interrupt]` passages and `@return`).

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
