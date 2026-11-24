/**
 * Passage edits as data: what story_batch_edit proposes and what a writing job's take holds. One list of
 * operations, applied in order to a Story in memory, so the approval diff, the take's lint and the accept all
 * see the same result.
 */
import { addPassage, deletePassage, parseTwee3, passageById, renamePassage, updatePassageText, type Passage, type Story } from "@river/core"
import { z } from "zod"

export type StoryEdit =
  | { op: "write"; passageId: string; rawText: string }
  | { op: "add"; name: string; rawText: string; tags?: string[] }
  | { op: "rename"; passageId: string; newName: string }
  | { op: "delete"; passageId: string }

const oneLine = z.string().min(1).regex(/^[^\r\n]+$/, "one line")

/** The edit list as river-mcp's story_batch_edit and writing_write take it. */
export const StoryEditSchema = z.discriminatedUnion("op", [
  z.object({ op: z.literal("write"), passageId: z.string().min(1), rawText: z.string() }),
  z.object({ op: z.literal("add"), name: oneLine, rawText: z.string(), tags: z.array(z.string().regex(/^[^\s[\]]+$/, "no spaces or brackets")).optional() }),
  z.object({ op: z.literal("rename"), passageId: z.string().min(1), newName: oneLine }),
  z.object({ op: z.literal("delete"), passageId: z.string().min(1) }),
])
export const StoryEditsSchema = z.array(StoryEditSchema).min(1).max(64)

const escapeHeaderPart = (s: string) => s.replace(/[\\[\]{}]/g, (c) => `\\${c}`)

/** A new passage named `name` with `rawText` (no :: header), parsed as river-mcp's story_add_passage parses it. */
export function newPassage(name: string, tags: readonly string[], rawText: string, file: string): Passage {
  if (/[\r\n]/.test(name)) throw new Error("a passage name is one line")
  const header = `:: ${escapeHeaderPart(name)}${tags.length > 0 ? ` [${tags.map(escapeHeaderPart).join(" ")}]` : ""}`
  // A body line starting with "::" would start another passage.
  const body = rawText.replace(/\r\n?/g, "\n").split("\n").map((l) => (l.startsWith("::") ? `\\${l}` : l)).join("\n")
  const passage = parseTwee3(`${header}\n${body}\n`, file).story.passages[0]
  if (!passage) throw new Error(`could not read the new passage ${JSON.stringify(name)}`)
  return passage
}

/** Where an edit failed, for an error the agent or user can act on. */
function at(i: number, edit: StoryEdit, err: unknown): Error {
  const what = edit.op === "add" ? `add "${edit.name}"` : `${edit.op} ${edit.passageId}`
  return new Error(`edit ${i + 1} (${what}): ${err instanceof Error ? err.message : String(err)}`)
}

/**
 * Apply `edits` in order to `story`. Returns a new Story; the input is not changed. Throws on the first edit that
 * cannot apply (an unknown passage, a name or id taken), naming the edit.
 */
export function applyStoryEdits(story: Story, edits: readonly StoryEdit[]): Story {
  let next = story
  for (const [i, edit] of edits.entries()) {
    try {
      switch (edit.op) {
        case "write":
          next = updatePassageText(next, edit.passageId, edit.rawText)
          break
        case "add":
          next = addPassage(next, newPassage(edit.name, edit.tags ?? [], edit.rawText, next.file))
          break
        case "rename":
          next = renamePassage(next, edit.passageId, edit.newName)
          break
        case "delete":
          next = deletePassage(next, edit.passageId)
          break
      }
    } catch (err) {
      throw at(i, edit, err)
    }
  }
  return next
}

/** Ids of the passages that are in `after` and were written, added or renamed by `edits` (for previews). */
export function touchedPassages(after: Story, edits: readonly StoryEdit[]): Passage[] {
  const out: Passage[] = []
  const add = (p: Passage | undefined) => {
    if (p && !out.includes(p)) out.push(p)
  }
  for (const edit of edits) {
    if (edit.op === "write" || edit.op === "rename") add(passageById(after, edit.passageId))
    else if (edit.op === "add") add(after.passages.find((p) => p.name === edit.name))
  }
  return out
}
