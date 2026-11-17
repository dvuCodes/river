import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { app, safeStorage } from "electron"

/** Stored in app userData. The API key is kept only as safeStorage ciphertext (base64). */
interface Settings {
  lastProject?: string
  apiKeyEnc?: string
}

const file = () => join(app.getPath("userData"), "river-settings.json")

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
