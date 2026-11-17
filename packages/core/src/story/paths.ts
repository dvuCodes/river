import { satisfiable } from "../lint/sat"
import { evalCond } from "./cond"
import { resolveTarget, startPassage } from "./model"
import type { Choice, Cond, GameState, Passage, PathStep, StateSchema, Story, StoryPath } from "./types"

export interface PathOptions {
  /** Start passage name. Default: the story start. */
  from?: string
  /** Stop after this many paths. Default 500. */
  maxPaths?: number
}

/**
 * Every route from the start to an ending, a dead end or a loop. A passage appears at most once per route.
 *
 * - "ending": the passage has @end.
 * - "dead-end": no @end and no choice that leads to an existing passage.
 * - "loop": the next choice leads back to a passage already on the route (the repeated passage is the last step).
 * Choices with broken links are skipped (lint reports them).
 *
 * `satisfiable` checks the conjunction of every condition on the route against the schema
 * ranges. Version 1 ignores the effects applied along the route.
 */
export function paths(story: Story, schema: StateSchema, opts?: PathOptions): StoryPath[] {
  const maxPaths = opts?.maxPaths ?? 500
  const first = opts?.from !== undefined ? resolveTarget(story, opts.from) : startPassage(story)
  if (!first) return []
  const out: StoryPath[] = []

  const emit = (steps: PathStep[], conditions: Cond[], end: StoryPath["end"]) => {
    out.push({ steps: steps.map((s) => ({ ...s })), conditions: [...conditions], end, satisfiable: satisfiable(conditions, schema) })
  }

  const visit = (p: Passage, steps: PathStep[], conditions: Cond[], onRoute: Set<Passage>) => {
    if (out.length >= maxPaths) return
    const conds = p.when ? [...conditions, p.when] : conditions
    const here: PathStep = { passageId: p.id }
    if (p.isEnding) return emit([...steps, here], conds, "ending")
    const live = p.choices
      .map((choice, index) => ({ choice, index, target: resolveTarget(story, choice.target) }))
      .filter((c): c is { choice: Choice; index: number; target: Passage } => c.target !== undefined)
    if (live.length === 0) return emit([...steps, here], conds, "dead-end")
    onRoute.add(p)
    for (const { choice, index, target } of live) {
      if (out.length >= maxPaths) break
      const nextSteps = [...steps, { passageId: p.id, choiceIndex: index }]
      const nextConds = choice.when ? [...conds, choice.when] : conds
      if (onRoute.has(target)) emit([...nextSteps, { passageId: target.id }], nextConds, "loop")
      else visit(target, nextSteps, nextConds, onRoute)
    }
    onRoute.delete(p)
  }

  visit(first, [], [], new Set())
  return out
}

/** Which choices of a passage are open in a given state. */
export function openChoices(passage: Passage, state: GameState): { choice: Choice; index: number; open: boolean }[] {
  return passage.choices.map((choice, index) => ({ choice, index, open: choice.when ? evalCond(choice.when, state) : true }))
}
