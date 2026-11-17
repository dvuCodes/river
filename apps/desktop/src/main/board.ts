import { createHash, randomUUID } from "node:crypto"
import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises"
import { basename, extname, join, relative, resolve, sep } from "node:path"
import { type BrowserWindow, dialog, shell } from "electron"
import {
  type Card,
  type Edge,
  type Job,
  type Mark,
  type Project,
  type Story,
  IMAGE_CARD_W,
  boardDir,
  boardJsonText,
  cardFile,
  cardHeight,
  deleteCard,
  deleteEdge,
  deleteMark,
  edgeFile,
  ensureBoard,
  listBoards,
  listCaptures,
  listJobs,
  loadBoard,
  loadCard,
  loadJob,
  loadMark,
  loadStory,
  markFile,
  newBoardId,
  occupiedRects,
  openMarks,
  placeRow,
  replyToMark,
  saveCard,
  saveEdge,
  saveJob,
  saveMark,
} from "@river/core"
import type { BoardCard, BoardDTO, CardDTO, CardView, ConceptJob, FrameStrip, ImageSize, NewCard, NewEdge, NewMark, StagedImage } from "../shared/api"
import { loadAgent } from "./agent"
import { imageSize } from "./imageSize"
import { getLastBoard, setLastBoard } from "./settings"
import { noteOwnWrite } from "./watch"

const ME = "you"
const IMAGE_EXT = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".avif", ".bmp"])

export function riverFileUrl(p: Project, abs: string): string {
  return "river-file://project/" + relative(p.root, abs).split(sep).map(encodeURIComponent).join("/")
}

export type BoardEntity = { kind: "card"; value: BoardCard } | { kind: "mark"; value: Mark } | { kind: "edge"; value: Edge }
const boardWritten = new Set<(written: BoardEntity) => void>()
/** Call `cb` after River writes a card, mark or edge (smoke mode waits on it). Returns an unsubscribe function. */
export function onBoardWritten(cb: (written: BoardEntity) => void): () => void {
  boardWritten.add(cb)
  return () => boardWritten.delete(cb)
}

/** An image's river-file:// URL, versioned by its mtime so a new render replaces the cached one, and its size. Empty while it does not exist. */
async function imageAt(p: Project, abs: string): Promise<{ url?: string; size?: ImageSize }> {
  try {
    const mtime = Math.round((await stat(abs)).mtimeMs)
    const size = await imageSize(abs)
    return { url: `${riverFileUrl(p, abs)}?v=${mtime}`, ...(size ? { size } : {}) }
  } catch {
    return {}
  }
}

/** Card files are written by agents too, and the variant becomes part of a file name. */
const VARIANT = /^[a-e]$/

/**
 * Whether the answer can be revised: it is the mark's latest job, and the job failed or the user replied on the
 * mark since it answered (the same rule reviseJob applies).
 */
export async function jobRevisable(root: string, job: Job): Promise<boolean> {
  if (!["answered", "accepted", "failed"].includes(job.status)) return false
  const mark = await loadMark(root, job.board, job.markId).catch(() => undefined)
  if (mark?.jobId !== job.id) return false
  if (job.status === "failed") return true
  const jobs = (await loadAgent()).jobs
  return jobs ? jobs.repliesAfter(mark, job).length > 0 : false
}

async function jobView(p: Project, jobId: string): Promise<{ job: ConceptJob } | { missing: string }> {
  try {
    const job = await loadJob(p.root, jobId)
    const { id, status, summary, error, scripts } = job
    return { job: { id, status, summary, error, scripts, revisable: await jobRevisable(p.root, job) } }
  } catch (e) {
    return { missing: e instanceof Error ? e.message : String(e) }
  }
}

/**
 * After keeping some of a job's options, the kept cards close up into one row where the options started. Written
 * with core's saveCard, not as River's own write, so the watcher reports the move to the canvas.
 */
export async function closeRowGap(root: string, board: string, options: readonly Card[]): Promise<void> {
  const now = await loadBoard(root, board)
  const kept = options.map((o) => now.cards.find((c) => c.id === o.id)).filter((c): c is Card => c !== undefined).sort((a, b) => a.x - b.x)
  if (kept.length === 0) return
  const start = { x: Math.min(...options.map((c) => c.x)), y: Math.min(...options.map((c) => c.y)) }
  const spots = placeRow(start, kept.map((c) => ({ w: c.w, h: cardHeight(c) })), occupiedRects(now, new Set(kept.map((c) => c.id))))
  for (const [i, c] of kept.entries()) {
    const at = spots[i]!
    if (at.x !== c.x || at.y !== c.y) await saveCard(root, board, { ...c, x: at.x, y: at.y })
  }
}

/** A concept card: the job's render while pending, the applied concepts/<id>/concept[_<variant>].png once accepted. */
async function conceptView(p: Project, card: Card): Promise<CardView> {
  if (card.variant !== undefined && !VARIANT.test(card.variant)) {
    return { kind: "concept", id: card.ref, missing: `Unknown variant ${JSON.stringify(card.variant)} (a to e).` }
  }
  const suffix = card.variant ? `_${card.variant}` : ""
  if (!card.pending) return { kind: "concept", id: card.ref, ...(await imageAt(p, join(p.root, "concepts", card.ref, `concept${suffix}.png`))) }
  const { jobId } = card.pending
  const image = await imageAt(p, join(p.root, ".river", "jobs", jobId, `render${suffix}.png`))
  return { kind: "concept", id: card.ref, ...image, ...(await jobView(p, jobId)) }
}

/** First prose lines of a passage: no rule lines, no choice lines, links reduced to their labels. */
function proseLines(text: string, max: number): string[] {
  return text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !/^\[\[/.test(l) && !l.startsWith("@"))
    .map((l) => l.replace(/\[\[(.+?)\]\]/g, (_m, inner: string) => inner.split(/->|\|/)[0] ?? inner))
    .slice(0, max)
}

/** Resolves what cards show. Stories are read once per resolver. */
export function cardResolver(p: Project) {
  const stories = new Map<string, Promise<Story | Error>>()
  const story = (rel: string) => {
    let s = stories.get(rel)
    if (!s) {
      s = loadStory(p, rel).then(
        (r) => r.story,
        (e: unknown) => (e instanceof Error ? e : new Error(String(e))),
      )
      stories.set(rel, s)
    }
    return s
  }
  return async (card: BoardCard): Promise<CardDTO> => {
    let view: CardView
    switch (card.kind) {
      case "passage": {
        const hash = card.ref.lastIndexOf("#")
        const rel = hash >= 0 ? card.ref.slice(0, hash) : card.ref
        const passageId = hash >= 0 ? card.ref.slice(hash + 1) : ""
        const s = await story(rel)
        const passage = s instanceof Error ? undefined : s.passages.find((x) => x.id === passageId)
        view = passage
          ? { kind: "passage", story: rel, passageId, title: passage.name, tags: passage.tags, lines: proseLines(passage.text, 4) }
          : { kind: "passage", story: rel, passageId, title: passageId || card.ref, tags: [], lines: [], missing: s instanceof Error ? s.message : `No passage ${passageId} in ${rel}` }
        break
      }
      case "frame": {
        let caps: Awaited<ReturnType<typeof listCaptures>> = []
        let err: string | undefined
        try {
          caps = await listCaptures(p, card.ref)
        } catch (e) {
          err = e instanceof Error ? e.message : String(e)
        }
        const cap = card.capture ? caps.find((c) => c.at === card.capture) : card.rev ? caps.find((c) => c.rev === card.rev) : caps[0]
        const frame = card.frame ?? 0
        const file = cap?.files[frame]
        const size = file ? await imageSize(file) : undefined
        const at = card.frame !== undefined ? { frame: card.frame } : {}
        const missing = err ?? (cap ? `No frame ${frame + 1} in this capture` : card.capture || card.rev ? "That capture is gone" : "No capture yet")
        view = file
          ? { kind: "frame", shotId: card.ref, rev: cap.rev, ...at, url: riverFileUrl(p, file), ...(size ? { size } : {}) }
          : { kind: "frame", shotId: card.ref, ...(card.rev ? { rev: card.rev } : {}), ...at, missing }
        break
      }
      case "ref": {
        const size = await imageSize(join(p.root, card.ref))
        view = { kind: "ref", url: "river-file://project/" + card.ref.split(/[\\/]/).map(encodeURIComponent).join("/"), ...(size ? { size } : {}) }
        break
      }
      case "concept":
        view = await conceptView(p, card)
        break
      default: {
        const job = card.pending ? await jobView(p, card.pending.jobId) : undefined
        view = job && "job" in job ? { kind: "note", job: job.job } : { kind: "note" }
      }
    }
    return { card, view }
  }
}

async function writeCard(p: Project, board: string, card: NewCard): Promise<BoardCard> {
  const full: BoardCard = { ...card, id: card.id ?? newBoardId("c_"), createdAt: card.createdAt ?? new Date().toISOString() }
  // Tell the watcher first: the content is known before the write, so the echo is dropped.
  noteOwnWrite(cardFile(p.root, board, full.id), boardJsonText(full))
  const saved = await saveCard(p.root, board, full)
  for (const cb of boardWritten) cb({ kind: "card", value: saved })
  return saved
}

async function writeEdge(p: Project, board: string, edge: NewEdge): Promise<Edge> {
  const full: Edge = { ...edge, id: edge.id ?? newBoardId("e_"), createdAt: edge.createdAt ?? new Date().toISOString() }
  noteOwnWrite(edgeFile(p.root, board, full.id), boardJsonText(full))
  const saved = await saveEdge(p.root, board, full)
  for (const cb of boardWritten) cb({ kind: "edge", value: saved })
  return saved
}

/** Jobs still doing something on a board; renaming or deleting it under them would lose their answer. */
const LIVE_JOB = new Set<Job["status"]>(["queued", "running", "approval", "rendering"])
async function refuseLiveJobs(root: string, board: string, verb: string): Promise<Job[]> {
  const jobs = (await listJobs(root)).filter((j) => j.board === board)
  if (jobs.some((j) => LIVE_JOB.has(j.status))) throw new Error(`An answer on ${board} is still being made. ${verb} the board once it is done.`)
  return jobs
}

/** Windows can hold a folder for a moment after its watcher lets go, or while an indexer reads it. */
async function renameDir(from: string, to: string): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await rename(from, to)
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code
      if (attempt >= 20 || (code !== "EPERM" && code !== "EBUSY" && code !== "EACCES")) throw err
      await new Promise((r) => setTimeout(r, 50 + attempt * 25))
    }
  }
}

/** Card height for a frame of this size at width `w`: the image at its own aspect, plus a two-line caption. */
const frameCardHeight = (w: number, size: ImageSize | undefined) => Math.round(size ? (w * size.h) / size.w : (w * 9) / 16) + 40

async function loadEdge(p: Project, board: string, id: string): Promise<Edge | null> {
  try {
    return JSON.parse(await readFile(edgeFile(p.root, board, id), "utf8")) as Edge
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null
    throw err
  }
}

async function countOpen(p: Project, board: string): Promise<number> {
  return openMarks(await loadBoard(p.root, board)).length
}

/** Free spot for a pinned card: below everything, left-aligned, in a 4-wide grid of 320 x 300 slots. */
async function nextSpot(p: Project, board: string): Promise<{ x: number; y: number }> {
  const { cards } = await loadBoard(p.root, board)
  const taken = new Set(cards.map((c) => `${Math.round(c.x / 320)},${Math.round(c.y / 300)}`))
  for (let i = 0; ; i++) {
    const col = i % 4
    const row = Math.floor(i / 4)
    if (!taken.has(`${col},${row}`)) return { x: col * 320, y: row * 300 }
  }
}

const IMAGE_BYTES_MAX = 64 * 1024 * 1024
/** Images waiting for their licence form: a picked file's path, or the bytes of a pasted or dropped image. */
const staged = new Map<string, { file: string } | { bytes: Buffer; fileName: string }>()

function stage(image: { file: string } | { bytes: Buffer; fileName: string }): StagedImage {
  const token = randomUUID()
  staged.set(token, image)
  return { token, fileName: "file" in image ? basename(image.file) : image.fileName }
}

export function boardHandlers(need: () => Project, watch: { add(dir: string): void; remove(dir: string): Promise<void> | undefined }, getWindow: () => BrowserWindow | null) {
  const resolveAll = async (cards: Card[]) => {
    const resolve = cardResolver(need())
    return Promise.all(cards.map(resolve))
  }
  return {
    "board:list": () => listBoards(need().root),
    "board:open": async (name: string): Promise<BoardDTO> => {
      const p = need()
      const dir = await ensureBoard(p.root, name)
      watch.add(dir)
      setLastBoard(p.root, name)
      const errors: string[] = []
      const board = await loadBoard(p.root, name, (file, err) => errors.push(`${relative(p.root, file).split(sep).join("/")}: ${err instanceof Error ? err.message : String(err)}`))
      return { name, cards: await resolveAll(board.cards), marks: board.marks, edges: board.edges, openMarks: openMarks(board).length, errors }
    },
    "board:card": async (name: string, id: string): Promise<CardDTO | null> => {
      const card = await loadCard(need().root, name, id)
      return card ? cardResolver(need())(card) : null
    },
    "board:mark": async (name: string, id: string): Promise<Mark | null> => (await loadMark(need().root, name, id)) ?? null,
    "board:edge": (name: string, id: string) => loadEdge(need(), name, id),
    "board:saveEdge": (name: string, edge: NewEdge): Promise<Edge> => writeEdge(need(), name, edge),
    "board:deleteEdge": (name: string, id: string) => deleteEdge(need().root, name, id),
    "board:saveCard": async (name: string, card: NewCard): Promise<CardDTO> => cardResolver(need())(await writeCard(need(), name, card)),
    "board:deleteCard": (name: string, id: string) => deleteCard(need().root, name, id),
    "board:saveMark": async (name: string, mark: NewMark): Promise<{ mark: Mark; openMarks: number }> => {
      const p = need()
      const full: Mark = { ...mark, id: mark.id ?? newBoardId("m_"), createdAt: mark.createdAt ?? new Date().toISOString(), status: mark.status ?? "open" }
      noteOwnWrite(markFile(p.root, name, full.id), boardJsonText(full))
      const saved = await saveMark(p.root, name, full)
      for (const cb of boardWritten) cb({ kind: "mark", value: saved })
      return { mark: saved, openMarks: await countOpen(p, name) }
    },
    "board:deleteMark": async (name: string, id: string): Promise<number> => {
      await deleteMark(need().root, name, id)
      return countOpen(need(), name)
    },
    "board:reply": async (name: string, markId: string, text: string): Promise<{ mark: Mark; openMarks: number }> => {
      const p = need()
      if (typeof text !== "string" || !text.trim()) throw new Error("Write a reply first.")
      const mark = await replyToMark(p.root, name, markId, ME, text.trim())
      for (const cb of boardWritten) cb({ kind: "mark", value: mark })
      return { mark, openMarks: await countOpen(p, name) }
    },
    "board:openCount": (name: string) => countOpen(need(), name),
    "board:rename": async (from: string, to: string): Promise<void> => {
      const p = need()
      const src = boardDir(p.root, from)
      const dst = boardDir(p.root, to)
      if (from === to) return
      const boards = await listBoards(p.root)
      if (!boards.includes(from)) throw new Error(`There is no board ${from}.`)
      if (boards.includes(to)) throw new Error(`There is already a board called ${to}.`)
      const jobs = await refuseLiveJobs(p.root, from, "Rename")
      await watch.remove(src)
      await renameDir(src, dst)
      const meta = join(dst, "board.json")
      const old = JSON.parse(await readFile(meta, "utf8").catch(() => "{}")) as { createdAt?: string }
      await writeFile(meta, boardJsonText({ name: to, createdAt: old.createdAt ?? new Date().toISOString() }), "utf8")
      for (const job of jobs) await saveJob(p.root, { ...job, board: to })
      if (getLastBoard(p.root) === from) setLastBoard(p.root, to)
    },
    "board:delete": async (name: string): Promise<string[]> => {
      const p = need()
      const dir = boardDir(p.root, name)
      const boards = await listBoards(p.root)
      if (!boards.includes(name)) throw new Error(`There is no board ${name}.`)
      if (boards.length === 1) throw new Error("This is the only board. Make another before you delete this one.")
      await refuseLiveJobs(p.root, name, "Delete")
      await watch.remove(dir)
      await shell.trashItem(resolve(dir))
      return listBoards(p.root)
    },
    "board:addFrames": async (name: string, strip: FrameStrip): Promise<CardDTO[]> => {
      const p = need()
      const cap = (await listCaptures(p, strip.shotId)).find((c) => c.at === strip.capture)
      if (!cap) throw new Error(`That capture of ${strip.shotId} is gone. Capture it again.`)
      const frames = strip.frames
      if (!Array.isArray(frames) || frames.length === 0) throw new Error("Pick at least one frame.")
      if (frames.some((f) => !Number.isInteger(f) || f < 0 || f >= cap.files.length) || new Set(frames).size !== frames.length) {
        throw new Error(`Frames must be different numbers from 1 to ${cap.files.length}.`)
      }
      await ensureBoard(p.root, name)
      const occupied = occupiedRects(await loadBoard(p.root, name))
      const w = IMAGE_CARD_W
      const sizes = await Promise.all(frames.map(async (f) => ({ w, h: frameCardHeight(w, await imageSize(cap.files[f]!)) })))
      const start = occupied.length ? { x: Math.min(...occupied.map((r) => r.x)), y: Math.min(...occupied.map((r) => r.y)) } : { x: 0, y: 0 }
      const spots = placeRow(start, sizes, occupied)
      const cards: BoardCard[] = []
      for (const [i, f] of frames.entries()) {
        const at = spots[i]!
        cards.push(
          await writeCard(p, name, { kind: "frame", ref: strip.shotId, rev: cap.rev, capture: cap.at, frame: f, caption: `${strip.shotId} · frame ${f + 1}`, x: at.x, y: at.y, w, madeBy: ME }),
        )
      }
      for (let i = 1; i < cards.length; i++) await writeEdge(p, name, { from: cards[i - 1]!.id, to: cards[i]!.id, madeBy: ME })
      return Promise.all(cards.map(cardResolver(p)))
    },
    "board:pin": async (name: string, pin: { kind: "passage" | "frame"; ref: string; rev?: string }): Promise<CardDTO> => {
      const p = need()
      if (pin.kind !== "passage" && pin.kind !== "frame") throw new Error(`Cannot pin a ${String(pin.kind)} card.`)
      await ensureBoard(p.root, name)
      const at = await nextSpot(p, name)
      const card = await writeCard(p, name, { kind: pin.kind, ref: pin.ref, ...(pin.rev ? { rev: pin.rev } : {}), ...at, w: 260, madeBy: "you" })
      return cardResolver(p)(card)
    },
    "board:pickImage": async (): Promise<StagedImage | null> => {
      const win = getWindow()
      const opts = {
        title: "Add a reference image",
        properties: ["openFile" as const],
        filters: [{ name: "Images", extensions: [...IMAGE_EXT].map((e) => e.slice(1)) }],
      }
      const res = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts)
      const file = res.filePaths[0]
      if (res.canceled || !file) return null
      return stage({ file })
    },
    "board:stageImage": (bytes: Uint8Array, fileName: string): StagedImage => {
      if (!(bytes instanceof Uint8Array) || bytes.length === 0) throw new Error("The image is empty.")
      if (bytes.length > IMAGE_BYTES_MAX) throw new Error("The image is larger than 64 MB.")
      if (!IMAGE_EXT.has(extname(String(fileName)).toLowerCase())) throw new Error(`Not an image file: ${String(fileName)}`)
      return stage({ bytes: Buffer.from(bytes), fileName: basename(String(fileName)) })
    },
    "board:addRef": async (name: string, token: string, source: { title?: string; url?: string; licence: string }, at: { x: number; y: number }): Promise<CardDTO> => {
      const p = need()
      const image = staged.get(token)
      if (!image) throw new Error("Add the image again.")
      if (!source?.licence?.trim()) throw new Error("A reference image needs a licence.")
      const fileName = "file" in image ? image.file : image.fileName
      const ext = extname(fileName).toLowerCase()
      if (!IMAGE_EXT.has(ext)) throw new Error(`Not an image file: ${basename(fileName)}`)
      const bytes = "file" in image ? await readFile(image.file) : image.bytes
      const hash = createHash("sha256").update(bytes).digest("hex").slice(0, 16)
      const refs = join(p.root, ".river", "refs")
      await mkdir(refs, { recursive: true })
      await writeFile(join(refs, `${hash}${ext}`), bytes)
      staged.delete(token)
      const src = {
        licence: source.licence.trim(),
        ...(source.title?.trim() ? { title: source.title.trim() } : {}),
        ...(source.url?.trim() ? { url: source.url.trim() } : {}),
      }
      const card = await writeCard(p, name, { kind: "ref", ref: `.river/refs/${hash}${ext}`, source: src, x: Math.round(at.x), y: Math.round(at.y), w: 240, madeBy: "you" })
      return cardResolver(p)(card)
    },
  }
}
