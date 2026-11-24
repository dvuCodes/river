import { describe, expect, it } from "vitest"
import { clampFrame, computeImageDiff, DEFAULT_DIFF_THRESHOLD, DEFAULT_FPS, FLIPBOOK_FPS, formatDiffReadout, type RawImage, stepFrame } from "../src/renderer/src/views/frameDiff"

/** A solid image of one RGBA colour. */
function solid(width: number, height: number, rgba: [number, number, number, number] = [0, 0, 0, 255]): RawImage {
  const data = new Uint8ClampedArray(width * height * 4)
  for (let i = 0; i < width * height; i++) data.set(rgba, i * 4)
  return { data, width, height }
}
const px = (img: { data: Uint8ClampedArray; width: number }, x: number, y: number) => Array.from(img.data.slice((y * img.width + x) * 4, (y * img.width + x) * 4 + 4))
const MAGENTA = [255, 0, 170, 255]
const AMBER = [255, 176, 0, 255]

describe("computeImageDiff", () => {
  it("reports identical images as 0% changed, drawn as dimmed grayscale of After", () => {
    const d = computeImageDiff(solid(4, 3, [200, 100, 50, 255]), solid(4, 3, [200, 100, 50, 255]))
    expect(d).toMatchObject({ width: 4, height: 3, changedPixels: 0, totalPixels: 12, percentChanged: 0 })
    expect(d.data).toHaveLength(4 * 3 * 4)
    const [r, g, b, al] = px(d, 0, 0) as [number, number, number, number]
    expect(r).toBe(g)
    expect(g).toBe(b)
    expect(r).toBeGreaterThan(0)
    expect(r).toBeLessThan(100) // dimmed below the source luma
    expect(al).toBe(255)
  })

  it("highlights only the pixels that changed, in magenta", () => {
    const before = solid(4, 4)
    const after = solid(4, 4)
    after.data.set([255, 255, 255, 255], (1 * 4 + 2) * 4)
    const d = computeImageDiff(before, after)
    expect(d.changedPixels).toBe(1)
    expect(d.totalPixels).toBe(16)
    expect(d.percentChanged).toBeCloseTo(6.25)
    expect(px(d, 2, 1)).toEqual(MAGENTA)
    expect(px(d, 0, 0)).not.toEqual(MAGENTA)
  })

  it("ignores deltas up to the threshold and flags those above it", () => {
    const before = solid(2, 1, [100, 100, 100, 255])
    const after = solid(2, 1, [100, 100, 100, 255])
    after.data.set([108, 100, 100, 255], 0) // delta 8: at the default threshold, not changed
    after.data.set([109, 100, 100, 255], 4) // delta 9: changed
    expect(DEFAULT_DIFF_THRESHOLD).toBe(8)
    const d = computeImageDiff(before, after)
    expect(d.changedPixels).toBe(1)
    expect(px(d, 0, 0)).not.toEqual(MAGENTA)
    expect(px(d, 1, 0)).toEqual(MAGENTA)
    expect(computeImageDiff(before, after, 0).changedPixels).toBe(2)
    expect(computeImageDiff(before, after, 9).changedPixels).toBe(0)
  })

  it("uses the largest delta over R, G, B and A", () => {
    const before = solid(1, 1, [10, 10, 10, 255])
    for (const channel of [0, 1, 2, 3]) {
      const after = solid(1, 1, [10, 10, 10, 255])
      after.data[channel] = channel === 3 ? 200 : 100
      expect(computeImageDiff(before, after).changedPixels).toBe(1)
    }
  })

  it("compares the same pixel position when the images have different row widths", () => {
    const before = solid(2, 2)
    const after = solid(3, 2)
    after.data.set([255, 0, 0, 255], (1 * 3 + 1) * 4) // (1,1) differs; column 2 is outside Before
    const d = computeImageDiff(before, after)
    expect(px(d, 1, 1)).toEqual(MAGENTA)
    expect(px(d, 0, 0)).not.toEqual(MAGENTA)
  })

  it("sizes the result to the larger image and marks pixels only one image has as changed", () => {
    const d = computeImageDiff(solid(2, 3), solid(4, 2))
    expect(d.width).toBe(4)
    expect(d.height).toBe(3)
    expect(d.totalPixels).toBe(12)
    expect(d.data).toHaveLength(12 * 4)
    // The 2x2 overlap is identical; the other 8 pixels are outside one image or the other.
    expect(d.changedPixels).toBe(8)
    expect(px(d, 3, 0)).toEqual(AMBER) // After only
    expect(px(d, 0, 2)).toEqual(AMBER) // Before only
    expect(px(d, 1, 1)).not.toEqual(AMBER)
    expect(d.percentChanged).toBeCloseTo((8 / 12) * 100)
  })

  it("treats an empty image as entirely changed against a real one, and two empties as identical", () => {
    const empty: RawImage = { data: new Uint8ClampedArray(0), width: 0, height: 0 }
    expect(computeImageDiff(empty, solid(2, 2))).toMatchObject({ changedPixels: 4, totalPixels: 4, percentChanged: 100 })
    const both = computeImageDiff(empty, empty)
    expect(both).toMatchObject({ width: 0, height: 0, changedPixels: 0, totalPixels: 0, percentChanged: 0 })
    expect(both.data).toHaveLength(0)
  })

  it("does not read past short pixel buffers", () => {
    const short: RawImage = { data: new Uint8ClampedArray(4), width: 2, height: 1 }
    expect(() => computeImageDiff(short, solid(2, 1))).not.toThrow()
  })

  it("falls back to the default threshold for NaN and floors a negative one at 0", () => {
    const before = solid(1, 1, [0, 0, 0, 255])
    const after = solid(1, 1, [5, 0, 0, 255])
    expect(computeImageDiff(before, after, Number.NaN).changedPixels).toBe(0)
    expect(computeImageDiff(before, after, -10).changedPixels).toBe(1)
  })

  it("does not modify its inputs", () => {
    const before = solid(2, 2, [1, 2, 3, 255])
    const after = solid(2, 2, [200, 2, 3, 255])
    const b = Array.from(before.data)
    const a = Array.from(after.data)
    computeImageDiff(before, after)
    expect(Array.from(before.data)).toEqual(b)
    expect(Array.from(after.data)).toEqual(a)
  })
})

describe("formatDiffReadout", () => {
  it("says Identical when nothing changed", () => {
    expect(formatDiffReadout(computeImageDiff(solid(3, 3), solid(3, 3)))).toBe("Identical (0% changed)")
  })

  it("shows the percentage and grouped pixel counts", () => {
    expect(formatDiffReadout({ changedPixels: 12340, totalPixels: 294912, percentChanged: (12340 / 294912) * 100 })).toBe("4.2% changed (12,340 / 294,912 px)")
  })

  it("never rounds a real change down to 0.0% or an incomplete one up to 100%", () => {
    expect(formatDiffReadout({ changedPixels: 1, totalPixels: 1_000_000, percentChanged: 0.0001 })).toBe("<0.1% changed (1 / 1,000,000 px)")
    expect(formatDiffReadout({ changedPixels: 9999, totalPixels: 10000, percentChanged: 99.99 })).toBe("100% changed (9,999 / 10,000 px)")
    expect(formatDiffReadout(computeImageDiff(solid(2, 2), solid(2, 2, [255, 255, 255, 255])))).toBe("100% changed (4 / 4 px)")
  })
})

describe("flipbook frame arithmetic", () => {
  it("offers 6, 12, 24 and 30 fps, starting at 12", () => {
    expect([...FLIPBOOK_FPS]).toEqual([6, 12, 24, 30])
    expect(DEFAULT_FPS).toBe(12)
  })

  it("clamps a frame into the capture, and to 0 when there are no frames", () => {
    expect(clampFrame(7, 3)).toBe(2)
    expect(clampFrame(-2, 3)).toBe(0)
    expect(clampFrame(1.9, 3)).toBe(1)
    expect(clampFrame(Number.NaN, 3)).toBe(0)
    expect(clampFrame(4, 0)).toBe(0)
  })

  it("steps forward and back, wrapping at both ends", () => {
    expect(stepFrame(0, 4, 1)).toBe(1)
    expect(stepFrame(3, 4, 1)).toBe(0)
    expect(stepFrame(0, 4, -1)).toBe(3)
    expect(stepFrame(2, 4, -1)).toBe(1)
    expect(stepFrame(0, 4, -9)).toBe(3)
  })

  it("steps from a clamped frame, and stays at 0 for no frames or one frame", () => {
    expect(stepFrame(9, 3, 1)).toBe(0) // 9 clamps to 2, then wraps
    expect(stepFrame(5, 0, 1)).toBe(0)
    expect(stepFrame(0, 1, 1)).toBe(0)
    expect(stepFrame(0, 1, -1)).toBe(0)
  })
})
