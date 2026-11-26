# River

River is a game dev harness for branching stories and game frames. It works with any engine.

- **Story map & narrative craft.** Stories are Twee 3 text files in your game repo. The map shows passages and branches with inline add/rename/tag/delete editing, the path list shows routes and interrupts, the linter checks both structure and narrative craft (Chekhov's Gun unused variables, copy budgets, duplicate copy, reachability from initial state), and `river simulate` runs Monte Carlo playtests to chart ending and state distributions.
- **Typed game state & reactive Twee3+.** Declare variables once (`stories/state.json`, with `engine: true` for game-driven meters). Passages and choices support `@when`, `@set`, `@cost`, `@hint`, `@once`, `@meta`, `@shot`, `@cue`, inline reactive templates (`{when cond: a | b}`, `{var}`, `{once: ...}`, `{cycle: ...}`, `{shuffle: ...}`), visit memory (`visited(id)`, `visits(id)`), `[interrupt]` / `@auto` global transitions, and `[storylet]` encounter decks (`@weight`, `@priority`, `@cooldown`).
- **Playtest, table read & engine runtime.** Play a story live with interrupts and template rendering, run `river pacing` / `river table-read`, export JSON for your engine, or drop in River's official Godot 4 runtime addon (`river godot install-runtime`).
- **Frame review & visual diff.** Capture deterministic shots from Godot (single-process batch capture for `--all`) or any custom engine (`adapter.<engine>.command`), scrub/loop multi-frame flipbooks, compare Before/After with Side-by-side, Swipe, Onion-skin, or pixel Diff overlays, comment on frames, and drive change plans.
- **In-app agent & writing jobs.** Streaming chat across Story, Plan, and Implement modes with configurable models (`Opus 5.5`, `Sonnet 5.5`, `Haiku 4.5`, or custom IDs), `.river/brief.md` + `.river/voice.md` taste memory, and Canvas Writing Jobs that draft A/B/C passage takes in isolated git worktrees with an automated Table Read pass.
- **MCP server.** `river-mcp` exposes 44 tools (scoped passage reads, batch edits, playtesting, simulation, pacing, table reads, voice bible, storyboard, concept & writing jobs, and batch frame capture) to Claude Code and other MCP clients.

River reads and writes Twee 3 and imports Twine 2 archives, using the published specs. It is not affiliated with Twine.

## Agent backends

The in-app agent runs in one of two ways. Pick one in Settings; the model can change on every turn.

- **Claude Code (your Claude sign-in).** River runs your own installed `claude` CLI ([install it](https://code.claude.com/docs/en/setup)) in headless mode. You sign in to Claude Code itself: the Sign in button opens a terminal running `claude auth login`, Anthropic's own flow. River never reads, stores or forwards your sign-in, and it removes `ANTHROPIC_API_KEY` and `ANTHROPIC_AUTH_TOKEN` from the CLI's environment so the CLI uses that sign-in. Settings shows only whether you are signed in and your plan type. The CLI runs without your user or project settings, with only River's MCP server and the Read, Glob and Grep tools. Each permission prompt goes to River through `river-mcp`'s `approval_prompt` tool.
- **Anthropic API key.** River runs the Claude Agent SDK with a key you paste in Settings. The key is encrypted with the system's secure storage.

Both use the same permission policy: reads stay inside the game repo, every write asks you first, and anything else is denied.

## Storyboard, marks and agents

The storyboard is a canvas of passage cards, notes and images. You leave requests on it as marks: circle a card and write what you want. Agents answer beside the mark, with an arrow from your request to their answer:

- **River's concept artist** answers "draw it" requests with options drawn by small Godot scripts. You read the scripts in a separate review window and approve them there before anything runs. Every line is the agent's code and runs on your computer with your permissions once you approve; `Kit.name(...)` calls use River's drawing helpers, but River cannot prove a script only draws, so read all of it. Then keep the options you like or dismiss the answer with a reason that goes into `.river/brief.md`.
- **River's story writer** answers passage marks with 2–3 distinct A/B/C takes in a worktree, runs a Table Read self-check, and lays out diff + preview cards beside the mark. Accepted takes record exemplars and dismissed takes record cut reasons in `.river/voice.md`.
- **Claude Code**, through `river-mcp`, takes the other requests: it claims a mark, reads the story, brief, and voice bible, answers with notes and images, and hands drawing or writing requests to the concept artist or story writer. See [packages/mcp/README.md](packages/mcp/README.md) to set it up, including on Windows and for headless `claude -p` runs.

From the terminal: `river lint`, `river pacing`, `river table-read`, `river simulate`, `river voice`, `river godot install-runtime`, `river capture --all`, `river checkpoints prune`, `river card add`, `river mark ...`, `river job ...`, and `river write-job ...` (`pnpm river --help` lists them all).

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
