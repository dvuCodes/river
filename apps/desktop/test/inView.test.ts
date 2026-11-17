import { describe, expect, it } from "vitest"
import { type ReviewLayout, allInView } from "../src/renderer/src/approval/inView"

const fits: ReviewLayout = {
  lines: 2,
  list: { left: 440, right: 1157, top: 240, bottom: 820 },
  visible: { left: 0, right: 1427, top: 0, bottom: 865 },
  boxes: [
    { scrollWidth: 717, clientWidth: 717 },
    { scrollWidth: 680, clientWidth: 680 },
  ],
  code: [
    { left: 470, right: 1150 },
    { left: 470, right: 1150 },
  ],
  occluded: false,
}

describe("allInView", () => {
  it("lets Run through when every box fits, every code row sits inside the list, and the list is on screen", () => {
    expect(allInView(fits)).toBe(true)
  })

  it("allows a pixel of rounding either way", () => {
    expect(
      allInView({
        ...fits,
        list: { left: -1, right: 1428, top: -1, bottom: 866 },
        boxes: [{ scrollWidth: 718, clientWidth: 717 }],
        code: fits.code.map(() => ({ left: -2, right: 1429 })),
      }),
    ).toBe(true)
  })

  it("blocks Run when the list scrolls sideways, as a 160-character caption made it", () => {
    expect(allInView({ ...fits, boxes: [{ scrollWidth: 1334, clientWidth: 727 }, ...fits.boxes] })).toBe(false)
  })

  it("blocks Run when a row's text spills past its own box", () => {
    expect(allInView({ ...fits, boxes: [...fits.boxes, { scrollWidth: 900, clientWidth: 680 }] })).toBe(false)
  })

  it("blocks Run when a code row reaches past either side of the list", () => {
    expect(allInView({ ...fits, code: [fits.code[0]!, { left: 470, right: 2163 }] })).toBe(false)
    expect(allInView({ ...fits, code: [{ left: 400, right: 1150 }, fits.code[1]!] })).toBe(false)
  })

  it("blocks Run when the window or a clipping ancestor cuts off any side of the list", () => {
    expect(allInView({ ...fits, visible: { ...fits.visible, right: 1000 } })).toBe(false)
    expect(allInView({ ...fits, visible: { ...fits.visible, left: 500 } })).toBe(false)
    expect(allInView({ ...fits, visible: { ...fits.visible, bottom: 700 } })).toBe(false)
    expect(allInView({ ...fits, visible: { ...fits.visible, top: 300 } })).toBe(false)
  })

  it("blocks Run when something is drawn over the list, even with every byte inside the window", () => {
    expect(allInView({ ...fits, occluded: true })).toBe(false)
  })

  it("blocks Run when the list is too short to show one row", () => {
    expect(allInView({ ...fits, list: { ...fits.list, bottom: fits.list.top + 15 } })).toBe(false)
  })

  it("blocks Run until every line of the bytes has its row laid out", () => {
    expect(allInView({ ...fits, lines: 3 })).toBe(false)
    expect(allInView({ ...fits, lines: 0, code: [] })).toBe(false)
  })
})
