import { mkdir, readdir, readFile, rename, rm, unlink, writeFile } from "node:fs/promises"
import { randomBytes } from "node:crypto"
import path from "node:path"
import { newId } from "../review/store"
import type { Board, Card, Edge, Job, Mark } from "./types"

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
async function writeAtomic(file: string, text: string): Promise<void> {
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

function checkCard(v: unknown): Card {
  const c = v as Card
  if (!c || typeof c !== "object" || typeof c.id !== "string" || typeof c.kind !== "string" || typeof c.x !== "number" || typeof c.y !== "number") {
    throw new Error("not a card (needs id, kind, x, y)")
  }
  return c
}

function checkMark(v: unknown): Mark {
  const m = v as Mark
  if (!m || typeof m !== "object" || typeof m.id !== "string" || typeof m.shape !== "string" || !Array.isArray(m.path)) {
    throw new Error("not a mark (needs id, shape, path)")
  }
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
  const full: Card = { ...card, id: card.id ?? newBoardId("c_"), createdAt: card.createdAt ?? new Date().toISOString() }
  await writeAtomic(cardFile(workspaceRoot, board, full.id), boardJsonText(full))
  return full
}

export async function deleteCard(workspaceRoot: string, board: string, cardId: string): Promise<void> {
  await removeFile(cardFile(workspaceRoot, board, cardId))
}

/** Write one mark (atomic). New marks get an id ("m_" + 8 base36), createdAt and status "open". */
export async function saveMark(workspaceRoot: string, board: string, mark: Omit<Mark, "id" | "createdAt" | "status"> & Partial<Pick<Mark, "id" | "createdAt" | "status">>): Promise<Mark> {
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
 * Add a message to a mark's thread. `status` ("answered" when an agent's reply answers the mark, "open" to
 * give it back) is refused on a mark a River job works on, whose status follows the job. A user's reply on
 * a mark an agent answered outside River's jobs opens it again, so that agent finds it in marks_open.
 */
export async function replyToMark(
  workspaceRoot: string,
  board: string,
  markId: string,
  by: string,
  text: string,
  status?: "answered" | "open",
): Promise<Mark> {
  const mark = await needMark(workspaceRoot, board, markId)
  const job = mark.jobId ? await loadJob(workspaceRoot, mark.jobId).catch(() => undefined) : undefined
  const jobOwns = job !== undefined && job.status !== "failed" && job.status !== "dismissed"
  if (status && jobOwns) throw new Error(`river: mark ${markId}'s status follows its River job ${job.id} (${job.status}); reply without a status`)
  const next = status ?? (by === "you" && !jobOwns && mark.status === "answered" ? "open" : mark.status)
  const { claimedBy, ...rest } = mark
  // Giving a mark back releases the claim; a user's reply keeps it, so the agent that answered sees it is theirs.
  const keepClaim = claimedBy && !(status === "open") ? { claimedBy } : {}
  return saveMark(workspaceRoot, board, { ...rest, ...keepClaim, status: next, thread: [...mark.thread, { by, at: new Date().toISOString(), text }] })
}

/** An agent takes an open mark: status "working", claimedBy `by`. Claiming a mark again by the same agent is a no-op. */
export async function claimMark(workspaceRoot: string, board: string, markId: string, by: string): Promise<Mark> {
  const mark = await needMark(workspaceRoot, board, markId)
  if (mark.status === "working" && mark.claimedBy === by && !mark.jobId) return mark
  if (mark.status !== "open") {
    const who = mark.claimedBy ? ` by ${mark.claimedBy}` : mark.jobId ? ` (River job ${mark.jobId})` : ""
    throw new Error(`river: mark ${markId} is ${mark.status}${who}; only an open mark can be claimed`)
  }
  return saveMark(workspaceRoot, board, { ...mark, status: "working", claimedBy: by })
}

/** Marks with status "open", oldest first. */
export function openMarks(board: Board): Mark[] {
  return board.marks.filter((m) => m.status === "open").sort(byCreated)
}

const clipText = (text: string, max: number) => {
  const flat = text.replace(/\s*\n\s*/g, " / ").trim()
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat
}

/** What a card shows, in a few words. */
function cardWhat(card: Card): string {
  switch (card.kind) {
    case "note":
      return JSON.stringify(clipText(card.text ?? "", 400))
    case "concept":
      return `concepts/${card.ref}/${card.variant ? ` option ${card.variant}` : ""}`
    case "frame":
      return `shot ${card.ref}${card.rev ? ` rev ${card.rev}` : ""}`
    case "ref":
      return `${card.ref}${card.source ? ` (${[card.source.title, card.source.licence].filter(Boolean).join(", ")})` : ""}`
    case "passage":
      return card.ref
  }
}

/** One mark's header and thread, as formatBoard and marks_open print it. */
export function formatMark(mark: Mark, indent = ""): string[] {
  const on = mark.anchors.length > 0 ? ` on ${mark.anchors.join(", ")}` : ""
  const job = mark.jobId ? ` job ${mark.jobId}` : ""
  const claimed = mark.claimedBy ? ` claimed by ${mark.claimedBy}` : ""
  return [
    `${indent}${mark.id}  ${mark.shape} ${mark.status}${job}${claimed}${on}`,
    ...mark.thread.map((m) => `${indent}  ${m.by}: ${clipText(m.text, 600)}`),
  ]
}

/** A board as compact text for agents and `river board show`: one line per card, a few per mark, one per edge. */
export function formatBoard(board: Board): string {
  const lines = [`board ${board.name}: ${board.cards.length} cards, ${board.marks.length} marks, ${board.edges.length} edges`]
  if (board.cards.length > 0) lines.push("cards:")
  for (const c of board.cards) {
    const label = c.label ? ` [${c.label}]` : ""
    const caption = c.caption ? ` "${clipText(c.caption, 200)}"` : ""
    const pending = c.pending ? ` (pending, job ${c.pending.jobId})` : ""
    lines.push(`  ${c.id}  ${c.kind} at ${Math.round(c.x)},${Math.round(c.y)} w${Math.round(c.w)}${label}${caption}  ${cardWhat(c)}${pending}  by ${c.madeBy}`)
  }
  if (board.marks.length > 0) lines.push("marks:")
  for (const m of board.marks) lines.push(...formatMark(m, "  "))
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
