/**
 * concept_request and writing_request start a River job in its own detached process (`river job start`,
 * `river write-job start`), so the MCP call returns in seconds and the job outlives this server. That
 * process owns the job: it writes the job's heartbeat (.river/jobs/<id>/owner.json), so recoverJobs
 * elsewhere leaves it alone, and once it is gone recoverJobs fails the job. Its output goes to
 * .river/logs/<job>.log.
 */
import { spawn } from "node:child_process"
import { existsSync, openSync, closeSync } from "node:fs"
import { mkdir, readFile } from "node:fs/promises"
import { createRequire } from "node:module"
import path from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

export interface JobLaunch {
  root: string
  board: string
  markId: string
  /** The id the job gets, chosen by the caller so it can be returned at once. */
  jobId: string
  /** Who asks: the server's author. A mark another agent holds is refused. */
  by: string
  backend: "claude-code" | "api-key"
  model: string
}

/** Starts the job and resolves once its file exists. Throws, with the runner's output, when it could not start. */
export type JobLauncher = (launch: JobLaunch) => Promise<{ log: string }>

const START_WAIT_MS = 45_000

/** packages/cli/src/main.ts, found from this file, run with this Node and the tsx loader. */
export function cliEntryPath(): string {
  return fileURLToPath(new URL("../../cli/src/main.ts", import.meta.url))
}

/** The tsx loader as a file URL found from this file: the runner's cwd is the game folder, where a bare "tsx" does not resolve. */
const tsxLoader = () => pathToFileURL(createRequire(import.meta.url).resolve("tsx")).href

const jobFile = (root: string, jobId: string) => path.join(root, ".river", "jobs", `${jobId}.json`)

/** Run `river <command...> --root=... --job=<id> ...` as a detached process that survives this server. */
async function launchJob(l: JobLaunch, command: readonly string[], noun: string): Promise<{ log: string }> {
  const log = path.join(l.root, ".river", "logs", `${l.jobId}.log`)
  await mkdir(path.dirname(log), { recursive: true })
  const out = openSync(log, "a")
  // --name=value throughout: a board or mark id may start with "-", which the runner's strict parseArgs would refuse as a flag.
  const values = { root: l.root, board: l.board, mark: l.markId, job: l.jobId, by: l.by, backend: l.backend, model: l.model }
  const args = ["--import", tsxLoader(), cliEntryPath(), ...command, ...Object.entries(values).map(([name, value]) => `--${name}=${value}`)]
  const child = spawn(process.execPath, args, { cwd: l.root, detached: true, stdio: ["ignore", out, out], windowsHide: true })
  closeSync(out)
  const exited = new Promise<number | null>((resolve) => {
    child.once("exit", (code) => resolve(code))
    child.once("error", () => resolve(-1))
  })
  child.unref()
  const until = Date.now() + START_WAIT_MS
  while (Date.now() < until) {
    if (existsSync(jobFile(l.root, l.jobId))) return { log }
    const code = await Promise.race([exited, new Promise<"wait">((r) => setTimeout(() => r("wait"), 100))])
    if (code !== "wait") {
      if (existsSync(jobFile(l.root, l.jobId))) return { log }
      const text = (await readFile(log, "utf8").catch(() => "")).trim().split("\n").slice(-12).join("\n")
      throw new Error(`river: the ${noun} job did not start (exit ${code}):\n${text || "(no output)"}`)
    }
  }
  throw new Error(`river: the ${noun} job runner has not started job ${l.jobId} after ${START_WAIT_MS / 1000} s; see ${log}`)
}

/** The default launcher of concept_request: `river job start --job <id>`. */
export function launchConceptJob(l: JobLaunch): Promise<{ log: string }> {
  return launchJob(l, ["job", "start"], "concept")
}

/** The default launcher of writing_request: `river write-job start --job <id>`. */
export function launchWritingJob(l: JobLaunch): Promise<{ log: string }> {
  return launchJob(l, ["write-job", "start"], "writing")
}
