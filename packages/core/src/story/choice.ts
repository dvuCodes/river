/**
 * When a choice is open, the one rule play, paths, lint and the export share:
 * 1. its @when holds and the player can pay every @cost, on the state before the choice;
 * 2. the @cost, then the @set, run;
 * 3. the target passage's @when holds on that state;
 * 4. the target's own @set runs.
 */
import { applyEffects, evalCond, formatCond } from "./cond"
import { choiceTarget } from "./model"
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
export type ClosedBy = { by: "when"; cond: Cond } | { by: "cost"; cond: Cond } | { by: "target"; cond: Cond; target: Passage }

/** "coins >= 5", "@cost needs coins >= 5", "Vault needs coins >= 5 on arrival". */
export function formatClosed(c: ClosedBy): string {
  switch (c.by) {
    case "when": return formatCond(c.cond)
    case "cost": return `@cost needs ${formatCond(c.cond)}`
    case "target": return `${c.target.name} needs ${formatCond(c.cond)} on arrival`
  }
}

export interface ChoiceState {
  choice: Choice
  index: number
  open: boolean
  /** Set when open is false. */
  closed?: ClosedBy
}

/**
 * Which choices of a passage are open in a state. Without `ctx` only the choice's own @when and @cost count;
 * with the story and schema, a choice whose target's @when fails after its @cost and @set is closed too.
 */
export function openChoices(passage: Passage, state: GameState, ctx?: { story: Story; schema: StateSchema }): ChoiceState[] {
  return passage.choices.map((choice, index) => {
    const closed = closedBy(choice, state, ctx)
    return closed ? { choice, index, open: false, closed } : { choice, index, open: true }
  })
}

function closedBy(choice: Choice, state: GameState, ctx?: { story: Story; schema: StateSchema }): ClosedBy | undefined {
  if (choice.when && !evalCond(choice.when, state)) return { by: "when", cond: choice.when }
  const cost = costCond(choice)
  if (cost && !evalCond(cost, state)) return { by: "cost", cond: cost }
  if (!ctx) return undefined
  const to = choiceTarget(ctx.story, choice.target)
  if (to.kind !== "passage" || !to.passage.when) return undefined
  return evalCond(to.passage.when, afterChoice(state, choice, ctx.schema)) ? undefined : { by: "target", cond: to.passage.when, target: to.passage }
}
