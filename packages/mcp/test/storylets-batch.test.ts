import { readFileSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { beforeEach, describe, expect, it } from "vitest"
import { loadProject, type EngineAdapter, type Project, type ShotDef, type SimulationReport } from "@river/core"
import { adapterFor, createRiverTools, type RiverTool } from "../src/index"
import { tempProject } from "./helpers"

const PARK = "stories/park_walk.twee"
const DECK = "stories/deck.twee"

/** A hub with a wait loop and a home ending, two storylets (one weighted, with a cooldown) and an @auto interrupt. */
const DECK_TWEE = `:: StoryTitle
Deck

:: StoryData
{
  "ifid": "9B1D7C2E-3F4A-4B5C-8D6E-7F8091A2B3C4",
  "start": "Hub"
}

:: Hub
--
Hub.
[[Wait->Hub2]]
[[Go home->Home]] @set treats += 1

:: Hub2
--
Hub two.
[[Back->Hub]]

:: Home
@end
--
Home.

:: Squirrel [storylet]
@weight 3
@cooldown 2
@set energy -= 1
--
A squirrel!
[[Carry on->@return]]

:: Puddle [storylet]
@priority 0
@when energy >= 3
--
A puddle.
[[Splash->@return]]

:: Alarm [interrupt]
@auto
@priority 2
@when energy < 20
--
Wake up.
[[Fine->@return]]
`

let dir: string
let project: Project
let tools: RiverTool[]
const call = (name: string, input: unknown = {}, list: RiverTool[] = tools) => {
  const t = list.find((x) => x.name === name)
  if (!t) throw new Error(`no tool ${name}`)
  return t.handler(input)
}

async function reload(manifest?: (m: Record<string, unknown>) => void, extra?: Partial<Parameters<typeof createRiverTools>[1]>): Promise<void> {
  if (manifest) {
    const m = JSON.parse(readFileSync(join(dir, "river.json"), "utf8")) as Record<string, unknown>
    manifest(m)
    writeFileSync(join(dir, "river.json"), JSON.stringify(m))
  }
  project = await loadProject(dir)
  tools = createRiverTools(project, extra)
}

beforeEach(async () => {
  dir = tempProject()
  writeFileSync(join(dir, DECK), DECK_TWEE)
  await reload()
})

describe("story_simulate", () => {
  it("reports endings, steps and state averages, the same every time for one seed", async () => {
    const r = await call("story_simulate", { file: DECK, runs: 100, seed: 5 })
    const report = (r.data as { file: string; report: SimulationReport }).report
    expect(report.runs).toBe(100)
    expect(report.seed).toBe(5)
    expect(report.endings.map((e) => e.name)).toEqual(["Home"])
    expect(report.endings[0]).toMatchObject({ passageId: "home", count: 100, rate: 1 })
    expect(report.deadEnds).toBe(0)
    // Every game ends at Home through "Go home" (treats += 1: 2 -> 3), and nothing touches energy.
    expect(report.finalState["treats"]).toMatchObject({ type: "int", min: 3, max: 3, avg: 3 })
    expect(report.finalState["energy"]).toMatchObject({ avg: 80 })
    // Interrupts and storylets are not entered when a choice is always open, so none was visited.
    expect(report.neverVisitedPassages).toEqual(expect.arrayContaining(["squirrel", "puddle", "alarm"]))
    expect(report.neverTakenChoices.map((c) => c.label)).not.toContain("Wait")

    expect(r.text.split("\n")[0]).toBe(DECK)
    expect(r.text).toContain("100 simulated games (seed 5)")
    expect(r.text).toContain("Home")
    expect(r.text).toContain("final state:")

    const again = await call("story_simulate", { file: DECK, runs: 100, seed: 5 })
    expect(again.text).toBe(r.text)
    expect(again.data).toEqual(r.data)
    const other = await call("story_simulate", { file: DECK, runs: 100, seed: 6 })
    expect((other.data as { report: SimulationReport }).report.seed).toBe(6)
  })

  it("defaults to 200 runs and seed 1, and stops a game at maxSteps", async () => {
    const r = await call("story_simulate", { file: DECK })
    const report = (r.data as { report: SimulationReport }).report
    expect(report.runs).toBe(200)
    expect(report.seed).toBe(1)
    const short = (await call("story_simulate", { file: DECK, runs: 50, maxSteps: 1 })).data as { report: SimulationReport }
    expect(short.report.maxStepsHit + short.report.endings.reduce((n, e) => n + e.count, 0)).toBe(50)
    expect(short.report.steps.max).toBeLessThanOrEqual(1)
  })

  it("plays an @auto interrupt, and draws storylets only when asked and nothing else is open", async () => {
    const dead = `:: StoryData
{ "ifid": "9B1D7C2E-3F4A-4B5C-8D6E-7F8091A2B3C4", "start": "Stuck" }

:: Stuck
--
Nothing to do.

:: Rain [storylet]
@cooldown 1
--
Rain.
[[Look up->Done]]

:: Done
@end
--
Done.
`
    writeFileSync(join(dir, "stories/stuck.twee"), dead)
    const off = (await call("story_simulate", { file: "stories/stuck.twee", runs: 20, includeStorylets: false })).data as { report: SimulationReport }
    expect(off.report.deadEnds).toBe(20)
    expect(off.report.endings).toEqual([])
    const on = (await call("story_simulate", { file: "stories/stuck.twee", runs: 20 })).data as { report: SimulationReport }
    expect(on.report.deadEnds).toBe(0)
    expect(on.report.endings[0]).toMatchObject({ name: "Done", count: 20 })
  })

  it("takes the only story without file, and asks for one when there are several", async () => {
    await expect(call("story_simulate", {})).rejects.toThrow(/give a story file; this project has 2: stories\/deck\.twee, stories\/park_walk\.twee/)
    rmSync(join(dir, PARK))
    const r = await call("story_simulate", { runs: 10 })
    expect(r.text.split("\n")[0]).toBe(DECK)
    expect((r.data as { file: string }).file).toBe(DECK)
  })

  it("is a read tool and rejects bad input", async () => {
    expect(tools.find((t) => t.name === "story_simulate")!.mutating).toBe(false)
    for (const bad of [{ runs: 0 }, { runs: 2001 }, { runs: 1.5 }, { seed: 1.5 }, { maxSteps: 0 }, { maxSteps: 1001 }, { includeStorylets: "yes" }]) {
      await expect(call("story_simulate", { file: DECK, ...bad }), JSON.stringify(bad)).rejects.toThrow(/invalid input for story_simulate/)
    }
    await expect(call("story_simulate", { file: "stories/nope.twee" })).rejects.toThrow(/is not a story file/)
    await expect(call("story_simulate", { file: "../x.twee" })).rejects.toThrow()
  })
})

describe("playtest_run with storylets", () => {
  it("draws a storylet with a seed, repeatably, and lists the open ones", async () => {
    const run = () => call("playtest_run", { file: DECK, steps: [{ drawStorylet: true, seed: 1 }] })
    const r = await run()
    expect(r.text).toContain("! storylet:")
    const drawn = (r.data as { steps: { name: string; storylet?: string }[] }).steps.at(-1)!
    expect(["Squirrel", "Puddle"]).toContain(drawn.name)
    expect(drawn.storylet).toBe(drawn.name.toLowerCase())
    expect(r.text).toContain(`! storylet: ${drawn.name}`)
    expect((await run()).text).toBe(r.text)
    // A storylet is a detour: its @return comes back to the hub. The deck is listed with what the draw weighs.
    const back = await call("playtest_run", { file: DECK, steps: [{ drawStorylet: true, seed: 1, choice: 0 }] })
    expect(back.text).toContain("== Hub ==")
    expect(back.text).toMatch(/storylet Squirrel {2}\[can draw, weight 3\]/)
    expect(back.text).toMatch(/storylet Puddle {2}\[can draw\]/)
    expect(back.text).toMatch(/interrupt Alarm {2}\[closed: energy < 20\]/)
  })

  it("draws every storylet over seeds, applies its @set and honours @cooldown", async () => {
    const seen = new Set<string>()
    for (let seed = 1; seed <= 12; seed++) {
      const r = await call("playtest_run", { file: DECK, steps: [{ drawStorylet: true, seed }] })
      const step = (r.data as { steps: { name: string; state: Record<string, number> }[] }).steps.at(-1)!
      seen.add(step.name)
      if (step.name === "Squirrel") expect(step.state["energy"]).toBe(79)
    }
    expect([...seen].sort()).toEqual(["Puddle", "Squirrel"])
    // Squirrel has @cooldown 2: after it is drawn and left, only Puddle is open for the next draw.
    const r = await call("playtest_run", {
      file: DECK,
      steps: [{ drawStorylet: true, seed: 1, choice: 0 }, { drawStorylet: true, seed: 1, choice: 0 }, { drawStorylet: true, seed: 1 }],
    })
    const names = (r.data as { steps: { name: string; storylet?: string }[] }).steps.filter((s) => s.storylet !== undefined).map((s) => s.name)
    expect(names).toHaveLength(3)
    const first = names[0]!
    if (first === "Squirrel") expect(names[1]).toBe("Puddle")
  })

  it("fails clearly when nothing can be drawn, and for a step that mixes interrupt and drawStorylet", async () => {
    await expect(call("playtest_run", { file: PARK, steps: [{ drawStorylet: true }] })).rejects.toThrow(/step 1 \(drawStorylet\) failed: no storylet is open \(the story has no \[storylet\] passages\)/)
    await expect(call("playtest_run", { file: DECK, steps: [{ drawStorylet: true, interrupt: "Alarm" }] })).rejects.toThrow(/not both/)
    await expect(call("playtest_run", { file: DECK, steps: [{ seed: 3, choice: 0 }] })).rejects.toThrow(/seed only goes with drawStorylet/)
    await expect(call("playtest_run", { file: DECK, steps: [{ drawStorylet: false }] })).rejects.toThrow(/invalid input for playtest_run/)
    // The old steps still work.
    const r = await call("playtest_run", { file: DECK, steps: [{ set: { energy: 10 } }, { interrupt: "Alarm", choice: 0 }] })
    expect(r.text).toContain("! interrupt: Alarm")
  })

  it("draws without a seed (random) and still lands in a storylet", async () => {
    const r = await call("playtest_run", { file: DECK, steps: [{ drawStorylet: true }] })
    expect((r.data as { steps: { storylet?: string }[] }).steps.at(-1)!.storylet).toBeDefined()
  })
})

describe("story_outline with storylets and @auto", () => {
  it("shows weight, priority, cooldown and auto on passages", async () => {
    const r = await call("story_outline", { file: DECK })
    expect(r.text).toMatch(/- Squirrel \(id squirrel\) \[storylet\]  .*@set energy -= 1/)
    expect(r.text).toMatch(/- Squirrel .*@weight 3 @cooldown 2/)
    expect(r.text).toMatch(/- Puddle .*@when energy >= 3 @priority 0/)
    expect(r.text).toMatch(/- Alarm \(id alarm\) \[interrupt\]  @when energy < 20 @auto @priority 2/)
    // A plain passage shows none of them.
    const hub = r.text.split("\n").find((l) => l.startsWith("- Hub "))!
    expect(hub).not.toMatch(/@auto|@weight|@priority|@cooldown/)
    expect(r.text).toContain("@priority")
  })
})

describe("adapterFor and custom command engines", () => {
  it("picks Godot's adapter, a command adapter for an engine with adapter.<engine>.command, and says what is missing otherwise", async () => {
    await reload((m) => (m["engine"] = "godot"))
    expect(adapterFor(project).id).toBe("godot")

    await reload((m) => {
      m["engine"] = "mygame"
      m["adapter"] = { mygame: { command: "node capture.mjs" } }
    })
    expect(adapterFor(project).id).toBe("mygame")

    await reload((m) => {
      m["engine"] = "command"
      m["adapter"] = { command: { command: "node capture.mjs" } }
    })
    expect(adapterFor(project).id).toBe("command")

    await reload((m) => {
      m["engine"] = "unity"
      m["adapter"] = {}
    })
    expect(() => adapterFor(project)).toThrow(/no engine adapter for engine "unity" \(registered: "godot"\)[\s\S]*adapter\.unity\.command/)
    await reload((m) => (m["engine"] = "none"))
    expect(() => adapterFor(project)).toThrow(/engine "none"/)
  })

  it("frames_capture runs a custom command engine from river.json, with no adapter injected", async () => {
    writeFileSync(
      join(dir, "capture.mjs"),
      `import { writeFileSync } from "node:fs"
import { join } from "node:path"
writeFileSync(join(process.env.RIVER_OUT_DIR, "frame_00.png"), "single:" + process.env.RIVER_SHOT_ID)
`,
    )
    await reload((m) => {
      m["engine"] = "mygame"
      m["adapter"] = { mygame: { command: "node capture.mjs" } }
      m["shots"] = [{ id: "gate", scene: "res://gate.tscn", count: 1 }]
    })
    const r = await call("frames_capture", { shotId: "gate" })
    const files = (r.data as { files: string[] }).files
    expect(files).toHaveLength(1)
    expect(readFileSync(files[0]!, "utf8")).toBe("single:gate")
  })

  it("frames_capture batches through a custom engine's batchCommand", async () => {
    writeFileSync(
      join(dir, "batch.mjs"),
      `import { appendFileSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
const items = JSON.parse(readFileSync(process.env.RIVER_BATCH_MANIFEST, "utf8"))
appendFileSync(join(process.env.RIVER_PROJECT_ROOT, "batch.log"), items.map((i) => i.id).join(",") + "\\n")
for (const i of items) writeFileSync(join(i.outDir, "frame_00.png"), "batch:" + i.id)
`,
    )
    await reload((m) => {
      m["engine"] = "mygame"
      m["adapter"] = { mygame: { command: "node -e \"process.exit(1)\"", batchCommand: "node batch.mjs" } }
      m["shots"] = [
        { id: "gate", scene: "res://gate.tscn", count: 1 },
        { id: "pond", scene: "res://pond.tscn", count: 1 },
      ]
    })
    const r = await call("frames_capture", { all: true })
    const captures = (r.data as { captures: { shotId: string; files: string[] }[] }).captures
    expect(captures.map((c) => c.shotId)).toEqual(["gate", "pond"])
    expect(readFileSync(captures[1]!.files[0]!, "utf8")).toBe("batch:pond")
    expect(readFileSync(join(dir, "batch.log"), "utf8")).toBe("gate,pond\n")
  })
})

describe("frames_capture with several shots", () => {
  const SHOTS: ShotDef[] = [
    { id: "gate", scene: "res://gate.tscn", count: 1 },
    { id: "pond", scene: "res://pond.tscn", count: 2 },
    { id: "bridge", scene: "res://bridge.tscn", count: 1 },
  ]
  let singles: string[]
  let batches: string[][]
  let adapter: EngineAdapter

  beforeEach(async () => {
    singles = []
    batches = []
    adapter = {
      id: "fake",
      async capture(_p, shot, outDir) {
        singles.push(shot.id)
        const f = join(outDir, "frame_00.png")
        writeFileSync(f, "png")
        return [f]
      },
      async captureBatch(_p, items) {
        batches.push(items.map((i) => i.shot.id))
        const out: Record<string, string[]> = {}
        for (const { shot, outDir } of items) {
          const f = join(outDir, "frame_00.png")
          writeFileSync(f, "png")
          out[shot.id] = [f]
        }
        return out
      },
    }
    await reload((m) => (m["shots"] = SHOTS), { adapter })
  })

  it("captures shotIds in one batch call and returns each shot's frames in the order asked", async () => {
    const r = await call("frames_capture", { shotIds: ["pond", "gate"] })
    expect(batches).toEqual([["pond", "gate"]])
    expect(singles).toEqual([])
    const captures = (r.data as { captures: { shotId: string; files: string[] }[] }).captures
    expect(captures.map((c) => c.shotId)).toEqual(["pond", "gate"])
    expect(r.text).toContain("Captured 2 shots:")
    expect(r.text).toContain("pond at rev")
    expect(r.text).toContain(captures[0]!.files[0]!)
    expect(readFileSync(captures[1]!.files[0]!, "utf8")).toBe("png")
    expect((await call("frames_list", {})).text).toContain(captures[0]!.files[0]!)
  })

  it("captures every shot with all: true through adapter.captureBatch", async () => {
    const r = await call("frames_capture", { all: true })
    expect(batches).toEqual([["gate", "pond", "bridge"]])
    expect((r.data as { captures: unknown[] }).captures).toHaveLength(3)
    expect(r.text).toContain("Captured 3 shots:")
  })

  it("keeps shotId as a single capture, and falls back to one by one without captureBatch", async () => {
    const r = await call("frames_capture", { shotId: "gate" })
    expect(singles).toEqual(["gate"])
    expect(batches).toEqual([])
    expect((r.data as { shotId: string; files: string[] }).shotId).toBe("gate")
    expect(r.text).toMatch(/^Captured gate at rev .* \(1 frame\):/)

    const plain: EngineAdapter = { id: "plain", capture: adapter.capture }
    singles = []
    await reload(undefined, { adapter: plain })
    await call("frames_capture", { shotIds: ["gate", "pond"] })
    expect(singles).toEqual(["gate", "pond"])
    expect(batches).toEqual([])
  })

  it("treats a repeated id once, and checks every id before the engine runs", async () => {
    await call("frames_capture", { shotIds: ["gate", "gate"] })
    expect(singles).toEqual(["gate"])
    expect(batches).toEqual([])
    singles = []
    await expect(call("frames_capture", { shotIds: ["gate", "nope"] })).rejects.toThrow(/no shot "nope" in river\.json\. Shots: gate, pond, bridge/)
    await expect(call("frames_capture", { shotId: "nope" })).rejects.toThrow(/no shot "nope" in river\.json/)
    expect(singles).toEqual([])
    expect(batches).toEqual([])
  })

  it("needs exactly one of shotId, shotIds or all", async () => {
    for (const bad of [{}, { shotIds: [] }, { all: false }]) {
      await expect(call("frames_capture", bad), JSON.stringify(bad)).rejects.toThrow(/frames_capture needs one of: shotId .*shotIds .*all: true/)
    }
    await expect(call("frames_capture", { shotId: "gate", all: true })).rejects.toThrow(/takes only one of/)
    await expect(call("frames_capture", { shotIds: ["gate"], all: true })).rejects.toThrow(/takes only one of/)
    await expect(call("frames_capture", { shotIds: [""] })).rejects.toThrow(/invalid input for frames_capture/)
    expect(singles).toEqual([])
    expect(batches).toEqual([])
  })

  it("says so when river.json has no shots", async () => {
    await reload((m) => (m["shots"] = []), { adapter })
    await expect(call("frames_capture", { all: true })).rejects.toThrow(/river\.json has no shots to capture/)
  })
})
