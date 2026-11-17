import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { PassThrough, Writable } from "node:stream"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"
import { parseTwee3, writeTwineArchive } from "@river/core"
import { run } from "../src/index"

const example = fileURLToPath(new URL("../../../examples/park-walk/", import.meta.url))

function sink() {
  let text = ""
  const stream = new Writable({ write(chunk, _enc, cb) { text += String(chunk); cb() } })
  return { stream, text: () => text }
}

async function cli(argv: string[], input?: string) {
  const out = sink()
  const err = sink()
  const stdin = new PassThrough()
  if (input !== undefined) stdin.end(input)
  const code = await run(argv, { stdout: out.stream, stderr: err.stream, stdin })
  return { code, out: out.text(), err: err.text() }
}

function tempProject() {
  const dir = mkdtempSync(join(tmpdir(), "river-cli-"))
  mkdirSync(join(dir, "stories"))
  copyFileSync(join(example, "river.json"), join(dir, "river.json"))
  copyFileSync(join(example, "stories/state.json"), join(dir, "stories/state.json"))
  return dir
}

describe("river CLI", () => {
  it("lint reports the planted problems and exits 1", async () => {
    const r = await cli(["lint", example])
    expect(r.code).toBe(1)
    expect(r.out).toContain("error  Pond → Splash: no passage has this name\n")
    expect(r.out).toContain("warn   Fetch: dead end, no link and no @end\n")
    expect(r.out).toContain("1 error, 3 warnings in 9 passages")
  })

  it("paths numbers the routes", async () => {
    const r = await cli(["paths", example])
    expect(r.code).toBe(0)
    expect(r.out).toContain("2  Gate [Go to the pond] → Pond [Throw a treat] → Treat [Head home] → Home happy   when treats >= 1")
  })

  it("export refuses a story with errors", async () => {
    const r = await cli(["export", example])
    expect(r.code).toBe(1)
    expect(r.err).toContain("Splash")
  })

  it("play reads commands from stdin and stops at EOF", async () => {
    const r = await cli(["play", example], "1\n2\n:state\n")
    expect(r.code).toBe(0)
    expect(r.out).toContain("== Treat ==")
    expect(r.out).toContain("treats = 1")
  })

  it("import-twine writes stories/<slug>.twee and export writes JSON for a clean story", async () => {
    const dir = tempProject()
    const story = parseTwee3(readFileSync(join(example, "stories/park_walk.twee"), "utf8").replace("[[Let go->Splash]] @when excitement > 150\n", ""), "x").story
    writeFileSync(join(dir, "lib.html"), `<html><body>${writeTwineArchive(story)}</body></html>`)
    const r = await cli(["import-twine", join(dir, "lib.html"), dir])
    expect(r.code).toBe(0)
    expect(existsSync(join(dir, "stories/park_walk.twee"))).toBe(true)
    expect((await cli(["import-twine", join(dir, "lib.html"), dir])).code).toBe(1) // exists, no --force
    const e = await cli(["export", dir])
    expect(e.code).toBe(0)
    const json = JSON.parse(readFileSync(join(dir, "export/park_walk.json"), "utf8"))
    expect(json.start).toBe("gate")
  })

  it("shots lists the manifest shots", async () => {
    const empty = await cli(["shots", example])
    expect(empty.code).toBe(0)
    expect(empty.out).toContain("no shots in river.json")
    const dir = tempProject()
    const manifest = JSON.parse(readFileSync(join(dir, "river.json"), "utf8"))
    manifest.shots = [{ id: "gate_open", scene: "res://gate.tscn", count: 1, note: "first frame" }]
    writeFileSync(join(dir, "river.json"), JSON.stringify(manifest))
    const r = await cli(["shots", dir])
    expect(r.code).toBe(0)
    expect(r.out).toContain("gate_open  res://gate.tscn  1 frame  never captured  first frame")
  })

  it("capture picks the adapter by engine and explains a missing one", async () => {
    expect((await cli(["capture"])).code).toBe(2)
    const none = await cli(["capture", "gate_open", example])
    expect(none.code).toBe(1)
    expect(none.err).toContain('engine "none"')
    const dir = tempProject()
    const manifest = JSON.parse(readFileSync(join(dir, "river.json"), "utf8"))
    manifest.engine = "godot"
    manifest.shots = [{ id: "gate_open", scene: "res://gate.tscn", count: 1 }]
    writeFileSync(join(dir, "river.json"), JSON.stringify(manifest))
    const godot = await cli(["capture", "gate_open", dir])
    expect(godot.code).toBe(1)
    expect(godot.err).toContain("adapter.godot.bin is not set")
    const unknown = await cli(["capture", "nope", dir])
    expect(unknown.err).toContain('no shot "nope" in the manifest (shots: gate_open)')
  })
})

const STORY = [
  ":: StoryTitle", "Shop", "", ":: StoryData", '{ "ifid": "9B1D7C2E-3F4A-4B5C-8D6E-7F8091A2B3C4", "start": "Street" }', "",
  ":: Street", "--", "A shop and a locked gate.",
  '[[Buy a map->Shop]] @cost treats 3 @hint "Three treats"',
  "[[Try the gate->Gate]]",
  "[[Wander->Square]] @when energy > 10 and (bond < 5 or bond > 90)",
  "",
  ":: Shop", "@end", "--", "",
  ":: Gate", "@when bond >= 60", "@end", "--", "",
  ":: Square", "--", "[[Rest->Bench]] @when energy > 10", "", ":: Bench", "@end", "--", "",
  ":: Loud bang [interrupt]", "@id bang", "@when excitement >= 90", "--", "Everyone jumps.",
  "[[Calm down->@return]] @set excitement = 0, bond *= 0.5",
].join("\n")

function storyProject(story = STORY) {
  const dir = tempProject()
  writeFileSync(join(dir, "stories/shop.twee"), story)
  return dir
}

async function cliIn(cwd: string, argv: string[], input?: string) {
  const out = sink()
  const err = sink()
  const stdin = new PassThrough()
  if (input !== undefined) stdin.end(input)
  const code = await run(argv, { stdout: out.stream, stderr: err.stream, stdin, cwd })
  return { code, out: out.text(), err: err.text() }
}

describe("river paths", () => {
  it("labels each step, groups `or` terms, and lists interrupt routes after the others", async () => {
    const r = await cli(["paths", storyProject()])
    expect(r.out).toContain("1  Street [Buy a map] → Shop   when treats >= 3\n")
    expect(r.out).toContain("3  Street [Wander] → Square [Rest] → Bench   when energy > 10 and (bond < 5 or bond > 90)\n")
    expect(r.out).toContain("interrupts (each can start at any passage while its @when holds):\n4  Loud bang [Calm down] → @return   when excitement >= 90\n")
  })

  it("--summary counts routes by ending and --max stops early", async () => {
    const dir = storyProject()
    const s = await cli(["paths", dir, "--summary"])
    expect(s.out).toBe(
      [
        "4 routes: 4 possible, 0 never true; 4 distinct passage sequences",
        "  Shop                    1 route, 1 possible, 1 sequence",
        "  Gate                    1 route, 1 possible, 1 sequence",
        "  Bench                   1 route, 1 possible, 1 sequence",
        "  @return from Loud bang  1 route, 1 possible, 1 sequence",
        "",
      ].join("\n"),
    )
    const m = await cli(["paths", dir, "--max", "1"])
    expect(m.out).toContain("stopped at 1 routes; --max N lists more")
    expect(m.out).not.toContain("Gate   when")
    expect((await cli(["paths", dir, "--max", "0"])).code).toBe(2)
  })
})

describe("river play", () => {
  it("says why a choice is closed, shows hints, and runs an interrupt and its @return", async () => {
    const r = await cli(["play", storyProject()], "1\n2\n!1\n:set excitement 95\n!1\n1\n:state\n")
    expect(r.out).toContain("  1. Buy a map  (Three treats)  [@cost needs treats >= 3]\n")
    expect(r.out).toContain("  2. Try the gate  [Gate needs bond >= 60 on arrival]\n")
    expect(r.out).toContain('choice "Buy a map" is closed: @cost needs treats >= 3')
    expect(r.out).toContain("Loud bang cannot start: its @when excitement >= 90 is false")
    expect(r.out).toContain("== Loud bang ==\nEveryone jumps.")
    expect(r.out.lastIndexOf("== Street ==")).toBeGreaterThan(r.out.indexOf("== Loud bang =="))
    expect(r.out).toContain("excitement = 0\n")
    expect(r.out).toContain("bond = 25\n")
  })
})

describe("project folder and paths", () => {
  it("takes the folder as the argument after the command or as --root, read from the caller's folder", async () => {
    const dir = storyProject()
    const parent = join(dir, "..")
    const name = dir.slice(parent.length + 1)
    expect((await cliIn(parent, ["lint", name])).code).toBe(0)
    expect((await cliIn(parent, ["lint", "--root", name])).code).toBe(0)
    expect((await cliIn(dir, ["lint"])).out).toContain("1 warning in 6 passages")
    expect((await cliIn(parent, ["paths", name, "--root", name])).code).toBe(0)
    const twice = await cliIn(parent, ["lint", name, "--root", "elsewhere"])
    expect([twice.code, twice.err]).toEqual([2, `river lint: the project folder is given twice: "${name}" and --root "elsewhere"\n`])
    expect((await cliIn(parent, ["lint", name, "extra"])).err).toContain('unexpected "extra" (usage: river lint [dir])')
  })

  it("explains a folder that is missing or has no river.json", async () => {
    const dir = storyProject()
    const missing = await cli(["lint", join(dir, "nope")])
    expect(missing.err).toContain(`no folder at ${join(dir, "nope")}. River wants the game's root folder, the one that holds river.json`)
    const inner = await cli(["lint", join(dir, "stories")])
    expect(inner.err).toContain(`no river.json in ${join(dir, "stories")} (${dir} has one).`)
    const story = await cli(["lint", dir, "--story", "nope"])
    expect(story.err).toContain("stories here: stories/shop.twee")
    expect((await cli(["lint", dir, "--story", "shop"])).code).toBe(0)
  })

  it("capture takes the folder before or after the shot, and frames capture is the same command", async () => {
    const dir = storyProject()
    for (const argv of [["capture", dir, "walk"], ["capture", "walk", dir], ["frames", "capture", dir, "walk"], ["capture", "walk", "--root", dir]]) {
      const r = await cli(argv)
      expect([r.code, r.err]).toEqual([1, `river ${argv[0]}: this project has engine "none" in river.json, so it cannot capture frames (set "engine": "godot" and adapter.godot.bin)\n`])
    }
    expect((await cli(["capture", dir])).err).toContain("missing <shotId> (or --all)")
    expect((await cli(["frames", "list", dir])).out).toBe("no shots in river.json\n")
  })

  it("capture runs nothing when an argument is a folder without river.json or a shot is unknown", async () => {
    const dir = storyProject()
    const manifest = JSON.parse(readFileSync(join(dir, "river.json"), "utf8"))
    manifest.engine = "godot"
    manifest.adapter = { godot: { bin: join(dir, "no-godot-here") } }
    manifest.shots = [{ id: "gate_open", scene: "res://gate.tscn", count: 1 }]
    writeFileSync(join(dir, "river.json"), JSON.stringify(manifest))
    const folder = await cliIn(dir, ["capture", "gate_open", "stories"])
    expect([folder.code, folder.err]).toEqual([1, `river capture: no river.json in ${join(dir, "stories")} (${dir} has one). River wants the game's root folder, the one that holds river.json\n`])
    const unknown = await cli(["capture", dir, "gate_open", "nope"])
    expect([unknown.code, unknown.err]).toEqual([1, 'river capture: no shot "nope" in the manifest (shots: gate_open); nothing was captured\n'])
    expect(existsSync(join(dir, ".river"))).toBe(false)
  })

  it("captures prune needs --keep and reports what it deleted", async () => {
    const dir = storyProject()
    expect((await cli(["captures", "prune", dir])).code).toBe(2)
    for (const keep of ["", " ", "abc", "-1", "1.5", "0x2", "2 "]) {
      const bad = await cli(["captures", "prune", dir, `--keep=${keep}`])
      expect([bad.code, bad.err], JSON.stringify(keep)).toEqual([2, expect.stringContaining("--keep N")])
    }
    const r = await cli(["captures", "prune", dir, "--keep", "2", "--dry-run"])
    expect([r.code, r.out]).toEqual([0, "would delete 0 captures, keeping the newest 2 of each shot\n"])
  })
})

describe("river check-data", () => {
  function withCheck(script: string) {
    const dir = storyProject()
    writeFileSync(join(dir, "check.mjs"), script)
    const manifest = JSON.parse(readFileSync(join(dir, "river.json"), "utf8"))
    manifest.checkData = "node check.mjs"
    writeFileSync(join(dir, "river.json"), JSON.stringify(manifest))
    return dir
  }

  it("lint runs it on a fresh export and shows what it printed", async () => {
    const dir = withCheck(`import { readFileSync } from "node:fs"
const story = JSON.parse(readFileSync(process.env.RIVER_EXPORT_DIR + "/shop.json", "utf8"))
console.log("checked " + Object.keys(story.passages).length + " passages from " + (process.env.RIVER_ROOT === process.cwd()))`)
    const r = await cli(["lint", dir])
    expect(r.code).toBe(0)
    expect(r.out).toContain("check-data: node check.mjs\n  checked 6 passages from true\ncheck-data: ok\n0 errors")
    expect(existsSync(join(dir, "export"))).toBe(false)
  })

  it("a failing check is a lint error", async () => {
    const dir = withCheck(`console.error("bond differs"); process.exit(3)`)
    const r = await cli(["lint", dir])
    expect(r.code).toBe(1)
    expect(r.out).toContain("  bond differs\nerror  check-data: exited with code 3\n1 error, 1 warning in 6 passages")
    expect((await cli(["check-data", dir])).code).toBe(1)
  })
})
