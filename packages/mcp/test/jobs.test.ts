import { rmSync } from "node:fs"
import { afterEach, describe, expect, it } from "vitest"
import { launchConceptJob } from "../src/jobs"
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
