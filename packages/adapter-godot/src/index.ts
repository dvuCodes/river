import { execFile } from "node:child_process"
import { mkdir, readdir } from "node:fs/promises"
import path from "node:path"
import type { EngineAdapter, Project, ShotDef } from "@river/core"

export { conceptScriptBytesProblem, lintConceptScript, renderConcept, type RenderConceptRequest } from "./concept"
export { KIT_API, KIT_FILE, kitFileAction, kitFileText } from "./kit"

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
}

const CAPTURE_TIMEOUT_MS = 60_000
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
  }
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
    const args = ["--path", projectDir, "-s", s.screenshotScript, "--", `--scene=${shot.scene}`, `--out=${out}/frame_00.png`]
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

function run(bin: string, args: string[]): Promise<{ ok: boolean; stdout: string; stderr: string; error?: Error }> {
  return new Promise((resolve) => {
    execFile(bin, args, { timeout: CAPTURE_TIMEOUT_MS, maxBuffer: 64 * 1024 * 1024, encoding: "utf8" }, (err, stdout, stderr) => {
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
      const result = await run(bin, args)
      const files = await framesIn(outDir)
      const report = () =>
        [`command: ${bin} ${args.join(" ")}`, result.error ? `error: ${result.error.message}` : "", `stderr:\n${tail(result.stderr)}`, `stdout:\n${tail(result.stdout)}`]
          .filter(Boolean)
          .join("\n")
      if (!result.ok) throw new Error(`river: Godot capture of shot ${shot.id} failed\n${report()}`)
      if (files.length === 0) throw new Error(`river: Godot capture of shot ${shot.id} wrote no frame_NN.png into ${outDir}\n${report()}`)
      return files
    },
  }
}
