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
| `.river/boards/`, `.river/review/`, `.river/plans/`, `.river/brief.md`, `.river/voice.md`, `.river/refs/` | Storyboards, review threads, change plans, the project brief, writing voice guide, reference images. Shared work. | yes |
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
  "copyBudgets": {
    "passageMaxWords": 120,
    "choiceMaxWords": 10,
    "hintMaxWords": 12
  },
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
| `adapter.godot.batchScript` | The script that captures many shots in one Godot run. Default: River's bundled `batch_capture.gd`, so you add nothing. |
| `editable` | Globs a change plan may name for the implementer to edit. Default `["data/**", "tools/shots/**"]`. |
| `checkData` | Optional. A command River runs to compare the story with your game's own data (see below). |
| `copyBudgets` | Optional. Word-count limits checked by `river lint` (`passageMaxWords`, `choiceMaxWords`, `hintMaxWords`). |
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
| `id` | Letters, digits, `_`, `-` and `.`, starting with a letter or digit. Names the capture folder and the frame cards. |
| `scene` | The scene to load, `res://...`. |
| `setup` | A script that puts the scene in the state you want to see. Required when `count` is more than 1. |
| `count` | 1 for a still; more for consecutive frames. |
| `ticks` | Physics ticks between frames. Default 3. |
| `note` | Shown under the shot in River. |
| `timeoutS` | How long Godot may run. Default 60 s plus half a second per frame. |

River does not ship the one-shot capture scripts (only the batch runner below): they are your game's, so they can use its own types. River runs Godot like this (both with `--disable-vsync`):

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

**Batch capture.** When `river capture` gets more than one shot (`--all`, or several ids), River starts Godot once for all of them instead of once per shot:

```sh
godot --path <project> --disable-vsync -s <batchScript> -- --manifest=<tmp>/batch.json
```

This uses River's bundled runner, not your `capture.gd` or `capture_frames.gd`; set `adapter.godot.batchScript` to use your own script instead. The manifest is a JSON array of `{ "id", "scene", "setup", "outDir", "count", "ticks" }` (`setup` is `""` when the shot has none). The bundled `batch_capture.gd` loads each scene in turn, runs its setup, saves frames the way `capture.gd` (30 frames, then one still) and `capture_frames.gd` (10 frames, then `count` frames `ticks` hand-stepped ticks apart) do, and frees the scene before the next shot. Any load, setup or save error exits with code 1, naming the shot. The run may take the sum of the shots' `timeoutS` (at least 60 s). Every shot must write at least one `frame_NN.png`.

**Another engine: a command adapter.** Set `"engine"` to an id other than `"godot"` (for example `"command"` or `"unity"`) and give `adapter.<id>.command` in `river.json`; River runs it once per shot from `adapter.<id>.cwd` (default the root), with `RIVER_PROJECT_ROOT`, `RIVER_SHOT_ID`, `RIVER_SCENE`, `RIVER_SETUP`, `RIVER_COUNT`, `RIVER_TICKS` and `RIVER_OUT_DIR` set (and usable as `$VAR` in the command). It must write `frame_00.png`, `frame_01.png`, ... into `RIVER_OUT_DIR`. Add `adapter.<id>.batchCommand` to capture many shots in one run: it gets `RIVER_PROJECT_ROOT` and `RIVER_BATCH_MANIFEST`, a file in the manifest format above. `adapter.<id>.timeoutS` replaces each shot's timeout for `command`, and is the whole run's timeout for `batchCommand`.

## Godot runtime (`addons/river/`)

Instead of duplicating exported passages into `.tres` resources, load `stories/export/*.json` directly with River's zero-dependency Godot 4 addon (`packages/adapter-godot/runtime/addons/river/`).

Install it into your Godot project by copying `addons/river/` into `<project>/addons/river/` (or calling `installGodotRuntime(projectRoot)` from `@river/adapter-godot`), then enable **River Story Runtime** in **Project -> Project Settings -> Plugins**.

```gdscript
var story: RiverStory = RiverStory.load_from_file("res://stories/export/walk.json")
var runner: RiverRunner = RiverRunner.new()

runner.passage_entered.connect(func(pid: String, _passage: Dictionary) -> void:
	for block: Dictionary in runner.get_blocks():
		print(block.get("speaker", ""), block.get("text", ""))
	for entry: Dictionary in runner.get_choices():
		print(entry["index"], entry["choice"]["label"], entry["open"], entry["closed_reason"])
)
runner.cue_triggered.connect(func(cue_name: String, args: String) -> void:
	AudioManager.play_cue(cue_name, args)
)
runner.state_changed.connect(func(variable: String, _old_v: Variant, new_v: Variant) -> void:
	hud.update_stat(variable, new_v)
)
runner.story_ended.connect(func(pid: String, is_ending: bool) -> void:
	show_summary(pid, is_ending)
)

runner.start(story)
runner.choose(0)
```

Key runtime APIs:

- **`RiverStory`**: `load_from_file(path)`, `from_dict(data)`, `get_passage(id)`, `get_interrupts()`, `get_storylets()`, `initial_state()`.
- **`RiverRunner` navigation & state**: `start(story, from_id, state_override)`, `current_id()`, `current_passage()`, `get_state()`, `set_var(name, value)`, `get_visits()`, `get_choices()`, `choose(index)`, `get_interrupts()`, `trigger_interrupt(passage_id)`, `can_undo()`, `undo()`, `is_over()`, `get_turn()`, `get_cooldowns()`.
- **`RiverRunner` storylets**: `storylets()` lists each `[storylet]` passage as `{ id, passage, open, weight, priority, cooldown_left }`. `draw_storylet(rng = null)` draws one open storylet (highest `priority` first, then at random by `weight`, from `rng` or the global RNG), enters it, starts its cooldown and returns the passage, or `{}` when none is open. Pass a seeded `RandomNumberGenerator` for repeatable draws, or `draw_storylet(null, roll)` with a fixed `roll` in [0, 1) to replay one exact draw.
- **`@auto` interrupts**: `choose()` starts them by itself, as described under Story rules; nothing to call.
- **`RiverRunner` text & evaluation**: `render_text(raw)` (evaluates `{var}`, `{when ...}`, `{once:}`, `{cycle:}`, `{shuffle:}`), `get_blocks()` (rendered dialogue/narration blocks), `eval_cond(cond)`, `apply_effects(state, effects)`.
- **Signals**: `passage_entered(passage_id, passage)`, `choice_taken(passage_id, choice_index, choice)`, `cue_triggered(name, args)`, `state_changed(variable, old_value, new_value)`, `story_ended(passage_id, ending)`, `storylet_drawn(passage_id)`.
- **Save / load**: serialize `runner.to_dict()` with `JSON.stringify(...)`, and restore later with `runner.from_dict(saved_dict, story)`. History, visits, `@once` choices, active interrupt `@return` targets, the turn count and storylet cooldowns round-trip cleanly. Older saves without a turn or cooldowns load as turn 0 with none.

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
| `@cue name [args]` | Triggers `cue_triggered(name, args)` when the passage is entered (sound, camera, animation). |
| `@shot shot_id` | Links this passage to a shot id from `river.json` for storyboards and captures. |
| `@meta key=value, key2="text"` | Custom key/value metadata (numbers, booleans, or strings) passed through to the export. |
| `@end` | An ending. |
| `--` | Ends the rules. Exactly two hyphens; lint reports `---` or a dash as an error, because the rules above it would be read as prose. |

Choice rules:

| Rule | Meaning |
| --- | --- |
| `@when cond` | The choice is open only when this holds. |
| `@cost treats 1` | Pays 1 treat. The choice is open only while `treats >= 1`, so a purchase is never free. |
| `@set a += 1` | Effects when the choice is taken, after the cost. |
| `@once` | Can be chosen only once per playthrough (`closed_by: "once"` afterward; restored by `undo()`). |
| `@cue name [args]` | Triggers `cue_triggered(name, args)` when the choice is taken, before entering the target passage. |
| `@meta key=value` | Custom key/value metadata attached to the choice in the export. |
| `@hint "text"` | A short line the game can show with the option. Quote it; an `@` inside the quotes is text. |

Conditions: `a >= 1`, `a == 2`, `mood == CALM`, `rainy`, `not rainy`, `visited(pond)`, `visits(pond) >= 2`, `a > 1 and (b < 2 or c != 3)`. Effects: `a = 5`, `a += 1`, `a -= 1`, `a *= 0.5`, `a /= 2`, `mood = EXCITED`, `rainy = true`.

**Dialogue lines.** Prefix a line with `Speaker: text` or `Speaker [mood]: text` to emit structured dialogue blocks (`{ "kind": "dialogue", "speaker": "...", "mood": "...", "text": "..." }`) alongside narration blocks. `RiverRunner.get_blocks()` renders every block through `render_text()`.

**Inline reactive text.** Prose and dialogue lines can embed templates evaluated on the current state and passage visit count:

| Template | Behavior |
| --- | --- |
| `{energy}` | Interpolates the current value of state variable `energy`. |
| `{when cond: then \| else}` | Renders `then` when `cond` holds, else `else` (the `\| else` branch is optional). Supports variables, `visited(id)`, `visits(id) >= n`, `and`, `or`, `not`. |
| `{once: text}` | Renders only on the first visit to the current passage (`visits == 1`). |
| `{cycle: A \| B \| C}` | Cycles through options on each visit (`(visits - 1) % n`). |
| `{shuffle: A \| B \| C}` | Picks one option from the list for the current visit. |

**Voice guide & copy budgets.** Add `.river/voice.md` to document tone, character voices, and phrasing rules for writers and agents. Set `copyBudgets` in `river.json` (`passageMaxWords`, `choiceMaxWords`, `hintMaxWords`) so `river lint` flags overly long passages, labels, or hints.

**When a choice is open.** Its `@when` holds, every `@cost` can be paid, and the target passage's `@when` holds on the state after the choice's `@cost` and `@set`. `river play`, `paths`, `lint` and the export all use this one rule. `play` shows a closed choice dimmed with the reason; the game decides whether to hide it or grey it out.

**Interrupts.** A passage tagged `[interrupt]` can start from any passage while its `@when` holds; the game decides when to fire it (for example when an engine variable crosses a line). Its choices can target `@return` to go back to the passage it interrupted, keeping the effects. The export marks it `"interrupt": true` and writes `@return` as the choice's `to`. In `river play`, start one with `!1`. `paths` lists interrupt routes after the others. Interrupts do not nest, and `@return` anywhere an interrupt cannot lead is a lint error.

**`@auto` interrupts.** Add `@auto` to an `[interrupt]` passage and it starts by itself right after a choice moves to a passage, as soon as its `@when` holds there (on the new state, with the new passage's visit counted). It does not fire on a `@return`, inside another interrupt or storylet, at an ending, or when the choice links to that interrupt itself. When several hold, the highest `@priority` wins, then the first in the file. It is a step of its own on the same turn, so one `undo()` takes back only the interrupt. An `@auto` interrupt with `@end` ends the story.

```twee
:: Collapse [interrupt]
@auto
@priority 10
@when energy == 0
@end
--
You collapse.
```

**Storylets.** A passage tagged `[storylet]` is a card in a deck the game draws from (`draw_storylet()` in Godot) while no interrupt or storylet is running. It is entered like an interrupt, so its choices can `@return`; with `@end` it ends the story instead. A storylet is open when its `@when` holds and it is off cooldown. A draw picks among the open storylets of the highest `@priority`, at random by `@weight`. Each `choose()` and each draw is one turn.

| Rule | Meaning |
| --- | --- |
| `@weight 3` | Draw weight among storylets of the same priority. A positive number; default 1. |
| `@priority 5` | A whole number; higher is drawn first, whatever the weights. Also orders `@auto` interrupts. Default 0. |
| `@cooldown 2` | Whole turns after a draw before it can be drawn again. Default 0. |

```twee
:: Squirrel [storylet]
@weight 3
@cooldown 2
@set energy -= 1
--
A squirrel!
[[Carry on->@return]]
```

The export adds `"storylet": true`, `"weight"`, `"priority"`, `"cooldown"` and `"auto": true` only where a story uses them, so an older runtime still plays the story.

## Day to day

```sh
river lint .                 # problems, then checkData
river paths . --summary      # routes by ending; drop --summary for every route with its choices and conditions
river play .                 # n: choose, !n: start an interrupt, :set var value, :state, :undo, :quit
river export .               # write stories/export/<story>.json
river board show .           # the storyboard as agents read it
```

`paths` follows effects along each route: a condition after `@set hp -= 10` is checked on the lowered value, clamped to the schema range. A route is "never true" when no state lets a player take it.
