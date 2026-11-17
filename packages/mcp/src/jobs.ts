/**
 * concept_request starts River's concept job in its own detached process, `river job start`, so the
 * MCP call returns in seconds and the job outlives this server. That process owns the job: it writes
 * the job's heartbeat (.river/jobs/<id>/owner.json), so recoverJobs elsewhere leaves it alone, and once
 * it is gone recoverJobs fails the job. Its output goes to .river/logs/<job>.log.
 */
import { spawn } from "node:child_process"
import { existsSync, openSync, closeSync } from "node:fs"
import { mkdir, readFile } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"

export interface JobLaunch {
  root: string
  board: string
  markId: string
  /** The id the job gets, chosen by the caller so it can be returned at once. */
  jobId: string
  /** Who asks: the server's author. A mark another agent holds is refused. */
  by: string
  backend: "claude-code" | "api-key"
  model: "claude-sonnet-5-5" | "claude-opus-5-5"
}

/** Starts the job and resolves once its file exists. Throws, with the runner's output, when it could not start. */
export type JobLauncher = (launch: JobLaunch) => Promise<{ log: string }>

const START_WAIT_MS = 45_000

/** packages/cli/src/main.ts, found from this file, run with this Node and the loader this server runs with (tsx). */
export function cliEntryPath(): string {
  return fileURLToPath(new URL("../../cli/src/main.ts", import.meta.url))
}

const jobFile = (root: string, jobId: string) => path.join(root, ".river", "jobs", `${jobId}.json`)

/** The default launcher: `river job start --job <id>` as a detached process that survives this server. */
export async function launchConceptJob(l: JobLaunch): Promise<{ log: string }> {
  const log = path.join(l.root, ".river", "logs", `${l.jobId}.log`)
  await mkdir(path.dirname(log), { recursive: true })
  const out = openSync(log, "a")
  const args = [...process.execArgv, cliEntryPath(), "job", "start", "--root", l.root, "--board", l.board, "--mark", l.markId, "--job", l.jobId, "--by", l.by, "--backend", l.backend, "--model", l.model]
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
      throw new Error(`river: the concept job did not start (exit ${code}):\n${text || "(no output)"}`)
    }
  }
  throw new Error(`river: the concept job runner has not started job ${l.jobId} after ${START_WAIT_MS / 1000} s; see ${log}`)
}
