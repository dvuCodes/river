/** A box in CSS px, in window coordinates. */
export interface Box {
  left: number
  right: number
  top: number
  bottom: number
}

/**
 * The review's layout, as far as the user can read it. Run is allowed only when `allInView` holds: an approval covers
 * every byte, so scrolling the list down has to bring every byte on screen, none of it past an edge.
 */
export interface ReviewLayout {
  /** Lines across all scripts, as the bytes count them; one code row each. */
  lines: number
  /** The list's own scrolling viewport. */
  list: Box
  /** What the window and every clipping ancestor of the list leave on screen. */
  visible: Box
  /** Every box from the list down to the code: none may scroll or spill sideways. */
  boxes: { scrollWidth: number; clientWidth: number }[]
  /** Each code row's horizontal extent. */
  code: { left: number; right: number }[]
  /** Something else is on top of the list at one of the points sampled across it. */
  occluded: boolean
}

/** Sub-pixel layout rounds each measure on its own. */
const SLACK = 1
/** One script row: a list shorter than this shows no line whole. */
const ROW = 16

export function allInView(l: ReviewLayout): boolean {
  const { list, visible } = l
  return (
    l.lines > 0 &&
    !l.occluded &&
    l.code.length === l.lines &&
    list.bottom - list.top >= ROW &&
    list.left >= visible.left - SLACK &&
    list.right <= visible.right + SLACK &&
    list.top >= visible.top - SLACK &&
    list.bottom <= visible.bottom + SLACK &&
    l.boxes.every((b) => b.scrollWidth <= b.clientWidth + SLACK) &&
    l.code.every((c) => c.left >= list.left - SLACK && c.right <= list.right + SLACK)
  )
}

const clientBox = (el: Element): Box => {
  const r = el.getBoundingClientRect()
  const left = r.left + el.clientLeft
  const top = r.top + el.clientTop
  return { left, right: left + el.clientWidth, top, bottom: top + el.clientHeight }
}

/** Grid points per side, sampled across the list's visible box. */
const GRID = 5
/** Code rows on screen whose first and last characters are sampled; a list at a small zoom can show hundreds. */
const MAX_ROWS = 200

/**
 * Whether anything other than the list itself is the topmost element at a grid of points across the list's visible
 * part, or at the first and last character of a code row on screen. Hit testing passes through `pointer-events: none`,
 * so an overlay styled that way goes unseen here.
 */
function occluded(list: HTMLElement, box: Box): boolean {
  if (box.right - box.left < 1 || box.bottom - box.top < 1) return false
  const points: [number, number][] = []
  for (let i = 0; i < GRID; i++) {
    for (let j = 0; j < GRID; j++) {
      points.push([box.left + ((i + 0.5) * (box.right - box.left)) / GRID, box.top + ((j + 0.5) * (box.bottom - box.top)) / GRID])
    }
  }
  const range = document.createRange()
  const inside = (r: DOMRect) => r.bottom > box.top && r.top < box.bottom
  let rows = 0
  for (const code of list.querySelectorAll(".script-code")) {
    if (rows >= MAX_ROWS) break
    const text = code.firstChild
    if (!(text instanceof Text) || !inside(code.getBoundingClientRect())) continue
    const first = text.data.search(/\S/)
    if (first < 0) continue
    rows++
    for (const at of [first, text.data.trimEnd().length - 1]) {
      range.setStart(text, at)
      range.setEnd(text, at + 1)
      const r = range.getBoundingClientRect()
      points.push([(r.left + r.right) / 2, (r.top + r.bottom) / 2])
    }
  }
  return points.some(([x, y]) => {
    if (x < box.left || x > box.right || y < box.top || y > box.bottom) return false
    const hit = document.elementFromPoint(x, y)
    return !hit || !list.contains(hit)
  })
}

/** Read the layout of the review list `list` as it is laid out now. */
export function measureReview(list: HTMLElement, lines: number): ReviewLayout {
  const root = document.documentElement
  const visible: Box = { left: 0, right: root.clientWidth, top: 0, bottom: root.clientHeight }
  for (let a = list.parentElement; a && a !== root; a = a.parentElement) {
    const style = getComputedStyle(a)
    const box = clientBox(a)
    if (style.overflowX !== "visible") {
      visible.left = Math.max(visible.left, box.left)
      visible.right = Math.min(visible.right, box.right)
    }
    if (style.overflowY !== "visible") {
      visible.top = Math.max(visible.top, box.top)
      visible.bottom = Math.min(visible.bottom, box.bottom)
    }
  }
  const listBox = clientBox(list)
  const shown: Box = {
    left: Math.max(listBox.left, visible.left),
    right: Math.min(listBox.right, visible.right),
    top: Math.max(listBox.top, visible.top),
    bottom: Math.min(listBox.bottom, visible.bottom),
  }
  const inner = list.querySelectorAll(".review-script, .concept-script-head, .concept-script-head > *, .concept-script-text, .script-row, .script-code")
  return {
    lines,
    list: listBox,
    visible,
    boxes: [list, ...inner].map((el) => ({ scrollWidth: el.scrollWidth, clientWidth: el.clientWidth })),
    code: [...list.querySelectorAll(".script-code")].map((el) => {
      const r = el.getBoundingClientRect()
      return { left: r.left, right: r.right }
    }),
    occluded: occluded(list, shown),
  }
}
