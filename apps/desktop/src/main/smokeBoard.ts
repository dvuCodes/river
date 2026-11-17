import { mkdir, readFile, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { nativeImage } from "electron"
import { type Card, type Edge, type Mark, ensureBoard, saveCard, saveEdge, saveMark } from "@river/core"

/** Deterministic random numbers, so a seed paints the same scene every run. */
function rng(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function hsl(h: number, s: number, l: number): [number, number, number] {
  const k = (n: number) => (n + h / 30) % 12
  const a = s * Math.min(l, 1 - l)
  const f = (n: number) => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)))
  return [f(0) * 255, f(8) * 255, f(4) * 255]
}

/**
 * A landscape (sky, sun, ridges, film grain) as PNG bytes. The grain keeps the file near the size of real concept art,
 * so loading and decoding cost what they would on a real board.
 */
export function scenePng(seed: number, w = 960, h = 600, sunAt?: [number, number]): Buffer {
  const r = rng(seed)
  const hue = r() * 360
  const skyTop = hsl(hue, 0.45, 0.32 + r() * 0.2)
  const skyLow = hsl((hue + 30 + r() * 40) % 360, 0.6, 0.62 + r() * 0.18)
  const sun = { x: w * (0.2 + r() * 0.6), y: h * (0.18 + r() * 0.3), r: h * (0.05 + r() * 0.06), c: hsl((hue + 50) % 360, 0.85, 0.82) }
  if (sunAt) [sun.x, sun.y] = [w * sunAt[0], h * sunAt[1]]
  const layers = Array.from({ length: 4 }, (_v, i) => ({
    base: h * (0.42 + i * 0.13 + r() * 0.05),
    amp: h * (0.03 + r() * 0.06),
    f: (0.004 + r() * 0.01) * (i + 1),
    p: r() * 6.28,
    c: hsl((hue + 160 + i * 12) % 360, 0.35 + i * 0.05, 0.42 - i * 0.08),
  }))
  const ridge = layers.map((l) => Float32Array.from({ length: w }, (_v, x) => l.base + l.amp * Math.sin(x * l.f + l.p) + l.amp * 0.4 * Math.sin(x * l.f * 3.1 + l.p * 2)))
  const buf = Buffer.alloc(w * h * 4)
  for (let y = 0; y < h; y++) {
    const t = y / h
    for (let x = 0; x < w; x++) {
      let c: [number, number, number] = [skyTop[0] + (skyLow[0] - skyTop[0]) * t, skyTop[1] + (skyLow[1] - skyTop[1]) * t, skyTop[2] + (skyLow[2] - skyTop[2]) * t]
      const d = Math.hypot(x - sun.x, y - sun.y)
      if (d < sun.r) c = sun.c
      else if (d < sun.r * 3) {
        const g = 0.35 * (1 - (d - sun.r) / (sun.r * 2))
        c = [c[0] + (sun.c[0] - c[0]) * g, c[1] + (sun.c[1] - c[1]) * g, c[2] + (sun.c[2] - c[2]) * g]
      }
      for (let i = 0; i < layers.length; i++) {
        if (y > ridge[i]![x]!) {
          const shade = 1 - Math.min(0.25, (y - ridge[i]![x]!) / h)
          const lc = layers[i]!.c
          c = [lc[0] * shade, lc[1] * shade, lc[2] * shade]
        }
      }
      const grain = (r() - 0.5) * 7
      const o = (y * w + x) * 4
      buf[o] = Math.max(0, Math.min(255, c[2] + grain))
      buf[o + 1] = Math.max(0, Math.min(255, c[1] + grain))
      buf[o + 2] = Math.max(0, Math.min(255, c[0] + grain))
      buf[o + 3] = 255
    }
  }
  return nativeImage.createFromBitmap(buf, { width: w, height: h }).toPNG()
}

const at = (n: number) => new Date(Date.UTC(2026, 10, 1, 12, 0, n)).toISOString()

/** Painting is slow (about 0.2 s an image), so repeated smoke runs reuse the PNGs from the temp folder. */
async function cachedScene(seed: number, w = 960, h = 600): Promise<Buffer> {
  const file = join(tmpdir(), "river-smoke-scenes", `${seed}-${w}x${h}.png`)
  try {
    return await readFile(file)
  } catch {
    const png = scenePng(seed, w, h)
    await mkdir(join(tmpdir(), "river-smoke-scenes"), { recursive: true })
    await writeFile(file, png)
    return png
  }
}

async function refImage(root: string, name: string, seed: number, w?: number, h?: number): Promise<string> {
  const dir = join(root, ".river", "refs")
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, name), await cachedScene(seed, w, h))
  return `.river/refs/${name}`
}

export interface RichBoard {
  /** Card ids by role, for the smoke's input steps. */
  ids: Record<string, string>
  markId: string
}

/**
 * A board like a real session: references with licences, your note, an agent's answer with a row of labelled options
 * and a note, a sequence of beats joined by connectors, a circled reference and a pinned passage.
 */
export async function seedRichBoard(root: string, board: string, passageRef: string): Promise<RichBoard> {
  await ensureBoard(root, board)
  let n = 0
  const ids: Record<string, string> = {}
  const card = async (key: string, c: Omit<Card, "id" | "createdAt">) => {
    const saved = await saveCard(root, board, { ...c, id: `c_${key}`, createdAt: at(n++) })
    ids[key] = saved.id
    return saved
  }
  const edge = (from: string, to: string, madeBy: string) => saveEdge(root, board, { id: `e_${from.slice(2)}_${to.slice(2)}`.slice(0, 64), from, to, madeBy, createdAt: at(n++) } satisfies Edge)

  await card("research", { kind: "note", ref: "", x: 0, y: 0, w: 430, madeBy: "researcher", text: "Three references for the park at dusk: long shadows on the path, a still pond, the iron gate. All public domain or your own photos." })
  const refs: [string, string, Card["source"], string][] = [
    ["shadows", "long evening shadows", { title: "long evening shadows", url: "https://example.org/shadows", licence: "CC BY-SA 4.0" }, "researcher"],
    ["pond", "a still pond at dusk", { title: "a still pond at dusk", licence: "CC0" }, "researcher"],
    ["gate", "iron park gate", { title: "iron park gate", licence: "own work" }, "you"],
  ]
  for (const [i, [key, , source, by]] of refs.entries()) {
    await card(key, { kind: "ref", ref: await refImage(root, `rich-${key}.png`, 11 + i * 7, 900, 1200 - i * 150), source, x: i * 150, y: 120, w: 135, madeBy: by })
  }
  await card("ask", { kind: "note", ref: "", x: 520, y: 10, w: 290, madeBy: "you", text: "I like the gate. Can we try the pond scene at dusk, with fewer ducks?" })

  const conceptDir = join(root, "concepts", "dusk")
  await mkdir(conceptDir, { recursive: true })
  const options = [
    ["a", "A", "Low sun: the gate throws long shadows across the path"],
    ["b", "B", "Lanterns: warm lamps along the path, cool sky"],
    ["c", "C", "Mist: the pond fades into fog past the reeds"],
    ["d", "D", "Moonrise: blue light and one sleepy duck"],
  ] as const
  for (const [i, [variant, label, caption]] of options.entries()) {
    await writeFile(join(conceptDir, `concept_${variant}.png`), await cachedScene(101 + i * 13, 960, 720))
    await card(`opt${label}`, { kind: "concept", ref: "dusk", variant, label, caption: `${label} · ${caption}`, x: 520 + i * 262, y: 230, w: 240, madeBy: "concept-artist" })
  }
  await card("answer", {
    kind: "note",
    ref: "",
    x: 520,
    y: 475,
    w: 500,
    madeBy: "concept-artist",
    text: "Four takes on dusk. A keeps your gate in frame; B and D change the light; C hides the far bank so the pond reads as the end of the walk.\n\nQuestions:\n1. Should the dog be in the shot, or just its lead?\n2. Is the pond the end of the walk, or a stop on the way home?",
  })
  const beats = ["gate", "path", "pond", "home"]
  for (const [i, beat] of beats.entries()) {
    await card(`beat${i + 1}`, { kind: "ref", ref: await refImage(root, `beat-${beat}.png`, 211 + i * 5, 960, 600), source: { title: `${i + 1} · ${beat}`, licence: "own work" }, caption: `${i + 1} · ${beat}`, x: i * 290, y: 760, w: 250, madeBy: "storyboard-artist" })
  }
  await card("passage", { kind: "passage", ref: passageRef, x: 0, y: 470, w: 260, madeBy: "you" })

  const pond = 120
  const mark = await saveMark(root, board, {
    id: "m_circle01",
    shape: "circle",
    path: Array.from({ length: 49 }, (_v, i) => {
      const t = (i / 48) * Math.PI * 2
      return [Math.round((150 + 67 + 95 * Math.cos(t)) * 10) / 10, Math.round((pond + 95 + 120 * Math.sin(t)) * 10) / 10]
    }).flat(),
    anchors: [ids["pond"]!],
    thread: [{ by: "you", at: at(n++), text: "this light, but warmer" }],
    madeBy: "you",
    status: "answered",
    createdAt: at(n++),
  } satisfies Mark)

  for (const opt of ["optA", "optB", "optC", "optD"]) await edge(ids["ask"]!, ids[opt]!, "concept-artist")
  await edge(mark.id, ids["research"]!, "researcher")
  for (let i = 1; i < beats.length; i++) await edge(ids[`beat${i}`]!, ids[`beat${i + 1}`]!, "storyboard-artist")
  return { ids, markId: mark.id }
}

/** 150 cards (100 distinct generated images, 30 of your notes, 20 agent notes) in rows, and 60 connectors. */
export async function seedPerfBoard(root: string, board: string): Promise<{ cards: number; images: number; edges: number }> {
  await ensureBoard(root, board)
  const cards: Card[] = []
  let n = 0
  let images = 0
  let notes = 0
  const COLS = 10
  for (let i = 0; i < 150; i++) {
    const col = i % COLS
    const row = Math.floor(i / COLS)
    const base = { id: `c_p${String(i).padStart(3, "0")}`, x: col * 300, y: row * 280, w: 260, createdAt: at(n++) }
    if (i % 3 !== 2) {
      const img = images++
      cards.push({ ...base, kind: "ref", ref: await refImage(root, `perf-${img}.png`, 1000 + img, 1024, 640), source: { title: `study ${img + 1}`, licence: "own work" }, caption: `study ${img + 1}, a hillside at a different hour`, madeBy: img % 2 ? "concept-artist" : "you" })
    } else {
      const note = notes++
      cards.push({
        ...base,
        kind: "note",
        ref: "",
        madeBy: note < 30 ? "you" : "concept-artist",
        text: note < 30 ? `Try this one warmer, note ${note + 1}` : `Study ${note + 1}: the ridge line reads well; the sky competes with the path. Next: a darker foreground and one figure for scale.`,
      })
    }
  }
  for (const c of cards) await saveCard(root, board, c)
  let edges = 0
  for (let i = 0; edges < 60 && i + 1 < cards.length; i += 2) {
    const a = cards[i]!
    const b = cards[i % COLS === COLS - 1 ? i + COLS : i + 1]
    if (!b) continue
    await saveEdge(root, board, { id: `e_p${String(edges).padStart(3, "0")}`, from: a.id, to: b.id, madeBy: "concept-artist", createdAt: at(n++) })
    edges++
  }
  return { cards: cards.length, images, edges }
}

export const STRIP_SHOT = "shadow_step"
export const STRIP_FRAMES = 6
export const STILL_SHOT = "gate_still"

/**
 * Two shots in river.json and one capture of each, laid out the way core's captureShot writes one
 * (.river/captures/<shot>/<stamp>/ with capture.json listing absolute PNG paths): six frames of one scene with the sun
 * crossing the sky, so the strip reads as a sequence, and a one-frame still.
 */
export async function seedStripCapture(root: string): Promise<void> {
  const manifest = join(root, "river.json")
  const m = JSON.parse(await readFile(manifest, "utf8")) as { shots: { id: string }[] }
  if (!m.shots.some((x) => x.id === STRIP_SHOT)) {
    m.shots.push(
      { id: STRIP_SHOT, scene: "res://arena/arena.tscn", setup: "res://tools/shots/shadow_step.gd", count: STRIP_FRAMES, ticks: 6, note: "Shadow step: he sinks into his shadow and rises ahead" } as { id: string },
      { id: STILL_SHOT, scene: "res://park/gate.tscn", count: 1, note: "The gate at dusk" } as { id: string },
    )
    await writeFile(manifest, JSON.stringify(m, null, 2) + "\n")
  }
  const at = "2026-11-17T09:30:00.000Z"
  const capture = async (shotId: string, frames: Buffer[]) => {
    const out = join(root, ".river", "captures", shotId, at.replace(/:/g, "-"))
    await mkdir(out, { recursive: true })
    const files: string[] = []
    for (const [i, png] of frames.entries()) {
      const file = join(out, `frame_${String(i).padStart(3, "0")}.png`)
      await writeFile(file, png)
      files.push(file)
    }
    await writeFile(join(out, "capture.json"), JSON.stringify({ shotId, rev: "a1b2c3d", at, files }, null, 2))
  }
  const t = (i: number) => i / (STRIP_FRAMES - 1)
  await capture(STRIP_SHOT, Array.from({ length: STRIP_FRAMES }, (_v, i) => scenePng(311, 960, 540, [0.14 + t(i) * 0.72, 0.42 - Math.sin(t(i) * Math.PI) * 0.3])))
  await capture(STILL_SHOT, [scenePng(211, 960, 540)])
}
