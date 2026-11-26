/**
 * Pure helpers for the Frames view: a pixel diff between two captures and the frame arithmetic the flipbook uses.
 * Nothing here touches the DOM, so it is unit-tested directly.
 */

/** RGBA pixels, row-major, as a canvas `ImageData` holds them. */
export type RawImage = { data: Uint8ClampedArray; width: number; height: number }

export type ImageDiff = RawImage & {
  /** Pixels whose largest channel delta exceeded the threshold, plus pixels that exist in only one image. */
  changedPixels: number
  totalPixels: number
  /** 0..100. */
  percentChanged: number
}

export const DEFAULT_DIFF_THRESHOLD = 8

/** Changed pixels are painted magenta; pixels outside the smaller image (a size mismatch) are amber. */
const CHANGED: readonly [number, number, number] = [255, 0, 170]
const OUT_OF_BOUNDS: readonly [number, number, number] = [255, 176, 0]
/** How much of the After image's brightness the unchanged pixels keep, so the highlights stand out. */
const DIM = 0.35

const dim = (d: Uint8ClampedArray, i: number) => {
  const r = d[i] ?? 0
  const g = d[i + 1] ?? 0
  const b = d[i + 2] ?? 0
  const a = (d[i + 3] ?? 0) / 255
  // Rec. 709 luma, over the background the image is composited on (transparent reads as black).
  return (0.2126 * r + 0.7152 * g + 0.0722 * b) * a * DIM
}

/**
 * Compare `before` with `after` pixel by pixel. The result is as large as the bigger of the two images in each
 * direction; a pixel that only one image has counts as changed. A pixel differs when the largest of its R, G, B and A
 * deltas is above `threshold` (0..255, default 8, so antialiasing and compression noise do not light up).
 */
export function computeImageDiff(before: RawImage, after: RawImage, threshold: number = DEFAULT_DIFF_THRESHOLD): ImageDiff {
  const t = Number.isFinite(threshold) ? Math.max(0, threshold) : DEFAULT_DIFF_THRESHOLD
  const width = Math.max(before.width, after.width)
  const height = Math.max(before.height, after.height)
  const totalPixels = width * height
  const out = new Uint8ClampedArray(totalPixels * 4)
  let changedPixels = 0

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const o = (y * width + x) * 4
      const inBefore = x < before.width && y < before.height
      const inAfter = x < after.width && y < after.height
      if (!inBefore || !inAfter) {
        changedPixels++
        out[o] = OUT_OF_BOUNDS[0]
        out[o + 1] = OUT_OF_BOUNDS[1]
        out[o + 2] = OUT_OF_BOUNDS[2]
        out[o + 3] = 255
        continue
      }
      const bi = (y * before.width + x) * 4
      const ai = (y * after.width + x) * 4
      let delta = 0
      for (let c = 0; c < 4; c++) delta = Math.max(delta, Math.abs((before.data[bi + c] ?? 0) - (after.data[ai + c] ?? 0)))
      if (delta > t) {
        changedPixels++
        out[o] = CHANGED[0]
        out[o + 1] = CHANGED[1]
        out[o + 2] = CHANGED[2]
      } else {
        const v = dim(after.data, ai)
        out[o] = v
        out[o + 1] = v
        out[o + 2] = v
      }
      out[o + 3] = 255
    }
  }
  return { data: out, width, height, changedPixels, totalPixels, percentChanged: totalPixels === 0 ? 0 : (changedPixels / totalPixels) * 100 }
}

const grouped = new Intl.NumberFormat("en-US")

/** "4.2% changed (12,340 / 294,912 px)", or "Identical (0% changed)" when nothing differs. */
export function formatDiffReadout(d: Pick<ImageDiff, "changedPixels" | "totalPixels" | "percentChanged">): string {
  if (d.changedPixels === 0) return "Identical (0% changed)"
  const pct = d.percentChanged
  // A few changed pixels in a big frame would round to "0.0%", which reads as identical.
  const shown = pct < 0.1 ? "<0.1" : pct >= 99.95 ? "100" : pct.toFixed(1)
  return `${shown}% changed (${grouped.format(d.changedPixels)} / ${grouped.format(d.totalPixels)} px)`
}

/** The playable frame rates, and the one a flipbook starts at. */
export const FLIPBOOK_FPS = [6, 12, 24, 30] as const
export const DEFAULT_FPS = 12

/** `frame` held inside 0..count-1 (0 when there are no frames). */
export function clampFrame(frame: number, count: number): number {
  if (count <= 0 || !Number.isFinite(frame)) return 0
  return Math.min(count - 1, Math.max(0, Math.trunc(frame)))
}

/** `delta` frames on from `frame`, wrapping around either end. */
export function stepFrame(frame: number, count: number, delta: number): number {
  if (count <= 0) return 0
  // The extra `+ count` keeps the remainder non-negative (and avoids a -0 for a single frame).
  return (((clampFrame(frame, count) + delta) % count) + count) % count
}
