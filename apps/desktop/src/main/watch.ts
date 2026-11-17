import { join, relative, sep } from "node:path"
import { type FSWatcher, watch } from "chokidar"
import type { Project } from "@river/core"
import type { FsChange, FsChangeKind } from "../shared/api"

/**
 * Watch the parts of a project the app shows: the stories folder, river.json,
 * .river/review and .river/plans. Changes are batched and handed to `emit`.
 * Nothing is created on disk; missing folders are simply not watched until they exist.
 */
export function watchProject(project: Project, emit: (changes: FsChange[]) => void): () => Promise<void> {
  const root = project.root
  const targets = [
    join(root, project.manifest.stories),
    join(root, "river.json"),
    join(root, ".river", "review"),
    join(root, ".river", "plans"),
  ]
  const stateRel = project.manifest.state.split(/[\\/]/).join("/")

  const classify = (abs: string): FsChangeKind | undefined => {
    const rel = relative(root, abs).split(sep).join("/")
    if (rel === "river.json") return "manifest"
    if (rel.startsWith(".river/review/")) return "review"
    if (rel.startsWith(".river/plans/")) return "plans"
    if (rel === stateRel) return "state"
    if (/\.(twee|tw)$/i.test(rel)) return "story"
    return undefined
  }

  let pending: FsChange[] = []
  let timer: NodeJS.Timeout | undefined
  const watcher: FSWatcher = watch(targets, { ignoreInitial: true, awaitWriteFinish: { stabilityThreshold: 120, pollInterval: 40 } })
  watcher.on("all", (_event, path) => {
    const kind = classify(path)
    if (!kind) return
    const rel = relative(root, path).split(sep).join("/")
    if (!pending.some((c) => c.rel === rel)) pending.push({ kind, rel })
    clearTimeout(timer)
    timer = setTimeout(() => {
      const batch = pending
      pending = []
      emit(batch)
    }, 150)
  })
  watcher.on("error", (err) => console.warn("river: watcher error", err))
  return async () => {
    clearTimeout(timer)
    await watcher.close()
  }
}
