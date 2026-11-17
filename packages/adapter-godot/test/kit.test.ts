import { createHash } from "node:crypto"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { afterAll, describe, expect, it } from "vitest"
import { conceptScriptProblem, KIT_API, lintConceptScript, renderConcept } from "../src/index"
import { KIT_GD } from "../src/kit"

const script = (body: string[]) => ["extends RefCounted", "", "func draw(img: Image) -> void:", ...body.map((l) => `\t${l}`), ""].join("\n")

const PARK = `extends RefCounted

# A park at dusk: a walker and a dog on the path under a lamp.
func draw(img: Image) -> void:
	var w := img.get_width()
	var h := img.get_height()
	var ink := Color("#1b1626")
	Kit.vgradient(img, Rect2i(0, 0, w, 180), Color("#2e2a5c"), Color("#f4a86a"))
	Kit.scatter(img, Rect2i(0, 0, w, 70), 30, Color(1, 1, 1, 0.7), 4)
	Kit.glow(img, Vector2(170, 150), 120, Color(1.0, 0.55, 0.3, 0.8))
	Kit.circle(img, Vector2(170, 150), 16, Color("#ffe2a8"))
	for i in range(4):
		Kit.ellipse(img, Vector2(40 + i * 60, 60 + i * 18), Vector2(46, 4), Color("#e88a7a", 0.45))
	Kit.ridge(img, 150, 30, Color("#7a5a86"), 2, 0.015)
	Kit.ridge(img, 170, 28, Color("#4a3a66"), 9, 0.03)
	Kit.vgradient(img, Rect2i(0, 186, w, h - 186), Color("#3a3354"), Color("#1d1a2e"))
	Kit.polygon(img, [Vector2(120, 186), Vector2(150, 186), Vector2(230, h), Vector2(40, h)], Color("#e88a7a", 0.5))
	for x in [14, 60, 214, 246]:
		Kit.tree(img, Vector2(x, 196), 70 + x % 30, ink)
	Kit.line(img, Vector2(196, 240), Vector2(196, 150), 3.0, ink)
	Kit.glow(img, Vector2(196, 148), 40, Color(1.0, 0.85, 0.5))
	Kit.circle(img, Vector2(196, 148), 4, Color("#fff4cc"))
	Kit.person(img, Vector2(118, 236), 46, ink)
	Kit.dog(img, Vector2(150, 236), 18, ink)
	Kit.line(img, Vector2(124, 214), Vector2(155, 224), 1.0, ink)
	Kit.scatter(img, Rect2i(0, 190, w, 50), 18, Color(1.0, 0.9, 0.5, 0.8), 11, 2.0)
	Kit.quantize(img, ["#1b1626", "#2e2a5c", "#4a3a66", "#7a5a86", "#c98a6e", "#e88a7a", "#f4a86a", "#ffe2a8", "#fff4cc", "#3a3354"], 0.3)
`

/** Each Kit function drawn on its own: `setup` runs in both renders, `call` only in the second, so a no-op shows up. */
const CASES: Record<string, { setup?: string[]; call: string[] }> = {
  rng: { call: ["var r := Kit.rng(5)", "img.set_pixel(r.randi_range(0, 63), r.randi_range(0, 63), Color.WHITE)"] },
  image: { call: ["var l := Kit.image(8, 8)", "l.fill(Color.RED)", "img.blit_rect(l, Rect2i(0, 0, 8, 8), Vector2i(4, 4))"] },
  dot: { call: ["Kit.dot(img, 3, 3, Color(1, 0, 0, 0.5))", "Kit.dot(img, -1, 99, Color.RED)"] },
  rect: { call: ["Kit.rect(img, Rect2i(-4, 10, 30, 20), Color(0.2, 0.4, 0.8, 0.6))"] },
  vgradient: { call: ["Kit.vgradient(img, Rect2i(0, 0, 64, 64), Color.NAVY_BLUE, Color.ORANGE, 4)"] },
  radial: { call: ["Kit.radial(img, Vector2(32, 32), 20, Color.YELLOW, Color(Color.YELLOW, 0))"] },
  glow: { setup: ["img.fill(Color(0.1, 0.1, 0.2))"], call: ["Kit.glow(img, Vector2(32, 32), 24, Color(1, 0.7, 0.3))"] },
  ellipse: { call: ["Kit.ellipse(img, Vector2(32, 32), Vector2(20, 9), Color.SEA_GREEN)"] },
  circle: { call: ["Kit.circle(img, Vector2(60, 4), 12, Color.TOMATO)"] },
  line: { call: ["Kit.line(img, Vector2(2, 60), Vector2(70, 3), 3.5, Color.WHEAT)"] },
  polygon: { call: ["Kit.polygon(img, [Vector2(4, 60), Vector2(32, 4), Vector2(60, 60)], Color.OLIVE)"] },
  noise: { call: ["for y in range(64):", "\tfor x in range(64):", "\t\timg.set_pixel(x, y, Color(1, 1, 1, Kit.noise(x * 0.1, y * 0.1, 3, 3)))"] },
  ridge: { call: ["Kit.ridge(img, 50, 20, Color.DIM_GRAY, 2)"] },
  scatter: { call: ["Kit.scatter(img, Rect2i(0, 0, 64, 64), 20, Color.WHITE, 9)", "Kit.scatter(img, Rect2i(0, 0, 64, 64), 5, Color.GOLD, 2, 4.0)"] },
  paste: { setup: ["var l := Kit.image(16, 16)", "l.fill(Color(0, 1, 0, 0.5))"], call: ["Kit.paste(img, l, Vector2i(56, 56))"] },
  outline: { setup: ["var l := Kit.image(64, 64)", "Kit.circle(l, Vector2(32, 32), 10, Color.WHITE)"], call: ["Kit.outline(l, Color.BLACK)", "Kit.paste(img, l)"] },
  shadow: { setup: ["var l := Kit.image(64, 64)", "Kit.circle(l, Vector2(32, 32), 10, Color.WHITE)"], call: ["Kit.shadow(l, Color(0, 0, 0, 0.5), Vector2i(3, 2))", "Kit.paste(img, l)"] },
  stamp: { call: ['Kit.stamp(img, [".a.", "aba"], {"a": "#3d7a4a", "b": Color.BROWN}, Vector2i(60, 2), 4)'] },
  upscale: { call: ["var s := Kit.image(4, 4)", "s.set_pixel(1, 2, Color.RED)", "Kit.upscale(img, s)"] },
  quantize: { setup: ["Kit.vgradient(img, Rect2i(0, 0, 64, 64), Color.BLACK, Color.WHITE)"], call: ['Kit.quantize(img, ["#000000", Color.GRAY, "#ffffff"], 0.5)'] },
  person: { call: ["Kit.person(img, Vector2(20, 62), 40, Color.BLACK)"] },
  dog: { call: ["Kit.dog(img, Vector2(40, 62), 20, Color.BLACK, -1.0)"] },
  tree: { call: ["Kit.tree(img, Vector2(32, 63), 50, Color.DARK_GREEN)"] },
}

const kitNames = [...KIT_API.matchAll(/^Kit\.(\w+)\(/gm)].map((m) => m[1]!)

describe("Kit API", () => {
  it("lists every public Kit function with its doc line, and the per-function cases cover each one", () => {
    expect(kitNames).toEqual([...KIT_GD.matchAll(/^static func ([a-z]\w*)\(/gm)].map((m) => m[1]))
    expect(KIT_API.split("\n").every((l) => / {2}# \S/.test(l))).toBe(true)
    expect(Object.keys(CASES).sort()).toEqual([...kitNames].sort())
  })

  it("lets agent scripts call every Kit function through the lint and the byte rule", () => {
    for (const [name, c] of Object.entries(CASES)) expect(lintConceptScript(script([...(c.setup ?? []), ...c.call])), name).toEqual([])
    expect(lintConceptScript(PARK)).toEqual([])
    expect(conceptScriptProblem(Buffer.from(PARK))).toBeUndefined()
  })

  it("keeps the sample scene within the 40 lines the prompt asks for", () => {
    expect(PARK.trimEnd().split("\n").length).toBeLessThanOrEqual(40)
  })

  it("holds the Kit to River's review, not the agent lint: the Kit itself uses static, which agent scripts may not", () => {
    expect(lintConceptScript(KIT_GD).join("\n")).toContain('remove "static"')
  })
})

const bin = process.env.GODOT_BIN
const out = mkdtempSync(path.join(tmpdir(), "river-kit-"))
afterAll(() => rmSync(out, { recursive: true, force: true, maxRetries: 3 }))

let renders = 0
async function renderHash(text: string, size = 64): Promise<string> {
  const png = path.join(out, `r${renders++}.png`)
  await renderConcept({ bin: bin!, script: text, outPng: png, width: size, height: size })
  return createHash("sha256").update(readFileSync(png)).digest("hex")
}

async function pool<T, R>(items: T[], width: number, run: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length)
  let next = 0
  await Promise.all(
    Array.from({ length: width }, async () => {
      while (next < items.length) {
        const i = next++
        results[i] = await run(items[i]!)
      }
    }),
  )
  return results
}

describe.skipIf(!bin)("Kit in the render sandbox with real Godot (GODOT_BIN)", { timeout: 60_000 }, () => {
  it("draws each function's output, the same bytes in two separate Godot runs", async () => {
    const names = Object.keys(CASES)
    const hashes = await pool(names, 4, async (name) => {
      const { setup = [], call } = CASES[name]!
      const withCall = script([...setup, ...call])
      return { name, base: await renderHash(script([...setup, "pass"])), first: await renderHash(withCall), second: await renderHash(withCall) }
    })
    for (const h of hashes) {
      expect(h.first, `${h.name} renders the same twice`).toBe(h.second)
      expect(h.first, `${h.name} changes the picture`).not.toBe(h.base)
    }
  })

  it("renders the sample scene at 256px, deterministically", async () => {
    const [a, b] = await Promise.all([renderHash(PARK, 256), renderHash(PARK, 256)])
    expect(a).toBe(b)
  })

  it("still refuses an agent script whose bytes break the rule, Kit calls or not", async () => {
    const bad = script(["Kit.circle(img, Vector2(8, 8), 4, Color.RED) # \u001b[2K"])
    await expect(renderConcept({ bin: bin!, script: Buffer.from(bad), outPng: path.join(out, "bad.png") })).rejects.toThrow(/Line 4, column \d+/)
  })
})
