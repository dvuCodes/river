import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { afterAll, describe, expect, it } from "vitest"
import { conceptScriptBytesProblem, lintConceptScript, renderConcept } from "../src/index"

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

  it("names the ways to build and run a script at runtime, and reflection", () => {
    const cases: [string, string][] = [
      ["\tvar s := GDScript.new()", "GDScript"],
      ["\tvar s: Script = null", "Script"],
      ['\ts.source_code = "extends RefCounted"', "source_code"],
      ["\ts.reload()", "reload("],
      ["\ts.new().run()", ".new() on a variable"],
      ["\tvar v = str_to_var(t)", "str_to_var"],
      ["\tvar v = str2var(t)", "str2var"],
      ["\tvar v = bytes_to_var_with_objects(b)", "bytes_to_var"],
      ["\tvar v = bytes2var(b)", "bytes2var"],
      ["\tvar o = dict_to_inst(d)", "dict_to_inst"],
      ["\tvar o = dict2inst(d)", "dict2inst"],
      ["\tvar o = instance_from_id(1)", "instance_from_id"],
      ["\tprint(img.get_class())", "get_class"],
    ]
    for (const [line, token] of cases) {
      const problems = lintConceptScript(DRAW + line + "\n")
      expect(problems, line).toHaveLength(1)
      expect(problems[0]).toContain(`Line 9: remove "${token}"`)
    }
    expect(lintConceptScript(DRAW + "\tvar noise := FastNoiseLite.new()\n\tvar rng := RandomNumberGenerator.new()\n")).toEqual([])
  })
})

describe("conceptScriptBytesProblem", () => {
  it("passes printable ASCII with tabs and LF line ends", () => {
    expect(conceptScriptBytesProblem(Buffer.from(DRAW))).toBeUndefined()
  })

  it("refuses CR, escape codes, other control bytes and anything not ASCII, with where it is", () => {
    const at = (text: string) => conceptScriptBytesProblem(Buffer.from(DRAW + text, "utf8"))
    for (const text of ["\t# a\r\n", "\tpass # \u001b[2K\u001b[1G\n", "\tpass # ‮ x\n", "\tpass # \u0000\n", "\tpass # \u007f\n", "\t# dusk — calm\n", "\t# 20°\n"]) {
      expect(at(text), JSON.stringify(text)).toMatch(/^Line 9, column \d+: /)
    }
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

  it("runs nothing whose bytes a person could not read as shown: escape codes hiding a script that writes a file", async () => {
    const marker = path.join(out, "marker.txt").split(path.sep).join("/")
    const hide = " # \u001b[2K\u001b[1G"
    const script = [
      "extends RefCounted",
      "",
      "func draw(img: Image) -> void:",
      "\timg.fill(Color(0.2, 0.3, 0.4))",
      `\tvar s := GDScript.new()${hide}`,
      `\ts.source_code = "extends RefCounted\\nfunc run():\\n\\tvar f = Fi" + "leAccess.open('${marker}', 2)\\n\\tf.store_string('ran')\\n\\tf.close()\\n"${hide}`,
      `\ts.reload()${hide}`,
      `\ts.new().run()${hide}`,
      "",
    ].join("\n")
    const png = path.join(out, "hidden.png")
    await expect(renderConcept({ bin: bin!, script: Buffer.from(script), outPng: png })).rejects.toThrow(/Line 5, column \d+/)
    expect(existsSync(marker)).toBe(false)
    expect(existsSync(png)).toBe(false)
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
