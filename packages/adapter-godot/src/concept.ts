/**
 * Concept art as a Godot script: `concepts/<id>/draw.gd` is `extends RefCounted` with
 * `func draw(img: Image) -> void`. River renders it headless in a throwaway sandbox project.
 *
 * Nothing here may run Godot on a script the user has not approved: even `--check-only` runs
 * static initialisers. `lintConceptScript` is plain text matching that tells the agent what to
 * rewrite; it is not a security boundary. The boundary is the user's approval of the exact bytes
 * that `renderConcept` is given, and `conceptScriptBytesProblem` keeps those bytes readable as shown.
 */
import { execFile, spawn } from "node:child_process"
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"

/** Tokens a drawing script has no use for, each with a regex that finds it. */
const FORBIDDEN: readonly [token: string, find: RegExp][] = [
  ["static", /\bstatic\b/],
  ["preload", /\bpreload\b/],
  ["load(", /\bload\s*\(/],
  ['extends "', /\bextends\s+["']/],
  ["OS.", /\bOS\s*\./],
  ["FileAccess", /\bFileAccess\b/],
  ["DirAccess", /\bDirAccess\b/],
  ["ResourceLoader", /\bResourceLoader\b/],
  ["ResourceSaver", /\bResourceSaver\b/],
  ["ProjectSettings", /\bProjectSettings\b/],
  ["Engine.", /\bEngine\s*\./],
  ["ClassDB", /\bClassDB\b/],
  ["JavaScriptBridge", /\bJavaScriptBridge\b/],
  ["HTTP", /HTTP/],
  ["Thread", /Thread/],
  ["Expression", /\bExpression\b/],
  ["call(", /\bcall(_deferred)?\s*\(/],
  ["callv", /\bcallv\b/],
  ["set_script", /\bset_script\b/],
  ["GDScript", /\bGDScript\b/],
  ["Script", /\bScript\b/],
  ["source_code", /\bsource_code\b/],
  ["reload(", /\breload\s*\(/],
  // Class names start upper case (FastNoiseLite.new() is fine); a lower-case name is a value, such as a script built at runtime.
  [".new() on a variable", /\b[a-z_]\w*\s*\.\s*new\s*\(/],
  ["str_to_var", /\bstr_to_var\b/],
  ["str2var", /\bstr2var\b/],
  ["bytes_to_var", /\bbytes_to_var/],
  ["bytes2var", /\bbytes2var\b/],
  ["dict_to_inst", /\bdict_to_inst\b/],
  ["dict2inst", /\bdict2inst\b/],
  ["instance_from_id", /\binstance_from_id\b/],
  ["get_class", /\bget_class\b/],
]

/**
 * The rule on draw.gd's bytes, checked before River writes, commits, shows or runs it: printable
 * ASCII, tabs and LF line ends only. Then the text a person reads is exactly what Godot runs; an
 * escape code, a lone CR or a bidi control cannot hide or reorder code. Returns where it breaks, or
 * undefined when the bytes pass.
 */
export function conceptScriptBytesProblem(bytes: Uint8Array): string | undefined {
  let line = 1
  let column = 1
  for (const b of bytes) {
    if (b === 0x0a) {
      line++
      column = 1
      continue
    }
    if (b !== 0x09 && (b < 0x20 || b > 0x7e)) {
      const hex = b.toString(16).toUpperCase().padStart(2, "0")
      return `Line ${line}, column ${column}: byte 0x${hex} is not allowed. draw.gd may hold only printable ASCII, tabs and LF line ends (no CR, control or non-ASCII characters, in comments and strings too).`
    }
    column++
  }
  return undefined
}

/** Problems that make the agent rewrite draw.gd, one sentence each. Empty means the text passes. */
export function lintConceptScript(text: string): string[] {
  const lines = text.split(/\r?\n/)
  const problems: string[] = []
  const firstCode = lines.find((l) => l.trim() !== "" && !l.trim().startsWith("#"))
  if (firstCode?.trim() !== "extends RefCounted") problems.push('The first line of code must be exactly "extends RefCounted".')
  if (!lines.some((l) => /^func\s+draw\s*\(\s*img\s*:\s*Image\s*\)/.test(l))) {
    problems.push("Define func draw(img: Image) -> void at the top level.")
  }
  for (const [token, find] of FORBIDDEN) {
    const at = lines.findIndex((l) => find.test(l))
    if (at !== -1) {
      problems.push(`Line ${at + 1}: remove "${token}". A concept script only draws on the Image it is given (fill, set_pixel, fill_rect, blend_rect); this check reads comments and strings too.`)
    }
  }
  return problems
}

const PROJECT = `config_version=5

[application]
config/name="river-concept"

[debug]
file_logging/enable_file_logging=false
file_logging/enable_file_logging.pc=false
`

const RUNNER = `extends SceneTree

func _initialize() -> void:
	quit(_render())

func _render() -> int:
	var args := {}
	for a in OS.get_cmdline_user_args():
		var kv := a.trim_prefix("--").split("=", true, 1)
		if kv.size() == 2:
			args[kv[0]] = kv[1]
	var script := load("res://concept.gd") as GDScript
	if script == null or not script.can_instantiate():
		printerr("river: concept.gd does not compile")
		return 2
	var concept = script.new()
	if not concept.has_method("draw"):
		printerr("river: concept.gd has no draw(img: Image)")
		return 3
	var img := Image.create(int(args.get("w", "256")), int(args.get("h", "256")), false, Image.FORMAT_RGBA8)
	concept.draw(img)
	var err := img.save_png(args.get("out", ""))
	if err != OK:
		printerr("river: save_png failed with error %d" % err)
		return 4
	return 0
`

export interface RenderConceptRequest {
  /** Godot executable. */
  bin: string
  /** The approved bytes, written to the sandbox unchanged. */
  script: Buffer | string
  /** Where the PNG goes. Written only when the render succeeded. */
  outPng: string
  /** Default 256. */
  width?: number
  /** Default 256. */
  height?: number
  /** Default 30 s. */
  timeoutMs?: number
}

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
const MAX_OUTPUT = 64 * 1024

async function pngSize(file: string): Promise<{ width: number; height: number } | undefined> {
  const bytes = await readFile(file).catch(() => undefined)
  if (!bytes || bytes.length < 24 || !bytes.subarray(0, 8).equals(PNG_SIGNATURE)) return undefined
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) }
}

/** Kill Godot and anything it started (the Windows console build runs the engine as a child). */
function killTree(pid: number): void {
  if (process.platform === "win32") execFile("taskkill", ["/pid", String(pid), "/T", "/F"], { windowsHide: true }, () => {})
  else {
    try {
      process.kill(pid, "SIGKILL")
    } catch {
      // already gone
    }
  }
}

function runGodot(bin: string, args: string[], timeoutMs: number): Promise<{ code: number | null; output: string; timedOut: boolean }> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { stdio: ["ignore", "pipe", "pipe"], windowsHide: true })
    let output = ""
    const collect = (d: Buffer) => {
      output = (output + d.toString("utf8")).slice(-MAX_OUTPUT)
    }
    child.stdout.on("data", collect)
    child.stderr.on("data", collect)
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      if (child.pid !== undefined) killTree(child.pid)
    }, timeoutMs)
    child.once("error", (err) => {
      clearTimeout(timer)
      reject(new Error(`river: could not start Godot (${bin}): ${err.message}`))
    })
    child.once("close", (code) => {
      clearTimeout(timer)
      resolve({ code, output, timedOut })
    })
  })
}

const tail = (text: string, lines = 30) => text.trim().split(/\r?\n/).slice(-lines).join("\n")

/**
 * Render a concept script to a PNG in a fresh temp sandbox project: River's runner loads the
 * script, calls draw() on a blank RGBA8 image and saves it. Throws with Godot's output on any
 * failure, including a runtime script error (Godot reports those but still exits 0).
 */
export async function renderConcept(req: RenderConceptRequest): Promise<void> {
  const unreadable = conceptScriptBytesProblem(Buffer.from(req.script))
  if (unreadable) throw new Error(`river: refused to render: ${unreadable}`)
  const width = req.width ?? 256
  const height = req.height ?? 256
  const timeoutMs = req.timeoutMs ?? 30_000
  const sandbox = await mkdtemp(path.join(tmpdir(), "river-concept-"))
  try {
    await writeFile(path.join(sandbox, "project.godot"), PROJECT)
    await writeFile(path.join(sandbox, "runner.gd"), RUNNER)
    await writeFile(path.join(sandbox, "concept.gd"), req.script)
    const png = path.join(sandbox, "render.png")
    const args = ["--headless", "--path", sandbox, "-s", "res://runner.gd", "--", `--out=${png.replace(/\\/g, "/")}`, `--w=${width}`, `--h=${height}`]
    const { code, output, timedOut } = await runGodot(req.bin, args, timeoutMs)
    const size = await pngSize(png)
    const problem = timedOut
      ? `timed out after ${timeoutMs} ms`
      : code !== 0
        ? `Godot exited with code ${String(code)}`
        : /SCRIPT ERROR/.test(output)
          ? "the script raised an error"
          : !size || size.width !== width || size.height !== height
            ? `no ${width}x${height} PNG was written`
            : undefined
    if (problem) throw new Error(`river: concept render failed: ${problem}\n${tail(output)}`)
    await mkdir(path.dirname(req.outPng), { recursive: true })
    await copyFile(png, req.outPng)
  } finally {
    await rm(sandbox, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
}
