import { mkdirSync } from "node:fs"
import { access, mkdir, readFile, readdir, rename, rm, symlink, writeFile } from "node:fs/promises"
import { basename, dirname, join, resolve } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { BrowserWindow, ClipboardItem, app, clipboard, ipcMain, nativeTheme, net, protocol } from "electron"
import { type JobDeps, readJobScripts } from "@river/agent"
import { VIEWS, type ViewId } from "../shared/api"
import { type Card, type Job, type Mark, CONCEPT_ROLE, boardJsonText, claimMark, loadBoard, loadCard, loadJob, loadMark, markFile, replyToMark, saveCard, saveEdge, saveJob, saveMark } from "@river/core"
import { type BoardEntity, onBoardWritten } from "./board"
import { currentProject, onStoryWritten, openProject, registerIpc, stopAgentWork } from "./ipc"
import { riverFilePath } from "./riverFile"
import { getLastProject } from "./settings"
import { noteOwnWrite } from "./watch"
import { STILL_SHOT, STRIP_FRAMES, STRIP_SHOT, scenePng, seedPerfBoard, seedRichBoard, seedStripCapture } from "./smokeBoard"

const here = dirname(fileURLToPath(import.meta.url))
const smokeDir = process.env["RIVER_SMOKE_DIR"]
const isSmoke = Boolean(smokeDir)
// Smoke runs that write settings (canvas theme, last board) keep them out of the user's own app data.
const smokeUserData = isSmoke ? process.env["RIVER_SMOKE_USERDATA"] : undefined
if (smokeUserData) {
  mkdirSync(resolve(smokeUserData), { recursive: true })
  app.setPath("userData", resolve(smokeUserData))
}

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
  // River is one page: no link or script may take the window elsewhere or open another one.
  w.webContents.on("will-navigate", (e) => {
    if (e.url !== w.webContents.getURL()) e.preventDefault()
  })
  w.webContents.setWindowOpenHandler(() => ({ action: "deny" }))
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
  const outsideEdge = { id: "e_outside1", from: outsideId, to: moved, madeBy: "concept-artist", createdAt: new Date().toISOString() }
  await writeFile(join(boardDir, "edges", ".e_outside1.json.tmp"), JSON.stringify(outsideEdge, null, 2))
  await rename(join(boardDir, "edges", ".e_outside1.json.tmp"), join(boardDir, "edges", "e_outside1.json"))
  const liveEdge = await waitRect(w, `[data-testid="rf__edge-e_outside1"]`, 5_000)
  console.log(`river smoke: outside connector ${liveEdge ? "appeared on the canvas" : "did NOT appear"}`)

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
    live !== null &&
    liveEdge !== null
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

/** What the fake look at the renders says, once the smoke lets it answer. */
const LOOK_NOTE = "Looked at the renders: A keeps the low horizon, C warms the sky, B did not render."
let releaseLook: (() => void) | null = null

/**
 * RIVER_SMOKE_JOB: the agent turn writes three options instead of calling a model; option B does not compile, so its
 * render fails. The look at the renders waits until the smoke releases it (or it is stopped), then answers in JSON.
 */
const smokeJobDeps: JobDeps = {
  runTurn: async (req, h) => {
    if (req.prompt.includes("River rendered your scripts.")) {
      await new Promise<void>((done) => {
        releaseLook = done
        h.signal?.addEventListener("abort", () => done())
        setTimeout(done, 90_000)
      })
      releaseLook = null
      if (h.signal?.aborted) return
      h.onEvent({ type: "text", text: JSON.stringify({ note: LOOK_NOTE, captions: { a: "Low horizon, checked", c: "Warmer sky, checked" } }) })
      return
    }
    const dir = join(req.root, "concepts", req.conceptId ?? "missing")
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, "draw_a.gd"), SMOKE_DRAW_GD)
    await writeFile(join(dir, "caption_a.txt"), "Low horizon, soft sky")
    await writeFile(join(dir, "draw_b.gd"), SMOKE_DRAW_GD.replace("img.fill(", "img.no_such_method("))
    await writeFile(join(dir, "caption_b.txt"), "Same pond, broken script")
    await writeFile(join(dir, "draw_c.gd"), SMOKE_DRAW_GD.replace("Color(0.62, 0.74, 0.80)", "Color(0.86, 0.66, 0.52)"))
    await writeFile(join(dir, "caption_c.txt"), "Warmer sky")
    h.onEvent({ type: "text", text: "Calmer: a low horizon, soft sky, one still pond. B tries a different call." })
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
 * RIVER_SMOKE_JOB=1: pin a passage and put two pin marks with requests beside it (IPC), then with real clicks:
 * open the first mark, ask the concept artist, show its answer, review both options' scripts and run them all,
 * see options A and C render and option B show Godot's error, keep C only (it closes up to the row start); dismiss the second mark's answer with a reason
 * (it lands in the project brief); then reply on the first mark and revise its answer. The agent turn is the fake
 * from smokeJobDeps; the renders are real Godot. Screenshots the review, the answer and the kept option.
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
  // The second mark's answer lands left of the passage, clear of the first one's.
  const toDismiss = await saveMark({ ...markReq, path: [card.x - 330, card.y + 40], thread: [{ by: "you", at: new Date().toISOString(), text: "try it at dusk" }] })
  console.log(`river smoke: pinned ${card.ref} as ${card.id}; marks ${mark.id} (keep) and ${toDismiss.id} (dismiss)`)
  w.webContents.send("smoke:navigate", "canvas")
  if (!(await waitFor("canvas", 15_000))) console.warn("river smoke: canvas did not report ready")
  w.focus()
  w.webContents.focus()
  await sleep(300)

  /** The answer's cards on disk, once the job has written them: its note and its options by variant. */
  const answer = async (markId: string, ms: number) => {
    let found: { note: Card; options: Card[] } | undefined
    await until(async () => {
      const cards = (await loadBoard(p.root, "main")).cards.filter((c) => c.pending?.markId === markId)
      const note = cards.find((c) => c.kind === "note")
      const options = cards.filter((c) => c.kind === "concept")
      found = note && options.length > 0 ? { note, options } : undefined
      return found !== undefined
    }, ms)
    return found
  }
  const askAndShow = async (markId: string) => {
    if (!(await clickEl(w, `[data-mark="${markId}"] .mark-pin`, 8_000))) return undefined
    if (!(await clickEl(w, `[data-action="ask-concept"]`, 3_000))) return undefined
    const cards = await answer(markId, 60_000)
    // Agents place their answer beside the mark, maybe off screen: the mark panel brings it into view.
    if (!cards || !(await clickEl(w, `[data-action="show-answer"]`, 10_000))) return undefined
    await sleep(500)
    return cards
  }

  const kept = await askAndShow(mark.id)
  if (!kept) return false
  const jobId = kept.note.pending!.jobId
  const noteSel = `.react-flow__node[data-id="${kept.note.id}"]`
  console.log(`river smoke: asked the concept artist; job ${jobId}`)
  if (!(await clickEl(w, `${noteSel} [data-action="review"]`, 120_000))) return false
  const sections = await until(async () => (await w.webContents.executeJavaScript(`document.querySelectorAll(".review .review-script").length`)) === 3, 5_000)
  console.log(`river smoke: review shows ${sections ? "all three" : "NOT all three"} scripts`)
  // Option B calls img.no_such_method(, outside the Image API, so the review highlights that line and no other.
  const highlighted = (await w.webContents.executeJavaScript(
    `[...document.querySelectorAll(".review .review-script .concept-script-text .read-line")].map((m) => m.closest(".review-script").dataset.variant + ":" + m.dataset.line).join(" ")`,
  )) as string
  console.log(`river smoke: the review highlights ${highlighted === "b:6" ? "option B's unknown call" : `"${highlighted}", not just option B's unknown call`}`)
  // Each script line is its own row, numbered 1 to n in the gutter, matching the bytes the job holds.
  const shownScripts = (await readJobScripts(p.root, jobId)).map((s) => s.text.split("\n").length).join(",")
  const numbered = (await w.webContents.executeJavaScript(
    `[...document.querySelectorAll(".review .review-script")].map((s) => { const n = [...s.querySelectorAll(".script-row .script-ln")].map((l) => Number(l.textContent)); return n.every((v, i) => v === i + 1) ? n.length : -1 }).join(",")`,
  )) as string
  console.log(`river smoke: the review numbers ${numbered === shownScripts ? "every line of each script" : `rows ${numbered}, not lines ${shownScripts}`}`)
  await shoot(w, dir, "job-review.png")
  const kitShown =
    (await clickEl(w, `.review [data-action="view-kit"]`, 3_000)) &&
    (await until(async () => ((await w.webContents.executeJavaScript(`document.querySelector(".text-panel-body")?.textContent ?? ""`)) as string).includes("class_name Kit"), 5_000))
  await clickEl(w, `.text-panel [data-action="close-text"]`, 2_000)
  console.log(`river smoke: the review's Kit link ${kitShown ? "shows River's kit.gd" : "does NOT show the kit"}`)
  const firstNote = (await loadJob(p.root, jobId)).summary
  if (!(await clickEl(w, `.review [data-action="run"]`, 3_000))) return false
  console.log("river smoke: ran all; rendering")
  // While drawing, the answer holds one placeholder card; each option has its own card from approval on.
  const options = (await answer(mark.id, 5_000))?.options ?? []
  console.log(`river smoke: the answer has option cards ${options.map((c) => c.variant ?? "-").join(", ")}`)
  // The options run off to the right of the note; fit the board so all of them are on screen.
  await key(w, "1", ["shift"])
  await sleep(500)
  const looking = Boolean(await waitRect(w, `${noteSel} .job-line.is-looking`, 120_000))
  if (looking) await shoot(w, dir, "job-looking.png")
  releaseLook?.()
  const looked = await until(async () => (await loadJob(p.root, jobId)).summary === LOOK_NOTE && (await loadCard(p.root, "main", kept.note.id))?.text === LOOK_NOTE, 20_000)
  console.log(`river smoke: the answer ${looking ? "showed" : "did NOT show"} "looking at the renders"; the look ${looked ? "rewrote the note" : "did NOT rewrite the note"} (first note ${JSON.stringify(firstNote)})`)
  const optSel = (v: string) => `.react-flow__node[data-id="${options.find((c) => c.variant === v)?.id}"]`
  const rendered = (await waitImage(w, `${optSel("a")} img.cnode-img`, 120_000)) && (await waitImage(w, `${optSel("c")} img.cnode-img`, 10_000))
  const brokenShown = Boolean(await waitRect(w, `${optSel("b")} .render-error`, 10_000))
  console.log(`river smoke: options A and C ${rendered ? "rendered" : "did NOT render"}; option B ${brokenShown ? "shows its render error" : "does NOT show an error"}`)
  await sleep(500)
  await shoot(w, dir, "job-answered.png")
  if (!(await clickEl(w, `${optSel("c")} [data-action="keep"]`, 5_000))) return false
  const optionC = options.find((c) => c.variant === "c")!
  if (!(await waitImage(w, `.react-flow__node[data-id="${optionC.id}"] .cnode-concept:not(.is-pending) img.cnode-img`, 30_000))) {
    console.error("river smoke: the kept option did not show its image")
    return false
  }
  await sleep(500)
  await shoot(w, dir, "job-accepted.png")
  const job = await loadJob(p.root, jobId)
  const conceptDir = join(p.root, "concepts", job.conceptId)
  const files = {
    "draw_c.gd": await exists(join(conceptDir, "draw_c.gd")),
    "concept_c.png": await exists(join(conceptDir, "concept_c.png")),
    "draw_a.gd (not kept)": await exists(join(conceptDir, "draw_a.gd")),
  }
  const rowStart = Math.min(...options.map((c) => c.x))
  const closed = await until(async () => (await loadCard(p.root, "main", optionC.id))?.x === rowStart, 5_000)
  const markNow = (await loadBoard(p.root, "main")).marks.find((m) => m.id === mark.id)
  console.log(`river smoke: concepts/${job.conceptId}/ ${JSON.stringify(files)}; job ${job.status}; mark ${markNow?.status}; kept card ${closed ? "moved to the row start" : "did NOT close the gap"}`)
  const keptOk = highlighted === "b:6" && numbered === shownScripts && kitShown && looking && looked && sections && rendered && brokenShown && files["draw_c.gd"] && files["concept_c.png"] && !files["draw_a.gd (not kept)"] && job.status === "accepted" && closed

  await key(w, "Escape")
  await key(w, "1", ["shift"])
  await sleep(500)
  const gone = await askAndShow(toDismiss.id)
  if (!gone) return false
  const goneJob = gone.note.pending!.jobId
  const goneSel = `.react-flow__node[data-id="${gone.note.id}"]`
  if (!(await clickEl(w, `${goneSel} [data-action="review"]`, 120_000))) return false
  const goneFirst = (await loadJob(p.root, goneJob)).summary
  await until(async () => (await w.webContents.executeJavaScript(`document.querySelectorAll(".review .review-script").length`)) === 3, 5_000)
  if (!(await clickEl(w, `.review [data-action="run"]`, 5_000))) return false
  const lookShown = Boolean(await waitRect(w, `${goneSel} .job-line.is-looking`, 120_000))
  const stopClicked = lookShown && (await clickEl(w, `${goneSel} [data-action="stop-look"]`, 3_000))
  const stopped = stopClicked && (await until(async () => (await loadJob(p.root, goneJob)).status === "answered", 15_000))
  const kept1st = (await loadJob(p.root, goneJob)).summary === goneFirst
  console.log(`river smoke: Stop looking ${stopped ? "answered at once" : "did NOT answer"}; the note ${kept1st ? "stayed as first written" : "changed"}`)
  const goneOption = (await answer(toDismiss.id, 5_000))?.options[0]
  if (!goneOption || !(await clickEl(w, `.react-flow__node[data-id="${goneOption.id}"] .cnode-frame`, 3_000))) return false
  // Delete on one option of a live answer asks to dismiss the whole answer instead of deleting the card.
  await key(w, "Delete")
  if (!(await clickEl(w, ".ref-form input", 3_000))) return false
  await typeText(w, "too dark for a calm walk")
  if (!(await clickEl(w, `[data-action="dismiss-confirm"]`, 3_000))) return false
  const dismissed = await until(async () => {
    const b = await loadBoard(p.root, "main")
    return (await loadJob(p.root, goneJob)).status === "dismissed" && !b.cards.some((c) => c.pending?.jobId === goneJob) && !b.edges.some((e) => e.id.includes(goneJob.slice(2)))
  }, 10_000)
  const brief = await readFile(join(p.root, ".river", "brief.md"), "utf8").catch(() => "")
  const reasoned = brief.includes("too dark for a calm walk")
  console.log(`river smoke: dismiss leg: job ${goneJob} ${dismissed ? "dismissed, cards and connectors gone" : "NOT dismissed"}; reason ${reasoned ? "is" : "is NOT"} in .river/brief.md`)

  await key(w, "Escape")
  await key(w, "1", ["shift"])
  await sleep(500)
  if (!(await clickEl(w, `[data-mark="${mark.id}"] .mark-pin`, 5_000))) return false
  if (!(await clickEl(w, ".mark-reply textarea", 3_000))) return false
  await typeText(w, "warmer light please")
  if (!(await clickEl(w, `.mark-reply [data-action="reply"]`, 3_000))) return false
  const replied = await until(async () => (await loadBoard(p.root, "main")).marks.find((m) => m.id === mark.id)?.thread.some((t) => t.by === "you" && t.text === "warmer light please") ?? false, 4_000)
  if (!(await clickEl(w, `.mark-panel [data-action="revise"]`, 5_000))) return false
  const revised = await until(async () => {
    const m = (await loadBoard(p.root, "main")).marks.find((x) => x.id === mark.id)
    return Boolean(m?.jobId && m.jobId !== jobId && (await loadJob(p.root, m.jobId)).parentJobId === jobId)
  }, 15_000)
  console.log(`river smoke: reply ${replied ? "saved in the thread" : "NOT saved"}; revise ${revised ? "started a job revising " + jobId : "did NOT start"}`)

  // Dismissing the revision while the agent looks at its renders: the look ends and the job stays dismissed.
  const revJob = (await loadBoard(p.root, "main")).marks.find((x) => x.id === mark.id)?.jobId ?? ""
  await key(w, "Escape")
  let revNote: Card | undefined
  await until(async () => {
    revNote = (await loadBoard(p.root, "main")).cards.find((c) => c.pending?.jobId === revJob && c.kind === "note")
    return revNote !== undefined
  }, 60_000)
  const revSel = `.react-flow__node[data-id="${revNote?.id}"]`
  await key(w, "1", ["shift"])
  await sleep(500)
  let lateDismiss = false
  if (revNote && (await clickEl(w, `${revSel} [data-action="review"]`, 120_000))) {
    await until(async () => (await w.webContents.executeJavaScript(`document.querySelectorAll(".review .review-script").length`)) === 3, 5_000)
    await clickEl(w, `.review [data-action="run"]`, 5_000)
    const lookOn = Boolean(await waitRect(w, `${revSel} .job-line.is-looking`, 120_000))
    const asked = lookOn && (await clickEl(w, `${revSel} [data-action="dismiss"]`, 3_000)) && (await clickEl(w, `[data-action="dismiss-confirm"]`, 3_000))
    const gone = asked && (await until(async () => (await loadJob(p.root, revJob)).status === "dismissed", 15_000))
    await sleep(2_000)
    const b = await loadBoard(p.root, "main")
    lateDismiss = gone && (await loadJob(p.root, revJob)).status === "dismissed" && !b.cards.some((c) => c.pending?.jobId === revJob)
    console.log(`river smoke: dismissing ${revJob} while the agent looked ${lateDismiss ? "ended the look; the job stayed dismissed and its cards are gone" : `did NOT hold (look shown ${lookOn}, dismissed ${gone})`}`)
  } else console.error("river smoke: the revision did not reach review")

  const ok = keptOk && stopped && kept1st && dismissed && reasoned && replied && revised && lateDismiss
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

  await clickEl(w, `[data-tool="arrow"]`, 3_000)
  const from = await centerOf(w, node("shadows", ".cnode-frame"))
  const to = await centerOf(w, node("passage"))
  const edgeSaved = waitBoardWrite("edge", (e) => e.from === id("shadows") && e.to === id("passage"), 6_000)
  if (from && to) await drag(w, from, to, 18)
  const drawn = await edgeSaved
  check("arrow tool draws a connector between two cards", drawn !== null && (await until(async () => Boolean(await rectOf(w, `[data-testid="rf__edge-${drawn.id}"]`)), 3_000)))
  await key(w, "V")

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

  await key(w, "Escape")
  const png = scenePng(4242, 640, 400)
  // The clipboard belongs to the OS, and another program can hold it: check the image really landed.
  await clipboard.write([new ClipboardItem({ "image/png": new Blob([new Uint8Array(png)], { type: "image/png" }) })])
  const onClipboard = (await clipboard.read()).some((item) => item.types.includes("image/png"))
  const pane = await rectOf(w, ".react-flow__pane")
  if (pane) w.webContents.sendInputEvent({ type: "mouseMove", x: Math.round(pane.x + pane.w * 0.62), y: Math.round(pane.y + pane.h * 0.18) })
  await sleep(100)
  if (onClipboard) await key(w, "V", ["control"])
  else {
    // Without the OS clipboard, a paste event carrying the image as a File goes through the same handler.
    console.warn("river smoke: the OS clipboard did not take the image; pasting with a synthetic paste event")
    await w.webContents.executeJavaScript(`(() => {
      const bytes = Uint8Array.from(atob(${JSON.stringify(png.toString("base64"))}), (c) => c.charCodeAt(0))
      const dt = new DataTransfer()
      dt.items.add(new File([bytes], "image.png", { type: "image/png" }))
      window.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }))
    })()`)
  }
  const form = await waitRect(w, ".ref-form", 4_000)
  const licence = form ? ((await w.webContents.executeJavaScript(`[...document.querySelectorAll(".ref-form input")].pop()?.value ?? null`)) as string | null) : null
  const pasted = waitBoardWrite("card", (c) => c.kind === "ref" && !Object.values(ids).includes(c.id), 6_000)
  await key(w, "Return")
  const pastedCard = await pasted
  check(`paste opens the licence form with "own work" (got ${JSON.stringify(licence)}) and adds the image`, licence === "own work" && pastedCard?.source?.licence === "own work" && (await exists(join(p.root, pastedCard.ref))))

  // An OS drag cannot be scripted: a drop event with a DataTransfer of File objects goes through the same handler.
  const dropOn = (name: string, type: string) =>
    w.webContents.executeJavaScript(`(async () => {
      const bytes = ${JSON.stringify(name)}.endsWith(".png") ? Uint8Array.from(atob(${JSON.stringify(scenePng(5, 96, 60).toString("base64"))}), (c) => c.charCodeAt(0)) : new TextEncoder().encode("notes")
      const dt = new DataTransfer()
      dt.items.add(new File([bytes], ${JSON.stringify(name)}, { type: ${JSON.stringify(type)} }))
      const wrap = document.querySelector(".canvas-wrap")
      const r = wrap.getBoundingClientRect()
      const at = { bubbles: true, cancelable: true, dataTransfer: dt, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2 }
      wrap.dispatchEvent(new DragEvent("dragover", at))
      const drop = new DragEvent("drop", at)
      wrap.dispatchEvent(drop)
      return drop.defaultPrevented
    })()`) as Promise<boolean>
  const textPrevented = await dropOn("notes.txt", "text/plain")
  const refused = Boolean(await waitRect(w, ".banner-err", 2_000)) && !(await rectOf(w, ".ref-form"))
  await w.webContents.executeJavaScript(`document.querySelector(".banner-err")?.click()`)
  const imagePrevented = await dropOn("dropped.png", "image/png")
  const dropForm = await waitRect(w, ".ref-form", 4_000)
  const dropLicence = dropForm ? ((await w.webContents.executeJavaScript(`[...document.querySelectorAll(".ref-form input")].pop()?.value ?? null`)) as string | null) : null
  if (dropForm) await clickEl(w, ".ref-form .dialog-foot .btn:not(.btn-primary)", 2_000)
  check(`a dropped image opens the licence form with "own work" and a dropped text file is refused (synthetic drop events)`, textPrevented && refused && imagePrevented && dropLicence === "own work")

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

  await clickEl(w, node("optD", ".cnode-frame"), 3_000)
  const dup = waitBoardWrite("card", (c) => c.kind === "concept" && c.variant === "d" && c.id !== id("optD"), 5_000)
  await key(w, "D", ["control"])
  const copy = await dup
  await key(w, "Z", ["control"])
  check("Ctrl+D duplicates the card and Ctrl+Z removes the copy", copy !== null && (await until(async () => (await loadCard(p.root, "main", copy.id)) === undefined, 4_000)))

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

  await key(w, "Escape")
  const research0 = await card("research")
  const optA0 = await card("optA")
  await clickEl(w, node("research", ".note-text"), 3_000)
  const optA = await centerOf(w, node("optA", ".cnode-frame"))
  if (optA) {
    // React Flow reads the multi-select key from key events, so Shift is held as a key around the click.
    w.webContents.sendInputEvent({ type: "keyDown", keyCode: "Shift", modifiers: ["shift"] })
    await sleep(50)
    w.webContents.sendInputEvent({ type: "mouseMove", x: Math.round(optA[0]), y: Math.round(optA[1]), modifiers: ["shift"] })
    w.webContents.sendInputEvent({ type: "mouseDown", x: Math.round(optA[0]), y: Math.round(optA[1]), button: "left", clickCount: 1, modifiers: ["shift"] })
    await sleep(30)
    w.webContents.sendInputEvent({ type: "mouseUp", x: Math.round(optA[0]), y: Math.round(optA[1]), button: "left", clickCount: 1, modifiers: ["shift"] })
    await sleep(50)
    w.webContents.sendInputEvent({ type: "keyUp", keyCode: "Shift" })
    await sleep(200)
  }
  const both = (await w.webContents.executeJavaScript(`document.querySelectorAll(".react-flow__node.selected").length`)) as number
  const rowSaved = waitBoardWrite("card", (c) => c.id === id("optA"), 4_000)
  await clickEl(w, `[data-action="row"]`, 2_000)
  const lined = await rowSaved
  check(`shift-click adds to the selection (${both} selected) and "Arrange in a row" top-aligns them`, both === 2 && lined !== null && research0 !== undefined && lined.y === research0.y && lined.x > research0.x)
  await key(w, "Z", ["control"])
  await until(async () => (await card("optA"))?.y === optA0?.y, 3_000)

  await key(w, "Escape")
  await clickEl(w, `[data-tool="note"]`, 2_000)
  const placing = waitBoardWrite("card", (c) => c.kind === "note" && c.text === "" && !Object.values(ids).includes(c.id), 4_000)
  if (pane) await click(w, pane.x + pane.w * 0.55, pane.y + pane.h * 0.62)
  const placed = await placing
  const input = await waitRect(w, ".note-input", 2_000)
  const focus = (await w.webContents.executeJavaScript(`(document.activeElement?.tagName ?? "") + "." + (document.activeElement?.className ?? "")`)) as string
  await typeText(w, "warmer lamps")
  const typed = waitBoardWrite("card", (c) => c.id === placed?.id && c.text === "warmer lamps", 4_000)
  await key(w, "Escape")
  const noted = await typed
  await key(w, "Z", ["control"])
  const unTyped = placed ? await until(async () => (await loadCard(p.root, "main", placed.id))?.text === "", 3_000) : false
  const onDisk = placed ? (await loadCard(p.root, "main", placed.id))?.text : undefined
  check(`a new note takes typing inline, saves on Escape, and Ctrl+Z takes the text back (input ${input ? "shown" : "missing"}, focus "${focus}", saved ${JSON.stringify(noted?.text ?? null)}, after undo ${JSON.stringify(onDisk ?? null)})`, noted !== null && unTyped)

  const draftNote = waitBoardWrite("card", (c) => c.kind === "note" && c.text === "" && !Object.values(ids).includes(c.id), 4_000)
  await clickEl(w, `[data-tool="note"]`, 2_000)
  if (pane) await click(w, pane.x + pane.w * 0.3, pane.y + pane.h * 0.62)
  const draft = await draftNote
  await waitRect(w, ".note-input", 2_000)
  await typeText(w, "kept on leaving")
  await w.webContents.executeJavaScript(`[...document.querySelectorAll(".nav-item")].find((b) => b.textContent.includes("Story map"))?.setAttribute("data-smoke", "story-map")`)
  await clickEl(w, `.nav-item[data-smoke="story-map"]`, 2_000)
  const flushed = draft ? await until(async () => (await loadCard(p.root, "main", draft.id))?.text === "kept on leaving", 4_000) : false
  await w.webContents.executeJavaScript(`[...document.querySelectorAll(".nav-item")].find((b) => b.textContent.includes("Canvas"))?.setAttribute("data-smoke", "canvas")`)
  await clickEl(w, `.nav-item[data-smoke="canvas"]`, 3_000)
  await waitRect(w, `.react-flow__node[data-id="${id("optA")}"]`, 8_000)
  await sleep(600)
  check("text typed into a note is saved when the canvas closes mid-edit (switching to the story map)", flushed)

  await key(w, "Escape")
  await clickEl(w, ".board-pill", 2_000)
  await clickEl(w, ".board-new input", 2_000)
  await typeText(w, "second")
  await key(w, "Return")
  const second = await waitRect(w, `.board-pill[data-board="second"]`, 5_000)
  const secondEmpty = second ? await until(async () => (await w.webContents.executeJavaScript(`document.querySelectorAll(".react-flow__node").length`)) === 0, 3_000) : false
  await clickEl(w, ".board-pill", 2_000)
  const menu = (await w.webContents.executeJavaScript(`[...document.querySelectorAll(".board-menu-item")].map((b) => b.textContent.replace("✓", "").trim()).join()`)) as string
  await w.webContents.executeJavaScript(`[...document.querySelectorAll(".board-menu-item")].find((b) => b.textContent.trim() === "main")?.setAttribute("data-smoke", "main")`)
  await clickEl(w, `.board-menu-item[data-smoke="main"]`, 2_000)
  const back = await waitRect(w, `.board-pill[data-board="main"]`, 5_000)
  check(`the board pill creates "second" (empty, listed as ${menu}) and switches back to main`, second !== null && secondEmpty && menu === "main,second" && back !== null && (await exists(join(p.root, ".river", "boards", "second", "board.json"))))
  if (!(await waitFor("canvas", 8_000))) console.warn("river smoke: canvas not ready after switching back")
  await sleep(600)

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

  const page = w.webContents.getURL()
  const popupRefused = await w.webContents.executeJavaScript(`window.open("https://example.invalid/") === null`)
  await w.webContents.executeJavaScript(`location.href = "https://example.invalid/"; true`)
  await sleep(1_000)
  check("the window stays on River's page: navigating away and window.open are refused", popupRefused === true && w.webContents.getURL() === page && BrowserWindow.getAllWindows().length === 1)
  const outside = join(dirname(p.root), `${basename(p.root)}-outside`)
  await mkdir(outside, { recursive: true })
  await writeFile(join(outside, "secret.txt"), "secret")
  await symlink(outside, join(p.root, "linked"), "junction")
  const served = (await net.fetch("river-file://project/river.json")).status
  const linked = (await net.fetch("river-file://project/linked/secret.txt")).status
  await rm(join(p.root, "linked"))
  await rm(outside, { recursive: true, force: true })
  check(`river-file:// serves project files (${served}) and nothing through a link out of the project (${linked})`, served === 200 && linked === 404)

  const ok = results.every(([, r]) => r)
  console.log(`river smoke: board checks ${ok ? "PASSED" : "FAILED"} (${results.filter(([, r]) => r).length}/${results.length})`)
  return ok
}

/** A drag like `drag`, running `beforeUp` while the button is still down. */
async function dragAround(w: BrowserWindow, from: [number, number], to: [number, number], beforeUp: () => Promise<void>): Promise<void> {
  const [x0, y0, x1, y1] = [...from, ...to].map(Math.round) as [number, number, number, number]
  w.webContents.sendInputEvent({ type: "mouseMove", x: x0, y: y0 })
  await sleep(30)
  w.webContents.sendInputEvent({ type: "mouseDown", x: x0, y: y0, button: "left", clickCount: 1 })
  for (let i = 1; i <= 14; i++) {
    await sleep(16)
    w.webContents.sendInputEvent({ type: "mouseMove", x: Math.round(x0 + ((x1 - x0) * i) / 14), y: Math.round(y0 + ((y1 - y0) * i) / 14), button: "left", modifiers: ["leftbuttondown"] })
  }
  await beforeUp()
  await sleep(30)
  w.webContents.sendInputEvent({ type: "mouseUp", x: x1, y: y1, button: "left", clickCount: 1 })
}

/**
 * RIVER_SMOKE_AGENTS=1: what the canvas shows of agents working outside the app, driven with real input.
 * claude-code claims a mark (badge on the mark, a line in its panel); it replies while the user is dragging that mark,
 * and the reply must survive the move; the user dismisses one mark with a reason and resolves another from the panel;
 * a job started outside the app (as concept_request does) appears, fails, and its log opens from the card. With
 * RIVER_SMOKE_USERDATA set, the self-check setting is switched off and on in Settings.
 */
async function smokeAgents(w: BrowserWindow, dir: string, waitFor: (view: ViewId, ms: number) => Promise<boolean>): Promise<boolean> {
  const p = currentProject()
  if (!p) return false
  const root = p.root
  const results: [string, boolean][] = []
  const check = (name: string, ok: boolean) => {
    results.push([name, ok])
    console.log(`river smoke: ${ok ? "ok" : "FAILED"} ${name}`)
  }
  const card = (
    (await w.webContents.executeJavaScript(`(async () => {
      const info = await window.river.getProject()
      const rel = info.stories[0]
      const story = await window.river.loadStory(rel)
      return window.river.boardPin("main", { kind: "passage", ref: rel + "#" + story.passages[0].id })
    })()`)) as { card: Card }
  ).card
  const pinMark = async (dy: number, text: string) =>
    (
      (await w.webContents.executeJavaScript(
        `window.river.boardSaveMark("main", ${JSON.stringify({ shape: "pin", path: [card.x + card.w + 60, card.y + dy], anchors: [card.id], thread: [{ by: "you", at: new Date().toISOString(), text }], madeBy: "you" })})`,
      )) as { mark: Mark }
    ).mark
  const claimed = await pinMark(40, "make the gate older")
  const toDismiss = await pinMark(150, "add a lamp by the gate")
  const toResolve = await pinMark(260, "less fog")
  w.webContents.send("smoke:navigate", "canvas")
  if (!(await waitFor("canvas", 15_000))) console.warn("river smoke: canvas did not report ready")
  w.focus()
  w.webContents.focus()
  await sleep(400)
  const pinSel = (m: Mark) => `[data-mark="${m.id}"] .mark-pin`
  const text = async (sel: string) => (await w.webContents.executeJavaScript(`document.querySelector(${JSON.stringify(sel)})?.textContent ?? null`)) as string | null

  await claimMark(root, "main", claimed.id, "claude-code")
  await replyToMark(root, "main", claimed.id, "claude-code", "On it: weathered stone, ivy, a rusted latch.")
  const badge = await waitRect(w, `[data-mark="${claimed.id}"] .mark-claim-badge`, 6_000)
  await clickEl(w, pinSel(claimed), 3_000)
  const line = (await waitRect(w, ".mark-panel .mark-claim", 3_000)) ? await text(".mark-panel .mark-claim") : null
  const noAsk = !(await rectOf(w, `[data-action="ask-concept"]`))
  await sleep(300)
  await shoot(w, dir, "mark-claimed.png")
  check(`a mark claude-code claimed shows a badge (${JSON.stringify(badge ? await text(`[data-mark="${claimed.id}"] .mark-claim-badge`) : null)}) and its panel says ${JSON.stringify(line)}`, badge !== null && line === "✦ claude-code is working on this" && noAsk)
  await key(w, "Escape")

  // The reply lands on disk while the pointer is down; the watcher is told it is River's own write, so the canvas
  // still holds the mark without it when the move is saved. Only a locked merge keeps the reply.
  const before = (await loadMark(root, "main", claimed.id))!
  const grab = await centerOf(w, pinSel(claimed), 3_000)
  const reply = "Two options coming: ivy, and bare stone."
  const movedSaved = waitBoardWrite("mark", (m) => m.id === claimed.id && m.path[0] !== before.path[0], 8_000)
  if (grab) {
    await dragAround(w, grab, [grab[0] + 90, grab[1] + 40], async () => {
      const m = await replyToMark(root, "main", claimed.id, "claude-code", reply)
      noteOwnWrite(markFile(root, "main", claimed.id), boardJsonText(m))
    })
  }
  const moved = await movedSaved
  const after = await loadMark(root, "main", claimed.id)
  const replies = after?.thread.map((t) => t.text) ?? []
  check(
    `moving the mark while claude-code replies keeps the reply and the claim (moved ${moved ? `${before.path[0]} to ${after?.path[0]}` : "NOT saved"}; thread ${JSON.stringify(replies)}; ${after?.status} by ${after?.claimedBy})`,
    moved !== null && after !== undefined && after.path[0] !== before.path[0] && replies.includes(reply) && after.status === "working" && after.claimedBy === "claude-code",
  )
  await key(w, "Escape")

  const why = "the lamp is already in shot 3"
  await clickEl(w, pinSel(toDismiss), 3_000)
  await clickEl(w, `[data-action="dismiss-mark"]`, 3_000)
  await clickEl(w, ".mark-dismiss input", 2_000)
  await typeText(w, why)
  await clickEl(w, `[data-action="dismiss-mark-confirm"]`, 2_000)
  const dismissed = await until(async () => {
    const m = await loadMark(root, "main", toDismiss.id)
    const last = m?.thread[m.thread.length - 1]
    return m?.status === "dismissed" && last?.by === "you" && last.text === why
  }, 5_000)
  await key(w, "Escape")
  const opacity = async () => Number(await w.webContents.executeJavaScript(`getComputedStyle(document.querySelector('[data-mark="${toDismiss.id}"]')).opacity`))
  const faded = await until(async () => (await opacity()) < 0.5, 3_000)
  check(`"Dismiss mark" with a reason closes the mark (reason in its thread) and the mark fades (opacity ${await opacity()})`, dismissed && faded)

  await clickEl(w, pinSel(toResolve), 3_000)
  await clickEl(w, `[data-action="resolve-mark"]`, 3_000)
  const resolved = await until(async () => (await loadMark(root, "main", toResolve.id))?.status === "accepted", 5_000)
  check(`"Mark resolved" accepts a mark that follows no job`, resolved)
  await key(w, "Escape")

  // A job as concept_request starts it: its own process writes the log, the job file and the answer's note card.
  const jobId = "j_smokeout1"
  const now = new Date().toISOString()
  const asked = await saveMark(root, "main", { shape: "pin", path: [card.x - 40, card.y + 40], anchors: [card.id], thread: [{ by: "claude-code", at: now, text: "the gate at dusk" }], madeBy: "claude-code", status: "working", jobId })
  const logText = [`river job start --job ${jobId}`, `concept job ${jobId}: running the agent turn`, `concept job ${jobId}: the agent turn ended without writing a script`, ""].join("\n")
  await mkdir(join(root, ".river", "logs"), { recursive: true })
  await writeFile(join(root, ".river", "logs", `${jobId}.log`), logText)
  const job: Job = {
    id: jobId,
    markId: asked.id,
    board: "main",
    role: CONCEPT_ROLE,
    model: "claude-sonnet-5-5",
    backend: "claude-code",
    status: "running",
    conceptId: jobId,
    baseSha: "0".repeat(40),
    branch: `river/job/${jobId}`,
    worktree: join(root, ".git", "river", "worktrees", jobId),
    projectSub: "",
    createdAt: now,
    updatedAt: now,
  }
  const jobsExisted = await exists(join(root, ".river", "jobs"))
  await saveJob(root, job)
  // Until the agent writes its scripts, a job's answer is one placeholder concept card that carries the job's bar.
  const placeholder = await saveCard(root, "main", { kind: "concept", ref: jobId, x: card.x - 340, y: card.y, w: 260, madeBy: CONCEPT_ROLE, pending: { markId: asked.id, jobId } })
  const cardSel = `.react-flow__node[data-id="${placeholder.id}"]`
  const drawing = Boolean(await waitRect(w, `${cardSel} .job-line.is-working`, 6_000))
  await saveJob(root, { ...job, status: "failed", error: "The agent turn ended without writing a script.", updatedAt: new Date().toISOString() })
  await key(w, "1", ["shift"])
  await sleep(500)
  const logLink = Boolean(await waitRect(w, `${cardSel} [data-action="view-log"]`, 8_000))
  await clickEl(w, `${cardSel} [data-action="view-log"]`, 3_000)
  const shown = await until(async () => ((await text(".text-panel-body")) ?? "").includes("ended without writing a script"), 4_000)
  await sleep(200)
  await shoot(w, dir, "job-log.png")
  await key(w, "Escape")
  const closed = await until(async () => !(await rectOf(w, ".text-panel")), 2_000)
  check(
    `a job started outside the app (.river/jobs ${jobsExisted ? "existed" : "did not exist"} at open) shows live (${drawing}), fails live (${logLink}), and "View log" opens .river/logs/${jobId}.log read-only (${shown}, closed ${closed})`,
    drawing && logLink && shown && closed,
  )

  if (process.env["RIVER_SMOKE_USERDATA"]) {
    await w.webContents.executeJavaScript(`[...document.querySelectorAll(".sidebar-foot .nav-item")].find((b) => b.textContent.includes("Settings"))?.setAttribute("data-smoke", "settings")`)
    await clickEl(w, `.nav-item[data-smoke="settings"]`, 3_000)
    const box = `[data-setting="self-check"]`
    const on0 = (await w.webContents.executeJavaScript(`document.querySelector(${JSON.stringify(box)})?.checked ?? null`)) as boolean | null
    await clickEl(w, box, 3_000)
    const off = await until(async () => (await savedSettings()).selfCheck === false, 3_000)
    await clickEl(w, box, 3_000)
    const on = await until(async () => (await savedSettings()).selfCheck === true, 3_000)
    await key(w, "Escape")
    check(`Settings turns the look at the renders off and on (was ${on0})`, on0 === true && off && on)
  } else console.log("river smoke: skipped the Settings check (it writes settings; set RIVER_SMOKE_USERDATA)")

  const ok = results.every(([, r]) => r)
  console.log(`river smoke: agents checks ${ok ? "PASSED" : "FAILED"} (${results.filter(([, r]) => r).length}/${results.length})`)
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
    const rec = { frames: [], movedFrames: [], long: [], moved: 0, run: true }
    window.__riverFrames = rec
    const vp = document.querySelector(".react-flow__viewport")
    let last = performance.now()
    let was = vp?.style.transform
    const tick = (t) => {
      rec.frames.push(t - last)
      last = t
      const now = vp?.style.transform
      if (now !== was) {
        rec.moved++
        rec.movedFrames.push(rec.frames[rec.frames.length - 1])
      }
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
    return { frames: rec.frames.slice(1), movedFrames: rec.movedFrames, long: rec.long, moved: rec.moved, nodes: document.querySelectorAll(".react-flow__node").length, edges: document.querySelectorAll(".react-flow__edge").length, imgs: document.querySelectorAll("img.cnode-img").length }
  })()`)) as { frames: number[]; movedFrames: number[]; long: number[]; moved: number; nodes: number; edges: number; imgs: number }
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
    fitPan: { zoom: +vpFit0.zoom.toFixed(3), framesMoved: fit.moved, frames: stats(fit.frames), movedFrames: stats(fit.movedFrames), over25ms: fit.frames.filter((f) => f > 25).length, longTasks: fit.long.length, longMax: Math.round(Math.max(0, ...fit.long)), dom: { nodes: fit.nodes, edges: fit.edges, imgs: fit.imgs } },
    pan100: { zoom: +vp100a.zoom.toFixed(3), framesMoved: at100.moved, frames: stats(at100.frames), movedFrames: stats(at100.movedFrames), over25ms: at100.frames.filter((f) => f > 25).length, longTasks: at100.long.length, longMax: Math.round(Math.max(0, ...at100.long)), dom: { nodes: at100.nodes, edges: at100.edges, imgs: at100.imgs } },
  }
  console.log(`river perf: ${JSON.stringify(report)}`)
  return ready && report.fitPan.framesMoved > 0 && report.pan100.framesMoved > 0
}

/**
 * The colour most of a row of screen pixels has, read from a capture of the window (what the user sees, not a style).
 * The row runs along the top edge of `selector`, right of centre (clear of the board pill and fitted cards), so a stray grid dot or card cannot decide it.
 */
async function bgOf(w: BrowserWindow, selector: string): Promise<string> {
  const r = await waitRect(w, selector, 3_000)
  if (!r) return "none"
  const img = await w.webContents.capturePage()
  const { width } = img.getSize()
  const k = width / ((await w.webContents.executeJavaScript("innerWidth")) as number)
  const bmp = img.toBitmap()
  const counts = new Map<string, number>()
  for (let i = 0; i < 15; i++) {
    const x = Math.round((r.x + r.w * (0.55 + i * 0.025)) * k)
    const y = Math.round((r.y + Math.min(14, r.h * 0.02)) * k)
    const o = (y * width + x) * 4
    const c = `rgb(${bmp[o + 2]}, ${bmp[o + 1]}, ${bmp[o]})`
    counts.set(c, (counts.get(c) ?? 0) + 1)
  }
  return [...counts].sort((a, b) => b[1] - a[1])[0]![0]
}

const PAPER_BG = "rgb(243, 241, 236)"
const DARK_BG = "rgb(27, 26, 24)"

async function savedSettings(): Promise<{ canvasTheme?: string; lastBoards?: Record<string, string>; selfCheck?: boolean }> {
  try {
    return JSON.parse(await readFile(join(app.getPath("userData"), "river-settings.json"), "utf8")) as { canvasTheme?: string }
  } catch {
    return {}
  }
}

async function dblClick(w: BrowserWindow, x: number, y: number): Promise<void> {
  const [cx, cy] = [Math.round(x), Math.round(y)]
  w.webContents.sendInputEvent({ type: "mouseMove", x: cx, y: cy })
  for (const clickCount of [1, 2]) {
    await sleep(40)
    w.webContents.sendInputEvent({ type: "mouseDown", x: cx, y: cy, button: "left", clickCount })
    await sleep(30)
    w.webContents.sendInputEvent({ type: "mouseUp", x: cx, y: cy, button: "left", clickCount })
  }
  await sleep(200)
}

async function openBoardMenu(w: BrowserWindow): Promise<boolean> {
  if (await rectOf(w, ".board-menu")) return true
  return (await clickEl(w, ".board-pill", 3_000)) && Boolean(await waitRect(w, ".board-menu", 2_000))
}

async function closeBoardMenu(w: BrowserWindow): Promise<void> {
  if (await rectOf(w, ".board-menu")) await clickEl(w, ".board-pill", 2_000)
}

/**
 * RIVER_SMOKE_PREMIUM=1|2, two launches sharing RIVER_SMOKE_USERDATA and the project copy (smoke-premium.sh).
 * Phase 1: a fresh board is paper beside the OS-dark shell and shows the three gestures; the board pill switches the
 * canvas to dark (saved in settings) and renames the board; in Frames, unticking frames 2, 4 and 6 and sending puts
 * three frame cards in a row joined by two connectors, and sending all six puts a second row below it.
 * Phase 2 (after a restart): the renamed board opens again, still dark; the pill switches back to paper; a caption is
 * edited by double-click and undone and redone; the lightbox steps to the next image with the arrow key; a scratch
 * board is made and deleted after its confirm, and the last board cannot be deleted.
 */
async function smokePremium(w: BrowserWindow, dir: string, phase: "1" | "2", waitFor: (view: ViewId, ms: number) => Promise<boolean>, forget: (view: ViewId) => void): Promise<boolean> {
  const p = currentProject()
  if (!p) return false
  const results: [string, boolean][] = []
  const check = (name: string, ok: boolean) => {
    results.push([name, ok])
    console.log(`river smoke: ${ok ? "ok" : "FAILED"} ${name}`)
  }
  const pill = async () => (await w.webContents.executeJavaScript(`document.querySelector(".board-pill")?.dataset.board ?? ""`)) as string
  const toCanvas = async () => {
    w.webContents.send("smoke:navigate", "canvas")
    if (!(await waitFor("canvas", 20_000))) console.warn("river smoke: canvas did not report ready")
    w.focus()
    w.webContents.focus()
    await imagesSettled(w, 8_000)
    await sleep(500)
  }
  const pickTheme = async (t: string) => {
    await openBoardMenu(w)
    await clickEl(w, `[data-theme-choice="${t}"]`, 2_000)
    await sleep(200)
    await closeBoardMenu(w)
  }

  if (phase === "1") {
    await toCanvas()
    const empty = Boolean(await waitRect(w, ".canvas-empty .empty-sheet", 3_000))
    const steps = (await w.webContents.executeJavaScript(`document.querySelectorAll(".empty-steps li").length`)) as number
    const canvasBg = await bgOf(w, ".canvas-wrap")
    const shellBg = await bgOf(w, ".sidebar")
    check(`a fresh board is paper (${canvasBg}) beside the dark shell (${shellBg}) and shows ${steps} gestures`, empty && steps === 3 && canvasBg === PAPER_BG && shellBg !== PAPER_BG)
    await shoot(w, dir, "empty-paper.png")

    await pickTheme("dark")
    const darkBg = await bgOf(w, ".canvas-wrap")
    check(`the board pill switches the canvas to dark (${darkBg}) and saves it`, darkBg === DARK_BG && (await savedSettings()).canvasTheme === "dark")
    await shoot(w, dir, "empty-dark.png")

    await openBoardMenu(w)
    await clickEl(w, `[data-action="rename-board"][data-board="main"]`, 2_000)
    await waitRect(w, ".board-rename input", 2_000)
    await typeText(w, "arena")
    await key(w, "Return")
    const renamed = await until(async () => (await pill()) === "arena", 5_000)
    const moved = (await exists(join(p.root, ".river", "boards", "arena", "board.json"))) && !(await exists(join(p.root, ".river", "boards", "main")))
    const meta = JSON.parse(await readFile(join(p.root, ".river", "boards", "arena", "board.json"), "utf8").catch(() => "{}")) as { name?: string }
    check(`renaming main to arena moves the folder and opens it (pill ${await pill()}, board.json name ${meta.name})`, renamed && moved && meta.name === "arena")
    await closeBoardMenu(w)
    if (!(await waitFor("canvas", 8_000))) console.warn("river smoke: canvas not ready after rename")

    w.webContents.send("smoke:navigate", "frames")
    await waitFor("frames", 10_000)
    const thumbs = await until(async () => (await w.webContents.executeJavaScript(`document.querySelectorAll(".strip-thumb img").length`)) === STRIP_FRAMES, 8_000)
    for (const i of [1, 3, 5]) await clickEl(w, `[data-pick="${i}"]`, 2_000)
    await clickEl(w, `[data-action="send-strip"]`, 2_000)
    await until(async () => Boolean(await rectOf(w, ".send-done")), 6_000)
    await shoot(w, dir, "frames-strip.png")
    const b1 = await loadBoard(p.root, "arena")
    const row = [...b1.cards].sort((a, b) => a.x - b.x) as (Card & { frame?: number })[]
    const linked = row.slice(1).every((c, i) => b1.edges.some((e) => e.from === row[i]!.id && e.to === c.id))
    check(
      `unticking frames 2, 4, 6 sends 3 cards in a row joined by ${b1.edges.length} connectors (frames ${row.map((c) => c.frame).join()}, captions ${row.map((c) => JSON.stringify(c.caption)).join(" ")})`,
      thumbs && row.length === 3 && b1.edges.length === 2 && linked && row.map((c) => c.frame).join() === "0,2,4" && row.every((c) => c.y === row[0]!.y) && row[0]!.caption === `${STRIP_SHOT} · frame 1`,
    )
    for (const i of [1, 3, 5]) await clickEl(w, `[data-pick="${i}"]`, 2_000)
    await clickEl(w, `[data-action="send-strip"]`, 2_000)
    const all = await until(async () => (await loadBoard(p.root, "arena")).cards.length === 9, 6_000)
    const b2 = await loadBoard(p.root, "arena")
    const second = b2.cards.filter((c) => !b1.cards.some((x) => x.id === c.id))
    const below = second.every((c) => c.y > row[0]!.y + 100)
    check(`sending all six puts a second row of ${second.length} below the first, with ${b2.edges.length - 2} more connectors`, all && second.length === 6 && below && b2.edges.length === 7)

    await w.webContents.executeJavaScript(`[...document.querySelectorAll(".shot")].find((b) => b.textContent.includes(${JSON.stringify(STILL_SHOT)}))?.setAttribute("data-smoke", "still")`)
    await clickEl(w, `.shot[data-smoke="still"]`, 2_000)
    const before = await loadBoard(p.root, "arena")
    await clickEl(w, `[data-action="send-frame"]`, 3_000)
    const one = await until(async () => (await loadBoard(p.root, "arena")).cards.length === before.cards.length + 1, 5_000)
    const after = await loadBoard(p.root, "arena")
    const still = after.cards.find((c) => c.ref === STILL_SHOT)
    check(`a one-frame capture shows "Send to board" and adds one card (${JSON.stringify(still?.caption)}) and no connector`, one && still !== undefined && after.edges.length === before.edges.length)

    await clickEl(w, `[data-action="open-board"]`, 2_000)
    forget("canvas")
    await toCanvas()
    await key(w, "1", ["shift"])
    await sleep(700)
    await imagesSettled(w, 8_000)
    await shoot(w, dir, "strip-dark.png")
  } else {
    await toCanvas()
    const board = await pill()
    const bg = await bgOf(w, ".canvas-wrap")
    check(`after a restart the canvas opens the last board (${board}) and stays dark (${bg})`, board === "arena" && bg === DARK_BG)

    await pickTheme("system")
    const system = await bgOf(w, ".canvas-wrap")
    check(`"System" follows the OS, dark here (${system})`, system === DARK_BG && (await savedSettings()).canvasTheme === "system")
    await pickTheme("paper")
    const paper = await bgOf(w, ".canvas-wrap")
    check(`switching back to paper (${paper}) is saved`, paper === PAPER_BG && (await savedSettings()).canvasTheme === "paper")

    // A note of yours pointing at one frame, written from outside like an agent would, so the screenshot reads like a real board.
    const strip = [...(await loadBoard(p.root, "arena")).cards].sort((a, b) => a.y - b.y || a.x - b.x).slice(0, 3)
    const right = strip[2]!
    const note = await saveCard(p.root, "arena", { kind: "note", ref: "", text: "hmm, he rises a beat late here. Can the shadow land on frame 4?", x: right.x + right.w + 80, y: right.y - 30, w: 250, madeBy: "you" })
    await saveEdge(p.root, "arena", { from: note.id, to: right.id, madeBy: "you" })
    await waitRect(w, `.react-flow__node[data-id="${note.id}"]`, 5_000)
    await key(w, "1", ["shift"])
    await sleep(700)
    await imagesSettled(w, 8_000)
    await shoot(w, dir, "strip-paper.png")
    await openBoardMenu(w)
    await sleep(200)
    await shoot(w, dir, "board-menu-paper.png")
    await closeBoardMenu(w)

    const cards = (await loadBoard(p.root, "arena")).cards.filter((c) => c.kind === "frame")
    const first = [...cards].sort((a, b) => a.y - b.y || a.x - b.x)[0]!
    const next = [...cards].filter((c) => c.y === first.y && c.x > first.x).sort((a, b) => a.x - b.x)[0]!
    const oldCaption = first.caption
    const newCaption = "Move · Shadow step: he sinks into his shadow and rises ahead"
    const cap = await centerOf(w, `.react-flow__node[data-id="${first.id}"] .cnode-cap`)
    if (cap) await dblClick(w, cap[0], cap[1])
    const editing = Boolean(await waitRect(w, ".cnode-cap-input", 2_000))
    const noLightbox = !(await rectOf(w, ".lightbox"))
    await typeText(w, newCaption)
    const saved = waitBoardWrite("card", (c) => c.id === first.id && c.caption === newCaption, 4_000)
    await key(w, "Return")
    const wrote = (await saved) !== null
    await shoot(w, dir, "caption-edited.png")
    await key(w, "Z", ["control"])
    const undone = await until(async () => (await loadCard(p.root, "arena", first.id))?.caption === oldCaption, 4_000)
    await key(w, "Z", ["control", "shift"])
    const redone = await until(async () => (await loadCard(p.root, "arena", first.id))?.caption === newCaption, 4_000)
    check(`double-clicking a caption edits it in place (no lightbox), Enter saves, Ctrl+Z restores ${JSON.stringify(oldCaption)}, Ctrl+Shift+Z redoes`, editing && noLightbox && wrote && undone && redone)

    const img = await centerOf(w, `.react-flow__node[data-id="${first.id}"] .cnode-frame`)
    if (img) await dblClick(w, img[0], img[1])
    const opened = await waitImage(w, ".lightbox img", 3_000)
    const shown = async () => (await w.webContents.executeJavaScript(`[document.querySelector(".lightbox")?.dataset.card ?? "", document.querySelector(".lightbox-text")?.textContent ?? ""]`)) as [string, string]
    const [id0, cap0] = await shown()
    await shoot(w, dir, "lightbox-paper.png")
    await key(w, "Right")
    await sleep(250)
    const [id1, cap1] = await shown()
    await key(w, "Left")
    await sleep(200)
    const [id2] = await shown()
    await key(w, "Escape")
    const closed = await until(async () => !(await rectOf(w, ".lightbox")), 2_000)
    check(`the lightbox shows the caption (${JSON.stringify(cap0)}), the right arrow steps to the next frame in reading order (${JSON.stringify(cap1)}), left steps back, Escape closes`, opened && id0 === first.id && cap0 === newCaption && id1 === next.id && cap1 === next.caption && id2 === first.id && closed)

    await openBoardMenu(w)
    await clickEl(w, ".board-new input", 2_000)
    await typeText(w, "scratch")
    await key(w, "Return")
    const made = await until(async () => (await pill()) === "scratch", 5_000)
    if (!(await waitFor("canvas", 8_000))) console.warn("river smoke: canvas not ready on scratch")
    await openBoardMenu(w)
    await clickEl(w, `[data-action="delete-board"][data-board="scratch"]`, 2_000)
    const asked = Boolean(await waitRect(w, `[data-action="delete-board-confirm"]`, 2_000))
    const stillThere = await exists(join(p.root, ".river", "boards", "scratch"))
    await clickEl(w, `[data-action="delete-board-confirm"]`, 2_000)
    const gone = await until(async () => !(await exists(join(p.root, ".river", "boards", "scratch"))), 5_000)
    const back = await until(async () => (await pill()) === "arena", 5_000)
    await openBoardMenu(w)
    const lastLocked = (await w.webContents.executeJavaScript(`Boolean(document.querySelector('[data-action="delete-board"][data-board="arena"]')?.disabled)`)) as boolean
    await closeBoardMenu(w)
    const refusal = (await w.webContents.executeJavaScript(`window.river.boardDelete("arena").then(() => "deleted", (e) => e.message)`)) as string
    check(`main refuses to delete the last board too (${JSON.stringify(refusal)})`, refusal.includes("only board") && (await exists(join(p.root, ".river", "boards", "arena", "board.json"))))
    check(`deleting a board asks first, sends it to the trash and opens the one left; the last board cannot be deleted`, made && asked && stillThere && gone && back && lastLocked)
  }
  const ok = results.every(([, r]) => r)
  console.log(`river smoke: premium phase ${phase} ${ok ? "PASSED" : "FAILED"} (${results.filter(([, r]) => r).length}/${results.length})`)
  return ok
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
  const phase = process.env["RIVER_SMOKE_PREMIUM"]
  if (phase === "1" || phase === "2") {
    if (!(await waitFor("story-map", 30_000))) console.warn("river smoke: story map did not report ready")
    const ok = await smokePremium(w, dir, phase, waitFor, (v) => seen.delete(v)).catch((err: unknown) => {
      console.error("river smoke: premium run threw", err)
      return false
    })
    clearTimeout(hardStop)
    app.exit(ok ? 0 : 1)
    return
  }
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
    ["RIVER_SMOKE_AGENTS", () => smokeAgents(w, dir, waitFor)],
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
    const p = currentProject()
    const abs = p && riverFilePath(p, request.url)
    if (!abs) return new Response("Not found", { status: 404 })
    return net.fetch(pathToFileURL(abs).toString())
  })
  registerIpc(() => win, isSmoke && process.env["RIVER_SMOKE_JOB"] === "1" ? { jobDeps: smokeJobDeps } : {})

  const initial = isSmoke ? process.env["RIVER_PROJECT"] : (argProject() ?? process.env["RIVER_PROJECT"] ?? getLastProject())
  if (initial && process.env["RIVER_SMOKE_PREMIUM"] === "1") await seedStripCapture(resolve(initial))
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

/** How long quitting waits for agent turns to end once their processes are told to stop. */
const QUIT_WAIT_MS = 6_000
let agentWorkStopped = false
app.on("before-quit", (e) => {
  if (agentWorkStopped) return
  // Agent turns run Claude processes that would otherwise outlive the app: stop them first, then quit.
  e.preventDefault()
  agentWorkStopped = true
  void stopAgentWork(QUIT_WAIT_MS).finally(() => app.quit())
})
