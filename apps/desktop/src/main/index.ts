import { access, mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { BrowserWindow, app, ipcMain, nativeTheme, net, protocol } from "electron"
import type { JobDeps } from "@river/agent"
import { VIEWS, type ViewId } from "../shared/api"
import { type Card, type Mark, loadBoard, loadJob } from "@river/core"
import { type BoardEntity, onBoardWritten } from "./board"
import { currentProject, onStoryWritten, openProject, registerIpc, resolveRiverFile } from "./ipc"
import { getLastProject } from "./settings"

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
  const query = isSmoke ? { smoke: "1" } : undefined
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

async function runSmoke(w: BrowserWindow, dir: string): Promise<void> {
  const limit = process.env["RIVER_SMOKE_JOB"] === "1" ? 300_000 : 120_000
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
