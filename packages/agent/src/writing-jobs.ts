/**
 * Writing jobs: one agent answers one mark with 2-3 takes on the story, on its own branch in its own worktree.
 * The same state machine, locks, heartbeat and board layout as concept jobs (jobs.ts), minus the script approval:
 * a take is data (passage edits), not code, so nothing runs it, and the job goes straight to "answered".
 *
 *   queued -> running -> answered -> accepted
 *        (any non-terminal state) -> dismissed;  (most states) -> failed -> dismissed
 *
 * The writer turn writes each take with river-mcp's writing_write as .river/writing/<id>/take_<v>.json in the
 * worktree. River reads them back, applies each take's edits in memory to the story as the job started from it,
 * lints the result (lint and lintNarrative), and commits the take files on the job branch. An optional table read
 * (one short turn reading each take's player-facing transcripts) may rewrite the note and captions. On the board:
 * the note, then one note card per take labelled A, B, C, with edges mark -> note -> each take.
 *
 * Accepting a take applies its committed edits to the user's story file (refusing clearly when a passage it edits
 * is gone) and can keep a line of it in .river/voice.md as an exemplar; dismissing with a reason keeps the reason
 * there under "Lines we cut".
 */
import { readFile, writeFile } from "node:fs/promises"
import path from "node:path"
import {
  addVoiceExemplar,
  answerStart,
  cardHeight,
  checkpoint,
  choiceTarget,
  commitJobFile,
  createJobWorktree,
  createStoryIndex,
  gitTop,
  initialState,
  JOB_NEXT,
  jobKind,
  lint,
  lintNarrative,
  listStories,
  loadBoard,
  loadJob,
  loadMark,
  loadProject,
  loadSchema,
  loadStory,
  newBoardId,
  NOTE_CARD_W,
  occupiedRects,
  parseProseBlocks,
  passageById,
  placeRow,
  proseText,
  readBrief,
  readCommittedFile,
  readVoice,
  renderProse,
  safePath,
  sampleTranscripts,
  saveCard,
  saveEdge,
  saveStory,
  WRITER_ROLE,
  writeTwee3,
  type Card,
  type Diagnostic,
  type Job,
  type JobStatus,
  type Mark,
  type Passage,
  type Project,
  type StateSchema,
  type Story,
  type WritingTakeRecord,
} from "@river/core"
import { z } from "zod"
import { unifiedDiff } from "./diff"
import {
  answerIds,
  captionText,
  clip,
  describeCard,
  dismiss,
  dismissJob,
  errMsg,
  fail,
  finishAccept,
  inRepo,
  liveRun,
  NO_SESSION,
  now,
  ownCards,
  parseSelfCheck,
  assertSelfCheckModel,
  selfCheckModelFor,
  quoted,
  removeCards,
  repliesAfter,
  reserveJob,
  SUMMARY_MAX,
  syncMark,
  transition,
  type JobAgentSettings,
  type RunTurn,
} from "./jobs"
import { startAgentTurn } from "./run"
import { applyStoryEdits, StoryEditsSchema, touchedPassages, type StoryEdit } from "./story-edits"
import type { AgentEvent, AgentModel } from "./types"

export { WRITER_ROLE }

export interface WritingJobRequest extends JobAgentSettings {
  /** The user's project root (the folder with river.json). Boards, marks, jobs and voice.md live here. */
  workspaceRoot: string
  board: string
  markId: string
  /** The new job's id, when the caller must know it before the job exists (writing_request). Default: a new one. */
  jobId?: string
  /** Who asks: "you" (the default) or an agent's name, as for concept jobs. */
  by?: string
  /**
   * The story file the takes change, relative to the project root. Default: the story of the first passage card the
   * mark is on, or the project's only story.
   */
  storyFile?: string
}

export interface WritingJobDeps {
  /** Default startAgentTurn. Tests pass a fake that writes known take files. */
  runTurn?: RunTurn
  /** Every event of the agent turns, for progress output. */
  onEvent?: (event: AgentEvent) => void
  /** For RIVER_SELF_CHECK. Default process.env. */
  env?: NodeJS.ProcessEnv
  /**
   * The table read: one more short turn reads each take's player-facing transcripts and may rewrite the note and
   * captions. false skips it; settings run it with them. Default: the job's own model and backend, unless
   * RIVER_SELF_CHECK=off is in `env` (the test suite sets it).
   */
  selfCheck?: false | JobAgentSettings
  /**
   * A different model for the table read (a faster or cheaper one), on the job's own backend. Default: the job's
   * model. Ignored when `selfCheck` gives settings of its own. Must pass isValidModel.
   */
  selfCheckModel?: AgentModel
  /** Aborting stops the table read only (the job is still answered, with the note as the agent wrote it). */
  signal?: AbortSignal
}

/** Take variants, in order. */
export const TAKE_VARIANTS = ["a", "b", "c", "d", "e"] as const

/** Where a writing job's takes are, relative to the project root (in the worktree, and on the job branch). */
export const writingFolder = (writingId: string) => `.river/writing/${writingId}`
export const takeFileName = (variant: string) => `take_${variant}.json`
export const takePath = (writingId: string, variant: string) => `${writingFolder(writingId)}/${takeFileName(variant)}`

/** One take as river-mcp's writing_write stores it. */
export const WritingTakeSchema = z.object({
  variant: z.enum(TAKE_VARIANTS),
  storyFile: z.string().min(1),
  caption: z.string(),
  summary: z.string(),
  edits: StoryEditsSchema,
})

export interface WritingTakeData {
  variant: string
  storyFile: string
  caption: string
  summary: string
  edits: StoryEdit[]
}

/** Apply a take's edits in order to `story` (a new Story; throws naming the first edit that cannot apply). */
export function applyTakeEdits(story: Story, edits: readonly StoryEdit[]): Story {
  return applyStoryEdits(story, edits)
}

/** A take file's text as a take, or an error saying what is wrong with it. */
export function parseTake(text: string, expectVariant?: string): WritingTakeData {
  let raw: unknown
  try {
    raw = JSON.parse(text.replace(/^﻿/, ""))
  } catch (err) {
    throw new Error(`not JSON: ${errMsg(err)}`)
  }
  const parsed = WritingTakeSchema.safeParse(raw)
  if (!parsed.success) throw new Error(z.prettifyError(parsed.error))
  if (expectVariant !== undefined && parsed.data.variant !== expectVariant) {
    throw new Error(`the file is take ${expectVariant} but says variant ${JSON.stringify(parsed.data.variant)}`)
  }
  return parsed.data
}

const STORY_EXT = /\.(twee|tw)$/i
const TAKE_CAPTION_MAX = 60
const TAKE_SUMMARY_MAX = 400
const SELF_CHECK_TURNS = 4
const TABLE_READ_MAX = 3500
const PREVIEW_MAX = 600

/**
 * Where a take may write: a story file of the project (in `manifest.stories`, inside the root), and the job's own
 * story file when the job has one. Committed take files may come from a cloned repo, so this runs at accept too.
 */
async function checkStoryFile(project: Project, job: Pick<Job, "storyFile">, file: string): Promise<string> {
  const rel = file.replace(/\\/g, "/")
  if (!STORY_EXT.test(rel) || path.posix.isAbsolute(rel) || /^[A-Za-z]:/.test(rel)) throw new Error(`${JSON.stringify(file)} is not a story file (.twee or .tw, relative to the project)`)
  safePath(project, rel)
  if (job.storyFile && rel !== job.storyFile) throw new Error(`this job writes ${job.storyFile}, not ${rel}`)
  if (!(await listStories(project)).includes(rel)) throw new Error(`${rel} is not a story of this project (stories are under ${project.manifest.stories}/)`)
  return rel
}

// ---- reviewing a take

/** What River shows about a take: its data, the diff it makes, the new lint problems, and how it reads. */
export interface WritingTakeView extends WritingTakeData {
  /** Unified diff of the story file the take changes. Empty when `error` is set. */
  diff: string
  /** The passages the take writes, adds or renames, with their prose rendered for the initial state. */
  preview: string
  /**
   * lint and lintNarrative problems the take adds to the story, craft notes ("info": false-choice, duplicate-copy,
   * unused-state-var) included. Problems the story already had are left out.
   */
  diagnostics: Diagnostic[]
  lintErrors: number
  lintWarnings: number
  /** Player-facing transcripts of up to two routes through the take, as text. */
  tableRead: string
  /** Set when the take does not apply to the story as it is now. */
  error?: string
}

/**
 * A problem's identity across a take: its message with every passage name written as the passage's id, so a
 * rename (which changes the names in messages) adds no problem, while a new broken link does.
 */
function diagKeyer(...stories: Story[]): (d: Diagnostic) => string {
  const names = new Map<string, string>()
  for (const s of stories) for (const p of s.passages) if (p.name.trim()) names.set(p.name, p.id)
  const sorted = [...names.keys()].sort((a, b) => b.length - a.length)
  return (d) => {
    let msg = d.message
    for (const name of sorted) msg = msg.split(name).join(`#${names.get(name)}`)
    return `${d.severity}|${d.code}|${d.passageId ?? ""}|${msg}`
  }
}

function storyDiagnostics(project: Project, story: Story, schema: StateSchema): Diagnostic[] {
  return [...lint(story, schema), ...lintNarrative(story, schema, { copyBudgets: project.manifest.copyBudgets ?? {}, shotIds: project.manifest.shots.map((s) => s.id) })]
}

const rendered = (p: Passage, schema: StateSchema) => renderProse(proseText(p.text), { state: initialState(schema) }).trim()

/** Apply, lint, diff and read a take against the story in `project` (a worktree or the user's checkout). Throws when it does not apply. */
async function reviewTake(project: Project, data: WritingTakeData): Promise<WritingTakeView> {
  const { story } = await loadStory(project, data.storyFile)
  const schema = await loadSchema(project)
  const after = applyTakeEdits(story, data.edits)
  // Counted, not just seen: a take that adds a second broken link to a passage that had one adds a problem.
  const diagKey = diagKeyer(story, after)
  const known = new Map<string, number>()
  for (const d of storyDiagnostics(project, story, schema)) known.set(diagKey(d), (known.get(diagKey(d)) ?? 0) + 1)
  const diagnostics = storyDiagnostics(project, after, schema).filter((d) => {
    const left = known.get(diagKey(d)) ?? 0
    if (left > 0) known.set(diagKey(d), left - 1)
    return left === 0
  })
  const touched = touchedPassages(after, data.edits)
  const preview = touched.map((p) => `${p.name}\n${rendered(p, schema)}`).join("\n\n")
  const ids = new Set(touched.map((p) => p.id))
  let tableRead = ""
  try {
    const all = sampleTranscripts(after, schema, { maxTranscripts: 6 })
    const through = all.filter((t) => t.route.some((id) => ids.has(id)))
    tableRead = clip((through.length > 0 ? through : all).slice(0, 2).map((t) => t.text).join("\n\n* * *\n\n"), TABLE_READ_MAX)
  } catch {
    // A table read is advice; a story the path search cannot walk still gets its diff and lint.
  }
  return {
    ...data,
    // Both sides through writeTwee3, so the diff shows the take and nothing the writer normalises (CRLF, spacing).
    diff: unifiedDiff(writeTwee3(story), writeTwee3(after), data.storyFile),
    preview,
    diagnostics,
    lintErrors: diagnostics.filter((d) => d.severity === "error").length,
    lintWarnings: diagnostics.filter((d) => d.severity === "warn").length,
    tableRead,
  }
}

/** The take files the turn left in the worktree, parsed, with the problems of those that did not parse. */
async function writtenTakes(dir: string, job: Job): Promise<{ takes: { data: WritingTakeData; bytes: Buffer }[]; problems: string[] }> {
  const out: { data: WritingTakeData; bytes: Buffer }[] = []
  const problems: string[] = []
  for (const v of TAKE_VARIANTS) {
    const bytes = await readFile(path.join(dir, ...takePath(job.conceptId, v).split("/"))).catch(() => undefined)
    if (!bytes) continue
    try {
      out.push({ data: parseTake(bytes.toString("utf8"), v), bytes })
    } catch (err) {
      problems.push(`take ${v.toUpperCase()} (${takePath(job.conceptId, v)}): ${errMsg(err)}`)
    }
  }
  return { takes: out, problems }
}

/** A take as committed on the job branch: the only copy River applies. */
async function committedTake(root: string, job: Job, variant: string): Promise<WritingTakeData> {
  if (!job.headSha) throw new Error(`river: job ${job.id} has no takes yet`)
  const bytes = await readCommittedFile(root, job.headSha, inRepo(job, takePath(job.conceptId, variant)))
  try {
    return parseTake(bytes.toString("utf8"), variant)
  } catch (err) {
    throw new Error(`river: refused: take ${variant.toUpperCase()} of job ${job.id} is not a valid take: ${errMsg(err)}`)
  }
}

/**
 * Every take of a writing job as it would apply to the user's story now: diff, preview, new lint problems and a
 * table read. A take that no longer applies (a passage it edits is gone) comes back with `error` set.
 */
export async function readWritingTakes(workspaceRoot: string, jobId: string): Promise<WritingTakeView[]> {
  const project = await loadProject(workspaceRoot)
  const job = await loadJob(project.root, jobId)
  if (jobKind(job) !== "writing") throw new Error(`river: job ${jobId} is not a writing job`)
  const out: WritingTakeView[] = []
  for (const record of job.takes ?? []) {
    const data = await committedTake(project.root, job, record.variant)
    try {
      await checkStoryFile(project, job, data.storyFile)
      out.push(await reviewTake(project, data))
    } catch (err) {
      out.push({ ...data, diff: "", preview: "", diagnostics: [], lintErrors: 0, lintWarnings: 0, tableRead: "", error: errMsg(err) })
    }
  }
  return out
}

// ---- the answer on the board

const takeLetter = (v: string) => v.toUpperCase()
const lintBadge = (t: Pick<WritingTakeRecord, "lintErrors" | "lintWarnings">) => {
  const e = t.lintErrors ?? 0
  const w = t.lintWarnings ?? 0
  if (e === 0 && w === 0) return "Lint: no new problems"
  return `Lint: new ${[e ? `${e} error${e === 1 ? "" : "s"}` : "", w ? `${w} warning${w === 1 ? "" : "s"}` : ""].filter(Boolean).join(", ")}`
}

/** A take card's text: what it changes, a snippet of its prose, and its lint badge. */
function takeCardText(take: WritingTakeRecord, preview: string): string {
  return [take.summary ?? "", preview ? clip(preview, PREVIEW_MAX) : "", lintBadge(take)].filter((s) => s.trim() !== "").join("\n\n")
}

/** Card height with the caption line drawn above the text. */
const noteHeight = (c: Pick<Card, "w" | "text" | "caption">) => cardHeight({ kind: "note", w: c.w, text: c.caption ? `${c.caption}\n${c.text ?? ""}` : (c.text ?? "") })

/** The faded note that stands for the job while it writes; it becomes the answer's note. */
async function placePlaceholder(root: string, job: Job): Promise<void> {
  const board = await loadBoard(root, job.board)
  const text = "Writing takes..."
  const [spot] = placeRow(answerStart(board, job.markId), [{ w: NOTE_CARD_W, h: noteHeight({ w: NOTE_CARD_W, text }) }], occupiedRects(board))
  await saveCard(root, job.board, { id: answerIds(job).note, kind: "note", ...spot!, w: NOTE_CARD_W, ref: "", text, madeBy: job.role, pending: { markId: job.markId, jobId: job.id } })
}

/** The answer as one row where the placeholder stood: the note, then one card per take labelled A, B, ...; edges mark -> note -> each take. */
async function layoutAnswer(root: string, job: Job, takes: WritingTakeRecord[], previews: ReadonlyMap<string, string>, summary: string): Promise<void> {
  const board = await loadBoard(root, job.board)
  const ids = answerIds(job)
  const own = ownCards(board, job)
  const placeholder = own.find((c) => c.id === ids.note)
  const pending = { markId: job.markId, jobId: job.id }
  const base = { madeBy: job.role, pending, createdAt: now() }
  const note: Card = { ...base, id: ids.note, kind: "note", x: 0, y: 0, w: NOTE_CARD_W, ref: "", text: summary }
  const cards: Card[] = takes.map((t, i) => ({
    ...base,
    id: ids.option(i),
    kind: "note",
    x: 0,
    y: 0,
    w: NOTE_CARD_W,
    ref: "",
    variant: t.variant,
    label: takeLetter(t.variant),
    ...(t.caption ? { caption: t.caption } : {}),
    text: takeCardText(t, previews.get(t.variant) ?? ""),
  }))
  const all = [note, ...cards]
  const start = placeholder ? { x: placeholder.x, y: placeholder.y } : answerStart(board, job.markId)
  const spots = placeRow(start, all.map((c) => ({ w: c.w, h: noteHeight(c) })), occupiedRects(board, new Set(own.map((c) => c.id))))
  const keep = new Set(all.map((c) => c.id))
  await removeCards(root, board, own.filter((c) => !keep.has(c.id)))
  for (const [i, card] of all.entries()) await saveCard(root, job.board, { ...card, ...spots[i]!, createdAt: own.find((c) => c.id === card.id)?.createdAt ?? card.createdAt })
  if (board.marks.some((m) => m.id === job.markId)) await saveEdge(root, job.board, { id: ids.toNote, from: job.markId, to: note.id, madeBy: job.role })
  for (const [i, card] of cards.entries()) await saveEdge(root, job.board, { id: ids.toOption(i), from: note.id, to: card.id, madeBy: job.role })
}

// ---- prompts

/** A passage card for the writer: the passage's full text, where it is entered from and where it leads, with the neighbours' prose. */
async function describePassage(project: Project, card: Card): Promise<string[]> {
  const [file = "", id = ""] = card.ref.split("#")
  let story: Story
  try {
    story = (await loadStory(project, file)).story
  } catch {
    return [`- passage ${card.ref} (the story file could not be read)`]
  }
  const passage = passageById(story, id)
  if (!passage) return [`- passage ${card.ref} (no longer in the story)`]
  const index = createStoryIndex(story)
  const leadsTo = (p: Passage) => p.choices.map((c) => ({ label: c.label, to: choiceTarget(story, c.target, index) }))
  const incoming = story.passages.flatMap((p) => leadsTo(p).filter((l) => l.to.kind === "passage" && l.to.passage === passage).map((l) => ({ from: p, label: l.label })))
  const outgoing = leadsTo(passage).flatMap((l) => (l.to.kind === "passage" ? [{ to: l.to.passage, label: l.label }] : []))
  const lines = [`- passage "${passage.name}" (id ${passage.id}, ${file}). Its full text as written:`, "---", passage.rawText.trimEnd(), "---"]
  if (incoming.length > 0) lines.push("  Entered from:", ...incoming.map((i) => `  - "${i.from.name}" (id ${i.from.id}) by [${i.label}]: ${quoted(proseText(i.from.text), 400)}`))
  if (outgoing.length > 0) lines.push("  Leads to:", ...outgoing.map((o) => `  - [${o.label}] -> "${o.to.name}" (id ${o.to.id}): ${quoted(proseText(o.to.text), 400)}`))
  return lines
}

/** The user's request: the mark's thread, one quoted line per message, then the cards it is on, then where to write. */
async function writingPrompt(project: Project, board: string, mark: Mark, job: Pick<Job, "storyFile" | "passageIds">): Promise<string> {
  const cards = (await loadBoard(project.root, board)).cards
  const lines = [
    'The user marked the storyboard and asked for writing. The mark\'s thread, oldest first, one message per line: who wrote it, then the message in quotes ("you" is the user):',
    ...mark.thread.map((m) => `- ${m.by}: ${quoted(m.text)}`),
  ]
  const anchored = mark.anchors.map((id) => cards.find((c) => c.id === id)).filter((c): c is Card => c !== undefined)
  if (anchored.length > 0) {
    lines.push("", "The mark is on these cards:")
    for (const card of anchored) {
      if (card.kind === "passage") lines.push(...(await describePassage(project, card)))
      else lines.push(`- ${await describeCard(project, card)}`)
    }
  }
  lines.push("")
  if (job.storyFile) lines.push(`Write your takes against ${job.storyFile}${job.passageIds?.length ? `, centred on ${job.passageIds.join(", ")}` : ""}.`)
  else lines.push("The request names no passage: find where it belongs with story_outline and story_search, and say which story file each take changes.")
  return lines.join("\n")
}

/** The previous answer, for a revision: each take with its caption and summary, and its edits when the agent cannot resume. */
async function revisionPrompt(root: string, parent: Job, replies: string[], writingId: string, withEdits: boolean): Promise<string> {
  const lines = [`This revises your previous answer (job ${parent.id}).`]
  if (parent.summary) lines.push(`Your note then: ${quoted(parent.summary)}`)
  for (const t of parent.takes ?? []) {
    lines.push(`- take ${takeLetter(t.variant)}${t.caption ? ` ${quoted(t.caption, 120)}` : ""}${t.summary ? `: ${quoted(t.summary, 400)}` : ""} (${lintBadge(t)})`)
    if (!withEdits || !parent.headSha) continue
    // An accepted job's branch is gone; its kept take is already in the story.
    const data = await committedTake(root, parent, t.variant).catch(() => undefined)
    if (data) lines.push(`  edits: ${JSON.stringify(data.edits)}`)
  }
  if (parent.status === "failed" && parent.error) lines.push(`The job failed: ${parent.error}`)
  const kept = (parent.takes ?? []).filter((t) => t.accepted)
  if (parent.status === "accepted") {
    lines.push(`The user kept ${kept.map((t) => `take ${takeLetter(t.variant)}`).join(" and ") || "nothing"}; it is in the story now, so read the story as it is before you write.`)
  }
  lines.push(
    "",
    replies.length > 0 ? `The user replied, one message per line:\n${replies.map((r) => `- you: ${quoted(r)}`).join("\n")}` : "The user asked for a fix: write takes that River can apply and lint.",
    "",
    `Answer with new takes in this job (writing id ${writingId}) with writing_write. The previous takes are not in this worktree: write out in full whatever you keep. Caption the new takes for what they are now, and say in your note how they answer the reply.`,
  )
  return lines.join("\n")
}

// ---- running a turn

interface Ask {
  prompt: string
  resume?: { sessionId: string; prompt: string }
}

/** One writer-mode turn in `dir` (the job's worktree), collecting the session id, the texts and the errors. */
async function writerTurn(
  dir: string,
  job: Job,
  settings: JobAgentSettings,
  ask: { prompt: string; resume?: string; brief?: string; voice?: string },
  signal: AbortSignal,
  deps: WritingJobDeps,
  runTurn: RunTurn,
): Promise<{ sessionId?: string; texts: string[]; errors: string[] }> {
  const out: { sessionId?: string; texts: string[]; errors: string[] } = { texts: [], errors: [] }
  await runTurn(
    {
      root: dir,
      mode: "writer",
      model: settings.model,
      prompt: ask.prompt,
      backend: settings.backend,
      writingId: job.conceptId,
      ...(job.storyFile ? { storyFile: job.storyFile } : {}),
      ...(ask.resume ? { sessionId: ask.resume } : {}),
      ...(ask.brief ? { brief: ask.brief } : {}),
      ...(ask.voice ? { voice: ask.voice } : {}),
      ...(settings.apiKey ? { apiKey: settings.apiKey } : {}),
      ...(settings.claudePath ? { claudePath: settings.claudePath } : {}),
    },
    {
      onEvent: (e) => {
        deps.onEvent?.(e)
        if (e.type === "session") out.sessionId = e.sessionId
        if (e.type === "text") out.texts.push(e.text.trim())
        if (e.type === "error") out.errors.push(e.message)
      },
      onPermission: async () => ({ behavior: "deny", message: "A writing job asks for nothing: it writes only its own takes." }),
      signal,
    },
  )
  return out
}

/** Who reads the takes back, or undefined to skip (see WritingJobDeps.selfCheck). */
function selfCheckSettings(job: Job, deps: WritingJobDeps): JobAgentSettings | undefined {
  if (deps.selfCheck === false) return undefined
  if (deps.selfCheck) return deps.selfCheck
  if ((deps.env ?? process.env).RIVER_SELF_CHECK === "off") return undefined
  return { model: selfCheckModelFor(job.model, deps.selfCheckModel), backend: job.backend }
}

export const TABLE_READ_ASK = "Table read."

/**
 * The table read: one short turn reads each take's player-facing transcripts and may rewrite the note and captions.
 * It cannot change the takes (River applies only the committed files). Returns the new records and note, or
 * undefined when it is skipped, stopped, or says nothing usable.
 */
async function tableRead(
  project: Project,
  job: Job,
  settings: JobAgentSettings | undefined,
  takes: WritingTakeRecord[],
  views: ReadonlyMap<string, WritingTakeView>,
  summary: string,
  deps: WritingJobDeps,
  signal: AbortSignal,
): Promise<{ takes: WritingTakeRecord[]; summary: string } | undefined> {
  const dir = path.join(job.worktree, job.projectSub)
  if (!settings || signal.aborted) return undefined
  const reads = takes.map((t) => {
    const v = views.get(t.variant)
    return [`Take ${takeLetter(t.variant)} (key "${t.variant}")${t.caption ? `, caption ${quoted(t.caption)}` : ""} (${lintBadge(t)}):`, v?.tableRead || v?.preview || "(no route reaches this take from the start)", ""].join("\n")
  })
  const ask = [
    `${TABLE_READ_ASK} River applied each of your takes to the story and played routes through it. This is the player-facing prose, choices marked with ">":`,
    "",
    ...reads,
    `Your note was: ${quoted(summary)}`,
    "",
    "Read each take aloud in your head. Check it against the voice bible: does each character sound like themselves, does the rhythm hold, are the choices real, does the state the take sets pay off? You cannot change the takes now, so do not call writing_write.",
    "Rewrite the note and the captions so they are true to how the takes read (same rules as before: plain text, under 90 words, one line per take, then your pick). If a take reads badly, say so in the note.",
    'Answer with only this JSON: {"note": "...", "captions": {"a": "..."}} (captions keyed by take letter).',
  ].join("\n")
  const mark = await loadMark(project.root, job.board, job.markId)
  const fresh = mark ? `${await writingPrompt(project, job.board, mark, job)}\n\n${ask}` : ask
  const runTurn = deps.runTurn ?? ((r, h) => startAgentTurn(r, h, { maxTurns: SELF_CHECK_TURNS, effort: "low" }))
  // The system prompt is rendered fresh on every turn, resumed or not, so the brief and voice bible go with both.
  const brief = await readBrief(project.root)
  const voice = await readVoice(project.root)
  const context = { ...(brief ? { brief } : {}), ...(voice ? { voice } : {}) }
  let result = await writerTurn(dir, job, settings, job.sessionId ? { prompt: ask, resume: job.sessionId, ...context } : { prompt: fresh, ...context }, signal, deps, runTurn)
  if (job.sessionId && !signal.aborted && result.errors.some((e) => NO_SESSION.test(e))) result = await writerTurn(dir, job, settings, { prompt: fresh, ...context }, signal, deps, runTurn)
  const parsed = signal.aborted ? undefined : parseSelfCheck(result.texts.join("\n"))
  if (!parsed) return undefined
  return {
    summary: clip(parsed.note.trim(), SUMMARY_MAX),
    takes: takes.map((t) => {
      const caption = captionText(parsed.captions[t.variant] ?? "").slice(0, TAKE_CAPTION_MAX).trimEnd()
      return caption ? { ...t, caption } : t
    }),
  }
}

async function runWritingTurn(project: Project, settings: JobAgentSettings, job: Job, ask: Ask, signal: AbortSignal, deps: WritingJobDeps): Promise<Job> {
  const root = project.root
  let sessionId: string | undefined
  try {
    await syncMark(root, job)
    await placePlaceholder(root, job)
    const created = await createJobWorktree(root, job.id)
    job = await transition(root, job, "running", created)
    const dir = path.join(created.worktree, job.projectSub)
    const runTurn = deps.runTurn ?? ((r, h) => startAgentTurn(r, h))
    const brief = await readBrief(root)
    const voice = await readVoice(root)
    const fresh = { prompt: ask.prompt, ...(brief ? { brief } : {}), ...(voice ? { voice } : {}) }
    let result = await writerTurn(dir, job, settings, ask.resume ? { ...fresh, prompt: ask.resume.prompt, resume: ask.resume.sessionId } : fresh, signal, deps, runTurn)
    if (ask.resume && !signal.aborted && result.errors.some((e) => NO_SESSION.test(e))) {
      result = await writerTurn(dir, job, settings, fresh, signal, deps, runTurn)
    }
    sessionId = result.sessionId
    if (signal.aborted) return await dismiss(root, await loadJob(root, job.id))
    const kept = sessionId ? { sessionId } : {}

    // The base story, schema and manifest come from the worktree: the snapshot the takes were written against.
    const worktree: Project = { root: dir, manifest: project.manifest }
    const written = await writtenTakes(dir, job)
    const problems = [...written.problems]
    const reviewed: { view: WritingTakeView; bytes: Buffer }[] = []
    for (const { data, bytes } of written.takes) {
      try {
        await checkStoryFile(worktree, job, data.storyFile)
        reviewed.push({ view: await reviewTake(worktree, data), bytes })
      } catch (err) {
        problems.push(`take ${takeLetter(data.variant)}: ${errMsg(err)}`)
      }
    }
    if (reviewed.length === 0) {
      const why = problems.length > 0 ? problems : result.errors.length > 0 ? result.errors : [`The writer did not write any take (${writingFolder(job.conceptId)}/take_a.json ...).`]
      return await fail(root, job, why.join("\n"), kept)
    }
    // Every take of one job changes one story file, so accepting any of them means the same thing.
    const storyFile = job.storyFile ?? reviewed[0]!.view.storyFile
    const sameFile = reviewed.filter((r) => r.view.storyFile === storyFile)
    for (const r of reviewed.filter((r) => r.view.storyFile !== storyFile)) problems.push(`take ${takeLetter(r.view.variant)}: changes ${r.view.storyFile}, but this job's takes change ${storyFile}`)

    let headSha = ""
    const views = new Map<string, WritingTakeView>()
    let takes: WritingTakeRecord[] = []
    for (const { view, bytes } of sameFile) {
      headSha = await commitJobFile(root, job.id, inRepo(job, takePath(job.conceptId, view.variant)), bytes, `river: writing ${job.conceptId} take ${view.variant}`)
      views.set(view.variant, view)
      const caption = captionText(view.caption).slice(0, TAKE_CAPTION_MAX).trimEnd()
      const summary = clip(view.summary.replace(/\s+/g, " ").trim(), TAKE_SUMMARY_MAX)
      takes.push({ variant: view.variant, file: view.storyFile, ...(caption ? { caption } : {}), ...(summary ? { summary } : {}), lintErrors: view.lintErrors, lintWarnings: view.lintWarnings })
    }
    let summary = result.texts.at(-1) || `The writer wrote ${takes.map((t) => `take ${takeLetter(t.variant)}`).join(", ")}.`
    if (problems.length > 0) summary = `${summary}\n\nRiver left out: ${problems.join("; ")}`
    summary = clip(summary, SUMMARY_MAX)

    const look = deps.signal ? AbortSignal.any([signal, deps.signal]) : signal
    const checked = await tableRead(project, { ...job, ...kept, storyFile }, selfCheckSettings(job, deps), takes, views, summary, deps, look).catch((err: unknown) => {
      console.warn(`river: job ${job.id}: the table read failed, so the note stays as written: ${errMsg(err)}`)
      return undefined
    })
    if (signal.aborted) return await dismiss(root, await loadJob(root, job.id))
    if (checked) {
      takes = checked.takes
      summary = checked.summary
    }
    await layoutAnswer(root, job, takes, new Map([...views].map(([v, view]) => [v, view.preview])), summary)
    return await transition(root, job, "answered", { headSha, summary, takes, storyFile, ...kept }, summary)
  } catch (err) {
    const ended = await fail(root, job, errMsg(err), sessionId ? { sessionId } : {})
    return ended.status === "dismissed" ? await dismiss(root, ended) : ended
  }
}

function queuedWritingJob(mark: Mark, board: string, settings: JobAgentSettings, scope: Pick<Job, "storyFile" | "passageIds">, parentJobId?: string, jobId?: string): Job {
  const id = jobId ?? newBoardId("j_")
  const at = now()
  return {
    id,
    kind: "writing",
    markId: mark.id,
    board,
    role: WRITER_ROLE,
    model: settings.model,
    backend: settings.backend,
    status: "queued",
    conceptId: id,
    baseSha: "",
    branch: "",
    worktree: "",
    projectSub: "",
    ...(scope.storyFile ? { storyFile: scope.storyFile } : {}),
    ...(scope.passageIds?.length ? { passageIds: scope.passageIds } : {}),
    ...(parentJobId ? { parentJobId } : {}),
    createdAt: at,
    updatedAt: at,
  }
}

/** The story file and passages a request is about: the request's file, else the passage cards the mark is on, else the only story. */
async function writingScope(project: Project, board: string, mark: Mark, storyFile?: string): Promise<Pick<Job, "storyFile" | "passageIds">> {
  const cards = (await loadBoard(project.root, board)).cards
  const passages = mark.anchors
    .map((id) => cards.find((c) => c.id === id))
    .filter((c): c is Card => c?.kind === "passage")
    .map((c) => {
      const [file = "", id = ""] = c.ref.split("#")
      return { file, id }
    })
  const stories = await listStories(project)
  const file = storyFile ?? passages[0]?.file ?? (stories.length === 1 ? stories[0] : undefined)
  if (file !== undefined) await checkStoryFile(project, {}, file).catch((err: unknown) => {
    throw new Error(`river: ${errMsg(err)}`)
  })
  const passageIds = [...new Set(passages.filter((p) => p.file === file && p.id).map((p) => p.id))]
  return { ...(file ? { storyFile: file } : {}), ...(passageIds.length ? { passageIds } : {}) }
}

/** Reserve the job on its mark and run its turn, as the job's one live run in this process. */
function launchWritingJob(project: Project, queued: Job, settings: JobAgentSettings, ask: Ask, deps: WritingJobDeps, reserve: () => Promise<() => void>): Promise<Job> {
  return liveRun(queued.id, async (signal) => {
    const stop = await reserve()
    try {
      return await runWritingTurn(project, settings, queued, ask, signal, deps)
    } finally {
      stop()
    }
  })
}

/**
 * Start a writing job for a mark and run its writer turn. Resolves when the job is "answered" (or "failed", or
 * "dismissed"). Throws only when no job could be created (unknown mark, a job already active on it, a mark another
 * agent holds, not a git repo, a story file that is not the project's).
 */
export async function startWritingJob(req: WritingJobRequest, deps: WritingJobDeps = {}): Promise<Job> {
  assertSelfCheckModel(deps.selfCheckModel)
  const project = await loadProject(req.workspaceRoot)
  const root = project.root
  const mark = await loadMark(root, req.board, req.markId)
  if (!mark) throw new Error(`river: no mark ${req.markId} on board ${req.board}`)
  await gitTop(root).catch(() => {
    throw new Error(`river: writing jobs work on a git branch, but ${root} is not in a git repository`)
  })
  const leadOf = async (m: Mark | undefined) => (m?.jobId ? await loadJob(root, m.jobId).catch(() => undefined) : undefined)
  let previous = await leadOf(mark)
  // Asking again replaces a failed attempt, of either kind.
  while (previous?.status === "failed") {
    await dismissJob(root, previous.id)
    previous = await leadOf(await loadMark(root, req.board, req.markId))
  }
  const scope = await writingScope(project, req.board, mark, req.storyFile)
  const queued = queuedWritingJob(mark, req.board, req, scope, undefined, req.jobId)
  const check = async (m: Mark) => {
    const lead = await leadOf(m)
    if (lead && JOB_NEXT[lead.status].length > 0) {
      throw new Error(`river: mark ${m.id} already has job ${lead.id} (${lead.status})${lead.status === "answered" ? "; reply on the mark and revise it, or dismiss it" : ""}`)
    }
  }
  const ask = { prompt: await writingPrompt(project, req.board, mark, scope) }
  return launchWritingJob(project, queued, req, ask, deps, () => reserveJob(root, queued, req.by ?? "you", check))
}

/**
 * Answer the user's reply on a mark with new takes: a new writing job (parentJobId = jobId) that gets the previous
 * takes and the reply, and resumes the writer's session when there is one. `jobId` must be the mark's latest job:
 * answered or accepted with a reply by the user after its answer, or failed. Resolves like startWritingJob.
 */
export async function reviseWritingJob(workspaceRoot: string, jobId: string, settings: JobAgentSettings, deps: WritingJobDeps = {}): Promise<Job> {
  assertSelfCheckModel(deps.selfCheckModel)
  const project = await loadProject(workspaceRoot)
  const root = project.root
  const parent = await loadJob(root, jobId)
  if (jobKind(parent) !== "writing") throw new Error(`river: job ${jobId} is not a writing job`)
  if (!(["answered", "accepted", "failed"] as JobStatus[]).includes(parent.status)) {
    throw new Error(`river: job ${jobId} is ${parent.status}; only an answered, accepted or failed job can be revised`)
  }
  const mark = await loadMark(root, parent.board, parent.markId)
  if (!mark) throw new Error(`river: no mark ${parent.markId} on board ${parent.board}`)
  const check = async (m: Mark) => {
    if (m.jobId !== parent.id) throw new Error(`river: job ${jobId} is not the latest answer on mark ${m.id} (that is ${m.jobId ?? "none"}); revise that one`)
    if (parent.status !== "failed" && repliesAfter(m, parent).length === 0) throw new Error(`river: reply on mark ${m.id} first: say what to change`)
  }
  await check(mark)
  const replies = repliesAfter(mark, parent)
  const scope = { ...(parent.storyFile ? { storyFile: parent.storyFile } : {}), ...(parent.passageIds ? { passageIds: parent.passageIds } : {}) }
  const queued = queuedWritingJob(mark, parent.board, settings, scope, parent.id)
  const request = await writingPrompt(project, parent.board, mark, scope)
  const ask: Ask = { prompt: `${request}\n\n${await revisionPrompt(root, parent, replies, queued.conceptId, true)}` }
  if (parent.sessionId) ask.resume = { sessionId: parent.sessionId, prompt: await revisionPrompt(root, parent, replies, queued.conceptId, false) }
  return launchWritingJob(project, queued, settings, ask, deps, () => reserveJob(root, queued, "you", check))
}

// ---- accept and dismiss

/** One line of the take worth keeping as an exemplar: its first line of dialogue, else its first paragraph of narration. */
function exemplarLine(after: Story, edits: readonly StoryEdit[], schema: StateSchema): string | undefined {
  for (const p of touchedPassages(after, edits)) {
    const blocks = parseProseBlocks(renderProse(proseText(p.text, { keepCues: true }), { state: initialState(schema) }))
    const line = blocks.find((b) => b.kind === "dialogue") ?? blocks.find((b) => b.kind === "narration")
    if (line?.kind === "dialogue") return clip(`${line.speaker}${line.mood ? ` [${line.mood}]` : ""}: "${line.text}"`, 240)
    if (line?.kind === "narration") return clip(line.text.replace(/\s+/g, " ").trim(), 240)
  }
  return undefined
}

/**
 * Apply take `variant`'s committed edits to the user's story file and mark the job accepted. Refuses (throws, the
 * story and job as they were) when the job is not an answered writing job, the take does not exist, or its edits no
 * longer apply (a passage it edits is gone). A checkpoint of the user's tree is taken first, so the accept can be
 * undone. With `saveExemplar` (the default) a line of the take goes into .river/voice.md under "Lines that landed".
 * Then the kept take's card and the note settle, the other takes' cards go, and so do the worktree and branch.
 */
export async function acceptWritingJob(workspaceRoot: string, jobId: string, opts: { variant: string; saveExemplar?: boolean }): Promise<Job> {
  const project = await loadProject(workspaceRoot)
  const root = project.root
  const job = await loadJob(root, jobId)
  if (jobKind(job) !== "writing") throw new Error(`river: job ${jobId} is not a writing job; accept it with acceptJob`)
  if (job.status !== "answered") throw new Error(`river: job ${jobId} is ${job.status}; only an answered job can be accepted`)
  const variant = opts.variant.trim().toLowerCase()
  const offered = (job.takes ?? []).map((t) => t.variant)
  if (!offered.includes(variant)) throw new Error(`river: job ${jobId} has no take ${takeLetter(variant)}; it offers ${offered.map(takeLetter).join(", ") || "none"}`)
  const data = await committedTake(root, job, variant)
  let file: string
  try {
    file = await checkStoryFile(project, job, data.storyFile)
  } catch (err) {
    throw new Error(`river: refused: take ${takeLetter(variant)} of job ${jobId}: ${errMsg(err)}`)
  }
  const { story } = await loadStory(project, file)
  let after: Story
  try {
    after = applyTakeEdits(story, data.edits)
  } catch (err) {
    throw new Error(`river: take ${takeLetter(variant)} of job ${jobId} no longer applies to ${file}: ${errMsg(err)}. The story changed since the take was written; reply on the mark to revise, or dismiss the job.`)
  }
  await checkpoint(root, `accept take ${takeLetter(variant)} of ${jobId}`).catch((err: unknown) => console.warn(`river: could not checkpoint before accepting job ${jobId}: ${errMsg(err)}`))
  const abs = safePath(project, file)
  const before = await readFile(abs)
  await saveStory(project, file, after)
  let accepted: Job
  try {
    accepted = await transition(root, job, "accepted", { takes: job.takes!.map((t) => (t.variant === variant ? { ...t, accepted: true } : t)) })
  } catch (err) {
    // Another process can dismiss the job between the write and this move; then the story goes back as it was.
    if ((await loadJob(root, jobId)).status !== "accepted") await writeFile(abs, before)
    throw err
  }
  if (opts.saveExemplar !== false) {
    const line = exemplarLine(after, data.edits, await loadSchema(project).catch(() => ({})))
    if (line) await addVoiceExemplar(root, `${jobId}/${variant}`, line).catch((err: unknown) => console.warn(`river: job ${jobId} is accepted, but its line could not be added to .river/voice.md: ${errMsg(err)}`))
  }
  await finishAccept(root, accepted).catch((err: unknown) => console.warn(`river: job ${jobId} is accepted, but tidying up failed (retried when the project next opens): ${errMsg(err)}`))
  return accepted
}

/**
 * Throw a writing job away from any non-terminal state (dismissJob does the same for either kind). `reason`, when
 * given, goes into .river/voice.md under "Lines we cut", so the next writer avoids it.
 */
export async function dismissWritingJob(workspaceRoot: string, jobId: string, reason?: string): Promise<Job> {
  const root = (await loadProject(workspaceRoot)).root
  const job = await loadJob(root, jobId)
  if (jobKind(job) !== "writing") throw new Error(`river: job ${jobId} is not a writing job; dismiss it with dismissJob`)
  return dismissJob(root, jobId, reason)
}

/** The pending cards of a writing job: its note and one card per take. */
export async function writingJobCards(workspaceRoot: string, job: Job): Promise<Card[]> {
  return ownCards(await loadBoard(workspaceRoot, job.board), job)
}
