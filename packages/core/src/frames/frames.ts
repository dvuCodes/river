import { mkdir, readdir } from "node:fs/promises"
import path from "node:path"
import { currentRev } from "../git/checkpoint"
import type { Capture, EngineAdapter, Project } from "../project/types"
import { assertSafeId, readJson, writeJsonAtomic } from "../review/store"

const capturesDir = (project: Project, shotId: string) => {
  assertSafeId("shot", shotId)
  return path.join(project.root, ".river", "captures", shotId)
}

/** Git rev of the game repo, or "unknown" when the root is not a git repo. */
async function revOf(root: string): Promise<string> {
  try {
    return await currentRev(root)
  } catch {
    return "unknown"
  }
}

/**
 * Capture one shot with the adapter into .river/captures/<shotId>/<stamp>/ and write capture.json there.
 * .river/captures is meant to be gitignored in the game repo.
 */
export async function captureShot(project: Project, shotId: string, adapter: EngineAdapter): Promise<Capture> {
  const shot = project.manifest.shots.find((s) => s.id === shotId)
  if (!shot) throw new Error(`river: no shot ${JSON.stringify(shotId)} in the manifest`)
  // Read the rev before the adapter writes anything, so the capture itself never makes it "+dirty".
  const rev = await revOf(project.root)
  const at = new Date().toISOString()
  const outDir = path.join(capturesDir(project, shotId), at.replace(/:/g, "-"))
  await mkdir(outDir, { recursive: true })
  const files = await adapter.capture(project, shot, outDir)
  const capture: Capture = { shotId, rev, at, files }
  await writeJsonAtomic(path.join(outDir, "capture.json"), capture)
  return capture
}

/** Captures of one shot, newest first. */
export async function listCaptures(project: Project, shotId: string): Promise<Capture[]> {
  const dir = capturesDir(project, shotId)
  let entries: import("node:fs").Dirent[]
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return []
    throw err
  }
  const captures: Capture[] = []
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const capture = await readJson<Capture | undefined>(path.join(dir, entry.name, "capture.json"), undefined)
    if (capture) captures.push(capture)
  }
  return captures.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0))
}
