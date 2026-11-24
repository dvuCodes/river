import { lint } from "../lint/lint"
import { hasStructuredBlocks, parseProseBlocks, type ProseBlock } from "../story/blocks"
import { choiceTarget, contentPassages, createStoryIndex, isInterrupt, isStorylet, startPassage } from "../story/model"
import { proseText } from "../story/prose"
import { RETURN_TARGET } from "../story/types"
import type { Cond, Cue, Effect, MetaValue, StateSchema, Story } from "../story/types"
import { lintStoryInWorkspace, resolveWorkspaceTarget, type StoryWorkspace } from "../story/workspace"

export { proseText }

/**
 * What a game engine loads. Version 1. Engines never parse Twee. A choice is open when its `when` holds, the
 * player can pay every `cost` (a cost of -n on a variable needs it at n or more), and the target's `when` holds
 * after `cost` then `set`. Effects with op "mul" multiply (`/= 4` is mul 0.25); numbers clamp to the `state`
 * range and int variables drop the fraction. A variable with `engine: true` is one the game moves itself.
 *
 * Optional additions, present only when the story uses them (an engine that ignores them still plays the story):
 * passage `meta`, `shot`, `cues`, `blocks`, `storylet`, `weight`, `priority`, `cooldown` and `auto`; choice `once`, `meta` and `cues`. A condition may hold
 * `{ kind: "visit", passageId, op, value }`: how many times the player entered that passage before now (a passage's
 * own `when` is checked before its entry is counted; returning from an interrupt is not an entry). `text` may hold
 * inline templates (`{when cond: a | b}`, `{var}`, `{once: ...}`, `{cycle: a | b}`, `{shuffle: a | b}`).
 */
export interface ExportedStory {
  schema: 1
  id: string
  title: string
  /** Start passage id. */
  start: string
  state: StateSchema
  passages: Record<string, {
    name: string
    tags: string[]
    when?: Cond
    onEnter: Effect[]
    ending: boolean
    /** True for a passage tagged `interrupt`: the game may enter it from any passage while its `when` holds. */
    interrupt?: true
    /** True for a passage tagged `storylet`: the game may draw it from the deck while its `when` holds and it is off cooldown. */
    storylet?: true
    /** Storylet draw weight among the open storylets of the top priority. Absent means 1. */
    weight?: number
    /** Higher goes first, for storylet draws and auto interrupts. Absent means 0. */
    priority?: number
    /** Turns (choices and draws) before a storylet can be drawn again. */
    cooldown?: number
    /** On an interrupt: the game starts it by itself after a choice, as soon as its `when` holds. */
    auto?: true
    /** Prose without rule lines, link lines and `@cue` lines. */
    text: string
    /** `to` is a passage id, or "@return": go back to the passage the running interrupt started from. */
    choices: {
      label: string
      to: string
      cost: Effect[]
      set: Effect[]
      when?: Cond
      hint?: string
      /** The choice closes once taken. */
      once?: true
      meta?: Record<string, MetaValue>
      cues?: Cue[]
    }[]
    meta?: Record<string, MetaValue>
    /** The manifest shot that shows this passage. */
    shot?: string
    /** Cues to fire on entry. */
    cues?: Cue[]
    /** The prose as dialogue, narration, cue and beat blocks; present only when it has more than narration. */
    blocks?: ProseBlock[]
  }>
}

export interface ExportStoryOptions {
  /** Optional multi-story workspace for resolving cross-story links (`story::passage`). */
  workspace?: StoryWorkspace
}

/** Throws if lint reports any error. Choice targets become passage ids (or `<storyId>::<passageId>` for cross-story links). */
export function exportStory(story: Story, schema: StateSchema, id: string, opts?: ExportStoryOptions): ExportedStory {
  const workspace = opts?.workspace
  const diagnostics = workspace ? lintStoryInWorkspace(workspace, id, story, schema) : lint(story, schema)
  const errors = diagnostics.filter((d) => d.severity === "error")
  if (errors.length > 0) {
    const lines = errors.map((d) => `  ${d.span ? `${d.span.file}:${d.span.line}: ` : ""}${d.message}`)
    throw new Error(`cannot export ${story.file}: ${errors.length} lint error${errors.length === 1 ? "" : "s"}\n${lines.join("\n")}`)
  }
  const index = createStoryIndex(story)
  const start = startPassage(story, index)!
  const passages: ExportedStory["passages"] = {}
  for (const p of contentPassages(story)) {
    const blocks = parseProseBlocks(proseText(p.text, { keepCues: true }))
    passages[p.id] = {
      name: p.name,
      tags: [...p.tags],
      ...(p.when ? { when: p.when } : {}),
      onEnter: p.onEnter,
      ending: p.isEnding,
      ...(isInterrupt(p) ? { interrupt: true as const } : {}),
      ...(isStorylet(p) ? { storylet: true as const } : {}),
      ...(p.weight !== undefined ? { weight: p.weight } : {}),
      ...(p.priority !== undefined ? { priority: p.priority } : {}),
      ...(p.cooldown !== undefined ? { cooldown: p.cooldown } : {}),
      ...(p.auto ? { auto: true as const } : {}),
      text: proseText(p.text),
      choices: p.choices.map((c) => {
        const to = choiceTarget(story, c.target, index)
        let targetId: string
        if (to.kind === "passage") {
          targetId = to.passage.id
        } else if (to.kind === "return") {
          targetId = RETURN_TARGET
        } else if (workspace) {
          const wsTo = resolveWorkspaceTarget(workspace, id, c.target)
          targetId = wsTo.kind === "cross" || wsTo.kind === "local" ? `${wsTo.storyId}::${wsTo.passage.id}` : RETURN_TARGET
        } else {
          // lint has no errors, so every target exists.
          targetId = RETURN_TARGET
        }
        return {
          label: c.label,
          to: targetId,
          cost: c.cost,
          set: c.set,
          ...(c.when ? { when: c.when } : {}),
          ...(c.hint !== undefined ? { hint: c.hint } : {}),
          ...(c.once ? { once: true as const } : {}),
          ...(c.meta ? { meta: c.meta } : {}),
          ...(c.cues && c.cues.length > 0 ? { cues: c.cues } : {}),
        }
      }),
      ...(p.meta ? { meta: p.meta } : {}),
      ...(p.shot !== undefined ? { shot: p.shot } : {}),
      ...(p.cues && p.cues.length > 0 ? { cues: p.cues } : {}),
      ...(hasStructuredBlocks(blocks) ? { blocks } : {}),
    }
  }
  return { schema: 1, id, title: story.title, start: start.id, state: schema, passages }
}
