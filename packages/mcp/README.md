# river-mcp

The River MCP server (stdio, server name `river`). It gives Claude Code, or any MCP client, the River tools for one game repo. With them an agent can read and lint stories, playtest, list frames and review threads, save change plans, and edit only the files an approved plan names. It can also work the storyboard: find the requests the user drew, claim one, and answer beside it with notes, images and arrows, or ask River's concept artist to draw the answer.

## Add it to Claude Code

The simplest setup is a `.mcp.json` in your game repo, the folder that has `river.json`. Replace `<river>` with the path of this repository:

```json
{
  "mcpServers": {
    "river": {
      "command": "npx",
      "args": ["tsx", "<river>/packages/mcp/src/main.ts", "--root", ".", "--author", "claude-code"]
    }
  }
}
```

On native Windows (not WSL), use `"command": "cmd"` and put `"/c", "npx"` in front of the args. Claude Code asks you once to approve a project server from `.mcp.json`.

Or add it with `claude mcp add`, from the game repo. `-s project` writes the same `.mcp.json`:

```sh
claude mcp add -s project river -- npx tsx <river>/packages/mcp/src/main.ts --root . --author claude-code
```

On native Windows, wrap `npx` in `cmd /c`. In PowerShell:

```powershell
claude mcp add -s project river -- cmd /c npx tsx <river>/packages/mcp/src/main.ts --root . --author claude-code
```

In Git Bash, MSYS rewrites `/c` into a drive path (`C:/`), which breaks `cmd /c`. Turn that off for the command:

```sh
MSYS_NO_PATHCONV=1 claude mcp add -s project river -- cmd /c npx tsx <river>/packages/mcp/src/main.ts --root . --author claude-code
```

Everything after `--` is the server command. Use `-s user` with an absolute `--root` to have it in every project. Check it with `claude mcp list`. The tools show up as `mcp__river__<name>`.

`--author claude-code` is the name your board writes carry (`madeBy` on cards and arrows, `by` on thread messages). It cannot be `you`, which is the user, or `concept-artist`, which is River's concept jobs.

### Headless runs (`claude -p`)

`claude -p` cannot show the approval prompt for a project server, so it starts without one you never approved interactively. Pass the config, and allow the River tools, since `-p` cannot ask for each call either:

```sh
claude -p "Answer the open marks on the River board." --mcp-config .mcp.json --allowedTools mcp__river
```

## Work the storyboard from Claude Code

The server sends Claude Code this loop as its instructions:

1. `marks_open` lists the requests nobody is working on, oldest first: what each mark is on, where it is, and its thread.
2. `mark_claim` takes one. Its status becomes `working` and the claim is yours alone: another agent can neither claim it nor change its status. Claiming again refreshes the claim; one left for 30 minutes can be taken over.
3. Read the context: `mark_read` (the whole thread and the cards it is on), `story_read`, `brief_read`. `card_view` shows you an image card.
4. Answer with `board_add_note` and `answers: <markId>`, then each image with `board_add_card` and the same `answers`. River puts the note beside the mark, the images in a row beside the note labelled A, B, C, and draws the arrows mark -> note -> each image. A later answer to the same mark goes under the earlier one.
5. `mark_reply` with `status: "answered"`, `"dismissed"` (the text says why), or `"open"` to give the mark back.

When the request asks to draw, show or picture something, call `concept_request` instead. It starts River's concept job for the mark in its own process and returns the job id at once. The concept artist writes small Godot drawing scripts; the user reads and approves them in River before anything runs, and accepts or dismisses the answer there. The mark follows the job from then on, so `mark_reply` takes no status on it.

When the user replies on a mark you answered (`river mark reply`, or the app), it opens again and shows up in `marks_open`, still claimed by you. Iterate with a new note and a new row; `answers` puts them under the first.

## Options

```
river-mcp --root <dir> [--tools name,name,...] [--author <role>] [--approval-pipe <name>] [--concept <id>]
```

- `--root` is required. It is the game repo, the folder with `river.json`.
- `--tools` serves only the tools you name. The default is every tool below except `concept_write`.
- `--author` is who the board writes and review replies come from. The default is `agent`.
- `--approval-pipe` is for the River app only. It adds `approval_prompt`, the tool Claude Code calls for permission prompts (`--permission-prompt-tool mcp__river__approval_prompt`). The tool asks the River app over that local named pipe or socket, and denies on any error or timeout. It is never one of the `--tools`.
- `--concept` is for River's concept jobs. It adds `concept_write`, which writes only in `concepts/<id>/`, and removes `concept_request`, so a job never starts another. Without it, asking for `concept_write` in `--tools` is an error.

## Tools

Results are text only. (Claude Code gives the model a tool's `structuredContent` instead of its text, and the JSON is several times longer.)

Read-only:

| Tool | What it does |
| --- | --- |
| `project_info` | Project name, engine, folders, editable globs, story files, shot ids, and each state variable's type, range and starting value. |
| `story_list` | Story files with titles and passage counts. |
| `story_read` | One story's raw Twee 3 text, each passage with its choices, and the state variables. |
| `story_lint` | Broken links, dead ends, never-true conditions, choices that show while their target cannot be entered, unknown variables. |
| `story_paths` | Every route from the start to an ending, dead end or loop. |
| `playtest_run` | Plays a story through a list of choices and returns the transcript. |
| `frames_list` | Shots and their captures, with PNG paths. |
| `review_list` | Review threads on shots. |
| `plan_list`, `plan_read` | Change plans and their status. |
| `board_read` | A storyboard as compact text: cards with size, labels, captions and image files; marks with status, box, what they are on and their threads; arrows. Long text is clipped. |
| `marks_open` | Open marks across every board, oldest first. Marks River's concept jobs answer are left out. |
| `mark_read` | One mark in full: the whole thread, the cards it is on, the answers its arrows lead to. |
| `card_read` | One card in full: a note's whole text, a passage card's passage, its arrows. |
| `card_view` | An image card's picture, as an MCP image: a concept render (pending or accepted), a reference image, or a frame's captures. Up to 4 MB, inside the project. |
| `brief_read` | The project brief, `.river/brief.md`. |

Tools that write:

| Tool | What it does |
| --- | --- |
| `story_write_passage`, `story_add_passage` | Change or add one passage; returns a diff and new lint problems. |
| `review_reply` | Reply on a review thread. |
| `plan_save` | Save a draft change plan for the user to approve. |
| `implement_edit` | Edit a file an approved plan names. |
| `plan_mark_implemented` | Mark an approved plan done. |
| `frames_capture` | Run the engine to capture one shot. |
| `mark_claim` | Take an open mark: status `working`, claimed by the author alone. |
| `mark_reply` | Add to a mark's thread; `status` `answered`, `dismissed` or `open` (give it back). |
| `board_add_note` | A note card. With `answers` it goes beside the mark with an arrow; otherwise right of `near`, or under everything. Covers nothing. |
| `board_add_card` | An image card for a file under the project. With `answers` it joins the labelled row beside your note, with an arrow from the note. Covers nothing. |
| `board_update_note` | Replace the text of a note the author made. |
| `board_remove_card` | Remove a card the author made, and its arrows. |
| `board_connect` | A curved arrow between two cards or marks. Joining the same two again returns the arrow already there. |
| `board_place_row` | Move cards into a labelled row (A, B, C...) beside a card or mark, clear of everything else. Not River's pending job cards. |
| `concept_request` | Start River's concept job for a mark (default backend `claude-code`, model `claude-sonnet-5-5`) and return its id. The user approves its scripts in River. |
| `concept_write` | Only with `--concept`. Write a file in `concepts/<id>/`. |

## Safety

- Every path is relative to `--root`, and the server never writes outside it. `card_view` reads only files inside the project, symlinks resolved.
- The story tools write only story files.
- `implement_edit` runs only for a plan with status `approved`, and only on a file that the plan's steps name and that matches the `editable` globs in `river.json`. The `oldText` you pass must match exactly once.
- The board tools write only under `.river/boards/<board>/`, one small JSON file per card, mark and arrow, renamed into place. Every change to a mark (a reply, a claim, a job's status) is read, changed and written under a lock file in `.river/locks/`, so the River app, River's concept jobs and several agents can work the same board at once without losing each other's changes, and two agents racing for one mark get one claim.
- An agent changes and removes only its own cards, never River's pending job cards.
- `board_add_card` takes only image files under the project. A frame under `.river/captures/` becomes a frame card. A concept render becomes a concept card only when a River job backs it: the pending render `.river/jobs/<job>/render_<v>.png` of a rendered job, or `concepts/<id>/concept_<v>.png` of an option the user accepted. Anything else, under `concepts/` too, is a reference image and needs `source.licence`.
- `concept_request` runs `river job start` detached, with its output in `.river/logs/<job>.log`. That process owns the job and refreshes its heartbeat, so it outlives this server, and River fails the job if the process dies. River runs nothing the job writes until the user approves every script's exact bytes.
- `concept_write` writes only inside `concepts/<id>/`. The scripts are `draw.gd`, or up to five options `draw_a.gd`..`draw_e.gd`, each with an optional one-line `caption`. Empty content removes a script. It refuses names that start or end with a dot and Windows device names (CON, NUL, COM1 and the like). A script may hold only printable ASCII, tabs and LF line ends. Anything else is refused, so the text the user reads is the text that runs. For a script it returns the concept lint problems.
- Errors come back as MCP tool errors (`isError: true`). They do not stop the server.

## Use it in-process

`createRiverTools(project, opts)` returns the same tools as plain objects, each with `name`, `description`, `inputSchema` (a zod raw shape), `mutating` and `handler`. A handler returns `text`, `data` (the same result as structured data, for in-process callers) and, for `card_view`, `images`. `opts.jobLauncher` replaces how `concept_request` starts a job.
