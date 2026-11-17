import type { Passage, Story } from "./types"

/** "Squirrel!" -> "squirrel", "Maple corner" -> "maple_corner". Lowercase, [a-z0-9_] only. */
export function slug(name: string): string {
  throw new Error("not implemented")
}

/** Find the passage a choice target names: by name first, then by id. */
export function resolveTarget(story: Story, target: string): Passage | undefined {
  throw new Error("not implemented")
}

export function passageById(story: Story, id: string): Passage | undefined {
  throw new Error("not implemented")
}

export function startPassage(story: Story): Passage | undefined {
  throw new Error("not implemented")
}

/** Passages that are story content (not [script] or [stylesheet]). */
export function contentPassages(story: Story): Passage[] {
  throw new Error("not implemented")
}

/** Replace one passage raw text and re-parse it. Returns a new Story; the input is not changed. */
export function updatePassageText(story: Story, passageId: string, rawText: string): Story {
  throw new Error("not implemented")
}

/** Rename a passage and rewrite every link to it in every other passage. Returns a new Story. */
export function renamePassage(story: Story, passageId: string, newName: string): Story {
  throw new Error("not implemented")
}
