import { existsSync, statSync } from "node:fs"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { createInterface } from "node:readline"
import { basename, join, resolve } from "node:path"
import { parseArgs } from "node:util"
import { createGodotAdapter } from "@river/adapter-godot"
import {
  captureShot,
  choiceTarget,
  contentPassages,
  DEFAULT_BOARD,
  createPlaytest,
  exportStory,
  formatClosed,
  formatCond,
  formatPathList,
  interruptPaths,
  lint,
  listCaptures,
  listStories,
  loadProject,
  loadSchema,
  loadStory,
  parseTwineHtml,
  paths,
  proseText,
  pruneCaptures,
  runCheckData,
  safePath,
  saveStory,
  slug,
  summarizePaths,
} from "@river/core"
import type { Diagnostic, EngineAdapter, Project, StateSchema, Story } from "@river/core"
import { cmdBoard, cmdCard, cmdJob, cmdMark } from "./jobs"

export interface RunIo {
  /** Where normal output goes. Default: process.stdout. */
  stdout?: NodeJS.WritableStream & { isTTY?: boolean }
  /** Where errors go. Default: process.stderr. */
  stderr?: NodeJS.WritableStream
  /** Input for `play`. Default: process.stdin. */
  stdin?: NodeJS.ReadableStream
  /** The folder relative paths are read from, and the project folder when none is given. Default: process.cwd(). */
  cwd?: string
}

const HELP = `river <command> [dir] [options]

[dir] is the game's root folder, the one that holds river.json. Give it as the argument after the command
(after the subcommand for frames, captures, board, card, mark and job) or as --root <dir>; the default is the
current folder. Relative paths are read from the folder you ran river in.

Story:
  lint [dir] [--story rel]                 broken links, dead ends, never-true conditions, rule lines read as prose;
                                           then river.json's checkData command, when it has one
  paths [dir] [--story rel] [--max N] [--summary]
                                           every route from the start, with the choice taken at each passage
                                           (--summary: route counts by ending; --max: stop after N routes, default 500)
  play [dir] [--story rel] [--from name]   play a story as text
  export [dir] [--story rel]               write <export>/<story>.json for each story
  import-twine <file.html> [dir] [--force] import a Twine 2 archive or published story
  check-data [dir]                         run river.json's checkData command against a fresh export

Frames:
  shots [dir]                              the shots in river.json and their latest capture (also: frames list)
  capture [dir] <shotId>... | capture [dir] --all
                                           run the engine to capture shots into .river/captures (also: frames capture)
  captures prune [dir] --keep N [--dry-run]
                                           delete all but the newest N captures of each shot; a capture a board
                                           card shows is kept

Storyboard (--board defaults to main):
  board show [dir]                         the board as agents read it: cards, marks with threads, arrows
  card add [dir] --passage <file>#<passage id> | --note "..." | --image <file> --licence "..." [--caption "..."] [--anchor <cardId>]
                                           add a card at a free spot (or right of the anchor); prints its id
  mark add [dir] --text "..." [--anchor <cardId>]   add a mark, circled around the card (or at a free spot); prints its id
  mark reply --mark <id> --text "..."      add your reply to a mark's thread
  mark dismiss|accept --mark <id> [--text "..."]
                                           close a mark an agent answered (dismiss: --text says why)
  job start --mark <id> [--backend claude-code|api-key] [--model claude-sonnet-5-5]
                                           the concept artist answers the mark; waits until its scripts need approval,
                                           then prints the job and what its turn cost
  job revise --job <id> [--backend ...] [--model ...]
                                           answer your reply on the job's mark with a new job, under the old answer
  job show --job <id>                      status, summary, error and scripts of a job
  job approve --job <id>                   print every script and its sha256; runs nothing
  job approve --job <id> --sha256 a=<hex> --sha256 b=<hex> ... --yes
                                           run the scripts in Godot, only if every one still hashes to the sha256
                                           you read (one draw.gd: --sha256 <hex>); then the agent looks at its
                                           renders once and may rewrite its note (--skip-self-check: don't)
  job accept --job <id> [--variants a,c]   apply the chosen options (default: all that rendered) to your checkout
  job dismiss --job <id> [--reason "..."]  throw the job away; the reason goes into .river/brief.md
`

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`

class Out {
  constructor(private stream: NodeJS.WritableStream) {}
  line(s = "") { this.stream.write(s + "\n") }
  write(s: string) { this.stream.write(s) }
}

/** A mistake in how the command was typed: exit code 2 and the usage line. */
class UsageError extends Error {}

async function openProject(dir: string): Promise<{ project: Project; schema: StateSchema }> {
  const project = await loadProject(dir)
  const schema = await loadSchema(project)
  return { project, schema }
}

/** The stories to work on: all of them, or the one --story names (by path from the root, file name or stem). */
async function storyFiles(project: Project, story: string | undefined): Promise<string[]> {
  const all = await listStories(project)
  if (story === undefined) return all
  const want = story.replace(/\\/g, "/")
  const match = all.find((s) => s === want) ?? all.find((s) => basename(s) === want || basename(s).replace(/\.(twee|tw)$/i, "") === want)
  if (match) return [match]
  throw new Error(`no story "${story}". --story takes a path from the project root, a file name or a name without .twee; stories here: ${all.join(", ") || `(none under ${project.manifest.stories}/)`}`)
}

function formatDiag(d: Diagnostic): string {
  return `${d.severity.padEnd(6)} ${d.message}`
}

const isProjectDir = (cwd: string, p: string) => {
  const dir = resolve(cwd, p)
  return existsSync(join(dir, "river.json")) && statSync(dir).isDirectory()
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
        all: { type: "boolean" },
        root: { type: "string" },
        board: { type: "string" },
        mark: { type: "string" },
        job: { type: "string" },
        text: { type: "string" },
        anchor: { type: "string" },
        backend: { type: "string" },
        model: { type: "string" },
        yes: { type: "boolean" },
        sha256: { type: "string", multiple: true },
        variants: { type: "string" },
        reason: { type: "string" },
        by: { type: "string" },
        "skip-self-check": { type: "boolean" },
        passage: { type: "string" },
        note: { type: "string" },
        image: { type: "string" },
        caption: { type: "string" },
        licence: { type: "string" },
        max: { type: "string" },
        summary: { type: "boolean" },
        keep: { type: "string" },
        "dry-run": { type: "boolean" },
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

  /** The project folder from a positional dir or --root (both may be given when they agree). */
  const root = (dir: string | undefined): string => {
    const a = dir !== undefined ? resolve(cwd, dir) : undefined
    const b = values.root !== undefined ? resolve(cwd, values.root) : undefined
    if (a !== undefined && b !== undefined && a !== b) throw new UsageError(`the project folder is given twice: "${dir}" and --root "${values.root}"`)
    return a ?? b ?? cwd
  }
  /** At most `n` positionals after the command; the rest is a mistake. */
  const upTo = (args: string[], n: number, what: string): string[] => {
    if (args.length > n) throw new UsageError(`unexpected "${args[n]}" (usage: river ${what})`)
    return args
  }
  const board = values.board ?? DEFAULT_BOARD

  const capture = (args: string[]) => {
    // Accept the folder before or after the shot ids: a positional that names a folder with river.json is the folder.
    const dirs = values.root === undefined ? args.filter((a) => isProjectDir(cwd, a)) : []
    if (dirs.length > 1) throw new UsageError(`more than one project folder: ${dirs.join(", ")}`)
    const shots = args.filter((a) => a !== dirs[0])
    if (values.all && shots.length > 0) throw new UsageError(`--all captures every shot; drop "${shots[0]}" or --all`)
    if (!values.all && shots.length === 0) throw new UsageError("missing <shotId> (or --all) (usage: river capture [dir] <shotId>...)")
    return cmdCapture(root(dirs[0]), values.all ? undefined : shots, out, err)
  }
  const prune = (args: string[]) => {
    const [dir] = upTo(args, 1, "captures prune [dir] --keep N [--dry-run]")
    const keep = Number(values.keep)
    if (values.keep === undefined || !Number.isInteger(keep) || keep < 0) throw new UsageError("captures prune needs --keep N, a whole number of captures to keep per shot (0 or more)")
    return cmdPrune(root(dir), keep, values["dry-run"] ?? false, out)
  }

  try {
    switch (cmd) {
      case "lint": return await cmdLint(root(upTo(rest, 1, "lint [dir]")[0]), values.story, out)
      case "paths": {
        const max = values.max === undefined ? undefined : Number(values.max)
        if (max !== undefined && (!Number.isInteger(max) || max < 1)) throw new UsageError("--max needs a whole number of routes, 1 or more")
        return await cmdPaths(root(upTo(rest, 1, "paths [dir]")[0]), values.story, { max, summary: values.summary ?? false }, out)
      }
      case "export": return await cmdExport(root(upTo(rest, 1, "export [dir]")[0]), values.story, out, err)
      case "play": return await cmdPlay(root(upTo(rest, 1, "play [dir]")[0]), values.story, values.from, io, out)
      case "check-data": return await cmdCheckData(root(upTo(rest, 1, "check-data [dir]")[0]), out)
      case "import-twine": {
        const [file, dir] = upTo(rest, 2, "import-twine <file.html> [dir]")
        if (!file) throw new UsageError("missing <file.html> (usage: river import-twine <file.html> [dir])")
        return await cmdImport(resolve(cwd, file), root(dir), values.force ?? false, out, err)
      }
      case "shots": return await cmdShots(root(upTo(rest, 1, "shots [dir]")[0]), out)
      case "capture": return await capture(rest)
      case "frames": {
        const [sub, ...args] = rest
        if (sub === "capture") return await capture(args)
        if (sub === "list") return await cmdShots(root(upTo(args, 1, "frames list [dir]")[0]), out)
        if (sub === "prune") return await prune(args)
        throw new UsageError(`frames has "list", "capture" and "prune", not ${sub === undefined ? "nothing" : `"${sub}"`}`)
      }
      case "captures": {
        const [sub, ...args] = rest
        if (sub === "prune") return await prune(args)
        throw new UsageError(`captures has "prune", not ${sub === undefined ? "nothing" : `"${sub}"`} (river shots lists the captures)`)
      }
      case "mark": {
        const [sub, dir] = upTo(rest, 2, "mark <add|reply|dismiss|accept> [dir]")
        return await cmdMark(sub, { root: root(dir), board, text: values.text, anchor: values.anchor, mark: values.mark }, out, err)
      }
      case "board": {
        const [sub, dir] = upTo(rest, 2, "board show [dir]")
        return await cmdBoard(sub, { root: root(dir), board }, out, err)
      }
      case "card": {
        const [sub, dir] = upTo(rest, 2, "card add [dir]")
        return await cmdCard(sub, { ...values, root: root(dir), board }, out, err)
      }
      case "job": {
        const [sub, dir] = upTo(rest, 2, "job <start|revise|show|approve|accept|dismiss> [dir]")
        return await cmdJob(sub, { ...values, root: root(dir) }, out, err)
      }
      default:
        err.line(`river: unknown command "${cmd}"`)
        out.write(HELP)
        return 2
    }
  } catch (e) {
    err.line(`river ${cmd}: ${(e as Error).message}`)
    return e instanceof UsageError ? 2 : 1
  }
}

/** The engine adapter named by manifest.engine. */
export function adapterFor(project: Project): EngineAdapter {
  const engine = project.manifest.engine
  if (engine === "godot") return createGodotAdapter()
  if (engine === "none" || engine === "") {
    throw new Error(`this project has engine "${engine}" in river.json, so it cannot capture frames (set "engine": "godot" and adapter.godot.bin)`)
  }
  throw new Error(`unknown engine "${engine}" in river.json; supported: godot`)
}

async function cmdShots(dir: string, out: Out): Promise<number> {
  const project = await loadProject(dir)
  const shots = project.manifest.shots
  if (shots.length === 0) {
    out.line("no shots in river.json")
    return 0
  }
  for (const s of shots) {
    const latest = (await listCaptures(project, s.id))[0]
    const last = latest ? `last capture ${latest.at} (rev ${latest.rev}, ${plural(latest.files.length, "frame")})` : "never captured"
    out.line(`${s.id}  ${s.scene}  ${plural(s.count, "frame")}  ${last}${s.note ? `  ${s.note}` : ""}`)
  }
  return 0
}

async function cmdCapture(dir: string, shotIds: string[] | undefined, out: Out, err: Out): Promise<number> {
  const project = await loadProject(dir)
  const adapter = adapterFor(project)
  const ids = shotIds ?? project.manifest.shots.map((s) => s.id)
  if (ids.length === 0) {
    err.line("river capture: no shots in river.json")
    return 1
  }
  let failed = 0
  for (const id of ids) {
    try {
      const capture = await captureShot(project, id, adapter)
      out.line(`captured ${id} at rev ${capture.rev} (${plural(capture.files.length, "frame")})`)
      for (const f of capture.files) out.line(`  ${f}`)
    } catch (e) {
      failed++
      err.line(`error  ${(e as Error).message}`)
    }
  }
  return failed > 0 ? 1 : 0
}

async function cmdPrune(dir: string, keep: number, dryRun: boolean, out: Out): Promise<number> {
  const project = await loadProject(dir)
  const { removed, pinned } = await pruneCaptures(project, keep, { dryRun })
  for (const r of removed) out.line(`${dryRun ? "would delete" : "deleted"}  ${r.shotId}  ${r.at}  (rev ${r.rev})`)
  for (const p of pinned) out.line(`kept  ${p.shotId}  ${p.at}  (a board card shows it)`)
  out.line(`${dryRun ? "would delete" : "deleted"} ${plural(removed.length, "capture")}, keeping the newest ${keep} of each shot`)
  return 0
}

async function cmdCheckData(dir: string, out: Out): Promise<number> {
  const { project, schema } = await openProject(dir)
  if (!project.manifest.checkData) {
    out.line('no checkData in river.json (for example "checkData": "node tools/check_story.mjs")')
    return 1
  }
  return (await printCheckData(project, schema, out)) ? 0 : 1
}

/** Run river.json's checkData command and print what it said. False when it failed or could not run. */
async function printCheckData(project: Project, schema: StateSchema, out: Out): Promise<boolean> {
  const r = await runCheckData(project, schema)
  out.line(`check-data: ${r.command}`)
  for (const l of r.output.trimEnd().split(/\r?\n/)) if (l.trim()) out.line(`  ${l}`)
  if (r.ok) out.line("check-data: ok")
  else out.line(`error  check-data: ${r.problem}`)
  return r.ok
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
  if (project.manifest.checkData && !(await printCheckData(project, schema, out))) errors++
  let summary = `${plural(errors, "error")}, ${plural(warnings, "warning")}`
  if (infos > 0) summary += `, ${infos} info`
  out.line(`${summary} in ${plural(passages, "passage")}`)
  return errors > 0 ? 1 : 0
}

async function cmdPaths(dir: string, storyOpt: string | undefined, o: { max: number | undefined; summary: boolean }, out: Out): Promise<number> {
  const { project, schema } = await openProject(dir)
  const files = await storyFiles(project, storyOpt)
  const opts = o.max !== undefined ? { maxPaths: o.max } : {}
  for (const rel of files) {
    const { story } = await loadStory(project, rel)
    if (files.length > 1) out.line(rel)
    const routes = paths(story, schema, opts)
    const detours = interruptPaths(story, schema, opts)
    if (routes.length === 0) out.line("no routes (the start passage is missing)")
    else for (const l of o.summary ? summarizePaths(story, routes, detours) : formatPathList(story, routes, detours)) out.line(l)
    const max = o.max ?? 500
    if (routes.length >= max || detours.length >= max) out.line(`stopped at ${max} routes; --max N lists more`)
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
  if (!rel) throw new Error(`no stories under ${project.manifest.stories}/`)
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
    const inInterrupt = play.history().at(-1)?.returnTo !== undefined
    for (const c of play.choices()) {
      const to = choiceTarget(story, c.choice.target)
      const label = `${c.index + 1}. ${c.choice.label}${c.choice.hint ? `  (${c.choice.hint})` : ""}`
      if (to.kind === "missing") out.line(dim(`  ${label}  (broken link to "${c.choice.target}")`))
      else if (c.closed) out.line(dim(`  ${label}  [${formatClosed(c.closed)}]`))
      else if (to.kind === "return" && !inInterrupt) out.line(dim(`  ${label}  (returns, but no interrupt is running)`))
      else out.line(`  ${label}`)
    }
    const interrupts = play.interrupts()
    if (interrupts.length > 0 && !inInterrupt && !p.isEnding) {
      out.line(
        `  interrupts: ${interrupts
          .map((i, k) => (i.open ? `!${k + 1} ${i.passage.name}` : dim(`!${k + 1} ${i.passage.name} [${i.passage.when ? formatCond(i.passage.when) : ""}]`)))
          .join("   ")}`,
      )
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
        for (const [k, v] of Object.entries(play.state())) out.line(`  ${k} = ${String(v)}${schema[k]?.engine ? "  (engine)" : ""}`)
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
      if (line.startsWith("!")) {
        const pick = line.slice(1).trim()
        const interrupts = play.interrupts()
        const target = /^\d+$/.test(pick) ? interrupts[Number(pick) - 1]?.passage.name : pick
        if (target === undefined) throw new Error(`no interrupt ${line}`)
        play.interrupt(target)
        render()
        continue
      }
      out.line("  type a choice number, !n to start an interrupt, :state, :set var value, :undo or :quit")
    } catch (e) {
      out.line(`  ${(e as Error).message}`)
    }
    out.write("> ")
  }
  rl.close()
  out.line()
  return 0
}
