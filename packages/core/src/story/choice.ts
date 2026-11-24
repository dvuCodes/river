/**
 * When a choice is open, the one rule play, paths, lint and the export share:
 * 1. its @when holds and the player can pay every @cost, on the state before the choice;
 * 2. the @cost, then the @set, run;
 * 3. the target passage's @when holds on that state;
 * 4. the target's own @set runs.
 */
import { applyEffects, evalCond, formatCond } from "./cond"
import { choiceTarget, type StoryIndex } from "./model"
import type { Choice, Cond, GameState, Passage, StateSchema, Story } from "./types"

/** What a choice's @cost needs: `@cost treats 1` needs `treats >= 1`. Undefined when it costs nothing. */
export function costCond(choice: Choice): Cond | undefined {
  const need = new Map<string, number>()
  for (const e of choice.cost) {
    if (e.op === "add" && typeof e.amount === "number") need.set(e.variable, (need.get(e.variable) ?? 0) - e.amount)
  }
  const terms: Cond[] = [...need].filter(([, n]) => n > 0).map(([variable, n]) => ({ kind: "cmp", variable, op: ">=", value: n }))
  return terms.length === 0 ? undefined : terms.length === 1 ? terms[0] : { kind: "and", terms }
}

/** Step 1 as one condition: the choice's @when and what its @cost needs. Undefined when the choice has neither. */
export function choiceGuard(choice: Choice): Cond | undefined {
  const cost = costCond(choice)
  if (!choice.when) return cost
  if (!cost) return choice.when
  return { kind: "and", terms: [choice.when, cost] }
}

/** Steps 2 and 3's state: after the choice's @cost, then its @set. */
export function afterChoice(state: GameState, choice: Choice, schema: StateSchema): GameState {
  return applyEffects(applyEffects(state, choice.cost, schema), choice.set, schema)
}

/** Why a choice is closed: its own @when, a @cost the player cannot pay, or the target's @when on arrival. */
export type ClosedBy =
  | { by: "when"; cond: Cond }
  | { by: "cost"; cond: Cond }
  | { by: "target"; cond: Cond; target: Passage }
  /** A `@once` choice the player already took. */
  | { by: "once" }

/** "coins >= 5", "@cost needs coins >= 5", "Vault needs coins >= 5 on arrival". */
export function formatClosed(c: ClosedBy): string {
  switch (c.by) {
    case "when": return formatCond(c.cond)
    case "cost": return `@cost needs ${formatCond(c.cond)}`
    case "target": return `${c.target.name} needs ${formatCond(c.cond)} on arrival`
    case "once": return "already chosen"
  }
}

export interface ChoiceState {
  choice: Choice
  index: number
  open: boolean
  /** Set when open is false. */
  closed?: ClosedBy
}

/** The key a taken `@once` choice is remembered by: "<passage id>#<choice index>". */
export const onceKey = (passageId: string, choiceIndex: number) => `${passageId}#${choiceIndex}`

export interface ChoiceContext {
  story: Story
  schema: StateSchema
  /** Passage id -> times entered, for `visited(id)` / `visits(id)`. Default: none. */
  visits?: Readonly<Record<string, number>>
  /** `onceKey`s of the `@once` choices already taken. */
  usedOnce?: readonly string[]
  /** Lookups for the story, when the caller has built them. */
  index?: StoryIndex
}

/**
 * Which choices of a passage are open in a state. Without `ctx` only the choice's own @when and @cost count;
 * with the story and schema, a choice whose target's @when fails after its @cost and @set is closed too, and a
 * `@once` choice listed in `ctx.usedOnce` is closed.
 */
export function openChoices(passage: Passage, state: GameState, ctx?: ChoiceContext): ChoiceState[] {
  return passage.choices.map((choice, index) => {
    const closed = closedBy(passage, choice, index, state, ctx)
    return closed ? { choice, index, open: false, closed } : { choice, index, open: true }
  })
}

function closedBy(passage: Passage, choice: Choice, index: number, state: GameState, ctx?: ChoiceContext): ClosedBy | undefined {
  const visits = ctx?.visits ?? {}
  if (choice.once && ctx?.usedOnce?.includes(onceKey(passage.id, index))) return { by: "once" }
  if (choice.when && !evalCond(choice.when, state, visits)) return { by: "when", cond: choice.when }
  const cost = costCond(choice)
  if (cost && !evalCond(cost, state)) return { by: "cost", cond: cost }
  if (!ctx) return undefined
  const to = choiceTarget(ctx.story, choice.target, ctx.index)
  if (to.kind !== "passage" || !to.passage.when) return undefined
  // Like the rest of the target's rules, its @when runs before it is entered: visit counts do not include this entry yet.
  return evalCond(to.passage.when, afterChoice(state, choice, ctx.schema), visits) ? undefined : { by: "target", cond: to.passage.when, target: to.passage }
}
