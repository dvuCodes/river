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
import { existsSync } from "node:fs"
import { copyFile, mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises"
import { hostname } from "node:os"
import path from "node:path"
import { conceptScriptBytesProblem, godotSettings, KIT_FILE, kitFileAction, kitFileText, lintConceptScript, renderConcept, type RenderConceptRequest } from "@river/adapter-godot"
import {
  addTurnedDown,
  answerStart,
  applyJobFiles,
  cardHeight,
  CONCEPT_ROLE,
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
  liveClaim,
  loadBoard,
  loadJob,
  loadMark,
  loadProject,
  loadStory,
  MARK_STATUS_FOR_JOB,
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
  updateMark,
  withMarkLock,
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

export { CONCEPT_ROLE }

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
  /** The new job's id, when the caller must know it before the job exists (concept_request). Default: a new one. */
  jobId?: string
  /**
   * Who asks: "you" (the default) for the user, or an agent's name. An agent may not start a job on a mark another
   * agent holds; the user takes such a mark over, and the thread says so.
   */
  by?: string
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
  /**
   * After rendering, one more turn looks at the renders and may rewrite the note and captions. false skips it;
   * settings run it with them. Default: the job's own model and backend, unless RIVER_SELF_CHECK=off is in `env`
   * (the test suite sets it), or the render is injected and the turn is not (a fake render is not worth paying a
   * model to look at).
   */
  selfCheck?: false | JobAgentSettings
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

const INTERRUPTIBLE: readonly JobStatus[] = ["queued", "running", "rendering"]
const CAPTION_MAX = 160
/** The agent's closing note goes on the board and into the mark's thread. */
const SUMMARY_MAX = 1500

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

/**
 * The mark's jobId and status follow its lead job, so accepting or dismissing an older answer never hides a newer one.
 * Under the mark's lock, so a reply the user writes meanwhile is kept. A job owns its mark: no agent's claim stays.
 */
async function syncMark(root: string, job: Job, message?: string): Promise<void> {
  if (!(await loadMark(root, job.board, job.markId))) return
  await updateMark(root, job.board, job.markId, async (mark) => {
    const lead = leadJob((await listJobs(root)).filter((j) => j.board === job.board && j.markId === job.markId))
    const thread = message ? [...mark.thread, { by: job.role, at: now(), text: message }] : mark.thread
    if (!lead) return { ...mark, thread }
    const { claimedBy: _by, claimedAt: _at, ...rest } = mark
    return { ...rest, thread, jobId: lead.id, status: MARK_STATUS_FOR_JOB[lead.status] }
  })
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

/**
 * Remove cards (and card ids, for files that did not load) and every edge that touches them; edges go first, so an
 * interrupted run leaves no edge to a missing card.
 */
async function removeCards(root: string, board: Board, cards: Card[], moreIds: readonly string[] = [], moreEdges: readonly string[] = []): Promise<void> {
  const ids = new Set([...cards.map((c) => c.id), ...moreIds])
  for (const e of board.edges.filter((e) => ids.has(e.from) || ids.has(e.to))) await deleteEdge(root, board.name, e.id)
  for (const id of moreEdges) await deleteEdge(root, board.name, id)
  for (const id of ids) await deleteCard(root, board.name, id)
}

/** Every card and edge id a job's answer can have, so a dismiss removes them even when a file no longer loads. */
function derivedIds(job: Job): { cards: string[]; edges: string[] } {
  const ids = answerIds(job)
  const n = [0, 1, 2, 3, 4]
  return { cards: [ids.note, ...n.map(ids.option)], edges: [ids.toNote, ...n.map(ids.toOption)] }
}

/** The faded card that stands for the job while it works; it becomes the first option's card at approval. */
async function placePlaceholder(root: string, job: Job): Promise<void> {
  const board = await loadBoard(root, job.board)
  const size = { w: IMAGE_CARD_W, h: IMAGE_CARD_W }
  // Beside the mark, or under the answers already there (the answer this one revises among them).
  const [spot] = placeRow(answerStart(board, job.markId), [size], occupiedRects(board))
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
  const start = placeholder ? { x: placeholder.x, y: placeholder.y } : answerStart(board, job.markId)
  const spots = placeRow(start, cards.map((c) => ({ w: c.w, h: cardHeight(c) })), occupiedRects(board, new Set(own.map((c) => c.id))))
  const keep = new Set(cards.map((c) => c.id))
  await removeCards(root, board, own.filter((c) => !keep.has(c.id)))
  for (const [i, card] of cards.entries()) await saveCard(root, job.board, { ...card, ...spots[i]!, createdAt: own.find((c) => c.id === card.id)?.createdAt ?? card.createdAt })
  if (board.marks.some((m) => m.id === job.markId)) await saveEdge(root, job.board, { id: ids.toNote, from: job.markId, to: note.id, madeBy: job.role })
  for (const [i, card] of options.entries()) await saveEdge(root, job.board, { id: ids.toOption(i), from: note.id, to: card.id, madeBy: job.role })
}

// ---- prompts

const clip = (text: string, max = 600) => (text.length > max ? text.slice(0, max - 1) + "…" : text)
/**
 * Text someone wrote, as one quoted line: newlines flattened and quotes escaped, so a message cannot start a line
 * that looks like another speaker ("you: ...") or like River's own instructions.
 */
const quoted = (text: string, max = 2000) => JSON.stringify(clip(text.replace(/\s+/g, " ").trim(), max))

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
      return `note: ${quoted(card.text ?? "", 600)}`
    case "concept":
      return `concept art in concepts/${card.ref}/${card.variant ? ` (option ${card.variant.toUpperCase()}${card.caption ? `: ${card.caption}` : ""})` : ""}`
    case "ref":
      return `reference image ${card.ref}${card.source?.title ? ` (${card.source.title})` : ""}`
  }
}

/** The user's request: the mark's thread, one quoted line per message, then the cards it is on. */
async function conceptPrompt(project: Project, board: string, mark: Mark): Promise<string> {
  const cards = (await loadBoard(project.root, board)).cards
  const lines = [
    'The user marked the storyboard and asked. The mark\'s thread, oldest first, one message per line: who wrote it, then the message in quotes ("you" is the user):',
    ...mark.thread.map((m) => `- ${m.by}: ${quoted(m.text)}`),
  ]
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

/** A rendered option's PNG and where a turn's worktree gets a copy to look at with Read (relative to the project root). */
interface RenderCopy {
  variant?: string
  from: string
  to: string
}

/** The renders of a job that still exist (a dismiss removes them), each to be copied to `<folder>/<render name>`. */
function renderCopies(root: string, job: Job, folder: string): RenderCopy[] {
  return (job.scripts ?? [])
    .filter((s) => s.render?.ok)
    .map((s) => ({ ...(s.variant ? { variant: s.variant } : {}), from: path.join(root, ".river", "jobs", job.id, jobRenderName(s.variant)), to: `${folder}/${jobRenderName(s.variant)}` }))
    .filter((r) => existsSync(r.from))
}

/** The previous answer, for a revision: each option with its caption, how its render went and where to see it, and the scripts when the agent cannot resume. */
async function revisionPrompt(project: Project, parent: Job, replies: string[], conceptId: string, withScripts: boolean, renders: RenderCopy[]): Promise<string> {
  const lines = [`This revises your previous answer (job ${parent.id}, folder concepts/${parent.conceptId}/).`]
  if (parent.summary) lines.push(`Your note then: ${quoted(parent.summary)}`)
  if (renders.length > 0) lines.push("Look at your previous renders with Read before you change anything; the paths are below.")
  for (const s of parent.scripts ?? []) {
    const seen = renders.find((r) => r.variant === s.variant)
    const how = !s.render ? "not rendered" : s.render.ok ? `rendered${seen ? `, see ${seen.to}` : ""}` : `failed to render. Godot said:\n${s.render.error}`
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
    replies.length > 0 ? `The user replied, one message per line:\n${replies.map((r) => `- you: ${quoted(r)}`).join("\n")}` : "The user asked for a fix: make the scripts render.",
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
  /** Renders copied into the worktree before the turn, so the agent can Read them. */
  renders?: RenderCopy[]
}

/** Jobs whose agent turn runs in this process, so a dismiss can stop the turn before removing its worktree. */
const live = new Map<string, { abort: AbortController; run: Promise<Job> }>()

/**
 * Under the mark's lock: `check` the mark still allows the job, then record the job's owner (before the job file
 * exists, so recoverJobs elsewhere never sees it queued without one), the job, and the mark's pointer to it. Two
 * starts or revisions on one mark can no longer both pass the check. Returns the owner's stop().
 */
async function reserveJob(root: string, queued: Job, by: string, check: (mark: Mark) => Promise<void>): Promise<() => void> {
  return withMarkLock(root, queued.board, queued.markId, async () => {
    const mark = await loadMark(root, queued.board, queued.markId)
    if (!mark) throw new Error(`river: no mark ${queued.markId} on board ${queued.board}`)
    await check(mark)
    if (existsSync(path.join(root, ".river", "jobs", `${queued.id}.json`))) throw new Error(`river: job ${queued.id} already exists`)
    const holder = liveClaim(mark)
    if (holder && holder !== by && by !== "you") throw new Error(`river: mark ${mark.id} is claimed by ${holder}; only ${holder} or the user can start a River job on it`)
    const stop = await claimJob(root, queued.id)
    try {
      await saveJob(root, queued)
      const { claimedBy: _by, claimedAt: _at, ...rest } = mark
      const took = holder && holder !== by ? [{ by: CONCEPT_ROLE, at: now(), text: `River job ${queued.id} took this mark over from ${holder}'s claim.` }] : []
      await saveMark(root, queued.board, { ...rest, thread: [...mark.thread, ...took], jobId: queued.id, status: MARK_STATUS_FOR_JOB.queued })
      return stop
    } catch (err) {
      stop()
      throw err
    }
  })
}

/** Reserve the job on its mark, run its turn and resolve with the job at "approval" (or "failed", or "dismissed"). */
async function launchJob(project: Project, queued: Job, settings: JobAgentSettings, ask: Ask, deps: JobDeps, reserve: () => Promise<() => void>): Promise<Job> {
  const abort = new AbortController()
  // In `live` before the job file exists, so a dismiss from this process always waits for the run.
  const run = reserve().then(async (stop) => {
    try {
      return await runConceptTurn(project, settings, queued, ask, abort.signal, deps)
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

function queuedJob(mark: Mark, board: string, settings: JobAgentSettings, parentJobId?: string, jobId?: string): Job {
  const id = jobId ?? newBoardId("j_")
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

/**
 * One concept-mode turn in `dir` (the job's worktree), resuming session `resume` when given. Collects the session
 * id, the texts and the errors; a caller that resumed starts fresh when the errors say the session is gone.
 */
async function conceptTurn(
  dir: string,
  job: Job,
  settings: JobAgentSettings,
  ask: { prompt: string; resume?: string; brief?: string },
  signal: AbortSignal,
  deps: JobDeps,
  runTurn: RunTurn,
): Promise<{ sessionId?: string; texts: string[]; errors: string[] }> {
  const out: { sessionId?: string; texts: string[]; errors: string[] } = { texts: [], errors: [] }
  await runTurn(
    {
      root: dir,
      mode: "concept",
      model: settings.model,
      prompt: ask.prompt,
      backend: settings.backend,
      conceptId: job.conceptId,
      ...(ask.resume ? { sessionId: ask.resume } : {}),
      ...(ask.brief ? { brief: ask.brief } : {}),
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
      onPermission: async () => ({ behavior: "deny", message: "A concept job asks for nothing: it writes only its own folder." }),
      signal,
    },
  )
  return out
}

async function runConceptTurn(project: Project, settings: JobAgentSettings, job: Job, ask: Ask, signal: AbortSignal, deps: JobDeps): Promise<Job> {
  const root = project.root
  let sessionId: string | undefined
  try {
    await syncMark(root, job)
    await placePlaceholder(root, job)
    const created = await createJobWorktree(root, job.id)
    job = await transition(root, job, "running", created)
    const dir = path.join(created.worktree, job.projectSub)
    for (const r of ask.renders ?? []) {
      await mkdir(path.dirname(path.join(dir, r.to)), { recursive: true })
      await copyFile(r.from, path.join(dir, r.to))
    }
    const runTurn = deps.runTurn ?? ((r, h) => startAgentTurn(r, h))
    const brief = await readBrief(root)
    const fresh = { prompt: ask.prompt, ...(brief ? { brief } : {}) }
    let result = await conceptTurn(dir, job, settings, ask.resume ? { ...fresh, prompt: ask.resume.prompt, resume: ask.resume.sessionId } : fresh, signal, deps, runTurn)
    if (ask.resume && !signal.aborted && result.errors.some((e) => NO_SESSION.test(e))) {
      // The earlier session is gone (another machine, cleared history): start fresh with everything in the prompt.
      result = await conceptTurn(dir, job, settings, fresh, signal, deps, runTurn)
    }
    sessionId = result.sessionId
    if (signal.aborted) return await dismiss(root, await loadJob(root, job.id))
    const kept = sessionId ? { sessionId } : {}

    const folder = conceptPath(job.conceptId)
    const scripts = await writtenScripts(path.join(dir, folder))
    const problem = scriptsProblem(folder, scripts, result.errors)
    if (problem) return await fail(root, job, problem, kept)

    let headSha = ""
    const records: JobScriptRecord[] = []
    for (const s of scripts) {
      const file = conceptPath(job.conceptId, s.name)
      headSha = await commitJobFile(root, job.id, inRepo(job, file), s.bytes, `river: concept ${job.conceptId} ${s.name}`)
      records.push({ file, sha256: hash(s.bytes), approved: false, ...(s.variant ? { variant: s.variant } : {}), ...(s.caption ? { caption: s.caption } : {}) })
    }
    const summary = clip(result.texts.at(-1) || `The concept artist wrote ${records.map((r) => path.posix.basename(r.file)).join(", ")}.`, SUMMARY_MAX)
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
 * (or "failed"). Throws only when no job could be created (unknown mark, a job already active on it,
 * a mark another agent has claimed).
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
  const queued = queuedJob(mark, req.board, req, undefined, req.jobId)
  const check = async (m: Mark) => {
    const lead = await leadOf(m)
    if (lead && JOB_NEXT[lead.status].length > 0) {
      throw new Error(`river: mark ${m.id} already has job ${lead.id} (${lead.status})${lead.status === "answered" ? "; reply on the mark and revise it, or dismiss it" : ""}`)
    }
  }
  const ask = { prompt: await conceptPrompt(project, req.board, mark) }
  return launchJob(project, queued, req, ask, deps, () => reserveJob(root, queued, req.by ?? "you", check))
}

/**
 * Answer the user's reply on a mark: a new job (parentJobId = jobId) that gets the previous answer, how its
 * renders went (and copies of them to look at) and the reply, and resumes the agent's session when there is one.
 * `jobId` must be the mark's latest job: answered or accepted (with a reply by the user after its answer, such as
 * "I like A, try two more takes on A"), or failed (a reply is optional: the revision fixes what broke). The
 * previous job stays as it is; the user can still accept or dismiss it. Resolves like startConceptJob.
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
  const check = async (m: Mark) => {
    if (m.jobId !== parent.id) throw new Error(`river: job ${jobId} is not the latest answer on mark ${m.id} (that is ${m.jobId ?? "none"}); revise that one`)
    if (parent.status !== "failed" && repliesAfter(m, parent).length === 0) throw new Error(`river: reply on mark ${m.id} first: say what to change`)
  }
  await check(mark)
  const replies = repliesAfter(mark, parent)

  const queued = queuedJob(mark, parent.board, settings, parent.id)
  const renders = renderCopies(root, parent, conceptPath(queued.conceptId, "previous"))
  const request = await conceptPrompt(project, parent.board, mark)
  const ask: Ask = { prompt: `${request}\n\n${await revisionPrompt(project, parent, replies, queued.conceptId, true, renders)}`, renders }
  if (parent.sessionId) ask.resume = { sessionId: parent.sessionId, prompt: await revisionPrompt(project, parent, replies, queued.conceptId, false, renders) }
  return launchJob(project, queued, settings, ask, deps, () => reserveJob(root, queued, "you", check))
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

// ---- the look at the renders

const SELF_CHECK_TURNS = 6
const SELF_CHECK_ASK = "River rendered your scripts."

/** Who looks at the renders, or undefined to skip (see JobDeps.selfCheck). */
function selfCheckSettings(job: Job, deps: JobDeps): JobAgentSettings | undefined {
  if (deps.selfCheck === false) return undefined
  if (deps.selfCheck) return deps.selfCheck
  if ((deps.env ?? process.env).RIVER_SELF_CHECK === "off") return undefined
  if (deps.render && !deps.runTurn) return undefined
  return { model: job.model as AgentModel, backend: job.backend }
}

/** One line of display text: no control or bidi characters, whitespace collapsed, at most `max` characters. */
const displayLine = (text: string, max: number) => clip(text.replace(/[\p{Cc}‪-‮⁦-⁩]+/gu, " ").replace(/\s+/g, " ").trim(), max)

/** The note and captions from the turn's text: the first {...} span ending at the last "}" that parses with a note, or undefined. */
function parseSelfCheck(text: string): { note: string; captions: Record<string, string> } | undefined {
  const end = text.lastIndexOf("}")
  for (let start = text.indexOf("{"); start >= 0 && start < end; start = text.indexOf("{", start + 1)) {
    let v: { note?: unknown; captions?: unknown }
    try {
      v = JSON.parse(text.slice(start, end + 1)) as typeof v
    } catch {
      continue
    }
    if (typeof v.note !== "string" || !v.note.trim()) continue
    const captions: Record<string, string> = {}
    if (v.captions && typeof v.captions === "object") for (const [k, c] of Object.entries(v.captions)) if (typeof c === "string") captions[k.toLowerCase()] = c
    return { note: v.note, captions }
  }
  return undefined
}

/**
 * One more turn, after rendering and before the job is answered: the agent looks at its renders (copied into the
 * worktree, opened with Read) and may rewrite its note and captions to say what they really show. It cannot
 * change the scripts: River runs and applies only the approved, committed bytes. Resumes the job's session in
 * its worktree when it can. Returns the new records and note, or undefined when it is skipped or says nothing usable.
 */
async function selfCheck(project: Project, job: Job, scripts: JobScriptRecord[], deps: JobDeps): Promise<{ scripts: JobScriptRecord[]; summary: string } | undefined> {
  const settings = selfCheckSettings(job, deps)
  const dir = path.join(job.worktree, job.projectSub)
  if (!settings || !existsSync(dir)) return undefined
  const root = project.root
  const renders = renderCopies(root, { ...job, scripts }, conceptPath(job.conceptId))
  for (const r of renders) await copyFile(r.from, path.join(dir, r.to))
  const options = scripts.map((s) => {
    const seen = renders.find((r) => r.variant === s.variant)
    return `- ${optionName(s)}${s.variant ? ` (key "${s.variant}")` : ""}${s.caption ? `, caption ${quoted(s.caption)}` : ""}: ${seen ? seen.to : `did not render: ${quoted(s.render?.ok === false ? s.render.error : "", 300)}`}`
  })
  const ask = [
    `${SELF_CHECK_ASK} Look at each render with Read before you answer:`,
    ...options,
    `Your note was: ${quoted(job.summary ?? "")}`,
    "",
    "Check each picture against what you meant and what the user asked. You cannot change the scripts now: new scripts would need the user's approval again, so do not call concept_write.",
    "Rewrite the note and the captions so they say what the renders really show (same rules as before: plain text, under 90 words, one line per option). If a render misses its idea, say so in the note and suggest the user asks for a revision.",
    'Answer with only this JSON: {"note": "...", "captions": {"a": "..."}} (captions keyed by option letter; leave captions out for a single drawing).',
  ].join("\n")
  const mark = await loadMark(root, job.board, job.markId)
  const fresh = mark ? `${await conceptPrompt(project, job.board, mark)}\n\n${ask}` : ask
  const runTurn = deps.runTurn ?? ((r, h) => startAgentTurn(r, h, { maxTurns: SELF_CHECK_TURNS, effort: "low" }))
  const never = new AbortController().signal
  let result = await conceptTurn(dir, job, settings, job.sessionId ? { prompt: ask, resume: job.sessionId } : { prompt: fresh }, never, deps, runTurn)
  if (job.sessionId && result.errors.some((e) => NO_SESSION.test(e))) result = await conceptTurn(dir, job, settings, { prompt: fresh }, never, deps, runTurn)
  const parsed = parseSelfCheck(result.texts.join("\n"))
  if (!parsed) return undefined
  const summary = clip(parsed.note.trim(), SUMMARY_MAX)
  const next = scripts.map((s) => {
    const caption = displayLine(parsed.captions[s.variant ?? ""] ?? "", CAPTION_MAX)
    return caption ? { ...s, caption } : s
  })
  const board = await loadBoard(root, job.board)
  const ids = answerIds(job)
  for (const card of ownCards(board, job)) {
    const script = card.kind === "concept" ? next.find((s) => s.variant === card.variant) : undefined
    if (card.id === ids.note && card.text !== summary) await saveCard(root, job.board, { ...card, text: summary })
    else if (script?.caption && card.caption !== script.caption) await saveCard(root, job.board, { ...card, caption: script.caption })
  }
  return { scripts: next, summary }
}

/**
 * The user approves every script's exact bytes at once: `shas` maps each script's file (as readJobScripts
 * gives it) to its sha256. Refuses (throws, nothing changes) unless the job is in "approval" and `shas`
 * names exactly the job's scripts with matching hashes. Then renders each in a sandbox Godot project and
 * puts each PNG on the job branch. A script that fails keeps Godot's output on its record and its card
 * says so; the job is "answered" when at least one rendered, "failed" when none did. Before it is answered,
 * the agent looks at the renders once (JobDeps.selfCheck) and may rewrite its note and captions.
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
      if (done.some((s) => s.render?.ok)) {
        const checked = await selfCheck(project, job, done, deps).catch((err: unknown) => {
          console.warn(`river: job ${job.id}: the look at the renders failed, so the note stays as written: ${errMsg(err)}`)
          return undefined
        })
        if (!checked) return await transition(root, job, "answered", { headSha, scripts: done })
        const rewritten = checked.summary !== job.summary ? checked.summary : undefined
        return await transition(root, job, "answered", { headSha, scripts: checked.scripts, summary: checked.summary }, rewritten)
      }
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
  await installKit(root).catch((err: unknown) => console.warn(`river: job ${jobId} is accepted, but ${KIT_FILE} could not be written: ${errMsg(err)}`))
  await finishAccept(root, accepted).catch((err: unknown) =>
    console.warn(`river: job ${jobId} is accepted, but tidying up failed (retried when the project next opens): ${errMsg(err)}`),
  )
  return accepted
}

/**
 * Accepted scripts call Kit, which the sandbox gives them as res://kit.gd. The game gets the same bytes at
 * concepts/kit.gd (class_name Kit), so the scripts parse there too. River replaces its own older copy and
 * never a file someone edited; then it says so, since the scripts may not match that file's Kit.
 */
async function installKit(root: string): Promise<void> {
  const file = path.join(root, ...KIT_FILE.split("/"))
  const existing = await readFile(file, "utf8").catch(() => undefined)
  const action = kitFileAction(existing)
  if (action === "keep") console.warn(`river: ${KIT_FILE} was edited, so River left it as it is; accepted concept scripts call the Kit functions in it`)
  if (action !== "write") return
  await mkdir(path.dirname(file), { recursive: true })
  await writeFile(file, kitFileText(), "utf8")
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
  const derived = derivedIds(job)
  await removeCards(root, board, ownCards(board, job), derived.cards, derived.edges)
  if (job.status !== "dismissed") {
    const dismissed = await transition(root, job, "dismissed")
    // After the move, so a brief that cannot be written never leaves the job half dismissed.
    if (reason?.trim()) {
      const asked = (await loadMark(root, job.board, job.markId))?.thread.find((m) => m.by === "you")?.text
      await addTurnedDown(root, job.id, `${reason.trim()}${asked ? ` (asked: "${clip(asked.replace(/\s+/g, " "), 120)}")` : ""}`).catch((err: unknown) =>
        console.warn(`river: job ${job.id} is dismissed, but the reason could not be added to .river/brief.md: ${errMsg(err)}`),
      )
    }
    return dismissed
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
