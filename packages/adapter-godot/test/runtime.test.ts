import { spawn } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { createPlaytest, exportStory, parseTwee3, type ExportedStory, type StateSchema } from "@river/core"
import { afterAll, describe, expect, it } from "vitest"
import { GODOT_BATCH_SCRIPT, GODOT_RUNTIME_DIR, installGodotRuntime } from "../src/index"

const bin = process.env.GODOT_BIN
const scratch = mkdtempSync(path.join(tmpdir(), "river-godot-runtime-"))
afterAll(() => rmSync(scratch, { recursive: true, force: true, maxRetries: 5 }))

function runGodot(godotBin: string, args: string[], timeoutMs = 45_000): Promise<{ code: number | null; output: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(godotBin, args, { stdio: ["ignore", "pipe", "pipe"], windowsHide: true })
    let output = ""
    const collect = (chunk: Buffer) => {
      output += chunk.toString("utf8")
    }
    child.stdout.on("data", collect)
    child.stderr.on("data", collect)
    const timer = setTimeout(() => {
      child.kill()
      reject(new Error(`Godot timed out after ${timeoutMs} ms\n${output}`))
    }, timeoutMs)
    child.once("error", (err) => {
      clearTimeout(timer)
      reject(err)
    })
    child.once("close", (code) => {
      clearTimeout(timer)
      resolve({ code, output })
    })
  })
}

/** A Godot project whose GDScript warnings are errors, so the addon must stay strictly typed. */
const STRICT_PROJECT_GODOT = [
  "config_version=5",
  "",
  "[application]",
  'config/name="river-runtime-test"',
  "",
  "[debug]",
  "file_logging/enable_file_logging=false",
  "file_logging/enable_file_logging.pc=false",
  "gdscript/warnings/untyped_declaration=2",
  "gdscript/warnings/inferred_declaration=2",
  "gdscript/warnings/unused_variable=2",
  "gdscript/warnings/unused_parameter=2",
  "gdscript/warnings/shadowed_variable=2",
  "",
].join("\n")

const STORY_JSON = {
  schema: 1,
  id: "park_walk",
  title: "Park Walk",
  start: "start",
  state: {
    energy: { type: "number", min: 0, max: 100, initial: 80 },
    coins: { type: "int", min: -10, max: 20, initial: 5 },
    treats: { type: "int", min: 0, initial: 1 },
    stamina: { type: "int", min: 3 },
    score: { type: "int" },
    rainy: { type: "bool" },
    mood: { type: "enum", values: ["CALM", "EXCITED"] },
    noise: { type: "number", min: 0, max: 100, initial: 10, engine: true },
  },
  passages: {
    start: {
      name: "Start",
      tags: ["hub"],
      onEnter: [{ variable: "energy", op: "add", amount: 5 }],
      ending: false,
      cues: [{ name: "ambience", args: "park_morning" }],
      text: "{once: First step.} {cycle: A | B | C} {shuffle: X | Y} {when energy >= 80 and not rainy: Ready {energy}! | Low.} {when visited(pond): Saw ducks. | No ducks yet.} {when visits(start) >= 2: Returned.}",
      blocks: [
        { kind: "narration", text: "{once: First step.} Energy is {energy}." },
        { kind: "dialogue", speaker: "Zoro", mood: "curious", text: "{when visited(pond): Woof! Ducks! | Where to?}" },
      ],
      choices: [
        {
          label: "Visit pond",
          to: "pond",
          cost: [{ variable: "treats", op: "add", amount: -1 }],
          set: [{ variable: "coins", op: "mul", amount: 0.5 }],
          cues: [{ name: "sfx_step", args: "gravel" }],
        },
        {
          label: "One-time sniff",
          to: "sniff",
          once: true,
          cost: [],
          set: [{ variable: "mood", op: "set", amount: "EXCITED" }],
        },
        {
          label: "Secret gate (needs pond)",
          to: "secret",
          when: { kind: "visit", passageId: "pond", op: ">=", value: 1 },
          cost: [],
          set: [],
        },
        {
          label: "Drain into club",
          to: "club",
          cost: [],
          set: [{ variable: "energy", op: "add", amount: -50 }],
        },
        {
          label: "Boost into club",
          to: "club",
          cost: [],
          set: [{ variable: "energy", op: "add", amount: 50 }],
        },
        {
          label: "Go home",
          to: "home",
          cost: [],
          set: [],
        },
        {
          label: "Cross to chapter 2",
          to: "chapter2::gate",
          cost: [{ variable: "coins", op: "add", amount: -1 }],
          set: [{ variable: "mood", op: "set", amount: "EXCITED" }],
          cues: [{ name: "sfx_portal", args: "ch2" }],
        },
      ],
    },
    pond: {
      name: "Pond",
      tags: ["encounter"],
      onEnter: [{ variable: "energy", op: "add", amount: 10 }],
      ending: false,
      cues: [{ name: "sfx_quack", args: "2" }],
      text: "Ducks splash. Coins={coins}.",
      choices: [
        {
          label: "Back to start",
          to: "start",
          cost: [],
          set: [],
        },
      ],
    },
    sniff: {
      name: "Sniff",
      tags: [],
      onEnter: [],
      ending: false,
      text: "A great smell. Mood={mood}.",
      choices: [
        {
          label: "Return to path",
          to: "start",
          cost: [],
          set: [],
        },
      ],
    },
    secret: {
      name: "Secret",
      tags: [],
      onEnter: [],
      ending: false,
      text: "You found the hidden bench.",
      choices: [
        {
          label: "Back",
          to: "start",
          cost: [],
          set: [],
        },
      ],
    },
    club: {
      name: "High Energy Club",
      tags: [],
      when: { kind: "cmp", variable: "energy", op: ">=", value: 90 },
      onEnter: [],
      ending: false,
      text: "Clamped energy={energy}.",
      choices: [
        {
          label: "Back",
          to: "start",
          cost: [],
          set: [],
        },
      ],
    },
    loud_bang: {
      name: "Loud Bang",
      tags: ["interrupt"],
      interrupt: true,
      when: { kind: "cmp", variable: "noise", op: ">=", value: 80 },
      onEnter: [{ variable: "mood", op: "set", amount: "EXCITED" }],
      ending: false,
      cues: [{ name: "sfx_bang", args: "loud" }],
      text: "A car backfires!",
      choices: [
        {
          label: "Kneel and calm down",
          to: "@return",
          cost: [],
          set: [{ variable: "energy", op: "add", amount: -10 }],
          cues: [{ name: "sfx_sigh", args: "" }],
        },
        {
          label: "Run straight home",
          to: "home",
          cost: [],
          set: [],
        },
      ],
    },
    home: {
      name: "Home",
      tags: [],
      onEnter: [],
      ending: true,
      text: "Safe at home.",
      choices: [],
    },
  },
}

const TEST_SCRIPT = `extends SceneTree

var _failures: Array[String] = []


func _assert(cond: bool, msg: String) -> void:
	if not cond:
		_failures.append(msg)
		printerr("FAIL: " + msg)


func _initialize() -> void:
	_run_tests()
	if _failures.is_empty():
		print("ALL_TESTS_PASSED")
		quit(0)
	else:
		printerr("FAILED COUNT: %d" % _failures.size())
		quit(1)


func _run_tests() -> void:
	var plugin_script: Variant = load("res://addons/river/river_plugin.gd")
	_assert(plugin_script != null, "river_plugin.gd loads cleanly")

	var story: RiverStory = RiverStory.load_from_file("res://story.json")
	_assert(story != null, "RiverStory.load_from_file returned non-null")
	if story == null:
		return
	_assert(story.schema_version == 1, "schema_version == 1")
	_assert(story.story_id == "park_walk", "story_id == park_walk")
	_assert(story.title == "Park Walk", "title == Park Walk")
	_assert(story.start_id == "start", "start_id == start")
	_assert(story.get_interrupts().size() == 1, "story has 1 interrupt")

	# Initial state defaults
	var init_st: Dictionary = story.initial_state()
	_assert(init_st["energy"] == 80.0, "energy initial == 80")
	_assert(init_st["coins"] is int and init_st["coins"] == 5, "coins initial == int(5)")
	_assert(init_st["treats"] is int and init_st["treats"] == 1, "treats initial == int(1)")
	_assert(init_st["stamina"] is int and init_st["stamina"] == 3, "stamina falls back to min=3")
	_assert(init_st["score"] is int and init_st["score"] == 0, "score falls back to 0")
	_assert(init_st["rainy"] is bool and init_st["rainy"] == false, "rainy defaults to false")
	_assert(init_st["mood"] == "CALM", "mood defaults to first enum value CALM")

	var runner: RiverRunner = RiverRunner.new()
	var entered_log: Array[String] = []
	var choices_log: Array[String] = []
	var cues_log: Array[String] = []
	var state_log: Array[String] = []
	var ended_log: Array[String] = []

	runner.passage_entered.connect(func(pid: String, _p: Dictionary) -> void:
		entered_log.append(pid)
	)
	runner.choice_taken.connect(func(pid: String, idx: int, _c: Dictionary) -> void:
		choices_log.append("%s:%d" % [pid, idx])
	)
	runner.cue_triggered.connect(func(cname: String, cargs: String) -> void:
		cues_log.append("%s(%s)" % [cname, cargs])
	)
	runner.state_changed.connect(func(v: String, old_v: Variant, new_v: Variant) -> void:
		state_log.append("%s:%s->%s" % [v, str(old_v), str(new_v)])
	)
	runner.story_ended.connect(func(pid: String, is_ending: bool) -> void:
		ended_log.append("%s:%s" % [pid, str(is_ending)])
	)

	# 1. Start story -> onEnter adds 5 energy -> 85, fires cue ambience(park_morning)
	runner.start(story)
	_assert(runner.current_id() == "start", "started at start")
	_assert(runner.get_state()["energy"] == 85.0, "onEnter applied energy 80+5=85")
	_assert(runner.get_visits()["start"] == 1, "start visit count == 1")
	_assert(not runner.can_undo(), "cannot undo at start")
	_assert(not runner.is_over(), "story not over at start")
	_assert(entered_log == ["start"], "entered_log has start")
	_assert(cues_log == ["ambience(park_morning)"], "start cue fired")
	_assert(state_log.size() == 1 and state_log[0].begins_with("energy:"), "state_changed fired for energy")

	# 2. Render text + blocks on first visit
	var rendered1: String = runner.render_text()
	_assert(rendered1.contains("First step."), "once renders on visit 1: " + rendered1)
	_assert(rendered1.contains(" A "), "cycle picks A on visit 1: " + rendered1)
	_assert(rendered1.contains(" X ") or rendered1.contains(" Y "), "shuffle picks X or Y: " + rendered1)
	_assert(rendered1.contains("Ready 85!"), "when + {energy} nested interpolation works: " + rendered1)
	_assert(rendered1.contains("No ducks yet."), "visited(pond) false initially: " + rendered1)
	_assert(not rendered1.contains("Returned."), "visits(start) >= 2 false on visit 1: " + rendered1)

	var blocks1: Array[Dictionary] = runner.get_blocks()
	_assert(blocks1.size() == 2, "start has 2 blocks")
	_assert(blocks1[0]["kind"] == "narration" and blocks1[0]["text"] == "First step. Energy is 85.", "block 0 rendered: " + str(blocks1[0]))
	_assert(blocks1[1]["kind"] == "dialogue" and blocks1[1]["speaker"] == "Zoro" and blocks1[1]["text"] == "Where to?", "block 1 rendered: " + str(blocks1[1]))

	# 3. Inspect choices at start
	var ch0: Array[Dictionary] = runner.get_choices()
	_assert(ch0.size() == 7, "start has 7 choices")
	_assert(ch0[0]["open"] == true, "choice 0 (Visit pond) open when treats=1")
	_assert(ch0[1]["open"] == true, "choice 1 (@once sniff) open initially")
	_assert(ch0[2]["open"] == false and ch0[2]["closed_by"] == "when", "choice 2 closed by visit when")
	_assert(ch0[3]["open"] == false and ch0[3]["closed_by"] == "target", "choice 3 closed by target when after -50 energy")
	_assert(ch0[4]["open"] == true, "choice 4 open because +50 energy clamps to 100 >= 90")
	_assert(ch0[6]["open"] == true and bool(ch0[6].get("cross_story", false)) and ch0[6].get("target_story", "") == "chapter2" and ch0[6].get("target_passage", "") == "gate", "choice 6 (cross-story chapter2::gate) is open with cross-story metadata")
	_assert(not runner.choose(2), "cannot take closed choice 2")
	_assert(not runner.choose(3), "cannot take target-closed choice 3")

	# 4. Take @once choice 1 -> sniff -> return to start -> verify @once is closed
	_assert(runner.choose(1), "took @once choice 1")
	_assert(runner.current_id() == "sniff", "now at sniff")
	_assert(runner.get_state()["mood"] == "EXCITED", "mood set to EXCITED")
	_assert(runner.get_blocks().size() == 1 and runner.get_blocks()[0]["kind"] == "narration", "fallback narration block when blocks absent")
	_assert(runner.get_blocks()[0]["text"] == "A great smell. Mood=EXCITED.", "fallback narration block renders {mood}")

	_assert(runner.choose(0), "back to start from sniff")
	_assert(runner.current_id() == "start", "back at start")
	_assert(runner.get_visits()["start"] == 2, "start visits == 2")
	_assert(runner.get_state()["energy"] == 90.0, "start onEnter ran again: 85+5=90")

	var rendered2: String = runner.render_text()
	_assert(not rendered2.contains("First step."), "once hidden on visit 2: " + rendered2)
	_assert(rendered2.contains(" B "), "cycle picks B on visit 2: " + rendered2)
	_assert(rendered2.contains("Returned."), "visits(start) >= 2 true on visit 2: " + rendered2)

	var ch_after_once: Array[Dictionary] = runner.get_choices()
	_assert(ch_after_once[1]["open"] == false and ch_after_once[1]["closed_by"] == "once", "@once choice now closed_by=once")
	_assert(not runner.choose(1), "cannot retake @once choice")

	# 5. Take choice 0 (Visit pond): cost treats 1 (1->0), set coins *= 0.5 (5 -> int 2), pond onEnter energy +10 (90->100), fires sfx_step + sfx_quack
	cues_log.clear()
	_assert(runner.choose(0), "took Visit pond")
	_assert(runner.current_id() == "pond", "now at pond")
	_assert(runner.get_state()["treats"] == 0, "treats deducted to 0")
	_assert(runner.get_state()["coins"] is int and runner.get_state()["coins"] == 2, "coins truncated toward zero 5*0.5=2")
	_assert(runner.get_state()["energy"] == 100.0, "energy clamped at 100")
	_assert(cues_log == ["sfx_step(gravel)", "sfx_quack(2)"], "choice cue then passage cue fired: " + str(cues_log))

	# Verify negative int truncation toward zero via apply_effects directly
	var neg_st: Dictionary = runner.apply_effects({ "coins": -5 }, [{ "variable": "coins", "op": "mul", "amount": 0.5 }])
	_assert(neg_st["coins"] is int and neg_st["coins"] == -2, "negative int mul truncates toward zero: -5*0.5=-2, got " + str(neg_st["coins"]))

	# Verify clamping at min & max via apply_effects
	var clamped_hi: Dictionary = runner.apply_effects({ "energy": 90.0 }, [{ "variable": "energy", "op": "add", "amount": 50.0 }])
	var clamped_lo: Dictionary = runner.apply_effects({ "energy": 10.0 }, [{ "variable": "energy", "op": "add", "amount": -50.0 }])
	_assert(clamped_hi["energy"] == 100.0, "clamps to max 100")
	_assert(clamped_lo["energy"] == 0.0, "clamps to min 0")

	# Return from pond to start -> treats == 0 so Visit pond is closed_by=cost, secret gate is NOW open via visited(pond)!
	_assert(runner.choose(0), "back to start from pond")
	_assert(runner.get_visits()["start"] == 3, "start visits == 3")
	var ch_after_pond: Array[Dictionary] = runner.get_choices()
	_assert(ch_after_pond[0]["open"] == false and ch_after_pond[0]["closed_by"] == "cost", "Visit pond closed by cost when treats=0")
	_assert(ch_after_pond[2]["open"] == true, "Secret gate opened after visiting pond")
	_assert(runner.render_text().contains("Saw ducks."), "visited(pond) true in render_text")
	_assert(runner.render_text().contains(" C "), "cycle picks C on visit 3")

	# 6. Interrupt + @return
	var intrs0: Array[Dictionary] = runner.get_interrupts()
	_assert(intrs0.size() == 1 and intrs0[0]["id"] == "loud_bang" and intrs0[0]["open"] == false, "interrupt closed when noise=10")
	_assert(not runner.trigger_interrupt("loud_bang"), "trigger_interrupt fails when condition false")

	runner.set_var("noise", 85.0)
	var intrs1: Array[Dictionary] = runner.get_interrupts()
	_assert(intrs1[0]["open"] == true, "interrupt open when noise=85")

	var start_visits_before_intr: int = int(runner.get_visits()["start"])
	_assert(runner.trigger_interrupt("loud_bang"), "trigger_interrupt succeeds")
	_assert(runner.current_id() == "loud_bang", "inside loud_bang interrupt")
	_assert(not runner.trigger_interrupt("loud_bang"), "interrupts do not nest")
	var intrs_nested: Array[Dictionary] = runner.get_interrupts()
	_assert(intrs_nested[0]["open"] == false, "interrupts report open=false while inside interrupt")

	# Take @return choice: energy -10 (100 -> 90), returns to start WITHOUT re-running start onEnter (+5) or incrementing start visits!
	_assert(runner.choose(0), "took @return choice")
	_assert(runner.current_id() == "start", "returned to start")
	_assert(runner.get_state()["energy"] == 90.0, "@return kept -10 effect and did NOT re-run start onEnter (+5): got " + str(runner.get_state()["energy"]))
	_assert(int(runner.get_visits()["start"]) == start_visits_before_intr, "@return did not increment start visits")

	# 7. Save / Load round-trip through JSON
	var saved_json: String = JSON.stringify(runner.to_dict())
	var parsed_snap: Variant = JSON.parse_string(saved_json)
	_assert(parsed_snap is Dictionary, "saved snapshot parses back as Dictionary")
	var loaded: RiverRunner = RiverRunner.new()
	loaded.from_dict(parsed_snap as Dictionary, story)
	_assert(loaded.current_id() == "start", "loaded current_id == start")
	_assert(loaded.get_state()["energy"] == 90.0, "loaded energy == 90")
	_assert(loaded.get_state()["coins"] is int and loaded.get_state()["coins"] == 2, "loaded coins preserved as int 2")
	_assert(loaded.get_visits()["pond"] is int and loaded.get_visits()["pond"] == 1, "loaded visits preserved as int")
	_assert(loaded.get_choices()[1]["closed_by"] == "once", "loaded runner remembers @once used")
	_assert(loaded.can_undo(), "loaded runner preserves undo stack")

	# 8. Undo from start -> back into loud_bang interrupt -> undo again back to start before interrupt
	_assert(loaded.undo(), "undo 1 back into loud_bang")
	_assert(loaded.current_id() == "loud_bang", "undo restored interrupt passage")
	_assert(loaded.get_state()["energy"] == 100.0, "undo restored energy before @return")
	_assert(loaded.undo(), "undo 2 back before interrupt")
	_assert(loaded.current_id() == "start", "undo restored start before interrupt")

	# Undo all the way to start and verify @once reopens
	while loaded.can_undo():
		loaded.undo()
	_assert(loaded.current_id() == "start", "undid all the way to initial start")
	_assert(loaded.get_visits()["start"] == 1, "visits rolled back to 1")
	_assert(loaded.get_choices()[1]["open"] == true, "@once choice reopened after full undo")
	_assert(not loaded.undo(), "undo returns false at root")

	# 9. Ending passage emits story_ended and blocks interrupts
	ended_log.clear()
	_assert(runner.choose(5), "took Go home ending")
	_assert(runner.current_id() == "home", "at home")
	_assert(runner.is_over(), "story is_over at ending")
	_assert(ended_log == ["home:true"], "story_ended emitted with (home, true)")
	_assert(not runner.trigger_interrupt("loud_bang"), "cannot trigger interrupt after ending")

	# 10. Cross-story choice applies cost/set, emits cross_story_requested, and returns true
	var cross_runner: RiverRunner = RiverRunner.new()
	var cross_log: Array[String] = []
	var cross_cues: Array[String] = []
	var cross_choices: Array[String] = []
	cross_runner.cross_story_requested.connect(func(sid: String, pid: String) -> void:
		cross_log.append("%s::%s" % [sid, pid])
	)
	cross_runner.cue_triggered.connect(func(cname: String, cargs: String) -> void:
		cross_cues.append("%s(%s)" % [cname, cargs])
	)
	cross_runner.choice_taken.connect(func(pid: String, idx: int, _c: Dictionary) -> void:
		cross_choices.append("%s:%d" % [pid, idx])
	)
	cross_runner.start(story)
	cross_cues.clear()
	_assert(cross_runner.choose(6), "cross-story choice returns true")
	_assert(cross_runner.get_state()["coins"] == 4, "cross-story choice applied cost coins 5-1=4")
	_assert(cross_runner.get_state()["mood"] == "EXCITED", "cross-story choice applied set mood=EXCITED")
	_assert(cross_runner.get_turn() == 1, "cross-story choice incremented turn to 1")
	_assert(cross_choices == ["start:6"], "cross-story choice emitted choice_taken")
	_assert(cross_cues == ["sfx_portal(ch2)"], "cross-story choice emitted cue_triggered")
	_assert(cross_log == ["chapter2::gate"], "cross_story_requested emitted (chapter2, gate): " + str(cross_log))

	# 11. Invalid {when ...} template condition renders verbatim instead of falling through to else
	_assert(cross_runner.render_text("{when ???: a | b}") == "{when ???: a | b}", "invalid when condition renders verbatim: " + cross_runner.render_text("{when ???: a | b}"))

	# 12. from_dict rejects invalid history (unknown passage_id or empty array) without corrupting current runner state
	var before_id: String = cross_runner.current_id()
	var before_coins: Variant = cross_runner.get_state()["coins"]
	var before_turn: int = cross_runner.get_turn()
	_assert(not cross_runner.from_dict({ "history": [] }, story), "from_dict rejects empty history")
	_assert(cross_runner.current_id() == before_id and cross_runner.get_state()["coins"] == before_coins and cross_runner.get_turn() == before_turn, "empty history left runner state intact")
	_assert(not cross_runner.from_dict({ "history": [{ "passage_id": "start", "state": {} }, { "passage_id": "missing_passage", "state": {} }] }, story), "from_dict rejects unknown passage_id in history")
	_assert(cross_runner.current_id() == before_id and cross_runner.get_state()["coins"] == before_coins and cross_runner.get_turn() == before_turn, "unknown passage_id left runner state intact")
`

describe("Godot 4 runtime addon packaging", () => {
  it("resolves GODOT_RUNTIME_DIR with all addon files", () => {
    for (const file of ["plugin.cfg", "river_plugin.gd", "river_story.gd", "river_runner.gd"]) {
      expect(existsSync(path.join(GODOT_RUNTIME_DIR, file)), file).toBe(true)
    }
  })

  it("installGodotRuntime copies addons/river/* into a Godot project", async () => {
    const projectDir = path.join(scratch, "install-check")
    const files = await installGodotRuntime(projectDir)
    expect(files.map((f) => path.basename(f))).toEqual([
      "plugin.cfg",
      "river_plugin.gd",
      "river_runner.gd",
      "river_story.gd",
    ])
    for (const f of files) {
      expect(existsSync(f)).toBe(true)
    }
  })
})

describe.skipIf(!bin)("Godot 4 runtime addon headless execution (GODOT_BIN)", { timeout: 60_000 }, () => {
  it("loads exported JSON and passes full RiverStory + RiverRunner parity suite in headless Godot", async () => {
    const projectDir = path.join(scratch, "godot-project")
    mkdirSync(projectDir, { recursive: true })
    await installGodotRuntime(projectDir)

    writeFileSync(path.join(projectDir, "project.godot"), STRICT_PROJECT_GODOT, "utf8")
    writeFileSync(path.join(projectDir, "story.json"), JSON.stringify(STORY_JSON, null, 2), "utf8")
    writeFileSync(path.join(projectDir, "test_runtime.gd"), TEST_SCRIPT, "utf8")

    // Import once so Godot builds .godot/global_script_class_cache.cfg for RiverStory and RiverRunner.
    const imp = await runGodot(bin!, ["--headless", "--path", projectDir, "--import"])
    expect(imp.code, `godot --import failed:\n${imp.output}`).toBe(0)

    const res = await runGodot(bin!, ["--headless", "--path", projectDir, "-s", "res://test_runtime.gd"])
    expect(res.output).not.toMatch(/SCRIPT ERROR|Parse Error/)
    expect(res.code, `godot test script failed:\n${res.output}`).toBe(0)
    expect(res.output).toContain("ALL_TESTS_PASSED")
  })
})

// --- Storylets and @auto interrupts: stories built by @river/core from Twee, so the JSON is exactly what `river export` writes. ---

const DECK_SCHEMA: StateSchema = {
  energy: { type: "int", min: 0, max: 10, initial: 5 },
  rain: { type: "bool", initial: false },
}

const twee = (lines: string[]) => [":: StoryData", '{ "ifid": "9B1D7C2E-3F4A-4B5C-8D6E-7F8091A2B3C4", "start": "Hub" }', "", ...lines].join("\n")

function exported(id: string, ...lines: string[]): ExportedStory {
  const { story, diagnostics } = parseTwee3(twee(lines), `${id}.twee`)
  if (diagnostics.length > 0) throw new Error(`${id}: ${JSON.stringify(diagnostics)}`)
  return exportStory(story, DECK_SCHEMA, id)
}

const DECK_LINES = [
  ":: Hub", "--", "[[Wait->Hub2]]", "[[Go home->Home]]", "",
  ":: Hub2", "--", "[[Back->Hub]]", "",
  ":: Home", "@end", "--", "",
  ":: Squirrel [storylet]", "@weight 3", "@cooldown 2", "@set energy -= 1", "--", "A squirrel!", "[[Carry on->@return]]", "",
  ":: Puddle [storylet]", "@when energy >= 3", "--", "[[Splash->@return]] @set energy -= 2", "",
  ":: Storm [storylet]", "@priority 5", "@when rain == true", "--", "[[Shelter->@return]]",
]

const STORYLET_STORIES: Record<string, ExportedStory> = {
  deck: exported("deck", ...DECK_LINES),
  doom: exported("doom", ":: Hub", "--", "[[Loop->Hub]]", "", ":: Doom [storylet]", "@end", "--", "The end."),
  auto: exported(
    "auto",
    ":: Hub", "--", "[[Run->Hub]] @set energy -= 3", "[[Rest->Hub]] @set energy += 1", "",
    ":: Tired [interrupt]", "@auto", "@when energy <= 2", "--", "[[Sit->@return]] @set energy += 5", "",
    ":: Collapse [interrupt]", "@auto", "@priority 10", "@when energy == 0", "@end", "--", "You collapse.", "",
    ":: Manual [interrupt]", "@when energy <= 2", "--", "[[Ok->@return]]",
  ),
  order: exported(
    "order",
    ":: Hub", "--", "[[Go->Hub]] @set rain = true", "",
    ":: Manual [interrupt]", "@when rain == true", "--", "[[Ok->@return]]", "",
    ":: First [interrupt]", "@auto", "@when rain == true", "--", "[[Ok->@return]]", "",
    ":: Second [interrupt]", "@auto", "@when rain == true", "--", "[[Ok->@return]]",
  ),
  nested: exported(
    "nested",
    ":: Hub", "--", "[[Wait->Hub]]", "",
    ":: Deck [storylet]", "--", "[[Deeper->Inner]]", "",
    ":: Inner", "--", "[[Back->@return]]", "",
    ":: Alarm [interrupt]", "@auto", "--", "[[Ok->@return]]",
  ),
  direct: exported("direct", ":: Hub", "--", "[[Go->Alarm]]", "", ":: Alarm [interrupt]", "@auto", "@when rain == false", "--", "[[Ok->Hub]]"),
  welcome: exported(
    "welcome",
    ":: Hub", "--", "[[Go->Room]]", "",
    ":: Room", "--", "[[Back->Hub]]", "",
    ":: Welcome [interrupt]", "@auto", "@when visited(room) and visits(welcome) == 0", "--", "[[Ok->@return]]",
  ),
}

/** The deck run both engines play: rolls for draws, indexes for choices. */
const DECK_SCRIPT: ({ draw: number } | { choose: number } | { undo: true })[] = [
  { draw: 0.74 }, { choose: 0 }, { draw: 0 }, { choose: 0 }, { choose: 0 }, { draw: 0.5 }, { choose: 0 }, { undo: true }, { choose: 0 },
]

/** History rows [passage id, turn, return to, cooldowns] after core's playtest plays DECK_SCRIPT. */
function coreDeckTrace(): [string, number, string, Record<string, number>][] {
  const { story } = parseTwee3(twee(DECK_LINES), "deck.twee")
  const play = createPlaytest(story, DECK_SCHEMA)
  for (const step of DECK_SCRIPT) {
    if ("draw" in step) play.drawStorylet(() => step.draw)
    else if ("choose" in step) play.choose(step.choose)
    else play.undo()
  }
  return play.history().map((h) => [h.passageId, h.turn, h.returnTo ?? "", h.cooldowns])
}

const DECK_SCRIPT_GD = DECK_SCRIPT.map((step) =>
  "draw" in step ? `\tr.draw_storylet(null, ${step.draw.toFixed(2)})` : "choose" in step ? `\tr.choose(${step.choose})` : "\tr.undo()",
).join("\n")

const STORYLET_TEST_SCRIPT = `extends SceneTree

var _failures: Array[String] = []


func _assert(cond: bool, msg: String) -> void:
	if not cond:
		_failures.append(msg)
		printerr("FAIL: " + msg)


func _initialize() -> void:
	_storylets()
	_auto_interrupts()
	_trace()
	if _failures.is_empty():
		print("ALL_TESTS_PASSED")
		quit(0)
	else:
		printerr("FAILED COUNT: %d" % _failures.size())
		quit(1)


func _load(id: String) -> RiverStory:
	var story: RiverStory = RiverStory.load_from_file("res://%s.json" % id)
	_assert(story != null, "%s.json loads" % id)
	return story


func _run(id: String) -> RiverRunner:
	var r: RiverRunner = RiverRunner.new()
	r.start(_load(id))
	return r


func _summary(r: RiverRunner) -> String:
	var parts: PackedStringArray = PackedStringArray()
	for s: Dictionary in r.storylets():
		parts.append("%s:%s:%.1f:%d:%d" % [s["id"], str(s["open"]), float(s["weight"]), int(s["priority"]), int(s["cooldown_left"])])
	return ",".join(parts)


func _step(r: RiverRunner, i: int) -> Dictionary:
	var hist: Array = r.to_dict()["history"] as Array
	return hist[i if i >= 0 else hist.size() + i] as Dictionary


func _sl(r: RiverRunner, id: String) -> Dictionary:
	for s: Dictionary in r.storylets():
		if s["id"] == id:
			return s
	return {}


func _history_ids(r: RiverRunner) -> String:
	var ids: PackedStringArray = PackedStringArray()
	for step: Variant in (r.to_dict()["history"] as Array):
		ids.append(str((step as Dictionary)["passage_id"]))
	return ",".join(ids)


func _storylets() -> void:
	var deck: RiverStory = _load("deck")
	_assert(deck.get_storylets().size() == 3, "deck has 3 storylets")
	_assert(deck.get_storylets()[0]["id"] == "squirrel", "get_storylets keeps story order and adds id")
	_assert(deck.get_interrupts().is_empty(), "storylets are not interrupts")

	# storylets(): weight, priority, cooldown and open
	var r: RiverRunner = _run("deck")
	_assert(_summary(r) == "squirrel:true:3.0:0:0,puddle:true:1.0:0:0,storm:false:1.0:5:0", "storylets() summary: " + _summary(r))
	_assert(r.get_turn() == 0 and r.get_cooldowns().is_empty(), "turn 0 and no cooldowns at the start")

	# draw by weight: squirrel 3 + puddle 1, roll 0.74 * 4 = 2.96 < 3 picks squirrel
	var drawn_log: Array[String] = []
	r.storylet_drawn.connect(func(pid: String) -> void:
		drawn_log.append("%s@%s:%d" % [pid, r.current_id(), r.get_turn()])
	)
	var drawn: Dictionary = r.draw_storylet(null, 0.74)
	_assert(drawn.get("id", "") == "squirrel", "roll 0.74 draws squirrel: " + str(drawn.get("id", "")))
	_assert(drawn_log == ["squirrel@squirrel:1"], "storylet_drawn emitted after entering: " + str(drawn_log))
	_assert(r.current_id() == "squirrel", "entered squirrel")
	_assert(r.get_state()["energy"] == 4, "squirrel onEnter energy 5-1=4")
	var top: Dictionary = _step(r, -1)
	_assert(top["return_to"] == "hub" and int(top["turn"]) == 1, "draw takes a turn and returns to hub: " + str(top))
	_assert(r.get_cooldowns() == { "squirrel": 3 }, "cooldown squirrel ends on turn 3: " + str(r.get_cooldowns()))
	var all_closed: bool = true
	for s: Dictionary in r.storylets():
		all_closed = all_closed and not bool(s["open"])
	_assert(all_closed, "nothing is open inside a detour")
	_assert(r.draw_storylet(null, 0.0).is_empty(), "draw inside a detour returns {}")
	_assert((r.to_dict()["history"] as Array).size() == 2, "a failed draw changes nothing")
	_assert(r.choose(0), "@return from squirrel")
	_assert(r.current_id() == "hub" and r.get_turn() == 2 and _step(r, -1)["return_to"] == "", "back at hub on turn 2")
	_assert(_run("deck").draw_storylet(null, 0.76).get("id", "") == "puddle", "roll 0.76 draws puddle")

	# cooldown blocks for its turns; undo restores it
	var c: RiverRunner = _run("deck")
	c.draw_storylet(null, 0.0)
	c.choose(0)
	_assert(not bool(_sl(c, "squirrel")["open"]) and int(_sl(c, "squirrel")["cooldown_left"]) == 1, "squirrel cooling down, 1 turn left")
	_assert(c.draw_storylet(null, 0.0).get("id", "") == "puddle", "only puddle is open")
	c.choose(0)
	_assert(bool(_sl(c, "squirrel")["open"]) and int(_sl(c, "squirrel")["cooldown_left"]) == 0, "squirrel open again on turn 4")
	c.undo()
	c.undo()
	_assert(not bool(_sl(c, "squirrel")["open"]) and int(_sl(c, "squirrel")["cooldown_left"]) == 1, "undo restores the cooldown")
	c.undo()
	c.undo()
	_assert(not c.can_undo() and bool(_sl(c, "squirrel")["open"]) and c.get_cooldowns().is_empty(), "undo to the start clears cooldowns")

	# the highest open priority wins whatever the weights
	var p: RiverRunner = _run("deck")
	p.set_var("rain", true)
	_assert(p.draw_storylet(null, 0.99).get("id", "") == "storm", "priority 5 storm wins")

	# weighted draw with a seeded RandomNumberGenerator: squirrel about 3 in 4
	var rng: RandomNumberGenerator = RandomNumberGenerator.new()
	rng.seed = 20261124
	var squirrels: int = 0
	for i: int in 400:
		var w: RiverRunner = _run("deck")
		if w.draw_storylet(rng).get("id", "") == "squirrel":
			squirrels += 1
	_assert(squirrels > 260 and squirrels < 340, "weighted draw ~75%% squirrel: %d / 400" % squirrels)

	# save / load keeps turn and cooldowns, as ints, with the undo stack
	var s1: RiverRunner = _run("deck")
	s1.draw_storylet(null, 0.0)
	s1.choose(0)
	var parsed: Variant = JSON.parse_string(JSON.stringify(s1.to_dict()))
	var loaded: RiverRunner = RiverRunner.new()
	loaded.from_dict(parsed as Dictionary, deck)
	_assert(loaded.get_turn() == 2, "loaded turn 2")
	_assert(loaded.get_cooldowns()["squirrel"] is int and loaded.get_cooldowns()["squirrel"] == 3, "loaded cooldown is int 3")
	_assert(int(_sl(loaded, "squirrel")["cooldown_left"]) == 1, "loaded squirrel has 1 turn left")
	loaded.undo()
	_assert(loaded.current_id() == "squirrel" and loaded.get_turn() == 1, "loaded undo goes back into the storylet")
	var old_save: RiverRunner = RiverRunner.new()
	old_save.from_dict({ "passage_id": "hub", "state": { "energy": 5, "rain": false } }, deck)
	_assert(old_save.get_turn() == 0 and old_save.get_cooldowns().is_empty(), "saves without turn/cooldowns default to 0 and {}")
	old_save.from_dict({ "history": [{ "passage_id": "hub", "state": { "energy": 5, "rain": false }, "visits": { "hub": 1 }, "used_once": {}, "return_to": "" }] }, deck)
	_assert(old_save.get_turn() == 0 and old_save.draw_storylet(null, 0.0).get("id", "") == "squirrel", "old history steps still draw")

	# a storylet with @end has nowhere to return to, and storylet_drawn fires before passage_entered / story_ended
	var d: RiverRunner = _run("doom")
	var doom_events: Array[String] = []
	d.storylet_drawn.connect(func(pid: String) -> void:
		doom_events.append("drawn:%s" % pid)
	)
	d.passage_entered.connect(func(pid: String, _p: Dictionary) -> void:
		doom_events.append("entered:%s" % pid)
	)
	d.story_ended.connect(func(pid: String, is_ending: bool) -> void:
		doom_events.append("ended:%s:%s" % [pid, str(is_ending)])
	)
	_assert(d.draw_storylet().get("id", "") == "doom", "draws doom with the global rng")
	_assert(d.is_over() and _step(d, -1)["return_to"] == "", "doom ends the story with no return")
	_assert(doom_events == ["drawn:doom", "entered:doom", "ended:doom:true"], "storylet_drawn fires before passage_entered and story_ended: " + str(doom_events))
	_assert(d.storylets()[0]["open"] == false, "nothing is open after the end")


func _auto_interrupts() -> void:
	# starts as its own step on the same turn; one undo takes it back
	var a: RiverRunner = _run("auto")
	var entered: Array[String] = []
	a.passage_entered.connect(func(pid: String, _p: Dictionary) -> void:
		entered.append(pid)
	)
	_assert(a.choose(0), "Run")
	_assert(a.current_id() == "tired", "@auto tired starts at energy 2")
	_assert(entered == ["hub", "tired"], "passage_entered for hub then tired: " + str(entered))
	_assert(_history_ids(a) == "hub,hub,tired", "history hub,hub,tired: " + _history_ids(a))
	_assert(int(_step(a, 1)["turn"]) == 1 and int(_step(a, 2)["turn"]) == 1, "interrupt keeps the turn")
	_assert(_step(a, -1)["return_to"] == "hub", "tired returns to hub")
	a.undo()
	_assert(a.current_id() == "hub" and a.get_state()["energy"] == 2, "undo takes back only the interrupt")
	a.choose(1)
	_assert(a.current_id() == "hub" and a.get_state()["energy"] == 3, "Rest: tired's @when no longer holds")

	# does not fire again on the @return
	var b: RiverRunner = _run("auto")
	b.choose(0)
	_assert(b.choose(0), "Sit (@return)")
	_assert(b.current_id() == "hub" and _step(b, -1)["return_to"] == "" and b.get_state()["energy"] == 7, "@return back to hub, no refire")
	_assert(b.get_turn() == 2, "@return takes a turn")
	b.undo()
	_assert(b.current_id() == "tired" and _step(b, -1)["return_to"] == "hub" and b.get_turn() == 1, "undo the @return: back inside tired")
	b.undo()
	_assert(b.current_id() == "hub" and b.get_state()["energy"] == 2 and _history_ids(b) == "hub,hub", "undo again: hub before the interrupt")

	# higher priority wins; an @auto @end interrupt ends the story
	var e: RiverRunner = _run("auto")
	var ended: Array[String] = []
	e.story_ended.connect(func(pid: String, is_ending: bool) -> void:
		ended.append("%s:%s" % [pid, str(is_ending)])
	)
	e.set_var("energy", 3)
	e.choose(0)
	_assert(e.current_id() == "collapse", "priority 10 collapse beats tired")
	_assert(e.is_over() and _step(e, -1)["return_to"] == "", "collapse ends the story")
	_assert(ended == ["collapse:true"], "story_ended only for collapse: " + str(ended))
	e.undo()
	_assert(e.current_id() == "hub" and e.get_state()["energy"] == 0 and not e.is_over(), "undo leaves collapse")

	# equal priority keeps story order; interrupts without @auto never start by themselves
	var o: RiverRunner = _run("order")
	o.choose(0)
	_assert(o.current_id() == "first", "first @auto in story order: " + o.current_id())

	# does not fire inside an interrupt or a storylet
	var n: RiverRunner = _run("nested")
	_assert(n.draw_storylet().get("id", "") == "deck", "draw deck")
	n.choose(0)
	_assert(n.current_id() == "inner", "inner inside the storylet, no alarm")
	n.choose(0)
	_assert(n.current_id() == "hub", "@return to hub, no alarm on @return")
	n.choose(0)
	_assert(n.current_id() == "alarm", "alarm on the next move")

	# a choice that links straight to an @auto interrupt does not start it on top of itself
	var t: RiverRunner = _run("direct")
	t.choose(0)
	_assert(_history_ids(t) == "hub,alarm", "direct link: " + _history_ids(t))

	# @when sees the visit counts with the new passage counted
	var v: RiverRunner = _run("welcome")
	v.choose(0)
	_assert(v.current_id() == "welcome", "welcome after the first visit to room")
	v.choose(0)
	v.choose(0)
	v.choose(0)
	_assert(v.current_id() == "room", "welcome only once")


func _trace() -> void:
	var r: RiverRunner = _run("deck")
${DECK_SCRIPT_GD}
	var rows: Array = []
	for step: Variant in (r.to_dict()["history"] as Array):
		var st: Dictionary = step as Dictionary
		rows.append([st["passage_id"], st["turn"], st["return_to"], st["cooldowns"]])
	print("TRACE " + JSON.stringify(rows))
`

describe.skipIf(!bin)("Godot 4 runtime storylets and @auto interrupts (GODOT_BIN)", { timeout: 90_000 }, () => {
  it("matches @river/core playtest for storylets, cooldowns, priority, weighted draws, @auto, undo and saves", async () => {
    const projectDir = path.join(scratch, "godot-storylets")
    mkdirSync(projectDir, { recursive: true })
    await installGodotRuntime(projectDir)
    writeFileSync(path.join(projectDir, "project.godot"), STRICT_PROJECT_GODOT, "utf8")
    for (const [id, data] of Object.entries(STORYLET_STORIES)) {
      writeFileSync(path.join(projectDir, `${id}.json`), JSON.stringify(data, null, 2), "utf8")
    }
    writeFileSync(path.join(projectDir, "test_storylets.gd"), STORYLET_TEST_SCRIPT, "utf8")

    const imp = await runGodot(bin!, ["--headless", "--path", projectDir, "--import"])
    expect(imp.code, `godot --import failed:\n${imp.output}`).toBe(0)
    const res = await runGodot(bin!, ["--headless", "--path", projectDir, "-s", "res://test_storylets.gd"])
    expect(res.output).not.toMatch(/SCRIPT ERROR|Parse Error/)
    expect(res.code, `godot storylet suite failed:\n${res.output}`).toBe(0)
    expect(res.output).toContain("ALL_TESTS_PASSED")

    // The same run in @river/core's playtest gives the same history, step for step.
    const line = res.output.split(/\r?\n/).find((l) => l.startsWith("TRACE "))
    expect(line, res.output).toBeDefined()
    expect(JSON.parse(line!.slice("TRACE ".length))).toEqual(coreDeckTrace())
  })

  it("batch_capture.gd parses under strict warnings and exits 1 on a scene it cannot load", async () => {
    const projectDir = path.join(scratch, "godot-batch")
    mkdirSync(projectDir, { recursive: true })
    // The batch script runs from outside the game's addons/, so the game's own unsafe_* warnings apply to it too.
    const unsafe = ["unsafe_property_access", "unsafe_method_access", "unsafe_cast", "unsafe_call_argument"].map((w) => `gdscript/warnings/${w}=2`)
    writeFileSync(path.join(projectDir, "project.godot"), `${STRICT_PROJECT_GODOT}${unsafe.join("\n")}\n`, "utf8")
    const script = GODOT_BATCH_SCRIPT.replace(/\\/g, "/")
    const check = await runGodot(bin!, ["--headless", "--path", projectDir, "--check-only", "-s", script])
    expect(check.output).not.toMatch(/SCRIPT ERROR|Parse Error/)
    expect(check.code, check.output).toBe(0)

    const manifest = path.join(projectDir, "batch.json").replace(/\\/g, "/")
    const outDir = path.join(projectDir, "out").replace(/\\/g, "/")
    writeFileSync(manifest, JSON.stringify([{ id: "nope", scene: "res://missing.tscn", setup: "", outDir, count: 1, ticks: 3 }]), "utf8")
    const res = await runGodot(bin!, ["--headless", "--path", projectDir, "-s", script, "--", `--manifest=${manifest}`])
    expect(res.code, res.output).toBe(1)
    expect(res.output).toContain("batch_capture: shot nope cannot load scene res://missing.tscn")
  })
})
