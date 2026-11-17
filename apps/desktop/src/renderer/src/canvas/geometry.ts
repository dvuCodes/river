/** Geometry for canvas marks. All coordinates are board units (React Flow's flow coordinates). */

export interface Rect {
  x: number
  y: number
  w: number
  h: number
}

export type Pt = [number, number]

export function pointsOf(path: number[]): Pt[] {
  const out: Pt[] = []
  for (let i = 0; i + 1 < path.length; i += 2) out.push([path[i]!, path[i + 1]!])
  return out
}

export function flatten(points: Pt[]): number[] {
  return points.flatMap(([x, y]) => [Math.round(x * 10) / 10, Math.round(y * 10) / 10])
}

/** Split a pen path into strokes at `breaks` (point indexes). */
export function strokesOf(path: number[], breaks: number[] | undefined): Pt[][] {
  const pts = pointsOf(path)
  const cuts = [...new Set((breaks ?? []).filter((b) => b > 0 && b < pts.length))].sort((a, b) => a - b)
  const out: Pt[][] = []
  let from = 0
  for (const c of [...cuts, pts.length]) {
    if (c > from) out.push(pts.slice(from, c))
    from = c
  }
  return out
}

export function bounds(path: number[]): Rect {
  const pts = pointsOf(path)
  if (pts.length === 0) return { x: 0, y: 0, w: 0, h: 0 }
  let x0 = Infinity
  let y0 = Infinity
  let x1 = -Infinity
  let y1 = -Infinity
  for (const [x, y] of pts) {
    x0 = Math.min(x0, x)
    y0 = Math.min(y0, y)
    x1 = Math.max(x1, x)
    y1 = Math.max(y1, y)
  }
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 }
}

export function intersects(a: Rect, b: Rect): boolean {
  return a.x <= b.x + b.w && b.x <= a.x + a.w && a.y <= b.y + b.h && b.y <= a.y + a.h
}

export function grow(r: Rect, by: number): Rect {
  return { x: r.x - by, y: r.y - by, w: r.w + by * 2, h: r.h + by * 2 }
}

/** Distance between two rectangles (0 when they touch or overlap). */
export function rectDistance(a: Rect, b: Rect): number {
  const dx = Math.max(0, a.x - (b.x + b.w), b.x - (a.x + a.w))
  const dy = Math.max(0, a.y - (b.y + b.h), b.y - (a.y + a.h))
  return Math.hypot(dx, dy)
}

/**
 * Cards a mark refers to: those whose bounds intersect the mark's bounding box. A pen note that touches
 * no card is anchored to the nearest card within `near` board units.
 */
export function anchorsFor(shape: string, path: number[], cards: { id: string; rect: Rect }[], near = 80): string[] {
  const box = bounds(path)
  const hit = cards.filter((c) => intersects(box, c.rect)).map((c) => c.id)
  if (hit.length > 0 || (shape !== "pen" && shape !== "pin")) return hit
  let best: { id: string; d: number } | undefined
  for (const c of cards) {
    const d = rectDistance(box, c.rect)
    if (d <= near && (!best || d < best.d)) best = { id: c.id, d }
  }
  return best ? [best.id] : []
}

/** Smooth polyline: quadratic curves through the midpoints of consecutive points. */
export function smoothPath(points: Pt[], closed = false): string {
  if (points.length === 0) return ""
  const f = (n: number) => Math.round(n * 10) / 10
  const [first] = points
  if (points.length === 1) return `M${f(first![0])} ${f(first![1])}l0.1 0`
  if (points.length === 2) return `M${f(first![0])} ${f(first![1])}L${f(points[1]![0])} ${f(points[1]![1])}`
  let d = `M${f(first![0])} ${f(first![1])}`
  for (let i = 1; i < points.length - 1; i++) {
    const [x, y] = points[i]!
    const [nx, ny] = points[i + 1]!
    d += `Q${f(x)} ${f(y)} ${f((x + nx) / 2)} ${f((y + ny) / 2)}`
  }
  const last = points[points.length - 1]!
  d += `L${f(last[0])} ${f(last[1])}`
  return closed ? d + "Z" : d
}

/** Outline of the ellipse inscribed in the box from a to b, as points. */
export function ellipsePoints(a: Pt, b: Pt, n = 48): Pt[] {
  const cx = (a[0] + b[0]) / 2
  const cy = (a[1] + b[1]) / 2
  const rx = Math.abs(b[0] - a[0]) / 2
  const ry = Math.abs(b[1] - a[1]) / 2
  const out: Pt[] = []
  for (let i = 0; i <= n; i++) {
    const t = (i / n) * Math.PI * 2
    out.push([cx + rx * Math.cos(t), cy + ry * Math.sin(t)])
  }
  return out
}

/** Arrow shaft plus a two-stroke head at the end. */
export function arrowPath(path: number[], head = 14): string {
  const pts = pointsOf(path)
  if (pts.length < 2) return ""
  const [x0, y0] = pts[0]!
  const [x1, y1] = pts[pts.length - 1]!
  const a = Math.atan2(y1 - y0, x1 - x0)
  const h1: Pt = [x1 - head * Math.cos(a - 0.45), y1 - head * Math.sin(a - 0.45)]
  const h2: Pt = [x1 - head * Math.cos(a + 0.45), y1 - head * Math.sin(a + 0.45)]
  const f = (n: number) => Math.round(n * 10) / 10
  return `M${f(x0)} ${f(y0)}L${f(x1)} ${f(y1)}M${f(h1[0])} ${f(h1[1])}L${f(x1)} ${f(y1)}L${f(h2[0])} ${f(h2[1])}`
}
