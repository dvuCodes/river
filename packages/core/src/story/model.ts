import { parsePassage, rewriteLinks, slugify } from "./passage"
import type { Passage, Story } from "./types"

/** "Squirrel!" -> "squirrel", "Maple corner" -> "maple_corner". Lowercase, [a-z0-9_] only. */
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
  return parsePassage({ name, tags: p.tags, metadata: p.metadata, rawText, file: p.span.file, line: p.span.line }).passage
}

/** Replace one passage raw text and re-parse it. Returns a new Story; the input is not changed. */
export function updatePassageText(story: Story, passageId: string, rawText: string): Story {
  const target = passageById(story, passageId)
  if (!target) throw new Error(`no passage with id "${passageId}"`)
  return { ...story, passages: story.passages.map((p) => (p === target ? reparse(p, rawText) : p)) }
}

/** Rename a passage and rewrite every link to it in every other passage. Returns a new Story. */
export function renamePassage(story: Story, passageId: string, newName: string): Story {
  const target = passageById(story, passageId)
  if (!target) throw new Error(`no passage with id "${passageId}"`)
  if (story.passages.some((p) => p !== target && p.name === newName)) {
    throw new Error(`a passage named "${newName}" already exists`)
  }
  const oldName = target.name
  const passages = story.passages.map((p) => {
    const raw = isCodePassage(p) ? p.rawText : rewriteLinks(p.rawText, oldName, newName)
    if (p === target) return reparse(p, raw, newName)
    return raw === p.rawText ? p : reparse(p, raw)
  })
  return { ...story, start: story.start === oldName ? newName : story.start, passages }
}
