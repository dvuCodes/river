import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { afterAll, describe, expect, it } from "vitest"
import { lintConceptScript, renderConcept } from "../src/index"

const DRAW = `extends RefCounted

# A calm sky with a low hill.
func draw(img: Image) -> void:
	img.fill(Color("#8fb3c9"))
	img.fill_rect(Rect2i(0, 180, 256, 76), Color(0.35, 0.5, 0.3))
	for x in range(0, 256, 8):
		img.set_pixel(x, 179, Color.WHITE)
`

describe("lintConceptScript", () => {
  it("passes a plain drawing script, CRLF included", () => {
    expect(lintConceptScript(DRAW)).toEqual([])
    expect(lintConceptScript(DRAW.replace(/\n/g, "\r\n"))).toEqual([])
  })

  it("requires extends RefCounted as the first code line and a top-level draw(img: Image)", () => {
    expect(lintConceptScript("@tool\n" + DRAW).join("\n")).toMatch(/extends RefCounted/)
    expect(lintConceptScript(DRAW.replace("extends RefCounted", "extends Node")).join("\n")).toMatch(/extends RefCounted/)
    expect(lintConceptScript(DRAW.replace("func draw(img: Image)", "func paint(img: Image)")).join("\n")).toMatch(/func draw\(img: Image\)/)
    expect(lintConceptScript("")).toHaveLength(2)
  })

  it("names each token a drawing script has no use for, with its line", () => {
    const cases: [string, string][] = [
      ["static var cache = 1", "static"],
      ["const P = preload(\"res://x.gd\")", "preload"],
      ["var r = load(\"res://x.tres\")", "load("],
      ["\tOS.execute(\"cmd\", [])", "OS."],
      ["\tvar f = FileAccess.open(\"user://x\", FileAccess.WRITE)", "FileAccess"],
      ["\tDirAccess.remove_absolute(\"x\")", "DirAccess"],
      ["\tResourceLoader.exists(\"x\")", "ResourceLoader"],
      ["\tResourceSaver.save(null, \"x\")", "ResourceSaver"],
      ["\tProjectSettings.get_setting(\"x\")", "ProjectSettings"],
      ["\tEngine.get_main_loop()", "Engine."],
      ["\tClassDB.instantiate(\"Node\")", "ClassDB"],
      ["\tJavaScriptBridge.eval(\"1\")", "JavaScriptBridge"],
      ["\tvar h = HTTPRequest.new()", "HTTP"],
      ["\tvar t = Thread.new()", "Thread"],
      ["\tWorkerThreadPool.add_task(f)", "Thread"],
      ["\tvar e = Expression.new()", "Expression"],
      ["\tf.call()", "call("],
      ["\tcall_deferred(\"x\")", "call("],
      ["\tcallv(\"x\", [])", "callv"],
      ["\tset_script(null)", "set_script"],
    ]
    for (const [line, token] of cases) {
      const problems = lintConceptScript(DRAW + line + "\n")
      expect(problems, line).toHaveLength(1)
      expect(problems[0]).toContain(`Line 9: remove "${token}"`)
    }
    expect(lintConceptScript(DRAW.replace("extends RefCounted", 'extends "res://base.gd"')).join("\n")).toContain('remove "extends "')
  })

  it("does not flag words that only contain a token", () => {
    expect(lintConceptScript(DRAW + "\tvar is_static_sky = true\n\tvar reload_count = 0\n\tvar recall = 1\n")).toEqual([])
  })
})

const bin = process.env.GODOT_BIN
const out = mkdtempSync(path.join(tmpdir(), "river-render-"))
afterAll(() => rmSync(out, { recursive: true, force: true, maxRetries: 3 }))

function pngSize(file: string): { width: number; height: number } {
  const bytes = readFileSync(file)
  expect(bytes.subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a")
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) }
}

describe.skipIf(!bin)("renderConcept with real Godot (GODOT_BIN)", { timeout: 60_000 }, () => {
  it("renders draw() to a PNG of the requested size", async () => {
    const png = path.join(out, "a", "render.png")
    await renderConcept({ bin: bin!, script: Buffer.from(DRAW), outPng: png })
    expect(pngSize(png)).toEqual({ width: 256, height: 256 })
    await renderConcept({ bin: bin!, script: DRAW, outPng: path.join(out, "small.png"), width: 64, height: 32 })
    expect(pngSize(path.join(out, "small.png"))).toEqual({ width: 64, height: 32 })
  })

  it("fails on a runtime error, a parse error and a timeout, and writes no PNG", async () => {
    const runtime = DRAW + "\tvar a := [1]\n\tvar b = a[5]\n"
    const png = path.join(out, "bad.png")
    await expect(renderConcept({ bin: bin!, script: runtime, outPng: png })).rejects.toThrow(/script raised an error[\s\S]*Out of bounds/)
    await expect(renderConcept({ bin: bin!, script: DRAW + "\timg.fill(\n", outPng: png })).rejects.toThrow(/exited with code[\s\S]*Parse Error/)
    const started = Date.now()
    await expect(renderConcept({ bin: bin!, script: DRAW + "\twhile true:\n\t\tpass\n", outPng: png, timeoutMs: 3000 })).rejects.toThrow(/timed out after 3000 ms/)
    expect(Date.now() - started).toBeLessThan(15_000)
    expect(existsSync(png)).toBe(false)
  })
})
