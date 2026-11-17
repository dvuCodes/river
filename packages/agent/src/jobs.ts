/**
 * Concept jobs: one agent answers one mark with Godot drawing scripts, on its own branch in its own
 * worktree. The job is a state machine over core JOB_NEXT; every move goes through `transition`, which
 * also keeps the mark's status in step with all of the mark's jobs (MARK_STATUS_FOR_JOB).
 *
 *   queued -> running -> approval -> rendering -> answered -> accepted
 *        (any non-terminal state) -> dismissed;  (most states) -> failed -> dismissed
 *
 * A job writes draw.gd, or up to five options draw_a.gd..draw_e.gd. Nothing runs them until
 * approveJobScripts gets the sha256 of every script's exact bytes. Those bytes are read once, from the
 * job's commit, then hashed, rendered and later applied. At approval the answer is laid out on the
 * board: the agent's note, then one card per option in a row beside the mark, with edges
 * mark -> note -> each option. A reply on the mark can start a revision (reviseJob), a new job whose
 * row goes under the previous one.
 */
import { createHash } from "node:crypto"
import { mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises"
import { hostname } from "node:os"
import path from "node:path"
import { conceptScriptBytesProblem, godotSettings, lintConceptScript, renderConcept, type RenderConceptRequest } from "@river/adapter-godot"
import {
  addTurnedDown,
  applyJobFiles,
  BOARD_GAP,
  besideRect,
  cardHeight,
  cardRect,
  commitJobFile,
  conceptCaptionName,
  conceptPath,
  conceptRenderName,
  createJobWorktree,
  deleteCard,
  deleteEdge,
  gitTop,
  IMAGE_CARD_W,
  JOB_NEXT,
  jobRenderName,
  listJobBranches,
  listJobs,
  loadBoard,
  loadJob,
  loadMark,
  loadProject,
  loadStory,
  MARK_STATUS_FOR_JOB,
  markRect,
  newBoardId,
  NOTE_CARD_W,
  occupiedRects,
  parseConceptScriptName,
  passageById,
  placeRow,
  proseText,
  readBrief,
  readCommittedFile,
  removeJobWorktree,
  saveCard,
  saveEdge,
  saveJob,
  saveMark,
  type Board,
  type Card,
  type Job,
  type JobScriptRecord,
  type JobStatus,
  type Mark,
  type Project,
} from "@river/core"
import { startAgentTurn } from "./run"
import type { AgentBackend, AgentEvent, AgentModel, AgentTurnHandlers, AgentTurnRequest } from "./types"

/** Who runs a job's agent turn. */
export interface JobAgentSettings {
  model: AgentModel
  backend: AgentBackend
  apiKey?: string
  claudePath?: string
}

export interface ConceptJobRequest extends JobAgentSettings {
  /** The user's project root (the folder with river.json). Boards, marks, jobs and renders live here. */
  workspaceRoot: string
  board: string
  markId: string
}

/** Runs one agent turn; never throws (problems arrive as error events). */
export type RunTurn = (req: AgentTurnRequest, handlers: AgentTurnHandlers) => Promise<void>

export interface JobDeps {
  /** Default startAgentTurn. Tests pass a fake that writes known scripts. */
  runTurn?: RunTurn
  /** Every event of the agent turn, for progress output. */
  onEvent?: (event: AgentEvent) => void
  /** Default renderConcept (real Godot). */
  render?: (req: RenderConceptRequest) => Promise<void>
  /** For GODOT_BIN and $VARs in river.json. Default process.env. */
  env?: NodeJS.ProcessEnv
}

/** A script a job waits on, as the user must see it before approving. */
export interface JobScript {
  /** Relative to the project root: concepts/<conceptId>/draw.gd or draw_<v>.gd. */
  file: string
  text: string
  sha256: string
  /** "a".."e" for an option; absent for a single draw.gd. */
  variant?: string
  caption?: string
}

export const CONCEPT_ROLE = "concept-artist"
const INTERRUPTIBLE: readonly JobStatus[] = ["queued", "running", "rendering"]
const CAPTION_MAX = 160

const now = () => new Date().toISOString()
const hash = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex")
const errMsg = (err: unknown) => (err instanceof Error ? err.message : String(err))
/** A project-relative path as a path from the git top level, which is what the job's commits use. */
const inRepo = (job: Job, rel: string) => path.posix.join(job.projectSub, rel)
const projectRoot = async (workspaceRoot: string) => (await loadProject(workspaceRoot)).root
const optionName = (s: { variant?: string }) => (s.variant ? `option ${s.variant.toUpperCase()}` : "the drawing")
/** Jobs answered before renders were recorded per script rendered their one script. */
const renderedOk = (s: JobScriptRecord) => s.render?.ok ?? true

/** The job that speaks for a mark: its newest job that is not dismissed, or its newest job once all are. */
function leadJob(jobs: Job[]): Job | undefined {
  const newest = (list: Job[]) => list.reduce<Job | undefined>((a, j) => (!a || j.createdAt > a.createdAt || (j.createdAt === a.createdAt && j.id > a.id) ? j : a), undefined)
  return newest(jobs.filter((j) => j.status !== "dismissed")) ?? newest(jobs)
}

/** The mark's jobId and status follow its lead job, so accepting or dismissing an older answer never hides a newer one. */
async function syncMark(root: string, job: Job, message?: string): Promise<void> {
  const mark = await loadMark(root, job.board, job.markId)
  if (!mark) return
  const lead = leadJob((await listJobs(root)).filter((j) => j.board === job.board && j.markId === job.markId))
  const thread = message ? [...mark.thread, { by: job.role, at: now(), text: message }] : mark.thread
  await saveMark(root, job.board, { ...mark, thread, ...(lead ? { jobId: lead.id, status: MARK_STATUS_FOR_JOB[lead.status] } : {}) })
}

/**
 * The one way a job changes state. Re-reads the job first, so a move another process made (a
 * dismiss while the agent runs) wins, and throws on any move JOB_NEXT does not allow.
 */
async function transition(root: string, job: Job, to: JobStatus, patch: Partial<Job> = {}, message?: string): Promise<Job> {
  const current = await loadJob(root, job.id)
  if (!JOB_NEXT[current.status].includes(to)) throw new Error(`river: job ${job.id} is ${current.status}; it cannot become ${to}`)
  const next: Job = { ...current, ...patch, status: to, updatedAt: now() }
  await saveJob(root, next)
  await syncMark(root, next, message)
  return next
}

const HEARTBEAT_MS = 10_000
const OWNER_STALE_MS = 60_000

/** The process working on a job: .river/jobs/<id>/owner.json. Apart from the job file, so a heartbeat never overwrites a state change. */
interface JobOwner {
  pid: number
  host: string
  /** Last heartbeat, ISO time. */
  at: string
}

const ownerFile = (root: string, jobId: string) => path.join(root, ".river", "jobs", jobId, "owner.json")

/**
 * Record this process as the job's owner and refresh the record until stop() runs, so recoverJobs in
 * another process (the app opening the project while the CLI runs a job) leaves the job alone.
 */
async function claimJob(root: string, jobId: string): Promise<() => void> {
  const file = ownerFile(root, jobId)
  const beat = async () => {
    const owner: JobOwner = { pid: process.pid, host: hostname(), at: now() }
    const tmp = `${file}.${process.pid}.tmp`
    await writeFile(tmp, JSON.stringify(owner))
    await rename(tmp, file)
  }
  await mkdir(path.dirname(file), { recursive: true })
  await beat()
  // Later beats never create the folder, so once a dismiss removes it, it stays gone.
  const timer = setInterval(() => void beat().catch(() => undefined), HEARTBEAT_MS)
  timer.unref()
  return () => clearInterval(timer)
}

/** A heartbeat within the last minute from a process that still exists (the pid is checked on the owner's host only). */
async function ownerAlive(root: string, jobId: string): Promise<boolean> {
  let owner: JobOwner
  try {
    owner = JSON.parse(await readFile(ownerFile(root, jobId), "utf8")) as JobOwner
  } catch {
    return false
  }
  if (!(Date.now() - Date.parse(owner.at) < OWNER_STALE_MS)) return false
  if (owner.host !== hostname()) return true
  try {
    process.kill(owner.pid, 0)
    return true
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM"
  }
}

/** Fail the job unless it already ended (dismissed meanwhile, or failed already); returns it as it is now. */
async function fail(root: string, job: Job, error: string, patch: Partial<Job> = {}): Promise<Job> {
  const current = await loadJob(root, job.id)
  return JOB_NEXT[current.status].includes("failed") ? transition(root, current, "failed", { ...patch, error }) : current
}

// ---- the answer on the board

/** Card and edge ids a job derives from its own id, so laying its answer out again overwrites instead of adding. */
const answerIds = (job: Job) => {
  const base = job.id.replace(/^j_/, "")
  return { option: (i: number) => `c_${base}_${i}`, note: `c_${base}_n`, toNote: `e_${base}_n`, toOption: (i: number) => `e_${base}_${i}` }
}

const ownCards = (board: Board, job: Job) => board.cards.filter((c) => c.pending?.jobId === job.id)

/** Remove cards and every edge that touches them; edges go first, so an interrupted run leaves no edge to a missing card. */
async function removeCards(root: string, board: Board, cards: Card[]): Promise<void> {
  const ids = new Set(cards.map((c) => c.id))
  for (const e of board.edges.filter((e) => ids.has(e.from) || ids.has(e.to))) await deleteEdge(root, board.name, e.id)
  for (const c of cards) await deleteCard(root, board.name, c.id)
}

/** The cards of a job's answer, found by their derived ids, so they are found after an accept too. */
function answerCards(board: Board, jobId: string): Card[] {
  const ids = answerIds({ id: jobId } as Job)
  const own = new Set([ids.note, ...[0, 1, 2, 3, 4].map(ids.option)])
  return board.cards.filter((c) => own.has(c.id))
}

/** Where a job's answer starts: beside the mark, or under the answer it revises. */
function answerStart(board: Board, job: Job): { x: number; y: number } {
  const parentCards = job.parentJobId ? answerCards(board, job.parentJobId).map(cardRect) : []
  if (parentCards.length > 0) {
    return { x: Math.min(...parentCards.map((r) => r.x)), y: Math.max(...parentCards.map((r) => r.y + r.h)) + BOARD_GAP }
  }
  const mark = board.marks.find((m) => m.id === job.markId)
  return mark ? besideRect(markRect(mark)) : { x: 0, y: 0 }
}

/** The faded card that stands for the job while it works; it becomes the first option's card at approval. */
async function placePlaceholder(root: string, job: Job): Promise<void> {
  const board = await loadBoard(root, job.board)
  const size = { w: IMAGE_CARD_W, h: IMAGE_CARD_W }
  const [spot] = placeRow(answerStart(board, job), [size], occupiedRects(board))
  await saveCard(root, job.board, {
    id: answerIds(job).option(0),
    kind: "concept",
    ...spot!,
    w: IMAGE_CARD_W,
    ref: job.conceptId,
    madeBy: job.role,
    pending: { markId: job.markId, jobId: job.id },
  })
}

/**
 * Lay the answer out as one row starting where the placeholder stood: the agent's note, then one card per
 * script labelled A, B, ... with its caption. Edges run mark -> note -> each option, all left to right in
 * reading order. Anything else the job had on the board (an older placeholder) goes.
 */
async function layoutAnswer(root: string, job: Job, scripts: JobScriptRecord[], summary: string): Promise<void> {
  const board = await loadBoard(root, job.board)
  const ids = answerIds(job)
  const own = ownCards(board, job)
  const placeholder = own.find((c) => c.id === ids.option(0))
  const pending = { markId: job.markId, jobId: job.id }
  const base = { madeBy: job.role, pending, createdAt: now() }
  const note: Card = { ...base, id: ids.note, kind: "note", x: 0, y: 0, w: NOTE_CARD_W, ref: "", text: summary }
  const options: Card[] = scripts.map((s, i) => ({
    ...base,
    id: ids.option(i),
    kind: "concept",
    x: 0,
    y: 0,
    w: IMAGE_CARD_W,
    ref: job.conceptId,
    ...(s.variant ? { variant: s.variant, label: s.variant.toUpperCase() } : {}),
    ...(s.caption ? { caption: s.caption } : {}),
  }))
  const cards = [note, ...options]
  const start = placeholder ? { x: placeholder.x, y: placeholder.y } : answerStart(board, job)
  const spots = placeRow(start, cards.map((c) => ({ w: c.w, h: cardHeight(c) })), occupiedRects(board, new Set(own.map((c) => c.id))))
  const keep = new Set(cards.map((c) => c.id))
  await removeCards(root, board, own.filter((c) => !keep.has(c.id)))
  for (const [i, card] of cards.entries()) await saveCard(root, job.board, { ...card, ...spots[i]!, createdAt: own.find((c) => c.id === card.id)?.createdAt ?? card.createdAt })
  if (board.marks.some((m) => m.id === job.markId)) await saveEdge(root, job.board, { id: ids.toNote, from: job.markId, to: note.id, madeBy: job.role })
  for (const [i, card] of options.entries()) await saveEdge(root, job.board, { id: ids.toOption(i), from: note.id, to: card.id, madeBy: job.role })
}

// ---- prompts

const clip = (text: string, max = 600) => (text.length > max ? text.slice(0, max - 1) + "…" : text)

async function describeCard(project: Project, card: Card): Promise<string> {
  switch (card.kind) {
    case "passage": {
      const [file = "", id = ""] = card.ref.split("#")
      try {
        const passage = passageById((await loadStory(project, file)).story, id)
        if (passage) return `passage "${passage.name}" (${card.ref}): ${clip(proseText(passage.text))}`
      } catch {
        // A card can point at a story that moved; the ref alone still tells the agent where to look.
      }
      return `passage ${card.ref}`
    }
    case "frame":
      return `frame of shot "${card.ref}"`
    case "note":
      return `note: ${clip(card.text ?? "")}`
    case "concept":
      return `concept art in concepts/${card.ref}/${card.variant ? ` (option ${card.variant.toUpperCase()}${card.caption ? `: ${card.caption}` : ""})` : ""}`
    case "ref":
      return `reference image ${card.ref}${card.source?.title ? ` (${card.source.title})` : ""}`
  }
}

/** The user's request: the mark's thread, then the cards it is on. */
async function conceptPrompt(project: Project, board: string, mark: Mark): Promise<string> {
  const cards = (await loadBoard(project.root, board)).cards
  const lines = ["The user marked the storyboard and asked:", ...mark.thread.map((m) => `${m.by}: ${m.text}`)]
  const anchored = mark.anchors.map((id) => cards.find((c) => c.id === id)).filter((c): c is Card => c !== undefined)
  if (anchored.length > 0) {
    lines.push("", "The mark is on these cards:")
    for (const card of anchored) lines.push(`- ${await describeCard(project, card)}`)
  }
  return lines.join("\n")
}

/**
 * What the user said on the mark after `job` answered: messages by "you" after the job's own answer in the
 * thread, or after the job started when it never answered (it failed first).
 */
export function repliesAfter(mark: Mark, job: Job): string[] {
  const answer = mark.thread.findLastIndex((m) => m.by === job.role && m.at >= job.createdAt)
  const after = answer >= 0 ? mark.thread.slice(answer + 1) : mark.thread.filter((m) => m.at > job.createdAt)
  return after.filter((m) => m.by === "you").map((m) => m.text)
}

/** The previous answer, for a revision: each option with its caption and how its render went, and the scripts when the agent cannot resume. */
async function revisionPrompt(project: Project, parent: Job, replies: string[], conceptId: string, withScripts: boolean): Promise<string> {
  const lines = [`This revises your previous answer (job ${parent.id}, folder concepts/${parent.conceptId}/).`]
  if (parent.summary) lines.push(`Your note then: ${parent.summary}`)
  for (const s of parent.scripts ?? []) {
    const how = !s.render ? "not rendered" : s.render.ok ? "rendered" : `failed to render. Godot said:\n${s.render.error}`
    lines.push(`- ${optionName(s)} (${path.posix.basename(s.file)})${s.caption ? ` "${s.caption}"` : ""}: ${how}`)
  }
  if (parent.status === "failed" && parent.error) lines.push(`The job failed: ${parent.error}`)
  const kept = parent.status === "accepted" ? (parent.scripts ?? []).filter((s) => s.accepted) : []
  if (parent.status === "accepted") {
    lines.push(`The user kept ${kept.map(optionName).join(" and ") || "nothing"}; ${kept.length === 1 ? "it is" : "they are"} in the project at concepts/${parent.conceptId}/.`)
  }
  if (withScripts && parent.headSha) {
    lines.push("", "The previous scripts:")
    for (const s of parent.scripts ?? []) {
      // An accepted job's branch is gone; the options the user kept are in the checkout.
      const text = await readCommittedFile(project.root, parent.headSha, inRepo(parent, s.file))
        .catch(() => (s.accepted ? readFile(path.join(project.root, s.file)) : undefined))
        .then((b) => b?.toString("utf8"))
        .catch(() => undefined)
      if (text !== undefined) lines.push(`--- ${path.posix.basename(s.file)}`, text.trimEnd(), "---")
    }
  }
  lines.push(
    "",
    replies.length > 0 ? `The user replied:\n${replies.map((r) => `you: ${r}`).join("\n")}` : "The user asked for a fix: make the scripts render.",
    "",
    `Answer with new options in this job's own folder, concepts/${conceptId}/ (draw.gd, or draw_a.gd..draw_e.gd). ` +
      (kept.length > 0
        ? `What the user kept is in this worktree at concepts/${parent.conceptId}/ (read it there; do not write there), and the options they did not keep are not: `
        : "The previous folder is not in this worktree: ") +
      "write out in full whatever you keep in the new scripts. Label and caption the new options for what they are now, and say in your note how they answer the reply.",
  )
  return lines.join("\n")
}

// ---- scripts

/** The scripts the turn left in the job's folder, by file name, each with its caption. */
async function writtenScripts(dir: string): Promise<{ name: string; variant?: string; bytes: Buffer; caption?: string }[]> {
  const names = (await readdir(dir).catch(() => [] as string[])).filter((n) => parseConceptScriptName(n)).sort()
  return Promise.all(
    names.map(async (name) => {
      const { variant } = parseConceptScriptName(name)!
      const raw = await readFile(path.join(dir, conceptCaptionName(variant)), "utf8").catch(() => "")
      // A caption is display text: one line, no control or bidi characters, short.
      const caption = raw.replace(/[\p{Cc}‪-‮⁦-⁩]+/gu, " ").replace(/\s+/g, " ").trim().slice(0, CAPTION_MAX)
      return { name, ...(variant ? { variant } : {}), bytes: await readFile(path.join(dir, name)), ...(caption ? { caption } : {}) }
    }),
  )
}

/** Why the written scripts cannot go to approval, or undefined when they can. */
function scriptsProblem(folder: string, scripts: { name: string; variant?: string; bytes: Buffer }[], errors: string[]): string | undefined {
  if (scripts.length === 0) return errors.length > 0 ? errors.join("\n") : `The concept artist did not write ${folder}/draw.gd (or options draw_a.gd..draw_e.gd).`
  if (scripts.some((s) => !s.variant) && scripts.some((s) => s.variant)) {
    return `${folder}/ has draw.gd and lettered options; a job answers with one or the other. Write the one you do not want with empty content to remove it.`
  }
  const problems: string[] = []
  for (const s of scripts) {
    const unreadable = conceptScriptBytesProblem(s.bytes)
    if (unreadable) {
      problems.push(`${folder}/${s.name}: ${unreadable}`)
      continue
    }
    const lint = lintConceptScript(s.bytes.toString("utf8"))
    if (lint.length > 0) problems.push(`${folder}/${s.name} does not pass the concept lint:`, ...lint)
  }
  return problems.length > 0 ? problems.join("\n") : undefined
}

/**
 * The bytes of each of the job's scripts in its latest commit: the only copy River shows, hashes, renders
 * and applies. Refuses bytes a person could not read as shown (a job committed before that rule).
 */
async function committedScripts(root: string, job: Job): Promise<{ record: JobScriptRecord; bytes: Buffer }[]> {
  if (!job.scripts?.length || !job.headSha) throw new Error(`river: job ${job.id} has no script yet`)
  const out: { record: JobScriptRecord; bytes: Buffer }[] = []
  for (const record of job.scripts) {
    const bytes = await readCommittedFile(root, job.headSha, inRepo(job, record.file))
    const unreadable = conceptScriptBytesProblem(bytes)
    if (unreadable) throw new Error(`river: refused: ${record.file} cannot be shown as it would run. ${unreadable} Dismiss the job and ask again.`)
    out.push({ record, bytes })
  }
  return out
}

// ---- running a turn

interface Ask {
  /** Complete on its own: the prompt for a fresh session. */
  prompt: string
  /** Continue the agent's earlier session with a shorter prompt; a fresh session with `prompt` if it cannot be found. */
  resume?: { sessionId: string; prompt: string }
}

/** Jobs whose agent turn runs in this process, so a dismiss can stop the turn before removing its worktree. */
const live = new Map<string, { abort: AbortController; run: Promise<Job> }>()

/** Save the queued job, run its turn and resolve with the job at "approval" (or "failed", or "dismissed"). */
async function launchJob(project: Project, queued: Job, settings: JobAgentSettings, ask: Ask, deps: JobDeps): Promise<Job> {
  const root = project.root
  const abort = new AbortController()
  // In `live` before the job file exists, so a dismiss from this process always waits for the run.
  // Claimed before it exists too, so recoverJobs elsewhere never sees it queued without an owner.
  const run = claimJob(root, queued.id).then(async (stop) => {
    try {
      return await runConceptTurn(project, settings, await saveJob(root, queued), ask, abort.signal, deps)
    } finally {
      stop()
    }
  })
  live.set(queued.id, { abort, run })
  try {
    return await run
  } finally {
    live.delete(queued.id)
  }
}

function queuedJob(mark: Mark, board: string, settings: JobAgentSettings, parentJobId?: string): Job {
  const id = newBoardId("j_")
  const at = now()
  return {
    id,
    markId: mark.id,
    board,
    role: CONCEPT_ROLE,
    model: settings.model,
    backend: settings.backend,
    status: "queued",
    conceptId: id,
    baseSha: "",
    branch: "",
    worktree: "",
    projectSub: "",
    ...(parentJobId ? { parentJobId } : {}),
    createdAt: at,
    updatedAt: at,
  }
}

const NO_SESSION = /No conversation found with session ID/

async function runConceptTurn(project: Project, settings: JobAgentSettings, job: Job, ask: Ask, signal: AbortSignal, deps: JobDeps): Promise<Job> {
  const root = project.root
  let sessionId: string | undefined
  try {
    await syncMark(root, job)
    await placePlaceholder(root, job)
    const created = await createJobWorktree(root, job.id)
    job = await transition(root, job, "running", created)
    const brief = await readBrief(root)
    const texts: string[] = []
    let errors: string[] = []
    const runTurn = deps.runTurn ?? ((r, h) => startAgentTurn(r, h))
    const turn = (prompt: string, resume?: string) =>
      runTurn(
        {
          root: path.join(created.worktree, job.projectSub),
          mode: "concept",
          model: settings.model,
          prompt,
          backend: settings.backend,
          conceptId: job.conceptId,
          ...(resume ? { sessionId: resume } : {}),
          ...(brief ? { brief } : {}),
          ...(settings.apiKey ? { apiKey: settings.apiKey } : {}),
          ...(settings.claudePath ? { claudePath: settings.claudePath } : {}),
        },
        {
          onEvent: (e) => {
            deps.onEvent?.(e)
            if (e.type === "session") sessionId = e.sessionId
            if (e.type === "text") texts.push(e.text.trim())
            if (e.type === "error") errors.push(e.message)
          },
          onPermission: async () => ({ behavior: "deny", message: "A concept job asks for nothing: it writes only its own folder." }),
          signal,
        },
      )
    await turn(ask.resume?.prompt ?? ask.prompt, ask.resume?.sessionId)
    if (ask.resume && !signal.aborted && errors.some((e) => NO_SESSION.test(e))) {
      // The earlier session is gone (another machine, cleared history): start fresh with everything in the prompt.
      errors = []
      sessionId = undefined
      await turn(ask.prompt)
    }
    if (signal.aborted) return await dismiss(root, await loadJob(root, job.id))
    const kept = sessionId ? { sessionId } : {}

    const folder = conceptPath(job.conceptId)
    const scripts = await writtenScripts(path.join(created.worktree, job.projectSub, folder))
    const problem = scriptsProblem(folder, scripts, errors)
    if (problem) return await fail(root, job, problem, kept)

    let headSha = ""
    const records: JobScriptRecord[] = []
    for (const s of scripts) {
      const file = conceptPath(job.conceptId, s.name)
      headSha = await commitJobFile(root, job.id, inRepo(job, file), s.bytes, `river: concept ${job.conceptId} ${s.name}`)
      records.push({ file, sha256: hash(s.bytes), approved: false, ...(s.variant ? { variant: s.variant } : {}), ...(s.caption ? { caption: s.caption } : {}) })
    }
    const summary = texts.at(-1) || `The concept artist wrote ${records.map((r) => path.posix.basename(r.file)).join(", ")}.`
    await layoutAnswer(root, job, records, summary)
    return await transition(root, job, "approval", { headSha, summary, scripts: records, ...kept }, summary)
  } catch (err) {
    const ended = await fail(root, job, errMsg(err), sessionId ? { sessionId } : {})
    // Dismissed by another process while this one set up: its dismiss could not see the cards or worktree made after it.
    return ended.status === "dismissed" ? await dismiss(root, ended) : ended
  }
}

/**
 * Start a concept job for a mark and run its agent turn. Resolves when the job reaches "approval"
 * (or "failed"). Throws only when no job could be created (unknown mark, a job already active on it).
 */
export async function startConceptJob(req: ConceptJobRequest, deps: JobDeps = {}): Promise<Job> {
  const project = await loadProject(req.workspaceRoot)
  const root = project.root
  const mark = await loadMark(root, req.board, req.markId)
  if (!mark) throw new Error(`river: no mark ${req.markId} on board ${req.board}`)
  await gitTop(root).catch(() => {
    throw new Error(`river: concept jobs work on a git branch, but ${root} is not in a git repository`)
  })
  const leadOf = async (m: Mark | undefined) => (m?.jobId ? await loadJob(root, m.jobId).catch(() => undefined) : undefined)
  let previous = await leadOf(mark)
  // Asking again replaces a failed attempt (its cards and worktree go). The mark then follows its next job,
  // such as the answer a failed revision was revising, which blocks like anything else still in flight.
  while (previous?.status === "failed") {
    await dismissJob(root, previous.id)
    previous = await leadOf(await loadMark(root, req.board, req.markId))
  }
  if (previous && JOB_NEXT[previous.status].length > 0) {
    throw new Error(`river: mark ${mark.id} already has job ${previous.id} (${previous.status})${previous.status === "answered" ? "; reply on the mark and revise it, or dismiss it" : ""}`)
  }
  return launchJob(project, queuedJob(mark, req.board, req), req, { prompt: await conceptPrompt(project, req.board, mark) }, deps)
}

/**
 * Answer the user's reply on a mark: a new job (parentJobId = jobId) that gets the previous answer, how its
 * renders went and the reply, and resumes the agent's session when there is one. `jobId` must be the
 * mark's latest job: answered or accepted (with a reply by the user after its answer, such as "I like A, try
 * two more takes on A"), or failed (a reply is optional: the revision fixes what broke). The previous job
 * stays as it is; the user can still accept or dismiss it. Resolves like startConceptJob.
 */
export async function reviseJob(workspaceRoot: string, jobId: string, settings: JobAgentSettings, deps: JobDeps = {}): Promise<Job> {
  const project = await loadProject(workspaceRoot)
  const root = project.root
  const parent = await loadJob(root, jobId)
  if (!(["answered", "accepted", "failed"] as JobStatus[]).includes(parent.status)) {
    throw new Error(`river: job ${jobId} is ${parent.status}; only an answered, accepted or failed job can be revised`)
  }
  const mark = await loadMark(root, parent.board, parent.markId)
  if (!mark) throw new Error(`river: no mark ${parent.markId} on board ${parent.board}`)
  if (mark.jobId !== parent.id) throw new Error(`river: job ${jobId} is not the latest answer on mark ${mark.id} (that is ${mark.jobId ?? "none"}); revise that one`)
  const replies = repliesAfter(mark, parent)
  if (parent.status !== "failed" && replies.length === 0) throw new Error(`river: reply on mark ${mark.id} first: say what to change`)

  const queued = queuedJob(mark, parent.board, settings, parent.id)
  const request = await conceptPrompt(project, parent.board, mark)
  const ask: Ask = { prompt: `${request}\n\n${await revisionPrompt(project, parent, replies, queued.conceptId, true)}` }
  if (parent.sessionId) ask.resume = { sessionId: parent.sessionId, prompt: await revisionPrompt(project, parent, replies, queued.conceptId, false) }
  return launchJob(project, queued, settings, ask, deps)
}

/** The scripts a job in "approval" wants to run, with the sha256 of each to pass to approveJobScripts. */
export async function readJobScripts(workspaceRoot: string, jobId: string): Promise<JobScript[]> {
  const root = await projectRoot(workspaceRoot)
  return (await committedScripts(root, await loadJob(root, jobId))).map(({ record, bytes }) => ({
    file: record.file,
    text: bytes.toString("utf8"),
    sha256: hash(bytes),
    ...(record.variant ? { variant: record.variant } : {}),
    ...(record.caption ? { caption: record.caption } : {}),
  }))
}

/** The one script of a single-script job. Throws for a job with options: show them all with readJobScripts. */
export async function readJobScript(workspaceRoot: string, jobId: string): Promise<JobScript> {
  const scripts = await readJobScripts(workspaceRoot, jobId)
  if (scripts.length !== 1) throw new Error(`river: job ${jobId} has ${scripts.length} scripts; read them all with readJobScripts and approve them together`)
  return scripts[0]!
}

function godotBin(project: Project, env: NodeJS.ProcessEnv): string {
  if (project.manifest.adapter?.godot?.bin) return godotSettings(project, env).bin
  if (env.GODOT_BIN) return env.GODOT_BIN
  throw new Error('river: no Godot to render with. Set adapter.godot.bin in river.json (for example "$GODOT_BIN") or the GODOT_BIN environment variable.')
}

/**
 * The user approves every script's exact bytes at once: `shas` maps each script's file (as readJobScripts
 * gives it) to its sha256. Refuses (throws, nothing changes) unless the job is in "approval" and `shas`
 * names exactly the job's scripts with matching hashes. Then renders each in a sandbox Godot project and
 * puts each PNG on the job branch. A script that fails keeps Godot's output on its record and its card
 * says so; the job is "answered" when at least one rendered, "failed" when none did.
 */
export async function approveJobScripts(workspaceRoot: string, jobId: string, shas: Readonly<Record<string, string>>, deps: JobDeps = {}): Promise<Job> {
  const project = await loadProject(workspaceRoot)
  const root = project.root
  let job = await loadJob(root, jobId)
  if (job.status !== "approval") throw new Error(`river: job ${jobId} is ${job.status}; only a job waiting for approval can run its scripts`)
  const scripts = await committedScripts(root, job)
  const unknown = Object.keys(shas).filter((f) => !scripts.some((s) => s.record.file === f))
  if (unknown.length > 0) throw new Error(`river: refused: ${unknown.join(", ")} ${unknown.length === 1 ? "is" : "are"} not a script of job ${jobId}`)
  for (const { record, bytes } of scripts) {
    const actual = hash(bytes)
    if (shas[record.file] !== actual || actual !== record.sha256) {
      throw new Error(`river: refused: ${record.file} hashes to ${actual}, but ${shas[record.file] ?? "nothing"} was approved for it`)
    }
  }
  const bin = godotBin(project, deps.env ?? process.env)

  const stop = await claimJob(root, job.id)
  try {
    job = await transition(root, job, "rendering", { scripts: scripts.map(({ record }) => ({ ...record, approved: true })) })
    try {
      let headSha = job.headSha!
      const done: JobScriptRecord[] = []
      for (const { record, bytes } of scripts) {
        try {
          const png = path.join(root, ".river", "jobs", job.id, jobRenderName(record.variant))
          await (deps.render ?? renderConcept)({ bin, script: bytes, outPng: png })
          const render = conceptPath(job.conceptId, conceptRenderName(record.variant))
          headSha = await commitJobFile(root, job.id, inRepo(job, render), await readFile(png), `river: render ${job.conceptId} ${path.posix.basename(render)}`)
          done.push({ ...record, approved: true, render: { ok: true } })
        } catch (err) {
          done.push({ ...record, approved: true, render: { ok: false, error: errMsg(err) } })
        }
      }
      if (done.some((s) => s.render?.ok)) return await transition(root, job, "answered", { headSha, scripts: done })
      const error = done.map((s) => (s.render?.ok === false ? (done.length > 1 ? `${optionName(s)}: ${s.render.error}` : s.render.error) : "")).join("\n\n")
      return await fail(root, job, error, { headSha, scripts: done })
    } catch (err) {
      return await fail(root, job, errMsg(err))
    }
  } finally {
    stop()
  }
}

/** approveJobScripts for a job with one script. Throws for a job with options, which needs every sha. */
export async function approveJobScript(workspaceRoot: string, jobId: string, sha256: string, deps: JobDeps = {}): Promise<Job> {
  const root = await projectRoot(workspaceRoot)
  const job = await loadJob(root, jobId)
  const [only, ...more] = job.scripts ?? []
  if (!only || more.length > 0) throw new Error(`river: job ${jobId} has ${job.scripts?.length ?? 0} scripts; approve every one of them with approveJobScripts`)
  return approveJobScripts(root, jobId, { [only.file]: sha256 }, deps)
}

/**
 * What follows an accept: the kept options and the note stay without their pending flag, the other
 * options' cards and their edges go, and so do the worktree and branch. Safe to repeat.
 */
async function finishAccept(root: string, job: Job): Promise<void> {
  const board = await loadBoard(root, job.board)
  const own = ownCards(board, job)
  const kept = (c: Card) => c.kind !== "concept" || !c.variant || job.scripts?.some((s) => s.variant === c.variant && s.accepted)
  await removeCards(root, board, own.filter((c) => !kept(c)))
  for (const card of own.filter(kept)) {
    const { pending: _pending, ...settled } = card
    await saveCard(root, job.board, settled)
  }
  await removeJobWorktree(root, job.id)
}

/**
 * Write the chosen options' scripts and renders into the user's checkout as the committed bytes (index and
 * other files untouched) and mark the job accepted. `variants` picks options by letter; without it every
 * option that rendered is kept. Throws, leaving the job answered and the checkout as it was, when a file is
 * in the way or a choice is not an option that rendered. Settling the cards and removing the worktree
 * follow; if they fail the job stays accepted and recoverJobs finishes them.
 */
export async function acceptJob(workspaceRoot: string, jobId: string, opts: { variants?: readonly string[] } = {}): Promise<Job> {
  const root = await projectRoot(workspaceRoot)
  const job = await loadJob(root, jobId)
  if (job.status !== "answered") throw new Error(`river: job ${jobId} is ${job.status}; only an answered job can be accepted`)
  const scripts = await committedScripts(root, job)
  const rendered = scripts.filter(({ record }) => renderedOk(record))
  let chosen = rendered
  if (opts.variants) {
    const wanted = [...new Set(opts.variants.map((v) => v.toLowerCase()))]
    if (wanted.length === 0) throw new Error(`river: choose at least one option of job ${jobId}, or dismiss it`)
    const offered = rendered.map(({ record }) => record.variant).filter((v): v is string => v !== undefined)
    const missing = wanted.filter((v) => !offered.includes(v))
    if (missing.length > 0) throw new Error(`river: job ${jobId} has no rendered option ${missing.join(", ")}; it offers ${offered.join(", ") || "no lettered options"}`)
    chosen = rendered.filter(({ record }) => wanted.includes(record.variant ?? ""))
  }
  for (const { record, bytes } of chosen) {
    if (hash(bytes) !== record.sha256) throw new Error(`river: refused: ${record.file} on job ${jobId}'s branch is not the approved one`)
  }
  const files = chosen.flatMap(({ record }) => [record.file, conceptPath(job.conceptId, conceptRenderName(record.variant))])
  const undo = await applyJobFiles(root, job.headSha!, files.map((f) => inRepo(job, f)))
  const keep = new Set(chosen.map(({ record }) => record.file))
  let accepted: Job
  try {
    accepted = await transition(root, job, "accepted", { scripts: job.scripts!.map((s) => (keep.has(s.file) ? { ...s, accepted: true } : s)) })
  } catch (err) {
    // Another process can dismiss the job between the write and this move; then none of its files may stay.
    if ((await loadJob(root, jobId)).status !== "accepted") await undo()
    throw err
  }
  await finishAccept(root, accepted).catch((err: unknown) =>
    console.warn(`river: job ${jobId} is accepted, but tidying up failed (retried when the project next opens): ${errMsg(err)}`),
  )
  return accepted
}

/**
 * Worktree, branch, render folder, cards and their edges go first, then the job is dismissed. A dismissed
 * job is cleaned up again, so whatever an earlier dismiss raced with (a card saved just after it) goes too.
 * `reason` goes into the project brief, once, when the job actually becomes dismissed.
 */
async function dismiss(root: string, job: Job, reason?: string): Promise<Job> {
  if (job.status !== "dismissed" && !JOB_NEXT[job.status].includes("dismissed")) throw new Error(`river: job ${job.id} is ${job.status}; it cannot be dismissed`)
  await removeJobWorktree(root, job.id)
  await rm(path.join(root, ".river", "jobs", job.id), { recursive: true, force: true, maxRetries: 3 })
  const board = await loadBoard(root, job.board)
  await removeCards(root, board, ownCards(board, job))
  if (job.status !== "dismissed") {
    if (reason?.trim()) {
      const asked = (await loadMark(root, job.board, job.markId))?.thread.find((m) => m.by === "you")?.text
      await addTurnedDown(root, job.id, `${reason.trim()}${asked ? ` (asked: "${clip(asked.replace(/\s+/g, " "), 120)}")` : ""}`)
    }
    return transition(root, job, "dismissed")
  }
  await syncMark(root, job)
  return job
}

/**
 * Throw the job away from any non-terminal state; dismissing it again tidies up anything left. A turn
 * running in this process is stopped first (it holds the worktree open). A turn running in another
 * process cannot be stopped from here. `reason`, when given, is added to the project brief under
 * "Things the user turned down", so later answers avoid it.
 */
export async function dismissJob(workspaceRoot: string, jobId: string, reason?: string): Promise<Job> {
  const root = await projectRoot(workspaceRoot)
  const owned = live.get(jobId)
  if (owned) {
    owned.abort.abort()
    await owned.run.catch(() => undefined)
  }
  return dismiss(root, await loadJob(root, jobId), reason)
}

/**
 * Call when a project opens. Jobs left queued, running or rendering by a process that is gone (no
 * heartbeat for a minute, or its pid no longer exists) become "failed"; jobs a live process works on,
 * in this process or another, are left alone. What an accept or dismiss left unsettled is finished.
 * Returns the jobs it failed.
 */
export async function recoverJobs(workspaceRoot: string): Promise<Job[]> {
  const root = await projectRoot(workspaceRoot)
  const jobs = await listJobs(root)
  const recovered: Job[] = []
  for (const job of jobs) {
    if (INTERRUPTIBLE.includes(job.status) && !(await ownerAlive(root, job.id))) {
      recovered.push(await transition(root, job, "failed", { error: `interrupted: River stopped while this job was ${job.status}` }))
    }
  }
  await settleEnded(root, jobs)
  return recovered
}

/** Accepted and dismissed jobs that still have a pending card or a branch: the process stopped, or a cleanup step failed. */
async function settleEnded(root: string, jobs: Job[]): Promise<void> {
  const ended = jobs.filter((j) => j.status === "accepted" || j.status === "dismissed")
  if (ended.length === 0) return
  const branches = new Set(await listJobBranches(root))
  const boards = new Map<string, Board>()
  for (const job of ended) {
    try {
      if (!boards.has(job.board)) boards.set(job.board, await loadBoard(root, job.board))
      if (ownCards(boards.get(job.board)!, job).length === 0 && !branches.has(job.id)) continue
      if (job.status === "accepted") await finishAccept(root, job)
      else await dismiss(root, job)
    } catch (err) {
      console.warn(`river: could not tidy up job ${job.id}: ${errMsg(err)}`)
    }
  }
}
