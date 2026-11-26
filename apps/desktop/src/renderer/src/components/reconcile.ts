/**
 * Keeping node objects the same when nothing about them changed, so React Flow (and memoized node components) only
 * redraw the nodes that did change: a click on a passage then touches the old and the new selection, not every card.
 */

export interface ReconcilableNode<D> {
  id: string
  type?: string
  position: { x: number; y: number }
  data: D
  selected?: boolean
  measured?: { width?: number; height?: number }
}

/** Same members, in any order; two absent sets are equal. */
export function sameSet<T>(a: ReadonlySet<T> | undefined, b: ReadonlySet<T> | undefined): boolean {
  if (a === b) return true
  if (!a || !b || a.size !== b.size) return false
  for (const x of a) if (!b.has(x)) return false
  return true
}

/** Same items in the same order; two absent arrays are equal. */
export function sameArray<T>(a: readonly T[] | undefined, b: readonly T[] | undefined): boolean {
  if (a === b) return true
  if (!a || !b || a.length !== b.length) return false
  return a.every((x, i) => x === b[i])
}

/**
 * The next node list, reusing each previous node whose type, position and data (by `sameData`) are unchanged. A
 * changed node keeps the previous one's `measured` size (React Flow measures it again if it changed) and selection.
 * Returns `prev` itself when nothing changed at all.
 */
export function reconcileNodes<N extends ReconcilableNode<unknown>>(prev: readonly N[], next: readonly N[], sameData: (a: N, b: N) => boolean): N[] {
  const byId = new Map(prev.map((n) => [n.id, n]))
  let changed = prev.length !== next.length
  const out = next.map((n, i) => {
    const p = byId.get(n.id)
    if (p && p.type === n.type && p.position.x === n.position.x && p.position.y === n.position.y && sameData(p, n)) {
      if (prev[i] !== p) changed = true
      return p
    }
    changed = true
    if (!p) return n
    return { ...n, ...(p.measured ? { measured: p.measured } : {}), ...(p.selected !== undefined ? { selected: p.selected } : {}) }
  })
  return changed ? out : (prev as N[])
}
