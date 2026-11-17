# river-mcp

The River MCP server (stdio, server name `river`). It gives Claude Code, or any MCP client, the River tools for one game repo: reading and linting stories, playtesting, listing frames and review threads, saving change plans, and editing only the files an approved plan names.

## Add it to Claude Code

Run this from your game repo. Replace `<repo>` with this repository's path and `<game repo>` with the folder that has `river.json`:

```sh
claude mcp add river -- npx tsx <repo>/packages/mcp/src/main.ts --root <game repo>
```

On native Windows (not WSL), wrap `npx` in `cmd /c`:

```sh
claude mcp add river -- cmd /c npx tsx <repo>/packages/mcp/src/main.ts --root <game repo>
```

Everything after `--` is the server command. Add `-s project` to write the entry to `.mcp.json`, so the whole team gets it, or `-s user` to use it in every project. Check it with `claude mcp list`. The tools show up as `mcp__river__<name>`.

## Options

```
river-mcp --root <dir> [--tools name,name,...] [--approval-pipe <name>] [--concept <id>]
```

- `--root` is required. It is the game repo, the folder with `river.json`.
- `--tools` serves only the tools you name. The default is all 17, plus `concept_write` with `--concept`.
- `--approval-pipe` is for the River app only. It adds `approval_prompt`, the tool Claude Code calls for permission prompts (`--permission-prompt-tool mcp__river__approval_prompt`). The tool asks the River app over that local named pipe or socket, and denies on any error or timeout. It is never one of the `--tools`.
- `--concept` is for River's concept jobs. It adds `concept_write`, which writes only in `concepts/<id>/`. Without it, asking for `concept_write` in `--tools` is an error.

Read-only tools: `project_info`, `story_list`, `story_read`, `story_lint`, `story_paths`, `playtest_run`, `frames_list`, `review_list`, `plan_list`, `plan_read`.

Tools that write: `story_write_passage`, `story_add_passage`, `review_reply`, `plan_save`, `implement_edit`, `plan_mark_implemented`, `frames_capture`, `concept_write` (only with `--concept`).

## Safety

- Every path is relative to `--root`, and the server never writes outside it.
- The story tools write only story files.
- `implement_edit` runs only for a plan with status `approved`, and only on a file that the plan's steps name and that matches the `editable` globs in `river.json`. The `oldText` you pass must match exactly once.
- `concept_write` writes only inside `concepts/<id>/`, and the only script it takes is `concepts/<id>/draw.gd`. For that file it returns the concept lint problems. River runs nothing it writes until the user approves the script's exact bytes.
- Errors come back as MCP tool errors (`isError: true`). They do not stop the server.

## Use it in-process

`createRiverTools(project, opts)` returns the same tools as plain objects, each with `name`, `description`, `inputSchema` (a zod raw shape), `mutating` and `handler`. Use it when you want the tools without stdio.
