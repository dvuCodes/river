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
    expect(r.out).toContain("1 error, 3 warnings in 8 passages")
  })

  it("paths numbers the routes", async () => {
    const r = await cli(["paths", example])
    expect(r.code).toBe(0)
    expect(r.out).toContain("2  Gate → Pond → Treat → Home happy   [treats >= 1]")
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
    expect(unknown.err).toContain('no shot "nope"')
  })
})
