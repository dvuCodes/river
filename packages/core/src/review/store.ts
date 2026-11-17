import { randomBytes, randomInt } from "node:crypto"
import { readFile, rename, rm, writeFile } from "node:fs/promises"
import { basename, dirname, join } from "node:path"

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/

/** Throws unless `id` is safe to use as a file name (no separators, no "..", no leading dot). */
export function assertSafeId(kind: string, id: string): void {
  if (typeof id !== "string" || !SAFE_ID.test(id) || id.includes("..")) {
    throw new Error(`river: invalid ${kind} id ${JSON.stringify(id)}`)
  }
}

const BASE36 = "0123456789abcdefghijklmnopqrstuvwxyz"

/** `prefix` + 8 random base36 characters. */
export function newId(prefix: string): string {
  let out = prefix
  for (let i = 0; i < 8; i++) out += BASE36[randomInt(36)]
  return out
}

/** Write JSON (2-space indent, trailing newline) via a temp file in the same dir, then rename. */
export async function writeJsonAtomic(file: string, value: unknown): Promise<void> {
  const tmp = join(dirname(file), `.${basename(file)}.${randomBytes(6).toString("hex")}.tmp`)
  await writeFile(tmp, JSON.stringify(value, null, 2) + "\n", "utf8")
  try {
    await rename(tmp, file)
  } catch (err) {
    await rm(tmp, { force: true })
    throw err
  }
}

/** Parse a JSON file, or return `fallback` when it does not exist. */
export async function readJson<T>(file: string, fallback: T): Promise<T> {
  let text: string
  try {
    text = await readFile(file, "utf8")
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return fallback
    throw err
  }
  return JSON.parse(text) as T
}
