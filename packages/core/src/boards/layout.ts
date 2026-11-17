/**
 * Where River puts new cards on a board: beside a card or mark, in a row, never on top of anything.
 * Cards store only their width, so heights here are estimates of what the canvas draws.
 */
import type { Board, Card, Mark } from "./types"

export interface Rect {
  x: number
  y: number
  w: number
  h: number
}

export interface Size {
  w: number
  h: number
}

/** Space River leaves between the cards and marks it places. */
export const BOARD_GAP = 40
/** Width of the image cards River places (concept options, captured frames). */
export const IMAGE_CARD_W = 260
/** Width of the note cards River places. */
export const NOTE_CARD_W = 320

const LINE_H = 20
const CHAR_W = 7.5
const PAD = 24

/** Height of `text` wrapped at width `w`, with the card's padding. */
function textHeight(text: string, w: number): number {
  const perLine = Math.max(10, Math.floor((w - PAD) / CHAR_W))
  const lines = text.split("\n").reduce((n, para) => n + Math.max(1, Math.ceil(para.length / perLine)), 0)
  return PAD + lines * LINE_H
}

/** The height the canvas draws a card at, estimated. */
export function cardHeight(card: Pick<Card, "kind" | "w" | "text" | "caption">): number {
  const caption = card.caption ? textHeight(card.caption, card.w) - PAD + 8 : 0
  switch (card.kind) {
    case "note":
      return textHeight(card.text ?? "", card.w)
    case "passage":
      return Math.round(card.w * 0.75)
    case "frame":
      return Math.round((card.w * 9) / 16) + caption
    default:
      // Concept renders are square; a reference image's shape is unknown, so square is the guess.
      return card.w + caption
  }
}

export function cardRect(card: Card): Rect {
  return { x: card.x, y: card.y, w: card.w, h: cardHeight(card) }
}

/** The bounding box of a mark's points. */
export function markRect(mark: Mark): Rect {
  const xs = mark.path.filter((_, i) => i % 2 === 0)
  const ys = mark.path.filter((_, i) => i % 2 === 1)
  if (xs.length === 0 || ys.length === 0) return { x: 0, y: 0, w: 1, h: 1 }
  const x = Math.min(...xs)
  const y = Math.min(...ys)
  return { x, y, w: Math.max(1, Math.max(...xs) - x), h: Math.max(1, Math.max(...ys) - y) }
}

/** The rect of the card or mark with this id, or undefined. */
export function elementRect(board: Board, id: string): Rect | undefined {
  const card = board.cards.find((c) => c.id === id)
  if (card) return cardRect(card)
  const mark = board.marks.find((m) => m.id === id)
  return mark ? markRect(mark) : undefined
}

/** Every card and mark on the board, except the ids in `skip` (cards about to move). */
export function occupiedRects(board: Board, skip: ReadonlySet<string> = new Set()): Rect[] {
  return [...board.cards.filter((c) => !skip.has(c.id)).map(cardRect), ...board.marks.filter((m) => !skip.has(m.id)).map(markRect)]
}

/** True when a and b come closer than `gap` on both axes. */
export function overlaps(a: Rect, b: Rect, gap = 0): boolean {
  return a.x < b.x + b.w + gap && b.x < a.x + a.w + gap && a.y < b.y + b.h + gap && b.y < a.y + a.h + gap
}

/**
 * The first place for `want` at its x, at or below its y, that keeps `gap` from every occupied rect.
 * Sliding straight down keeps a row level with what it answers and stacks later rows under earlier ones.
 */
export function freeSpot(want: Rect, occupied: readonly Rect[], gap = BOARD_GAP): { x: number; y: number } {
  let y = want.y
  for (;;) {
    const hits = occupied.filter((o) => overlaps({ ...want, y }, o, gap))
    if (hits.length === 0) return { x: want.x, y }
    y = Math.max(...hits.map((o) => o.y + o.h)) + gap
  }
}

/** Where a row of `sizes` starting at `start` lands: left to right, tops aligned, the whole row moved down past anything in the way. */
export function placeRow(start: { x: number; y: number }, sizes: readonly Size[], occupied: readonly Rect[], gap = BOARD_GAP): { x: number; y: number }[] {
  const w = sizes.reduce((sum, s) => sum + s.w, 0) + gap * Math.max(0, sizes.length - 1)
  const h = Math.max(0, ...sizes.map((s) => s.h))
  const at = freeSpot({ x: start.x, y: start.y, w, h }, occupied, gap)
  let x = at.x
  return sizes.map((s) => {
    const spot = { x, y: at.y }
    x += s.w + gap
    return spot
  })
}

/** The start of a row beside `target`: right of it, level with its top. */
export function besideRect(target: Rect, gap = BOARD_GAP): { x: number; y: number } {
  return { x: target.x + target.w + gap, y: target.y }
}

/** Option labels for a row: "A", "B", ... */
export function optionLabels(n: number): string[] {
  return Array.from({ length: n }, (_, i) => String.fromCharCode(65 + (i % 26)))
}
