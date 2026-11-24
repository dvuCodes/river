/**
 * The River tools, as plain functions over a loaded project. `server.ts` registers them on an
 * MCP server; the in-app agent can register the same list in-process.
 *
 * Every path argument is relative to the project root and goes through core `safePath`.
 * Handlers throw on bad input; the MCP server turns a throw into an `isError` tool result.
 */
import { createHash } from "node:crypto"
import { existsSync, realpathSync } from "node:fs"
import { mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises"
import path from "node:path"
import { conceptScriptProblem, createGodotAdapter, lintConceptScript } from "@river/adapter-godot"
import {
  addVoiceCut,
  addVoiceExemplar,
  answerStart,
  assertConceptFile,
  assertConceptId,
  BOARD_GAP,
  besideRect,
  cardHeight,
  cardImageFile,
  cardRect,
  choiceTarget,
  claimMark,
  conceptCaptionName,
  conceptPath,
  createStoryIndex,
  CUT_HEADING,
  DEFAULT_BOARD,
  deleteCard,
  deleteEdge,
  deletePassage,
  elementRect,
  formatBoard,
  formatClosed,
  formatEffects,
  formatPacingReport,
  formatSimulationReport,
  formatPathList,
  initialState,
  interruptPaths,
  summarizePaths,
  frameCardFiles,
  captureForCard,
  formatCard,
  formatMark,
  IMAGE_CARD_W,
  isInterrupt,
  isStorylet,
  jobRenderName,
  LANDED_HEADING,
  lintNarrative,
  listBoards,
  listJobs,
  loadBoard,
  loadCard,
  loadJob,
  markRect,
  mulberry32,
  newBoardId,
  noPassageError,
  NOTE_CARD_W,
  occupiedRects,
  openMarks,
  optionLabels,
  pacingReport,
  parseConceptScriptName,
  parseProseBlocks,
  placeRow,
  readBrief,
  readVoice,
  renamePassage,
  resolveAdapter,
  renderProse,
  replyToMark,
  RESERVED_AUTHORS,
  saveCard,
  saveEdge,
  assertEditAllowed,
  captureShot,
  captureShots,
  contentPassages,
  createPlaytest,
  formatCond,
  lint,
  listCaptures,
  listPlans,
  listStories,
  listThreads,
  loadPlan,
  loadSchema,
  loadStory,
  normalizeRel,
  parseTwee3,
  passageById,
  paths,
  proseText,
  reply,
  safePath,
  sampleTranscripts,
  savePlan,
  saveStory,
  setPlanStatus,
  simulateStory,
  templateRefs,
  updatePassageText,
  VOICE_FILE,
  voiceSection,
  writeAtomic,
  writeTwee3,
} from "@river/core"
import type { Board, Card, ChangePlan, Choice, Cond, Diagnostic, EngineAdapter, Job, Mark, Passage, Project, StateSchema, Story, StoryIndex } from "@river/core"
import { z } from "zod"
import { unifiedDiff } from "./diff"
import { launchConceptJob, launchWritingJob, type JobLauncher } from "./jobs"

export const READ_TOOL_NAMES = [
  "project_info",
  "story_list",
  "story_read",
  "story_lint",
  "story_paths",
  "story_outline",
  "story_read_passage",
  "story_search",
  "story_pacing",
  "story_sample_transcripts",
  "story_simulate",
  "playtest_run",
  "voice_read",
  "frames_list",
  "review_list",
  "plan_list",
  "plan_read",
  "board_read",
  "marks_open",
  "brief_read",
  "card_read",
  "mark_read",
  "card_view",
] as const

export const WRITE_TOOL_NAMES = [
  "story_write_passage",
  "story_add_passage",
  "story_rename_passage",
  "story_delete_passage",
  "story_batch_edit",
  "voice_note",
  "review_reply",
  "plan_save",
  "implement_edit",
  "plan_mark_implemented",
  "frames_capture",
  "concept_write",
  "mark_claim",
  "mark_reply",
  "board_add_note",
  "board_add_card",
  "board_connect",
  "board_place_row",
  "board_update_note",
  "board_remove_card",
  "concept_request",
  "writing_request",
  "writing_write",
] as const

export type RiverToolName = (typeof READ_TOOL_NAMES)[number] | (typeof WRITE_TOOL_NAMES)[number]

export const RIVER_TOOL_NAMES: readonly RiverToolName[] = [...READ_TOOL_NAMES, ...WRITE_TOOL_NAMES]

export interface RiverToolResult {
  /** What the model reads. Complete on its own. */
  text: string
  /** The same result as structured data, for in-process callers (diffs, plan ids, capture files). Never sent over MCP. */
  data?: unknown
  /** Images the model sees after the text (card_view). */
  images?: { data: string; mimeType: string }[]
}

export interface RiverTool {
  name: RiverToolName
  description: string
  /** A zod raw shape (the MCP SDK `inputSchema` form). */
  inputSchema: Record<string, z.ZodType>
  /** True when the tool writes to the game repo. */
  mutating: boolean
  /** Validates the input against inputSchema, then runs. Throws on any error. */
  handler(input: unknown): Promise<RiverToolResult>
}

export interface RiverToolsOptions {
  /** Engine adapter for frames_capture. Default: picked by manifest.engine. */
  adapter?: EngineAdapter
  /** Who this server writes as: review_reply's default author, and madeBy/by on board writes. Default "agent". Never "you", which is the user. */
  author?: string
  /** The concept job this server works for. concept_write exists only when this is set, and writes only in concepts/<conceptId>/. */
  conceptId?: string
  /** How concept_request starts a job in its own process. Default: River's CLI, `river job start`, detached. */
  jobLauncher?: JobLauncher
  /**
   * The writing job this server works for. writing_write exists only when this is set, and writes only
   * .river/writing/<writingId>/take_<variant>.json. Cannot be set together with conceptId.
   */
  writingId?: string
  /** How writing_request starts a job in its own process. Default: River's CLI, `river write-job start`, detached. */
  writingJobLauncher?: JobLauncher
}

/**
 * The engine adapter for a project: Godot's for engine "godot", else the command adapter when river.json sets
 * `adapter.<engine>.command` (or the engine is "command"). Throws when there is neither.
 */
export function adapterFor(project: Project): EngineAdapter {
  return resolveAdapter(project, [createGodotAdapter()])
}

/** A model id River can pass to `claude --model`: letters, digits and . _ : - only, never a flag. */
const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$/
const modelId = z.string().regex(MODEL_ID, "a model id: letters, digits and . _ : - (at most 100), not starting with a symbol")

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`

/** Throws for a name an agent may not write as: the user ("you") and River's own job role. */
function assertAgentAuthor(author: string): void {
  const name = author.trim().toLowerCase()
  if (name === "you") throw new Error('river: the author "you" is the user; run the server as an agent role such as "claude-code"')
  if (RESERVED_AUTHORS.includes(name)) throw new Error(`river: "${author}" is River's own role; run the server as an agent role such as "claude-code"`)
}

/** The state schema, one variable per line: type, range and starting value. */
function schemaLines(schema: StateSchema): string[] {
  return Object.entries(schema).map(([name, d]) => {
    const range = d.type === "number" || d.type === "int" ? ` ${d.min ?? "-inf"}..${d.max ?? "inf"}` : d.type === "enum" ? ` (${d.values.join(" | ")})` : ""
    return `  ${name}: ${d.type}${range}, initial ${d.initial === undefined ? "(none)" : String(d.initial)}`
  })
}
const formatDiag = (d: Diagnostic) => `${d.severity.padEnd(6)} ${d.message}`
/** A narrative note with its rule code, so the reader can tell a false-choice from an unused-state-var. */
const formatNote = (d: Diagnostic) => `${formatDiag(d)}  (${d.code})`
const diagKey = (d: Diagnostic) => `${d.severity}|${d.code}|${d.message}`

const escapeHeaderPart = (s: string) => s.replace(/[\\[\]{}]/g, (c) => `\\${c}`)

/** Parse one new passage the way the Twee 3 reader will see it in the file. */
function parseOnePassage(name: string, tags: string[], rawText: string, file: string): Passage {
  const header = `:: ${escapeHeaderPart(name)}${tags.length > 0 ? ` [${tags.map(escapeHeaderPart).join(" ")}]` : ""}`
  const body = rawText
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((ln) => (ln.startsWith("::") ? `\\${ln}` : ln))
    .join("\n")
  const passage = parseTwee3(`${header}\n${body}\n`, file).story.passages[0]
  if (!passage || passage.name !== name) throw new Error(`cannot use "${name}" as a passage name`)
  return passage
}

const wordCount = (text: string) => (text.match(/[\p{L}\p{N}][\p{L}\p{N}'’-]*/gu) ?? []).length

function condVars(c: Cond | undefined, out: Set<string>): void {
  if (!c) return
  switch (c.kind) {
    case "cmp": out.add(c.variable); break
    case "and":
    case "or": c.terms.forEach((t) => condVars(t, out)); break
    case "not": condVars(c.term, out); break
    case "visit": break
  }
}

/** Where a passage reads or writes each state variable: variable -> places ("@when", "choice 1 @cost", "prose {when}"). */
function variableUses(p: Passage): Map<string, string[]> {
  const out = new Map<string, string[]>()
  const add = (v: string, where: string) => {
    const list = out.get(v)
    if (!list) out.set(v, [where])
    else if (!list.includes(where)) list.push(where)
  }
  const cond = (c: Cond | undefined, where: string) => {
    const vars = new Set<string>()
    condVars(c, vars)
    vars.forEach((v) => add(v, where))
  }
  cond(p.when, "@when")
  p.onEnter.forEach((e) => add(e.variable, "@set"))
  const refs = templateRefs(proseText(p.text))
  refs.conds.forEach((c) => cond(c, "prose {when}"))
  refs.variables.forEach((v) => add(v, "prose {var}"))
  p.choices.forEach((c, i) => {
    cond(c.when, `choice ${i} @when`)
    c.cost.forEach((e) => add(e.variable, `choice ${i} @cost`))
    c.set.forEach((e) => add(e.variable, `choice ${i} @set`))
  })
  return out
}

/** `@meta` values as they are written: key=value, with a string quoted unless it is a bare word. */
function formatMeta(meta: Record<string, number | string | boolean>): string {
  return Object.entries(meta)
    .map(([k, v]) => {
      const bare = typeof v !== "string" || (/^[A-Za-z_][A-Za-z0-9_.-]*$/.test(v) && v !== "true" && v !== "false")
      return `${k}=${bare ? String(v) : JSON.stringify(v)}`
    })
    .join(", ")
}

/** A passage's rule block as written rules: "@when energy >= 20", "@set bond += 10", "@shot pond", "@meta k=v", "@end". */
function passageRules(p: Passage): string[] {
  const out: string[] = []
  if (p.when) out.push(`@when ${formatCond(p.when)}`)
  if (p.onEnter.length > 0) out.push(`@set ${formatEffects(p.onEnter)}`)
  if (p.auto) out.push("@auto")
  if (p.priority !== undefined) out.push(`@priority ${p.priority}`)
  if (p.weight !== undefined) out.push(`@weight ${p.weight}`)
  if (p.cooldown !== undefined) out.push(`@cooldown ${p.cooldown}`)
  if (p.shot !== undefined) out.push(`@shot ${p.shot}`)
  if (p.meta && Object.keys(p.meta).length > 0) out.push(`@meta ${formatMeta(p.meta)}`)
  for (const c of p.cues ?? []) out.push(`@cue ${c.name}${c.args ? ` ${c.args}` : ""}`)
  if (p.isEnding) out.push("@end")
  return out
}

/** The rules written after a link: "@cost treats 1", "@set bond -= 5", "@when treats >= 1", "@once", "@hint \"...\"". */
function choiceRules(c: Choice): string[] {
  const out: string[] = []
  if (c.cost.length > 0) out.push(`@cost ${c.cost.map((e) => `${e.variable} ${typeof e.amount === "number" ? -e.amount : String(e.amount)}`).join(", ")}`)
  if (c.set.length > 0) out.push(`@set ${formatEffects(c.set)}`)
  if (c.when) out.push(`@when ${formatCond(c.when)}`)
  if (c.once) out.push("@once")
  if (c.hint !== undefined) out.push(`@hint ${JSON.stringify(c.hint)}`)
  if (c.meta && Object.keys(c.meta).length > 0) out.push(`@meta ${formatMeta(c.meta)}`)
  for (const cue of c.cues ?? []) out.push(`@cue ${cue.name}${cue.args ? ` ${cue.args}` : ""}`)
  return out
}

/** "1: Throw a treat -> Treat (id treat)  @cost treats 1": where the choice leads, a broken link marked MISSING. */
function choiceLine(story: Story, c: Choice, i: number, index: StoryIndex): string {
  const to = choiceTarget(story, c.target, index)
  const dest = to.kind === "passage" ? `${c.target} (id ${to.passage.id})` : to.kind === "return" ? `${c.target} (back to the interrupted passage)` : `${c.target} (MISSING: no such passage)`
  const rules = choiceRules(c)
  return `${i}: ${c.label} -> ${dest}${rules.length > 0 ? `  ${rules.join(" ")}` : ""}`
}

/** Every link to a passage that does not exist: `text` is "From [label] -> Target"; `key` names the passage by id, which a rename keeps. */
function brokenLinks(story: Story): { key: string; text: string }[] {
  const index = createStoryIndex(story)
  const out: { key: string; text: string }[] = []
  for (const p of contentPassages(story)) {
    for (const c of p.choices) {
      if (choiceTarget(story, c.target, index).kind === "missing") out.push({ key: `${p.id}\n${c.label}\n${c.target}`, text: `${p.name} [${c.label}] -> ${c.target}` })
    }
  }
  return out
}

/** The broken links `after` has that `before` did not, as "From [label] -> Target". */
function newlyBrokenLinks(before: Story, after: Story): string[] {
  const was = new Set(brokenLinks(before).map((l) => l.key))
  return brokenLinks(after).filter((l) => !was.has(l.key)).map((l) => l.text)
}

/** A passage that got a new name, with its old one. */
interface Rename {
  from: string
  to: string
}

/** Past this many, a rename no longer adds its reading of the old problems (only a story of one-letter names gets here). */
const KNOWN_PROBLEMS_MAX = 5000

/**
 * The keys of the problems a story had before an edit. Lint messages name passages, so after a rename the same
 * problem reads differently: each rename, in order, adds the old problems as they read under the new name, and
 * an edit that only renames reports nothing new.
 */
function knownProblems(before: readonly Diagnostic[], renames: readonly Rename[] = []): Set<string> {
  let all = [...before]
  for (const r of renames) {
    if (all.length > KNOWN_PROBLEMS_MAX) break
    all = [...all, ...all.filter((d) => d.message.includes(r.from)).map((d) => ({ ...d, message: d.message.replaceAll(r.from, r.to) }))]
  }
  return new Set(all.map(diagKey))
}

const passageName = z.string().min(1).regex(/^[^\r\n]+$/, "one line")
const passageTags = z.array(z.string().regex(/^[^\s[\]]+$/, "no spaces or brackets"))

const storyEdit = z.discriminatedUnion("op", [
  z.object({ op: z.literal("write"), passageId: z.string().min(1), rawText: z.string() }).describe("Replace one passage's full raw text (rules block, --, prose and choice lines; not the :: header)"),
  z.object({ op: z.literal("add"), name: passageName, rawText: z.string(), tags: passageTags.optional() }).describe("Append a new passage"),
  z.object({ op: z.literal("rename"), passageId: z.string().min(1), newName: passageName }).describe("Rename a passage; links to it are rewritten and its id stays"),
  z.object({ op: z.literal("delete"), passageId: z.string().min(1) }).describe("Remove a passage; links to it are left as written"),
])

/** One step of story_batch_edit and writing_write. A later edit sees the story the earlier ones left (an added passage's id, a new name). */
export type StoryEdit = z.infer<typeof storyEdit>

/** The most edits one batch or take holds; River's writing jobs read a take's edits back with the same limit. */
const STORY_EDITS_MAX = 64
/** story_read_passage shows at most this many neighbours, the nearest first. */
const NEIGHBOURS_MAX = 24
/** story_search lists at most this many passages. */
const SEARCH_MAX = 50

/** Passage text as the story file keeps it: LF, and no trailing newline (the file puts the blank line between passages). */
const normalRawText = (rawText: string) => rawText.replace(/\r\n?/g, "\n").replace(/\n+$/, "")

/**
 * Apply edits in order to a story in memory. Nothing is read or written. Throws on the first edit that fails,
 * naming it, so the caller writes all of the edits or none.
 */
export function applyStoryEdits(story: Story, edits: readonly StoryEdit[], file: string): { story: Story; applied: string[]; passageIds: string[]; renames: { from: string; to: string }[] } {
  const applied: string[] = []
  const renames: Rename[] = []
  const passageIds = new Set<string>()
  let next = story
  for (const [i, e] of edits.entries()) {
    const target = e.op === "add" ? JSON.stringify(e.name) : e.passageId
    try {
      switch (e.op) {
        case "write":
          next = updatePassageText(next, e.passageId, normalRawText(e.rawText))
          passageIds.add(e.passageId)
          applied.push(`write ${e.passageId}`)
          break
        case "add": {
          if (next.passages.some((p) => p.name === e.name)) throw new Error(`a passage named "${e.name}" already exists`)
          const passage = parseOnePassage(e.name, e.tags ?? [], e.rawText, file)
          if (next.passages.some((p) => p.id === passage.id)) throw new Error(`a passage with id "${passage.id}" already exists; add an @id rule with another id`)
          next = { ...next, passages: [...next.passages, passage] }
          passageIds.add(passage.id)
          applied.push(`add ${e.name} (id ${passage.id})`)
          break
        }
        case "rename": {
          const old = passageById(next, e.passageId)?.name
          next = renamePassage(next, e.passageId, e.newName)
          passageIds.add(e.passageId)
          if (old !== undefined && old !== e.newName) renames.push({ from: old, to: e.newName })
          applied.push(`rename ${e.passageId}: ${old} -> ${e.newName}`)
          break
        }
        case "delete":
          next = deletePassage(next, e.passageId)
          passageIds.delete(e.passageId)
          applied.push(`delete ${e.passageId}`)
          break
      }
    } catch (err) {
      throw new Error(`edit ${i + 1} of ${edits.length} (${e.op} ${target}) failed: ${(err as Error).message}\nNothing was written: fix this edit and send all of them again.`)
    }
  }
  return { story: next, applied, passageIds: [...passageIds], renames }
}

/**
 * The file text a story writes to, checked to read back as the same passages: a name the header cannot hold, or
 * a text line that reads as a new header, would otherwise change the story silently.
 */
function checkedStoryText(story: Story, file: string): { text: string; story: Story; diagnostics: Diagnostic[] } {
  const text = writeTwee3(story)
  const back = parseTwee3(text, file)
  const want = story.passages.map((p) => `${p.id}\n${p.name}`)
  const got = back.story.passages.map((p) => `${p.id}\n${p.name}`)
  const at = want.findIndex((w, i) => w !== got[i])
  if (at !== -1 || got.length !== want.length) {
    const p = story.passages[at === -1 ? want.length - 1 : at]
    const read = back.story.passages[at === -1 ? want.length : at]
    throw new Error(
      `the story would not read back as written: passage "${p?.name}" (id ${p?.id}) reads back as ${read ? `"${read.name}" (id ${read.id})` : "nothing"}. ` +
        "Use a one-line name without leading or trailing spaces, and no text line that starts with ::",
    )
  }
  return { text, story: back.story, diagnostics: back.diagnostics }
}

const narrativeTally = (notes: readonly Diagnostic[]) => {
  const warnings = notes.filter((d) => d.severity === "warn").length
  return { warnings, infos: notes.length - warnings }
}

/** "Narrative notes (...): 1 warning, 2 info", or that there are none. */
function narrativeHeading(notes: readonly Diagnostic[]): string {
  if (notes.length === 0) return "Narrative notes: none."
  const { warnings, infos } = narrativeTally(notes)
  return `Narrative notes (craft advice, never blocks an export): ${plural(warnings, "warning")}, ${infos} info`
}

const WRITING_VARIANTS = ["a", "b", "c", "d", "e"] as const

/** What writing_write stores in .river/writing/<writingId>/take_<variant>.json: one take of a writing job. */
export interface WritingTakeFile {
  version: 1
  writingId: string
  /** "a".."e". Its card is labelled with the upper-case letter. */
  variant: (typeof WRITING_VARIANTS)[number]
  /** One line shown under the take's card. */
  caption: string
  /** What the take changes, in a sentence or two. */
  summary: string
  /** The story file the take rewrites, relative to the project root. */
  storyFile: string
  /** The edits, as checked: applying them in order to the story file gives `text`. A write's rawText is stored with LF line ends and no trailing newline. */
  edits: StoryEdit[]
  /** Ids of the passages the edits wrote, added or renamed. */
  passageIds: string[]
  /** sha256 (hex) of the story file the edits were checked against. */
  baseSha256: string
  /** The whole story file with the edits applied. The story file itself is not changed. */
  text: string
  /** Unified diff from the story file to `text`. */
  diff: string
  /** `lint` errors and warnings in the take's story. */
  lintErrors: number
  lintWarnings: number
  /** `lintNarrative` notes in the take's story. */
  narrativeWarnings: number
  narrativeInfos: number
  /** ISO time. */
  writtenAt: string
}

function define<S extends Record<string, z.ZodType>>(def: {
  name: RiverToolName
  description: string
  inputSchema: S
  mutating: boolean
  run(input: z.infer<z.ZodObject<S>>): Promise<RiverToolResult>
}): RiverTool {
  const schema = z.object(def.inputSchema)
  return {
    name: def.name,
    description: def.description,
    inputSchema: def.inputSchema,
    mutating: def.mutating,
    async handler(input) {
      const parsed = schema.safeParse(input ?? {})
      if (!parsed.success) throw new Error(`invalid input for ${def.name}:\n${z.prettifyError(parsed.error)}`)
      return def.run(parsed.data)
    },
  }
}

const relPath = z.string().min(1).describe("Path relative to the project root, with forward slashes")
const storyFile = z.string().min(1).describe("Story file relative to the project root, e.g. stories/park_walk.twee")
const scalar = z.union([z.number(), z.string(), z.boolean()])

export function createRiverTools(project: Project, opts: RiverToolsOptions = {}): RiverTool[] {
  const defaultAuthor = opts.author ?? "agent"
  // River trusts "you" as the user's own words (a reply that starts a revision), and concept-artist as its job's answer.
  assertAgentAuthor(defaultAuthor)
  if (opts.conceptId !== undefined && opts.writingId !== undefined) throw new Error("river: a server works for a concept job (--concept) or a writing job (--writing), not both")

  /** The story file, checked to be inside the root and one of the project's story files. */
  async function storyRel(file: string): Promise<string> {
    const rel = normalizeRel(file)
    safePath(project, file) // throws "outside the project root" for ../ and absolute paths
    if (!rel) throw new Error(`path "${file}" must be relative to the project root`)
    const stories = await listStories(project)
    const caseInsensitive = process.platform === "win32" || process.platform === "darwin"
    const match = stories.find((s) => s === rel) ?? (caseInsensitive ? stories.find((s) => s.toLowerCase() === rel.toLowerCase()) : undefined)
    if (!match) throw new Error(`"${file}" is not a story file of this project. Story files: ${stories.join(", ") || "(none)"}`)
    return match
  }

  async function readText(rel: string): Promise<string> {
    return readFile(safePath(project, rel), "utf8")
  }

  async function lintFile(rel: string): Promise<{ story: Story; diagnostics: Diagnostic[]; schema: StateSchema }> {
    const schema = await loadSchema(project)
    const { story, diagnostics } = await loadStory(project, rel)
    return { story, diagnostics: [...diagnostics, ...lint(story, schema)], schema }
  }

  /** The narrative craft notes for a story, with the manifest's copy budgets and shot ids. Every one is "info" or "warn". */
  const narrativeFor = (story: Story, schema: StateSchema): Diagnostic[] =>
    lintNarrative(story, schema, { copyBudgets: project.manifest.copyBudgets, shotIds: project.manifest.shots.map((s) => s.id) })

  /**
   * Apply edits to a story file in memory and check the result: the text it would write, read back and linted
   * (lint and narrative notes). Writes nothing. Throws when any edit fails.
   */
  async function stageEdits(file: string, edits: readonly StoryEdit[]) {
    const rel = await storyRel(file)
    const before = await readText(rel)
    const { story, diagnostics: beforeDiags, schema } = await lintFile(rel)
    const { story: next, applied, passageIds, renames } = applyStoryEdits(story, edits, rel)
    const known = knownProblems([...beforeDiags, ...narrativeFor(story, schema)], renames)
    const checked = checkedStoryText(next, rel)
    const diagnostics = [...checked.diagnostics, ...lint(checked.story, schema)]
    const narrative = narrativeFor(checked.story, schema)
    const newlyBroken = newlyBrokenLinks(story, checked.story)
    return { rel, before, beforeDiags, after: checked.text, story: next, applied, passageIds, diagnostics, narrative, known, newlyBroken }
  }

  /** The whole lint and narrative report of a staged story, with the problems the edits brought marked "(new)". */
  function stagedReport(staged: { diagnostics: Diagnostic[]; narrative: Diagnostic[]; known: Set<string> }) {
    const isNew = (d: Diagnostic) => (staged.known.has(diagKey(d)) ? "" : "  (new)")
    const errors = staged.diagnostics.filter((d) => d.severity === "error").length
    const warnings = staged.diagnostics.filter((d) => d.severity === "warn").length
    const newProblems = [...staged.diagnostics, ...staged.narrative].filter((d) => !staged.known.has(diagKey(d)))
    const lines = [`Lint: ${plural(errors, "error")}, ${plural(warnings, "warning")}`, ...staged.diagnostics.map((d) => `${formatDiag(d)}${isNew(d)}`), narrativeHeading(staged.narrative), ...staged.narrative.map((d) => `${formatNote(d)}${isNew(d)}`)]
    return { lines, errors, warnings, newProblems }
  }

  /** Save a changed story, then diff and re-lint it from disk. `notes` go after the lint problems; `renames` are the passages the change renamed. */
  async function writeStory(
    rel: string,
    before: string,
    beforeDiags: Diagnostic[],
    next: Story,
    what: string,
    { notes = [], extra = {}, renames = [] }: { notes?: string[]; extra?: Record<string, unknown>; renames?: Rename[] } = {},
  ): Promise<RiverToolResult> {
    await saveStory(project, rel, next)
    const after = await readText(rel)
    const diff = unifiedDiff(before, after, rel)
    const { diagnostics } = await lintFile(rel)
    const known = knownProblems(beforeDiags, renames)
    const newProblems = diagnostics.filter((d) => !known.has(diagKey(d)) && d.severity !== "info")
    const errors = diagnostics.filter((d) => d.severity === "error").length
    const lines = [what, "", diff || "(no change to the file)"]
    if (newProblems.length > 0) lines.push("New lint problems:", ...newProblems.map(formatDiag))
    else lines.push("No new lint problems.")
    lines.push(...notes, `${plural(errors, "error")} in the file now.`)
    return { text: lines.join("\n"), data: { file: rel, diff, newProblems, diagnostics, ...extra } }
  }

  function passageSummary(story: Story) {
    return story.passages.map((p) => ({
      id: p.id,
      name: p.name,
      tags: p.tags,
      isEnding: p.isEnding,
      choices: p.choices.map((c, index) => ({ index, label: c.label, target: c.target })),
    }))
  }

  const tools: RiverTool[] = [
    define({
      name: "project_info",
      description: "Summary of the River project: name, engine, folders, editable globs, story files, shot ids, and the state variables with their type, range and starting value.",
      inputSchema: {},
      mutating: false,
      async run() {
        const m = project.manifest
        const stories = await listStories(project)
        const schema = await loadSchema(project).catch(() => undefined)
        const data = {
          root: project.root,
          name: m.name,
          engine: m.engine,
          stories: m.stories,
          state: m.state,
          export: m.export,
          editable: m.editable,
          storyFiles: stories,
          shots: m.shots.map((s) => ({ id: s.id, scene: s.scene, count: s.count, ...(s.note ? { note: s.note } : {}) })),
          ...(schema ? { schema } : {}),
        }
        const text = [
          `${m.name} (engine: ${m.engine})`,
          `root: ${project.root}`,
          `stories folder: ${m.stories}, state: ${m.state}, export: ${m.export}`,
          `editable: ${(m.editable ?? []).join(", ")}`,
          `story files: ${stories.join(", ") || "(none)"}`,
          `shots: ${m.shots.map((s) => s.id).join(", ") || "(none)"}`,
          ...(schema ? [`state variables (${m.state}):`, ...schemaLines(schema)] : [`state variables: ${m.state} is missing or invalid`]),
        ].join("\n")
        return { text, data }
      },
    }),

    define({
      name: "story_list",
      description: "List the story files (.twee) with their titles and passage counts.",
      inputSchema: {},
      mutating: false,
      async run() {
        const out: { file: string; title: string; passages: number; start: string }[] = []
        for (const file of await listStories(project)) {
          const { story } = await loadStory(project, file)
          out.push({ file, title: story.title, passages: contentPassages(story).length, start: story.start })
        }
        const text = out.length === 0 ? "No story files." : out.map((s) => `${s.file}  "${s.title}"  ${plural(s.passages, "passage")}, start: ${s.start}`).join("\n")
        return { text, data: out }
      },
    }),

    define({
      name: "story_read",
      description:
        "Read a story file: the raw Twee 3 text, then each passage with id, name, tags and choices, then the state variables (type, range, starting value). Choice indexes start at 0 (the same indexes playtest_run uses).",
      inputSchema: { file: storyFile },
      mutating: false,
      async run({ file }) {
        const rel = await storyRel(file)
        const raw = await readText(rel)
        const { story } = await loadStory(project, rel)
        const passages = passageSummary(story)
        const list = passages.map((p) => {
          const tags = p.tags.length > 0 ? ` [${p.tags.join(" ")}]` : ""
          const choices = p.choices.map((c) => `\n    ${c.index}: ${c.label} -> ${c.target}`).join("")
          return `- ${p.name} (id ${p.id})${tags}${p.isEnding ? " @end" : ""}${choices}`
        })
        const schema = await loadSchema(project).catch(() => undefined)
        const state = schema ? `\n\nState variables (${project.manifest.state}):\n${schemaLines(schema).join("\n")}` : ""
        const text = `${rel}\n\n${raw}\n\nPassages (${passages.length}), start: ${story.start}\n${list.join("\n")}${state}`
        return { text, data: { file: rel, raw, title: story.title, start: story.start, passages } }
      },
    }),

    define({
      name: "story_lint",
      description:
        "Check stories for broken links, dead ends, never-true conditions, unknown variables and type mismatches. Without file, checks every story. " +
        "After the lint summary come the narrative notes (advice, never errors): a state variable nothing reads (unused-state-var), choices that all lead to the same place " +
        "(false-choice), repeated labels or hints (duplicate-copy), copy over its budget (copy-budget-exceeded), a passage no game from the initial state reaches " +
        "(unreachable-from-initial), and a @shot the manifest lacks (unknown-shot). narrative: false leaves them out.",
      inputSchema: {
        file: storyFile.optional(),
        narrative: z.boolean().optional().describe("Also give the narrative craft notes. Default true"),
      },
      mutating: false,
      async run({ file, narrative }) {
        const withNotes = narrative !== false
        const files = file !== undefined ? [await storyRel(file)] : await listStories(project)
        let errors = 0, warnings = 0, infos = 0, passages = 0
        const lines: string[] = []
        const noteLines: string[] = []
        const allNotes: Diagnostic[] = []
        const data: { file: string; diagnostics: Diagnostic[]; narrative?: Diagnostic[] }[] = []
        for (const rel of files) {
          const { story, diagnostics, schema } = await lintFile(rel)
          passages += contentPassages(story).length
          if (files.length > 1) lines.push(rel)
          for (const d of diagnostics) {
            lines.push(formatDiag(d))
            if (d.severity === "error") errors++
            else if (d.severity === "warn") warnings++
            else infos++
          }
          if (!withNotes) {
            data.push({ file: rel, diagnostics })
            continue
          }
          const notes = narrativeFor(story, schema)
          if (files.length > 1 && notes.length > 0) noteLines.push(rel)
          noteLines.push(...notes.map(formatNote))
          allNotes.push(...notes)
          data.push({ file: rel, diagnostics, narrative: notes })
        }
        // The summary line counts lint only, as it did before there were narrative notes: those are advice and follow it.
        let summary = `${plural(errors, "error")}, ${plural(warnings, "warning")}`
        if (infos > 0) summary += `, ${infos} info`
        lines.push(`${summary} in ${plural(passages, "passage")}`)
        if (withNotes) lines.push(narrativeHeading(allNotes), ...noteLines)
        return { text: lines.join("\n"), data: { errors, warnings, files: data, ...(withNotes ? { narrative: narrativeTally(allNotes) } : {}) } }
      },
    }),

    define({
      name: "story_paths",
      description:
        "List every route from the start (or from a passage) to an ending, dead end or loop: each passage with the choice label taken there, then the conditions along it. Routes through [interrupt] passages follow the others. A route is \"never true\" when no state lets a player take it, following @set and @cost along the way. summary: true gives counts by ending instead.",
      inputSchema: {
        file: storyFile,
        from: z.string().optional().describe("Passage name (or id) to start from. Default: the story start"),
        maxPaths: z.number().int().min(1).max(5000).optional().describe("Stop after this many routes. Default 500"),
        summary: z.boolean().optional().describe("Route counts by ending and distinct passage sequences instead of every route"),
      },
      mutating: false,
      async run({ file, from, maxPaths, summary }) {
        const rel = await storyRel(file)
        const schema = await loadSchema(project)
        const { story } = await loadStory(project, rel)
        const max = maxPaths !== undefined ? { maxPaths } : {}
        const routes = paths(story, schema, { ...(from !== undefined ? { from } : {}), ...max })
        const detours = from === undefined ? interruptPaths(story, schema, max) : []
        const lines = summary ? summarizePaths(story, routes, detours) : formatPathList(story, routes, detours)
        if (routes.length === 0) lines.push(from !== undefined ? `no routes (no passage "${from}")` : "no routes (the start passage is missing)")
        return { text: lines.join("\n"), data: { routes, interrupts: detours } }
      },
    }),

    define({
      name: "playtest_run",
      description:
        "Play a story without the engine. Takes a list of choice indexes (0-based, as story_read lists them) and returns the transcript: each passage with its prose as the player reads it " +
        "(templates filled in for the state and the visit), its choices (a closed one says why) and the state after each step. A choice is open when its @when holds, its @cost can be paid, and its target's @when holds after the cost and set. " +
        "steps does more than choices: one step can set state variables (what the engine would change mid-run), start an [interrupt] passage or draw a [storylet] (drawStorylet: true, optional seed) and take a choice, in that order. " +
        "proseOnly returns only the prose the player reads, in order.",
      inputSchema: {
        file: storyFile,
        from: z.string().optional().describe("Passage name (or id) to start from. Default: the story start"),
        choices: z.array(z.number().int().min(0)).optional().describe("Choice indexes to take in order, 0-based"),
        steps: z
          .array(
            z.object({
              set: z.record(z.string(), scalar).optional().describe("State variables to set first, as the engine would (checked against the schema)"),
              interrupt: z.string().min(1).optional().describe("Then start this [interrupt] passage (name or id); its @when must hold"),
              choice: z.number().int().min(0).optional().describe("Then take this choice of the passage on screen, 0-based"),
              drawStorylet: z.literal(true).optional().describe("Draw one open [storylet] from the deck (highest @priority, then random by @weight) and enter it, as a detour. Use alone or before choice"),
              seed: z.number().int().optional().describe("With drawStorylet: seed for a repeatable draw (mulberry32). Default: random"),
            }),
          )
          .optional()
          .describe("Steps to take in order (after choices, when both are given). A step with only set shows the passage again in the new state"),
        state: z.record(z.string(), scalar).optional().describe("Starting values for state variables, over the schema initial values"),
        proseOnly: z.boolean().optional().describe("Only the rendered prose of each passage: no names, choices or state. Default false"),
      },
      mutating: false,
      async run({ file, from, choices, steps: more, state, proseOnly }) {
        const rel = await storyRel(file)
        const schema = await loadSchema(project)
        const { story } = await loadStory(project, rel)
        const play = createPlaytest(story, schema, { ...(from !== undefined ? { from } : {}), ...(state !== undefined ? { state } : {}) })
        type Did = { choice?: number; interrupt?: string; storylet?: string; set?: Record<string, number | string | boolean> }
        const lines: string[] = []
        const prose: string[] = []
        const read = new Map<string, string>()
        const steps: ({ passageId: string; name: string; text: string; state: Record<string, unknown> } & Did)[] = []
        const show = () => {
          const p = play.current()
          const history = play.history()
          lines.push(`== ${p.name} == (id ${p.id})`)
          const text = play.renderedText()
          if (text) lines.push(text)
          // The prose the player reads: each entry to a passage, and a passage still on screen (after a set, or back
          // from an interrupt) only when the new state changed its text.
          const shown = `${play.visits()[p.id] ?? 1}\n${text}`
          if (text && read.get(p.id) !== shown) prose.push(text)
          read.set(p.id, shown)
          for (const c of play.choices()) {
            lines.push(`  ${c.index}: ${c.choice.label} -> ${c.choice.target}${c.choice.hint ? `  (${c.choice.hint})` : ""}${c.closed ? `  [closed: ${formatClosed(c.closed)}]` : ""}`)
          }
          // Only a run that uses steps can start an interrupt, so only there does the transcript say which could start.
          if (more !== undefined && history.at(-1)!.returnTo === undefined && !p.isEnding) {
            for (const i of play.interrupts()) {
              lines.push(`  interrupt ${i.passage.name}${i.open ? "  [can start]" : i.passage.when ? `  [closed: ${formatCond(i.passage.when)}]` : ""}`)
            }
            // The open storylets the deck could draw now (priority and weight decide the draw).
            for (const s of play.storylets()) {
              if (s.open) lines.push(`  storylet ${s.passage.name}  [can draw${s.priority !== 0 ? `, priority ${s.priority}` : ""}${s.weight !== 1 ? `, weight ${s.weight}` : ""}]`)
            }
          }
          const st = play.state()
          lines.push(`  state: ${Object.entries(st).map(([k, v]) => `${k}=${String(v)}`).join(", ")}`)
          if (play.isOver()) lines.push(p.isEnding ? "  -- the end --" : "  -- no open choices --")
          lines.push("")
          return { passageId: p.id, name: p.name, text, state: st }
        }
        const fail = (k: number, what: string, e: unknown): never => {
          throw new Error(`step ${k + 1} (${what}) failed: ${(e as Error).message}\n\nTranscript so far:\n${lines.join("\n")}`)
        }
        steps.push(show())
        const all: NonNullable<typeof more> = [...(choices ?? []).map((choice) => ({ choice })), ...(more ?? [])]
        for (const [k, step] of all.entries()) {
          if (step.set === undefined && step.interrupt === undefined && step.drawStorylet === undefined && step.choice === undefined) fail(k, "empty", new Error("a step needs set, interrupt, drawStorylet or choice"))
          if (step.interrupt !== undefined && step.drawStorylet !== undefined) fail(k, "interrupt and drawStorylet", new Error("a step starts an interrupt or draws a storylet, not both"))
          if (step.seed !== undefined && step.drawStorylet === undefined) fail(k, "seed", new Error("seed only goes with drawStorylet"))
          let did: Did = {}
          if (step.set !== undefined) {
            for (const [name, value] of Object.entries(step.set)) {
              try {
                play.setVar(name, value)
              } catch (e) {
                fail(k, `set ${name}`, e)
              }
            }
            did.set = step.set
            lines.push(`~ set ${Object.entries(step.set).map(([n, v]) => `${n}=${String(v)}`).join(", ")}`, "")
          }
          if (step.interrupt !== undefined || step.drawStorylet !== undefined) {
            if (step.interrupt !== undefined) {
              try {
                play.interrupt(step.interrupt)
              } catch (e) {
                fail(k, `interrupt ${JSON.stringify(step.interrupt)}`, e)
              }
              did.interrupt = play.current().id
              lines.push(`! interrupt: ${play.current().name}`, "")
            } else {
              let drawn: Passage | undefined
              try {
                drawn = play.drawStorylet(step.seed !== undefined ? mulberry32(step.seed) : undefined)
              } catch (e) {
                fail(k, "drawStorylet", e)
              }
              if (!drawn) fail(k, "drawStorylet", new Error(`no storylet is open${play.storylets().length === 0 ? " (the story has no [storylet] passages)" : ""}`))
              did.storylet = play.current().id
              lines.push(`! storylet: ${play.current().name}`, "")
            }
            // The interrupt or storylet passage is shown before the step's own choice is taken in it.
            if (step.choice !== undefined) {
              steps.push({ ...show(), ...did })
              did = {}
            }
          }
          if (step.choice !== undefined) {
            const index = step.choice
            const label = play.choices()[index]?.choice.label
            try {
              play.choose(index)
            } catch (e) {
              fail(k, `choice ${index}`, e)
            }
            did.choice = index
            lines.push(`> ${index}: ${label ?? ""}`, "")
          }
          steps.push({ ...show(), ...did })
        }
        return { text: proseOnly ? prose.join("\n\n") : lines.join("\n").trimEnd(), data: { steps, over: play.isOver(), prose } }
      },
    }),

    define({
      name: "story_outline",
      description:
        "The structure of one story without its prose: each passage's id, name, tags, rules (@when, @set, @auto, @priority, @weight, @cooldown, @shot, @meta, @cue, @end; the last four are what a [storylet] deck and an @auto [interrupt] use) and word count, and each choice with its index, target and rules. " +
        "Start here in a long story, then read the passages you need with story_read_passage.",
      inputSchema: { file: storyFile },
      mutating: false,
      async run({ file }) {
        const rel = await storyRel(file)
        const { story } = await loadStory(project, rel)
        const schema = await loadSchema(project).catch(() => undefined)
        const state = schema ? initialState(schema) : {}
        const index = createStoryIndex(story)
        const passages = contentPassages(story).map((p) => ({
          id: p.id,
          name: p.name,
          tags: p.tags,
          isEnding: p.isEnding,
          rules: passageRules(p),
          words: wordCount(renderProse(proseText(p.text), { state })),
          choices: p.choices.map((c, i) => {
            const to = choiceTarget(story, c.target, index)
            return { index: i, label: c.label, target: c.target, ...(to.kind === "passage" ? { targetId: to.passage.id } : to.kind === "missing" ? { missing: true } : {}), rules: choiceRules(c) }
          }),
        }))
        const words = passages.reduce((n, p) => n + p.words, 0)
        const lines = [`${rel}  "${story.title}"  ${plural(passages.length, "passage")}, ${plural(words, "word")}, start: ${story.start}`]
        for (const [k, p] of contentPassages(story).entries()) {
          const o = passages[k]!
          lines.push(`- ${p.name} (id ${p.id})${p.tags.length > 0 ? ` [${p.tags.join(" ")}]` : ""}${o.rules.length > 0 ? `  ${o.rules.join(" ")}` : ""}  ${plural(o.words, "word")}`)
          p.choices.forEach((c, i) => lines.push(`    ${choiceLine(story, c, i, index)}`))
        }
        return { text: lines.join("\n"), data: { file: rel, title: story.title, start: story.start, words, passages } }
      },
    }),

    define({
      name: "story_read_passage",
      description:
        "Read one passage in full: its raw text, its prose as a new game shows it, the links that lead to it and the links it has. Then its neighbourhood, the passages up to depth links away (in or out) with their raw text, " +
        "and only the state variables these passages use. For work on one scene of a long story, in place of story_read.",
      inputSchema: {
        file: storyFile,
        passageId: z.string().min(1).describe("The passage id (story_outline lists them), or its exact name"),
        depth: z.number().int().min(0).max(2).optional().describe("How many links away the neighbourhood reaches. 0: the passage alone. Default 1, max 2"),
      },
      mutating: false,
      async run({ file, passageId, depth }) {
        const rel = await storyRel(file)
        const { story } = await loadStory(project, rel)
        const schema = await loadSchema(project).catch(() => undefined)
        const index = createStoryIndex(story)
        const focus = index.byId.get(passageId) ?? index.byName.get(passageId)
        if (!focus) throw noPassageError(story, passageId)
        const reach = depth ?? 1

        const distance = new Map<string, number>([[focus.id, 0]])
        let frontier: Passage[] = [focus]
        for (let d = 1; d <= reach; d++) {
          const next: Passage[] = []
          for (const p of frontier) {
            const out = (index.outgoing.get(p.id) ?? []).map((o) => o.to).filter((t): t is Passage => typeof t === "object" && t !== null)
            for (const q of [...out, ...(index.incoming.get(p.id) ?? []).map((i) => i.from)]) {
              if (distance.has(q.id)) continue
              distance.set(q.id, d)
              next.push(q)
            }
          }
          frontier = next
        }
        const around = contentPassages(story)
          .filter((p) => (distance.get(p.id) ?? 0) > 0)
          .sort((a, b) => distance.get(a.id)! - distance.get(b.id)!)
        const shown = around.slice(0, NEIGHBOURS_MAX)

        const tagsOf = (p: Passage) => (p.tags.length > 0 ? ` [${p.tags.join(" ")}]` : "")
        const incoming = (index.incoming.get(focus.id) ?? []).map(({ from, choiceIndex }) => ({ from: from.id, name: from.name, choiceIndex, label: from.choices[choiceIndex]!.label }))
        const rendered = renderProse(proseText(focus.text), { state: schema ? initialState(schema) : {} })
        const lines = [`${focus.name} (id ${focus.id})${tagsOf(focus)} in ${rel}`]
        if (story.start === focus.name) lines.push("The story starts here.")
        if (isInterrupt(focus)) lines.push("An [interrupt] passage: the game can start it from any passage while its @when holds.")
        lines.push("", "Raw text:", focus.rawText, "", "Prose as a new game shows it (initial state, first visit):", rendered || "(none)", "")
        lines.push(`Links to it (${incoming.length}):`, ...incoming.map((l) => `  ${l.name} (id ${l.from}) choice ${l.choiceIndex}: ${l.label}`))
        lines.push(`Its links (${focus.choices.length}):`, ...focus.choices.map((c, i) => `  ${choiceLine(story, c, i, index)}`))
        if (reach > 0) {
          lines.push("", `Neighbourhood, up to ${plural(reach, "link")} away (${plural(around.length, "passage")}${around.length > shown.length ? `, the nearest ${shown.length} shown` : ""}):`)
          for (const p of shown) lines.push("", `:: ${p.name} (id ${p.id})${tagsOf(p)}, ${plural(distance.get(p.id)!, "link")} away`, p.rawText)
        }
        const used = new Set<string>()
        for (const p of [focus, ...shown]) for (const v of variableUses(p).keys()) used.add(v)
        const variables = schema ? Object.fromEntries(Object.entries(schema).filter(([name]) => used.has(name))) : {}
        if (schema) {
          const names = Object.keys(variables)
          lines.push("", names.length > 0 ? `State variables these passages use (${project.manifest.state}):` : "These passages use no state variable.", ...schemaLines(variables))
        }
        return {
          text: lines.join("\n"),
          data: {
            file: rel,
            passage: { id: focus.id, name: focus.name, tags: focus.tags, rawText: focus.rawText, rendered },
            incoming,
            outgoing: focus.choices.map((c, i) => ({ index: i, label: c.label, target: c.target })),
            neighbours: shown.map((p) => ({ id: p.id, name: p.name, distance: distance.get(p.id)!, rawText: p.rawText })),
            variables,
          },
        }
      },
    }),

    define({
      name: "story_search",
      description:
        "Find passages in one story (or, without file, in every story). query: text in a passage's name, prose, choice lines or hints, any case. tag: a passage tag. " +
        "variable: a state variable the passage reads or writes (@when, @set, @cost, prose templates). speaker: who speaks a dialogue line (Rex [excited]: ..., Mara: \"...\"). " +
        "Give at least one; several narrow the result. Each match shows why it matched.",
      inputSchema: {
        file: storyFile.optional(),
        query: z.string().min(1).optional().describe("Text to find, any case"),
        tag: z.string().min(1).optional().describe("A passage tag, e.g. interrupt"),
        variable: z.string().min(1).optional().describe("A state variable name, e.g. bond"),
        speaker: z.string().min(1).optional().describe("A dialogue speaker, e.g. Rex"),
      },
      mutating: false,
      async run({ file, query, tag, variable, speaker }) {
        if (query === undefined && tag === undefined && variable === undefined && speaker === undefined) throw new Error("story_search needs at least one of query, tag, variable, speaker")
        const files = file !== undefined ? [await storyRel(file)] : await listStories(project)
        const clip = (s: string) => (s.length > 160 ? `${s.slice(0, 157)}...` : s)
        const some = (hits: string[]) => (hits.length > 3 ? [...hits.slice(0, 3), `(+${hits.length - 3} more)`] : hits)
        const matches: { file: string; id: string; name: string; tags: string[]; why: string[] }[] = []
        for (const rel of files) {
          const { story } = await loadStory(project, rel)
          for (const p of contentPassages(story)) {
            const why: string[] = []
            if (tag !== undefined && !p.tags.some((t) => t.toLowerCase() === tag.toLowerCase())) continue
            if (query !== undefined) {
              const q = query.toLowerCase()
              const hits: string[] = []
              if (p.name.toLowerCase().includes(q)) hits.push(`name: ${p.name}`)
              const textLines = p.text.split("\n").filter((l) => l.toLowerCase().includes(q))
              hits.push(...textLines.map((l) => `text: ${clip(l.trim())}`))
              // A hint is in its choice line as written; this catches one the line escapes differently.
              for (const c of p.choices) if (c.hint?.toLowerCase().includes(q) && !textLines.some((l) => l.includes(c.hint!))) hits.push(`hint: ${clip(c.hint)}`)
              if (hits.length === 0) continue
              why.push(...some(hits))
            }
            if (variable !== undefined) {
              const uses = variableUses(p).get(variable)
              if (!uses) continue
              why.push(`${variable}: ${uses.join(", ")}`)
            }
            if (speaker !== undefined) {
              const said = parseProseBlocks(proseText(p.text, { keepCues: true })).flatMap((b) => (b.kind === "dialogue" && b.speaker.toLowerCase() === speaker.toLowerCase() ? [b] : []))
              if (said.length === 0) continue
              why.push(...some(said.map((b) => clip(`${b.speaker}${b.mood ? ` [${b.mood}]` : ""}: ${b.text}`))))
            }
            matches.push({ file: rel, id: p.id, name: p.name, tags: p.tags, why })
          }
        }
        const asked = [query !== undefined ? `query ${JSON.stringify(query)}` : "", tag !== undefined ? `tag ${tag}` : "", variable !== undefined ? `variable ${variable}` : "", speaker !== undefined ? `speaker ${speaker}` : ""].filter(Boolean).join(", ")
        const where = file !== undefined ? files[0]! : plural(files.length, "story file")
        if (matches.length === 0) return { text: `No passage matches ${asked} in ${where}.`, data: { matches } }
        const shown = matches.slice(0, SEARCH_MAX)
        const lines = [`${plural(matches.length, "passage")} match${matches.length === 1 ? "es" : ""} ${asked} in ${where}${matches.length > shown.length ? ` (the first ${shown.length} shown)` : ""}:`]
        let last = ""
        for (const m of shown) {
          if (files.length > 1 && m.file !== last) lines.push(m.file)
          last = m.file
          lines.push(`- ${m.name} (id ${m.id})${m.tags.length > 0 ? ` [${m.tags.join(" ")}]` : ""}`, ...m.why.map((w) => `    ${w}`))
        }
        return { text: lines.join("\n"), data: { matches } }
      },
    }),

    define({
      name: "story_pacing",
      description:
        "A pacing summary of one story: passages, words and words per passage, choices per passage, endings, how long the possible routes read (words) and how many decisions they hold, and the longest passages.",
      inputSchema: {
        file: storyFile,
        maxPaths: z.number().int().min(1).max(5000).optional().describe("Count at most this many routes. Default 500"),
      },
      mutating: false,
      async run({ file, maxPaths }) {
        const rel = await storyRel(file)
        const schema = await loadSchema(project)
        const { story } = await loadStory(project, rel)
        const report = pacingReport(story, schema, maxPaths !== undefined ? { maxPaths } : undefined)
        return { text: [rel, ...formatPacingReport(report)].join("\n"), data: { file: rel, ...report } }
      },
    }),

    define({
      name: "story_sample_transcripts",
      description:
        "A table read: a few routes through one story as the player reads them, chosen to reach every ending and as many passages as possible. Each is played from the initial state, " +
        "with the prose templates filled in and every @ rule, link line and cue left out; the choice taken shows as > label. Read these to hear how the story flows before and after you change it.",
      inputSchema: {
        file: storyFile,
        maxTranscripts: z.number().int().min(1).max(20).optional().describe("How many routes at most. Default 5"),
        includeInterrupts: z.boolean().optional().describe("Also read one route through each [interrupt] passage. Default false"),
        proseOnly: z.boolean().optional().describe("Only the prose: no passage names, no choices. Default false"),
      },
      mutating: false,
      async run({ file, maxTranscripts, includeInterrupts, proseOnly }) {
        const rel = await storyRel(file)
        const schema = await loadSchema(project)
        const { story } = await loadStory(project, rel)
        const transcripts = sampleTranscripts(story, schema, {
          ...(maxTranscripts !== undefined ? { maxTranscripts } : {}),
          ...(includeInterrupts !== undefined ? { includeInterrupts } : {}),
          ...(proseOnly !== undefined ? { proseOnly } : {}),
        })
        if (transcripts.length === 0) return { text: `No transcript: ${rel} has no start passage or no route a player can take.`, data: { file: rel, transcripts } }
        const lines = [`${plural(transcripts.length, "transcript")} of ${rel}`]
        transcripts.forEach((t, i) => {
          const end = t.end === "ending" ? `ending: ${t.ending ?? "?"}` : t.end === "return" ? "interrupt, back to the story" : t.end
          lines.push("", `--- ${i + 1} of ${transcripts.length}: ${t.route.join(" > ")} (${end}) ---`, t.text)
          if (!t.complete) lines.push(`(stopped early: ${t.note ?? "the route could not be played from the initial state"})`)
        })
        return { text: lines.join("\n"), data: { file: rel, transcripts } }
      },
    }),

    define({
      name: "story_simulate",
      description:
        "Play many random games of one story without the engine (each step takes a random open choice; with none open it draws a [storylet], else it is a dead end) and report: how often each ending is reached, " +
        "dead ends, how many steps a game takes, the passages and choices no game ever reached, and where each state variable ends up (min/avg/max, or counts). " +
        "The same seed gives the same report. Use it to check balance and that storylets and @auto interrupts actually come up; story_paths and story_pacing are static counts.",
      inputSchema: {
        file: storyFile.optional().describe("Story file. Default: the project's only story file"),
        runs: z.number().int().min(1).max(2000).optional().describe("Games to play. Default 200, max 2000"),
        seed: z.number().int().optional().describe("PRNG seed. Default 1"),
        maxSteps: z.number().int().min(1).max(1000).optional().describe("Choices and draws per game before it counts as stuck. Default 100, max 1000"),
        includeStorylets: z.boolean().optional().describe("Draw a storylet when no choice is open. Default true"),
      },
      mutating: false,
      async run({ file, runs, seed, maxSteps, includeStorylets }) {
        let rel: string
        if (file !== undefined) rel = await storyRel(file)
        else {
          const stories = await listStories(project)
          if (stories.length !== 1) throw new Error(`river: give a story file; this project has ${stories.length === 0 ? "none" : `${stories.length}: ${stories.join(", ")}`}`)
          rel = stories[0]!
        }
        const schema = await loadSchema(project)
        const { story } = await loadStory(project, rel)
        const report = simulateStory(story, schema, {
          runs: runs ?? 200,
          seed: seed ?? 1,
          maxSteps: maxSteps ?? 100,
          includeStorylets: includeStorylets ?? true,
        })
        return { text: [rel, ...formatSimulationReport(report)].join("\n"), data: { file: rel, report } }
      },
    }),

    define({
      name: "voice_read",
      description:
        `Read the narrative bible (${VOICE_FILE}): how the story should sound. The user writes its voice pillars, character voices and anti-patterns; River adds the lines that landed and the lines that were cut. Read it before you write or rewrite prose.`,
      inputSchema: {},
      mutating: false,
      async run() {
        const voice = await readVoice(project.root)
        if (voice === undefined) return { text: `No voice bible yet (${VOICE_FILE} does not exist or is empty).`, data: { voice: null, landed: [], cut: [] } }
        return { text: voice, data: { voice, landed: voiceSection(voice, LANDED_HEADING), cut: voiceSection(voice, CUT_HEADING) } }
      },
    }),

    define({
      name: "frames_list",
      description: "List the shots in river.json with their captures, newest first. Each capture lists its PNG file paths (absolute).",
      inputSchema: {},
      mutating: false,
      async run() {
        const shots = []
        const lines: string[] = []
        for (const s of project.manifest.shots) {
          const captures = await listCaptures(project, s.id)
          shots.push({ id: s.id, scene: s.scene, count: s.count, note: s.note, captures })
          lines.push(`${s.id}  (${s.scene}, ${plural(s.count, "frame")})${s.note ? `  ${s.note}` : ""}`)
          if (captures.length === 0) lines.push("  no captures yet")
          for (const c of captures) {
            lines.push(`  ${c.at}  rev ${c.rev}`)
            for (const f of c.files) lines.push(`    ${f}`)
          }
        }
        if (lines.length === 0) lines.push("No shots in river.json.")
        return { text: lines.join("\n"), data: shots }
      },
    }),

    define({
      name: "review_list",
      description: "List review threads (comments on shots), optionally for one shot.",
      inputSchema: { shotId: z.string().min(1).optional() },
      mutating: false,
      async run({ shotId }) {
        const threads = await listThreads(project, shotId)
        const lines = threads.flatMap((t) => {
          const head = `${t.id}  shot ${t.target.shotId} rev ${t.target.rev}${t.target.frame !== undefined ? ` frame ${t.target.frame}` : ""}${t.target.box ? ` box ${t.target.box.join(",")}` : ""}  [${t.status}]${t.planId ? `  plan ${t.planId}` : ""}`
          return [head, ...t.messages.map((m) => `  ${m.author} (${m.at}): ${m.text}`)]
        })
        return { text: lines.length > 0 ? lines.join("\n") : "No review threads.", data: threads }
      },
    }),

    define({
      name: "plan_list",
      description: "List change plans with their status.",
      inputSchema: {},
      mutating: false,
      async run() {
        const plans = await listPlans(project)
        const lines = plans.map((p) => `${p.id}  [${p.status}]  ${p.title}${p.threadId ? `  (thread ${p.threadId})` : ""}  files: ${p.steps.map((s) => s.file).join(", ")}`)
        return { text: lines.length > 0 ? lines.join("\n") : "No change plans.", data: plans }
      },
    }),

    define({
      name: "plan_read",
      description: "Read one change plan in full.",
      inputSchema: { planId: z.string().min(1) },
      mutating: false,
      async run({ planId }) {
        const plan = await loadPlan(project, planId)
        return { text: JSON.stringify(plan, null, 2), data: plan }
      },
    }),

    define({
      name: "story_write_passage",
      description:
        "Replace the full raw text of one passage (the @ rules block, the -- line, prose and choice lines; not the :: header), save the file, and return a unified diff and any new lint problems.",
      inputSchema: {
        file: storyFile,
        passageId: z.string().min(1).describe("The passage id (from story_read)"),
        rawText: z.string().describe("The new passage text, without the :: header line"),
      },
      mutating: true,
      async run({ file, passageId, rawText }) {
        const rel = await storyRel(file)
        const before = await readText(rel)
        const { story, diagnostics } = await lintFile(rel)
        // The file puts the blank line between passages; a trailing newline in rawText would add another.
        const next = updatePassageText(story, passageId, rawText.replace(/\r\n?/g, "\n").replace(/\n+$/, ""))
        return writeStory(rel, before, diagnostics, next, `Updated passage ${passageId} in ${rel}.`)
      },
    }),

    define({
      name: "story_add_passage",
      description: "Append a new passage to a story file, save it, and return a unified diff and any new lint problems.",
      inputSchema: {
        file: storyFile,
        name: z.string().min(1).regex(/^[^\r\n]+$/, "one line").describe("Passage name, as links name it"),
        rawText: z.string().describe("Passage text, without the :: header line"),
        tags: z.array(z.string().regex(/^[^\s[\]]+$/, "no spaces or brackets")).optional(),
      },
      mutating: true,
      async run({ file, name, rawText, tags }) {
        const rel = await storyRel(file)
        const before = await readText(rel)
        const { story, diagnostics } = await lintFile(rel)
        if (story.passages.some((p) => p.name === name)) throw new Error(`a passage named "${name}" already exists in ${rel}`)
        const passage = parseOnePassage(name, tags ?? [], rawText, rel)
        if (story.passages.some((p) => p.id === passage.id)) throw new Error(`a passage with id "${passage.id}" already exists in ${rel}; add an @id rule with another id`)
        return writeStory(rel, before, diagnostics, { ...story, passages: [...story.passages, passage] }, `Added passage ${name} (id ${passage.id}) to ${rel}.`)
      },
    }),

    define({
      name: "story_rename_passage",
      description:
        "Rename one passage and rewrite every link to it, save the file, and return a unified diff and any new lint problems. The passage id stays (an @id rule is added when the id came from the old name), so cards and layouts keyed by id still match.",
      inputSchema: {
        file: storyFile,
        passageId: z.string().min(1).describe("The passage id (from story_outline or story_read)"),
        newName: passageName.describe("The new passage name, as links will name it"),
      },
      mutating: true,
      async run({ file, passageId, newName }) {
        const rel = await storyRel(file)
        const before = await readText(rel)
        const { story, diagnostics } = await lintFile(rel)
        const old = passageById(story, passageId)
        if (!old) throw noPassageError(story, passageId)
        if (old.name === newName) throw new Error(`passage ${passageId} is already named "${newName}"`)
        const next = renamePassage(story, passageId, newName)
        checkedStoryText(next, rel)
        const links = (createStoryIndex(story).incoming.get(old.id) ?? []).length
        const what = `Renamed passage ${passageId} from "${old.name}" to "${newName}" in ${rel} (${plural(links, "link")} to it). Its id is still ${passageId}.`
        return writeStory(rel, before, diagnostics, next, what, { extra: { passageId, oldName: old.name, newName }, renames: [{ from: old.name, to: newName }] })
      },
    }),

    define({
      name: "story_delete_passage",
      description:
        "Remove one passage, save the file, and return a unified diff, the links the removal broke (they are left as written: point them elsewhere or remove them) and any new lint problems.",
      inputSchema: {
        file: storyFile,
        passageId: z.string().min(1).describe("The passage id (from story_outline or story_read)"),
      },
      mutating: true,
      async run({ file, passageId }) {
        const rel = await storyRel(file)
        const before = await readText(rel)
        const { story, diagnostics } = await lintFile(rel)
        const gone = passageById(story, passageId)
        if (!gone) throw noPassageError(story, passageId)
        const next = deletePassage(story, passageId)
        const broken = newlyBrokenLinks(story, next)
        const notes = broken.length > 0 ? [`Links this broke (${broken.length}); point them at another passage or remove them:`, ...broken.map((l) => `  ${l}`)] : ["No link led to it."]
        if (story.start === gone.name) notes.push(`${gone.name} was the story's start passage: set "start" in StoryData to another passage.`)
        return writeStory(rel, before, diagnostics, next, `Deleted passage ${gone.name} (id ${passageId}) from ${rel}.`, { notes, extra: { passageId, brokenLinks: broken } })
      },
    }),

    define({
      name: "story_batch_edit",
      description:
        "Apply several passage edits to one story file as one change: write (replace a passage's raw text), add, rename and delete, in the order given, each seeing the story the earlier ones left. " +
        "All of them are applied or none: if any edit fails nothing is written and the error names the edit. The file is saved once; the result is one unified diff, then the whole lint report and the narrative notes, " +
        "with every problem the edits brought marked (new). Use it for a rewrite that touches more than one passage.",
      inputSchema: {
        file: storyFile,
        edits: z.array(storyEdit).min(1).max(STORY_EDITS_MAX).describe("The edits, in order. rawText is passage text without the :: header line; passageId is the id, not the name"),
        summary: z.string().max(200).optional().describe("What the change does, in a line. Shown to the user when the client asks them to approve it"),
      },
      mutating: true,
      async run({ file, edits, summary }) {
        const staged = await stageEdits(file, edits)
        await saveStory(project, staged.rel, staged.story)
        const diff = unifiedDiff(staged.before, await readText(staged.rel), staged.rel)
        const report = stagedReport(staged)
        const why = summary?.replace(/\s+/g, " ").trim()
        const lines = [`Applied ${plural(edits.length, "edit")} to ${staged.rel} in one write${why ? ` (${why})` : ""}:`, ...staged.applied.map((a, i) => `  ${i + 1}. ${a}`), "", diff || "(no change to the file)"]
        if (staged.newlyBroken.length > 0) lines.push(`Links these edits broke (${staged.newlyBroken.length}):`, ...staged.newlyBroken.map((l) => `  ${l}`))
        lines.push(...report.lines)
        return {
          text: lines.join("\n"),
          data: { file: staged.rel, diff, applied: staged.applied, passageIds: staged.passageIds, diagnostics: staged.diagnostics, narrative: staged.narrative, newProblems: report.newProblems, brokenLinks: staged.newlyBroken },
        }
      },
    }),

    define({
      name: "voice_note",
      description:
        `Record a line of taste in the narrative bible (${VOICE_FILE}): kind "landed" for a line that sounds right (an example to write toward), "cut" for a line that was thrown out (an example to avoid). ` +
        `It goes under "${LANDED_HEADING}" or "${CUT_HEADING}"; the rest of the file is the user's and is not touched. Record what the user said about a line, not your own guess.`,
      inputSchema: {
        kind: z.enum(["landed", "cut"]),
        key: z
          .string()
          .regex(/^[A-Za-z0-9][A-Za-z0-9 _.:#-]{0,63}$/, "letters, digits, spaces and _ . : # -")
          .optional()
          .describe("Where the line is from, written after it in brackets: a job, take or passage id. A key already in that section is not added twice. Default: a new one"),
        text: z.string().min(1).max(600).describe("The line itself, or the line with a few words on why"),
      },
      mutating: true,
      async run({ kind, key, text }) {
        const line = text.replace(/\s+/g, " ").trim()
        if (!line) throw new Error("voice_note needs a line of text")
        const heading = kind === "landed" ? LANDED_HEADING : CUT_HEADING
        const noteKey = key ?? `${defaultAuthor.replace(/[^A-Za-z0-9_.-]+/g, "-")}-${Date.now().toString(36)}`
        const current = (await readVoice(project.root)) ?? ""
        if (voiceSection(current, heading).some((b) => b === line || b.startsWith(`${line} (`))) {
          return { text: `Already recorded under "${heading}" in ${VOICE_FILE}: ${line}`, data: { added: false, kind, key: noteKey } }
        }
        const added = await (kind === "landed" ? addVoiceExemplar : addVoiceCut)(project.root, noteKey, line)
        if (!added) return { text: `Not added: "${heading}" in ${VOICE_FILE} already has a line with the key (${noteKey}). Pass another key to record this line too.`, data: { added: false, kind, key: noteKey } }
        return { text: `Recorded under "${heading}" in ${VOICE_FILE}:\n- ${line} (${noteKey})`, data: { added: true, kind, key: noteKey, line } }
      },
    }),

    define({
      name: "review_reply",
      description: "Add a reply to a review thread.",
      inputSchema: {
        threadId: z.string().min(1),
        text: z.string().min(1),
        author: z.string().min(1).optional().describe(`Default "${defaultAuthor}". Never "you" (the user) or "concept-artist" (River's jobs)`),
      },
      mutating: true,
      async run({ threadId, text, author }) {
        if (author !== undefined) assertAgentAuthor(author)
        const thread = await reply(project, threadId, author ?? defaultAuthor, text)
        return { text: `Replied to ${threadId} (${plural(thread.messages.length, "message")} now).`, data: thread }
      },
    }),

    define({
      name: "plan_save",
      description:
        "Save a change plan as a draft (.river/plans/<id>.json). The user approves it before anyone implements it. Steps name files relative to the root; only those files can be edited later, and only if they match the editable globs.",
      inputSchema: {
        threadId: z.string().min(1).optional().describe("Review thread this plan answers"),
        title: z.string().min(1),
        rationale: z.string().min(1).describe("Why this change answers the comment"),
        steps: z
          .array(
            z.object({
              file: relPath,
              change: z.string().min(1).describe("What to change in this file, in words"),
              oldText: z.string().optional(),
              newText: z.string().optional(),
            }),
          )
          .min(1),
        recapture: z.array(z.string()).describe("Shot ids to capture again after the change"),
      },
      mutating: true,
      async run({ threadId, title, rationale, steps, recapture }) {
        for (const s of steps) {
          if (!normalizeRel(s.file)) throw new Error(`step file "${s.file}" must be relative to the project root, without '..'`)
          safePath(project, s.file)
        }
        const shotIds = new Set(project.manifest.shots.map((s) => s.id))
        const unknown = recapture.filter((id) => !shotIds.has(id))
        if (unknown.length > 0) throw new Error(`unknown shot ids in recapture: ${unknown.join(", ")}`)
        const plan = await savePlan(project, {
          ...(threadId !== undefined ? { threadId } : {}),
          title,
          rationale,
          steps: steps.map((s) => ({
            file: normalizeRel(s.file)!,
            change: s.change,
            ...(s.oldText !== undefined ? { oldText: s.oldText } : {}),
            ...(s.newText !== undefined ? { newText: s.newText } : {}),
          })),
          recapture,
        })
        return { text: `Saved draft plan ${plan.id}: ${plan.title}. It needs the user's approval before implement_edit can use it.`, data: plan }
      },
    }),

    define({
      name: "implement_edit",
      description:
        "Edit one file named by an APPROVED change plan: replace oldText (must occur exactly once) with newText. Returns a unified diff. Fails if the plan is not approved, the file is not in its steps, or the file is outside the editable globs.",
      inputSchema: {
        planId: z.string().min(1),
        file: relPath,
        oldText: z.string().min(1).describe("Exact text to replace; must occur exactly once in the file"),
        newText: z.string(),
      },
      mutating: true,
      async run({ planId, file, oldText, newText }) {
        const plan = await loadPlan(project, planId)
        assertEditAllowed(project, plan, file)
        const full = safePath(project, file)
        let before: string
        try {
          before = await readFile(full, "utf8")
        } catch (e) {
          throw new Error(`cannot read ${file}: ${(e as Error).message}`)
        }
        let find = oldText
        let put = newText
        if (before.includes("\r\n") && !oldText.includes("\r\n")) {
          find = oldText.replace(/\n/g, "\r\n")
          put = newText.replace(/\r?\n/g, "\r\n")
        }
        const at: number[] = []
        for (let i = before.indexOf(find); i !== -1; i = before.indexOf(find, i + find.length)) at.push(i)
        if (at.length === 0) throw new Error(`oldText was not found in ${file}`)
        if (at.length > 1) throw new Error(`oldText occurs ${at.length} times in ${file}; include more surrounding text so it matches once`)
        const after = before.slice(0, at[0]) + put + before.slice(at[0]! + find.length)
        await writeFile(full, after, "utf8")
        const rel = normalizeRel(file)!
        const diff = unifiedDiff(before, after, rel)
        return { text: `Edited ${rel} for plan ${planId}.\n\n${diff}`, data: { file: rel, diff } }
      },
    }),

    define({
      name: "plan_mark_implemented",
      description: "Mark an approved change plan as implemented, after its edits are done.",
      inputSchema: { planId: z.string().min(1) },
      mutating: true,
      async run({ planId }) {
        const plan: ChangePlan = await loadPlan(project, planId)
        if (plan.status !== "approved") throw new Error(`plan ${planId} is ${plan.status}; only an approved plan can be marked implemented`)
        const saved = await setPlanStatus(project, planId, "implemented")
        const recap = saved.recapture.length > 0 ? ` Shots to capture again: ${saved.recapture.join(", ")}.` : ""
        return { text: `Plan ${planId} is now implemented.${recap}`, data: saved }
      },
    }),

    define({
      name: "frames_capture",
      description:
        "Run the engine to capture shots from river.json. Give shotId for one shot, shotIds for several, or all: true for every shot. " +
        "Saves the PNG frames under .river/captures/<shotId>/ and returns their paths. Several shots run in one engine call when the adapter can batch them.",
      inputSchema: {
        shotId: z.string().min(1).optional().describe("One shot id"),
        shotIds: z.array(z.string().min(1)).max(200).optional().describe("Several shot ids, captured together"),
        all: z.boolean().optional().describe("Capture every shot in river.json"),
      },
      mutating: true,
      async run({ shotId, shotIds, all }) {
        const given = [shotId !== undefined, (shotIds?.length ?? 0) > 0, all === true].filter(Boolean).length
        if (given === 0) throw new Error('frames_capture needs one of: shotId (one shot), shotIds (a non-empty list) or all: true (every shot in river.json)')
        if (given > 1) throw new Error("frames_capture takes only one of shotId, shotIds and all")
        const known = project.manifest.shots.map((s) => s.id)
        const missing = (id: string) => new Error(`no shot "${id}" in river.json. Shots: ${known.join(", ") || "(none)"}`)
        if (shotId !== undefined) {
          if (!known.includes(shotId)) throw missing(shotId)
          const adapter = opts.adapter ?? adapterFor(project)
          const capture = await captureShot(project, shotId, adapter)
          return { text: [`Captured ${shotId} at rev ${capture.rev} (${plural(capture.files.length, "frame")}):`, ...capture.files].join("\n"), data: capture }
        }
        const ids = all === true ? known : [...new Set(shotIds)]
        if (all === true && ids.length === 0) throw new Error("river.json has no shots to capture")
        for (const id of ids) if (!known.includes(id)) throw missing(id)
        const adapter = opts.adapter ?? adapterFor(project)
        const captures = await captureShots(project, ids, adapter)
        const lines = [`Captured ${plural(captures.length, "shot")}:`]
        for (const c of captures) lines.push(`${c.shotId} at rev ${c.rev} (${plural(c.files.length, "frame")}):`, ...c.files.map((f) => `  ${f}`))
        return { text: lines.join("\n"), data: { captures } }
      },
    }),
  ]

  /** writing_write: one take of this server's writing job, checked like story_batch_edit but saved beside the story, never in it. */
  function writingWrite(writingId: string): RiverTool {
    assertWritingId(writingId)
    const folder = writingPath(writingId)
    /** The take file, refused unless it is exactly <root>/.river/writing/<id>/take_<variant>.json with no link leading elsewhere. */
    const takeFile = (variant: string) => {
      const rel = `${folder}/take_${variant}.json`
      const full = safePath(project, rel)
      const want = path.join(realpathSync(project.root), ".river", "writing", writingId, `take_${variant}.json`)
      if (path.resolve(full) !== path.resolve(want)) throw new Error(`river: cannot write ${rel}: it does not resolve inside ${folder}/ of this project (a link leads elsewhere)`)
      return { rel, full }
    }
    return define({
      name: "writing_write",
      description:
        `Write one take of this writing job: a version of the story as a list of passage edits (the edits of story_batch_edit). River applies them to the story file in memory, checks the result and saves the take as ${folder}/take_<variant>.json; ` +
        "the story file itself is never changed, the user reads the takes in River and keeps one. Every take starts from the story as it is on disk, not from another take. " +
        "The result is the take's unified diff, then the lint report and the narrative notes with the problems this take brings marked (new): fix them and write the take again until none is left. " +
        "Writing a variant again replaces it; edits: [] with remove: true deletes it.",
      inputSchema: {
        variant: z.enum(WRITING_VARIANTS).describe("The take's letter; its card is labelled A..E"),
        storyFile,
        caption: z.string().max(160).optional().describe('One line shown under the take\'s card, e.g. "Drier: the dog gets the last word". Needed unless remove'),
        summary: z.string().max(600).optional().describe("What this take changes and why, in a sentence or two. Needed unless remove"),
        edits: z.array(storyEdit).max(STORY_EDITS_MAX).describe("The take's edits, in order. rawText is passage text without the :: header line; passageId is the id, not the name"),
        remove: z.boolean().optional().describe("With edits: [], delete this take"),
      },
      mutating: true,
      async run({ variant, storyFile: file, caption, summary, edits, remove }) {
        const take = takeFile(variant)
        const letter = variant.toUpperCase()
        if (remove) {
          if (edits.length > 0) throw new Error("river: remove deletes the take; send it with edits: []")
          const had = existsSync(take.full)
          await rm(take.full, { force: true })
          return { text: had ? `Removed take ${letter} (${take.rel}).` : `There is no take ${letter} to remove.`, data: { file: take.rel, removed: had } }
        }
        if (edits.length === 0) throw new Error("river: a take needs at least one edit (edits: [] with remove: true deletes a take)")
        const line = caption?.replace(/\s+/g, " ").trim()
        if (!line) throw new Error("river: a take needs a caption: one line that tells this take from the others")
        if (!summary?.trim()) throw new Error("river: a take needs a summary: what it changes and why, in a sentence or two")
        // Stored as applied, so whoever applies the take's edits again gets the same text.
        const stored: StoryEdit[] = edits.map((e) => (e.op === "write" ? { ...e, rawText: normalRawText(e.rawText) } : e))
        const staged = await stageEdits(file, stored)
        const diff = unifiedDiff(staged.before, staged.after, staged.rel)
        if (!diff) throw new Error(`river: these edits change nothing in ${staged.rel}; a take has to differ from the story`)
        const report = stagedReport(staged)
        const notes = narrativeTally(staged.narrative)
        const saved: WritingTakeFile = {
          version: 1,
          writingId,
          variant,
          caption: line,
          summary: summary.trim(),
          storyFile: staged.rel,
          edits: stored,
          passageIds: staged.passageIds,
          baseSha256: createHash("sha256").update(staged.before, "utf8").digest("hex"),
          text: staged.after,
          diff,
          lintErrors: report.errors,
          lintWarnings: report.warnings,
          narrativeWarnings: notes.warnings,
          narrativeInfos: notes.infos,
          writtenAt: new Date().toISOString(),
        }
        await writeAtomic(take.full, `${JSON.stringify(saved, null, 2)}\n`)
        const fresh = report.newProblems.filter((d) => d.severity !== "info")
        const lines = [
          `Wrote take ${letter} of ${staged.rel} to ${take.rel} (${plural(edits.length, "edit")}). The story file is unchanged; the user reads the takes in River and keeps one.`,
          "",
          diff,
        ]
        if (staged.newlyBroken.length > 0) lines.push(`Links this take breaks (${staged.newlyBroken.length}):`, ...staged.newlyBroken.map((l) => `  ${l}`))
        lines.push(...report.lines)
        lines.push(fresh.length > 0 ? `This take brings ${plural(fresh.length, "new problem")}, marked (new) above. Fix that and write take ${letter} again.` : "This take brings no new errors or warnings.")
        return { text: lines.join("\n"), data: { file: take.rel, take: saved, diagnostics: staged.diagnostics, narrative: staged.narrative, newProblems: report.newProblems } }
      },
    })
  }

  tools.push(...boardTools(project, defaultAuthor))
  // A job's own server never starts another job, of either kind.
  if (opts.conceptId !== undefined) tools.push(conceptWrite(project, opts.conceptId))
  else if (opts.writingId !== undefined) tools.push(writingWrite(opts.writingId))
  else {
    tools.push(conceptRequest(project, defaultAuthor, opts.jobLauncher ?? launchConceptJob))
    tools.push(writingRequest(project, defaultAuthor, opts.writingJobLauncher ?? launchWritingJob))
  }
  return tools
}

const SAFE_WRITING_ID = /^[A-Za-z0-9_-]{1,64}$/
/** Device names Windows reserves: a folder named "con" or "nul" cannot be made there. */
const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i

function assertWritingId(writingId: string): void {
  if (typeof writingId !== "string" || !SAFE_WRITING_ID.test(writingId) || WINDOWS_RESERVED.test(writingId)) throw new Error(`river: invalid writing id ${JSON.stringify(writingId)}`)
}

/** .river/writing/<writingId>: where a writing job's takes are kept, relative to the project root. */
export function writingPath(writingId: string): string {
  assertWritingId(writingId)
  return `.river/writing/${writingId}`
}

function conceptWrite(project: Project, conceptId: string): RiverTool {
  assertConceptId(conceptId)
  const folder = conceptPath(conceptId)
  return define({
    name: "concept_write",
    description:
      `Write one file in this job's folder, ${folder}/ (path relative to the project root). The scripts are ${folder}/draw.gd for one drawing, ` +
      "or draw_a.gd..draw_e.gd for up to five options; pass caption with each script (one line shown under its card). " +
      "Replaces the whole file; empty content removes a script. River refuses a script with bytes other than printable ASCII, tabs and LF line ends, or with the word Kit anywhere but in Kit.name(...) calls. " +
      "The user reads and approves every line before anything runs. " +
      "For a script the result lists lint problems; fix them and write the file again until there are none.",
    inputSchema: {
      file: relPath,
      content: z.string().max(200_000).describe("The whole file content. Empty removes a script."),
      caption: z.string().max(200).optional().describe('Scripts only: one short line shown under the option card, e.g. "Low sun: long shadows across the path"'),
    },
    mutating: true,
    async run({ file, content, caption }) {
      const rel = assertConceptFile(conceptId, file)
      const script = rel.endsWith(".gd") ? parseConceptScriptName(path.posix.basename(rel)) : undefined
      if (caption !== undefined && !script) throw new Error(`river: caption is for scripts (draw.gd, draw_a.gd..draw_e.gd), not ${rel}`)
      const full = safePath(project, rel)
      if (script && content === "") {
        await rm(full, { force: true })
        await rm(safePath(project, conceptPath(conceptId, conceptCaptionName(script.variant))), { force: true })
        return { text: `Removed ${rel}.`, data: { file: rel, removed: true, problems: [] } }
      }
      const refused = script ? conceptScriptProblem(Buffer.from(content, "utf8")) : undefined
      if (refused) throw new Error(`river: cannot write ${rel}: ${refused} Write the whole file again.`)
      await mkdir(path.dirname(full), { recursive: true })
      await writeFile(full, content, "utf8")
      if (!script) return { text: `Wrote ${rel}.`, data: { file: rel, problems: [] } }
      if (caption !== undefined) await writeFile(safePath(project, conceptPath(conceptId, conceptCaptionName(script.variant))), caption.replace(/\s+/g, " ").trim(), "utf8")
      const problems = lintConceptScript(content)
      const lines =
        problems.length === 0
          ? [`Wrote ${rel}. Lint: no problems.`]
          : [`Wrote ${rel}, but it does not pass the concept lint. Fix these and write the file again:`, ...problems.map((p) => `- ${p}`)]
      const siblings = (await readdir(path.dirname(full)).catch(() => [] as string[])).map(parseConceptScriptName).filter((s) => s !== undefined)
      if (siblings.some((s) => !s.variant) && siblings.some((s) => s.variant)) {
        lines.push("Note: this folder now has draw.gd and lettered options. A job answers with one or the other; write the one you do not want with empty content to remove it.")
      }
      return { text: lines.join("\n"), data: { file: rel, problems } }
    },
  })
}

const boardName = z.string().regex(/^[a-z0-9_-]{1,64}$/, "a-z, 0-9, _ and -").optional().describe('Board name. Default "main"')
const entityId = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/, "a card or mark id")
const IMAGE_FILE = /\.(png|jpe?g|webp|gif)$/i
const IMAGE_TYPES: Record<string, string> = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".gif": "image/gif" }
/** card_view refuses bigger files: an image block that size costs the model more than it shows. */
const VIEW_MAX_BYTES = 4 * 1024 * 1024
const VIEW_MAX_IMAGES = 4

/**
 * The storyboard tools. Every write is one small file under .river/boards/<board>/, renamed into place, so
 * the River app, River's own jobs and other agents can write the same board at once.
 */
function boardTools(project: Project, author: string): RiverTool[] {
  const root = project.root

  async function board(name: string | undefined): Promise<Board> {
    const b = name ?? DEFAULT_BOARD
    const known = await listBoards(root)
    if (!known.includes(b)) throw new Error(`no board "${b}". Boards: ${known.join(", ") || "(none yet)"}`)
    return loadBoard(root, b)
  }

  /** Where a new card goes: right of `near` (a card or mark), or under everything at the left edge. */
  function startFor(b: Board, near: string | undefined): { x: number; y: number } {
    if (near === undefined) {
      const rects = occupiedRects(b)
      return { x: Math.min(0, ...rects.map((r) => r.x)), y: rects.length > 0 ? Math.max(...rects.map((r) => r.y + r.h)) + BOARD_GAP : 0 }
    }
    const target = elementRect(b, near)
    if (!target) throw new Error(`no card or mark "${near}" on board ${b.name}`)
    return besideRect(target)
  }

  function needMark(b: Board, markId: string): Mark {
    const mark = b.marks.find((m) => m.id === markId)
    if (!mark) throw new Error(`no mark "${markId}" on board ${b.name}`)
    return mark
  }

  /**
   * Where an answer's image card goes and what it hangs off: this author's newest note answering the mark (or the
   * mark itself, before there is one), in the row of cards that note already leads to. River's job notes and the
   * user's arrows are someone else's answer.
   */
  function answerRow(b: Board, markId: string): { head: string; spot: { x: number; y: number }; index: number } {
    const own = b.edges.filter((e) => e.madeBy === author)
    const notes = own.filter((e) => e.from === markId).map((e) => b.cards.find((c) => c.id === e.to && c.kind === "note" && !c.pending)).filter((c): c is Card => c !== undefined)
    const head = notes.at(-1)
    const headId = head?.id ?? markId
    const headRect = head ? cardRect(head) : markRect(needMark(b, markId))
    const row = own.filter((e) => e.from === headId).map((e) => b.cards.find((c) => c.id === e.to && c.kind !== "note")).filter((c): c is Card => c !== undefined)
    const right = Math.max(headRect.x + headRect.w, ...row.map((c) => c.x + c.w))
    return { head: headId, spot: { x: right + BOARD_GAP, y: headRect.y }, index: row.length }
  }

  /**
   * What card an image file under the project makes. A capture River knows is a frame. A concept render is a
   * concept only when a job backs it: an accepted job's kept render beside its script, or a rendered job's
   * pending render in .river/jobs/<job>/. Anything else, under concepts/ too, is a reference that needs a licence.
   */
  async function imageCard(rel: string): Promise<Pick<Card, "kind" | "ref" | "rev" | "capture" | "frame" | "variant" | "pending">> {
    const capture = /^\.river\/captures\/([^/]+)\/[^/]+\/[^/]+$/.exec(rel)
    if (capture) {
      const abs = path.resolve(safePath(project, rel))
      const found = (await listCaptures(project, capture[1]!)).find((c) => c.files.some((f) => path.resolve(f) === abs))
      if (!found) throw new Error(`${rel} is not a frame of a capture River knows (frames_list lists them)`)
      return { kind: "frame", ref: found.shotId, rev: found.rev, capture: found.at, frame: found.files.findIndex((f) => path.resolve(f) === abs) }
    }
    const variantOf = (v: string | undefined) => (v ? { variant: v } : {})
    const pending = /^\.river\/jobs\/(j_[A-Za-z0-9_-]+)\/render(?:_([a-e]))?\.png$/.exec(rel)
    if (pending) {
      const job = await loadJob(root, pending[1]!).catch(() => undefined)
      const script = job?.scripts?.find((s) => s.variant === pending[2] && s.render?.ok)
      if (job && script && (job.status === "answered" || (job.status === "accepted" && script.accepted))) {
        return { kind: "concept", ref: job.conceptId, ...variantOf(pending[2]), ...(job.status === "answered" ? { pending: { markId: job.markId, jobId: job.id } } : {}) }
      }
    }
    const accepted = /^concepts\/([A-Za-z0-9_-]+)\/concept(?:_([a-e]))?\.png$/.exec(rel)
    if (accepted) {
      const backed = (await listJobs(root)).some(
        (j: Job) => j.conceptId === accepted[1] && j.status === "accepted" && j.scripts?.some((s) => s.variant === accepted[2] && s.accepted),
      )
      if (backed) return { kind: "concept", ref: accepted[1]!, ...variantOf(accepted[2]) }
    }
    return { kind: "ref", ref: rel }
  }

  /** The image files a card shows, relative to the root: one for a concept or reference, a capture's frames for a frame card. */
  async function imageFiles(card: Card): Promise<string[]> {
    if (card.kind === "frame") {
      const capture = captureForCard(await listCaptures(project, card.ref), card)
      if (!capture) throw new Error(`shot ${card.ref} has no capture${card.capture ? ` from ${card.capture}` : card.rev ? ` at rev ${card.rev}` : ""}${card.capture || card.rev ? " any more" : " yet"}`)
      const files = card.frame !== undefined ? capture.files.slice(card.frame, card.frame + 1) : capture.files
      return files.map((f) => path.relative(root, f).split(path.sep).join("/"))
    }
    const file = cardImageFile(card)
    if (!file) throw new Error(`${card.id} is a ${card.kind} card, not an image; card_read shows its text`)
    return [file]
  }

  /** Write a card the caller made, so an agent can change and remove its own answer but nobody else's. */
  async function ownCard(b: Board, cardId: string): Promise<Card> {
    const card = await loadCard(root, b.name, cardId)
    if (!card) throw new Error(`no card "${cardId}" on board ${b.name}`)
    if (card.madeBy !== author) throw new Error(`${cardId} was made by ${card.madeBy}; ${author} changes only its own cards`)
    if (card.pending) throw new Error(`${cardId} belongs to River job ${card.pending.jobId}; the user accepts or dismisses it in River`)
    return card
  }

  const edgesOf = (b: Board, id: string) => b.edges.filter((e) => e.from === id || e.to === id)

  return [
    define({
      name: "board_read",
      description:
        "Read a storyboard: every card (id, kind, position and size, option label, caption, what it shows, image file, pending job), every mark (status, job, box, what it is on, thread) and every edge (from -> to). Long text is clipped; card_read and mark_read show it in full. Ids here are what the other board tools take.",
      inputSchema: { board: boardName },
      mutating: false,
      async run({ board: name }) {
        const b = await board(name)
        return { text: formatBoard(b, await frameCardFiles(root, b)), data: b }
      },
    }),

    define({
      name: "marks_open",
      description:
        "List the open marks (requests the user drew on a storyboard that nobody is working on), across every board, oldest first, with what each is on and its thread. Marks that River's concept jobs answer are not listed.",
      inputSchema: {},
      mutating: false,
      async run() {
        const open: { board: Board; mark: Mark }[] = []
        for (const name of await listBoards(root)) {
          const b = await loadBoard(root, name)
          for (const mark of openMarks(b).filter((m) => !m.jobId)) open.push({ board: b, mark })
        }
        open.sort((a, b) => (a.mark.createdAt < b.mark.createdAt ? -1 : a.mark.createdAt > b.mark.createdAt ? 1 : 0))
        const text = open.length === 0 ? "No open marks." : open.flatMap(({ board: b, mark }) => [`board ${b.name}:`, ...formatMark(mark, "  ", b)]).join("\n")
        return { text, data: { marks: open.map(({ board: b, mark }) => ({ board: b.name, mark })) } }
      },
    }),

    define({
      name: "mark_read",
      description: "Read one mark in full: status, claim, job, box, the cards it is on (with their text), the cards its arrows lead to, and every message unclipped.",
      inputSchema: { board: boardName, markId: entityId },
      mutating: false,
      async run({ board: name, markId }) {
        const b = await board(name)
        const mark = needMark(b, markId)
        const [head] = formatMark(mark, "", b)
        const lines = [head!]
        if (mark.claimedAt) lines.push(`claimed at ${mark.claimedAt}`)
        for (const id of mark.anchors) {
          const card = b.cards.find((c) => c.id === id)
          if (card) lines.push(`on: ${formatCard(card, 100_000)}`)
        }
        for (const e of b.edges.filter((e) => e.from === mark.id)) {
          const card = b.cards.find((c) => c.id === e.to)
          lines.push(`answer: ${card ? formatCard(card, 300) : e.to}`)
        }
        lines.push("thread:", ...mark.thread.map((m) => `- ${m.by} (${m.at}):\n${m.text}`))
        return { text: lines.join("\n"), data: mark }
      },
    }),

    define({
      name: "card_read",
      description: "Read one card in full: its whole note text or caption, what it shows (the passage text for a passage card, the image file for an image card), who made it, and its arrows.",
      inputSchema: { board: boardName, cardId: entityId },
      mutating: false,
      async run({ board: name, cardId }) {
        const b = await board(name)
        const card = b.cards.find((c) => c.id === cardId)
        if (!card) throw new Error(`no card "${cardId}" on board ${b.name}`)
        const lines = [formatCard(card, 80)]
        if (card.text !== undefined) lines.push("text:", card.text)
        if (card.caption) lines.push(`caption: ${card.caption}`)
        if (card.source) lines.push(`source: ${[card.source.title, card.source.url, card.source.licence].filter(Boolean).join(", ")}`)
        if (card.kind === "passage") {
          const [file = "", id = ""] = card.ref.split("#")
          const passage = await loadStory(project, file).then(({ story }) => passageById(story, id)).catch(() => undefined)
          lines.push(passage ? `passage ${passage.name} (id ${passage.id}) in ${file}:\n${passage.rawText}` : `passage ${card.ref} is not in the stories any more`)
        }
        for (const e of edgesOf(b, card.id)) lines.push(`edge ${e.id}: ${e.from} -> ${e.to}`)
        return { text: lines.join("\n"), data: card }
      },
    }),

    define({
      name: "card_view",
      description:
        "See an image card: returns the picture itself (a concept render, pending or accepted, a reference image, or a captured frame's images) so you can judge what it shows. Files over 4 MB are refused.",
      inputSchema: { board: boardName, cardId: entityId },
      mutating: false,
      async run({ board: name, cardId }) {
        const b = await board(name)
        const card = b.cards.find((c) => c.id === cardId)
        if (!card) throw new Error(`no card "${cardId}" on board ${b.name}`)
        const files = (await imageFiles(card)).slice(0, VIEW_MAX_IMAGES)
        const images: { data: string; mimeType: string }[] = []
        for (const rel of files) {
          const mimeType = IMAGE_TYPES[path.extname(rel).toLowerCase()]
          if (!mimeType) throw new Error(`${rel} is not a PNG, JPG, WebP or GIF image`)
          const abs = safePath(project, rel)
          const size = await stat(abs).then((s) => s.size).catch(() => undefined)
          if (size === undefined) {
            const wait = card.pending ? ` River job ${card.pending.jobId} has not rendered it yet: the user approves its scripts in River first.` : ""
            throw new Error(`${rel} does not exist.${wait}`)
          }
          if (size > VIEW_MAX_BYTES) throw new Error(`${rel} is ${(size / 1024 / 1024).toFixed(1)} MB; card_view shows images up to 4 MB`)
          images.push({ data: (await readFile(abs)).toString("base64"), mimeType })
        }
        return { text: `${card.id} (${card.kind}${card.label ? ` ${card.label}` : ""}${card.caption ? `, "${card.caption}"` : ""}): ${files.join(", ")}`, data: { card, files }, images }
      },
    }),

    define({
      name: "brief_read",
      description: "Read the project brief (.river/brief.md): what the game should look and feel like, written by the user, and what the user turned down before.",
      inputSchema: {},
      mutating: false,
      async run() {
        const brief = await readBrief(root)
        return { text: brief ?? "No brief yet (.river/brief.md does not exist).", data: { brief: brief ?? null } }
      },
    }),

    define({
      name: "mark_claim",
      description:
        `Take an open mark to work on it: its status becomes "working", claimed by ${author}, and nobody else can claim it or change its status. ` +
        "Fails when another agent or a River job has it. Claiming it again refreshes your claim; a claim untouched for 30 minutes can be taken over.",
      inputSchema: { board: boardName, markId: entityId },
      mutating: true,
      async run({ board: name, markId }) {
        const b = await board(name)
        const mark = await claimMark(root, b.name, markId, author)
        return { text: `Claimed ${mark.id} on board ${b.name} as ${author}.`, data: mark }
      },
    }),

    define({
      name: "mark_reply",
      description:
        `Add a message to a mark's thread, as ${author}. status "answered": your reply and the cards you added answer the mark. "open": give the mark back. ` +
        '"dismissed": you will not do it; the text says why. Only the agent that claimed a mark changes its status. A mark a River job works on keeps the job\'s status, so leave status out there.',
      inputSchema: {
        board: boardName,
        markId: entityId,
        text: z.string().min(1).max(4000),
        status: z.enum(["answered", "open", "dismissed"]).optional(),
      },
      mutating: true,
      async run({ board: name, markId, text, status }) {
        const mark = await replyToMark(root, (await board(name)).name, markId, author, text, status)
        return { text: `Replied on ${mark.id} (${mark.thread.length} messages, status ${mark.status}).`, data: mark }
      },
    }),

    define({
      name: "board_add_note",
      description:
        `Add a note card (text) to a board; it never covers another card. With answers (a mark id) River puts the note beside the mark, under any earlier answer, ` +
        `and draws the arrow mark -> note: use it for every answer. Otherwise it goes right of near, or under everything. Returns the new card id. madeBy ${author}.`,
      inputSchema: {
        board: boardName,
        text: z.string().min(1).max(8000),
        answers: entityId.optional().describe("The mark this note answers"),
        near: entityId.optional().describe("Card or mark id to put the note beside (not with answers)"),
      },
      mutating: true,
      async run({ board: name, text, answers, near }) {
        const b = await board(name)
        if (answers !== undefined && near !== undefined) throw new Error("pass answers or near, not both")
        if (answers !== undefined) needMark(b, answers)
        const card = { kind: "note" as const, w: NOTE_CARD_W, ref: "", text }
        const start = answers !== undefined ? answerStart(b, answers) : startFor(b, near)
        const [spot] = placeRow(start, [{ w: card.w, h: cardHeight(card) }], occupiedRects(b))
        const saved = await saveCard(root, b.name, { ...card, ...spot!, madeBy: author })
        if (answers === undefined) return { text: `Added note ${saved.id} at ${spot!.x},${spot!.y} on board ${b.name}.`, data: saved }
        const edge = await saveEdge(root, b.name, { from: answers, to: saved.id, madeBy: author })
        return { text: `Added note ${saved.id} answering ${answers} at ${spot!.x},${spot!.y} (edge ${edge.id}). Cards you add with answers: ${answers} go in a row beside it.`, data: saved }
      },
    }),

    define({
      name: "board_add_card",
      description:
        "Add an image card for a file under the project (a PNG, JPG, WebP or GIF); it never covers another card. With answers (a mark id) the card joins the row of options " +
        "beside your note answering that mark, labelled A, B, C..., with an arrow note -> card (add the note first). Otherwise it goes right of near, or under everything. " +
        "A frame from .river/captures/ becomes a frame card; a render of a River concept job (.river/jobs/<job>/render_<v>.png, or concepts/<id>/concept_<v>.png once accepted) " +
        "a concept card; these need no licence. Any other image (a reference you found, a PNG you made) is a reference card and needs source.licence. Returns the card id.",
      inputSchema: {
        board: boardName,
        file: relPath.describe("Image file relative to the project root"),
        caption: z.string().max(300).optional().describe("One or two lines under the image"),
        label: z.string().max(8).optional().describe('Short option badge, e.g. "A". With answers the next letter is the default'),
        answers: entityId.optional().describe("The mark this card answers"),
        near: entityId.optional().describe("Card or mark id to put the card beside (not with answers)"),
        source: z
          .object({ licence: z.string().min(1), url: z.string().optional(), title: z.string().optional() })
          .optional()
          .describe("Where the image came from; required for a reference image"),
      },
      mutating: true,
      async run({ board: name, file, caption, label, answers, near, source }) {
        const rel = normalizeRel(file)
        if (!rel) throw new Error(`"${file}" must be relative to the project root, without '..'`)
        if (!IMAGE_FILE.test(rel)) throw new Error(`${rel} is not an image (png, jpg, webp or gif)`)
        if (!existsSync(safePath(project, rel))) throw new Error(`${rel} does not exist`)
        if (answers !== undefined && near !== undefined) throw new Error("pass answers or near, not both")
        const kind = await imageCard(rel)
        if (kind.kind === "ref" && !source) throw new Error(`${rel} is a reference image: pass source.licence (and url or title when you have them)`)
        const b = await board(name)
        const row = answers !== undefined ? answerRow(b, answers) : undefined
        const badge = label ?? (row ? optionLabels(row.index + 1).at(-1) : undefined)
        const card = { ...kind, w: IMAGE_CARD_W, ...(caption ? { caption } : {}), ...(badge ? { label: badge } : {}), ...(kind.kind === "ref" && source ? { source } : {}) }
        const [spot] = placeRow(row?.spot ?? startFor(b, near), [{ w: card.w, h: cardHeight(card) }], occupiedRects(b))
        const saved = await saveCard(root, b.name, { ...card, ...spot!, madeBy: author })
        const what = `${saved.kind} card ${saved.id}${saved.label ? ` [${saved.label}]` : ""} for ${rel} at ${spot!.x},${spot!.y} on board ${b.name}`
        if (!row) return { text: `Added ${what}.`, data: saved }
        const edge = await saveEdge(root, b.name, { from: row.head, to: saved.id, madeBy: author })
        return { text: `Added ${what}, answering ${answers} (edge ${row.head} -> ${saved.id}, ${edge.id}).`, data: saved }
      },
    }),

    define({
      name: "board_update_note",
      description: `Replace the text of a note card you made (madeBy ${author}). Its place and arrows stay.`,
      inputSchema: { board: boardName, cardId: entityId, text: z.string().min(1).max(8000) },
      mutating: true,
      async run({ board: name, cardId, text }) {
        const b = await board(name)
        const card = await ownCard(b, cardId)
        if (card.kind !== "note") throw new Error(`${cardId} is a ${card.kind} card; only a note's text can change`)
        const saved = await saveCard(root, b.name, { ...card, text })
        return { text: `Updated note ${saved.id}.`, data: saved }
      },
    }),

    define({
      name: "board_remove_card",
      description: `Remove a card you made (madeBy ${author}) and the arrows that touch it. Cards of the user, other agents and River's jobs stay.`,
      inputSchema: { board: boardName, cardId: entityId },
      mutating: true,
      async run({ board: name, cardId }) {
        const b = await board(name)
        await ownCard(b, cardId)
        const edges = edgesOf(b, cardId)
        for (const e of edges) await deleteEdge(root, b.name, e.id)
        await deleteCard(root, b.name, cardId)
        return { text: `Removed ${cardId}${edges.length > 0 ? ` and ${plural(edges.length, "arrow")}` : ""}.`, data: { removed: cardId, edges: edges.map((e) => e.id) } }
      },
    }),

    define({
      name: "board_connect",
      description: `Draw a curved arrow from one card or mark to another (frames of a sequence, a card to what it refers to). board_add_note and board_add_card with answers draw the answer's arrows for you. An arrow that already joins the two is returned as it is. madeBy ${author}.`,
      inputSchema: { board: boardName, from: entityId, to: entityId, label: z.string().max(200).optional() },
      mutating: true,
      async run({ board: name, from, to, label }) {
        const b = await board(name)
        for (const id of [from, to]) if (!elementRect(b, id)) throw new Error(`no card or mark "${id}" on board ${b.name}`)
        const existing = b.edges.find((e) => e.from === from && e.to === to)
        if (existing) return { text: `Edge ${existing.id} already joins ${from} -> ${to}.`, data: existing }
        const edge = await saveEdge(root, b.name, { from, to, ...(label ? { label } : {}), madeBy: author })
        return { text: `Connected ${from} -> ${to} (edge ${edge.id}).`, data: edge }
      },
    }),

    define({
      name: "board_place_row",
      description:
        "Move existing cards into one row, in the order given, right of a card or mark (near), level with its top or moved down until it covers nothing. " +
        'Labels them A, B, C... unless you pass labels (one per card; "" leaves a card unlabelled). River\'s pending job cards cannot be moved this way.',
      inputSchema: {
        board: boardName,
        cards: z.array(entityId).min(1).max(26),
        near: entityId,
        labels: z.array(z.string().max(8)).optional(),
      },
      mutating: true,
      async run({ board: name, cards: ids, near, labels }) {
        const b = await board(name)
        if (labels && labels.length !== ids.length) throw new Error(`labels has ${labels.length} entries for ${ids.length} cards`)
        if (ids.includes(near)) throw new Error("near cannot be one of the cards in the row")
        const cards = ids.map((id) => {
          const card = b.cards.find((c) => c.id === id)
          if (!card) throw new Error(`no card "${id}" on board ${b.name}`)
          // A pending option's badge must keep matching its variant: that is the option the user accepts.
          if (card.pending) throw new Error(`${id} is an option of River job ${card.pending.jobId}; River places and labels it`)
          return card
        })
        const names = labels ?? optionLabels(cards.length)
        const placed = cards.map((c, i) => {
          const { label: _old, ...rest } = c
          return names[i] ? { ...rest, label: names[i] } : rest
        })
        const spots = placeRow(startFor(b, near), placed.map((c) => ({ w: c.w, h: cardHeight(c) })), occupiedRects(b, new Set(ids)))
        const saved = await Promise.all(placed.map((c, i) => saveCard(root, b.name, { ...c, ...spots[i]! })))
        return { text: `Placed ${saved.map((c) => `${c.label ?? "-"} ${c.id}`).join(", ")} in a row at ${spots[0]!.x},${spots[0]!.y}.`, data: { cards: saved } }
      },
    }),
  ]
}

const BACKENDS = ["claude-code", "api-key"] as const

/** concept_request: a River concept job for a mark, run by `river job start` in its own process. */
function conceptRequest(project: Project, author: string, launch: JobLauncher): RiverTool {
  const root = project.root
  return define({
    name: "concept_request",
    description:
      "Ask River's concept artist to draw the answer to a mark: the way to answer requests to draw, show or picture something (what does X look like, sketch Y, 3 options for Z). " +
      "It starts a River concept job and returns its id at once; the job takes a few minutes in the background and puts its options beside the mark. " +
      "The user must read and approve the job's scripts in River before anything is drawn, and accepts or dismisses the answer there; the mark then follows the job, so do not answer it yourself.",
    inputSchema: {
      board: boardName,
      markId: entityId,
      backend: z.enum(BACKENDS).optional().describe('Default "claude-code": the user\'s own Claude Code sign-in'),
      model: modelId.optional().describe('Any model id, e.g. claude-haiku-4-5. Default "claude-sonnet-5-5"'),
    },
    mutating: true,
    async run({ board: name, markId, backend, model }) {
      const b = name ?? DEFAULT_BOARD
      const mark = (await loadBoard(root, b)).marks.find((m) => m.id === markId)
      if (!mark) throw new Error(`no mark "${markId}" on board ${b}`)
      const jobId = newBoardId("j_")
      const settings = { backend: backend ?? "claude-code", model: model ?? "claude-sonnet-5-5" } as const
      const started = await launch({ root, board: b, markId, jobId, by: author, ...settings })
      const job = await loadJob(root, jobId).catch(() => undefined)
      return {
        text: [
          `Started River concept job ${jobId} for ${markId} (${settings.backend}, ${settings.model})${job ? `; it is ${job.status}` : ""}. Its log: ${started.log}.`,
          "It runs in the background for a few minutes, then River lays its note and options beside the mark. Nothing is drawn until the user reads and approves the scripts in River (or with river job approve).",
          `The mark now follows the job: do not reply on it with a status. board_read shows the job's cards as pending; card_view shows a render once it exists.`,
        ].join("\n"),
        data: { jobId, log: started.log },
      }
    },
  })
}

/** writing_request: a River writing job for a mark, run by `river write-job start` in its own process. */
function writingRequest(project: Project, author: string, launch: JobLauncher): RiverTool {
  const root = project.root
  return define({
    name: "writing_request",
    description:
      "Ask River's story writer to rewrite the prose a mark is on: the way to answer requests to rewrite, punch up, shorten or re-voice story text (make the pond scene calmer, 3 takes on this line, tighten the ending). " +
      "It starts a River writing job and returns its id at once; the job takes a few minutes in the background and puts its takes beside the mark as cards. " +
      "Nothing in the story changes until the user reads the takes in River and keeps one; the mark then follows the job, so do not answer it yourself.",
    inputSchema: {
      board: boardName,
      markId: entityId,
      backend: z.enum(BACKENDS).optional().describe('Default "claude-code": the user\'s own Claude Code sign-in'),
      model: modelId.optional().describe('Any model id, e.g. claude-haiku-4-5. Default "claude-sonnet-5-5"'),
    },
    mutating: true,
    async run({ board: name, markId, backend, model }) {
      const b = name ?? DEFAULT_BOARD
      const mark = (await loadBoard(root, b)).marks.find((m) => m.id === markId)
      if (!mark) throw new Error(`no mark "${markId}" on board ${b}`)
      const jobId = newBoardId("j_")
      const settings = { backend: backend ?? "claude-code", model: model ?? "claude-sonnet-5-5" } as const
      const started = await launch({ root, board: b, markId, jobId, by: author, ...settings })
      const job = await loadJob(root, jobId).catch(() => undefined)
      return {
        text: [
          `Started River writing job ${jobId} for ${markId} (${settings.backend}, ${settings.model})${job ? `; it is ${job.status}` : ""}. Its log: ${started.log}.`,
          "It runs in the background for a few minutes, then River lays its takes beside the mark. The story files do not change until the user keeps a take in River.",
          `The mark now follows the job: do not reply on it with a status. board_read shows the job's takes as pending cards; card_read shows a take's text.`,
        ].join("\n"),
        data: { jobId, log: started.log },
      }
    },
  })
}
