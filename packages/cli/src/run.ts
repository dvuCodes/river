import { randomBytes } from "node:crypto"
import { existsSync } from "node:fs"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { createInterface } from "node:readline"
import { basename, relative, resolve } from "node:path"
import { parseArgs } from "node:util"
import { createGodotAdapter, installGodotRuntime } from "@river/adapter-godot"
import {
  addVoiceCut,
  addVoiceExemplar,
  captureShots,
  choiceTarget,
  contentPassages,
  CUT_HEADING,
  DEFAULT_BOARD,
  createPlaytest,
  exportStory,
  extractStrings,
  formatClosed,
  formatCond,
  formatPacingReport,
  formatPathList,
  formatSimulationReport,
  formatStringsCsv,
  formatStringsJson,
  formatStringsPo,
  interruptPaths,
  LANDED_HEADING,
  lint,
  lintNarrative,
  lintStoryInWorkspace,
  listCaptures,
  listStories,
  loadProject,
  loadSchema,
  loadStory,
  loadStoryWorkspace,
  pacingReport,
  parseTwineHtml,
  paths,
  pruneCaptures,
  pruneCheckpoints,
  readVoice,
  resolveAdapter,
  runCheckData,
  safePath,
  sampleTranscripts,
  saveStory,
  simulateStory,
  slug,
  summarizePaths,
  tagStoryLines,
  VOICE_FILE,
  writeTwee3,
} from "@river/core"
import type { Diagnostic, EngineAdapter, Project, StateSchema, Story, StoryWorkspace, StringEntry } from "@river/core"
import { cmdBoard, cmdCard, cmdJob, cmdMark, cmdWriteJob } from "./jobs"

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
(after the subcommand for frames, captures, checkpoints, godot, voice, i18n, board, card, mark, job and write-job)
or as --root <dir>; the default is the current folder. Relative paths are read from the folder you ran river in.

Story:
  lint [dir] [--story rel] [--no-narrative]
                                           broken links, dead ends, never-true conditions, rule lines read as prose;
                                           then river.json's checkData command, when it has one, and narrative craft
                                           notes unless --no-narrative is given
  paths [dir] [--story rel] [--max N] [--summary]
                                           every route from the start, with the choice taken at each passage
                                           (--summary: route counts by ending; --max: stop after N routes, default 500)
  pacing [dir] [--story rel] [--max N]     passage counts, word counts, choice density and route lengths
  simulate [dir] [--story rel] [--runs N] [--seed N] [--max-steps N]
                                           play N seeded random games (default 200, seed 1, 100 steps each): how often
                                           each ending is reached, what no game visits, where the state lands
  table-read [dir] [--story rel] [--max N] [--interrupts]
                                           sample player-facing prose transcripts from the initial state
  voice [show] [dir]                       print the narrative voice bible (.river/voice.md)
  voice landed|cut [dir] --text "..." [--key <id>]
                                           record a line under "## Lines that landed" or "## Lines we cut"
  play [dir] [--story rel] [--from name]   play a story as text (renders inline prose templates live)
  export [dir] [--story rel]               write <export>/<story>.json for each story
  i18n tag [dir] [--story rel]             add deterministic #line:<id> tags to untagged prose lines
  i18n extract [dir] [--story rel] [--format csv|po|json] [--out file]
                                           extract localizable strings as csv (default), po or json
  import-twine <file.html> [dir] [--force] import a Twine 2 archive or published story
  check-data [dir]                         run river.json's checkData command against a fresh export

Frames & Engine:
  shots [dir]                              the shots in river.json and their latest capture (also: frames list)
  capture [dir] <shotId>... | capture [dir] --all
                                           run the engine to capture shots into .river/captures (also: frames capture);
                                           several shots go to the engine in one batch when its adapter can (Godot does,
                                           so does a command engine with batchCommand). The engine is river.json's
                                           "engine": godot, or any name with adapter.<name>.command
  captures prune [dir] --keep N [--dry-run]
                                           delete all but the newest N captures of each shot; a capture a board
                                           card shows is kept
  checkpoints prune [dir] --keep N         delete all but the newest N git checkpoint refs
  godot install-runtime [dir]              install River's Godot 4 runtime addon into addons/river/

Storyboard (--board defaults to main):
  board show [dir]                         the board as agents read it: cards, marks with threads, arrows
  card add [dir] --passage <file>#<passage id> | --note "..." | --image <file> --licence "..." [--caption "..."] [--anchor <cardId>]
                                           add a card at a free spot (or right of the anchor); prints its id
  mark add [dir] --text "..." [--anchor <cardId>]   add a mark, circled around the card (or at a free spot); prints its id
  mark reply --mark <id> --text "..."      add your reply to a mark's thread
  mark dismiss|accept --mark <id> [--text "..."]
                                           close a mark an agent answered (dismiss: --text says why)
  job start --mark <id> [--backend claude-code|api-key] [--model <id>]
                                           the concept artist answers the mark; waits until its scripts need approval,
                                           then prints the job and what its turn cost
  job revise --job <id> [--backend ...] [--model ...]
                                           answer your reply on the job's mark with a new job, under the old answer
  job show --job <id>                      status, summary, error and scripts (or takes) of a job
  job approve --job <id>                   print every script and its sha256; runs nothing
  job approve --job <id> --sha256 a=<hex> --sha256 b=<hex> ... --yes
                                           run the scripts in Godot, only if every one still hashes to the sha256
                                           you read (one draw.gd: --sha256 <hex>); then the agent looks at its
                                           renders once and may rewrite its note (--skip-self-check: don't;
                                           --self-check-model <id>: look with another model)
  job accept --job <id> [--variants a,c]   apply the chosen options (default: all that rendered) to your checkout
  job dismiss --job <id> [--reason "..."]  throw the job away; the reason goes into .river/brief.md
  write-job start --mark <id> [--board <name>] [--backend claude-code|api-key] [--model <id>] [--skip-self-check] [--self-check-model <id>]
                                           the story writer answers the mark with takes on its own branch
  write-job revise --job <id> [--backend ...] [--model ...] [--skip-self-check] [--self-check-model <id>]
                                           answer your reply on the writing job's mark with new takes
  write-job show --job <id>                status, summary, takes, diffs and new diagnostics of a writing job
  write-job accept --job <id> --variant <a|b|c|d|e> [--no-exemplar]
                                           apply the chosen take to your story (and record a line in .river/voice.md)
  write-job dismiss --job <id> [--reason "..."]
                                           throw the writing job away; the reason goes into .river/voice.md

--model takes any model id (default claude-sonnet-5-5; for example claude-opus-5-5 or claude-haiku-4-5).
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
  if (existsSync(safePath(project, want))) return [want]
  throw new Error(`no story "${story}". --story takes a path from the project root, a file name or a name without .twee; stories here: ${all.join(", ") || `(none under ${project.manifest.stories}/)`}`)
}

function formatDiag(d: Diagnostic): string {
  return `${d.severity.padEnd(6)} ${d.message}`
}

/** A capture argument that names a folder, not a shot: it has a path separator, or it exists. */
const isPathArg = (cwd: string, a: string) => /[\\/]/.test(a) || a === "." || a === ".." || existsSync(resolve(cwd, a))

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
        "self-check-model": { type: "string" },
        runs: { type: "string" },
        seed: { type: "string" },
        "max-steps": { type: "string" },
        yes: { type: "boolean" },
        sha256: { type: "string", multiple: true },
        variants: { type: "string" },
        variant: { type: "string" },
        "no-exemplar": { type: "boolean" },
        reason: { type: "string" },
        by: { type: "string" },
        "skip-self-check": { type: "boolean" },
        "no-narrative": { type: "boolean" },
        interrupts: { type: "boolean" },
        key: { type: "string" },
        passage: { type: "string" },
        note: { type: "string" },
        image: { type: "string" },
        caption: { type: "string" },
        licence: { type: "string" },
        max: { type: "string" },
        summary: { type: "boolean" },
        keep: { type: "string" },
        "dry-run": { type: "boolean" },
        format: { type: "string" },
        out: { type: "string" },
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
  /** A whole number of 1 or more from a flag, or `def` when the flag is absent. */
  const whole = (flag: string, raw: string | undefined, def: number, what: string): number => {
    if (raw === undefined) return def
    const n = Number(raw)
    if (!/^\d+$/.test(raw) || !Number.isSafeInteger(n) || n < 1) throw new UsageError(`${flag} needs ${what}`)
    return n
  }
  const seedOption = (raw: string | undefined): number => {
    if (raw === undefined) return 1
    const n = Number(raw)
    if (!/^-?\d+$/.test(raw) || !Number.isSafeInteger(n)) throw new UsageError("--seed needs an integer")
    return n
  }

  const capture = (args: string[]) => {
    // The folder can come before or after the shot ids. One that is not a project fails in loadProject, before anything runs.
    const dirs = values.root === undefined ? args.filter((a) => isPathArg(cwd, a)) : []
    if (dirs.length > 1) throw new UsageError(`more than one project folder: ${dirs.join(", ")}`)
    const shots = args.filter((a) => a !== dirs[0])
    if (values.all && shots.length > 0) throw new UsageError(`--all captures every shot; drop "${shots[0]}" or --all`)
    if (!values.all && shots.length === 0) throw new UsageError("missing <shotId> (or --all) (usage: river capture [dir] <shotId>...)")
    return cmdCapture(root(dirs[0]), values.all ? undefined : shots, out, err)
  }
  const prune = (args: string[]) => {
    const [dir] = upTo(args, 1, "captures prune [dir] --keep N [--dry-run]")
    // Number("") is 0, which would delete every unpinned capture; only digits count.
    if (values.keep === undefined || !/^\d+$/.test(values.keep)) throw new UsageError("captures prune needs --keep N, a whole number of captures to keep per shot (0 or more)")
    return cmdPrune(root(dir), Number(values.keep), values["dry-run"] ?? false, out)
  }

  try {
    switch (cmd) {
      case "lint": return await cmdLint(root(upTo(rest, 1, "lint [dir]")[0]), values.story, values["no-narrative"] ?? false, out)
      case "paths": {
        const max = values.max === undefined ? undefined : Number(values.max)
        if (max !== undefined && (!Number.isInteger(max) || max < 1)) throw new UsageError("--max needs a whole number of routes, 1 or more")
        return await cmdPaths(root(upTo(rest, 1, "paths [dir]")[0]), values.story, { max, summary: values.summary ?? false }, out)
      }
      case "pacing": {
        const max = values.max === undefined ? undefined : Number(values.max)
        if (max !== undefined && (!Number.isInteger(max) || max < 1)) throw new UsageError("--max needs a whole number of routes, 1 or more")
        return await cmdPacing(root(upTo(rest, 1, "pacing [dir]")[0]), values.story, max, out)
      }
      case "table-read": {
        const max = values.max === undefined ? undefined : Number(values.max)
        if (max !== undefined && (!Number.isInteger(max) || max < 1)) throw new UsageError("--max needs a whole number of transcripts, 1 or more")
        return await cmdTableRead(root(upTo(rest, 1, "table-read [dir]")[0]), values.story, { max, interrupts: values.interrupts ?? false }, out)
      }
      case "simulate": {
        const sim = {
          runs: whole("--runs", values.runs, 200, "a whole number of games, 1 or more"),
          seed: seedOption(values.seed),
          maxSteps: whole("--max-steps", values["max-steps"], 100, "a whole number of steps, 1 or more"),
        }
        return await cmdSimulate(root(upTo(rest, 1, "simulate [dir]")[0]), values.story, sim, out)
      }
      case "voice": {
        const [first, ...more] = rest
        if (first === "show") {
          const [dir] = upTo(more, 1, "voice show [dir]")
          return await cmdVoice("show", { root: root(dir) }, out)
        }
        if (first === "landed" || first === "cut") {
          const [dir] = upTo(more, 1, `voice ${first} [dir] --text "..." [--key <id>]`)
          return await cmdVoice(first, { root: root(dir), text: values.text, key: values.key }, out)
        }
        const [dir] = upTo(rest, 1, "voice [dir]")
        return await cmdVoice("show", { root: root(dir) }, out)
      }
      case "export": return await cmdExport(root(upTo(rest, 1, "export [dir]")[0]), values.story, out, err)
      case "i18n": {
        const [sub, ...args] = rest
        if (sub === "tag") {
          const [dir] = upTo(args, 1, "i18n tag [dir] [--story rel]")
          return await cmdI18nTag(root(dir), values.story, out)
        }
        if (sub === "extract") {
          const [dir] = upTo(args, 1, "i18n extract [dir] [--story rel] [--format csv|po|json] [--out file]")
          const format = values.format ?? "csv"
          if (format !== "csv" && format !== "po" && format !== "json") {
            throw new UsageError(`--format must be "csv", "po" or "json", not "${format}"`)
          }
          const outPath = values.out !== undefined ? resolve(cwd, values.out) : undefined
          return await cmdI18nExtract(root(dir), values.story, format, outPath, values.out, out)
        }
        throw new UsageError(`i18n has "tag" and "extract", not ${sub === undefined ? "nothing" : `"${sub}"`}`)
      }
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
      case "checkpoints": {
        const [sub, ...args] = rest
        if (sub === "prune") {
          const [dir] = upTo(args, 1, "checkpoints prune [dir] --keep N")
          if (values.keep === undefined || !/^\d+$/.test(values.keep)) {
            throw new UsageError("checkpoints prune needs --keep N, a whole number of checkpoints to keep (0 or more)")
          }
          return await cmdPruneCheckpoints(root(dir), Number(values.keep), out)
        }
        throw new UsageError(`checkpoints has "prune", not ${sub === undefined ? "nothing" : `"${sub}"`}`)
      }
      case "godot": {
        const [sub, ...args] = rest
        if (sub === "install-runtime") {
          const [dir] = upTo(args, 1, "godot install-runtime [dir]")
          return await cmdGodotInstallRuntime(root(dir), out)
        }
        throw new UsageError(`godot has "install-runtime", not ${sub === undefined ? "nothing" : `"${sub}"`}`)
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
      case "write-job": {
        const [sub, dir] = upTo(rest, 2, "write-job <start|revise|show|accept|dismiss> [dir]")
        return await cmdWriteJob(sub, { ...values, root: root(dir) }, out, err)
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

/** The engine adapter for the project: Godot's when engine is "godot", else a command adapter from river.json's adapter.<engine>.command. */
export function adapterFor(project: Project): EngineAdapter {
  const engine = project.manifest.engine
  if ((engine === "none" || engine === "") && !project.manifest.adapter?.[engine]?.command) {
    throw new Error(`this project has engine "${engine}" in river.json, so it cannot capture frames (set "engine": "godot" and adapter.godot.bin)`)
  }
  return resolveAdapter(project, [createGodotAdapter()])
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
  const known = project.manifest.shots.map((s) => s.id)
  const ids = shotIds ?? known
  if (ids.length === 0) {
    err.line("river capture: no shots in river.json")
    return 1
  }
  const unknown = ids.filter((id) => !known.includes(id))
  if (unknown.length > 0) {
    err.line(`river capture: no shot ${unknown.map((id) => JSON.stringify(id)).join(", ")} in the manifest (shots: ${known.join(", ") || "none yet"}); nothing was captured`)
    return 1
  }
  const show = (capture: { shotId: string; rev: string; files: string[] }) => {
    out.line(`captured ${capture.shotId} at rev ${capture.rev} (${plural(capture.files.length, "frame")})`)
    for (const f of capture.files) out.line(`  ${f}`)
  }
  // Several distinct shots on an adapter with a batch call go to the engine once (one cold start); that is all or nothing.
  if (ids.length > 1 && new Set(ids).size === ids.length && adapter.captureBatch) {
    try {
      for (const capture of await captureShots(project, ids, adapter)) show(capture)
      return 0
    } catch (e) {
      err.line(`error  ${(e as Error).message}`)
      return 1
    }
  }
  let failed = 0
  for (const id of ids) {
    try {
      for (const capture of await captureShots(project, [id], adapter)) show(capture)
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

async function cmdPruneCheckpoints(dir: string, keep: number, out: Out): Promise<number> {
  const project = await loadProject(dir)
  const removed = await pruneCheckpoints(project.root, keep)
  for (const c of removed) out.line(`deleted  ${c.ref}  ${c.at}  ${c.label}`)
  out.line(`deleted ${plural(removed.length, "checkpoint")}, keeping the newest ${keep}`)
  return 0
}

async function cmdGodotInstallRuntime(dir: string, out: Out): Promise<number> {
  const project = await loadProject(dir)
  const files = await installGodotRuntime(project.root)
  out.line(`installed Godot runtime (${plural(files.length, "file")}) under addons/river/:`)
  for (const f of files) out.line(`  ${relative(project.root, f).replace(/\\/g, "/")}`)
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

function storyIdFor(rel: string, storiesDir: string, allStories: readonly string[]): string {
  const stemOf = (p: string) => basename(p).replace(/\.(twee|tw)$/i, "")
  const stem = stemOf(rel)
  const lower = stem.toLowerCase()
  const collides = allStories.filter((s) => stemOf(s).toLowerCase() === lower).length > 1
  if (!collides) return stem
  const norm = rel.replace(/\\/g, "/").replace(/^\.\//, "")
  const prefix = storiesDir.replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/+$/, "")
  const under = prefix && prefix !== "." && norm.startsWith(`${prefix}/`) ? norm.slice(prefix.length + 1) : norm
  return under.replace(/\.(twee|tw)$/i, "")
}

async function loadWorkspaceStories(
  project: Project,
  selected: string[],
): Promise<{
  loaded: Map<string, { story: Story; diagnostics: Diagnostic[] }>
  storyIds: Map<string, string>
  workspace?: StoryWorkspace
}> {
  const all = await listStories(project)
  const pathsToLoad = all.length >= 2 ? Array.from(new Set([...all, ...selected])) : selected
  const loaded = new Map<string, { story: Story; diagnostics: Diagnostic[] }>()
  const storyIds = new Map<string, string>()
  for (const rel of pathsToLoad) {
    loaded.set(rel, await loadStory(project, rel))
    storyIds.set(rel, storyIdFor(rel, project.manifest.stories, pathsToLoad))
  }
  const workspace =
    pathsToLoad.length >= 2
      ? loadStoryWorkspace(
          pathsToLoad.map((rel) => ({
            file: rel,
            id: storyIds.get(rel)!,
            story: loaded.get(rel)!.story,
          })),
        )
      : undefined
  return { loaded, storyIds, workspace }
}

async function cmdLint(dir: string, storyOpt: string | undefined, noNarrative: boolean, out: Out): Promise<number> {
  const { project, schema } = await openProject(dir)
  const files = await storyFiles(project, storyOpt)
  const { loaded, storyIds, workspace } = await loadWorkspaceStories(project, files)
  let errors = 0, warnings = 0, infos = 0, passages = 0
  const allNotes: Diagnostic[] = []
  const noteLines: string[] = []
  const shotIds = project.manifest.shots.map((s) => s.id)
  for (const rel of files) {
    const { story, diagnostics } = loaded.get(rel)!
    const lintDiags = workspace ? lintStoryInWorkspace(workspace, storyIds.get(rel)!, story, schema) : lint(story, schema)
    const all = [...diagnostics, ...lintDiags]
    passages += contentPassages(story).length
    if (files.length > 1) out.line(rel)
    for (const d of all) {
      out.line(formatDiag(d))
      if (d.severity === "error") errors++
      else if (d.severity === "warn") warnings++
      else infos++
    }
    if (!noNarrative) {
      const notes = lintNarrative(story, schema, { copyBudgets: project.manifest.copyBudgets, shotIds })
      if (files.length > 1 && notes.length > 0) noteLines.push(rel)
      for (const n of notes) noteLines.push(`${formatDiag(n)}  (${n.code})`)
      allNotes.push(...notes)
    }
  }
  if (project.manifest.checkData && !(await printCheckData(project, schema, out))) errors++
  let summary = `${plural(errors, "error")}, ${plural(warnings, "warning")}`
  if (infos > 0) summary += `, ${infos} info`
  out.line(`${summary} in ${plural(passages, "passage")}`)
  if (!noNarrative) {
    if (allNotes.length === 0) {
      out.line("narrative: none")
    } else {
      const nWarn = allNotes.filter((d) => d.severity === "warn").length
      const nInfo = allNotes.length - nWarn
      out.line(`narrative: ${plural(nWarn, "warning")}, ${nInfo} info`)
      for (const l of noteLines) out.line(l)
    }
  }
  return errors > 0 ? 1 : 0
}

async function cmdPacing(dir: string, storyOpt: string | undefined, max: number | undefined, out: Out): Promise<number> {
  const { project, schema } = await openProject(dir)
  const files = await storyFiles(project, storyOpt)
  if (files.length === 0) {
    out.line(`no stories under ${project.manifest.stories}/`)
    return 0
  }
  const opts = max !== undefined ? { maxPaths: max } : undefined
  for (const rel of files) {
    const { story } = await loadStory(project, rel)
    if (files.length > 1) out.line(rel)
    for (const l of formatPacingReport(pacingReport(story, schema, opts))) out.line(l)
  }
  return 0
}

async function cmdSimulate(dir: string, storyOpt: string | undefined, o: { runs: number; seed: number; maxSteps: number }, out: Out): Promise<number> {
  const { project, schema } = await openProject(dir)
  const files = await storyFiles(project, storyOpt)
  if (files.length === 0) {
    out.line(`no stories under ${project.manifest.stories}/`)
    return 0
  }
  for (const [i, rel] of files.entries()) {
    if (i > 0) out.line()
    const { story } = await loadStory(project, rel)
    if (files.length > 1) out.line(rel)
    for (const l of formatSimulationReport(simulateStory(story, schema, o))) out.line(l)
  }
  return 0
}

async function cmdTableRead(dir: string, storyOpt: string | undefined, o: { max: number | undefined; interrupts: boolean }, out: Out): Promise<number> {
  const { project, schema } = await openProject(dir)
  const files = await storyFiles(project, storyOpt)
  if (files.length === 0) {
    out.line(`no stories under ${project.manifest.stories}/`)
    return 0
  }
  const opts = {
    ...(o.max !== undefined ? { maxTranscripts: o.max } : {}),
    ...(o.interrupts ? { includeInterrupts: true } : {}),
  }
  for (const [fIdx, rel] of files.entries()) {
    if (fIdx > 0) out.line()
    const { story } = await loadStory(project, rel)
    const transcripts = sampleTranscripts(story, schema, opts)
    if (transcripts.length === 0) {
      out.line(`no transcripts for ${rel} (the start passage is missing or no route is playable)`)
      continue
    }
    out.line(`${plural(transcripts.length, "transcript")} of ${rel}`)
    transcripts.forEach((t, i) => {
      const end = t.end === "ending" ? `ending: ${t.ending ?? "?"}` : t.end === "return" ? "interrupt, back to the story" : t.end
      out.line()
      out.line(`--- ${i + 1} of ${transcripts.length}: ${t.route.join(" > ")} (${end}) ---`)
      out.line(t.text)
      if (!t.complete) out.line(`(stopped early: ${t.note ?? "the route could not be played from the initial state"})`)
    })
  }
  return 0
}

async function cmdVoice(
  sub: "show" | "landed" | "cut",
  o: { root: string; text?: string | undefined; key?: string | undefined },
  out: Out,
): Promise<number> {
  const project = await loadProject(o.root)
  const root = project.root
  if (sub === "show") {
    const voice = await readVoice(root)
    if (voice === undefined) {
      out.line(`no voice bible yet (${VOICE_FILE} does not exist or is empty)`)
      out.line(`create ${VOICE_FILE} with your voice pillars and character notes, or add examples:`)
      out.line('  river voice landed --text "a line that sounds right"')
      out.line('  river voice cut --text "a line to avoid"')
      return 0
    }
    out.write(voice.endsWith("\n") ? voice : `${voice}\n`)
    return 0
  }
  const text = o.text?.replace(/\s+/g, " ").trim()
  if (!text) throw new UsageError(`voice ${sub} needs --text "..."`)
  const key = o.key?.trim() || `you-${randomBytes(4).toString("hex")}`
  const heading = sub === "landed" ? LANDED_HEADING : CUT_HEADING
  const added = await (sub === "landed" ? addVoiceExemplar : addVoiceCut)(root, key, text)
  if (!added) {
    out.line(`not added: "${heading}" in ${VOICE_FILE} already has a line with key (${key})`)
    return 0
  }
  out.line(`added to "${heading}" in ${VOICE_FILE}: - ${text} (${key})`)
  return 0
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
  const { loaded, storyIds, workspace } = await loadWorkspaceStories(project, files)
  let failed = 0
  for (const rel of files) {
    const { story } = loaded.get(rel)!
    const stem = storyIds.get(rel)!
    try {
      const data = workspace ? exportStory(story, schema, stem, { workspace }) : exportStory(story, schema, stem)
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

async function cmdI18nTag(dir: string, storyOpt: string | undefined, out: Out): Promise<number> {
  const project = await loadProject(dir)
  const files = await storyFiles(project, storyOpt)
  if (files.length === 0) {
    out.line(`no stories under ${project.manifest.stories}/`)
    return 0
  }
  for (const rel of files) {
    const { story } = await loadStory(project, rel)
    const { story: tagged, added } = tagStoryLines(story)
    if (added > 0) {
      const target = safePath(project, rel)
      await writeFile(target, writeTwee3(tagged), "utf8")
    }
    out.line(`${rel}: tagged ${added} line(s)`)
  }
  return 0
}

async function cmdI18nExtract(
  dir: string,
  storyOpt: string | undefined,
  format: "csv" | "po" | "json",
  outPath: string | undefined,
  outDisplay: string | undefined,
  out: Out,
): Promise<number> {
  const project = await loadProject(dir)
  const files = await storyFiles(project, storyOpt)
  if (files.length === 0) {
    out.line(`no stories under ${project.manifest.stories}/`)
    return 0
  }
  const allStories = await listStories(project)
  const entries: StringEntry[] = []
  for (const rel of files) {
    const { story } = await loadStory(project, rel)
    entries.push(...extractStrings(story, { storyId: storyIdFor(rel, project.manifest.stories, allStories) }))
  }
  const rendered =
    format === "csv"
      ? formatStringsCsv(entries)
      : format === "po"
        ? formatStringsPo(entries, { title: project.manifest.name })
        : formatStringsJson(entries)
  if (outPath !== undefined) {
    await mkdir(resolve(outPath, ".."), { recursive: true })
    await writeFile(outPath, rendered, "utf8")
    out.line(`wrote ${outDisplay ?? outPath}`)
  } else {
    out.write(rendered)
  }
  return 0
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
    const prose = play.renderedText()
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
