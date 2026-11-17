import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { BrowserWindow, type IpcMainInvokeEvent, ipcMain, nativeTheme } from "electron"
import type { FsChange } from "../shared/api"
import type { ApprovalPayload } from "../shared/approval"

const here = dirname(fileURLToPath(import.meta.url))

/** Job ids as River and concept_request make them. */
const JOB_ID = /^j_[a-z0-9]{1,32}$/

export interface ApprovalDeps {
  /** The app's window: the approval window is its modal child, and only it may ask to open one. */
  parent(): BrowserWindow | null
  /** The open project's root, or null. */
  root(): string | null
  /** A job waiting for approval, as the approval window shows it: its scripts read from the job's commit. Throws for any other job. */
  read(root: string, jobId: string): Promise<ApprovalPayload>
  /** Render the scripts with these shas through the approval gate (which hashes the committed bytes again). */
  run(root: string, jobId: string, shas: Record<string, string>): Promise<void>
  kit(): string
  /** Counts every approve call that reaches main, refused ones included (smoke mode). */
  onApprove?: () => void
  smoke: boolean
}

/** The one approval window, the project and job it shows, and exactly the shas main gave it. */
interface Slot {
  win: BrowserWindow
  root: string
  payload: ApprovalPayload
  shown: Record<string, string>
}

export interface Approvals {
  /** The approval window open now, if any (smoke mode drives it). */
  window(): BrowserWindow | null
  /** Watcher changes: a change to the open job's file closes the window when its scripts are no longer the ones shown. */
  changed(changes: FsChange[]): void
  /** The project closed or changed: nothing from it may be approved. */
  closeAll(): void
}

const shasOf = (p: ApprovalPayload) => Object.fromEntries(p.scripts.map((s) => [s.file, s.sha256]))

function sameShas(a: Readonly<Record<string, unknown>>, b: Readonly<Record<string, string>>): boolean {
  const keys = Object.keys(b)
  return Object.keys(a).length === keys.length && keys.every((k) => a[k] === b[k])
}

/**
 * The approval window: a separate, main-owned window, like an OS permission prompt. The canvas can only ask main to
 * open it for a job id. Main reads the scripts itself, hands them to that window, and takes `job:approve` only from
 * that window's main frame, only for its job and only with the shas it was given. Nothing the app's window draws can
 * cover it, and when the job's scripts change while it is open, it closes.
 */
export function registerApproval(deps: ApprovalDeps): Approvals {
  let slot: Slot | null = null

  const live = (s: Slot | null): s is Slot => s !== null && !s.win.isDestroyed()
  /** The slot whose window sent `e` from its main frame, or null. */
  const from = (e: IpcMainInvokeEvent): Slot | null => {
    if (!live(slot)) return null
    const main = slot.win.webContents.mainFrame
    const frame = e.senderFrame
    return e.sender.id === slot.win.webContents.id && frame !== null && frame.processId === main.processId && frame.routingId === main.routingId ? slot : null
  }
  const close = (s: Slot | null) => {
    if (live(s)) s.win.close()
  }
  /** Close `s` unless its job still waits for approval with exactly the scripts it shows. */
  const recheck = async (s: Slot) => {
    const now = await deps.read(s.root, s.payload.jobId).catch(() => null)
    if (slot === s && (!now || !sameShas(shasOf(now), s.shown))) close(s)
  }

  const open = async (jobId: string) => {
    const root = deps.root()
    if (!root) throw new Error("No project is open.")
    if (live(slot) && slot.payload.jobId === jobId && slot.root === root) {
      slot.win.focus()
      return
    }
    const payload = await deps.read(root, jobId)
    close(slot)
    const parent = deps.parent()
    const pb = parent && !parent.isDestroyed() ? parent.getBounds() : null
    const width = pb ? Math.min(980, pb.width - 60) : 980
    const height = pb ? pb.height - 60 : 860
    const win = new BrowserWindow({
      ...(parent && !parent.isDestroyed() ? { parent, modal: true } : {}),
      ...(pb ? { x: Math.round(pb.x + (pb.width - width) / 2), y: Math.round(pb.y + (pb.height - height) / 2) } : {}),
      width,
      height,
      minWidth: 420,
      minHeight: 320,
      show: false,
      title: "Review the scripts",
      autoHideMenuBar: true,
      minimizable: false,
      backgroundColor: nativeTheme.shouldUseDarkColors ? "#262522" : "#ffffff",
      webPreferences: {
        preload: join(here, "../preload/approval.cjs"),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        webSecurity: true,
        webviewTag: false,
        spellcheck: false,
        backgroundThrottling: !deps.smoke,
      },
    })
    const s: Slot = { win, root, payload, shown: shasOf(payload) }
    slot = s
    win.on("closed", () => {
      if (slot === s) slot = null
    })
    win.once("ready-to-show", () => win.show())
    // One page: nothing in it may navigate, open a window or attach a webview.
    win.webContents.on("will-navigate", (e) => e.preventDefault())
    win.webContents.on("will-redirect", (e) => e.preventDefault())
    win.webContents.on("will-attach-webview", (e) => e.preventDefault())
    win.webContents.setWindowOpenHandler(() => ({ action: "deny" }))
    if (deps.smoke) win.setIgnoreMouseEvents(true)
    const devUrl = process.env["ELECTRON_RENDERER_URL"]
    if (devUrl) void win.loadURL(`${devUrl}/approval.html`)
    else void win.loadFile(join(here, "../renderer/approval.html"))
  }

  ipcMain.handle("job:review", (e, jobId: unknown) => {
    const parent = deps.parent()
    if (!parent || parent.isDestroyed() || e.sender.id !== parent.webContents.id) throw new Error("river: refused: only River's window can open a review.")
    if (typeof jobId !== "string" || !JOB_ID.test(jobId)) throw new Error(`Not a job id: ${JSON.stringify(jobId)}`)
    return open(jobId)
  })
  ipcMain.handle("approval:load", (e) => {
    const s = from(e)
    if (!s) throw new Error("river: refused: this is not the review window.")
    return s.payload
  })
  ipcMain.handle("approval:kit", (e) => {
    if (!from(e)) throw new Error("river: refused: this is not the review window.")
    return deps.kit()
  })
  ipcMain.handle("approval:cancel", (e) => close(from(e)))
  ipcMain.handle("job:approve", async (e, jobId: unknown, shas: unknown) => {
    deps.onApprove?.()
    const s = from(e)
    if (!s) throw new Error("river: refused: scripts run only from the review window's Run button.")
    if (jobId !== s.payload.jobId || typeof shas !== "object" || shas === null || !sameShas(shas as Record<string, unknown>, s.shown)) {
      throw new Error("river: refused: these are not the scripts this window shows.")
    }
    try {
      await deps.run(s.root, s.payload.jobId, { ...s.shown })
    } catch (err) {
      // The gate refused (the bytes changed under the window, or the job moved on): show the change by closing.
      void recheck(s)
      throw err
    }
    close(s)
  })

  return {
    window: () => (live(slot) ? slot.win : null),
    changed(changes) {
      const s = slot
      if (live(s) && changes.some((c) => c.kind === "job" && c.rel === `.river/jobs/${s.payload.jobId}.json`)) void recheck(s)
    },
    closeAll: () => close(slot),
  }
}
