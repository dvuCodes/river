import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import path from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { buildCaptureCommand, captureTimeoutMs } from "../../../adapter-godot/src/index"
import { formatBoard, loadBoard, saveCard } from "../../src/boards/boards"
import { captureShot, frameCardFiles, listCaptures, pruneCaptures } from "../../src/frames/frames"
import type { EngineAdapter, ShotDef } from "../../src/project/types"
import { git, initRepo, project, removeDir, tempDir } from "./helpers"

let root: string
beforeEach(() => {
  root = tempDir()
})
afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllEnvs()
  removeDir(root)
})

const fakeAdapter = (): EngineAdapter & { calls: string[] } => {
  const calls: string[] = []
  return {
    id: "fake",
    calls,
    async capture(_p, shot, outDir) {
      calls.push(outDir)
      const files = Array.from({ length: shot.count }, (_, i) => path.join(outDir, `frame_${String(i).padStart(2, "0")}.png`))
      for (const f of files) writeFileSync(f, "png")
      return files
    },
  }
}

describe("captureShot / listCaptures", { timeout: 30_000 }, () => {
  it("captures into .river/captures/<shot>/<stamp>, writes capture.json, and lists newest first", async () => {
    initRepo(root)
    writeFileSync(path.join(root, ".gitignore"), ".river/\n")
    git(root, "add", "-A")
    git(root, "commit", "-q", "-m", "init")
    const sha = git(root, "rev-parse", "--short", "HEAD").trim()

    const p = project(root, {
      shots: [
        { id: "walk", scene: "res://walk.tscn", count: 1 },
        { id: "run", scene: "res://walk.tscn", setup: "res://s.gd", count: 3 },
      ],
    })
    const adapter = fakeAdapter()
    expect(await listCaptures(p, "walk")).toEqual([])

    vi.useFakeTimers({ toFake: ["Date"] })
    vi.setSystemTime(new Date("2026-11-17T10:00:00.000Z"))
    const first = await captureShot(p, "walk", adapter)
    vi.setSystemTime(new Date("2026-11-17T10:05:00.000Z"))
    const second = await captureShot(p, "walk", adapter)
    vi.useRealTimers()

    const outDir = path.join(root, ".river", "captures", "walk", "2026-11-17T10-00-00.000Z")
    expect(adapter.calls[0]).toBe(outDir)
    expect(first).toEqual({ shotId: "walk", rev: sha, at: "2026-11-17T10:00:00.000Z", files: [path.join(outDir, "frame_00.png")] })
    const json = readFileSync(path.join(outDir, "capture.json"), "utf8")
    expect(json.endsWith("\n")).toBe(true)
    expect(JSON.parse(json)).toEqual({ ...first, files: [".river/captures/walk/2026-11-17T10-00-00.000Z/frame_00.png"] })

    expect(await listCaptures(p, "walk")).toEqual([second, first])

    const run = await captureShot(p, "run", adapter)
    expect(run.files).toHaveLength(3)
    await expect(captureShot(p, "missing", adapter)).rejects.toThrow(/no shot/)
  })

  it("reads older capture.json files that hold absolute paths, also after the repo moved", async () => {
    const p = project(root)
    const folder = path.join(root, ".river", "captures", "walk", "old")
    mkdirSync(folder, { recursive: true })
    writeFileSync(path.join(folder, "frame_00.png"), "png")
    const files = [path.join(folder, "frame_00.png"), path.join(root, "..", "moved-away", "frame_01.png")]
    writeFileSync(path.join(folder, "capture.json"), JSON.stringify({ shotId: "walk", rev: "abc", at: "2026-01-01T00:00:00.000Z", files }))
    expect((await listCaptures(p, "walk"))[0]!.files).toEqual([files[0], path.join(folder, "frame_01.png")])
  })

  it("prune keeps the newest N of each shot and any capture a frame card pins", async () => {
    const p = project(root, { shots: [{ id: "walk", scene: "res://walk.tscn", count: 1 }] })
    vi.useFakeTimers({ toFake: ["Date"] })
    const ats: string[] = []
    for (let i = 0; i < 4; i++) {
      vi.setSystemTime(new Date(Date.UTC(2026, 0, 1, 10, i)))
      ats.push((await captureShot(p, "walk", fakeAdapter())).at)
    }
    vi.useRealTimers()
    await saveCard(root, "main", { kind: "frame", ref: "walk", capture: ats[0], x: 0, y: 0, w: 200, madeBy: "you" })
    const dry = await pruneCaptures(p, 1, { dryRun: true })
    expect([dry.removed.map((r) => r.at), dry.pinned.map((r) => r.at)]).toEqual([[ats[2], ats[1]], [ats[0]]])
    expect((await listCaptures(p, "walk")).length).toBe(4)
    await pruneCaptures(p, 1)
    expect((await listCaptures(p, "walk")).map((c) => c.at)).toEqual([ats[3], ats[0]])
  })

  it("uses rev 'unknown' outside a git repo", async () => {
    const p = project(root)
    const c = await captureShot(p, "walk", fakeAdapter())
    expect(c.rev).toBe("unknown")
  })
})

describe("frame cards on a board", () => {
  it("print their frame number and the PNG they show", async () => {
    const p = project(root, { shots: [{ id: "run", scene: "res://walk.tscn", setup: "res://s.gd", count: 3 }] })
    const cap = await captureShot(p, "run", fakeAdapter())
    const card = await saveCard(root, "main", { kind: "frame", ref: "run", rev: cap.rev, capture: cap.at, frame: 2, x: 0, y: 0, w: 200, madeBy: "you" })
    const gone = await saveCard(root, "main", { kind: "frame", ref: "run", capture: "1999-01-01T00:00:00.000Z", x: 300, y: 0, w: 200, madeBy: "you" })
    const board = await loadBoard(root, "main")
    const files = await frameCardFiles(root, board)
    const stamp = cap.at.replace(/:/g, "-")
    expect(files).toEqual({ [card.id]: `.river/captures/run/${stamp}/frame_02.png` })
    expect(existsSync(path.join(root, files[card.id]!))).toBe(true)
    const text = formatBoard(board, files)
    expect(text).toContain(`shot run rev ${cap.rev} frame 3  file: .river/captures/run/${stamp}/frame_02.png  by you`)
    expect(text).toContain(`${gone.id}  frame at 300,0`)
    expect(text).toMatch(new RegExp(`${gone.id} .*shot run frame 1  by you`))
  })
})

describe("buildCaptureCommand (godot)", () => {
  it("gives a capture 60 s plus half a second a frame, unless the shot sets timeoutS", () => {
    expect(captureTimeoutMs({ id: "a", scene: "s", count: 1 })).toBe(60_500)
    expect(captureTimeoutMs({ id: "a", scene: "s", count: 90 })).toBe(105_000)
    expect(captureTimeoutMs({ id: "a", scene: "s", count: 90, timeoutS: 30 })).toBe(30_000)
  })

  const outDir = path.join("C:", "tmp", "out")
  const outFwd = path.resolve(outDir).replace(/\\/g, "/")

  it("builds a single screenshot command and expands $VAR / ${VAR}", () => {
    vi.stubEnv("GODOT_BIN", "/opt/godot")
    const p = project(root, { adapter: { godot: { bin: "$GODOT_BIN", project: "game" } } })
    const shot: ShotDef = { id: "walk", scene: "res://walk.tscn", setup: "res://tools/shots/walk.gd", count: 1 }
    expect(buildCaptureCommand(p, shot, outDir)).toEqual({
      bin: "/opt/godot",
      args: [
        "--path", path.resolve(root, "game"), "--disable-vsync", "-s", "res://tools/capture.gd", "--",
        "--scene=res://walk.tscn", `--out=${outFwd}/frame_00.png`, "--setup=res://tools/shots/walk.gd",
      ],
    })
    const p2 = project(root, { adapter: { godot: { bin: "${GODOT_BIN}/bin" } } })
    const noSetup = buildCaptureCommand(p2, { ...shot, setup: undefined }, outDir)
    expect(noSetup.bin).toBe("/opt/godot/bin")
    expect(noSetup.args).toEqual(["--path", path.resolve(root), "--disable-vsync", "-s", "res://tools/capture.gd", "--", "--scene=res://walk.tscn", `--out=${outFwd}/frame_00.png`])
  })

  it("builds a frames command for count 3", () => {
    vi.stubEnv("GODOT_BIN", "/opt/godot")
    const p = project(root, { adapter: { godot: { bin: "$GODOT_BIN", framesScript: "res://f.gd" } } })
    const shot: ShotDef = { id: "run", scene: "res://walk.tscn", setup: "res://s.gd", count: 3 }
    expect(buildCaptureCommand(p, shot, outDir)).toEqual({
      bin: "/opt/godot",
      args: [
        "--path", path.resolve(root), "--disable-vsync", "-s", "res://f.gd", "--",
        "--scene=res://walk.tscn", "--setup=res://s.gd", `--out=${outFwd}/frame`, "--count=3", "--ticks=3",
      ],
    })
    expect(buildCaptureCommand(p, { ...shot, ticks: 5 }, outDir).args.at(-1)).toBe("--ticks=5")
    expect(() => buildCaptureCommand(p, { ...shot, setup: undefined }, outDir)).toThrow(/needs a setup script/)
  })

  it("errors clearly when bin is missing or its variable is unset", () => {
    vi.stubEnv("RIVER_TEST_UNSET_BIN", "")
    const shot: ShotDef = { id: "walk", scene: "res://walk.tscn", count: 1 }
    expect(() => buildCaptureCommand(project(root, { adapter: {} }), shot, outDir)).toThrow(/adapter\.godot\.bin is not set/)
    expect(() => buildCaptureCommand(project(root, { adapter: { godot: { bin: "$RIVER_TEST_UNSET_BIN" } } }), shot, outDir)).toThrow(
      /RIVER_TEST_UNSET_BIN is not set/,
    )
  })
})
