import { exec } from "node:child_process"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { exportStory } from "../export/export"
import type { StateSchema } from "../story/types"
import { listStories, loadStory } from "./project"
import type { Project } from "./types"

export interface CheckDataResult {
  command: string
  ok: boolean
  /** What the command printed, stdout then stderr. */
  output: string
  /** Why it failed, when ok is false. */
  problem?: string
}

const TIMEOUT_MS = 60_000

/**
 * Run river.json's `checkData` command from the project root, after exporting every story to a temporary folder
 * it gets as RIVER_EXPORT_DIR, so it never checks a stale export. The command is the user's own, like an npm
 * script: the CLI runs it for `river lint` and `river check-data`; an agent's tool call never does.
 */
export async function runCheckData(project: Project, schema: StateSchema): Promise<CheckDataResult> {
  const command = project.manifest.checkData
  if (!command) throw new Error("river.json has no checkData command")
  const dir = await mkdtemp(path.join(tmpdir(), "river-export-"))
  try {
    for (const rel of await listStories(project)) {
      const { story } = await loadStory(project, rel)
      const stem = path.basename(rel).replace(/\.(twee|tw)$/i, "")
      try {
        await writeFile(path.join(dir, `${stem}.json`), JSON.stringify(exportStory(story, schema, stem), null, 2) + "\n", "utf8")
      } catch {
        return { command, ok: false, output: "", problem: `not run: ${rel} has lint errors, so there is no export to check` }
      }
    }
    return await new Promise((resolve) => {
      exec(
        command,
        { cwd: project.root, env: { ...process.env, RIVER_ROOT: project.root, RIVER_EXPORT_DIR: dir }, timeout: TIMEOUT_MS, windowsHide: true, maxBuffer: 16 * 1024 * 1024 },
        (err, stdout, stderr) => {
          const output = [stdout, stderr].filter((s) => s.trim() !== "").join("\n")
          if (!err) return resolve({ command, ok: true, output })
          resolve({ command, ok: false, output, problem: err.killed ? `stopped after ${TIMEOUT_MS / 1000} s` : `exited with code ${err.code ?? "?"}` })
        },
      )
    })
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}
