import { describe, expect, it } from "vitest"
import { assertConceptFile, parseConceptScriptName } from "../../src/concepts/concepts"
import { besideRect, cardRect, freeSpot, markRect, occupiedRects, optionLabels, overlaps, placeRow, type Rect } from "../../src/boards/layout"
import type { Board, Card, Mark } from "../../src/boards/types"

const card = (id: string, x: number, y: number, over: Partial<Card> = {}): Card => ({ id, kind: "concept", x, y, w: 260, ref: "k", madeBy: "you", createdAt: "2026-01-01T00:00:00.000Z", ...over })
const mark = (id: string, path: number[]): Mark => ({ id, shape: "circle", path, anchors: [], thread: [], status: "open", madeBy: "you", createdAt: "2026-01-01T00:00:00.000Z" })
const board = (cards: Card[], marks: Mark[] = []): Board => ({ name: "main", cards, marks, edges: [] })

describe("board layout", () => {
  it("places a row beside a target, level with its top, when nothing is in the way", () => {
    const target = markRect(mark("m_1", [0, 0, 200, 0, 200, 100, 0, 100]))
    const spots = placeRow(besideRect(target), [{ w: 320, h: 120 }, { w: 260, h: 260 }, { w: 260, h: 260 }], [target])
    expect(spots).toEqual([{ x: 240, y: 0 }, { x: 600, y: 0 }, { x: 900, y: 0 }])
  })

  it("moves the whole row down past anything it would cover, and the result overlaps nothing", () => {
    const b = board([card("c_a", 500, -50), card("c_b", 1200, 400, { kind: "note", text: "x".repeat(900), w: 300 })], [mark("m_1", [0, 0, 200, 0, 200, 100, 0, 100])])
    const occupied = occupiedRects(b)
    const sizes = [{ w: 320, h: 200 }, { w: 260, h: 260 }, { w: 260, h: 260 }, { w: 260, h: 260 }]
    const spots = placeRow(besideRect(markRect(b.marks[0]!)), sizes, occupied)
    const placed: Rect[] = spots.map((s, i) => ({ ...s, ...sizes[i]! }))
    expect(new Set(spots.map((s) => s.y)).size).toBe(1)
    expect(spots[0]!.x).toBe(240)
    for (const p of placed) for (const o of occupied) expect(overlaps(p, o)).toBe(false)
    for (const [i, p] of placed.entries()) for (const q of placed.slice(i + 1)) expect(overlaps(p, q)).toBe(false)
  })

  it("stacks a second row under the first", () => {
    const first = placeRow({ x: 240, y: 0 }, [{ w: 260, h: 300 }, { w: 260, h: 300 }], [])
    const occupied = first.map((s) => ({ ...s, w: 260, h: 300 }))
    const second = placeRow({ x: 240, y: 0 }, [{ w: 260, h: 300 }], occupied)
    expect(second).toEqual([{ x: 240, y: 340 }])
    expect(freeSpot({ x: 240, y: 0, w: 10, h: 10 }, occupied, 0)).toEqual({ x: 240, y: 300 })
  })

  it("estimates heights from content: notes grow with their text, captions add a line", () => {
    const short = cardRect(card("c_n", 0, 0, { kind: "note", w: 300, text: "hi" }))
    const long = cardRect(card("c_m", 0, 0, { kind: "note", w: 300, text: "word ".repeat(200) }))
    expect(long.h).toBeGreaterThan(short.h * 5)
    expect(cardRect(card("c_c", 0, 0, { caption: "A - low sun" })).h).toBeGreaterThan(cardRect(card("c_d", 0, 0)).h)
  })

  it("labels options A, B, C", () => {
    expect(optionLabels(3)).toEqual(["A", "B", "C"])
  })
})

describe("concept script names", () => {
  it("knows draw.gd and draw_a.gd..draw_e.gd and refuses any other script", () => {
    expect(parseConceptScriptName("draw.gd")).toEqual({})
    expect(parseConceptScriptName("draw_c.gd")).toEqual({ variant: "c" })
    expect(parseConceptScriptName("draw_f.gd")).toBeUndefined()
    expect(assertConceptFile("k1", "concepts/k1/draw_e.gd")).toBe("concepts/k1/draw_e.gd")
    expect(assertConceptFile("k1", "concepts/k1/caption_e.txt")).toBe("concepts/k1/caption_e.txt")
    for (const bad of ["concepts/k1/draw_f.gd", "concepts/k1/sub/draw_a.gd", "concepts/k1/other.gd", "concepts/k1/DRAW_A.GD"]) {
      expect(() => assertConceptFile("k1", bad)).toThrow(/the only scripts are/)
    }
  })
})
