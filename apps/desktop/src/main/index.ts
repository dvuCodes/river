import { mkdir, writeFile } from "node:fs/promises"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { BrowserWindow, app, ipcMain, nativeTheme, net, protocol } from "electron"
import { VIEWS, type ViewId } from "../shared/api"
import { onStoryWritten, openProject, registerIpc, resolveRiverFile } from "./ipc"
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
    },
  })
  w.once("ready-to-show", () => w.show())
  const query = isSmoke ? { smoke: "1" } : undefined
  const devUrl = process.env["ELECTRON_RENDERER_URL"]
  if (devUrl) void w.loadURL(devUrl + (query ? "?smoke=1" : ""))
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

async function runSmoke(w: BrowserWindow, dir: string): Promise<void> {
  const hardStop = setTimeout(() => {
    console.error("river smoke: timed out after 120s")
    app.exit(2)
  }, 120_000)
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
  protocol.handle("river-file", (request) => {
    const abs = resolveRiverFile(request.url)
    if (!abs) return new Response("Not found", { status: 404 })
    return net.fetch(pathToFileURL(abs).toString())
  })
  registerIpc(() => win)

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
