import { createHash } from "node:crypto"
import { readFile } from "node:fs/promises"
import { join, relative, resolve, sep } from "node:path"
import { type FSWatcher, watch } from "chokidar"
import type { Project } from "@river/core"
import type { FsChange, FsChangeKind } from "../shared/api"

/** How long a write by River itself is remembered; a change event for it in this window is dropped. */
const OWN_WRITE_MS = 2000
const ownWrites = new Map<string, { hash: string; until: number }>()
const caseInsensitive = process.platform === "win32" || process.platform === "darwin"
const keyOf = (abs: string) => (caseInsensitive ? resolve(abs).toLowerCase() : resolve(abs))
const hashOf = (data: string | Buffer) => createHash("sha256").update(data).digest("hex")
const logEvents = Boolean(process.env["RIVER_SMOKE_DIR"])

/**
 * Remember that River is about to write `text` to `abs`, so the watcher does not report it back as an outside
 * change (which would reload the story and reset the view). Kept for 2 s, since one write can raise several events.
 */
export function noteOwnWrite(abs: string, text: string): void {
  ownWrites.set(keyOf(abs), { hash: hashOf(text), until: Date.now() + OWN_WRITE_MS })
}

/** True when the file now holds exactly what River wrote there in the last 2 s. */
async function isOwnWrite(abs: string): Promise<boolean> {
  const key = keyOf(abs)
  const own = ownWrites.get(key)
  if (!own) return false
  if (Date.now() > own.until) {
    ownWrites.delete(key)
    return false
  }
  try {
    return hashOf(await readFile(abs)) === own.hash
  } catch {
    return false
  }
}

export interface ProjectWatch {
  /** Start watching one more folder (e.g. a board folder River just created). */
  add(abs: string): void
  stop(): Promise<void>
}

/**
 * Watch the parts of a project the app shows: the stories folder, river.json,
 * .river/review, .river/plans and .river/jobs, plus folders added with `add`. Changes are batched and handed to `emit`.
 * Nothing is created on disk; missing folders are simply not watched until they exist.
 */
export function watchProject(project: Project, emit: (changes: FsChange[]) => void): ProjectWatch {
  const root = project.root
  const targets = [
    join(root, project.manifest.stories),
    join(root, "river.json"),
    join(root, ".river", "review"),
    join(root, ".river", "plans"),
    join(root, ".river", "jobs"),
  ]
  const stateRel = project.manifest.state.split(/[\\/]/).join("/")

  const classify = (abs: string): FsChangeKind | undefined => {
    const rel = relative(root, abs).split(sep).join("/")
    if (rel === "river.json") return "manifest"
    if (rel.startsWith(".river/review/")) return "review"
    if (rel.startsWith(".river/plans/")) return "plans"
    // One file per card, mark or edge; temp files of atomic writes start with a dot.
    if (/^\.river\/boards\/[a-z0-9_-]{1,64}\/(cards|marks|edges)\/[^./][^/]*\.json$/.test(rel)) return "board"
    if (/^\.river\/jobs\/[^./][^/]*\.json$/.test(rel)) return "job"
    if (rel === stateRel) return "state"
    if (/\.(twee|tw)$/i.test(rel)) return "story"
    return undefined
  }

  let pending: FsChange[] = []
  let timer: NodeJS.Timeout | undefined
  const queue = (change: FsChange) => {
    const { rel } = change
    if (!pending.some((c) => c.rel === rel)) pending.push(change)
    clearTimeout(timer)
    timer = setTimeout(() => {
      const batch = pending
      pending = []
      emit(batch)
    }, 150)
  }
  const watcher: FSWatcher = watch(targets, { ignoreInitial: true, awaitWriteFinish: { stabilityThreshold: 120, pollInterval: 40 } })
  watcher.on("all", (_event, path) => {
    const kind = classify(path)
    if (!kind) return
    void (async () => {
      const rel = relative(root, path).split(sep).join("/")
      if (await isOwnWrite(path)) {
        if (logEvents) console.log(`river watch: dropped own write ${rel}`)
        return
      }
      if (logEvents) console.log(`river watch: change ${kind} ${rel}`)
      queue({ kind, rel })
    })()
  })
  watcher.on("error", (err) => console.warn("river: watcher error", err))
  const added = new Set<string>()
  return {
    add(abs) {
      const key = keyOf(abs)
      if (added.has(key)) return
      added.add(key)
      watcher.add(abs)
    },
    async stop() {
      clearTimeout(timer)
      await watcher.close()
    },
  }
}
