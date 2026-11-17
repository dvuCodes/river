import { createHash, randomUUID } from "node:crypto"
import { mkdir, readFile, stat, writeFile } from "node:fs/promises"
import { basename, extname, join, relative, sep } from "node:path"
import { type BrowserWindow, dialog } from "electron"
import {
  type Card,
  type Edge,
  type Mark,
  type Project,
  type Story,
  boardJsonText,
  cardFile,
  deleteCard,
  deleteEdge,
  deleteMark,
  edgeFile,
  ensureBoard,
  listBoards,
  listCaptures,
  loadBoard,
  loadCard,
  loadJob,
  loadMark,
  loadStory,
  markFile,
  newBoardId,
  openMarks,
  saveCard,
  saveEdge,
  saveMark,
} from "@river/core"
import type { BoardDTO, CardDTO, CardView, ImageSize, NewCard, NewEdge, NewMark, StagedImage } from "../shared/api"
import { imageSize } from "./imageSize"
import { noteOwnWrite } from "./watch"

const IMAGE_EXT = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".avif", ".bmp"])

export function riverFileUrl(p: Project, abs: string): string {
  return "river-file://project/" + relative(p.root, abs).split(sep).map(encodeURIComponent).join("/")
}

export type BoardEntity = { kind: "card"; value: Card } | { kind: "mark"; value: Mark } | { kind: "edge"; value: Edge }
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

/** A concept card: the job's render while pending, the applied concepts/<id>/concept[_<variant>].png once accepted. */
async function conceptView(p: Project, card: Card): Promise<CardView> {
  if (card.variant !== undefined && !VARIANT.test(card.variant)) {
    return { kind: "concept", id: card.ref, missing: `Unknown variant ${JSON.stringify(card.variant)} (a to e).` }
  }
  const suffix = card.variant ? `_${card.variant}` : ""
  if (!card.pending) return { kind: "concept", id: card.ref, ...(await imageAt(p, join(p.root, "concepts", card.ref, `concept${suffix}.png`))) }
  const { jobId } = card.pending
  const image = await imageAt(p, join(p.root, ".river", "jobs", jobId, `render${suffix}.png`))
  try {
    const { id, status, summary, error } = await loadJob(p.root, jobId)
    return { kind: "concept", id: card.ref, ...image, job: { id, status, summary, error } }
  } catch (e) {
    return { kind: "concept", id: card.ref, ...image, missing: e instanceof Error ? e.message : String(e) }
  }
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
  return async (card: Card): Promise<CardDTO> => {
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
        const cap = card.rev ? caps.find((c) => c.rev === card.rev) : caps[0]
        const file = cap?.files[0]
        const size = file ? await imageSize(file) : undefined
        view = file
          ? { kind: "frame", shotId: card.ref, rev: cap.rev, url: riverFileUrl(p, file), ...(size ? { size } : {}) }
          : { kind: "frame", shotId: card.ref, ...(card.rev ? { rev: card.rev } : {}), missing: err ?? "No capture yet" }
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
      default:
        view = { kind: "note" }
    }
    return { card, view }
  }
}

async function writeCard(p: Project, board: string, card: NewCard): Promise<Card> {
  const full: Card = { ...card, id: card.id ?? newBoardId("c_"), createdAt: card.createdAt ?? new Date().toISOString() }
  // Tell the watcher first: the content is known before the write, so the echo is dropped.
  noteOwnWrite(cardFile(p.root, board, full.id), boardJsonText(full))
  const saved = await saveCard(p.root, board, full)
  for (const cb of boardWritten) cb({ kind: "card", value: saved })
  return saved
}

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

export function boardHandlers(need: () => Project, onOpen: (dir: string) => void, getWindow: () => BrowserWindow | null) {
  const resolveAll = async (cards: Card[]) => {
    const resolve = cardResolver(need())
    return Promise.all(cards.map(resolve))
  }
  return {
    "board:list": () => listBoards(need().root),
    "board:open": async (name: string): Promise<BoardDTO> => {
      const p = need()
      const dir = await ensureBoard(p.root, name)
      onOpen(dir)
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
    "board:saveEdge": async (name: string, edge: NewEdge): Promise<Edge> => {
      const p = need()
      const full: Edge = { ...edge, id: edge.id ?? newBoardId("e_"), createdAt: edge.createdAt ?? new Date().toISOString() }
      noteOwnWrite(edgeFile(p.root, name, full.id), boardJsonText(full))
      const saved = await saveEdge(p.root, name, full)
      for (const cb of boardWritten) cb({ kind: "edge", value: saved })
      return saved
    },
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
    "board:openCount": (name: string) => countOpen(need(), name),
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
