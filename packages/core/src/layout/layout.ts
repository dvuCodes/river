import { mkdir, readFile, writeFile } from "node:fs/promises"
import { dirname } from "node:path"

/** Card positions for one story, saved beside it as <story>.layout.json so story diffs show only words and rules. */
export interface StoryLayout {
  version: 1
  /** passage id -> [x, y] top-left in map units. */
  positions: Record<string, [number, number]>
}

/** "stories/a.twee" -> "stories/a.layout.json". */
export function layoutPathFor(storyFile: string): string {
  const m = /\.(twee|tw)$/i.exec(storyFile)
  return (m ? storyFile.slice(0, m.index) : storyFile) + ".layout.json"
}

/** Read the layout. Missing file -> empty positions. */
export async function loadLayout(storyFile: string): Promise<StoryLayout> {
  let text: string
  try {
    text = await readFile(layoutPathFor(storyFile), "utf8")
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return { version: 1, positions: {} }
    throw e
  }
  const data = JSON.parse(text) as { positions?: Record<string, unknown> }
  const positions: Record<string, [number, number]> = {}
  for (const [id, v] of Object.entries(data.positions ?? {})) {
    if (Array.isArray(v) && typeof v[0] === "number" && typeof v[1] === "number") positions[id] = [v[0], v[1]]
  }
  return { version: 1, positions }
}

/** Write with sorted keys and 2-space indent, so diffs stay small. */
export async function saveLayout(storyFile: string, layout: StoryLayout): Promise<void> {
  const positions: Record<string, [number, number]> = {}
  for (const id of Object.keys(layout.positions).sort()) positions[id] = layout.positions[id]!
  const path = layoutPathFor(storyFile)
  await mkdir(dirname(path), { recursive: true })
  // Keep each [x, y] pair on one line.
  const body = JSON.stringify({ version: 1, positions }, null, 2).replace(/\[\s+(-?[\d.e+-]+),\s+(-?[\d.e+-]+)\s+\]/g, "[$1, $2]")
  await writeFile(path, body + "\n", "utf8")
}
