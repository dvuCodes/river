/**
 * The project brief: .river/brief.md in the workspace, written by the user. Agents read it before they
 * answer; River adds what the user turned down (a dismiss with a reason) under one heading.
 */
import { readFile } from "node:fs/promises"
import path from "node:path"
import { writeAtomic } from "./boards"
import { briefLockFile, withLock } from "./lock"

export const BRIEF_FILE = ".river/brief.md"
export const TURNED_DOWN_HEADING = "## Things the user turned down"

export const briefPath = (workspaceRoot: string) => path.join(workspaceRoot, ".river", "brief.md")

/** The brief's text, or undefined when there is none (or it is blank). */
export async function readBrief(workspaceRoot: string): Promise<string | undefined> {
  try {
    const text = await readFile(briefPath(workspaceRoot), "utf8")
    return text.trim() ? text : undefined
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined
    throw err
  }
}

/** `text` with `line` added at the end of the turned-down section, which is created at the end when missing. */
export function withTurnedDown(text: string, line: string): string {
  const lines = text.replace(/\r\n/g, "\n").replace(/\n+$/, "").split("\n")
  const head = lines.findIndex((l) => l.trim() === TURNED_DOWN_HEADING)
  if (head === -1) return `${[...(text.trim() ? [...lines, ""] : []), TURNED_DOWN_HEADING, "", line].join("\n")}\n`
  let end = lines.findIndex((l, i) => i > head && /^#{1,2} /.test(l))
  if (end === -1) end = lines.length
  while (end > head + 1 && lines[end - 1]!.trim() === "") end--
  return `${[...lines.slice(0, end), line, ...lines.slice(end)].join("\n")}\n`
}

/**
 * Add one bullet to the turned-down section. `key` (a job id) is written into the bullet, and a bullet
 * with that key already there makes this a no-op, so repeating a dismiss adds nothing. Appends are
 * serialised by a lock, and the file keeps the line endings the user wrote it with.
 */
export async function addTurnedDown(workspaceRoot: string, key: string, text: string): Promise<void> {
  await withLock(briefLockFile(workspaceRoot), "the brief", async () => {
    const current = (await readBrief(workspaceRoot)) ?? ""
    if (current.includes(`(${key})`)) return
    const line = `- ${text.replace(/\s+/g, " ").trim()} (${key})`
    const next = withTurnedDown(current, line)
    await writeAtomic(briefPath(workspaceRoot), current.includes("\r\n") ? next.replace(/\n/g, "\r\n") : next)
  })
}
