/**
 * Structured prose: a passage's prose read as a screenplay, for a game that shows speech bubbles, fires cues
 * and pauses on beats.
 *
 *   Rex [excited]: Ducks! So many ducks!      dialogue, with a mood
 *   Mara: "Easy, boy."                         dialogue (quoted speech)
 *   @cue sfx quack                             cue
 *   ...                                        beat (a pause)
 *   Plain lines are narration; a blank line ends a paragraph.
 *
 * A colon alone does not make dialogue ("Note: the gate is shut." stays narration): it needs a `[mood]` or
 * quoted speech after the colon.
 */
import type { Cue } from "./types"

export type ProseBlock =
  | { kind: "narration"; text: string }
  | { kind: "dialogue"; speaker: string; mood?: string; text: string }
  | ({ kind: "cue" } & Cue)
  | { kind: "beat" }

const SPEAKER = String.raw`(\p{L}[\p{L}\p{N}'’ ._-]{0,39}?)`
const WITH_MOOD = new RegExp(String.raw`^${SPEAKER}\s*\[([^\]\n]+)\]\s*:\s*(.+)$`, "u")
const QUOTED = new RegExp(String.raw`^${SPEAKER}\s*:\s*(["“])(.*)(["”])\s*$`, "u")
const CUE = /^@cue(?:\s+(\S+)(?:\s+(.*))?)?\s*$/
const BEAT = /^(\.\.\.|…)$/

/** `"line"` or “line” -> line; anything else as written. */
function unquote(s: string): string {
  const m = /^(["“])([\s\S]*)(["”])$/.exec(s.trim())
  return m ? m[2]! : s.trim()
}

/** The block a single line is, when it is not narration. */
function lineBlock(line: string): ProseBlock | undefined {
  const t = line.trim()
  if (BEAT.test(t)) return { kind: "beat" }
  const cue = CUE.exec(t)
  if (cue) {
    if (!cue[1]) return undefined
    const args = cue[2]?.trim()
    return args ? { kind: "cue", name: cue[1], args } : { kind: "cue", name: cue[1] }
  }
  const mood = WITH_MOOD.exec(t)
  if (mood) return { kind: "dialogue", speaker: mood[1]!.trim(), mood: mood[2]!.trim(), text: unquote(mood[3]!) }
  const quoted = QUOTED.exec(t)
  if (quoted) return { kind: "dialogue", speaker: quoted[1]!.trim(), text: quoted[3]! }
  return undefined
}

/** True for a line `@cue name [args]` on its own. */
export function isCueLine(line: string): boolean {
  const m = CUE.exec(line.trim())
  return !!m?.[1]
}

/** Read prose (rule lines and link lines already removed, as `proseText` gives with `keepCues`) into blocks. */
export function parseProseBlocks(prose: string): ProseBlock[] {
  const out: ProseBlock[] = []
  let para: string[] = []
  const flush = () => {
    if (para.length > 0) out.push({ kind: "narration", text: para.join("\n") })
    para = []
  }
  for (const line of prose.replace(/\r\n/g, "\n").split("\n")) {
    if (line.trim() === "") { flush(); continue }
    const block = lineBlock(line)
    if (block) { flush(); out.push(block) } else para.push(line.trim())
  }
  flush()
  return out
}

/** True when the blocks hold more than narration (dialogue, a cue or a beat). */
export function hasStructuredBlocks(blocks: ProseBlock[]): boolean {
  return blocks.some((b) => b.kind !== "narration")
}
