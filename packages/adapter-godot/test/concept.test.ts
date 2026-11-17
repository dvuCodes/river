import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { afterAll, describe, expect, it } from "vitest"
import { conceptScriptProblem, lintConceptScript, linesToRead, renderConcept } from "../src/index"

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
      ["var r = load(\"res://x.tres\")", "load"],
      ["\tvar i = Image.load_from_file(\"C:/x.png\")", "load"],
      ["\timg.load_png_from_buffer(PackedByteArray())", "load"],
      ["\timg.save_png(\"C:/x.png\")", "save"],
      ["\timg.save_exr(\"C:/x.exr\")", "save"],
      ["\tvar f = img.save_webp", "save"],
      ["\tvar c := Callable(img, \"fill\")", "Callable"],
      ["\tOS.execute(\"cmd\", [])", "OS."],
      ["\tvar f = FileAccess.open(\"user://x\", FileAccess.WRITE)", "FileAccess"],
      ["\tDirAccess.remove_absolute(\"x\")", "DirAccess"],
      ["\tResourceLoader.exists(\"x\")", "ResourceLoader"],
      ["\tResourceSaver.get_recognized_extensions(null)", "ResourceSaver"],
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
    expect(lintConceptScript(DRAW + "\tvar is_static_sky = true\n\tvar reload_count = 0\n\tvar recall = 1\n\tvar saved = 1\n\tvar unloaded = 0\n")).toEqual([])
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

/** Scripts from the PR review that each give a name of their own the name Kit, so a line that reads as a Kit call runs the agent's code. */
const kitDisguises = (marker: string): [string, string][] => [
  ["a local var", `${DRAW}\tvar Kit = img\n\tKit.save_png("${marker}")\n`],
  ["a member var", `extends RefCounted\n\nvar Kit\n\nfunc draw(img: Image) -> void:\n\timg.fill(Color.RED)\n\tKit = img\n\tKit.save_png("${marker}")\n`],
  ["a loop variable", `${DRAW}\tfor Kit in [img]:\n\t\tKit.save_png("${marker}")\n`],
  ["a const", `${DRAW}\tvar n := 1\n\nconst Kit = 3\n`],
  ["an enum", `${DRAW}\tvar n := 1\n\nenum Kit { A }\n`],
]

describe("the name Kit", () => {
  const kitProblem = (text: string) => lintConceptScript(text).find((p) => p.includes("Kit"))

  it("refuses the review's disguises, and every other declaration or binding named Kit, in any case", () => {
    for (const [name, script] of kitDisguises("C:/x.png")) expect(kitProblem(script), name).toMatch(/^Line \d+: /)
    const cases: [string, string][] = [
      ["a parameter", "\nfunc paint(Kit: Image) -> void:\n\tpass\n"],
      ["a signal parameter", "\nsignal moved(Kit)\n"],
      ["an inner class", "\nclass Kit:\n\tvar a := 1\n"],
      ["a match binding", "\tmatch 1:\n\t\tvar Kit:\n\t\t\tpass\n"],
      ["a lambda parameter", "\tvar f := func(Kit): return 1\n"],
      ["a lower-case local", "\tvar kit = img\n"],
      ["an upper-case local", "\tvar KIT = img\n"],
      ["a member of something else", "\tvar d := {}\n\td.Kit.rect(img, Rect2i(0, 0, 1, 1), Color.RED)\n"],
      ["space before the dot", "\tKit .rect(img, Rect2i(0, 0, 1, 1), Color.RED)\n"],
      ["a line continuation", "\tKit.\\\n\t\trect(img, Rect2i(0, 0, 1, 1), Color.RED)\n"],
      ["an Image method", '\tKit.save_png("C:/x.png")\n'],
      ["a private Kit helper", "\tvar h = Kit._hash(1, 2, 3)\n"],
      ["a Kit function not called", "\tvar e = Kit.ellipse\n"],
      ["a comment", "\t# Kit draws the sky\n"],
      ["a string", '\tprint("Kit")\n'],
    ]
    for (const [name, text] of cases) expect(kitProblem(DRAW + text), name).toMatch(/^Line (9|10): /)
  })

  it("passes Kit calls written Kit.name(...), and names that only contain the word", () => {
    expect(lintConceptScript(DRAW + "\tKit.rect(img, Rect2i(0, 0, 4, 4), Color.RED)\n\tvar l := Kit.image(4, 4)\n\tvar kit_size := 4\n\tvar toolkit := 1\n")).toEqual([])
  })

  it("refuses before Godot starts: no process is launched for such a script", async () => {
    const [, script] = kitDisguises("C:/x.png")[0]!
    const png = path.join(out, "never.png")
    await expect(renderConcept({ bin: path.join(out, "no-such-godot.exe"), script, outPng: png })).rejects.toThrow(/refused to render: Line 9: [\s\S]*Kit/)
    expect(existsSync(png)).toBe(false)
  })
})

/**
 * Scripts from the second PR review that pass every refusal and, in real Godot, wrote a file. The text rules
 * cannot prove what GDScript does, so River does not claim they do: the user's approval of the exact bytes is
 * the gate (see "a script the refusals miss" in the agent's jobs tests).
 */
const MISSED: [string, string][] = [
  [
    "a comment between a member dot and Kit",
    `extends RefCounted

class Brush:
	var canvas: Image
	func glow(a, b, c, d) -> void:
		["C:/x.png"].map(canvas.get("sa" + "ve_png"))

func draw(img: Image) -> void:
	var tools = {}
	tools["K" + "it"] = Brush.new()
	tools.values()[0].canvas = img
	Kit.vgradient(img, Rect2i(0, 0, 256, 256), Color.BLUE, Color.ORANGE)
	var sun = [tools.  # the sun
		Kit.glow(img, Vector2(180, 60), 40.0, Color.YELLOW)]
`,
  ],
  [
    "OS through a variable, and save_png by a built name",
    `extends RefCounted

func draw(img: Image) -> void:
	img.fill(Color.RED)
	var o = OS
	o.execute("cmd", ["/c", "echo"])
	["C:/x.png"].map(img.get("sa" + "ve_png"))
`,
  ],
]

describe("what the refusals do not catch", () => {
  it("passes the review's bypasses: the byte rule, the Kit rule and the lint are a refusal list, not a proof", () => {
    for (const [name, script] of MISSED) {
      expect(conceptScriptProblem(Buffer.from(script)), name).toBeUndefined()
      expect(lintConceptScript(script), name).toEqual([])
    }
  })
})

describe("linesToRead", () => {
  const marked = (text: string) => linesToRead(text).map((l) => l.line)

  it("marks the bypasses' lines that reach past the image", () => {
    const [split, alias] = MISSED.map(([, s]) => linesToRead(s))
    expect(split!.map((l) => l.line)).toEqual([3, 6, 10, 11, 13])
    expect(split!.find((l) => l.line === 13)!.reason).toBe("continues on the next line")
    expect(alias!.map((l) => [l.line, l.reason])).toEqual([
      [5, "uses OS"],
      [6, "uses execute"],
      [7, "uses map, get"],
    ])
  })

  it("leaves a drawing made of Kit calls, the Image API, math and its own names unmarked", () => {
    const park = `${DRAW}	var w := img.get_width()
	var ink := Color("#1b1626")
	var r := Kit.rng(7)
	Kit.vgradient(img, Rect2i(0, 0, w, 180), Color("#2e2a5c"), Color.ORANGE) # sky
	for i in range(4):
		Kit.ellipse(img, Vector2(40 + i * 60, r.randf_range(50, 90)), Vector2(46, 4), Color("#e88a7a", 0.45))
	Kit.polygon(img, [Vector2(120, 186), Vector2(150, 186),
		Vector2(230, 256), Vector2(40, 256)], ink.lightened(0.2))
	Kit.person(img, Vector2(118, 236), 46, ink)
	Kit.stamp(img, [".a.", "aba"], {"a": "#3d7a4a", "b": Color.BROWN}, Vector2i(60, 2), 4)
	img.set_pixel(clampi(w - 1, 0, 255), 0, Color(1, 1, 1).lerp(Color.RED, 0.5))
	var fog := 1e-3 * sin(PI / 4.0)
`
    expect(linesToRead(park)).toEqual([])
  })

  it("marks other names, members outside the Image API and the Kit, and a string that does not close", () => {
    expect(marked(`${DRAW}\tvar d = self.get("x")\n`)).toEqual([9])
    expect(marked(`${DRAW}\tKit.no_such(img)\n`)).toEqual([9])
    expect(marked(`${DRAW}\tvar t = Time.get_ticks_msec()\n`)).toEqual([9])
    expect(marked(`${DRAW}\tvar s = "a\n\timg.fill(Color.RED)\n`)).toEqual([9])
    expect(marked(`@tool\n${DRAW}`)).toEqual([1])
    expect(marked(`${DRAW}\tvar s = """\nOS\n"""\n`)).toEqual([])
  })
})

describe("conceptScriptProblem", () => {
  it("passes printable ASCII with tabs and LF line ends", () => {
    expect(conceptScriptProblem(Buffer.from(DRAW))).toBeUndefined()
  })

  it("refuses CR, escape codes, other control bytes and anything not ASCII, with where it is", () => {
    const at = (text: string) => conceptScriptProblem(Buffer.from(DRAW + text, "utf8"))
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

  it("runs no script that takes the name Kit: the review's disguises write nothing and render nothing", async () => {
    const marker = path.join(out, "kit-marker.png").split(path.sep).join("/")
    for (const [name, script] of kitDisguises(marker)) {
      const png = path.join(out, "kit-disguise.png")
      await expect(renderConcept({ bin: bin!, script, outPng: png }), name).rejects.toThrow(/refused to render: Line \d+: [\s\S]*Kit/)
      expect(existsSync(marker), name).toBe(false)
      expect(existsSync(png), name).toBe(false)
    }
  })

  it("renders a script that infers a type from a Variant, which Godot's default settings treat as an error", async () => {
    const png = path.join(out, "variant.png")
    const script = "extends RefCounted\n\nfunc draw(img: Image) -> void:\n\tvar t := clamp(0.5, 0.0, 1.0)\n\timg.fill(Color.RED.lerp(Color.BLUE, t))\n"
    await renderConcept({ bin: bin!, script, outPng: png })
    expect(readFileSync(png).length).toBeGreaterThan(0)
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
