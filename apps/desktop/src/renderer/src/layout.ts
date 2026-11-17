import type { PassageDTO, StoryDTO } from "../../shared/api"

export const NODE_W = 232
const COL_GAP = 96
const ROW_GAP = 36

/** Rough card height, used only to stack auto-placed cards without overlap. */
export function estimateHeight(p: PassageDTO): number {
  const chips = p.tags.filter((t) => t !== "start" && t !== "ending").length > 0 ? 22 : 0
  return 38 + chips + (p.when ? 22 : 0) + p.choices.length * 24 + (p.choices.length ? 10 : 22)
}

/**
 * Positions for every passage: positions already on screen (`keep`), then the saved layout, else BFS columns from the start
 * (column = distance from the start). Passages the start cannot reach go in a last column.
 */
export function autoLayout(story: StoryDTO, keep: Record<string, [number, number]> = {}): Record<string, [number, number]> {
  const byId = new Map(story.passages.map((p) => [p.id, p]))
  const depth = new Map<string, number>()
  const start = story.passages.find((p) => p.isStart) ?? story.passages[0]
  if (start) {
    depth.set(start.id, 0)
    const queue = [start.id]
    while (queue.length) {
      const id = queue.shift()!
      for (const c of byId.get(id)?.choices ?? []) {
        if (c.targetId && byId.has(c.targetId) && !depth.has(c.targetId)) {
          depth.set(c.targetId, depth.get(id)! + 1)
          queue.push(c.targetId)
        }
      }
    }
  }
  const maxDepth = Math.max(0, ...depth.values())
  const columns = new Map<number, PassageDTO[]>()
  for (const p of story.passages) {
    const col = depth.get(p.id) ?? maxDepth + 1
    if (!columns.has(col)) columns.set(col, [])
    columns.get(col)!.push(p)
  }
  const out: Record<string, [number, number]> = {}
  for (const [col, list] of columns) {
    const total = list.reduce((h, p) => h + estimateHeight(p) + ROW_GAP, -ROW_GAP)
    let y = -total / 2
    for (const p of list) {
      out[p.id] = [col * (NODE_W + COL_GAP), Math.round(y)]
      y += estimateHeight(p) + ROW_GAP
    }
  }
  for (const p of story.passages) {
    const saved = keep[p.id] ?? story.positions[p.id]
    if (saved) out[p.id] = saved
  }
  return out
}
