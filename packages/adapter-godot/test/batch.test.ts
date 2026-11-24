import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import type { Project, RiverManifest, ShotDef } from "@river/core"
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest"

/** What the fake Godot does with one run: exit code, and which shot ids it writes frames for. */
type FakeRun = { code: number; frames: Record<string, number>; stderr?: string }

const calls: { bin: string; args: string[]; timeout: number; manifest: unknown; manifestPath: string }[] = []
let next: FakeRun = { code: 0, frames: {} }

vi.mock("node:child_process", () => ({
  execFile: (bin: string, args: string[], opts: { timeout: number }, cb: (err: Error | null, stdout: string, stderr: string) => void) => {
    const arg = args.find((a) => a.startsWith("--manifest="))!
    const manifestPath = arg.slice("--manifest=".length)
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as { id: string; outDir: string }[]
    calls.push({ bin, args, timeout: opts.timeout, manifest, manifestPath })
    for (const shot of manifest) {
      for (let i = 0; i < (next.frames[shot.id] ?? 0); i++) {
        writeFileSync(path.join(shot.outDir, `frame_${String(i).padStart(2, "0")}.png`), "png")
      }
    }
    setImmediate(() => {
      if (next.code === 0) cb(null, `batch_capture: ok ${manifest.length} shots\n`, "")
      else cb(Object.assign(new Error(`Command failed: exit ${next.code}`), { code: next.code }), "", next.stderr ?? "ERROR: boom")
    })
  },
}))

const { GODOT_BATCH_SCRIPT, batchTimeoutMs, buildBatchCaptureCommand, createGodotAdapter, godotSettings } = await import("../src/index")

const scratch = mkdtempSync(path.join(tmpdir(), "river-godot-batch-test-"))
afterAll(() => rmSync(scratch, { recursive: true, force: true, maxRetries: 5 }))

const slash = (p: string) => p.replace(/\\/g, "/")

function project(godot: Record<string, string> = {}): Project {
  const manifest = { name: "t", engine: "godot", stories: "stories", shots: [], adapter: { godot: { bin: "/opt/godot", project: "game", ...godot } } } as unknown as RiverManifest
  return { root: scratch, manifest }
}

const shot = (id: string, extra: Partial<ShotDef> = {}): ShotDef => ({ id, scene: `res://scenes/${id}.tscn`, count: 1, ...extra })

let n = 0
const outDirFor = (id: string) => path.join(scratch, `run-${n}`, id)

beforeEach(() => {
  calls.length = 0
  n++
  next = { code: 0, frames: {} }
})

describe("buildBatchCaptureCommand", () => {
  it("defaults to the bundled batch script, so a project needs no tools/ script", () => {
    expect(existsSync(GODOT_BATCH_SCRIPT)).toBe(true)
    expect(godotSettings(project()).batchScript).toBe(slash(GODOT_BATCH_SCRIPT))
    const { bin, args } = buildBatchCaptureCommand(project(), path.join(scratch, "m.json"))
    expect(bin).toBe("/opt/godot")
    expect(args).toEqual([
      "--path", path.resolve(scratch, "game"), "--disable-vsync", "-s", slash(GODOT_BATCH_SCRIPT), "--",
      `--manifest=${slash(path.join(scratch, "m.json"))}`,
    ])
  })

  it("uses adapter.godot.batchScript, with $VAR expansion", () => {
    process.env.RIVER_TEST_TOOLS = "res://tools"
    try {
      const { args } = buildBatchCaptureCommand(project({ batchScript: "$RIVER_TEST_TOOLS/batch.gd" }), "m.json")
      expect(args[args.indexOf("-s") + 1]).toBe("res://tools/batch.gd")
    } finally {
      delete process.env.RIVER_TEST_TOOLS
    }
  })

  it("batch timeout is the sum of the shots' timeouts, and at least 60 s", () => {
    expect(batchTimeoutMs([shot("a", { timeoutS: 5 })])).toBe(60_000)
    expect(batchTimeoutMs([shot("a"), shot("b", { count: 8 }), shot("c", { timeoutS: 10 })])).toBe(60_500 + 64_000 + 10_000)
  })
})

describe("captureBatch", () => {
  it("runs Godot once with a manifest of every shot, returns frames per shot and removes the manifest", async () => {
    next = { code: 0, frames: { a: 1, b: 3 } }
    const items = [
      { shot: shot("a"), outDir: outDirFor("a") },
      { shot: shot("b", { setup: "res://tools/shots/b.gd", count: 3, ticks: 2 }), outDir: outDirFor("b") },
      { shot: shot("c", { count: 2, setup: "res://tools/shots/c.gd" }), outDir: outDirFor("c") },
    ]
    next.frames.c = 2
    const out = await createGodotAdapter().captureBatch!(project(), items)

    expect(calls).toHaveLength(1)
    const call = calls[0]!
    expect(call.bin).toBe("/opt/godot")
    expect(call.args.slice(0, 6)).toEqual(["--path", path.resolve(scratch, "game"), "--disable-vsync", "-s", slash(GODOT_BATCH_SCRIPT), "--"])
    expect(call.timeout).toBe(60_500 + 61_500 + 61_000)
    expect(path.dirname(call.manifestPath).startsWith(slash(tmpdir()))).toBe(true)
    expect(call.manifest).toEqual([
      { id: "a", scene: "res://scenes/a.tscn", setup: "", outDir: slash(path.resolve(outDirFor("a"))), count: 1, ticks: 3 },
      { id: "b", scene: "res://scenes/b.tscn", setup: "res://tools/shots/b.gd", outDir: slash(path.resolve(outDirFor("b"))), count: 3, ticks: 2 },
      { id: "c", scene: "res://scenes/c.tscn", setup: "res://tools/shots/c.gd", outDir: slash(path.resolve(outDirFor("c"))), count: 2, ticks: 3 },
    ])
    expect(Object.keys(out)).toEqual(["a", "b", "c"])
    expect(out.a!.map((f) => path.basename(f))).toEqual(["frame_00.png"])
    expect(out.b!.map((f) => path.basename(f))).toEqual(["frame_00.png", "frame_01.png", "frame_02.png"])
    expect(existsSync(call.manifestPath)).toBe(false)
    expect(existsSync(path.dirname(call.manifestPath))).toBe(false)
  })

  it("throws with Godot's output when Godot fails, and still removes the manifest", async () => {
    next = { code: 1, frames: { a: 1 }, stderr: "ERROR: batch_capture: shot b cannot load scene res://scenes/b.tscn" }
    const items = [{ shot: shot("a"), outDir: outDirFor("a") }, { shot: shot("b"), outDir: outDirFor("b") }]
    const err = await createGodotAdapter().captureBatch!(project(), items).catch((e: Error) => e)
    expect(err).toBeInstanceOf(Error)
    expect((err as Error).message).toContain("Godot batch capture of 2 shots (a, b) failed")
    expect((err as Error).message).toContain("cannot load scene res://scenes/b.tscn")
    expect(existsSync(calls[0]!.manifestPath)).toBe(false)
  })

  it("throws naming every shot that wrote no frames, and still removes the manifest", async () => {
    next = { code: 0, frames: { a: 1 } }
    const items = [{ shot: shot("a"), outDir: outDirFor("a") }, { shot: shot("b"), outDir: outDirFor("b") }, { shot: shot("c"), outDir: outDirFor("c") }]
    const err = await createGodotAdapter().captureBatch!(project(), items).catch((e: Error) => e)
    expect((err as Error).message).toMatch(/wrote no frame_NN\.png for shots b \(.*\), c \(/)
    expect(existsSync(calls[0]!.manifestPath)).toBe(false)
  })

  it("does nothing for no shots, and rejects a bad count before starting Godot", async () => {
    expect(await createGodotAdapter().captureBatch!(project(), [])).toEqual({})
    const err = await createGodotAdapter().captureBatch!(project(), [{ shot: shot("a", { count: 0 }), outDir: outDirFor("a") }]).catch((e: Error) => e)
    expect((err as Error).message).toContain("shot a has count 0")
    expect(calls).toHaveLength(0)
  })

  it("creates every outDir before Godot runs", async () => {
    next = { code: 0, frames: { deep: 1 } }
    const dir = path.join(outDirFor("x"), "nested", "deep")
    mkdirSync(path.dirname(path.dirname(dir)), { recursive: true })
    await createGodotAdapter().captureBatch!(project(), [{ shot: shot("deep"), outDir: dir }])
    expect(existsSync(path.join(dir, "frame_00.png"))).toBe(true)
  })
})
