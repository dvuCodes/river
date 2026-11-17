/** A second River process for jobs.test.ts: starts a concept job whose agent turn runs until this process is killed. */
import { writeFileSync } from "node:fs"
import path from "node:path"
import { startConceptJob } from "../src/jobs"

const [game, markId, signals] = process.argv.slice(2) as [string, string, string]
await startConceptJob(
  { workspaceRoot: game, board: "main", markId, model: "claude-sonnet-5-5", backend: "claude-code" },
  {
    runTurn: () => {
      writeFileSync(path.join(signals, "started"), "")
      setInterval(() => {}, 1000)
      return new Promise<void>(() => {})
    },
  },
)
