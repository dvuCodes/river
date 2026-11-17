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
import { copyFile, readFile } from "node:fs/promises"
import path from "node:path"
import { godotSettings, lintConceptScript, renderConcept, type RenderConceptRequest } from "@river/adapter-godot"
import {
  applyJobPaths,
  commitPaths,
  CONCEPT_RENDER,
  CONCEPT_SCRIPT,
  conceptPath,
  createJobWorktree,
  deleteCard,
  JOB_NEXT,
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

/** The bytes of the job's script in its latest commit: the only copy River hashes, renders and applies. */
async function committedScript(root: string, job: Job): Promise<{ file: string; bytes: Buffer }> {
  const script = job.scripts?.[0]
  if (!script || !job.headSha) throw new Error(`river: job ${job.id} has no script yet`)
  return { file: script.file, bytes: await readCommittedFile(root, job.headSha, inRepo(job, script.file)) }
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
  if (mark.jobId) {
    const previous = await loadJob(root, mark.jobId).catch(() => undefined)
    // Asking again replaces a failed attempt (its card and worktree go); anything else still in flight blocks.
    if (previous?.status === "failed") await dismissJob(root, previous.id)
    else if (previous && JOB_NEXT[previous.status].length > 0) throw new Error(`river: mark ${mark.id} already has job ${previous.id} (${previous.status})`)
  }

  const id = newBoardId("j_")
  const at = now()
  let job = await saveJob(root, {
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
  })
  await syncMark(root, job)
  await saveCard(root, req.board, pendingCard(mark, job))

  let created: { worktree: string; branch: string } | undefined
  try {
    created = await createJobWorktree(root, id)
    job = await transition(root, job, "running", created)
    const texts: string[] = []
    const errors: string[] = []
    const runTurn = deps.runTurn ?? ((r, h) => startAgentTurn(r, h))
    await runTurn(
      {
        root: path.join(job.worktree, job.projectSub),
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
      },
    )

    const file = conceptPath(job.conceptId, CONCEPT_SCRIPT)
    const written = await readFile(path.join(job.worktree, job.projectSub, file)).catch(() => undefined)
    if (!written) return await fail(root, job, errors.length > 0 ? errors.join("\n") : `The concept artist did not write ${file}.`)
    const problems = lintConceptScript(written.toString("utf8"))
    if (problems.length > 0) return await fail(root, job, [`${file} does not pass the concept lint:`, ...problems].join("\n"))

    const headSha = await commitPaths(job.worktree, [inRepo(job, file)], `river: concept ${job.conceptId}`)
    const bytes = await readCommittedFile(root, headSha, inRepo(job, file))
    // The app shows the worktree file for approval; it must be the committed bytes, or the approval could never match.
    if (!bytes.equals(written)) return await fail(root, job, `git changed ${file} when committing it (check the repo's .gitattributes); River needs it byte for byte.`)
    const summary = texts.at(-1) || `The concept artist wrote ${file}.`
    return await transition(root, job, "approval", { headSha, summary, scripts: [{ file, sha256: hash(bytes), approved: false }] }, summary)
  } catch (err) {
    const ended = await fail(root, job, errMsg(err))
    // Dismissed while still queued: the dismiss could not know the worktree this call went on to create.
    if (ended.status === "dismissed" && created) await removeJobWorktree(root, created.worktree, created.branch)
    return ended
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

  job = await transition(root, job, "rendering", { scripts: [{ ...job.scripts![0]!, approved: true }] })
  try {
    const png = path.join(root, ".river", "jobs", job.id, "render.png")
    await (deps.render ?? renderConcept)({ bin, script: bytes, outPng: png })
    const render = conceptPath(job.conceptId, CONCEPT_RENDER)
    await copyFile(png, path.join(job.worktree, job.projectSub, render))
    const headSha = await commitPaths(job.worktree, [inRepo(job, render)], `river: render ${job.conceptId}`)
    return await transition(root, job, "answered", { headSha })
  } catch (err) {
    return fail(root, job, errMsg(err))
  }
}

/**
 * Apply the job's concept folder to the user's checkout (index and other files untouched), check
 * the script arrived byte for byte, keep the card, and remove the worktree and branch.
 */
export async function acceptJob(workspaceRoot: string, jobId: string): Promise<Job> {
  const root = await projectRoot(workspaceRoot)
  const job = await loadJob(root, jobId)
  if (job.status !== "answered") throw new Error(`river: job ${jobId} is ${job.status}; only an answered job can be accepted`)
  const script = job.scripts![0]!
  await applyJobPaths(root, job.baseSha, job.headSha!, inRepo(job, conceptPath(job.conceptId)))
  const applied = await readFile(path.join(root, script.file))
  if (hash(applied) !== script.sha256) return fail(root, job, `${script.file} in your project differs from the approved script; River did not accept it.`)
  const card = await findPendingCard(root, job)
  if (card) {
    const { pending: _pending, ...kept } = card
    await saveCard(root, job.board, kept)
  }
  await removeJobWorktree(root, job.worktree, job.branch)
  return transition(root, job, "accepted")
}

/** Throw the job away from any non-terminal state: worktree, branch and card go first, then the job is dismissed. */
export async function dismissJob(workspaceRoot: string, jobId: string): Promise<Job> {
  const root = await projectRoot(workspaceRoot)
  const job = await loadJob(root, jobId)
  if (!JOB_NEXT[job.status].includes("dismissed")) throw new Error(`river: job ${jobId} is ${job.status}; it cannot be dismissed`)
  await removeJobWorktree(root, job.worktree, job.branch)
  const card = await findPendingCard(root, job)
  if (card) await deleteCard(root, job.board, card.id)
  return transition(root, job, "dismissed")
}

/** Jobs a crashed or closed process left queued, running or rendering become "failed". Call once at startup. */
export async function recoverJobs(workspaceRoot: string): Promise<Job[]> {
  const root = await projectRoot(workspaceRoot)
  const recovered: Job[] = []
  for (const job of await listJobs(root)) {
    if (INTERRUPTIBLE.includes(job.status)) {
      recovered.push(await transition(root, job, "failed", { error: `interrupted: River stopped while this job was ${job.status}` }))
    }
  }
  return recovered
}
