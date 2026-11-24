/**
 * Parsed stories, kept per story file so the views that ask about one story in quick succession (load, paths, open
 * state, playtest) read and parse it once. Electron-free, so it can be tested on its own.
 *
 * An entry is the load's promise, so callers that ask while it loads share it. A failed load is not kept. Invalidating
 * drops the entry at once: a load still in flight answers its own callers but is never stored.
 */
export class StoryCache<T> {
  private readonly entries = new Map<string, Promise<T>>()

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

  /** Drop one story, or every story when `rel` is absent (the schema or the project changed). */
  invalidate(rel?: string): void {
    if (rel === undefined) this.entries.clear()
    else this.entries.delete(rel)
  }

  has(rel: string): boolean {
    return this.entries.has(rel)
  }
}

/** What a batch of watcher changes means for the cache: nothing, some story files, or everything. */
export function staleStories(changes: readonly { kind: string; rel: string }[]): "all" | string[] {
  if (changes.some((c) => c.kind === "state" || c.kind === "manifest")) return "all"
  return [...new Set(changes.filter((c) => c.kind === "story").map((c) => c.rel))]
}
