import { mkdir, writeFile } from "node:fs/promises"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { BrowserWindow, app, ipcMain, nativeTheme, net, protocol } from "electron"
import { VIEWS, type ViewId } from "../shared/api"
import { openProject, registerIpc, resolveRiverFile } from "./ipc"
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
