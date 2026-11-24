import { parsePassage, rewriteLinks, ruleBlockEnd, slugify } from "./passage"
import { RETURN_TARGET } from "./types"
import type { Passage, Story } from "./types"

/** "Pond!" -> "pond", "Long path" -> "long_path". Lowercase, [a-z0-9_] only. */
export function slug(name: string): string {
  return slugify(name)
}

/**
 * Lookups over one story, built once in O(passages + choices) so analyses do not scan the passage list per link.
 * Name and id lookups are first-wins, like `resolveTarget`. `incoming` and `outgoing` are keyed by passage id and
 * cover content passages; a broken link has `to: null`, a `@return` choice `to: "@return"`.
 * An index describes the story it was built from: build a new one after an edit.
 */
export interface StoryIndex {
  byName: Map<string, Passage>
  byId: Map<string, Passage>
  incoming: Map<string, { from: Passage; choiceIndex: number }[]>
  outgoing: Map<string, { to: Passage | typeof RETURN_TARGET | null; choiceIndex: number }[]>
}

export function createStoryIndex(story: Story): StoryIndex {
  const byName = new Map<string, Passage>()
  const byId = new Map<string, Passage>()
  for (const p of story.passages) {
    if (!byName.has(p.name)) byName.set(p.name, p)
    if (!byId.has(p.id)) byId.set(p.id, p)
  }
  const index: StoryIndex = { byName, byId, incoming: new Map(), outgoing: new Map() }
  for (const p of story.passages) {
    if (isCodePassage(p)) continue
    const out: { to: Passage | typeof RETURN_TARGET | null; choiceIndex: number }[] = []
    p.choices.forEach((c, choiceIndex) => {
      const to = c.target === RETURN_TARGET ? RETURN_TARGET : (byName.get(c.target) ?? byId.get(c.target) ?? null)
      out.push({ to, choiceIndex })
      if (to && to !== RETURN_TARGET) {
        const list = index.incoming.get(to.id)
        if (list) list.push({ from: p, choiceIndex })
        else index.incoming.set(to.id, [{ from: p, choiceIndex }])
      }
    })
    if (!index.outgoing.has(p.id)) index.outgoing.set(p.id, out)
  }
  return index
}

/** Find the passage a choice target names: by name first, then by id. Pass an index to look up in O(1). */
export function resolveTarget(story: Story, target: string, index?: StoryIndex): Passage | undefined {
  if (index) return index.byName.get(target) ?? index.byId.get(target)
  return story.passages.find((p) => p.name === target) ?? story.passages.find((p) => p.id === target)
}

/** Where a choice leads: a passage, back to the passage an interrupt interrupted, or nowhere (a broken link). */
export type ChoiceTarget = { kind: "passage"; passage: Passage } | { kind: "return" } | { kind: "missing" }

export function choiceTarget(story: Story, target: string, index?: StoryIndex): ChoiceTarget {
  if (target === RETURN_TARGET) return { kind: "return" }
  const passage = resolveTarget(story, target, index)
  return passage ? { kind: "passage", passage } : { kind: "missing" }
}

/** A passage tagged `interrupt`: the game can enter it from any passage while its @when holds. */
export function isInterrupt(p: Passage): boolean {
  return p.tags.includes("interrupt")
}

/** A passage tagged `storylet`: the game can draw it from the deck while its @when holds and it is off cooldown. */
export function isStorylet(p: Passage): boolean {
  return p.tags.includes("storylet")
}

export function passageById(story: Story, id: string, index?: StoryIndex): Passage | undefined {
  if (index) return index.byId.get(id)
  return story.passages.find((p) => p.id === id)
}

export function startPassage(story: Story, index?: StoryIndex): Passage | undefined {
  return resolveTarget(story, story.start, index)
}

function isCodePassage(p: Passage): boolean {
  return p.tags.includes("script") || p.tags.includes("stylesheet")
}

/** Passages that are story content (not [script] or [stylesheet]). */
export function contentPassages(story: Story): Passage[] {
  return story.passages.filter((p) => !isCodePassage(p))
}

function reparse(p: Passage, rawText: string, name = p.name, tags = p.tags): Passage {
  const next = parsePassage({ name, tags, metadata: p.metadata, rawText, file: p.span.file, line: p.span.line }).passage
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

function editDistance(a: string, b: string): number {
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j)
  for (let i = 1; i <= a.length; i++) {
    const row = [i]
    for (let j = 1; j <= b.length; j++) row[j] = Math.min(prev[j]! + 1, row[j - 1]! + 1, prev[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1))
    prev = row
  }
  return prev[b.length]!
}

/** "no passage with id", naming the passages the caller probably meant: a name given for an id, a case or spelling slip. */
export function noPassageError(story: Story, passageId: string): Error {
  const want = passageId.trim().toLowerCase()
  const close = story.passages.filter((p) => {
    const id = p.id.toLowerCase()
    return id === want || p.name.toLowerCase() === want || slugify(passageId) === p.id || editDistance(id, want) <= 2
  })
  const hint = close.length > 0 ? ` Did you mean ${close.slice(0, 3).map((p) => `"${p.id}" (passage ${p.name})`).join(" or ")}? Ids come from story_read.` : ""
  return new Error(`no passage with id "${passageId}".${hint}`)
}

/** Replace one passage raw text and re-parse it. Returns a new Story; the input is not changed. */
export function updatePassageText(story: Story, passageId: string, rawText: string): Story {
  const target = passageById(story, passageId)
  if (!target) throw noPassageError(story, passageId)
  return { ...story, passages: story.passages.map((p) => (p === target ? reparse(p, rawText) : p)) }
}

/**
 * Give a passage text an `@id` rule. Adds it to the top of the rules block, or adds a new
 * rules block (`@id ...` then `--`) when the text has none.
 */
function withIdRule(rawText: string, id: string): string {
  return ruleBlockEnd(rawText.split("\n")) !== undefined ? `@id ${id}\n${rawText}` : `@id ${id}\n--\n${rawText}`
}

/**
 * Rename a passage and rewrite every link to it in every other passage. Returns a new Story.
 * The passage id never changes: when the id came from the old name (no `@id` rule), an
 * `@id <old id>` rule is added, so layouts and anything else keyed by id still match.
 */
export function renamePassage(story: Story, passageId: string, newName: string): Story {
  const target = passageById(story, passageId)
  if (!target) throw noPassageError(story, passageId)
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

/** Shift StoryTitle/StoryData blocks so they stay between the same passages after the passage at `at` is removed. */
function withoutPassageAt(story: Story, at: number): Story {
  const passages = story.passages.filter((_, i) => i !== at)
  if (!story.source) return { ...story, passages }
  const blocks = story.source.blocks.map((b) => (b.index > at ? { ...b, index: b.index - 1 } : b))
  return { ...story, passages, source: { ...story.source, blocks } }
}

/**
 * Add a passage at the end of the story. Returns a new Story; the input is not changed. Throws when another
 * passage already has the passage's name or id.
 */
export function addPassage(story: Story, passage: Passage): Story {
  if (story.passages.some((p) => p.name === passage.name)) throw new Error(`a passage named "${passage.name}" already exists`)
  if (story.passages.some((p) => p.id === passage.id)) throw new Error(`a passage with id "${passage.id}" already exists`)
  return { ...story, passages: [...story.passages, passage] }
}

/**
 * Remove a passage by id. Links to it are left as written (lint reports them as broken). Returns a new Story;
 * StoryTitle and StoryData keep their place in the file.
 */
export function deletePassage(story: Story, passageId: string): Story {
  const at = story.passages.findIndex((p) => p.id === passageId)
  if (at < 0) throw noPassageError(story, passageId)
  return withoutPassageAt(story, at)
}

/**
 * Replace a passage's tags and re-parse it (a [script] or [stylesheet] tag changes how its text is read).
 * Returns the same Story when the tags are unchanged, else a new Story.
 */
export function updatePassageTags(story: Story, passageId: string, tags: string[]): Story {
  const target = passageById(story, passageId)
  if (!target) throw noPassageError(story, passageId)
  if (target.tags.length === tags.length && target.tags.every((t, i) => t === tags[i])) return story
  const next = reparse(target, target.rawText, target.name, [...tags])
  return { ...story, passages: story.passages.map((p) => (p === target ? next : p)) }
}
