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
}

/** Sub-pixel layout rounds each measure on its own. */
const SLACK = 1
/** One script row: a list shorter than this shows no line whole. */
const ROW = 16

export function allInView(l: ReviewLayout): boolean {
  const { list, visible } = l
  return (
    l.lines > 0 &&
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
  const inner = list.querySelectorAll(".review-script, .concept-script-head, .concept-script-head > *, .concept-script-text, .script-row, .script-code")
  return {
    lines,
    list: clientBox(list),
    visible,
    boxes: [list, ...inner].map((el) => ({ scrollWidth: el.scrollWidth, clientWidth: el.clientWidth })),
    code: [...list.querySelectorAll(".script-code")].map((el) => {
      const r = el.getBoundingClientRect()
      return { left: r.left, right: r.right }
    }),
  }
}
