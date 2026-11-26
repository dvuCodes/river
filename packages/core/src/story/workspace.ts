/**
 * Multi-file cross-story workspaces.
 *
 * A link target written `StoryName::PassageName` (e.g. `[[Head to Chapter 2->chapter2::Gate]]` or
 * `[[chapter2::Gate]]`) references a passage in another story file within the same workspace.
 */
import { lint } from "../lint/lint"
import {
  contentPassages,
  createStoryIndex,
  isInterrupt,
  isStorylet,
  resolveTarget,
  startPassage,
  type StoryIndex,
} from "./model"
import { isExternalTarget } from "./passage"
import { RETURN_TARGET } from "./types"
import type { Diagnostic, Passage, StateSchema, Story } from "./types"

export interface CrossStoryTarget {
  story: string
  target: string
}

/**
 * Parse a cross-story link target (`StoryRef::PassageRef`).
 * Splits on the first `::` when both sides are non-empty after trimming.
 * Never triggers on external URLs (`http://`, `https://`, ...) or `@return`.
 */
export function parseCrossStoryTarget(target: string): CrossStoryTarget | undefined {
  if (target === RETURN_TARGET || isExternalTarget(target)) return undefined
  const sep = target.indexOf("::")
  if (sep < 0) return undefined
  const story = target.slice(0, sep).trim()
  const passage = target.slice(sep + 2).trim()
  if (story === "" || passage === "") return undefined
  return { story, target: passage }
}

export interface WorkspaceStoryInput {
  file: string
  id: string
  story: Story
}

export interface WorkspaceStory extends WorkspaceStoryInput {
  index: StoryIndex
}

export interface StoryWorkspace {
  stories: WorkspaceStory[]
  byId: Map<string, WorkspaceStory>
  byFile: Map<string, WorkspaceStory>
  byTitle: Map<string, WorkspaceStory>
}

function normPath(file: string): string {
  return file.replace(/\\/g, "/")
}

/** Index a set of stories by `id`, relative `file`, and `story.title` for cross-story resolution and linting. */
export function loadStoryWorkspace(stories: readonly WorkspaceStoryInput[]): StoryWorkspace {
  const byId = new Map<string, WorkspaceStory>()
  const byFile = new Map<string, WorkspaceStory>()
  const byTitle = new Map<string, WorkspaceStory>()
  const entries: WorkspaceStory[] = []

  for (const input of stories) {
    const entry: WorkspaceStory = { ...input, index: createStoryIndex(input.story) }
    entries.push(entry)
    if (!byId.has(entry.id)) byId.set(entry.id, entry)
    const nf = normPath(entry.file)
    if (!byFile.has(nf)) byFile.set(nf, entry)
    if (entry.file !== nf && !byFile.has(entry.file)) byFile.set(entry.file, entry)
    if (entry.story.title && !byTitle.has(entry.story.title)) byTitle.set(entry.story.title, entry)
  }

  return { stories: entries, byId, byFile, byTitle }
}

function lookupStory(ws: StoryWorkspace, ref: string): WorkspaceStory | undefined {
  return ws.byId.get(ref) ?? ws.byFile.get(normPath(ref)) ?? ws.byFile.get(ref) ?? ws.byTitle.get(ref)
}

export type WorkspaceTarget =
  | { kind: "local" | "cross"; storyId: string; passage: Passage }
  | { kind: "return" }
  | { kind: "missing"; storyId?: string }

/**
 * Resolve a choice target from `fromStoryId` inside `ws`.
 * Cross-story targets (`story::passage`) resolve against `ws.byId`, `ws.byFile`, then `ws.byTitle`.
 */
export function resolveWorkspaceTarget(ws: StoryWorkspace, fromStoryId: string, target: string): WorkspaceTarget {
  if (target === RETURN_TARGET) return { kind: "return" }
  const cross = parseCrossStoryTarget(target)
  if (cross) {
    const dest = lookupStory(ws, cross.story)
    if (!dest) return { kind: "missing" }
    const passage = resolveTarget(dest.story, cross.target, dest.index)
    if (!passage) return { kind: "missing", storyId: dest.id }
    return { kind: "cross", storyId: dest.id, passage }
  }
  const from = lookupStory(ws, fromStoryId)
  if (!from) return { kind: "missing" }
  const passage = resolveTarget(from.story, target, from.index)
  if (!passage) return { kind: "missing", storyId: from.id }
  return { kind: "local", storyId: from.id, passage }
}

/**
 * Compute all passages reachable across the workspace starting from every story's start passage,
 * `[interrupt]`s, and `[storylet]`s, following both local and cross-story links.
 */
function workspaceReachable(ws: StoryWorkspace): Map<string, Set<string>> {
  const seen = new Map<string, Set<string>>()
  const queue: { storyId: string; passage: Passage }[] = []

  const mark = (storyId: string, passage: Passage) => {
    let set = seen.get(storyId)
    if (!set) { set = new Set(); seen.set(storyId, set) }
    if (set.has(passage.id)) return
    set.add(passage.id)
    queue.push({ storyId, passage })
  }

  for (const entry of ws.stories) {
    const start = startPassage(entry.story, entry.index)
    if (start) mark(entry.id, start)
    for (const p of contentPassages(entry.story)) {
      if (isInterrupt(p) || isStorylet(p)) mark(entry.id, p)
    }
  }

  for (let head = 0; head < queue.length; head++) {
    const cur = queue[head]!
    for (const c of cur.passage.choices) {
      const to = resolveWorkspaceTarget(ws, cur.storyId, c.target)
      if (to.kind === "local" || to.kind === "cross") mark(to.storyId, to.passage)
    }
  }

  return seen
}

/**
 * Lint a single story with workspace awareness:
 * - Suppresses `broken-link` diagnostics for cross-story links that resolve in `ws`.
 * - Replaces unresolved cross-story `broken-link` diagnostics with `broken-cross-link`.
 * - Suppresses `unreachable` diagnostics for passages reachable via cross-story links in `ws`.
 */
export function lintStoryInWorkspace(
  ws: StoryWorkspace,
  storyId: string,
  story: Story,
  schema: StateSchema,
  reachableByStory?: Map<string, Set<string>>,
): Diagnostic[] {
  const base = lint(story, schema)
  const reach = reachableByStory ?? workspaceReachable(ws)
  const reachedIds = reach.get(storyId)

  // Map each cross-story broken-link choice by passageId + line + column + target message.
  const crossByKey = new Map<string, { passage: Passage; target: string; cross: CrossStoryTarget; span: Passage["span"] }>()
  for (const p of contentPassages(story)) {
    for (const c of p.choices) {
      const cross = parseCrossStoryTarget(c.target)
      if (!cross) continue
      const key = `${p.id}\0${c.span.line}\0${c.span.column}\0${p.name} → ${c.target}: no passage has this name`
      crossByKey.set(key, { passage: p, target: c.target, cross, span: c.span })
    }
  }

  const out: Diagnostic[] = []
  for (const d of base) {
    if (d.code === "unreachable" && d.passageId && reachedIds?.has(d.passageId)) {
      continue
    }
    if (d.code === "broken-link" && d.passageId && d.span) {
      const key = `${d.passageId}\0${d.span.line}\0${d.span.column}\0${d.message}`
      const info = crossByKey.get(key)
      if (info) {
        const res = resolveWorkspaceTarget(ws, storyId, info.target)
        if (res.kind === "cross" || res.kind === "local") continue
        const msg =
          res.kind === "missing" && res.storyId !== undefined
            ? `${info.passage.name} → ${info.cross.story}::${info.cross.target}: no passage "${info.cross.target}" in story "${info.cross.story}"`
            : `${info.passage.name} → ${info.cross.story}::${info.cross.target}: no story "${info.cross.story}"`
        out.push({
          severity: "error",
          code: "broken-cross-link",
          message: msg,
          passageId: d.passageId,
          span: d.span,
        })
        continue
      }
    }
    out.push(d)
  }

  return out
}

/** Lint every story in a workspace with cross-story link resolution and cross-story reachability. */
export function lintWorkspace(
  ws: StoryWorkspace,
  schema: StateSchema,
): { file: string; diagnostics: Diagnostic[] }[] {
  const reach = workspaceReachable(ws)
  return ws.stories.map((entry) => ({
    file: entry.file,
    diagnostics: lintStoryInWorkspace(ws, entry.id, entry.story, schema, reach),
  }))
}
