/**
 * Engine adapters the core can run without a dedicated package: a shell command named in river.json.
 *
 *   "engine": "unity",
 *   "adapter": { "unity": { "command": "$UNITY_BIN -batchmode -executeMethod River.Capture", "batchCommand": "...", "cwd": ".", "timeoutS": "120" } }
 *
 * The command gets RIVER_PROJECT_ROOT, RIVER_SHOT_ID, RIVER_SCENE, RIVER_SETUP, RIVER_COUNT, RIVER_TICKS and
 * RIVER_OUT_DIR, and must write frame_00.png, frame_01.png, ... into RIVER_OUT_DIR. A batchCommand gets
 * RIVER_PROJECT_ROOT and RIVER_BATCH_MANIFEST: a JSON file holding [{ id, scene, setup, count, ticks, outDir }].
 */
import { spawn, type ChildProcess } from "node:child_process"
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import type { EngineAdapter, Project, ShotDef } from "../project/types"

const FRAME_FILE = /^frame_(\d+)\.png$/i

/**
 * Replace "$VAR" and "${VAR}" with values from `vars` (River's own, which may be empty, e.g. RIVER_SETUP for a
 * shot without a setup script), else from `env`. Throws when a referenced environment variable is unset.
 */
function expandVars(value: string, vars: NodeJS.ProcessEnv, env: NodeJS.ProcessEnv, what: string): string {
  return value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g, (_m, braced: string | undefined, bare: string | undefined) => {
    const name = (braced ?? bare) as string
    if (vars[name] !== undefined) return vars[name]!
    const v = env[name]
    if (v === undefined || v === "") throw new Error(`river: ${what} references $${name}, but the environment variable ${name} is not set`)
    return v
  })
}

/** PNGs named frame_NN.png in outDir, in frame order. */
async function framesIn(outDir: string): Promise<string[]> {
  const names = (await readdir(outDir)).filter((n) => FRAME_FILE.test(n))
  const num = (n: string) => Number(FRAME_FILE.exec(n)?.[1] ?? 0)
  return names.sort((a, b) => num(a) - num(b)).map((n) => path.join(outDir, n))
}

const tail = (text: string, lines = 40) => text.trim().split(/\r?\n/).slice(-lines).join("\n")

const WINDOWS = process.platform === "win32"

/**
 * Stop the shell and everything it started. Killing only the shell would leave the engine running (Node's
 * `kill()` does not reach a shell's children): on Windows taskkill /T ends the tree; elsewhere the shell leads
 * its own process group (spawned detached), so the whole group gets the signal.
 */
function killTree(child: ChildProcess): void {
  if (child.pid === undefined) return
  try {
    if (WINDOWS) spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" }).on("error", () => child.kill())
    else process.kill(-child.pid, "SIGKILL")
  } catch {
    child.kill("SIGKILL")
  }
}

/** Run a shell command; reject with its output when it fails, or as soon as it runs past the timeout. */
function runShell(command: string, cwd: string, env: NodeJS.ProcessEnv, timeoutMs: number, what: string): Promise<void> {
  return new Promise((resolve, reject) => {
    // detached on Windows would open a console window; elsewhere it makes the shell a process group leader.
    const child = spawn(command, { cwd, env, shell: true, windowsHide: true, detached: !WINDOWS })
    let out = ""
    const keep = (chunk: Buffer) => {
      out += chunk.toString("utf8")
      if (out.length > 256 * 1024) out = out.slice(-128 * 1024)
    }
    child.stdout?.on("data", keep)
    child.stderr?.on("data", keep)
    let settled = false
    const settle = (err?: Error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (err) reject(err)
      else resolve()
    }
    const output = () => (out.trim() ? `\n${tail(out)}` : "")
    // Reject from the timer itself: "close" waits for every process holding the pipes, which a hung engine may never let go.
    const timer = setTimeout(() => {
      killTree(child)
      settle(new Error(`river: ${what} ran longer than ${timeoutMs / 1000} s and was stopped${output()}`))
    }, timeoutMs)
    child.on("error", (err) => settle(new Error(`river: ${what} could not start: ${err.message}`)))
    child.on("close", (code, signal) => {
      if (code === 0) return settle()
      settle(new Error(`river: ${what} failed (${code !== null ? `exit code ${code}` : `signal ${signal}`})${output()}`))
    })
  })
}

interface CommandSettings {
  key: string
  command: string
  batchCommand?: string
  cwd: string
  /** Overrides each shot's own timeout when set. */
  timeoutS?: number
}

function commandSettings(project: Project, key: string): CommandSettings {
  const raw = project.manifest.adapter?.[key] ?? {}
  if (!raw.command) {
    throw new Error(`river: adapter.${key}.command is not set in river.json (for example "command": "$ENGINE_BIN --capture"); it runs once per shot`)
  }
  let timeoutS: number | undefined
  if (raw.timeoutS !== undefined) {
    timeoutS = Number(raw.timeoutS)
    if (!Number.isFinite(timeoutS) || timeoutS <= 0) throw new Error(`river: adapter.${key}.timeoutS must be a positive number of seconds (found ${JSON.stringify(raw.timeoutS)})`)
  }
  return {
    key,
    command: raw.command,
    ...(raw.batchCommand ? { batchCommand: raw.batchCommand } : {}),
    cwd: path.resolve(project.root, raw.cwd ?? "."),
    ...(timeoutS !== undefined ? { timeoutS } : {}),
  }
}

/** The shot's timeout: the adapter's timeoutS, else the shot's, else 60 s plus half a second per frame. */
const shotTimeoutS = (s: CommandSettings, shot: ShotDef) => s.timeoutS ?? shot.timeoutS ?? 60 + 0.5 * shot.count

/**
 * An adapter that runs `adapter.<engineId>.command` from river.json (engineId defaults to the manifest's engine).
 * `$VAR` / `${VAR}` in the command expand from the environment, RIVER_* variables included. With
 * `adapter.<engineId>.batchCommand`, captureBatch runs it once for all shots; without, it captures one by one.
 */
export function createCommandAdapter(engineId?: string): EngineAdapter {
  const keyOf = (project: Project) => engineId ?? project.manifest.engine

  const capture = async (project: Project, shot: ShotDef, outDir: string): Promise<string[]> => {
    const s = commandSettings(project, keyOf(project))
    await mkdir(outDir, { recursive: true })
    const vars: NodeJS.ProcessEnv = {
      RIVER_PROJECT_ROOT: project.root,
      RIVER_SHOT_ID: shot.id,
      RIVER_SCENE: shot.scene,
      RIVER_SETUP: shot.setup ?? "",
      RIVER_COUNT: String(shot.count),
      RIVER_TICKS: String(shot.ticks ?? 3),
      RIVER_OUT_DIR: path.resolve(outDir),
    }
    const env = { ...process.env, ...vars }
    const command = expandVars(s.command, vars, process.env, `adapter.${s.key}.command`)
    await runShell(command, s.cwd, env, shotTimeoutS(s, shot) * 1000, `capture of shot ${shot.id}`)
    const files = await framesIn(outDir)
    if (files.length === 0) throw new Error(`river: adapter.${s.key}.command finished but wrote no frame_NN.png into ${outDir} for shot ${shot.id}`)
    return files
  }

  return {
    id: engineId ?? "command",
    capture,
    async captureBatch(project, items) {
      const s = commandSettings(project, keyOf(project))
      const out: Record<string, string[]> = {}
      if (!s.batchCommand) {
        for (const { shot, outDir } of items) out[shot.id] = await capture(project, shot, outDir)
        return out
      }
      const dir = await mkdtemp(path.join(tmpdir(), "river-batch-"))
      try {
        const list = items.map(({ shot, outDir }) => ({
          id: shot.id,
          scene: shot.scene,
          setup: shot.setup ?? "",
          count: shot.count,
          ticks: shot.ticks ?? 3,
          outDir: path.resolve(outDir),
        }))
        for (const { outDir } of items) await mkdir(outDir, { recursive: true })
        const manifestPath = path.join(dir, "batch.json")
        await writeFile(manifestPath, `${JSON.stringify(list, null, 2)}\n`, "utf8")
        const vars: NodeJS.ProcessEnv = { RIVER_PROJECT_ROOT: project.root, RIVER_BATCH_MANIFEST: manifestPath }
        const env = { ...process.env, ...vars }
        const command = expandVars(s.batchCommand, vars, process.env, `adapter.${s.key}.batchCommand`)
        const timeoutS = s.timeoutS ?? items.reduce((sum, { shot }) => sum + (shot.timeoutS ?? 60 + 0.5 * shot.count), 0)
        await runShell(command, s.cwd, env, timeoutS * 1000, `batch capture of ${items.length} shots`)
        for (const { shot, outDir } of items) {
          const files = await framesIn(outDir)
          if (files.length === 0) throw new Error(`river: adapter.${s.key}.batchCommand finished but wrote no frame_NN.png into ${outDir} for shot ${shot.id}`)
          out[shot.id] = files
        }
        return out
      } finally {
        await rm(dir, { recursive: true, force: true })
      }
    },
  }
}

/**
 * The adapter for the project's engine: a registered one with that id, else the command adapter when the engine
 * is "command" or river.json sets `adapter.<engine>.command`. Throws when there is neither.
 */
export function resolveAdapter(project: Project, adapters: readonly EngineAdapter[] = []): EngineAdapter {
  const engine = project.manifest.engine
  const found = adapters.find((a) => a.id === engine)
  if (found) return found
  if (engine === "command" || Boolean(project.manifest.adapter?.[engine]?.command)) return createCommandAdapter(engine)
  const ids = adapters.map((a) => JSON.stringify(a.id))
  throw new Error(
    `river: no engine adapter for engine ${JSON.stringify(engine)} (registered: ${ids.join(", ") || "none"}). ` +
      `Set adapter.${engine}.command in river.json to capture with a shell command, or register an adapter with id ${JSON.stringify(engine)}.`,
  )
}
