import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs"
import path from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { createCommandAdapter, resolveAdapter } from "../../src/frames/adapter"
import { captureShot, captureShots, listCaptures } from "../../src/frames/frames"
import type { EngineAdapter, Project, ShotDef } from "../../src/project/types"
import { project, removeDir, tempDir } from "./helpers"

let root: string
beforeEach(() => {
  root = tempDir()
})
afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllEnvs()
  removeDir(root)
})

const node = JSON.stringify(process.execPath)

/** A fake engine: writes RIVER_COUNT frames (written out of order) and env.json into RIVER_OUT_DIR. */
function singleScript(): string {
  const file = path.join(root, "engine.mjs")
  writeFileSync(
    file,
    `import { writeFileSync } from "node:fs"
import path from "node:path"
const out = process.env.RIVER_OUT_DIR
const n = Number(process.env.RIVER_COUNT)
for (let i = n - 1; i >= 0; i--) writeFileSync(path.join(out, "frame_" + String(i).padStart(2, "0") + ".png"), "png")
writeFileSync(path.join(out, "note.txt"), "not a frame")
const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => k.startsWith("RIVER_")))
writeFileSync(path.join(out, "env.json"), JSON.stringify({ env, cwd: process.cwd(), argv: process.argv.slice(2) }))
`,
  )
  return file
}

/** A fake batch engine: reads RIVER_BATCH_MANIFEST and writes each item's frames; copies the manifest beside the root. */
function batchScript(): string {
  const file = path.join(root, "batch.mjs")
  writeFileSync(
    file,
    `import { readFileSync, writeFileSync } from "node:fs"
import path from "node:path"
const manifestPath = process.env.RIVER_BATCH_MANIFEST
const items = JSON.parse(readFileSync(manifestPath, "utf8"))
for (const it of items) for (let i = 0; i < it.count; i++) writeFileSync(path.join(it.outDir, "frame_" + String(i).padStart(2, "0") + ".png"), it.id)
writeFileSync(path.join(process.env.RIVER_PROJECT_ROOT, "seen.json"), JSON.stringify({ manifestPath, items }))
`,
  )
  return file
}

const shots: ShotDef[] = [
  { id: "walk", scene: "res://walk.tscn", setup: "res://s.gd", count: 11, ticks: 2 },
  { id: "idle", scene: "res://idle.tscn", count: 1 },
]

const cmdProject = (adapter: Record<string, string>, engine = "unity"): Project => project(root, { engine, adapter: { [engine]: adapter }, shots })

describe("createCommandAdapter.capture", { timeout: 30_000 }, () => {
  it("runs the command with RIVER_* variables and returns frame_NN.png in frame order", async () => {
    const p = cmdProject({ command: `${node} ${JSON.stringify(singleScript())} ` + "${RIVER_SHOT_ID}" })
    const outDir = path.join(root, "out", "walk")
    const adapter = createCommandAdapter()
    expect(adapter.id).toBe("command")
    const files = await adapter.capture(p, shots[0]!, outDir)
    expect(files).toEqual(Array.from({ length: 11 }, (_, i) => path.join(outDir, `frame_${String(i).padStart(2, "0")}.png`)))
    const seen = JSON.parse(readFileSync(path.join(outDir, "env.json"), "utf8"))
    expect(seen.env).toMatchObject({
      RIVER_PROJECT_ROOT: root,
      RIVER_SHOT_ID: "walk",
      RIVER_SCENE: "res://walk.tscn",
      RIVER_SETUP: "res://s.gd",
      RIVER_COUNT: "11",
      RIVER_TICKS: "2",
      RIVER_OUT_DIR: path.resolve(outDir),
    })
    expect(seen.argv).toEqual(["walk"])
    expect(path.resolve(seen.cwd)).toBe(root)
  })

  it("expands $VAR from the environment, defaults setup and ticks, and honours cwd", async () => {
    vi.stubEnv("RIVER_TEST_NODE", process.execPath)
    mkdirSync(path.join(root, "game"))
    const p = cmdProject({ command: `"$RIVER_TEST_NODE" ${JSON.stringify(singleScript())}`, cwd: "game" })
    const outDir = path.join(root, "out", "idle")
    const files = await createCommandAdapter("unity").capture(p, shots[1]!, outDir)
    expect(files).toEqual([path.join(outDir, "frame_00.png")])
    const seen = JSON.parse(readFileSync(path.join(outDir, "env.json"), "utf8"))
    expect(seen.env).toMatchObject({ RIVER_SETUP: "", RIVER_TICKS: "3", RIVER_COUNT: "1" })
    expect(path.resolve(seen.cwd)).toBe(path.join(root, "game"))
  })

  it("expands River's own variables even when empty, like RIVER_SETUP for a shot without setup", async () => {
    const p = cmdProject({ command: `${node} ${JSON.stringify(singleScript())} "setup=\${RIVER_SETUP}" $RIVER_COUNT` })
    const outDir = path.join(root, "out", "idle")
    await createCommandAdapter().capture(p, shots[1]!, outDir)
    expect(JSON.parse(readFileSync(path.join(outDir, "env.json"), "utf8")).argv).toEqual(["setup=", "1"])
  })

  it("stops an engine that runs past timeoutS, and the engine it started too", async () => {
    const marker = path.join(root, "still-running.txt")
    const hang = path.join(root, "hang.mjs")
    writeFileSync(hang, `import { writeFileSync } from "node:fs"; setTimeout(() => writeFileSync(${JSON.stringify(marker)}, "alive"), 2500)`)
    const p = cmdProject({ command: `${node} ${JSON.stringify(hang)}`, timeoutS: "0.5" })
    const started = Date.now()
    await expect(createCommandAdapter().capture(p, shots[1]!, path.join(root, "out"))).rejects.toThrow("capture of shot idle ran longer than 0.5 s and was stopped")
    expect(Date.now() - started).toBeLessThan(2500)
    await new Promise((r) => setTimeout(r, 3500))
    expect(existsSync(marker)).toBe(false)
  })

  it("explains a missing command, an unset variable, a bad timeout, a failing command and no frames", async () => {
    const outDir = path.join(root, "out")
    const a = createCommandAdapter()
    await expect(a.capture(cmdProject({}), shots[1]!, outDir)).rejects.toThrow("adapter.unity.command is not set")
    await expect(a.capture(cmdProject({ command: "$RIVER_TEST_UNSET_VAR --go" }), shots[1]!, outDir)).rejects.toThrow(
      "adapter.unity.command references $RIVER_TEST_UNSET_VAR, but the environment variable RIVER_TEST_UNSET_VAR is not set",
    )
    await expect(a.capture(cmdProject({ command: "x", timeoutS: "soon" }), shots[1]!, outDir)).rejects.toThrow("adapter.unity.timeoutS must be a positive number")
    const fail = path.join(root, "fail.mjs")
    writeFileSync(fail, `console.error("engine exploded"); process.exit(3)`)
    await expect(a.capture(cmdProject({ command: `${node} ${JSON.stringify(fail)}` }), shots[1]!, outDir)).rejects.toThrow(/capture of shot idle failed \(exit code 3\)\s+engine exploded/)
    const quiet = path.join(root, "quiet.mjs")
    writeFileSync(quiet, "")
    await expect(a.capture(cmdProject({ command: `${node} ${JSON.stringify(quiet)}` }), shots[1]!, outDir)).rejects.toThrow("wrote no frame_NN.png")
  })

  it("safely quotes paths with spaces and blocks command injection in expanded variables", async () => {
    const spacedDir = path.join(root, "my out dir", "idle shot")
    const pBare = cmdProject({ command: `${node} ${JSON.stringify(singleScript())} $RIVER_OUT_DIR "$RIVER_OUT_DIR"` })
    await createCommandAdapter().capture(pBare, shots[1]!, spacedDir)
    const seen = JSON.parse(readFileSync(path.join(spacedDir, "env.json"), "utf8"))
    expect(seen.argv).toEqual([path.resolve(spacedDir), path.resolve(spacedDir)])

    // A value containing shell metacharacters (&) does not execute injected commands.
    const marker = path.join(root, "pwned.txt")
    const metacharShot: ShotDef = { id: "idle", scene: `scene & echo pwned > ${marker}`, count: 1 }
    const outMeta = path.join(root, "out", "meta")
    await createCommandAdapter().capture(cmdProject({ command: `${node} ${JSON.stringify(singleScript())} $RIVER_SCENE` }), metacharShot, outMeta)
    expect(existsSync(marker)).toBe(false)
    expect(JSON.parse(readFileSync(path.join(outMeta, "env.json"), "utf8")).argv).toEqual([metacharShot.scene])

    // A value containing a quote breakout `" & echo pwned` never executes the injected command.
    const quoteShot: ShotDef = { id: "idle", scene: `a" & echo pwned > ${marker}`, count: 1 }
    const outQuote = path.join(root, "out", "quote")
    const pQuoted = cmdProject({ command: `${node} ${JSON.stringify(singleScript())} "$RIVER_SCENE"` })
    if (process.platform === "win32") {
      await expect(createCommandAdapter().capture(pQuoted, quoteShot, outQuote)).rejects.toThrow(/cannot be safely passed/)
    } else {
      await createCommandAdapter().capture(pQuoted, quoteShot, outQuote)
      expect(JSON.parse(readFileSync(path.join(outQuote, "env.json"), "utf8")).argv).toEqual([quoteShot.scene])
    }
    expect(existsSync(marker)).toBe(false)

    // Control characters in expanded values are rejected.
    const nlShot: ShotDef = { id: "idle", scene: "scene\necho pwned", count: 1 }
    await expect(createCommandAdapter().capture(pQuoted, nlShot, path.join(root, "out", "nl"))).rejects.toThrow(/control character/)
  })
})

describe("createCommandAdapter.captureBatch", { timeout: 30_000 }, () => {
  it("runs batchCommand once with a JSON manifest, collects each shot's frames and deletes the manifest", async () => {
    const p = cmdProject({ command: "never-run", batchCommand: `${node} ${JSON.stringify(batchScript())}` })
    const items = shots.map((shot) => ({ shot, outDir: path.join(root, "out", shot.id) }))
    const result = await createCommandAdapter().captureBatch!(p, items)
    expect(result.walk).toHaveLength(11)
    expect(result.walk![10]).toBe(path.join(root, "out", "walk", "frame_10.png"))
    expect(result.idle).toEqual([path.join(root, "out", "idle", "frame_00.png")])
    const seen = JSON.parse(readFileSync(path.join(root, "seen.json"), "utf8"))
    expect(seen.items).toEqual([
      { id: "walk", scene: "res://walk.tscn", setup: "res://s.gd", count: 11, ticks: 2, outDir: path.resolve(items[0]!.outDir) },
      { id: "idle", scene: "res://idle.tscn", setup: "", count: 1, ticks: 3, outDir: path.resolve(items[1]!.outDir) },
    ])
    expect(existsSync(seen.manifestPath)).toBe(false)
  })

  it("deletes the manifest when the batch command fails", async () => {
    const fail = path.join(root, "fail.mjs")
    writeFileSync(fail, `import { writeFileSync } from "node:fs"; writeFileSync(process.env.RIVER_PROJECT_ROOT + "/m.txt", process.env.RIVER_BATCH_MANIFEST); process.exit(1)`)
    const p = cmdProject({ command: "x", batchCommand: `${node} ${JSON.stringify(fail)}` })
    const items = shots.map((shot) => ({ shot, outDir: path.join(root, "out", shot.id) }))
    await expect(createCommandAdapter().captureBatch!(p, items)).rejects.toThrow("batch capture of 2 shots failed")
    expect(existsSync(readFileSync(path.join(root, "m.txt"), "utf8"))).toBe(false)
  })

  it("without batchCommand captures one shot at a time with command", async () => {
    const p = cmdProject({ command: `${node} ${JSON.stringify(singleScript())}` })
    const items = shots.map((shot) => ({ shot, outDir: path.join(root, "out", shot.id) }))
    const result = await createCommandAdapter().captureBatch!(p, items)
    expect(Object.keys(result)).toEqual(["walk", "idle"])
    expect(JSON.parse(readFileSync(path.join(root, "out", "idle", "env.json"), "utf8")).env.RIVER_SHOT_ID).toBe("idle")
  })

  it("scales timeoutS by item count for batchCommand, unless batchTimeoutS is explicitly set", async () => {
    const hang = path.join(root, "hang-batch.mjs")
    writeFileSync(hang, `setTimeout(() => {}, 10_000)`)
    const items = shots.map((shot) => ({ shot, outDir: path.join(root, "out", shot.id) }))
    const scaled = cmdProject({ command: "x", batchCommand: `${node} ${JSON.stringify(hang)}`, timeoutS: "0.2", cwd: path.dirname(root) })
    await expect(createCommandAdapter().captureBatch!(scaled, items)).rejects.toThrow("batch capture of 2 shots ran longer than 0.4 s and was stopped")
    const explicit = cmdProject({ command: "x", batchCommand: `${node} ${JSON.stringify(hang)}`, timeoutS: "0.2", batchTimeoutS: "0.25", cwd: path.dirname(root) })
    await expect(createCommandAdapter().captureBatch!(explicit, items)).rejects.toThrow("batch capture of 2 shots ran longer than 0.25 s and was stopped")
  })
})

describe("resolveAdapter", () => {
  const fake: EngineAdapter = { id: "godot", capture: async () => [] }

  it("prefers a registered adapter with the engine's id", () => {
    expect(resolveAdapter(project(root), [fake])).toBe(fake)
    expect(resolveAdapter(project(root, { adapter: { godot: { command: "x" } } }), [fake])).toBe(fake)
  })

  it("falls back to the command adapter for engine 'command' or a configured command", () => {
    expect(resolveAdapter(project(root, { engine: "command" })).id).toBe("command")
    expect(resolveAdapter(project(root, { engine: "unity", adapter: { unity: { command: "x" } } }), [fake]).id).toBe("unity")
  })

  it("throws listing the registered engines and the command option", () => {
    expect(() => resolveAdapter(project(root, { engine: "unity" }), [fake])).toThrow(
      'river: no engine adapter for engine "unity" (registered: "godot"). Set adapter.unity.command in river.json',
    )
    expect(() => resolveAdapter(project(root, { engine: "unity" }))).toThrow("(registered: none)")
  })
})

describe("captureShots", { timeout: 30_000 }, () => {
  const recording = (batch: boolean) => {
    const calls: string[] = []
    const write = (shot: ShotDef, outDir: string) => {
      const files = Array.from({ length: shot.count }, (_, i) => path.join(outDir, `frame_${String(i).padStart(2, "0")}.png`))
      for (const f of files) writeFileSync(f, "png")
      return files
    }
    const adapter: EngineAdapter & { calls: string[] } = {
      id: "fake",
      calls,
      async capture(_p, shot, outDir) {
        calls.push(`capture:${shot.id}`)
        return write(shot, outDir)
      },
    }
    if (batch) {
      adapter.captureBatch = async (_p, items) => {
        calls.push(`batch:${items.map((i) => i.shot.id).join(",")}`)
        for (const { outDir } of items) expect(existsSync(outDir)).toBe(true)
        return Object.fromEntries(items.map(({ shot, outDir }) => [shot.id, write(shot, outDir)]))
      }
    }
    return adapter
  }

  it("uses captureBatch for several shots, writes capture.json for each and keeps the input order", async () => {
    const p = project(root, { shots })
    const adapter = recording(true)
    vi.useFakeTimers({ toFake: ["Date"] })
    vi.setSystemTime(new Date("2026-11-24T09:00:00.000Z"))
    const caps = await captureShots(p, ["idle", "walk"], adapter)
    vi.useRealTimers()
    expect(adapter.calls).toEqual(["batch:idle,walk"])
    expect(caps.map((c) => [c.shotId, c.at, c.rev, c.files.length])).toEqual([
      ["idle", "2026-11-24T09:00:00.000Z", "unknown", 1],
      ["walk", "2026-11-24T09:00:00.000Z", "unknown", 11],
    ])
    const json = JSON.parse(readFileSync(path.join(root, ".river", "captures", "walk", "2026-11-24T09-00-00.000Z", "capture.json"), "utf8"))
    expect(json.files[0]).toBe(".river/captures/walk/2026-11-24T09-00-00.000Z/frame_00.png")
    expect(await listCaptures(p, "idle")).toEqual([caps[0]])
  })

  it("checks every shot id before capturing anything", async () => {
    const adapter = recording(true)
    await expect(captureShots(project(root, { shots }), ["walk", "nope"], adapter)).rejects.toThrow('no shot "nope"')
    expect(adapter.calls).toEqual([])
    expect(existsSync(path.join(root, ".river"))).toBe(false)
  })

  it("captures one by one without captureBatch, for a single shot, and for repeated ids", async () => {
    const p = project(root, { shots })
    const plain = recording(false)
    expect((await captureShots(p, ["walk", "idle"], plain)).map((c) => c.shotId)).toEqual(["walk", "idle"])
    expect(plain.calls).toEqual(["capture:walk", "capture:idle"])
    const batch = recording(true)
    await captureShots(p, ["idle"], batch)
    await captureShots(p, ["idle", "idle"], batch)
    expect(batch.calls).toEqual(["capture:idle", "capture:idle", "capture:idle"])
    expect(await captureShots(p, [], batch)).toEqual([])
  })

  it("throws when the batch result misses a shot and cleans up orphan capture directories", async () => {
    const p = project(root, { shots })
    const adapter: EngineAdapter = { id: "fake", capture: async () => [], captureBatch: async () => ({ walk: [] }) }
    await expect(captureShots(p, ["walk", "idle"], adapter)).rejects.toThrow('batch capture returned no frames for shot "idle"')
    expect(readdirSync(path.join(root, ".river", "captures", "walk"))).toEqual([])
    expect(readdirSync(path.join(root, ".river", "captures", "idle"))).toEqual([])
  })

  it("cleans up orphan capture directories when capture or captureBatch fails or returns empty frames", async () => {
    const p = project(root, { shots })
    const failSingle: EngineAdapter = { id: "fake", capture: async () => { throw new Error("boom") } }
    await expect(captureShot(p, "idle", failSingle)).rejects.toThrow("boom")
    expect(readdirSync(path.join(root, ".river", "captures", "idle"))).toEqual([])

    const emptySingle: EngineAdapter = { id: "fake", capture: async () => [] }
    await expect(captureShot(p, "idle", emptySingle)).rejects.toThrow('returned no frames for shot "idle"')
    expect(readdirSync(path.join(root, ".river", "captures", "idle"))).toEqual([])

    const partialBatch: EngineAdapter = {
      id: "fake",
      capture: async () => [],
      captureBatch: async (_p, items) => {
        const walkFrame = path.join(items[0]!.outDir, "frame_00.png")
        writeFileSync(walkFrame, "png")
        return { walk: [walkFrame], idle: [] }
      },
    }
    await expect(captureShots(p, ["walk", "idle"], partialBatch)).rejects.toThrow('batch capture returned no frames for shot "idle"')
    expect(readdirSync(path.join(root, ".river", "captures", "walk"))).toEqual([])
    expect(readdirSync(path.join(root, ".river", "captures", "idle"))).toEqual([])
    expect(await listCaptures(p, "walk")).toEqual([])
  })

  it("works end to end with the command adapter's batchCommand", async () => {
    const p = cmdProject({ command: "never-run", batchCommand: `${node} ${JSON.stringify(batchScript())}` })
    const caps = await captureShots(p, ["walk", "idle"], resolveAdapter(p))
    expect(caps.map((c) => [c.shotId, c.files.length])).toEqual([["walk", 11], ["idle", 1]])
    expect(readFileSync(caps[1]!.files[0]!, "utf8")).toBe("idle")
  })
})
