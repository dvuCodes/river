import { access, mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { BrowserWindow, ClipboardItem, app, clipboard, ipcMain, nativeTheme, net, protocol } from "electron"
import type { JobDeps } from "@river/agent"
import { VIEWS, type ViewId } from "../shared/api"
import { type Card, type Mark, loadBoard, loadCard, loadJob } from "@river/core"
import { type BoardEntity, onBoardWritten } from "./board"
import { currentProject, onStoryWritten, openProject, registerIpc, resolveRiverFile } from "./ipc"
import { getLastProject } from "./settings"
import { scenePng, seedPerfBoard, seedRichBoard } from "./smokeBoard"

const here = dirname(fileURLToPath(import.meta.url))
const smokeDir = process.env["RIVER_SMOKE_DIR"]
const isSmoke = Boolean(smokeDir)

// Images of captures are served from the project root through this scheme; webSecurity stays on.
protocol.registerSchemesAsPrivileged([
  { scheme: "river-file", privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } },
])

function argProject(): string | undefined {
  const i = process.argv.indexOf("--project")
  if (i >= 0 && process.argv[i + 1]) return process.argv[i + 1]
  const eq = process.argv.find((a) => a.startsWith("--project="))
  return eq ? eq.slice("--project=".length) : undefined
}

let win: BrowserWindow | null = null

function createWindow(): BrowserWindow {
  const w = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 960,
    minHeight: 600,
    show: false,
    title: "River",
    backgroundColor: nativeTheme.shouldUseDarkColors ? "#14181a" : "#f3f2ee",
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(here, "../preload/index.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      // Smoke runs measure frames and drive input while other windows may cover this one.
      backgroundThrottling: !isSmoke,
    },
  })
  w.once("ready-to-show", () => w.show())
  // Scripted input goes straight to the page; a person's real pointer over the window must not mix into it.
  if (isSmoke) w.setIgnoreMouseEvents(true)
  const query = isSmoke ? { smoke: "1", ...(process.env["RIVER_SMOKE_CULL"] === "0" ? { cull: "0" } : {}) } : undefined
  const devUrl = process.env["ELECTRON_RENDERER_URL"]
  if (devUrl) void w.loadURL(devUrl + (query ? `?${new URLSearchParams(query)}` : ""))
  else void w.loadFile(join(here, "../renderer/index.html"), query ? { query } : undefined)
  return w
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/**
 * RIVER_SMOKE_DRAG=1: drag one story map card ~120 px with real input events, wait until River writes the
 * story file, then let the watcher settle so its log shows whether the write was echoed back.
 */
async function smokeDrag(w: BrowserWindow): Promise<boolean> {
  const rect = (await w.webContents.executeJavaScript(`(() => {
    const el = document.querySelector(".react-flow__node-passage[data-id] .pnode-head")
    if (!el) return null
    const r = el.getBoundingClientRect()
    return { id: el.closest(".react-flow__node").getAttribute("data-id"), x: r.left + r.width / 2, y: r.top + r.height / 2 }
  })()`)) as { id: string; x: number; y: number } | null
  if (!rect) {
    console.error("river smoke: no passage card to drag")
    return false
  }
  const written = new Promise<string | null>((done) => {
    const t = setTimeout(() => done(null), 8_000)
    const off = onStoryWritten((rel) => {
      clearTimeout(t)
      off()
      done(rel)
    })
  })
  const x0 = Math.round(rect.x)
  const y0 = Math.round(rect.y)
  console.log(`river smoke: dragging ${rect.id} from ${x0},${y0}`)
  w.webContents.sendInputEvent({ type: "mouseMove", x: x0, y: y0 })
  w.webContents.sendInputEvent({ type: "mouseDown", x: x0, y: y0, button: "left", clickCount: 1 })
  for (let i = 1; i <= 12; i++) {
    await sleep(16)
    w.webContents.sendInputEvent({ type: "mouseMove", x: x0 + i * 10, y: y0, button: "left", modifiers: ["leftbuttondown"] })
  }
  await sleep(16)
  w.webContents.sendInputEvent({ type: "mouseUp", x: x0 + 120, y: y0, button: "left", clickCount: 1 })
  const rel = await written
  if (!rel) {
    console.error("river smoke: the drag was not saved")
    return false
  }
  console.log(`river smoke: drag saved to ${rel}`)
  // Give the watcher time to see the write (awaitWriteFinish + batching) so its log is complete.
  await sleep(1_200)
  return true
}

type Rect = { x: number; y: number; w: number; h: number }

/** Wait until River writes a card, mark or edge matching `pred`. */
function waitBoardWrite<K extends BoardEntity["kind"], T = Extract<BoardEntity, { kind: K }>["value"]>(kind: K, pred: (v: T) => boolean, ms: number): Promise<T | null> {
  return new Promise((done) => {
    const off = onBoardWritten(({ kind: k, value: v }) => {
      if (k !== kind || !pred(v as T)) return
      clearTimeout(t)
      off()
      done(v as T)
    })
    const t = setTimeout(() => {
      off()
      done(null)
    }, ms)
  })
}

async function rectOf(w: BrowserWindow, selector: string): Promise<Rect | null> {
  return (await w.webContents.executeJavaScript(`(() => {
    const el = document.querySelector(${JSON.stringify(selector)})
    if (!el) return null
    const r = el.getBoundingClientRect()
    return { x: r.left, y: r.top, w: r.width, h: r.height }
  })()`)) as Rect | null
}

async function waitRect(w: BrowserWindow, selector: string, ms: number): Promise<Rect | null> {
  const until = Date.now() + ms
  while (Date.now() < until) {
    const r = await rectOf(w, selector)
    if (r && r.w > 0) return r
    await sleep(100)
  }
  return null
}

async function click(w: BrowserWindow, x: number, y: number): Promise<void> {
  const [cx, cy] = [Math.round(x), Math.round(y)]
  w.webContents.sendInputEvent({ type: "mouseMove", x: cx, y: cy })
  await sleep(30)
  w.webContents.sendInputEvent({ type: "mouseDown", x: cx, y: cy, button: "left", clickCount: 1 })
  await sleep(30)
  w.webContents.sendInputEvent({ type: "mouseUp", x: cx, y: cy, button: "left", clickCount: 1 })
  await sleep(120)
}

async function drag(w: BrowserWindow, from: [number, number], to: [number, number], steps = 16): Promise<void> {
  const x0 = Math.round(from[0])
  const y0 = Math.round(from[1])
  const x1 = Math.round(to[0])
  const y1 = Math.round(to[1])
  w.webContents.sendInputEvent({ type: "mouseMove", x: x0, y: y0 })
  await sleep(30)
  w.webContents.sendInputEvent({ type: "mouseDown", x: x0, y: y0, button: "left", clickCount: 1 })
  for (let i = 1; i <= steps; i++) {
    await sleep(16)
    const x = Math.round(x0 + ((x1 - x0) * i) / steps)
    const y = Math.round(y0 + ((y1 - y0) * i) / steps)
    w.webContents.sendInputEvent({ type: "mouseMove", x, y, button: "left", modifiers: ["leftbuttondown"] })
  }
  await sleep(30)
  w.webContents.sendInputEvent({ type: "mouseUp", x: x1, y: y1, button: "left", clickCount: 1 })
}

/**
 * RIVER_SMOKE_CANVAS=1: pin two passages through IPC, open the canvas, circle one card with the circle tool,
 * type a request into the mark's box and press Enter, drag the other card ~150 px, then screenshot and check
 * the files on disk. Pointer and keyboard steps use real input events (sendInputEvent).
 */
async function smokeCanvas(w: BrowserWindow, dir: string, waitFor: (view: ViewId, ms: number) => Promise<boolean>): Promise<boolean> {
  const p = currentProject()
  if (!p) {
    console.error("river smoke: no project")
    return false
  }
  const refs = (await w.webContents.executeJavaScript(`(async () => {
    const info = await window.river.getProject()
    const rel = info.stories[0]
    const story = await window.river.loadStory(rel)
    return story.passages.slice(0, 2).map((x) => rel + "#" + x.id)
  })()`)) as string[]
  const ids: string[] = []
  const at: Record<string, [number, number]> = {}
  for (const ref of refs) {
    const dto = (await w.webContents.executeJavaScript(`window.river.boardPin("main", { kind: "passage", ref: ${JSON.stringify(ref)} })`)) as { card: Card }
    ids.push(dto.card.id)
    at[dto.card.id] = [dto.card.x, dto.card.y]
    console.log(`river smoke: pinned ${ref} as ${dto.card.id} at ${dto.card.x},${dto.card.y}`)
  }
  const [circled, moved] = ids as [string, string]
  w.webContents.send("smoke:navigate", "canvas")
  if (!(await waitFor("canvas", 15_000))) console.warn("river smoke: canvas did not report ready")
  const a = await waitRect(w, `.react-flow__node[data-id="${circled}"]`, 8_000)
  const b0 = await waitRect(w, `.react-flow__node[data-id="${moved}"]`, 8_000)
  if (!a || !b0) {
    console.error("river smoke: pinned cards are not on the canvas")
    return false
  }
  w.focus()
  w.webContents.focus()
  await sleep(300)

  // (c) circle tool; drag a circle around the first card; type the request; Enter.
  const tool = await waitRect(w, `[data-tool="circle"]`, 3_000)
  if (!tool) return false
  await click(w, tool.x + tool.w / 2, tool.y + tool.h / 2)
  const markSaved = waitBoardWrite("mark", (m) => m.shape === "circle", 8_000)
  await drag(w, [a.x - 30, a.y - 30], [a.x + a.w + 30, a.y + a.h + 30], 20)
  const mark = await markSaved
  if (!mark) {
    console.error("river smoke: the circle was not saved")
    return false
  }
  console.log(`river smoke: circle saved as ${mark.id}, anchors ${JSON.stringify(mark.anchors)}`)
  if (!(await waitRect(w, ".ask-input", 3_000))) {
    console.error("river smoke: no ask box")
    return false
  }
  await sleep(250)
  const text = "make this calmer"
  for (const ch of text) {
    w.webContents.sendInputEvent({ type: "char", keyCode: ch === " " ? "Space" : ch })
    await sleep(12)
  }
  await sleep(150)
  const typed = (await w.webContents.executeJavaScript(`document.querySelector(".ask-input")?.value ?? null`)) as string | null
  console.log(`river smoke: ask box holds ${JSON.stringify(typed)}`)
  const threadSaved = waitBoardWrite("mark", (m) => m.id === mark.id && m.thread.length > 0, 8_000)
  w.webContents.sendInputEvent({ type: "keyDown", keyCode: "Enter" })
  w.webContents.sendInputEvent({ type: "char", keyCode: "Enter" })
  w.webContents.sendInputEvent({ type: "keyUp", keyCode: "Enter" })
  const withThread = await threadSaved
  if (!withThread) {
    console.error("river smoke: the request text was not saved")
    return false
  }
  await sleep(300)

  // (d) select tool; drag the other card ~150 px right by its title.
  const sel = await rectOf(w, `[data-tool="select"]`)
  if (!sel) return false
  await click(w, sel.x + sel.w / 2, sel.y + sel.h / 2)
  await sleep(200)
  const b = (await rectOf(w, `.react-flow__node[data-id="${moved}"] .cnode-title`)) ?? b0
  const zoom = (await w.webContents.executeJavaScript(`(() => {
    const t = getComputedStyle(document.querySelector(".react-flow__viewport")).transform
    return new DOMMatrix(t).a
  })()`)) as number
  const cardSaved = waitBoardWrite("card", (c) => c.id === moved, 8_000)
  await drag(w, [b.x + 20, b.y + b.h / 2], [b.x + 20 + 150, b.y + b.h / 2], 15)
  const card = await cardSaved
  if (!card) {
    console.error("river smoke: the drag was not saved")
    return false
  }

  // (f) an outside writer (as an agent's river-mcp would be) adds a pending agent note: it must appear live.
  const boardDir = join(p.root, ".river", "boards", "main")
  const outsideId = "c_outside1"
  const outside: Card = {
    id: outsideId,
    kind: "note",
    x: at[circled]![0],
    y: 300,
    w: 240,
    ref: "",
    text: "Softer light, fewer ducks in frame?",
    madeBy: "concept-artist",
    pending: { markId: mark.id, jobId: "j_smoke000" },
    createdAt: new Date().toISOString(),
  }
  await writeFile(join(boardDir, "cards", `.${outsideId}.json.tmp`), JSON.stringify(outside, null, 2))
  await rename(join(boardDir, "cards", `.${outsideId}.json.tmp`), join(boardDir, "cards", `${outsideId}.json`))
  const live = await waitRect(w, `.react-flow__node[data-id="${outsideId}"]`, 5_000)
  console.log(`river smoke: outside write ${live ? "appeared on the canvas" : "did NOT appear"}`)

  // (e) settle, screenshot, check the files.
  await sleep(1_200)
  const out = join(dir, "canvas.png")
  await writeFile(out, (await w.webContents.capturePage()).toPNG())
  console.log(`river smoke: wrote ${out}`)
  for (const sub of ["", "cards", "marks"]) {
    const names = await readdir(join(boardDir, sub))
    console.log(`river smoke: ${sub || "."}/ ${names.join(" ")}`)
  }
  const markJson = await readFile(join(boardDir, "marks", `${mark.id}.json`), "utf8")
  const cardJson = JSON.parse(await readFile(join(boardDir, "cards", `${moved}.json`), "utf8")) as Card
  const [mx, my] = at[moved]!
  console.log(`river smoke: mark file ${mark.id}.json:\n${markJson}`)
  console.log(`river smoke: zoom ${zoom.toFixed(3)}; moved card ${moved} from ${mx},${my} to ${cardJson.x},${cardJson.y}`)
  const m = JSON.parse(markJson) as Mark
  const ok =
    m.anchors.length === 1 &&
    m.anchors[0] === circled &&
    m.thread[0]?.text === text &&
    Math.abs(cardJson.x - mx - 150 / zoom) < 12 &&
    Math.abs(cardJson.y - my) < 4 &&
    live !== null
  console.log(`river smoke: canvas checks ${ok ? "PASSED" : "FAILED"}`)
  return ok
}

const SMOKE_DRAW_GD = `extends RefCounted

func draw(img: Image) -> void:
	var w := img.get_width()
	var h := img.get_height()
	img.fill(Color(0.62, 0.74, 0.80))
	img.fill_rect(Rect2i(0, h * 6 / 10, w, h * 4 / 10), Color(0.45, 0.60, 0.42))
	img.fill_rect(Rect2i(w / 10, h * 3 / 10, w / 8, h * 3 / 10), Color(0.36, 0.30, 0.24))
	img.fill_rect(Rect2i(w * 6 / 10, h * 7 / 10, w * 3 / 10, h / 10), Color(0.40, 0.56, 0.70))
	img.fill_rect(Rect2i(w * 7 / 10, h / 10, w / 10, w / 10), Color(0.98, 0.90, 0.62))
`

/** RIVER_SMOKE_JOB: the agent turn writes a fixed draw.gd instead of calling a model. */
const smokeJobDeps: JobDeps = {
  runTurn: async (req, h) => {
    const dir = join(req.root, "concepts", req.conceptId ?? "missing")
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, "draw.gd"), SMOKE_DRAW_GD)
    h.onEvent({ type: "text", text: "Calmer: a low horizon, soft sky, one still pond." })
  },
}

/** Click the middle of `selector`, after checking nothing (a panel, another card) covers that point. */
async function clickEl(w: BrowserWindow, selector: string, ms: number): Promise<boolean> {
  const r = await waitRect(w, selector, ms)
  if (!r) {
    console.error(`river smoke: no ${selector}`)
    const dir = process.env["RIVER_SMOKE_DIR"]
    if (dir) await writeFile(join(dir, "missing.png"), (await w.webContents.capturePage()).toPNG())
    return false
  }
  const [x, y] = [Math.round(r.x + r.w / 2), Math.round(r.y + r.h / 2)]
  const onTarget = (await w.webContents.executeJavaScript(`(() => {
    const hit = document.elementFromPoint(${x}, ${y})
    const target = document.querySelector(${JSON.stringify(selector)})
    return Boolean(hit && target && (target === hit || target.contains(hit) || hit.contains(target)))
  })()`)) as boolean
  if (!onTarget) {
    console.error(`river smoke: ${selector} is covered at ${x},${y}`)
    const dir = process.env["RIVER_SMOKE_DIR"]
    if (dir) await writeFile(join(dir, "covered.png"), (await w.webContents.capturePage()).toPNG())
    return false
  }
  await click(w, x, y)
  return true
}

/** Wait until `selector` is an <img> that has loaded. */
async function waitImage(w: BrowserWindow, selector: string, ms: number): Promise<boolean> {
  const until = Date.now() + ms
  while (Date.now() < until) {
    const ok = (await w.webContents.executeJavaScript(`(() => {
      const img = document.querySelector(${JSON.stringify(selector)})
      return Boolean(img && img.complete && img.naturalWidth > 0)
    })()`)) as boolean
    if (ok) return true
    await sleep(200)
  }
  return false
}

async function key(w: BrowserWindow, keyCode: string, modifiers: ("shift" | "control")[] = []): Promise<void> {
  w.webContents.sendInputEvent({ type: "keyDown", keyCode, modifiers })
  // A form submits on the Enter key press (char), not on keydown.
  if (keyCode === "Return") w.webContents.sendInputEvent({ type: "char", keyCode: "Enter", modifiers })
  w.webContents.sendInputEvent({ type: "keyUp", keyCode, modifiers })
  await sleep(150)
}

const exists = (abs: string) => access(abs).then(
  () => true,
  () => false,
)

/**
 * RIVER_SMOKE_JOB=1: pin a passage and put a pin mark with a request beside it (IPC), then with real clicks:
 * open the mark, ask the concept artist, review and run its script, Accept; then ask on a second mark and
 * Dismiss it while it waits for approval. The agent turn is the fake from
 * smokeJobDeps; the render is real Godot. Screenshots the answered card and the accepted card.
 */
async function smokeJob(w: BrowserWindow, dir: string, waitFor: (view: ViewId, ms: number) => Promise<boolean>): Promise<boolean> {
  const p = currentProject()
  if (!p) {
    console.error("river smoke: no project")
    return false
  }
  const card = (
    (await w.webContents.executeJavaScript(`(async () => {
      const info = await window.river.getProject()
      const rel = info.stories[0]
      const story = await window.river.loadStory(rel)
      return window.river.boardPin("main", { kind: "passage", ref: rel + "#" + story.passages[0].id })
    })()`)) as { card: Card }
  ).card
  const markReq = {
    shape: "pin",
    path: [card.x + card.w + 24, card.y + 40],
    anchors: [card.id],
    thread: [{ by: "you", at: new Date().toISOString(), text: "make this calmer" }],
    madeBy: "you",
  }
  const saveMark = async (req: object) =>
    ((await w.webContents.executeJavaScript(`window.river.boardSaveMark("main", ${JSON.stringify(req)})`)) as { mark: Mark }).mark
  const mark = await saveMark(markReq)
  // The second mark's card lands left of the passage, clear of the first one's.
  const toDismiss = await saveMark({ ...markReq, path: [card.x - 330, card.y + 40], thread: [{ by: "you", at: new Date().toISOString(), text: "try it at dusk" }] })
  console.log(`river smoke: pinned ${card.ref} as ${card.id}; marks ${mark.id} (accept) and ${toDismiss.id} (dismiss)`)
  w.webContents.send("smoke:navigate", "canvas")
  if (!(await waitFor("canvas", 15_000))) console.warn("river smoke: canvas did not report ready")
  w.focus()
  w.webContents.focus()
  await sleep(300)

  if (!(await clickEl(w, `[data-mark="${mark.id}"] .mark-pin`, 8_000))) return false
  if (!(await clickEl(w, `[data-action="ask-concept"]`, 3_000))) return false
  console.log("river smoke: asked the concept artist")
  // Agents place their answer beside the mark, maybe off screen: the mark panel brings it into view.
  if (!(await clickEl(w, `[data-action="show-answer"]`, 120_000))) return false
  if (!(await clickEl(w, `.concept[data-job-status="approval"] [data-action="review"]`, 120_000))) return false
  if (!(await waitRect(w, ".concept-script-text", 5_000))) {
    console.error("river smoke: the script did not show")
    return false
  }
  const shown = (await w.webContents.executeJavaScript(`document.querySelector(".concept-script-text").textContent`)) as string
  console.log(`river smoke: reviewing script (${shown.split("\n").length} lines)`)
  await sleep(300)
  const review = join(dir, "job-review.png")
  await writeFile(review, (await w.webContents.capturePage()).toPNG())
  console.log(`river smoke: wrote ${review}`)
  if (!(await clickEl(w, `.concept[data-job-status="approval"] [data-action="run"]`, 3_000))) return false
  console.log("river smoke: approved; rendering")
  if (!(await waitImage(w, `.concept[data-job-status="answered"] img.cnode-img`, 120_000))) {
    const jobs = (await loadBoard(p.root, "main")).cards.filter((c) => c.kind === "concept")
    console.error(`river smoke: no rendered image; concept cards ${JSON.stringify(jobs)}`)
    return false
  }
  await sleep(500)
  const answered = join(dir, "job-answered.png")
  await writeFile(answered, (await w.webContents.capturePage()).toPNG())
  console.log(`river smoke: wrote ${answered}`)

  const concept = (await loadBoard(p.root, "main")).cards.find((c) => c.kind === "concept" && c.pending?.markId === mark.id)
  if (!concept?.pending) {
    console.error("river smoke: no pending concept card on disk")
    return false
  }
  const jobId = concept.pending.jobId
  if (!(await clickEl(w, `.concept[data-job-status="answered"] [data-action="accept"]`, 3_000))) return false
  if (!(await waitImage(w, `.react-flow__node[data-id="${concept.id}"] .cnode-concept:not(.is-pending) img.cnode-img`, 30_000))) {
    console.error("river smoke: the accepted card did not show its image")
    return false
  }
  await sleep(500)
  const accepted = join(dir, "job-accepted.png")
  await writeFile(accepted, (await w.webContents.capturePage()).toPNG())
  console.log(`river smoke: wrote ${accepted}`)

  const conceptDir = join(p.root, "concepts", concept.ref)
  const files = { "draw.gd": await exists(join(conceptDir, "draw.gd")), "concept.png": await exists(join(conceptDir, "concept.png")) }
  const job = await loadJob(p.root, jobId)
  const markNow = (await loadBoard(p.root, "main")).marks.find((m) => m.id === mark.id)
  console.log(`river smoke: concepts/${concept.ref}/ ${JSON.stringify(files)}; job ${job.status}; mark ${markNow?.status}`)

  await key(w, "Escape")
  await key(w, "1", ["shift"])
  await sleep(500)
  if (!(await clickEl(w, `[data-mark="${toDismiss.id}"] .mark-pin`, 3_000))) return false
  if (!(await clickEl(w, `[data-action="ask-concept"]`, 3_000))) return false
  if (!(await clickEl(w, `[data-action="show-answer"]`, 120_000))) return false
  if (!(await clickEl(w, `.concept[data-job-status="approval"] [data-action="dismiss"]`, 120_000))) return false
  const until = Date.now() + 10_000
  let dismissedJob: string | undefined
  let leftover: Card[] = []
  while (Date.now() < until) {
    const board = await loadBoard(p.root, "main")
    dismissedJob = board.marks.find((m) => m.id === toDismiss.id)?.jobId
    leftover = board.cards.filter((c) => c.pending?.markId === toDismiss.id)
    const status = dismissedJob ? (await loadJob(p.root, dismissedJob)).status : undefined
    const onCanvas = (await w.webContents.executeJavaScript(`document.querySelectorAll(".concept[data-job-status]").length`)) as number
    if (status === "dismissed" && leftover.length === 0 && onCanvas === 0) break
    await sleep(200)
  }
  const dismissed = dismissedJob ? (await loadJob(p.root, dismissedJob)).status === "dismissed" && leftover.length === 0 : false
  console.log(`river smoke: dismiss leg: job ${dismissedJob} ${dismissed ? "dismissed, card gone" : "NOT dismissed"}`)
  const ok = files["draw.gd"] && files["concept.png"] && job.status === "accepted" && dismissed
  console.log(`river smoke: job checks ${ok ? "PASSED" : "FAILED"}`)
  return ok
}

/** Middle of an element, in window coordinates; null when it is not on screen. */
async function centerOf(w: BrowserWindow, selector: string, ms = 5_000): Promise<[number, number] | null> {
  const r = await waitRect(w, selector, ms)
  return r ? [r.x + r.w / 2, r.y + r.h / 2] : null
}

async function viewport(w: BrowserWindow): Promise<{ x: number; y: number; zoom: number }> {
  return (await w.webContents.executeJavaScript(`(() => {
    const m = new DOMMatrix(getComputedStyle(document.querySelector(".react-flow__viewport")).transform)
    return { x: m.e, y: m.f, zoom: m.a }
  })()`)) as { x: number; y: number; zoom: number }
}

async function shoot(w: BrowserWindow, dir: string, name: string): Promise<void> {
  const out = join(dir, name)
  await writeFile(out, (await w.webContents.capturePage()).toPNG())
  console.log(`river smoke: wrote ${out}`)
}

async function typeText(w: BrowserWindow, text: string): Promise<void> {
  for (const ch of text) {
    w.webContents.sendInputEvent({ type: "char", keyCode: ch === " " ? "Space" : ch })
    await sleep(12)
  }
}

/** Poll `check` until it is true or `ms` passes. */
async function until(check: () => Promise<boolean>, ms: number): Promise<boolean> {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (await check()) return true
    await sleep(100)
  }
  return check()
}

async function imagesSettled(w: BrowserWindow, ms: number): Promise<boolean> {
  return until(async () => (await w.webContents.executeJavaScript(`[...document.querySelectorAll("img.cnode-img")].every((i) => i.complete)`)) as boolean, ms)
}

/**
 * RIVER_SMOKE_BOARD=1: seed a rich board (references, your note, an agent's labelled options and note, a sequence of
 * beats with connectors, a circled reference), screenshot it whole and close up, then drive it with real input:
 * draw a connector with the arrow tool, box-select two cards and drag them, undo and redo, paste an image (it gets
 * "own work"), zoom with the controls and pan the minimap, jump with Ctrl+K, duplicate and undo, select and delete
 * a connector and undo, delete a card with its connectors and undo, and open an image in the lightbox.
 */
async function smokeBoard(w: BrowserWindow, dir: string, waitFor: (view: ViewId, ms: number) => Promise<boolean>): Promise<boolean> {
  const p = currentProject()
  if (!p) return false
  const passageRef = (await w.webContents.executeJavaScript(`(async () => {
    const info = await window.river.getProject()
    const story = await window.river.loadStory(info.stories[0])
    return info.stories[0] + "#" + story.passages[0].id
  })()`)) as string
  const { ids } = await seedRichBoard(p.root, "main", passageRef)
  const id = (k: string) => ids[k]!
  const node = (k: string, sub = "") => `.react-flow__node[data-id="${id(k)}"] ${sub}`.trim()
  const card = (k: string) => loadCard(p.root, "main", id(k))
  const theme = process.env["RIVER_SMOKE_THEME"] ?? "system"
  const results: [string, boolean][] = []
  const check = (name: string, ok: boolean) => {
    results.push([name, ok])
    console.log(`river smoke: ${ok ? "ok" : "FAILED"} ${name}`)
  }

  w.webContents.send("smoke:navigate", "canvas")
  if (!(await waitFor("canvas", 20_000))) console.warn("river smoke: canvas did not report ready")
  w.focus()
  w.webContents.focus()
  await imagesSettled(w, 10_000)
  await sleep(600)
  await shoot(w, dir, `rich-${theme}.png`)

  // Clicking a mark's ink (not its box) selects it and opens its panel; Escape closes it.
  let panels = 0
  for (let i = 0; i < 3; i++) {
    const pt = (await w.webContents.executeJavaScript(`(() => {
      const path = document.querySelector('[data-mark="m_circle01"] .mark-hit')
      if (!path) return null
      const pt = path.getPointAtLength(path.getTotalLength() * 0.3)
      const m = path.getScreenCTM()
      return [pt.x * m.a + m.e, pt.y * m.d + m.f]
    })()`)) as [number, number] | null
    if (pt) await click(w, pt[0], pt[1])
    if (await waitRect(w, ".mark-panel", 1_500)) panels++
    await key(w, "Escape")
    await sleep(250)
  }
  check(`clicking a mark's ink opens its panel (${panels}/3)`, panels === 3)

  // Close up: jump to option B, which brings your note, the options and the agent's note into view.
  await key(w, "K", ["control"])
  await waitRect(w, ".jump-input", 3_000)
  await typeText(w, "lanterns")
  await key(w, "Return")
  await sleep(900)
  await imagesSettled(w, 5_000)
  await shoot(w, dir, `rich-${theme}-detail.png`)
  check("Ctrl+K jumps to and selects the card", (await w.webContents.executeJavaScript(`[...document.querySelectorAll(".react-flow__node.selected")].map((n) => n.dataset.id).join()`)) === id("optB"))
  await key(w, "Escape")
  await key(w, "1", ["shift"])
  await sleep(700)

  // Arrow tool: a connector from a reference to the passage card.
  await clickEl(w, `[data-tool="arrow"]`, 3_000)
  const from = await centerOf(w, node("shadows", ".cnode-frame"))
  const to = await centerOf(w, node("passage"))
  const edgeSaved = waitBoardWrite("edge", (e) => e.from === id("shadows") && e.to === id("passage"), 6_000)
  if (from && to) await drag(w, from, to, 18)
  const drawn = await edgeSaved
  check("arrow tool draws a connector between two cards", drawn !== null && (await until(async () => Boolean(await rectOf(w, `[data-testid="rf__edge-${drawn.id}"]`)), 3_000)))
  await key(w, "V")

  // Box-select beats 3 and 4 from empty paper, then drag one: both move, as one undo step.
  const b3 = await rectOf(w, node("beat3"))
  const b4 = await rectOf(w, node("beat4"))
  const before3 = await card("beat3")
  const before4 = await card("beat4")
  let moved = false
  let undone = false
  let redone = false
  if (b3 && b4 && before3 && before4) {
    await drag(w, [b3.x - 22, b3.y - 22], [b4.x + b4.w + 22, b4.y + b4.h + 30], 14)
    await sleep(300)
    const selected = (await w.webContents.executeJavaScript(`[...document.querySelectorAll(".react-flow__node.selected")].map((n) => n.dataset.id).sort().join()`)) as string
    check("box select picks exactly the two cards", selected === [id("beat3"), id("beat4")].sort().join())
    const { zoom } = await viewport(w)
    const saved3 = waitBoardWrite("card", (c) => c.id === id("beat3"), 6_000)
    const saved4 = waitBoardWrite("card", (c) => c.id === id("beat4"), 6_000)
    const grab = (await centerOf(w, node("beat3", ".cnode-frame")))!
    await drag(w, grab, [grab[0] + 120, grab[1] + 80], 16)
    const [a3, a4] = await Promise.all([saved3, saved4])
    const dx = 120 / zoom
    const dy = 80 / zoom
    // React Flow starts the drag after the first move, so one step of the 16 can be lost.
    const slack = 120 / 16 / zoom + 2
    const shifted = (a: Card | null, b: Card) => a !== null && Math.abs(a.x - b.x - dx) < slack && Math.abs(a.y - b.y - dy) < slack
    moved = shifted(a3, before3) && shifted(a4, before4) && a3!.x - before3.x === a4!.x - before4.x && a3!.y - before3.y === a4!.y - before4.y
    check(`dragging one moves both and saves both (expected +${dx.toFixed(1)},+${dy.toFixed(1)}; got ${a3 ? `${a3.x - before3.x},${a3.y - before3.y}` : "none"} and ${a4 ? `${a4.x - before4.x},${a4.y - before4.y}` : "none"})`, moved)
    await key(w, "Z", ["control"])
    undone = await until(async () => {
      const [c3, c4] = [await card("beat3"), await card("beat4")]
      return c3?.x === before3.x && c3.y === before3.y && c4?.x === before4.x && c4.y === before4.y
    }, 4_000)
    check("Ctrl+Z puts both back on disk", undone)
    await key(w, "Z", ["control", "shift"])
    redone = await until(async () => (await card("beat3"))?.x !== before3.x, 4_000)
    check("Ctrl+Shift+Z moves them again", redone)
    await key(w, "Z", ["control"])
    await until(async () => (await card("beat3"))?.x === before3.x, 4_000)
  } else check("beats 3 and 4 are on screen", false)

  // Paste an image from the clipboard: the licence form opens with "own work"; Enter adds the card.
  await key(w, "Escape")
  await clipboard.write([new ClipboardItem({ "image/png": new Blob([new Uint8Array(scenePng(4242, 640, 400))], { type: "image/png" }) })])
  const pane = await rectOf(w, ".react-flow__pane")
  if (pane) w.webContents.sendInputEvent({ type: "mouseMove", x: Math.round(pane.x + pane.w * 0.62), y: Math.round(pane.y + pane.h * 0.18) })
  await sleep(100)
  await key(w, "V", ["control"])
  const form = await waitRect(w, ".ref-form", 4_000)
  const licence = form ? ((await w.webContents.executeJavaScript(`[...document.querySelectorAll(".ref-form input")].pop()?.value ?? null`)) as string | null) : null
  const pasted = waitBoardWrite("card", (c) => c.kind === "ref" && !Object.values(ids).includes(c.id), 6_000)
  await key(w, "Return")
  const pastedCard = await pasted
  check(`paste opens the licence form with "own work" (got ${JSON.stringify(licence)}) and adds the image`, licence === "own work" && pastedCard?.source?.licence === "own work" && (await exists(join(p.root, pastedCard.ref))))

  // Zoom controls and minimap.
  const pct = async () => (await w.webContents.executeJavaScript(`document.querySelector(".zoom-pct")?.textContent ?? ""`)) as string
  const pct0 = await pct()
  await clickEl(w, `[data-zoom="in"]`, 3_000)
  await sleep(400)
  const pct1 = await pct()
  check(`zoom in changes the readout (${pct0} to ${pct1})`, parseInt(pct1) > parseInt(pct0))
  await clickEl(w, `[data-zoom="fit"]`, 3_000)
  await sleep(500)
  const miniNodes = (await w.webContents.executeJavaScript(`document.querySelectorAll(".react-flow__minimap-node").length`)) as number
  const mini = await centerOf(w, ".react-flow__minimap svg", 3_000)
  const vp0 = await viewport(w)
  if (mini) await drag(w, mini, [mini[0] + 30, mini[1] + 14], 10)
  await sleep(300)
  const vp1 = await viewport(w)
  check(`minimap shows ${miniNodes} nodes and dragging it pans the board`, miniNodes >= Object.keys(ids).length && (Math.abs(vp1.x - vp0.x) > 5 || Math.abs(vp1.y - vp0.y) > 5))
  await key(w, "1", ["shift"])
  await sleep(600)

  // Duplicate with Ctrl+D, then undo removes the copy.
  await clickEl(w, node("optD", ".cnode-frame"), 3_000)
  const dup = waitBoardWrite("card", (c) => c.kind === "concept" && c.variant === "d" && c.id !== id("optD"), 5_000)
  await key(w, "D", ["control"])
  const copy = await dup
  await key(w, "Z", ["control"])
  check("Ctrl+D duplicates the card and Ctrl+Z removes the copy", copy !== null && (await until(async () => (await loadCard(p.root, "main", copy.id)) === undefined, 4_000)))

  // Click a connector, Delete removes its file, Ctrl+Z brings it back.
  await key(w, "Escape")
  let edgeBack = false
  if (drawn) {
    const at = (await w.webContents.executeJavaScript(`(() => {
      const path = document.querySelector('[data-testid="rf__edge-${drawn.id}"] .react-flow__edge-path')
      if (!path) return null
      const pt = path.getPointAtLength(path.getTotalLength() * 0.5)
      const m = path.getScreenCTM()
      return [pt.x * m.a + m.e, pt.y * m.d + m.f]
    })()`)) as [number, number] | null
    if (at) await click(w, at[0], at[1])
    const picked = (await w.webContents.executeJavaScript(`Boolean(document.querySelector('[data-testid="rf__edge-${drawn.id}"].selected'))`)) as boolean
    await key(w, "Delete")
    const gone = await until(async () => !(await exists(join(p.root, ".river", "boards", "main", "edges", `${drawn.id}.json`))), 4_000)
    await key(w, "Z", ["control"])
    edgeBack = await until(async () => exists(join(p.root, ".river", "boards", "main", "edges", `${drawn.id}.json`)), 4_000)
    check("clicking a connector selects it; Delete removes it; Ctrl+Z restores it", picked && gone && edgeBack)
  }

  // Delete a card that has connectors: its connectors go with it; one Ctrl+Z restores all three files.
  const beatEdges = (await loadBoard(p.root, "main")).edges.filter((e) => e.from === id("beat2") || e.to === id("beat2")).map((e) => e.id)
  await clickEl(w, node("beat2", ".cnode-frame"), 3_000)
  await key(w, "Delete")
  const cascade = await until(async () => {
    const b = await loadBoard(p.root, "main")
    return !b.cards.some((c) => c.id === id("beat2")) && !b.edges.some((e) => beatEdges.includes(e.id))
  }, 4_000)
  await key(w, "Z", ["control"])
  const restored = await until(async () => {
    const b = await loadBoard(p.root, "main")
    return b.cards.some((c) => c.id === id("beat2")) && beatEdges.every((e) => b.edges.some((x) => x.id === e))
  }, 4_000)
  check(`deleting a card removes its ${beatEdges.length} connectors and Ctrl+Z restores them`, beatEdges.length === 2 && cascade && restored)

  // Double-click an image: lightbox; Escape closes it.
  const img = await centerOf(w, node("optA", ".cnode-frame"))
  if (img) {
    const [x, y] = img.map(Math.round) as [number, number]
    w.webContents.sendInputEvent({ type: "mouseMove", x, y })
    for (const clickCount of [1, 2]) {
      await sleep(40)
      w.webContents.sendInputEvent({ type: "mouseDown", x, y, button: "left", clickCount })
      await sleep(30)
      w.webContents.sendInputEvent({ type: "mouseUp", x, y, button: "left", clickCount })
    }
  }
  const opened = await waitImage(w, ".lightbox img", 3_000)
  await sleep(300)
  if (opened) await shoot(w, dir, `lightbox-${theme}.png`)
  await key(w, "Escape")
  check("double-click opens the lightbox and Escape closes it", opened && (await until(async () => !(await rectOf(w, ".lightbox")), 2_000)))

  await key(w, "Escape")
  await sleep(300)
  await shoot(w, dir, `rich-${theme}-after.png`)
  const ok = results.every(([, r]) => r)
  console.log(`river smoke: board checks ${ok ? "PASSED" : "FAILED"} (${results.filter(([, r]) => r).length}/${results.length})`)
  return ok
}

const stats = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b)
  const q = (f: number) => s[Math.min(s.length - 1, Math.floor(f * s.length))] ?? 0
  return { n: s.length, p50: q(0.5), p95: q(0.95), p99: q(0.99), max: s[s.length - 1] ?? 0 }
}

/**
 * Record rAF frame intervals and long tasks while `drive` sends input. Frame intervals at the display's refresh
 * interval mean no frame was dropped; the idle median measured first is that floor.
 */
async function framesDuring(w: BrowserWindow, drive: () => Promise<void>) {
  await w.webContents.executeJavaScript(`(() => {
    const rec = { frames: [], long: [], moved: 0, run: true }
    window.__riverFrames = rec
    const vp = document.querySelector(".react-flow__viewport")
    let last = performance.now()
    let was = vp?.style.transform
    const tick = (t) => {
      rec.frames.push(t - last)
      last = t
      const now = vp?.style.transform
      if (now !== was) rec.moved++
      was = now
      if (rec.run) requestAnimationFrame(tick)
    }
    requestAnimationFrame(tick)
    try { rec.obs = new PerformanceObserver((l) => rec.long.push(...l.getEntries().map((e) => e.duration))); rec.obs.observe({ type: "longtask" }) } catch {}
  })()`)
  await drive()
  return (await w.webContents.executeJavaScript(`(() => {
    const rec = window.__riverFrames
    rec.run = false
    rec.obs?.disconnect()
    return { frames: rec.frames.slice(1), long: rec.long, moved: rec.moved, nodes: document.querySelectorAll(".react-flow__node").length, edges: document.querySelectorAll(".react-flow__edge").length, imgs: document.querySelectorAll("img.cnode-img").length }
  })()`)) as { frames: number[]; long: number[]; moved: number; nodes: number; edges: number; imgs: number }
}

/** Wheel-pan in circles for `ms` (one loop a second), so the board keeps moving without leaving the cards. */
async function wheelPan(w: BrowserWindow, ms: number, step = 40): Promise<void> {
  const pane = (await rectOf(w, ".react-flow__pane"))!
  const x = Math.round(pane.x + pane.w / 2)
  const y = Math.round(pane.y + pane.h / 2)
  const start = Date.now()
  while (Date.now() - start < ms) {
    const a = ((Date.now() - start) / 1000) * Math.PI * 2
    w.webContents.sendInputEvent({ type: "mouseWheel", x, y, deltaX: Math.round(Math.cos(a) * step), deltaY: Math.round(Math.sin(a) * step), canScroll: true })
    await sleep(8)
  }
}

/**
 * RIVER_SMOKE_PERF=1: seed a 150-card board (100 distinct generated images, 50 notes, 60 connectors), then report
 * load to ready, how long until the images on screen have loaded, and frame intervals during a scripted wheel pan at
 * fit-all zoom and at 100%. RIVER_SMOKE_CULL=0 turns React Flow's culling off for comparison.
 */
/**
 * RIVER_SMOKE_PROFILE=1: a renderer CPU profile of `run`, written as renderer.cpuprofile, with the functions that took
 * the most self time printed. The profiler slows the page, so frame numbers from such a run are not reported.
 */
async function profiled(w: BrowserWindow, dir: string, run: () => Promise<void>): Promise<void> {
  const dbg = w.webContents.debugger
  dbg.attach("1.3")
  await dbg.sendCommand("Profiler.enable")
  await dbg.sendCommand("Profiler.setSamplingInterval", { interval: 200 })
  await dbg.sendCommand("Profiler.start")
  await run()
  const { profile } = (await dbg.sendCommand("Profiler.stop")) as {
    profile: { nodes: { id: number; callFrame: { functionName: string; url: string; lineNumber: number } }[]; samples: number[]; timeDeltas: number[] }
  }
  dbg.detach()
  await writeFile(join(dir, "renderer.cpuprofile"), JSON.stringify(profile))
  const self = new Map<number, number>()
  profile.samples.forEach((id, i) => self.set(id, (self.get(id) ?? 0) + (profile.timeDeltas[i] ?? 0)))
  const byName = new Map<string, number>()
  for (const n of profile.nodes) {
    const f = n.callFrame
    const name = `${f.functionName || "(anonymous)"} ${f.url.split("/").pop() ?? ""}:${f.lineNumber}`
    byName.set(name, (byName.get(name) ?? 0) + (self.get(n.id) ?? 0))
  }
  const total = [...byName.values()].reduce((a, b) => a + b, 0)
  const top = [...byName.entries()].sort((a, b) => b[1] - a[1]).slice(0, 14)
  console.log(`river perf: profile ${Math.round(total / 1000)} ms sampled; top self time:`)
  for (const [name, us] of top) console.log(`river perf:   ${(us / 1000).toFixed(1).padStart(7)} ms  ${((us / total) * 100).toFixed(1).padStart(5)}%  ${name}`)
}

async function smokePerf(w: BrowserWindow, dir: string, waitFor: (view: ViewId, ms: number) => Promise<boolean>): Promise<boolean> {
  const p = currentProject()
  if (!p) return false
  const t0 = performance.now()
  const seeded = await seedPerfBoard(p.root, "main")
  console.log(`river perf: seeded ${JSON.stringify(seeded)} in ${Math.round(performance.now() - t0)} ms`)
  w.focus()
  w.webContents.focus()
  await sleep(500)
  const idle = await framesDuring(w, async () => {
    await sleep(1_000)
  })
  const tNav = performance.now()
  w.webContents.send("smoke:navigate", "canvas")
  const ready = await waitFor("canvas", 60_000)
  // useSmokeReady reports two frames plus 250 ms after the canvas is ready.
  const navToReady = performance.now() - tNav - 250
  const marks = (await w.webContents.executeJavaScript(`(() => {
    const last = (n) => performance.getEntriesByName(n).pop()?.startTime ?? null
    return { open: last("canvas:open"), loaded: last("canvas:loaded"), ready: last("canvas:ready") }
  })()`)) as Record<string, number | null>
  const tImg = performance.now()
  const settled = await imagesSettled(w, 20_000)
  const imagesMs = performance.now() - tImg
  const atLoad = (await w.webContents.executeJavaScript(`({ nodes: document.querySelectorAll(".react-flow__node").length, imgs: document.querySelectorAll("img.cnode-img").length, loaded: [...document.querySelectorAll("img.cnode-img")].filter((i) => i.complete && i.naturalWidth > 0).length })`)) as Record<string, number>
  const vpFit0 = await viewport(w)
  const fit = await framesDuring(w, () => (process.env["RIVER_SMOKE_PROFILE"] === "1" ? profiled(w, dir, () => wheelPan(w, 3_000)) : wheelPan(w, 3_000)))
  await key(w, "1", ["shift"])
  await sleep(500)
  for (let i = 0; i < 12 && (await viewport(w)).zoom < 0.99; i++) {
    await clickEl(w, `[data-zoom="in"]`, 2_000)
    await sleep(250)
  }
  await imagesSettled(w, 10_000)
  const vp100a = await viewport(w)
  const at100 = await framesDuring(w, () => wheelPan(w, 3_000))
  const report = {
    cull: process.env["RIVER_SMOKE_CULL"] !== "0",
    ready,
    navToReadyMs: Math.round(navToReady),
    rendererOpenToLoadedMs: marks["open"] != null && marks["loaded"] != null ? Math.round(marks["loaded"] - marks["open"]) : null,
    rendererLoadedToReadyMs: marks["loaded"] != null && marks["ready"] != null ? Math.round(marks["ready"] - marks["loaded"]) : null,
    imagesSettledAfterReadyMs: settled ? Math.round(imagesMs) : null,
    atLoad,
    idleFrame: stats(idle.frames),
    fitPan: { zoom: +vpFit0.zoom.toFixed(3), framesMoved: fit.moved, frames: stats(fit.frames), over25ms: fit.frames.filter((f) => f > 25).length, longTasks: fit.long.length, longMax: Math.round(Math.max(0, ...fit.long)), dom: { nodes: fit.nodes, edges: fit.edges, imgs: fit.imgs } },
    pan100: { zoom: +vp100a.zoom.toFixed(3), framesMoved: at100.moved, frames: stats(at100.frames), over25ms: at100.frames.filter((f) => f > 25).length, longTasks: at100.long.length, longMax: Math.round(Math.max(0, ...at100.long)), dom: { nodes: at100.nodes, edges: at100.edges, imgs: at100.imgs } },
  }
  console.log(`river perf: ${JSON.stringify(report)}`)
  return ready && report.fitPan.framesMoved > 0 && report.pan100.framesMoved > 0
}

async function runSmoke(w: BrowserWindow, dir: string): Promise<void> {
  const limit = process.env["RIVER_SMOKE_JOB"] === "1" || process.env["RIVER_SMOKE_PERF"] === "1" ? 300_000 : 180_000
  const hardStop = setTimeout(() => {
    console.error(`river smoke: timed out after ${limit / 1000}s`)
    app.exit(2)
  }, limit)
  w.webContents.on("console-message", (e) => console.log(`[renderer] ${e.message}`))
  w.webContents.on("render-process-gone", (_e, d) => {
    console.error("river smoke: renderer gone", d.reason)
    app.exit(3)
  })

  const seen = new Set<ViewId>()
  const waiters = new Map<ViewId, () => void>()
  ipcMain.on("smoke:ready", (_e, view: ViewId) => {
    seen.add(view)
    waiters.get(view)?.()
  })
  const waitFor = (view: ViewId, ms: number) =>
    new Promise<boolean>((done) => {
      if (seen.has(view)) return done(true)
      const t = setTimeout(() => done(false), ms)
      waiters.set(view, () => {
        clearTimeout(t)
        done(true)
      })
    })

  await mkdir(dir, { recursive: true })
  if (process.env["RIVER_SMOKE_JOB"] === "1") {
    if (!(await waitFor("story-map", 30_000))) console.warn("river smoke: story map did not report ready")
    const ok = await smokeJob(w, dir, waitFor).catch((err: unknown) => {
      console.error("river smoke: job run threw", err)
      return false
    })
    clearTimeout(hardStop)
    app.exit(ok ? 0 : 1)
    return
  }
  for (const [env, run] of [
    ["RIVER_SMOKE_BOARD", () => smokeBoard(w, dir, waitFor)],
    ["RIVER_SMOKE_PERF", () => smokePerf(w, dir, waitFor)],
  ] as const) {
    if (process.env[env] !== "1") continue
    if (!(await waitFor("story-map", 30_000))) console.warn("river smoke: story map did not report ready")
    const ok = await run().catch((err: unknown) => {
      console.error(`river smoke: ${env} threw`, err)
      return false
    })
    clearTimeout(hardStop)
    app.exit(ok ? 0 : 1)
    return
  }
  if (process.env["RIVER_SMOKE_CANVAS"] === "1") {
    const ready = await waitFor("story-map", 30_000)
    if (!ready) console.warn("river smoke: story map did not report ready")
    const ok = await smokeCanvas(w, dir, waitFor).catch((err: unknown) => {
      console.error("river smoke: canvas run threw", err)
      return false
    })
    clearTimeout(hardStop)
    app.exit(ok ? 0 : 1)
    return
  }
  let failed = false
  for (const view of VIEWS) {
    let ok: boolean
    if (view === "story-map") ok = await waitFor(view, 30_000)
    else {
      seen.delete(view)
      ok = false
      // Re-send if the view does not report ready, so one lost message cannot yield a wrong capture.
      for (let attempt = 0; attempt < 3 && !ok; attempt++) {
        if (attempt > 0) console.warn(`river smoke: ${view} not ready, navigating again`)
        w.webContents.send("smoke:navigate", view)
        ok = await waitFor(view, 6_000)
      }
    }
    if (!ok) {
      failed = true
      console.error(`river smoke: ${view} did not report ready; capturing anyway`)
    }
    await new Promise((r) => setTimeout(r, 350))
    const image = await w.webContents.capturePage()
    const out = join(dir, `${view}.png`)
    await writeFile(out, image.toPNG())
    console.log(`river smoke: wrote ${out} (${image.getSize().width}x${image.getSize().height})`)
    if (view === "story-map" && process.env["RIVER_SMOKE_DRAG"] === "1") {
      const ok = await smokeDrag(w)
      const after = join(dir, "story-map-dragged.png")
      await writeFile(after, (await w.webContents.capturePage()).toPNG())
      console.log(`river smoke: wrote ${after}`)
      clearTimeout(hardStop)
      app.exit(ok ? 0 : 1)
      return
    }
  }
  clearTimeout(hardStop)
  app.exit(failed ? 1 : 0)
}

app.whenReady().then(async () => {
  // Smoke runs can pin the theme so both themes can be checked: RIVER_SMOKE_THEME=light|dark.
  const smokeTheme = process.env["RIVER_SMOKE_THEME"]
  if (isSmoke && (smokeTheme === "light" || smokeTheme === "dark")) nativeTheme.themeSource = smokeTheme
  protocol.handle("river-file", (request) => {
    const abs = resolveRiverFile(request.url)
    if (!abs) return new Response("Not found", { status: 404 })
    return net.fetch(pathToFileURL(abs).toString())
  })
  registerIpc(() => win, isSmoke && process.env["RIVER_SMOKE_JOB"] === "1" ? { jobDeps: smokeJobDeps } : {})

  const initial = isSmoke ? process.env["RIVER_PROJECT"] : (argProject() ?? process.env["RIVER_PROJECT"] ?? getLastProject())
  if (initial) await openProject(resolve(initial), !isSmoke)

  win = createWindow()
  win.on("closed", () => {
    win = null
  })
  if (smokeDir) void runSmoke(win, resolve(smokeDir))

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) win = createWindow()
  })
})

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit()
})
