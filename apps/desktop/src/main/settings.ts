import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { app, safeStorage } from "electron"
import type { AgentBackend, AgentModel } from "@river/agent"
import { CANVAS_THEMES, type CanvasTheme } from "../shared/api"

/**
 * Stored in app userData. The API key is kept only as safeStorage ciphertext (base64).
 * Nothing about the Claude Code sign-in is ever stored here: Claude Code keeps its own.
 */
interface Settings {
  lastProject?: string
  apiKeyEnc?: string
  backend?: AgentBackend
  model?: AgentModel
  /** The `claude` executable, when it is not on PATH. */
  claudePath?: string
  canvasTheme?: CanvasTheme
  /** False turns off the look at a job's renders after they are drawn. On unless set to false. */
  selfCheck?: boolean
  /** Project root -> the board last open in it. */
  lastBoards?: Record<string, string>
}

const file = () => join(app.getPath("userData"), "river-settings.json")

const BACKENDS: readonly AgentBackend[] = ["api-key", "claude-code"]
const MODELS: readonly AgentModel[] = ["claude-opus-5-5", "claude-sonnet-5-5"]

export interface AgentPrefs {
  /** Undefined until the user picks one; main then picks a default from what is available. */
  backend?: AgentBackend
  model: AgentModel
  claudePath?: string
  selfCheck: boolean
}

export function getAgentPrefs(): AgentPrefs {
  const s = read()
  return {
    ...(s.backend && BACKENDS.includes(s.backend) ? { backend: s.backend } : {}),
    model: s.model && MODELS.includes(s.model) ? s.model : "claude-opus-5-5",
    ...(s.claudePath ? { claudePath: s.claudePath } : {}),
    selfCheck: s.selfCheck !== false,
  }
}

export function setAgentPrefs(p: { backend?: AgentBackend; model?: AgentModel; claudePath?: string; selfCheck?: boolean }): void {
  const s = read()
  if (p.backend !== undefined) {
    if (!BACKENDS.includes(p.backend)) throw new Error(`Unknown backend ${String(p.backend)}`)
    s.backend = p.backend
  }
  if (p.model !== undefined) {
    if (!MODELS.includes(p.model)) throw new Error(`Unknown model ${String(p.model)}`)
    s.model = p.model
  }
  if (p.claudePath !== undefined) {
    const t = p.claudePath.trim()
    if (t) s.claudePath = t
    else delete s.claudePath
  }
  if (p.selfCheck !== undefined) {
    if (typeof p.selfCheck !== "boolean") throw new Error("selfCheck is true or false")
    s.selfCheck = p.selfCheck
  }
  write(s)
}

function read(): Settings {
  try {
    return JSON.parse(readFileSync(file(), "utf8")) as Settings
  } catch {
    return {}
  }
}

function write(s: Settings): void {
  mkdirSync(dirname(file()), { recursive: true })
  writeFileSync(file(), JSON.stringify(s, null, 2), "utf8")
}

export function getLastProject(): string | undefined {
  return read().lastProject
}

export function setLastProject(root: string): void {
  write({ ...read(), lastProject: root })
}

/** A smoke run on the user's own app data leaves their canvas look and last boards alone, as it leaves their last project. */
const keepUserSettings = Boolean(process.env["RIVER_SMOKE_DIR"]) && !process.env["RIVER_SMOKE_USERDATA"]

/** Paper unless the user picked another; the canvas does not follow the OS unless asked to. */
export function getCanvasTheme(): CanvasTheme {
  const t = read().canvasTheme
  return t && CANVAS_THEMES.includes(t) ? t : "paper"
}

export function setCanvasTheme(t: CanvasTheme): void {
  if (!CANVAS_THEMES.includes(t)) throw new Error(`Unknown canvas theme ${String(t)}`)
  if (keepUserSettings) return
  write({ ...read(), canvasTheme: t })
}

export function getLastBoard(root: string): string | undefined {
  return read().lastBoards?.[root]
}

export function setLastBoard(root: string, board: string): void {
  const s = read()
  if (keepUserSettings || s.lastBoards?.[root] === board) return
  write({ ...s, lastBoards: { ...s.lastBoards, [root]: board } })
}

export function encryptionAvailable(): Promise<boolean> {
  return safeStorage.isAsyncEncryptionAvailable()
}

export function hasApiKey(): boolean {
  return Boolean(read().apiKeyEnc)
}

/** The decrypted key. Only main ever sees it; it goes straight into startAgentTurn. */
export async function getApiKey(): Promise<string | undefined> {
  const enc = read().apiKeyEnc
  if (!enc || !(await safeStorage.isAsyncEncryptionAvailable())) return undefined
  try {
    const { result, shouldReEncrypt } = await safeStorage.decryptStringAsync(Buffer.from(enc, "base64"))
    if (shouldReEncrypt) await setApiKey(result)
    return result
  } catch {
    return undefined
  }
}

export async function setApiKey(key: string): Promise<void> {
  if (!(await safeStorage.isAsyncEncryptionAvailable())) throw new Error("Secure storage is not available on this system, so the key was not saved.")
  const trimmed = key.trim()
  if (!trimmed) throw new Error("The key is empty.")
  const enc = await safeStorage.encryptStringAsync(trimmed)
  write({ ...read(), apiKeyEnc: enc.toString("base64") })
}

export function clearApiKey(): void {
  const s = read()
  delete s.apiKeyEnc
  write(s)
}
