import { parsePassage, rewriteLinks, slugify } from "./passage"
import type { Passage, Story } from "./types"

/** "Pond!" -> "pond", "Long path" -> "long_path". Lowercase, [a-z0-9_] only. */
export function slug(name: string): string {
  return slugify(name)
}

/** Find the passage a choice target names: by name first, then by id. */
export function resolveTarget(story: Story, target: string): Passage | undefined {
  return story.passages.find((p) => p.name === target) ?? story.passages.find((p) => p.id === target)
}

export function passageById(story: Story, id: string): Passage | undefined {
  return story.passages.find((p) => p.id === id)
}

export function startPassage(story: Story): Passage | undefined {
  return resolveTarget(story, story.start)
}

function isCodePassage(p: Passage): boolean {
  return p.tags.includes("script") || p.tags.includes("stylesheet")
}

/** Passages that are story content (not [script] or [stylesheet]). */
export function contentPassages(story: Story): Passage[] {
  return story.passages.filter((p) => !isCodePassage(p))
}

function reparse(p: Passage, rawText: string, name = p.name): Passage {
  const next = parsePassage({ name, tags: p.tags, metadata: p.metadata, rawText, file: p.span.file, line: p.span.line }).passage
  // Keep the source so the writer can still reuse the header and spacing that did not change.
  return p.source ? { ...next, source: p.source } : next
}

/**
 * The card position from the Twee header metadata `{"position":"x,y"}` (top-left), or undefined when it
 * is missing or not two finite numbers.
 */
export function passagePosition(p: Passage): [number, number] | undefined {
  const v = p.metadata["position"]
  if (typeof v !== "string") return undefined
  const parts = v.split(",")
  if (parts.length !== 2 || parts.some((s) => s.trim() === "")) return undefined
  const [x, y] = parts.map((s) => Number(s.trim())) as [number, number]
  return Number.isFinite(x) && Number.isFinite(y) ? [x, y] : undefined
}

/**
 * Set card positions (passage id -> [x, y], rounded to integers) in each passage's header metadata as
 * "position": "x,y". Other metadata keys and their order are kept. Unknown ids and non-finite values are
 * ignored. Returns the same Story object when nothing changed, else a new Story.
 */
export function setPassagePositions(story: Story, positions: Record<string, [number, number]>): Story {
  let changed = false
  const passages = story.passages.map((p) => {
    const pos = Object.hasOwn(positions, p.id) ? positions[p.id] : undefined
    if (!pos || !Number.isFinite(pos[0]) || !Number.isFinite(pos[1])) return p
    // `|| 0` turns -0 into 0.
    const value = `${Math.round(pos[0]) || 0},${Math.round(pos[1]) || 0}`
    if (p.metadata["position"] === value) return p
    changed = true
    return { ...p, metadata: { ...p.metadata, position: value } }
  })
  return changed ? { ...story, passages } : story
}

/** Replace one passage raw text and re-parse it. Returns a new Story; the input is not changed. */
export function updatePassageText(story: Story, passageId: string, rawText: string): Story {
  const target = passageById(story, passageId)
  if (!target) throw new Error(`no passage with id "${passageId}"`)
  return { ...story, passages: story.passages.map((p) => (p === target ? reparse(p, rawText) : p)) }
}

/**
 * Give a passage text an `@id` rule. Adds it to the top of the rules block, or adds a new
 * rules block (`@id ...` then `--`) when the text has none.
 */
function withIdRule(rawText: string, id: string): string {
  const lines = rawText.split("\n")
  let i = 0
  while (i < lines.length && lines[i]!.startsWith("@")) i++
  const hasRules = i < lines.length && lines[i] === "--"
  return hasRules ? `@id ${id}\n${rawText}` : `@id ${id}\n--\n${rawText}`
}

/**
 * Rename a passage and rewrite every link to it in every other passage. Returns a new Story.
 * The passage id never changes: when the id came from the old name (no `@id` rule), an
 * `@id <old id>` rule is added, so layouts and anything else keyed by id still match.
 */
export function renamePassage(story: Story, passageId: string, newName: string): Story {
  const target = passageById(story, passageId)
  if (!target) throw new Error(`no passage with id "${passageId}"`)
  if (story.passages.some((p) => p !== target && p.name === newName)) {
    throw new Error(`a passage named "${newName}" already exists`)
  }
  const oldName = target.name
  const passages = story.passages.map((p) => {
    const raw = isCodePassage(p) ? p.rawText : rewriteLinks(p.rawText, oldName, newName)
    if (p === target) {
      const renamed = reparse(p, raw, newName)
      // Code passages have no rules block, so their id follows the name.
      if (renamed.id === target.id || isCodePassage(p)) return renamed
      return reparse(p, withIdRule(raw, target.id), newName)
    }
    return raw === p.rawText ? p : reparse(p, raw)
  })
  return { ...story, start: story.start === oldName ? newName : story.start, passages }
}
