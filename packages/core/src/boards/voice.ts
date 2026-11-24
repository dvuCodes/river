/**
 * The narrative bible: .river/voice.md in the workspace. The user writes how the story should sound; writing
 * agents read it before they write. River adds lines the user kept from a take under "## Lines that landed" and
 * lines the user threw out under "## Lines we cut", so the next take learns from both.
 */
import { readFile } from "node:fs/promises"
import path from "node:path"
import { writeAtomic } from "./boards"
import { voiceLockFile, withLock } from "./lock"

export const VOICE_FILE = ".river/voice.md"
export const LANDED_HEADING = "## Lines that landed"
export const CUT_HEADING = "## Lines we cut"

export const voicePath = (workspaceRoot: string) => path.join(workspaceRoot, ".river", "voice.md")

/** The voice file's text, or undefined when there is none (or it is blank). */
export async function readVoice(workspaceRoot: string): Promise<string | undefined> {
  try {
    const text = await readFile(voicePath(workspaceRoot), "utf8")
    return text.trim() ? text : undefined
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined
    throw err
  }
}

/** Where a `## ` section's lines are: [first line after the heading, end) or undefined when it is missing. */
function sectionRange(lines: string[], heading: string): { head: number; end: number } | undefined {
  const head = lines.findIndex((l) => l.trim() === heading)
  if (head === -1) return undefined
  let end = lines.findIndex((l, i) => i > head && /^#{1,2} /.test(l))
  if (end === -1) end = lines.length
  return { head, end }
}

/** The bullets of one section ("- " lines), without the "- ". */
export function voiceSection(text: string, heading: string): string[] {
  const lines = text.replace(/\r\n/g, "\n").split("\n")
  const range = sectionRange(lines, heading)
  if (!range) return []
  return lines.slice(range.head + 1, range.end).filter((l) => l.startsWith("- ")).map((l) => l.slice(2))
}

/** `text` (LF) with `line` added at the end of the `heading` section, which is created at the end when missing. */
export function withVoiceLine(text: string, heading: string, line: string): string {
  const lines = text.replace(/\r\n/g, "\n").replace(/\n+$/, "").split("\n")
  const range = sectionRange(lines, heading)
  if (!range) return `${[...(text.trim() ? [...lines, ""] : []), heading, "", line].join("\n")}\n`
  let end = range.end
  while (end > range.head + 1 && lines[end - 1]!.trim() === "") end--
  const after = lines.slice(end)
  // Keep a blank line between this section and the heading that follows it.
  const gap = after.length > 0 && after[0]!.trim() !== "" ? [""] : []
  return `${[...lines.slice(0, end), line, ...gap, ...after].join("\n")}\n`
}

async function addVoiceLine(workspaceRoot: string, heading: string, key: string, text: string): Promise<boolean> {
  return withLock(voiceLockFile(workspaceRoot), "the voice file", async () => {
    const current = (await readVoice(workspaceRoot)) ?? ""
    if (voiceSection(current, heading).some((b) => b.includes(`(${key})`))) return false
    const quoted = text.replace(/\s+/g, " ").trim()
    const next = withVoiceLine(current, heading, `- ${quoted} (${key})`)
    await writeAtomic(voicePath(workspaceRoot), current.includes("\r\n") ? next.replace(/\n/g, "\r\n") : next)
    return true
  })
}

/**
 * Add a line the user kept to "## Lines that landed". `key` (a job or take id) is written into the bullet; a
 * bullet in that section with the same key already there makes this a no-op. Returns whether a line was added.
 * Appends are serialised by a lock, and the file keeps the line endings it was written with.
 */
export function addVoiceExemplar(workspaceRoot: string, key: string, text: string): Promise<boolean> {
  return addVoiceLine(workspaceRoot, LANDED_HEADING, key, text)
}

/** Add a line the user threw out to "## Lines we cut", like `addVoiceExemplar`. */
export function addVoiceCut(workspaceRoot: string, key: string, text: string): Promise<boolean> {
  return addVoiceLine(workspaceRoot, CUT_HEADING, key, text)
}
