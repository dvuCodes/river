import { afterChoice, openChoices, type ChoiceState } from "../story/choice"
import { applyEffects, evalCond, formatCond, initialState } from "../story/cond"
import { choiceTarget, contentPassages, isInterrupt, resolveTarget, startPassage } from "../story/model"
import type { GameState, Passage, StateSchema, Story } from "../story/types"

export interface PlayStep {
  passageId: string
  /** State after the passage onEnter effects. */
  state: GameState
  /** Set inside an interrupt: the passage a `@return` choice goes back to. */
  returnTo?: string
}

export interface Playtest {
  current(): Passage
  state(): GameState
  /** All choices of the current passage. A closed one says why: its @when, its @cost, or its target's @when on arrival. */
  choices(): ChoiceState[]
  /**
   * Apply cost and set, move to the target, apply its onEnter. A `@return` choice goes back to the passage the
   * interrupt started from, without running that passage's rules again. Throws if the choice is closed or broken.
   */
  choose(index: number): void
  /** The interrupt passages, and whether each can start now: its @when holds and no interrupt is already running. */
  interrupts(): { passage: Passage; open: boolean }[]
  /** Start an interrupt passage (by name or id) from the current passage. */
  interrupt(name: string): void
  /** Set one variable by hand (the playtest state panel). Checks the type against the schema. */
  setVar(name: string, value: number | string | boolean): void
  undo(): void
  history(): PlayStep[]
  isOver(): boolean
}

/** Names of all passages, for "no passage named" errors. */
function known(story: Story): string {
  const names = contentPassages(story).map((p) => JSON.stringify(p.name))
  return names.length > 12 ? `${names.slice(0, 12).join(", ")}, ...` : names.join(", ")
}

export function createPlaytest(story: Story, schema: StateSchema, opts?: { from?: string; state?: GameState }): Playtest {
  const first = opts?.from !== undefined ? resolveTarget(story, opts.from) : startPassage(story)
  if (!first) {
    throw new Error(opts?.from !== undefined ? `no passage named "${opts.from}" (passages: ${known(story)})` : `start passage "${story.start}" does not exist`)
  }
  const byId = new Map(story.passages.map((p) => [p.id, p]))
  const start = { ...initialState(schema), ...(opts?.state ?? {}) }
  const steps: PlayStep[] = [{ passageId: first.id, state: applyEffects(start, first.onEnter, schema) }]
  const ctx = { story, schema }

  const top = () => steps[steps.length - 1]!
  const current = () => byId.get(top().passageId) ?? first
  const push = (passageId: string, state: GameState, returnTo: string | undefined) =>
    steps.push(returnTo === undefined ? { passageId, state } : { passageId, state, returnTo })
  const interruptOpen = (p: Passage) => top().returnTo === undefined && (!p.when || evalCond(p.when, top().state))

  return {
    current,
    state: () => ({ ...top().state }),
    choices: () => openChoices(current(), top().state, ctx),
    choose(index) {
      const entry = openChoices(current(), top().state, ctx)[index]
      if (!entry) throw new Error(`no choice ${index}`)
      const { choice } = entry
      if (entry.closed) {
        const c = entry.closed
        const why = c.by === "target" ? `${c.target.name} needs ${formatCond(c.cond)} on arrival` : c.by === "cost" ? `its @cost needs ${formatCond(c.cond)}` : `its @when ${formatCond(c.cond)} is false`
        throw new Error(`choice "${choice.label}" is closed: ${why}`)
      }
      const to = choiceTarget(story, choice.target)
      const s = afterChoice(top().state, choice, schema)
      if (to.kind === "return") {
        const back = top().returnTo
        if (back === undefined) throw new Error(`choice "${choice.label}" returns, but no interrupt is running`)
        push(back, s, undefined)
        return
      }
      if (to.kind === "missing") throw new Error(`choice "${choice.label}" links to "${choice.target}", which does not exist`)
      push(to.passage.id, applyEffects(s, to.passage.onEnter, schema), top().returnTo)
    },
    interrupts: () => contentPassages(story).filter(isInterrupt).map((passage) => ({ passage, open: interruptOpen(passage) })),
    interrupt(name) {
      const p = resolveTarget(story, name)
      if (!p || !isInterrupt(p)) throw new Error(`no interrupt passage named "${name}"`)
      if (top().returnTo !== undefined) throw new Error(`an interrupt is already running; take its @return choice first`)
      if (!interruptOpen(p)) throw new Error(`${p.name} cannot start: its @when ${formatCond(p.when!)} is false`)
      push(p.id, applyEffects(top().state, p.onEnter, schema), current().id)
    },
    setVar(name, value) {
      const decl = schema[name]
      if (!decl) throw new Error(`unknown variable "${name}"`)
      switch (decl.type) {
        case "number":
        case "int":
          if (typeof value !== "number" || Number.isNaN(value)) throw new Error(`${name} is a ${decl.type}`)
          if (decl.type === "int" && !Number.isInteger(value)) throw new Error(`${name} is an int`)
          if ((decl.min !== undefined && value < decl.min) || (decl.max !== undefined && value > decl.max)) {
            throw new Error(`${name} must be between ${decl.min ?? "-inf"} and ${decl.max ?? "inf"}`)
          }
          break
        case "bool":
          if (typeof value !== "boolean") throw new Error(`${name} is a bool`)
          break
        case "enum":
          if (typeof value !== "string" || !decl.values.includes(value)) throw new Error(`${name} must be one of ${decl.values.join(", ")}`)
          break
      }
      const t = top()
      steps[steps.length - 1] = { ...t, state: { ...t.state, [name]: value } }
    },
    undo() {
      if (steps.length > 1) steps.pop()
    },
    history: () => steps.map((s) => ({ ...s, state: { ...s.state } })),
    isOver() {
      const p = current()
      if (p.isEnding) return true
      return !openChoices(p, top().state, ctx).some((c) => {
        const to = choiceTarget(story, c.choice.target)
        return c.open && (to.kind === "passage" || (to.kind === "return" && top().returnTo !== undefined))
      })
    },
  }
}
