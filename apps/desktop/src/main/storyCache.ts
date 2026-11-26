import { basename } from "node:path"

/**
 * Parsed stories, kept per story file so the views that ask about one story in quick succession (load, paths, open
 * state, playtest) read and parse it once. Electron-free, so it can be tested on its own.
 *
 * An entry is the load's promise, so callers that ask while it loads share it. A failed load is not kept. Invalidating
 * drops the entry at once: a load still in flight answers its own callers but is never stored.
 */
export class StoryCache<T, W = unknown> {
  private readonly entries = new Map<string, Promise<T>>()
  private workspace: Promise<W> | undefined

  get(rel: string, load: () => Promise<T>): Promise<T> {
    const hit = this.entries.get(rel)
    if (hit) return hit
    const value = load()
    this.entries.set(rel, value)
    value.catch(() => {
      if (this.entries.get(rel) === value) this.entries.delete(rel)
    })
    return value
  }

  /** Cached multi-story workspace (or single-story marker), cleared on any story, state, or manifest invalidation. */
  getWorkspace(load: () => Promise<W>): Promise<W> {
    if (this.workspace) return this.workspace
    const value = load()
    this.workspace = value
    value.catch(() => {
      if (this.workspace === value) this.workspace = undefined
    })
    return value
  }

  /** Drop one story, or every story when `rel` is absent (the schema or the project changed). Always clears the workspace. */
  invalidate(rel?: string): void {
    this.workspace = undefined
    if (rel === undefined) this.entries.clear()
    else this.entries.delete(rel)
  }

  has(rel: string): boolean {
    return this.entries.has(rel)
  }

  hasWorkspace(): boolean {
    return this.workspace !== undefined
  }
}

/** What a batch of watcher changes means for the cache: nothing, some story files, or everything. */
export function staleStories(changes: readonly { kind: string; rel: string }[]): "all" | string[] {
  if (changes.some((c) => c.kind === "state" || c.kind === "manifest")) return "all"
  return [...new Set(changes.filter((c) => c.kind === "story").map((c) => c.rel))]
}

const stripStoryExt = (p: string) => p.replace(/\.(twee|tw)$/i, "")

/**
 * Collision-safe story IDs for a project's story files:
 * - When a file's basename (without `.twee`/`.tw`) is unique, its ID is that basename.
 * - When multiple files share a basename, their IDs are their relative path under `storiesDir` without `.twee`/`.tw`.
 */
export function storyIdsFor(files: readonly string[], storiesDir: string): Map<string, string> {
  const normFiles = files.map((f) => f.replace(/\\/g, "/"))
  const stems = normFiles.map((f) => stripStoryExt(basename(f)))
  const counts = new Map<string, number>()
  for (const s of stems) counts.set(s.toLowerCase(), (counts.get(s.toLowerCase()) ?? 0) + 1)

  const dir = storiesDir.replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/+$/, "")
  const prefix = dir && dir !== "." ? `${dir}/` : ""

  const out = new Map<string, string>()
  for (let i = 0; i < normFiles.length; i++) {
    const f = normFiles[i]!
    const stem = stems[i]!
    if ((counts.get(stem.toLowerCase()) ?? 0) > 1) {
      const under = prefix && f.startsWith(prefix) ? f.slice(prefix.length) : f.replace(/^\.\//, "")
      out.set(f, stripStoryExt(under))
    } else {
      out.set(f, stem)
    }
  }
  return out
}
