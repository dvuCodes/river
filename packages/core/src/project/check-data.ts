import { exec } from "node:child_process"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { exportStory } from "../export/export"
import { loadStoryWorkspace } from "../story/workspace"
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

const stripStoryExt = (p: string) => p.replace(/\.(twee|tw)$/i, "")

function storyIdsFor(files: readonly string[], storiesDir: string): Map<string, string> {
  const norm = files.map((f) => f.replace(/\\/g, "/"))
  const stems = norm.map((f) => stripStoryExt(path.basename(f)))
  const counts = new Map<string, number>()
  for (const s of stems) counts.set(s.toLowerCase(), (counts.get(s.toLowerCase()) ?? 0) + 1)
  const dir = storiesDir.replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/+$/, "")
  const prefix = dir && dir !== "." ? `${dir}/` : ""
  const out = new Map<string, string>()
  for (let i = 0; i < norm.length; i++) {
    const f = norm[i]!
    const stem = stems[i]!
    if ((counts.get(stem.toLowerCase()) ?? 0) > 1) {
      const under = prefix && f.startsWith(prefix) ? f.slice(prefix.length) : f.replace(/^\.\//, "")
      out.set(files[i]!, stripStoryExt(under))
    } else {
      out.set(files[i]!, stem)
    }
  }
  return out
}

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
    const files = await listStories(project)
    const ids = storyIdsFor(files, project.manifest.stories)
    const loaded = await Promise.all(
      files.map(async (rel) => {
        const { story } = await loadStory(project, rel)
        return { file: rel, id: ids.get(rel) ?? stripStoryExt(path.basename(rel)), story }
      }),
    )
    const workspace = loaded.length >= 2 ? loadStoryWorkspace(loaded) : undefined
    for (const { file: rel, id, story } of loaded) {
      try {
        const exported = exportStory(story, schema, id, workspace ? { workspace } : undefined)
        const dest = path.join(dir, ...id.split("/")) + ".json"
        await mkdir(path.dirname(dest), { recursive: true })
        await writeFile(dest, JSON.stringify(exported, null, 2) + "\n", "utf8")
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
