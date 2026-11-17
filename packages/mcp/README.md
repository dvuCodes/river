# river-mcp

The River MCP server (stdio, server name `river`). It gives Claude Code, or any MCP client, the River tools for one game repo. With them an agent can read and lint stories, playtest, list frames and review threads, save change plans, and edit only the files an approved plan names. It can also work the storyboard: find the requests the user drew, claim one, and answer with notes, images and arrows beside it.

## Add it to Claude Code

Run this from your game repo, the folder that has `river.json`. Replace `<river>` with the path of this repository:

```sh
claude mcp add -s project river -- npx tsx <river>/packages/mcp/src/main.ts --root . --author claude-code
```

On native Windows (not WSL), wrap `npx` in `cmd /c`:

```sh
claude mcp add -s project river -- cmd /c npx tsx <river>/packages/mcp/src/main.ts --root . --author claude-code
```

Everything after `--` is the server command. `-s project` writes the entry to `.mcp.json` in the game repo, so the server's `--root .` is that repo and the whole team gets it. Use `-s user` with an absolute `--root` to have it in every project. Check it with `claude mcp list`. The tools show up as `mcp__river__<name>`.

`--author claude-code` is the name your board writes carry (`madeBy` on cards and arrows, `by` on thread messages). It cannot be `you`, which is the user.

## Work the storyboard from Claude Code

A loop that answers the user's requests on the canvas:

1. `marks_open` lists the requests nobody is working on, oldest first, with their threads.
2. `mark_claim` takes one. Its status becomes `working`, so other agents leave it alone.
3. `board_read` shows the cards the mark is on, and `brief_read` shows what the project should look like and what the user turned down.
4. Make the answer, then put it beside the mark:
   - `board_add_note` for your explanation (what each option is and its risk).
   - `board_add_card` for each image: a captured frame, an accepted concept render, or a PNG you made.
   - `board_place_row` to line the options up as A, B, C beside the note.
   - `board_connect` from the mark to the note, and from the note to each option.
5. `mark_reply` with `status: "answered"`.

When the user replies on that mark, it opens again and shows up in `marks_open`, still claimed by you. Iterate with a new note and a new row under the first.

Marks that a River concept job works on keep the job's status: `mark_claim` refuses them and `mark_reply` takes no status there. Those requests are answered in the River app.

## Options

```
river-mcp --root <dir> [--tools name,name,...] [--author <role>] [--approval-pipe <name>] [--concept <id>]
```

- `--root` is required. It is the game repo, the folder with `river.json`.
- `--tools` serves only the tools you name. The default is all 26, plus `concept_write` with `--concept`.
- `--author` is who the board writes and review replies come from. The default is `agent`.
- `--approval-pipe` is for the River app only. It adds `approval_prompt`, the tool Claude Code calls for permission prompts (`--permission-prompt-tool mcp__river__approval_prompt`). The tool asks the River app over that local named pipe or socket, and denies on any error or timeout. It is never one of the `--tools`.
- `--concept` is for River's concept jobs. It adds `concept_write`, which writes only in `concepts/<id>/`. Without it, asking for `concept_write` in `--tools` is an error.

## Tools

Read-only:

| Tool | What it does |
| --- | --- |
| `project_info` | Project name, engine, folders, editable globs, story files and shot ids. |
| `story_list` | Story files with titles and passage counts. |
| `story_read` | One story's raw Twee 3 text, then each passage with its choices. |
| `story_lint` | Broken links, dead ends, never-true conditions, unknown variables. |
| `story_paths` | Every route from the start to an ending, dead end or loop. |
| `playtest_run` | Plays a story through a list of choices and returns the transcript. |
| `frames_list` | Shots and their captures, with PNG paths. |
| `review_list` | Review threads on shots. |
| `plan_list`, `plan_read` | Change plans and their status. |
| `board_read` | A storyboard as compact text: cards with labels and captions, marks with threads and status, arrows. |
| `marks_open` | Open marks across every board, oldest first. |
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
| `mark_claim` | Take an open mark: status `working`, claimed by the author. |
| `mark_reply` | Add to a mark's thread; `status` `answered` or `open` (give it back). |
| `board_add_note` | A note card beside a card or mark, placed so it covers nothing. Returns its id. |
| `board_add_card` | An image card for a file under the project, placed so it covers nothing. Returns its id. |
| `board_connect` | A curved arrow between two cards or marks. Joining the same two again returns the arrow already there. |
| `board_place_row` | Move cards into a labelled row (A, B, C...) beside a card or mark, clear of everything else. |
| `concept_write` | Only with `--concept`. Write a file in `concepts/<id>/`. |

## Safety

- Every path is relative to `--root`, and the server never writes outside it.
- The story tools write only story files.
- `implement_edit` runs only for a plan with status `approved`, and only on a file that the plan's steps name and that matches the `editable` globs in `river.json`. The `oldText` you pass must match exactly once.
- The board tools write only under `.river/boards/<board>/`, one small JSON file per card, mark and arrow, renamed into place. The River app, River's concept jobs and several agents can write the same board at once without losing each other's changes.
- `board_add_card` takes only image files under the project. A frame under `.river/captures/` becomes a frame card and `concepts/<id>/concept.png` (or `concept_<v>.png`) a concept card. Anything else is a reference image and needs `source.licence`.
- `concept_write` writes only inside `concepts/<id>/`. The scripts are `draw.gd`, or up to five options `draw_a.gd`..`draw_e.gd`, each with an optional one-line `caption`. Empty content removes a script. It refuses names that start or end with a dot and Windows device names (CON, NUL, COM1 and the like). A script may hold only printable ASCII, tabs and LF line ends. Anything else is refused, so the text the user reads is the text that runs. For a script it returns the concept lint problems. River runs nothing it writes until the user approves every script's exact bytes.
- Errors come back as MCP tool errors (`isError: true`). They do not stop the server.

## Use it in-process

`createRiverTools(project, opts)` returns the same tools as plain objects, each with `name`, `description`, `inputSchema` (a zod raw shape), `mutating` and `handler`. Use it when you want the tools without stdio.
