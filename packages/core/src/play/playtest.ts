import { applyEffects, initialState } from "../story/cond"
import { resolveTarget, startPassage } from "../story/model"
import { openChoices } from "../story/paths"
import type { Choice, GameState, Passage, StateSchema, Story } from "../story/types"

export interface PlayStep {
  passageId: string
  /** State after the passage onEnter effects. */
  state: GameState
}

export interface Playtest {
  current(): Passage
  state(): GameState
  /** All choices of the current passage, with open = false when its @when fails. */
  choices(): { choice: Choice; index: number; open: boolean }[]
  /** Apply cost and set, move to the target, apply its onEnter. Throws if the choice is closed or broken. */
  choose(index: number): void
  /** Set one variable by hand (the playtest state panel). Checks the type against the schema. */
  setVar(name: string, value: number | string | boolean): void
  undo(): void
  history(): PlayStep[]
  isOver(): boolean
}

export function createPlaytest(story: Story, schema: StateSchema, opts?: { from?: string; state?: GameState }): Playtest {
  const first = opts?.from !== undefined ? resolveTarget(story, opts.from) : startPassage(story)
  if (!first) throw new Error(opts?.from !== undefined ? `no passage named "${opts.from}"` : `start passage "${story.start}" does not exist`)
  const byId = new Map(story.passages.map((p) => [p.id, p]))
  const start = { ...initialState(schema), ...(opts?.state ?? {}) }
  const steps: PlayStep[] = [{ passageId: first.id, state: applyEffects(start, first.onEnter, schema) }]

  const top = () => steps[steps.length - 1]!
  const current = () => byId.get(top().passageId) ?? first

  return {
    current,
    state: () => ({ ...top().state }),
    choices: () => openChoices(current(), top().state),
    choose(index) {
      const entry = openChoices(current(), top().state)[index]
      if (!entry) throw new Error(`no choice ${index}`)
      if (!entry.open) throw new Error(`choice "${entry.choice.label}" is closed`)
      const target = resolveTarget(story, entry.choice.target)
      if (!target) throw new Error(`choice "${entry.choice.label}" links to "${entry.choice.target}", which does not exist`)
      let s = applyEffects(top().state, entry.choice.cost, schema)
      s = applyEffects(s, entry.choice.set, schema)
      s = applyEffects(s, target.onEnter, schema)
      steps.push({ passageId: target.id, state: s })
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
      steps[steps.length - 1] = { passageId: t.passageId, state: { ...t.state, [name]: value } }
    },
    undo() {
      if (steps.length > 1) steps.pop()
    },
    history: () => steps.map((s) => ({ passageId: s.passageId, state: { ...s.state } })),
    isOver() {
      const p = current()
      if (p.isEnding) return true
      return !openChoices(p, top().state).some((c) => c.open && resolveTarget(story, c.choice.target))
    },
  }
}
