import { readFile } from "node:fs/promises"
import { createInterface } from "node:readline"
import { basename, resolve } from "node:path"
import { parseArgs } from "node:util"
import {
  contentPassages,
  createPlaytest,
  exportStory,
  formatCond,
  lint,
  listStories,
  loadProject,
  loadSchema,
  loadStory,
  parseTwineHtml,
  passageById,
  paths,
  proseText,
  safePath,
  saveStory,
  slug,
} from "@river/core"
import type { Diagnostic, Project, StateSchema, Story } from "@river/core"
import { mkdir, writeFile } from "node:fs/promises"
import { existsSync } from "node:fs"

export interface RunIo {
  /** Where normal output goes. Default: process.stdout. */
  stdout?: NodeJS.WritableStream & { isTTY?: boolean }
  /** Where errors go. Default: process.stderr. */
  stderr?: NodeJS.WritableStream
  /** Input for `play`. Default: process.stdin. */
  stdin?: NodeJS.ReadableStream
  /** Working directory used when no project dir is given. Default: process.cwd(). */
  cwd?: string
}

const HELP = `river <command> [projectDir] [options]

Commands:
  lint [dir] [--story rel]                 check stories for broken links, dead ends, never-true conditions
  paths [dir] [--story rel]                list every route from the start
  play [dir] [--story rel] [--from name]   play a story as text
  export [dir]                             write <export>/<story>.json for each story
  import-twine <file.html> [dir] [--force] import a Twine 2 archive or published story
  capture, shots                           not implemented in this build
`

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`

class Out {
  constructor(private stream: NodeJS.WritableStream) {}
  line(s = "") { this.stream.write(s + "\n") }
  write(s: string) { this.stream.write(s) }
}

async function openProject(dir: string): Promise<{ project: Project; schema: StateSchema }> {
  const project = await loadProject(dir)
  const schema = await loadSchema(project)
  return { project, schema }
}

async function storyFiles(project: Project, story: string | undefined): Promise<string[]> {
  if (story) return [story.replace(/\\/g, "/")]
  return listStories(project)
}

function formatDiag(d: Diagnostic): string {
  return `${d.severity.padEnd(6)} ${d.message}`
}

/** Run the CLI. Resolves to the process exit code. */
export async function run(argv: string[], io: RunIo = {}): Promise<number> {
  const out = new Out(io.stdout ?? process.stdout)
  const err = new Out(io.stderr ?? process.stderr)
  const cwd = io.cwd ?? process.cwd()

  let parsed
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      strict: true,
      options: {
        story: { type: "string" },
        from: { type: "string" },
        force: { type: "boolean" },
        help: { type: "boolean", short: "h" },
      },
    })
  } catch (e) {
    err.line(`river: ${(e as Error).message}`)
    return 2
  }
  const { values, positionals } = parsed
  const [cmd, ...rest] = positionals
  if (!cmd || values.help || cmd === "help") {
    out.write(HELP)
    return cmd || values.help ? 0 : 2
  }

  try {
    switch (cmd) {
      case "lint": return await cmdLint(resolve(cwd, rest[0] ?? "."), values.story, out)
      case "paths": return await cmdPaths(resolve(cwd, rest[0] ?? "."), values.story, out)
      case "export": return await cmdExport(resolve(cwd, rest[0] ?? "."), values.story, out, err)
      case "play": return await cmdPlay(resolve(cwd, rest[0] ?? "."), values.story, values.from, io, out)
      case "import-twine": {
        if (!rest[0]) { err.line("river import-twine: missing <file.html>"); return 2 }
        return await cmdImport(resolve(cwd, rest[0]), resolve(cwd, rest[1] ?? "."), values.force ?? false, out, err)
      }
      case "capture":
      case "shots":
        out.line(`river ${cmd}: not implemented in this build`)
        return 1
      default:
        err.line(`river: unknown command "${cmd}"`)
        out.write(HELP)
        return 2
    }
  } catch (e) {
    err.line(`river ${cmd}: ${(e as Error).message}`)
    return 1
  }
}

async function cmdLint(dir: string, storyOpt: string | undefined, out: Out): Promise<number> {
  const { project, schema } = await openProject(dir)
  const files = await storyFiles(project, storyOpt)
  let errors = 0, warnings = 0, infos = 0, passages = 0
  for (const rel of files) {
    const { story, diagnostics } = await loadStory(project, rel)
    const all = [...diagnostics, ...lint(story, schema)]
    passages += contentPassages(story).length
    if (files.length > 1) out.line(rel)
    for (const d of all) {
      out.line(formatDiag(d))
      if (d.severity === "error") errors++
      else if (d.severity === "warn") warnings++
      else infos++
    }
  }
  let summary = `${plural(errors, "error")}, ${plural(warnings, "warning")}`
  if (infos > 0) summary += `, ${infos} info`
  out.line(`${summary} in ${plural(passages, "passage")}`)
  return errors > 0 ? 1 : 0
}

async function cmdPaths(dir: string, storyOpt: string | undefined, out: Out): Promise<number> {
  const { project, schema } = await openProject(dir)
  const files = await storyFiles(project, storyOpt)
  for (const rel of files) {
    const { story } = await loadStory(project, rel)
    if (files.length > 1) out.line(rel)
    const routes = paths(story, schema)
    const width = String(routes.length).length + 2
    routes.forEach((r, i) => {
      const names = r.steps.map((s) => passageById(story, s.passageId)?.name ?? s.passageId)
      let line = `${String(i + 1).padEnd(width)}${names.join(" → ")}`
      if (r.end === "dead-end") line += " (dead end)"
      if (r.end === "loop") line += " (loop)"
      if (r.conditions.length > 0) line += `   [${r.conditions.map(formatCond).join(" and ")}]`
      if (!r.satisfiable) line += "   never true"
      out.line(line)
    })
    if (routes.length === 0) out.line("no routes (the start passage is missing)")
  }
  return 0
}

async function cmdExport(dir: string, storyOpt: string | undefined, out: Out, err: Out): Promise<number> {
  const { project, schema } = await openProject(dir)
  const files = await storyFiles(project, storyOpt)
  let failed = 0
  for (const rel of files) {
    const { story } = await loadStory(project, rel)
    const stem = basename(rel).replace(/\.(twee|tw)$/i, "")
    try {
      const data = exportStory(story, schema, stem)
      const target = safePath(project, `${project.manifest.export}/${stem}.json`)
      await mkdir(resolve(target, ".."), { recursive: true })
      await writeFile(target, JSON.stringify(data, null, 2) + "\n", "utf8")
      out.line(`wrote ${project.manifest.export}/${stem}.json`)
    } catch (e) {
      failed++
      err.line(`error  ${(e as Error).message}`)
    }
  }
  return failed > 0 ? 1 : 0
}

async function cmdImport(file: string, dir: string, force: boolean, out: Out, err: Out): Promise<number> {
  const project = await loadProject(dir)
  const html = await readFile(file, "utf8")
  const { stories, diagnostics } = parseTwineHtml(html, basename(file))
  for (const d of diagnostics) err.line(formatDiag(d))
  let failed = 0
  for (const story of stories) {
    const rel = `${project.manifest.stories}/${slug(story.title || "story")}.twee`
    if (!force && existsSync(safePath(project, rel))) {
      err.line(`error  ${rel} exists; use --force to replace it`)
      failed++
      continue
    }
    await saveStory(project, rel, { ...story, file: rel } as Story)
    out.line(`wrote ${rel} (${plural(story.passages.length, "passage")})`)
  }
  return failed > 0 || stories.length === 0 ? 1 : 0
}

function parseValue(raw: string, schema: StateSchema, name: string): number | string | boolean {
  const decl = schema[name]
  if (!decl) throw new Error(`unknown variable "${name}"`)
  if (decl.type === "number" || decl.type === "int") {
    const n = Number(raw)
    if (raw.trim() === "" || Number.isNaN(n)) throw new Error(`${name} needs a number`)
    return n
  }
  if (decl.type === "bool") {
    if (raw === "true") return true
    if (raw === "false") return false
    throw new Error(`${name} needs true or false`)
  }
  return raw.replace(/^"|"$/g, "")
}

async function cmdPlay(dir: string, storyOpt: string | undefined, from: string | undefined, io: RunIo, out: Out): Promise<number> {
  const { project, schema } = await openProject(dir)
  const files = await storyFiles(project, storyOpt)
  const rel = files[0]
  if (!rel) throw new Error("no stories found")
  if (files.length > 1 && !storyOpt) out.line(`playing ${rel} (use --story to pick another)`)
  const { story } = await loadStory(project, rel)
  const play = createPlaytest(story, schema, from !== undefined ? { from } : undefined)
  const stdout = io.stdout ?? process.stdout
  const tty = Boolean((stdout as { isTTY?: boolean }).isTTY)
  const dim = (s: string) => (tty ? `\x1b[2m${s}\x1b[22m` : s)

  const render = () => {
    const p = play.current()
    out.line()
    out.line(`== ${p.name} ==`)
    const prose = proseText(p.text)
    if (prose) out.line(prose)
    out.line()
    for (const c of play.choices()) {
      const broken = !story.passages.some((q) => q.name === c.choice.target || q.id === c.choice.target)
      const label = `${c.index + 1}. ${c.choice.label}`
      if (broken) out.line(dim(`  ${label}  (broken link to "${c.choice.target}")`))
      else if (!c.open) out.line(dim(`  ${label}  [${c.choice.when ? formatCond(c.choice.when) : ""}]`))
      else out.line(`  ${label}`)
    }
    if (play.isOver()) out.line(p.isEnding ? "-- the end --  (:undo to go back, :quit to stop)" : "-- no open choices --  (:undo, :quit)")
    out.write("> ")
  }

  const rl = createInterface({ input: io.stdin ?? process.stdin, terminal: false })
  render()
  for await (const raw of rl) {
    const line = raw.trim()
    if (line === "") { out.write("> "); continue }
    try {
      if (line === ":quit" || line === ":q") break
      if (line === ":state") {
        for (const [k, v] of Object.entries(play.state())) out.line(`  ${k} = ${String(v)}`)
        out.write("> ")
        continue
      }
      if (line === ":undo") { play.undo(); render(); continue }
      if (line.startsWith(":set ")) {
        const [, name = "", ...valueParts] = line.split(/\s+/)
        play.setVar(name, parseValue(valueParts.join(" "), schema, name))
        out.line(`  ${name} = ${String(play.state()[name])}`)
        out.write("> ")
        continue
      }
      if (/^\d+$/.test(line)) { play.choose(Number(line) - 1); render(); continue }
      out.line("  type a choice number, :state, :set var value, :undo or :quit")
    } catch (e) {
      out.line(`  ${(e as Error).message}`)
    }
    out.write("> ")
  }
  rl.close()
  out.line()
  return 0
}
