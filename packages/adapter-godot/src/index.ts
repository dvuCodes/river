import { execFile, type ExecFileException } from "node:child_process"
import { copyFile, mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import type { EngineAdapter, Project, ShotDef } from "@river/core"

export { conceptScriptProblem, lintConceptScript, renderConcept, type RenderConceptRequest } from "./concept"
export { KIT_API, KIT_FILE, kitFileAction, kitFileText } from "./kit"
export { linesToRead, type LineToRead } from "./reading"

/** Absolute path to the bundled Godot 4 runtime addon (`addons/river/`). */
export const GODOT_RUNTIME_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "runtime", "addons", "river")

/** Absolute path to the bundled single-process batch shot runner (`runtime/tools/batch_capture.gd`). */
export const GODOT_BATCH_SCRIPT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "runtime", "tools", "batch_capture.gd")

/** Copy River's official Godot 4 runtime addon into `<projectRoot>/addons/river/`. Returns the written file paths. */
export async function installGodotRuntime(projectRoot: string): Promise<string[]> {
  const destDir = path.join(path.resolve(projectRoot), "addons", "river")
  await mkdir(destDir, { recursive: true })
  const entries = (await readdir(GODOT_RUNTIME_DIR, { withFileTypes: true }))
    .filter((entry) => entry.isFile())
    .sort((a, b) => a.name.localeCompare(b.name))
  const written: string[] = []
  for (const entry of entries) {
    const src = path.join(GODOT_RUNTIME_DIR, entry.name)
    const dst = path.join(destDir, entry.name)
    await copyFile(src, dst)
    written.push(dst)
  }
  return written
}

/** Godot settings read from manifest.adapter.godot. */
export interface GodotSettings {
  /** Godot executable. Required. Can be "$GODOT_BIN" or "${GODOT_BIN}". */
  bin: string
  /** Godot project folder, relative to the River root. Default ".". */
  project: string
  /** Single-screenshot script. Default "res://tools/capture.gd". */
  screenshotScript: string
  /** Consecutive-frames script. Default "res://tools/capture_frames.gd". */
  framesScript: string
  /** Script that captures many shots in one Godot run. Default: River's bundled GODOT_BATCH_SCRIPT, so a project needs no extra script. */
  batchScript: string
}

const FRAME_FILE = /^frame_(\d+)\.png$/i

/** Replace "$VAR" and "${VAR}" with values from `env`. Throws when a referenced variable is unset. */
export function expandEnv(value: string, env: NodeJS.ProcessEnv = process.env, what = "value"): string {
  return value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g, (_m, braced: string | undefined, bare: string | undefined) => {
    const name = (braced ?? bare) as string
    const v = env[name]
    if (v === undefined || v === "") {
      throw new Error(`river: ${what} references $${name}, but the environment variable ${name} is not set`)
    }
    return v
  })
}

export function godotSettings(project: Project, env: NodeJS.ProcessEnv = process.env): GodotSettings {
  const raw = project.manifest.adapter?.godot ?? {}
  if (!raw.bin) {
    throw new Error('river: adapter.godot.bin is not set in river.json (for example "bin": "$GODOT_BIN")')
  }
  return {
    bin: expandEnv(raw.bin, env, "adapter.godot.bin"),
    project: expandEnv(raw.project ?? ".", env, "adapter.godot.project"),
    screenshotScript: expandEnv(raw.screenshotScript ?? "res://tools/capture.gd", env, "adapter.godot.screenshotScript"),
    framesScript: expandEnv(raw.framesScript ?? "res://tools/capture_frames.gd", env, "adapter.godot.framesScript"),
    batchScript: raw.batchScript ? expandEnv(raw.batchScript, env, "adapter.godot.batchScript") : godotPath(GODOT_BATCH_SCRIPT),
  }
}

/** How long one capture may run: the shot's timeoutS, else 60 s plus half a second per frame. */
export function captureTimeoutMs(shot: ShotDef): number {
  return (shot.timeoutS ?? 60 + 0.5 * shot.count) * 1000
}

/** Godot takes "/" in OS paths on every platform. */
const godotPath = (p: string) => p.replace(/\\/g, "/")

/** The Godot command line for one shot. Pure: reads only the project, the shot and the environment. */
export function buildCaptureCommand(project: Project, shot: ShotDef, outDir: string): { bin: string; args: string[] } {
  const s = godotSettings(project)
  const projectDir = path.resolve(project.root, s.project)
  const out = godotPath(path.resolve(outDir))
  if (!Number.isInteger(shot.count) || shot.count < 1) {
    throw new Error(`river: shot ${shot.id} has count ${shot.count}; it must be a whole number of at least 1`)
  }
  if (shot.count === 1) {
    const args = ["--path", projectDir, "--disable-vsync", "-s", s.screenshotScript, "--", `--scene=${shot.scene}`, `--out=${out}/frame_00.png`]
    if (shot.setup) args.push(`--setup=${shot.setup}`)
    return { bin: s.bin, args }
  }
  if (!shot.setup) {
    throw new Error(`river: shot ${shot.id} captures ${shot.count} frames, so it needs a setup script (${s.framesScript} requires --setup)`)
  }
  return {
    bin: s.bin,
    args: [
      "--path", projectDir, "--disable-vsync", "-s", s.framesScript, "--",
      `--scene=${shot.scene}`, `--setup=${shot.setup}`, `--out=${out}/frame`,
      `--count=${shot.count}`, `--ticks=${shot.ticks ?? 3}`,
    ],
  }
}

/** The Godot command line that captures every shot listed in the batch manifest JSON at `manifestPath`, in one run. */
export function buildBatchCaptureCommand(project: Project, manifestPath: string): { bin: string; args: string[] } {
  const s = godotSettings(project)
  const projectDir = path.resolve(project.root, s.project)
  return { bin: s.bin, args: ["--path", projectDir, "--disable-vsync", "-s", s.batchScript, "--", `--manifest=${godotPath(path.resolve(manifestPath))}`] }
}

/** One entry of the batch manifest that batch_capture.gd reads. */
export interface BatchShot {
  id: string
  scene: string
  /** "" when the shot has no setup script. */
  setup: string
  /** Absolute, with "/" separators. */
  outDir: string
  count: number
  ticks: number
}

/** The batch manifest for these shots. Throws on a count that is not a whole number of at least 1. */
export function batchManifest(items: readonly { shot: ShotDef; outDir: string }[]): BatchShot[] {
  return items.map(({ shot, outDir }) => {
    if (!Number.isInteger(shot.count) || shot.count < 1) {
      throw new Error(`river: shot ${shot.id} has count ${shot.count}; it must be a whole number of at least 1`)
    }
    return { id: shot.id, scene: shot.scene, setup: shot.setup ?? "", outDir: godotPath(path.resolve(outDir)), count: shot.count, ticks: shot.ticks ?? 3 }
  })
}

/** How long a batch may run: the sum of every shot's captureTimeoutMs, and at least 60 s. */
export function batchTimeoutMs(shots: readonly ShotDef[]): number {
  return Math.max(60_000, shots.reduce((sum, shot) => sum + captureTimeoutMs(shot), 0))
}

function run(bin: string, args: string[], timeout: number): Promise<{ ok: boolean; stdout: string; stderr: string; error?: ExecFileException }> {
  return new Promise((resolve) => {
    execFile(bin, args, { timeout, maxBuffer: 64 * 1024 * 1024, encoding: "utf8" }, (err, stdout, stderr) => {
      resolve({ ok: !err, stdout: String(stdout ?? ""), stderr: String(stderr ?? ""), ...(err ? { error: err } : {}) })
    })
  })
}

const tail = (text: string, lines = 40) => text.trim().split(/\r?\n/).slice(-lines).join("\n")

/** PNGs named frame_NN.png in outDir, in frame order. */
async function framesIn(outDir: string): Promise<string[]> {
  const names = (await readdir(outDir)).filter((n) => FRAME_FILE.test(n))
  const num = (n: string) => Number(FRAME_FILE.exec(n)?.[1] ?? 0)
  return names.sort((a, b) => num(a) - num(b)).map((n) => path.join(outDir, n))
}

export function createGodotAdapter(): EngineAdapter {
  return {
    id: "godot",
    async capture(project, shot, outDir) {
      const { bin, args } = buildCaptureCommand(project, shot, outDir)
      await mkdir(outDir, { recursive: true })
      // Godot cannot render under --headless, so this opens a window for a moment.
      const timeout = captureTimeoutMs(shot)
      const result = await run(bin, args, timeout)
      const files = await framesIn(outDir)
      const report = () =>
        [`command: ${bin} ${args.join(" ")}`, result.error ? `error: ${result.error.message}${result.error.killed ? ` (stopped after ${timeout / 1000} s; set "timeoutS" on the shot for more)` : ""}` : "", `stderr:\n${tail(result.stderr)}`, `stdout:\n${tail(result.stdout)}`]
          .filter(Boolean)
          .join("\n")
      if (!result.ok) throw new Error(`river: Godot capture of shot ${shot.id} failed\n${report()}`)
      if (files.length === 0) throw new Error(`river: Godot capture of shot ${shot.id} wrote no frame_NN.png into ${outDir}\n${report()}`)
      return files
    },
    async captureBatch(project, items) {
      if (items.length === 0) return {}
      const list = batchManifest(items)
      for (const { outDir } of items) await mkdir(outDir, { recursive: true })
      const dir = await mkdtemp(path.join(tmpdir(), "river-godot-batch-"))
      try {
        const manifestPath = path.join(dir, "batch.json")
        await writeFile(manifestPath, `${JSON.stringify(list, null, 2)}\n`, "utf8")
        const { bin, args } = buildBatchCaptureCommand(project, manifestPath)
        // One Godot window for every shot.
        const timeout = batchTimeoutMs(items.map((i) => i.shot))
        const result = await run(bin, args, timeout)
        const report = () =>
          [`command: ${bin} ${args.join(" ")}`, result.error ? `error: ${result.error.message}${result.error.killed ? ` (stopped after ${timeout / 1000} s; set "timeoutS" on the shots for more)` : ""}` : "", `stderr:\n${tail(result.stderr)}`, `stdout:\n${tail(result.stdout)}`]
            .filter(Boolean)
            .join("\n")
        const ids = items.map((i) => i.shot.id).join(", ")
        if (!result.ok) throw new Error(`river: Godot batch capture of ${items.length} shot${items.length === 1 ? "" : "s"} (${ids}) failed\n${report()}`)
        const out: Record<string, string[]> = {}
        const empty: string[] = []
        for (const { shot, outDir } of items) {
          const files = await framesIn(outDir)
          if (files.length === 0) empty.push(`${shot.id} (${outDir})`)
          out[shot.id] = files
        }
        if (empty.length > 0) throw new Error(`river: Godot batch capture wrote no frame_NN.png for shot${empty.length === 1 ? "" : "s"} ${empty.join(", ")}\n${report()}`)
        return out
      } finally {
        await rm(dir, { recursive: true, force: true })
      }
    },
  }
}
