# Set up River on an existing Godot game

This guide makes an existing Godot repo a River project: a story River can lint, walk and play, state River can check, and shots River can capture into the storyboard. Nothing in your game changes; River adds a few files beside it.

## Run River

River runs from its own checkout. Pass your game's folder after the command (or as `--root`); a relative path is read from the folder you are in, even through `pnpm -C`:

```sh
cd my-game
pnpm -C ../river river lint .
pnpm -C ../river river paths . --summary
```

Every command takes the folder the same way: `river <command> [dir]`, and `river <command> <subcommand> [dir]` for `frames`, `captures`, `board`, `card`, `mark` and `job`. `river --help` lists them.

## The files

| File | What it is | Commit it? |
| --- | --- | --- |
| `river.json` | The manifest, at the repo root. River finds the project by it. | yes |
| `stories/*.twee` | Stories in Twee 3, with River rules. | yes |
| `stories/state.json` | The state variables the stories read and change. | yes |
| `stories/export/*.json` | What `river export` writes for the game to load. | yes, if the game loads it |
| `.river/boards/`, `.river/review/`, `.river/plans/`, `.river/brief.md`, `.river/refs/` | Storyboards, review threads, change plans, the project brief, reference images. Shared work. | yes |
| `.river/captures/`, `.river/jobs/`, `.river/logs/` | Captured frames, concept job renders, logs. Regenerated. | no |

Add this to `.gitignore`:

```gitignore
# River: regenerated output. Boards, review threads, plans, refs and brief.md are shared and committed.
/.river/captures/
/.river/jobs/
/.river/logs/
```

## river.json

```json
{
  "name": "My Game",
  "engine": "godot",
  "stories": "stories",
  "state": "stories/state.json",
  "export": "stories/export",
  "adapter": {
    "godot": {
      "bin": "$GODOT_BIN",
      "project": ".",
      "screenshotScript": "res://tools/capture.gd",
      "framesScript": "res://tools/capture_frames.gd"
    }
  },
  "editable": ["data/**", "tools/shots/**"],
  "checkData": "node tools/check_story.mjs",
  "shots": [
    { "id": "title_screen", "scene": "res://scenes/title.tscn", "setup": "res://tools/shots/title_screen.gd", "count": 1, "note": "the logo settles" },
    { "id": "jump_arc", "scene": "res://scenes/level_1.tscn", "setup": "res://tools/shots/jump_arc.gd", "count": 12, "ticks": 3, "timeoutS": 120 }
  ]
}
```

| Key | Meaning |
| --- | --- |
| `name` | Shown in River. |
| `engine` | `"godot"`, or `"none"` for a story-only project (no captures). |
| `stories` | Folder of `.twee` files, from the root. |
| `state` | The state schema file, from the root. |
| `export` | Folder `river export` writes `<story>.json` to. |
| `adapter.godot.bin` | The Godot executable. `"$GODOT_BIN"` reads the environment variable. Required for captures. |
| `adapter.godot.project` | The Godot project folder (the one with `project.godot`), from the root. Default `"."`. |
| `adapter.godot.screenshotScript` | The script that saves one frame. Default `res://tools/capture.gd`. |
| `adapter.godot.framesScript` | The script that saves several frames. Default `res://tools/capture_frames.gd`. |
| `editable` | Globs a change plan may name for the implementer to edit. Default `["data/**", "tools/shots/**"]`. |
| `checkData` | Optional. A command River runs to compare the story with your game's own data (see below). |
| `shots` | The frames River can capture (see below). |

Values in `adapter` can use `$NAME` or `${NAME}` for environment variables.

## stories/state.json

One entry per variable:

```json
{
  "energy":  { "type": "number", "min": 0, "max": 100, "initial": 80 },
  "coins":   { "type": "int", "min": 0, "initial": 3 },
  "rainy":   { "type": "bool", "initial": false },
  "mood":    { "type": "enum", "values": ["CALM", "EXCITED"], "initial": "CALM" },
  "noise":   { "type": "number", "min": 0, "max": 100, "initial": 0, "engine": true }
}
```

- Numbers clamp to `min` and `max` after every change. An `int` drops the fraction a `*=` or `/=` leaves.
- `initial` is where `river play` starts. Without it: `min` (or 0), `false`, or the first enum value.
- `"engine": true` marks a variable your game changes on its own while a passage is on screen: a meter, a timer, a distance. `paths` and `lint` treat it as anywhere in its range at every passage, so a condition on it is reachable without a story effect that sets it. Mark every variable the game drains or fills continuously; otherwise `paths` reports routes that need it as never true.

## Shots

A shot is one deterministic capture: a scene, a setup script that puts it in a known state, and how many frames to save.

| Key | Meaning |
| --- | --- |
| `id` | Letters, digits, `_` and `-`. Names the capture folder and the frame cards. |
| `scene` | The scene to load, `res://...`. |
| `setup` | A script that puts the scene in the state you want to see. Required when `count` is more than 1. |
| `count` | 1 for a still; more for consecutive frames. |
| `ticks` | Physics ticks between frames. Default 3. |
| `note` | Shown under the shot in River. |
| `timeoutS` | How long Godot may run. Default 60 s plus half a second per frame. |

River does not ship the capture scripts: they are your game's, so they can use its own types. River runs Godot like this (both with `--disable-vsync`):

```sh
# count 1
godot --path <project> --disable-vsync -s res://tools/capture.gd -- --scene=<scene> --out=<dir>/frame_00.png [--setup=<setup>]
# count > 1
godot --path <project> --disable-vsync -s res://tools/capture_frames.gd -- --scene=<scene> --setup=<setup> --out=<dir>/frame --count=<n> --ticks=<t>
```

The scripts must write `frame_00.png`, `frame_01.png`, ... into `<dir>` and quit with code 0. Godot cannot render headless, so a window opens for a moment. A common shape: the capture script is a `SceneTree` script that loads `--scene`, adds it to the root, loads `--setup` and calls a static `setup(scene)` on it, waits a few frames, then saves the viewport image. Each shot then gets one small setup script under `tools/shots/` that sets the scene's state directly and freezes anything random.

```sh
river shots .                      # the shots and their latest capture
river capture . title_screen       # one shot (the shot can also come first: river capture title_screen .)
river capture . --all              # every shot
river captures prune . --keep 3    # keep the newest 3 captures of each shot (--dry-run to see first)
```

Captures go to `.river/captures/<shot>/<time>/` with a `capture.json` that lists the frames relative to the root. Prune keeps any capture a frame card on a board shows.

## Check the story against the game's data

When the game keeps its own copy of what a story says (encounter resources, item tables), set `checkData` to a command that compares them. `river lint` and `river check-data` export every story to a temporary folder first, then run the command from the root with:

- `RIVER_ROOT`: the project root.
- `RIVER_EXPORT_DIR`: the folder holding a fresh `<story>.json` per story.

Read the export from `RIVER_EXPORT_DIR`, so the check never sees a stale file, and exit non-zero on a mismatch; lint counts that as an error and prints what the command printed. River runs this command only from the CLI, never for an agent's tool call. It is your own code, like an npm script.

## Story rules

A passage's rules go at its top, ended by a line `--`. A choice's rules go after its link, on the same line.

```twee
:: Pond [encounter]
@id pond
@when energy >= 20
@set excitement += 20
--
Ducks. Many ducks.

[[Throw a treat->Treat]] @cost treats 1 @hint "Costs one treat"
[[Hold the leash tight->Calm down]] @set excitement -= 30, bond -= 5 @when bond > 20
[[Rest->Bench]] @set bond *= 0.5

:: Loud bang [interrupt]
@id loud_bang
@when noise >= 80
--
A car backfires.

[[Kneel and wait->@return]] @set excitement -= 20
[[Head home now->Home]]
```

Passage rules:

| Rule | Meaning |
| --- | --- |
| `@id pond` | A stable id. Without it, the slug of the name. Ids survive renames. |
| `@when cond` | The passage can be entered only when this holds, on the state after the choice that leads here. |
| `@set a += 1, b = 2` | Effects when the passage is entered. |
| `@end` | An ending. |
| `--` | Ends the rules. Exactly two hyphens; lint reports `---` or a dash as an error, because the rules above it would be read as prose. |

Choice rules:

| Rule | Meaning |
| --- | --- |
| `@when cond` | The choice is open only when this holds. |
| `@cost treats 1` | Pays 1 treat. The choice is open only while `treats >= 1`, so a purchase is never free. |
| `@set a += 1` | Effects when the choice is taken, after the cost. |
| `@hint "text"` | A short line the game can show with the option. Quote it; an `@` inside the quotes is text. |

Conditions: `a >= 1`, `a == 2`, `mood == CALM`, `rainy`, `not rainy`, `a > 1 and (b < 2 or c != 3)`. Effects: `a = 5`, `a += 1`, `a -= 1`, `a *= 0.5`, `a /= 2`, `mood = EXCITED`, `rainy = true`.

**When a choice is open.** Its `@when` holds, every `@cost` can be paid, and the target passage's `@when` holds on the state after the choice's `@cost` and `@set`. `river play`, `paths`, `lint` and the export all use this one rule. `play` shows a closed choice dimmed with the reason; the game decides whether to hide it or grey it out.

**Interrupts.** A passage tagged `[interrupt]` can start from any passage while its `@when` holds; the game decides when to fire it (for example when an engine variable crosses a line). Its choices can target `@return` to go back to the passage it interrupted, keeping the effects. The export marks it `"interrupt": true` and writes `@return` as the choice's `to`. In `river play`, start one with `!1`. `paths` lists interrupt routes after the others. Interrupts do not nest, and `@return` anywhere an interrupt cannot lead is a lint error.

## Day to day

```sh
river lint .                 # problems, then checkData
river paths . --summary      # routes by ending; drop --summary for every route with its choices and conditions
river play .                 # n: choose, !n: start an interrupt, :set var value, :state, :undo, :quit
river export .               # write stories/export/<story>.json
river board show .           # the storyboard as agents read it
```

`paths` follows effects along each route: a condition after `@set hp -= 10` is checked on the lowered value, clamped to the schema range. A route is "never true" when no state lets a player take it.
