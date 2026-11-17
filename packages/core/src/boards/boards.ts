import { mkdir, readdir, readFile, rename, rm, unlink, writeFile } from "node:fs/promises"
import { randomBytes } from "node:crypto"
import path from "node:path"
import { newId } from "../review/store"
import { conceptRenderName, jobRenderName } from "../concepts/concepts"
import { cardHeight, markRect } from "./layout"
import { markLockFile, withLock } from "./lock"
import { CLAIM_STALE_MS, type Board, type Card, type Edge, type Job, type Mark, type MarkStatusChange } from "./types"

const SAFE_BOARD = /^[a-z0-9_-]{1,64}$/
/** Card, mark and job ids: our own are "c_"/"m_"/"j_" + 8 base36, but any plain file-safe name is read. */
const SAFE_ENTITY = /^[A-Za-z0-9_-]{1,64}$/

export const DEFAULT_BOARD = "main"

function assertBoardName(name: string): void {
  if (typeof name !== "string" || !SAFE_BOARD.test(name)) {
    throw new Error(`river: invalid board name ${JSON.stringify(name)} (use a-z, 0-9, _ and -, at most 64)`)
  }
}

function assertEntityId(kind: string, id: string): void {
  if (typeof id !== "string" || !SAFE_ENTITY.test(id)) throw new Error(`river: invalid ${kind} id ${JSON.stringify(id)}`)
}

/** Ids for new cards ("c_"), marks ("m_") and jobs ("j_"): the prefix plus 8 random base36 characters. */
export function newBoardId(prefix: "c_" | "m_" | "j_" | "e_"): string {
  return newId(prefix)
}

/** The exact text River writes for a card, mark, job or board.json (2-space JSON plus a newline). */
export function boardJsonText(value: unknown): string {
  return JSON.stringify(value, null, 2) + "\n"
}

/** Absolute folder of a board in the workspace: <root>/.river/boards/<name>. Rejects unsafe names. */
export function boardDir(workspaceRoot: string, name: string): string {
  assertBoardName(name)
  return path.join(workspaceRoot, ".river", "boards", name)
}

export function cardFile(workspaceRoot: string, board: string, cardId: string): string {
  assertEntityId("card", cardId)
  return path.join(boardDir(workspaceRoot, board), "cards", `${cardId}.json`)
}

export function markFile(workspaceRoot: string, board: string, markId: string): string {
  assertEntityId("mark", markId)
  return path.join(boardDir(workspaceRoot, board), "marks", `${markId}.json`)
}

export function edgeFile(workspaceRoot: string, board: string, edgeId: string): string {
  assertEntityId("edge", edgeId)
  return path.join(boardDir(workspaceRoot, board), "edges", `${edgeId}.json`)
}

const jobsDir = (workspaceRoot: string) => path.join(workspaceRoot, ".river", "jobs")
function jobFile(workspaceRoot: string, jobId: string): string {
  assertEntityId("job", jobId)
  return path.join(jobsDir(workspaceRoot), `${jobId}.json`)
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/**
 * Atomic write: a temp file in the same folder, then rename over the target. On Windows a rename onto a file
 * that another process is reading can fail for a moment (EPERM/EBUSY/EACCES), so it is retried briefly.
 */
export async function writeAtomic(file: string, text: string): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true })
  const tmp = path.join(path.dirname(file), `.${path.basename(file)}.${randomBytes(6).toString("hex")}.tmp`)
  await writeFile(tmp, text, "utf8")
  for (let attempt = 0; ; attempt++) {
    try {
      await rename(tmp, file)
      return
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code
      if (attempt < 20 && (code === "EPERM" || code === "EBUSY" || code === "EACCES")) {
        await sleep(5 + attempt * 5)
        continue
      }
      await rm(tmp, { force: true })
      throw err
    }
  }
}

async function removeFile(file: string): Promise<void> {
  try {
    await unlink(file)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err
  }
}

/** Entity files in a folder: *.json, not dotfiles (in-flight temp files start with a dot). */
async function jsonFiles(dir: string): Promise<string[]> {
  try {
    const names = await readdir(dir)
    return names.filter((n) => n.endsWith(".json") && !n.startsWith(".")).sort()
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return []
    throw err
  }
}

const byCreated = <T extends { createdAt: string; id: string }>(a: T, b: T) =>
  a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0

const finite = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n)

/** Why a card cannot be placed or drawn (a hand-edited file with "x": "10" or a width of 1e999), or undefined. */
function cardGeometryProblem(c: Pick<Card, "x" | "y" | "w">): string | undefined {
  if (!finite(c.x) || !finite(c.y)) return "x and y must be finite numbers"
  if (!finite(c.w) || c.w <= 0) return "w must be a finite number above 0"
  return undefined
}

function checkCard(v: unknown): Card {
  const c = v as Card
  if (!c || typeof c !== "object" || typeof c.id !== "string" || typeof c.kind !== "string") throw new Error("not a card (needs id, kind, x, y, w)")
  const bad = cardGeometryProblem(c)
  if (bad) throw new Error(`not a card: ${bad}`)
  return c
}

function checkMark(v: unknown): Mark {
  const m = v as Mark
  if (!m || typeof m !== "object" || typeof m.id !== "string" || typeof m.shape !== "string" || !Array.isArray(m.path)) {
    throw new Error("not a mark (needs id, shape, path)")
  }
  if (!m.path.every(finite)) throw new Error("not a mark: path must hold finite numbers")
  if (!Array.isArray(m.anchors)) m.anchors = []
  if (!Array.isArray(m.thread)) m.thread = []
  return m
}

function checkEdge(v: unknown): Edge {
  const e = v as Edge
  if (!e || typeof e !== "object" || typeof e.id !== "string" || typeof e.from !== "string" || typeof e.to !== "string") {
    throw new Error("not an edge (needs id, from, to)")
  }
  return e
}

async function readEntities<T>(dir: string, check: (v: unknown) => T, onError?: (file: string, err: unknown) => void): Promise<T[]> {
  const out: T[] = []
  for (const name of await jsonFiles(dir)) {
    const file = path.join(dir, name)
    try {
      out.push(check(JSON.parse(await readFile(file, "utf8"))))
    } catch (err) {
      // A file deleted between readdir and read is not an error.
      if ((err as NodeJS.ErrnoException).code === "ENOENT") continue
      onError?.(file, err)
    }
  }
  return out
}

/** Read one card file, or undefined when it does not exist. Throws when it does not parse. */
export async function loadCard(workspaceRoot: string, board: string, cardId: string): Promise<Card | undefined> {
  try {
    return checkCard(JSON.parse(await readFile(cardFile(workspaceRoot, board, cardId), "utf8")))
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined
    throw err
  }
}

/** Read one mark file, or undefined when it does not exist. Throws when it does not parse. */
export async function loadMark(workspaceRoot: string, board: string, markId: string): Promise<Mark | undefined> {
  try {
    return checkMark(JSON.parse(await readFile(markFile(workspaceRoot, board, markId), "utf8")))
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined
    throw err
  }
}

/** Read a whole board. A missing board is empty. Skips (and reports via onError) files that fail to parse. */
export async function loadBoard(workspaceRoot: string, name: string, onError?: (file: string, err: unknown) => void): Promise<Board> {
  const dir = boardDir(workspaceRoot, name)
  const [cards, marks, edges] = await Promise.all([
    readEntities(path.join(dir, "cards"), checkCard, onError),
    readEntities(path.join(dir, "marks"), checkMark, onError),
    readEntities(path.join(dir, "edges"), checkEdge, onError),
  ])
  return { name, cards: cards.sort(byCreated), marks: marks.sort(byCreated), edges: edges.sort(byCreated) }
}

/** Create the board folder and board.json if missing. Returns the board folder. */
export async function ensureBoard(workspaceRoot: string, name: string): Promise<string> {
  const dir = boardDir(workspaceRoot, name)
  await mkdir(path.join(dir, "cards"), { recursive: true })
  await mkdir(path.join(dir, "marks"), { recursive: true })
  await mkdir(path.join(dir, "edges"), { recursive: true })
  const meta = path.join(dir, "board.json")
  try {
    await writeFile(meta, boardJsonText({ name, createdAt: new Date().toISOString() }), { encoding: "utf8", flag: "wx" })
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err
  }
  return dir
}

export async function listBoards(workspaceRoot: string): Promise<string[]> {
  try {
    const entries = await readdir(path.join(workspaceRoot, ".river", "boards"), { withFileTypes: true })
    return entries.filter((e) => e.isDirectory() && SAFE_BOARD.test(e.name)).map((e) => e.name).sort()
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return []
    throw err
  }
}

/** Write one card (atomic). New cards get an id ("c_" + 8 base36) and createdAt. */
export async function saveCard(workspaceRoot: string, board: string, card: Omit<Card, "id" | "createdAt"> & Partial<Pick<Card, "id" | "createdAt">>): Promise<Card> {
  if (card.kind === "ref" && !card.source?.licence?.trim()) {
    throw new Error("river: a reference image card needs a licence (source.licence)")
  }
  const bad = cardGeometryProblem(card)
  if (bad) throw new Error(`river: cannot save card: ${bad}`)
  const full: Card = { ...card, id: card.id ?? newBoardId("c_"), createdAt: card.createdAt ?? new Date().toISOString() }
  await writeAtomic(cardFile(workspaceRoot, board, full.id), boardJsonText(full))
  return full
}

export async function deleteCard(workspaceRoot: string, board: string, cardId: string): Promise<void> {
  await removeFile(cardFile(workspaceRoot, board, cardId))
}

/** Write one mark (atomic). New marks get an id ("m_" + 8 base36), createdAt and status "open". */
export async function saveMark(workspaceRoot: string, board: string, mark: Omit<Mark, "id" | "createdAt" | "status"> & Partial<Pick<Mark, "id" | "createdAt" | "status">>): Promise<Mark> {
  if (!Array.isArray(mark.path) || !mark.path.every(finite)) throw new Error("river: cannot save mark: path must hold finite numbers")
  const full: Mark = {
    ...mark,
    id: mark.id ?? newBoardId("m_"),
    createdAt: mark.createdAt ?? new Date().toISOString(),
    status: mark.status ?? "open",
  }
  await writeAtomic(markFile(workspaceRoot, board, full.id), boardJsonText(full))
  return full
}

export async function deleteMark(workspaceRoot: string, board: string, markId: string): Promise<void> {
  await removeFile(markFile(workspaceRoot, board, markId))
}

/** Write one edge (atomic). New edges get an id ("e_" + 8 base36) and createdAt. */
export async function saveEdge(workspaceRoot: string, board: string, edge: Omit<Edge, "id" | "createdAt"> & Partial<Pick<Edge, "id" | "createdAt">>): Promise<Edge> {
  const full: Edge = { ...edge, id: edge.id ?? newBoardId("e_"), createdAt: edge.createdAt ?? new Date().toISOString() }
  await writeAtomic(edgeFile(workspaceRoot, board, full.id), boardJsonText(full))
  return full
}

export async function deleteEdge(workspaceRoot: string, board: string, edgeId: string): Promise<void> {
  await removeFile(edgeFile(workspaceRoot, board, edgeId))
}

async function needMark(workspaceRoot: string, board: string, markId: string): Promise<Mark> {
  const mark = await loadMark(workspaceRoot, board, markId)
  if (!mark) throw new Error(`river: no mark ${markId} on board ${board}`)
  return mark
}

/**
 * Run `fn` holding the mark's lock. Every read-modify-write of a mark goes through here, in every process,
 * so a reply, a claim and a job's status change never overwrite each other. Not reentrant.
 */
export function withMarkLock<T>(workspaceRoot: string, board: string, markId: string, fn: () => Promise<T>): Promise<T> {
  markFile(workspaceRoot, board, markId) // validates the names before they become a path
  return withLock(markLockFile(workspaceRoot, board, markId), `mark ${markId}`, fn)
}

/** Read the mark, change it with `fn` and write it back, under the mark's lock. `fn` may throw to refuse. */
export function updateMark(workspaceRoot: string, board: string, markId: string, fn: (mark: Mark) => Mark | Promise<Mark>): Promise<Mark> {
  return withMarkLock(workspaceRoot, board, markId, async () => saveMark(workspaceRoot, board, await fn(await needMark(workspaceRoot, board, markId))))
}

/** A claim that its agent still holds: the mark is "working" for it and the claim is not older than CLAIM_STALE_MS. */
export function liveClaim(mark: Mark, now = Date.now()): string | undefined {
  if (mark.status !== "working" || !mark.claimedBy || mark.jobId) return undefined
  const at = mark.claimedAt ? Date.parse(mark.claimedAt) : NaN
  return now - at < CLAIM_STALE_MS ? mark.claimedBy : undefined
}

/** The River job a mark follows, unless it was dismissed: then the mark is the user's again. */
async function owningJob(workspaceRoot: string, mark: Mark): Promise<Job | undefined> {
  const job = mark.jobId ? await loadJob(workspaceRoot, mark.jobId).catch(() => undefined) : undefined
  return job && job.status !== "dismissed" ? job : undefined
}

const withoutClaim = (mark: Mark): Mark => {
  const { claimedBy: _by, claimedAt: _at, ...rest } = mark
  return rest
}

/**
 * Add a message to a mark's thread (an empty `text` adds none). `status` changes the mark: an agent answers
 * ("answered"), gives it back ("open", which drops the claim) or dismisses it ("dismissed", the text says why);
 * only the user ("you") accepts. A status is refused on a mark that follows a River job, and on a mark another
 * agent holds a live claim on. A user's reply on a mark an agent answered or dismissed opens it again, so that agent
 * finds it in marks_open.
 */
export async function replyToMark(workspaceRoot: string, board: string, markId: string, by: string, text: string, status?: MarkStatusChange): Promise<Mark> {
  return updateMark(workspaceRoot, board, markId, async (mark) => {
    const job = await owningJob(workspaceRoot, mark)
    if (status && job) throw new Error(`river: mark ${markId}'s status follows its River job ${job.id} (${job.status}); reply without a status`)
    if (status === "accepted" && by !== "you") throw new Error(`river: only the user accepts an answer; reply with status "answered"`)
    const holder = liveClaim(mark)
    if (status && by !== "you" && holder && holder !== by) {
      throw new Error(`river: mark ${markId} is claimed by ${holder} (since ${mark.claimedAt}); only ${holder} changes its status. Reply without a status, or claim it after the claim goes stale.`)
    }
    const reopens = by === "you" && !job && (mark.status === "answered" || mark.status === "dismissed")
    const next = status ?? (reopens ? "open" : mark.status)
    const at = new Date().toISOString()
    const thread = text.trim() ? [...mark.thread, { by, at, text }] : mark.thread
    // Giving a mark back releases the claim; any other reply keeps it, so the agent that answered sees it is theirs.
    const claim = status === "open" ? withoutClaim(mark) : mark.claimedBy === by && next === "working" ? { ...mark, claimedAt: at } : mark
    return { ...claim, status: next, thread }
  })
}

/**
 * An agent takes an open mark: status "working", claimedBy `by`. Claiming again refreshes the claim. A claim
 * nobody refreshed for CLAIM_STALE_MS can be taken over. A mark that follows a River job is never claimed,
 * a failed one included: the user retries or dismisses it in River.
 */
export async function claimMark(workspaceRoot: string, board: string, markId: string, by: string): Promise<Mark> {
  return updateMark(workspaceRoot, board, markId, async (mark) => {
    const job = await owningJob(workspaceRoot, mark)
    if (job) {
      const how = job.status === "failed" ? "; the user can retry it (river job revise) or dismiss it in River" : ""
      throw new Error(`river: mark ${markId} is ${mark.status} (River job ${job.id}, ${job.status}${how}); only an open mark can be claimed`)
    }
    const at = new Date().toISOString()
    if (mark.status === "working" && mark.claimedBy === by) return { ...mark, claimedAt: at }
    const holder = liveClaim(mark)
    if (mark.status === "working" && mark.claimedBy && !holder) return { ...mark, claimedBy: by, claimedAt: at }
    if (mark.status !== "open") {
      const who = mark.claimedBy ? ` by ${mark.claimedBy}` : ""
      throw new Error(`river: mark ${markId} is ${mark.status}${who}; only an open mark can be claimed`)
    }
    return { ...mark, status: "working", claimedBy: by, claimedAt: at }
  })
}

/** Marks with status "open", oldest first. */
export function openMarks(board: Board): Mark[] {
  return board.marks.filter((m) => m.status === "open").sort(byCreated)
}

const clipText = (text: string, max: number) => {
  const flat = text.replace(/\s*\n\s*/g, " / ").trim()
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat
}

/**
 * The image file an image card shows, relative to the workspace root: a pending concept's render in
 * .river/jobs/<job>/, an accepted concept's render beside its script, a reference image's path. Frames
 * resolve through their shot's captures, so they have none here.
 */
export function cardImageFile(card: Card): string | undefined {
  if (card.kind === "concept") {
    return card.pending ? `.river/jobs/${card.pending.jobId}/${jobRenderName(card.variant)}` : `concepts/${card.ref}/${conceptRenderName(card.variant)}`
  }
  return card.kind === "ref" ? card.ref : undefined
}

/** What a card shows, in a few words. `frameFile` is the PNG a frame card shows, when the caller looked it up. */
function cardWhat(card: Card, noteMax = 400, frameFile?: string): string {
  switch (card.kind) {
    case "note":
      return JSON.stringify(clipText(card.text ?? "", noteMax))
    case "concept":
      return `concepts/${card.ref}/${card.variant ? ` option ${card.variant}` : ""}  file: ${cardImageFile(card)}`
    case "frame":
      return `shot ${card.ref}${card.rev ? ` rev ${card.rev}` : ""} frame ${(card.frame ?? 0) + 1}${frameFile ? `  file: ${frameFile}` : ""}`
    case "ref":
      return `file: ${card.ref}${card.source ? ` (${[card.source.title, card.source.licence].filter(Boolean).join(", ")})` : ""}`
    case "passage":
      return card.ref
  }
}

const round = (n: number) => Math.round(n)

/** One mark's header and thread, as formatBoard and marks_open print it. With the board, anchors say what they are. */
export function formatMark(mark: Mark, indent = "", board?: Board, threadMax = 600): string[] {
  const anchor = (id: string) => {
    const card = board?.cards.find((c) => c.id === id)
    return card ? `${id} (${card.kind} ${card.kind === "note" ? cardWhat(card, 60) : (cardWhat(card).split("  ")[0] ?? "")})` : id
  }
  const on = mark.anchors.length > 0 ? ` on ${mark.anchors.map(anchor).join(", ")}` : ""
  const job = mark.jobId ? ` job ${mark.jobId}` : ""
  const claimed = mark.claimedBy ? ` claimed by ${mark.claimedBy}` : ""
  const r = markRect(mark)
  return [
    `${indent}${mark.id}  ${mark.shape} ${mark.status}${job}${claimed}  box ${round(r.x)},${round(r.y)} ${round(r.w)}x${round(r.h)}${on}`,
    ...mark.thread.map((m) => `${indent}  ${m.by}: ${clipText(m.text, threadMax)}`),
  ]
}

/** One card as formatBoard prints it. */
export function formatCard(c: Card, noteMax = 400, frameFile?: string): string {
  const label = c.label ? ` [${c.label}]` : ""
  const caption = c.caption ? ` "${clipText(c.caption, 200)}"` : ""
  const pending = c.pending ? ` (pending, job ${c.pending.jobId})` : ""
  return `${c.id}  ${c.kind} at ${round(c.x)},${round(c.y)} w${round(c.w)} h${round(cardHeight(c))}${label}${caption}  ${cardWhat(c, noteMax, frameFile)}${pending}  by ${c.madeBy}`
}

/**
 * A board as compact text for agents and `river board show`: one line per card, a few per mark, one per edge.
 * `frameFiles` (frameCardFiles) adds the PNG each frame card shows.
 */
export function formatBoard(board: Board, frameFiles: Record<string, string> = {}): string {
  const lines = [`board ${board.name}: ${board.cards.length} cards, ${board.marks.length} marks, ${board.edges.length} edges`]
  if (board.cards.length > 0) lines.push("cards:")
  for (const c of board.cards) lines.push(`  ${formatCard(c, 400, frameFiles[c.id])}`)
  if (board.marks.length > 0) lines.push("marks:")
  for (const m of board.marks) lines.push(...formatMark(m, "  ", board))
  if (board.edges.length > 0) lines.push("edges:")
  for (const e of board.edges) lines.push(`  ${e.id}  ${e.from} -> ${e.to}${e.label ? ` "${clipText(e.label, 80)}"` : ""}  by ${e.madeBy}`)
  return lines.join("\n")
}

/** Jobs: .river/jobs/<id>.json in the workspace. A job without an id gets one ("j_" + 8 base36). */
export async function saveJob(workspaceRoot: string, job: Job): Promise<Job> {
  const full: Job = { ...job, id: job.id || newBoardId("j_") }
  await writeAtomic(jobFile(workspaceRoot, full.id), boardJsonText(full))
  return full
}

export async function loadJob(workspaceRoot: string, jobId: string): Promise<Job> {
  let text: string
  try {
    text = await readFile(jobFile(workspaceRoot, jobId), "utf8")
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") throw new Error(`river: no job ${JSON.stringify(jobId)}`)
    throw err
  }
  return JSON.parse(text) as Job
}

/** All jobs, oldest first. Files that fail to parse are skipped (and reported via onError). */
export async function listJobs(workspaceRoot: string, onError?: (file: string, err: unknown) => void): Promise<Job[]> {
  const jobs = await readEntities(
    jobsDir(workspaceRoot),
    (v) => {
      const j = v as Job
      if (!j || typeof j !== "object" || typeof j.id !== "string") throw new Error("not a job (needs id)")
      return j
    },
    onError,
  )
  return jobs.sort(byCreated)
}
