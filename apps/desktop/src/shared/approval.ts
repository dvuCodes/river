/**
 * The contract between main and the approval window, a separate window main opens to show a job's scripts and take
 * the user's Run. Plain JSON only. Main fills every field: the script text is the committed bytes, and every other
 * string has been through `asciiLine`.
 */
import type { LineToRead } from "@river/adapter-godot"

export interface ApprovalScript {
  /** Relative to the project root: concepts/<conceptId>/draw.gd or draw_<v>.gd. */
  file: string
  /** The committed bytes, printable ASCII, tabs and LF only (River refuses any other script). */
  text: string
  sha256: string
  variant?: string
  caption?: string
  toRead: LineToRead[]
}

export interface ApprovalPayload {
  jobId: string
  board: string
  /** Your first message on the mark the job answers, or "" when there is none. */
  request: string
  scripts: ApprovalScript[]
}

export interface ApprovalApi {
  /** What this window shows: the scripts main read from the job's commit when it opened the window. */
  load(): Promise<ApprovalPayload>
  /** Run the scripts whose sha256s this window displayed (file -> sha256). Main refuses it from any other window. */
  approve(jobId: string, shas: Record<string, string>): Promise<void>
  /** River's drawing kit (concepts/kit.gd as River writes it). */
  kit(): Promise<string>
  /** Close the window without running anything. */
  cancel(): Promise<void>
}

/**
 * Agent-written text as one line of printable ASCII: accents come off their letters, combining marks are dropped,
 * and any other character outside 0x20-0x7E becomes a space. Combining marks can stack ink far outside their line,
 * over the script text, so none reach the approval window.
 */
export function asciiLine(text: string): string {
  return text
    .normalize("NFKD")
    .replace(/\p{M}+/gu, "")
    .replace(/[^\x20-\x7E]+/g, " ")
    .replace(/ {2,}/g, " ")
    .trim()
}

declare global {
  interface Window {
    approval: ApprovalApi
  }
}
