/**
 * Concept jobs: one agent answers one mark with a Godot drawing script, on its own branch in its
 * own worktree. The job is a state machine over core JOB_NEXT; every move goes through
 * `transition`, which also keeps the mark's status in step (MARK_STATUS_FOR_JOB).
 *
 *   queued -> running -> approval -> rendering -> answered -> accepted
 *        (any non-terminal state) -> dismissed;  (most states) -> failed -> dismissed
 *
 * Nothing runs the agent's script until approveJobScript gets the sha256 of its exact bytes.
 * Those bytes are read once, from the job's commit, then hashed, rendered and later applied.
 */
import { createHash } from "node:crypto"
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises"
import { hostname } from "node:os"
import path from "node:path"
import { conceptScriptBytesProblem, godotSettings, lintConceptScript, renderConcept, type RenderConceptRequest } from "@river/adapter-godot"
import {
  applyJobFiles,
  commitJobFile,
  CONCEPT_RENDER,
  CONCEPT_SCRIPT,
  conceptPath,
  createJobWorktree,
  deleteCard,
  gitTop,
  JOB_NEXT,
  listJobBranches,
  listJobs,
  loadBoard,
  loadJob,
  loadMark,
  loadProject,
  loadStory,
  MARK_STATUS_FOR_JOB,
  newBoardId,
  passageById,
  proseText,
  readCommittedFile,
  removeJobWorktree,
  saveCard,
  saveJob,
  saveMark,
  type Card,
  type Job,
  type JobStatus,
  type Mark,
  type Project,
} from "@river/core"
import { startAgentTurn } from "./run"
import type { AgentBackend, AgentEvent, AgentModel, AgentTurnHandlers, AgentTurnRequest } from "./types"

export interface ConceptJobRequest {
  /** The user's project root (the folder with river.json). Boards, marks, jobs and renders live here. */
  workspaceRoot: string
  board: string
  markId: string
  model: AgentModel
  backend: AgentBackend
  apiKey?: string
  claudePath?: string
}

/** Runs one agent turn; never throws (problems arrive as error events). */
export type RunTurn = (req: AgentTurnRequest, handlers: AgentTurnHandlers) => Promise<void>

export interface JobDeps {
  /** Default startAgentTurn. Tests pass a fake that writes a known draw.gd. */
  runTurn?: RunTurn
  /** Every event of the agent turn, for progress output. */
  onEvent?: (event: AgentEvent) => void
  /** Default renderConcept (real Godot). */
  render?: (req: RenderConceptRequest) => Promise<void>
  /** For GODOT_BIN and $VARs in river.json. Default process.env. */
  env?: NodeJS.ProcessEnv
}

/** The script a job waits on, as the user must see it before approving. */
export interface JobScript {
  /** Relative to the project root: concepts/<conceptId>/draw.gd. */
  file: string
  text: string
  sha256: string
}

export const CONCEPT_ROLE = "concept-artist"
const CARD_WIDTH = 260
const CARD_GAP = 40
const INTERRUPTIBLE: readonly JobStatus[] = ["queued", "running", "rendering"]

const now = () => new Date().toISOString()
const hash = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex")
const errMsg = (err: unknown) => (err instanceof Error ? err.message : String(err))
/** A project-relative path as a path from the git top level, which is what the job's commits use. */
const inRepo = (job: Job, rel: string) => path.posix.join(job.projectSub, rel)
const projectRoot = async (workspaceRoot: string) => (await loadProject(workspaceRoot)).root

async function syncMark(root: string, job: Job, message?: string): Promise<void> {
  const mark = await loadMark(root, job.board, job.markId)
  if (!mark) return
  const thread = message ? [...mark.thread, { by: CONCEPT_ROLE, at: now(), text: message }] : mark.thread
  await saveMark(root, job.board, { ...mark, jobId: job.id, status: MARK_STATUS_FOR_JOB[job.status], thread })
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
async function fail(root: string, job: Job, error: string): Promise<Job> {
  const current = await loadJob(root, job.id)
  return JOB_NEXT[current.status].includes("failed") ? transition(root, current, "failed", { error }) : current
}

/** The faded card beside the mark: right of its bounding box, level with its top. */
function pendingCard(mark: Mark, job: Job): Omit<Card, "id" | "createdAt"> {
  const xs = mark.path.filter((_, i) => i % 2 === 0)
  const ys = mark.path.filter((_, i) => i % 2 === 1)
  return {
    kind: "concept",
    x: xs.length > 0 ? Math.max(...xs) + CARD_GAP : 0,
    y: ys.length > 0 ? Math.min(...ys) : 0,
    w: CARD_WIDTH,
    ref: job.conceptId,
    madeBy: CONCEPT_ROLE,
    pending: { markId: mark.id, jobId: job.id },
  }
}

async function findPendingCard(root: string, job: Job): Promise<Card | undefined> {
  return (await loadBoard(root, job.board)).cards.find((c) => c.pending?.jobId === job.id)
}

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
      return `concept art in concepts/${card.ref}/`
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
 * The bytes of the job's script in its latest commit: the only copy River shows, hashes, renders and
 * applies. Refuses bytes a person could not read as shown (a job committed before that rule).
 */
async function committedScript(root: string, job: Job): Promise<{ file: string; bytes: Buffer }> {
  const script = job.scripts?.[0]
  if (!script || !job.headSha) throw new Error(`river: job ${job.id} has no script yet`)
  const bytes = await readCommittedFile(root, job.headSha, inRepo(job, script.file))
  const unreadable = conceptScriptBytesProblem(bytes)
  if (unreadable) throw new Error(`river: refused: ${script.file} cannot be shown as it would run. ${unreadable} Dismiss the job and ask again.`)
  return { file: script.file, bytes }
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
  if (mark.jobId) {
    const previous = await loadJob(root, mark.jobId).catch(() => undefined)
    // Asking again replaces a failed attempt (its card and worktree go); anything else still in flight blocks.
    if (previous?.status === "failed") await dismissJob(root, previous.id)
    else if (previous && JOB_NEXT[previous.status].length > 0) throw new Error(`river: mark ${mark.id} already has job ${previous.id} (${previous.status})`)
  }

  const id = newBoardId("j_")
  const at = now()
  const queued: Job = {
    id,
    markId: mark.id,
    board: req.board,
    role: CONCEPT_ROLE,
    model: req.model,
    backend: req.backend,
    status: "queued",
    conceptId: id,
    baseSha: "",
    branch: "",
    worktree: "",
    projectSub: "",
    createdAt: at,
    updatedAt: at,
  }
  const abort = new AbortController()
  // In `live` before the job file exists, so a dismiss from this process always waits for the run.
  // Claimed before it exists too, so recoverJobs elsewhere never sees it queued without an owner.
  const run = claimJob(root, id).then(async (stop) => {
    try {
      return await runConceptTurn(project, req, mark, await saveJob(root, queued), abort.signal, deps)
    } finally {
      stop()
    }
  })
  live.set(id, { abort, run })
  try {
    return await run
  } finally {
    live.delete(id)
  }
}

/** Jobs whose agent turn runs in this process, so a dismiss can stop the turn before removing its worktree. */
const live = new Map<string, { abort: AbortController; run: Promise<Job> }>()

async function runConceptTurn(project: Project, req: ConceptJobRequest, mark: Mark, job: Job, signal: AbortSignal, deps: JobDeps): Promise<Job> {
  const root = project.root
  try {
    await syncMark(root, job)
    await saveCard(root, req.board, pendingCard(mark, job))
    const created = await createJobWorktree(root, job.id)
    job = await transition(root, job, "running", created)
    const texts: string[] = []
    const errors: string[] = []
    const runTurn = deps.runTurn ?? ((r, h) => startAgentTurn(r, h))
    await runTurn(
      {
        root: path.join(created.worktree, job.projectSub),
        mode: "concept",
        model: req.model,
        prompt: await conceptPrompt(project, req.board, mark),
        backend: req.backend,
        conceptId: job.conceptId,
        ...(req.apiKey ? { apiKey: req.apiKey } : {}),
        ...(req.claudePath ? { claudePath: req.claudePath } : {}),
      },
      {
        onEvent: (e) => {
          deps.onEvent?.(e)
          if (e.type === "text") texts.push(e.text.trim())
          if (e.type === "error") errors.push(e.message)
        },
        onPermission: async () => ({ behavior: "deny", message: "A concept job asks for nothing: it writes only its own folder." }),
        signal,
      },
    )
    if (signal.aborted) return await dismiss(root, await loadJob(root, job.id))

    const file = conceptPath(job.conceptId, CONCEPT_SCRIPT)
    const written = await readFile(path.join(created.worktree, job.projectSub, file)).catch(() => undefined)
    if (!written) return await fail(root, job, errors.length > 0 ? errors.join("\n") : `The concept artist did not write ${file}.`)
    const unreadable = conceptScriptBytesProblem(written)
    if (unreadable) return await fail(root, job, `${file}: ${unreadable}`)
    const problems = lintConceptScript(written.toString("utf8"))
    if (problems.length > 0) return await fail(root, job, [`${file} does not pass the concept lint:`, ...problems].join("\n"))

    const headSha = await commitJobFile(root, job.id, inRepo(job, file), written, `river: concept ${job.conceptId}`)
    const summary = texts.at(-1) || `The concept artist wrote ${file}.`
    return await transition(root, job, "approval", { headSha, summary, scripts: [{ file, sha256: hash(written), approved: false }] }, summary)
  } catch (err) {
    const ended = await fail(root, job, errMsg(err))
    // Dismissed by another process while this one set up: its dismiss could not see the card or worktree made after it.
    return ended.status === "dismissed" ? await dismiss(root, ended) : ended
  }
}

/** The script a job in "approval" wants to run, with the sha256 to pass to approveJobScript. */
export async function readJobScript(workspaceRoot: string, jobId: string): Promise<JobScript> {
  const root = await projectRoot(workspaceRoot)
  const { file, bytes } = await committedScript(root, await loadJob(root, jobId))
  return { file, text: bytes.toString("utf8"), sha256: hash(bytes) }
}

function godotBin(project: Project, env: NodeJS.ProcessEnv): string {
  if (project.manifest.adapter?.godot?.bin) return godotSettings(project, env).bin
  if (env.GODOT_BIN) return env.GODOT_BIN
  throw new Error('river: no Godot to render with. Set adapter.godot.bin in river.json (for example "$GODOT_BIN") or the GODOT_BIN environment variable.')
}

/**
 * The user approves the script's exact bytes. Refuses (throws, nothing changes) unless the job is
 * in "approval" and `sha256` matches. Then renders those bytes in a sandbox Godot project and puts
 * the PNG on the job branch. Resolves with the job "answered", or "failed" with Godot's output.
 */
export async function approveJobScript(workspaceRoot: string, jobId: string, sha256: string, deps: JobDeps = {}): Promise<Job> {
  const project = await loadProject(workspaceRoot)
  const root = project.root
  let job = await loadJob(root, jobId)
  if (job.status !== "approval") throw new Error(`river: job ${jobId} is ${job.status}; only a job waiting for approval can run its script`)
  const { bytes } = await committedScript(root, job)
  const actual = hash(bytes)
  if (sha256 !== actual || actual !== job.scripts![0]!.sha256) {
    throw new Error(`river: refused: the script's sha256 is ${actual}, but ${sha256} was approved`)
  }
  const bin = godotBin(project, deps.env ?? process.env)

  const stop = await claimJob(root, job.id)
  try {
    job = await transition(root, job, "rendering", { scripts: [{ ...job.scripts![0]!, approved: true }] })
    try {
      const png = path.join(root, ".river", "jobs", job.id, "render.png")
      await (deps.render ?? renderConcept)({ bin, script: bytes, outPng: png })
      const render = conceptPath(job.conceptId, CONCEPT_RENDER)
      const headSha = await commitJobFile(root, job.id, inRepo(job, render), await readFile(png), `river: render ${job.conceptId}`)
      return await transition(root, job, "answered", { headSha })
    } catch (err) {
      return await fail(root, job, errMsg(err))
    }
  } finally {
    stop()
  }
}

/** What follows an accept: the card keeps the concept without its pending flag, and the worktree and branch go. Safe to repeat. */
async function finishAccept(root: string, job: Job, card: Card | undefined): Promise<void> {
  if (card?.pending) {
    const { pending: _pending, ...kept } = card
    await saveCard(root, job.board, kept)
  }
  await removeJobWorktree(root, job.id)
}

/**
 * Write the job's concept folder into the user's checkout as the committed bytes (index and other
 * files untouched) and mark the job accepted. Throws, leaving the job answered and the checkout as it
 * was, when a file is in the way. Settling the card and removing the worktree follow; if they fail
 * the job stays accepted and recoverJobs finishes them.
 */
export async function acceptJob(workspaceRoot: string, jobId: string): Promise<Job> {
  const root = await projectRoot(workspaceRoot)
  const job = await loadJob(root, jobId)
  if (job.status !== "answered") throw new Error(`river: job ${jobId} is ${job.status}; only an answered job can be accepted`)
  const { bytes } = await committedScript(root, job)
  if (hash(bytes) !== job.scripts![0]!.sha256) throw new Error(`river: refused: the script on job ${jobId}'s branch is not the approved one`)
  await applyJobFiles(root, job.headSha!, inRepo(job, conceptPath(job.conceptId)))
  const accepted = await transition(root, job, "accepted")
  await findPendingCard(root, accepted)
    .then((card) => finishAccept(root, accepted, card))
    .catch((err: unknown) => console.warn(`river: job ${jobId} is accepted, but tidying up failed (retried when the project next opens): ${errMsg(err)}`))
  return accepted
}

/**
 * Worktree, branch, render folder and card go first, then the job is dismissed. A dismissed job is
 * cleaned up again, so whatever an earlier dismiss raced with (a card saved just after it) goes too.
 */
async function dismiss(root: string, job: Job): Promise<Job> {
  if (job.status !== "dismissed" && !JOB_NEXT[job.status].includes("dismissed")) throw new Error(`river: job ${job.id} is ${job.status}; it cannot be dismissed`)
  await removeJobWorktree(root, job.id)
  await rm(path.join(root, ".river", "jobs", job.id), { recursive: true, force: true, maxRetries: 3 })
  const card = await findPendingCard(root, job)
  if (card) await deleteCard(root, job.board, card.id)
  if (job.status !== "dismissed") return transition(root, job, "dismissed")
  const mark = await loadMark(root, job.board, job.markId)
  if (mark?.jobId === job.id && mark.status !== "dismissed") await syncMark(root, job)
  return job
}

/**
 * Throw the job away from any non-terminal state; dismissing it again tidies up anything left. A turn
 * running in this process is stopped first (it holds the worktree open). A turn running in another
 * process cannot be stopped from here.
 */
export async function dismissJob(workspaceRoot: string, jobId: string): Promise<Job> {
  const root = await projectRoot(workspaceRoot)
  const owned = live.get(jobId)
  if (owned) {
    owned.abort.abort()
    await owned.run.catch(() => undefined)
  }
  return dismiss(root, await loadJob(root, jobId))
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
  const cards = new Map<string, Card[]>()
  for (const job of ended) {
    try {
      if (!cards.has(job.board)) cards.set(job.board, (await loadBoard(root, job.board)).cards)
      const card = cards.get(job.board)!.find((c) => c.pending?.jobId === job.id)
      if (!card && !branches.has(job.id)) continue
      if (job.status === "accepted") await finishAccept(root, job, card)
      else await dismiss(root, job)
    } catch (err) {
      console.warn(`river: could not tidy up job ${job.id}: ${errMsg(err)}`)
    }
  }
}
