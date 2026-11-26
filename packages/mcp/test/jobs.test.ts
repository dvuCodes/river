import { existsSync, rmSync } from "node:fs"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { launchConceptJob, launchWritingJob } from "../src/jobs"
import { tempProject } from "./helpers"

let root: string | undefined
afterEach(() => {
  if (root) rmSync(root, { recursive: true, force: true, maxRetries: 3 })
})

describe("launchConceptJob", () => {
  it("starts the runner from the game folder whatever loader this process has, and passes values that start with '-'", { timeout: 60_000 }, async () => {
    // A temp copy outside River's folder, where a bare "tsx" does not resolve. The runner's own refusal shows it started and read the values.
    root = tempProject()
    const launch = launchConceptJob({ root, board: "-x", markId: "-m", jobId: "j_launch01", by: "claude-code", backend: "claude-code", model: "claude-sonnet-5-5" })
    await expect(launch).rejects.toThrow(/did not start \(exit 1\):\nriver job: river: no mark -m on board -x/)
  })
})

describe("launchWritingJob", () => {
  it("runs the writing runner the same way and reports a job that did not start, with its log", { timeout: 60_000 }, async () => {
    root = tempProject()
    const launch = launchWritingJob({ root, board: "-x", markId: "-m", jobId: "j_launch02", by: "claude-code", backend: "claude-code", model: "claude-sonnet-5-5" })
    // Whatever the runner says (no such mark, or a CLI without write-job yet), no job file means the launch failed.
    await expect(launch).rejects.toThrow(/river: the writing job did not start \(exit \d+\):\n\s*\S/)
    expect(existsSync(join(root, ".river", "logs", "j_launch02.log"))).toBe(true)
    expect(existsSync(join(root, ".river", "jobs", "j_launch02.json"))).toBe(false)
  })
})
