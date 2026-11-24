import { proseText } from "../story/prose"
import { afterChoice, formatClosed, onceKey, openChoices, type ChoiceContext, type ChoiceState } from "../story/choice"
import { applyEffects, evalCond, formatCond, initialState } from "../story/cond"
import { choiceTarget, contentPassages, createStoryIndex, isInterrupt, isStorylet, resolveTarget, startPassage } from "../story/model"
import { renderProse } from "../story/template"
import type { GameState, Passage, StateSchema, Story } from "../story/types"

export interface PlayStep {
  passageId: string
  /** State after the passage onEnter effects. */
  state: GameState
  /** Set inside an interrupt: the passage a `@return` choice goes back to. */
  returnTo?: string
  /** Passage id -> times entered, this passage included. A `@return` does not count as entering. */
  visits: Record<string, number>
  /** `onceKey`s ("<passage id>#<choice index>") of the `@once` choices taken so far. */
  usedOnce: string[]
  /** Turns taken: 0 at the start, one more for each `choose()` and each `drawStorylet()`. An interrupt keeps the turn it started on. */
  turn: number
  /** Storylet passage id -> the turn its `@cooldown` ends on. It can be drawn again once `turn` reaches it. */
  cooldowns: Record<string, number>
}

/** A storylet and whether it can be drawn now. */
export interface StoryletState {
  passage: Passage
  /** Its @when holds, it is off cooldown, no detour is running and the story has not ended. */
  open: boolean
  /** `@weight`, default 1. */
  weight: number
  /** `@priority`, default 0. */
  priority: number
  /** Turns until its @cooldown ends; 0 when it is off cooldown. */
  cooldownLeft: number
}

export interface Playtest {
  current(): Passage
  state(): GameState
  /** All choices of the current passage. A closed one says why: its @when, its @cost, its target's @when on arrival, or a `@once` already taken. */
  choices(): ChoiceState[]
  /**
   * Apply cost and set, move to the target, apply its onEnter. A `@return` choice goes back to the passage the
   * interrupt started from, without running that passage's rules again. Throws if the choice is closed or broken.
   * After a move to a passage (not a `@return`), an `@auto` interrupt whose @when now holds starts by itself
   * (highest `@priority` first, then file order) as a step of its own, so one `undo()` takes back only the interrupt.
   */
  choose(index: number): void
  /** The interrupt passages, and whether each can start now: its @when holds, no interrupt is running, and the story has not ended. */
  interrupts(): { passage: Passage; open: boolean }[]
  /** Start an interrupt passage (by name or id) from the current passage. */
  interrupt(name: string): void
  /** The storylet passages, with whether each can be drawn now, its weight, priority and the turns left on its cooldown. */
  storylets(): StoryletState[]
  /**
   * Draw one open storylet: among those of the highest priority, one at random by weight (`rng` returns a number
   * in [0, 1), default Math.random). Enters it like an interrupt (a `@return` comes back here) and starts its
   * cooldown. Takes a turn. Returns the storylet, or undefined when none is open (nothing changes then).
   */
  drawStorylet(rng?: () => number): Passage | undefined
  /** Set one variable by hand (the playtest state panel). Checks the type against the schema. */
  setVar(name: string, value: number | string | boolean): void
  /** Go back one step: the state, the visit counts and the `@once` choices taken are restored with it. */
  undo(): void
  history(): PlayStep[]
  isOver(): boolean
  /** The current passage's prose (no rule, link or cue lines) with its templates filled in for this state and visit. */
  renderedText(): string
  /** Passage id -> times entered so far. */
  visits(): Record<string, number>
}

/** Names of all passages, for "no passage named" errors. */
function known(story: Story): string {
  const names = contentPassages(story).map((p) => JSON.stringify(p.name))
  return names.length > 12 ? `${names.slice(0, 12).join(", ")}, ...` : names.join(", ")
}

export function createPlaytest(story: Story, schema: StateSchema, opts?: { from?: string; state?: GameState }): Playtest {
  const index = createStoryIndex(story)
  const first = opts?.from !== undefined ? resolveTarget(story, opts.from, index) : startPassage(story, index)
  if (!first) {
    throw new Error(opts?.from !== undefined ? `no passage named "${opts.from}" (passages: ${known(story)})` : `start passage "${story.start}" does not exist`)
  }
  const start = { ...initialState(schema), ...(opts?.state ?? {}) }
  const steps: PlayStep[] = [{ passageId: first.id, state: applyEffects(start, first.onEnter, schema), visits: { [first.id]: 1 }, usedOnce: [], turn: 0, cooldowns: {} }]

  const top = () => steps[steps.length - 1]!
  const ctx = (): ChoiceContext => ({ story, schema, index, visits: top().visits, usedOnce: top().usedOnce })
  const current = () => index.byId.get(top().passageId) ?? first
  /**
   * Move to a passage. `entered` counts a visit (a `@return` does not); `once` records a `@once` choice taken;
   * `turns` is how many turns the move takes; `cooldowns` replaces the cooldowns when given.
   */
  const push = (
    passageId: string,
    state: GameState,
    returnTo: string | undefined,
    entered: boolean,
    opts?: { once?: string | undefined; turns?: number; cooldowns?: Record<string, number> },
  ) => {
    const t = top()
    const visits = entered ? { ...t.visits, [passageId]: (t.visits[passageId] ?? 0) + 1 } : { ...t.visits }
    const once = opts?.once
    const usedOnce = once !== undefined && !t.usedOnce.includes(once) ? [...t.usedOnce, once] : [...t.usedOnce]
    const turn = t.turn + (opts?.turns ?? 0)
    const cooldowns = { ...(opts?.cooldowns ?? t.cooldowns) }
    steps.push(returnTo === undefined ? { passageId, state, visits, usedOnce, turn, cooldowns } : { passageId, state, returnTo, visits, usedOnce, turn, cooldowns })
  }
  // An interrupt's @when sees the visit counts before it is entered, like every passage @when.
  const interruptOpen = (p: Passage) => top().returnTo === undefined && !current().isEnding && (!p.when || evalCond(p.when, top().state, top().visits))
  const copyStep = (s: PlayStep): PlayStep => ({ ...s, state: { ...s.state }, visits: { ...s.visits }, usedOnce: [...s.usedOnce], cooldowns: { ...s.cooldowns } })
  /** Enter a detour (interrupt or storylet) from the current passage. An ending has nowhere to return to. */
  const enterDetour = (p: Passage, turns: number, cooldowns?: Record<string, number>) =>
    push(p.id, applyEffects(top().state, p.onEnter, schema), p.isEnding ? undefined : current().id, true, cooldowns ? { turns, cooldowns } : { turns })
  // Array.prototype.sort is stable, so equal priorities keep file order.
  const autoInterrupts = contentPassages(story)
    .filter((p) => isInterrupt(p) && p.auto === true)
    .sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0))
  const storyletPassages = contentPassages(story).filter(isStorylet)
  const storyletState = (passage: Passage): StoryletState => {
    const t = top()
    const cooldownLeft = Math.max(0, (t.cooldowns[passage.id] ?? 0) - t.turn)
    const open = t.returnTo === undefined && !current().isEnding && cooldownLeft === 0 && (!passage.when || evalCond(passage.when, t.state, t.visits))
    return { passage, open, weight: passage.weight ?? 1, priority: passage.priority ?? 0, cooldownLeft }
  }

  return {
    current,
    state: () => ({ ...top().state }),
    choices: () => openChoices(current(), top().state, ctx()),
    choose(choiceIndex) {
      const here = current()
      const entry = openChoices(here, top().state, ctx())[choiceIndex]
      if (!entry) throw new Error(`no choice ${choiceIndex}`)
      const { choice } = entry
      if (entry.closed) throw new Error(`choice "${choice.label}" is closed: ${formatClosed(entry.closed)}`)
      const to = choiceTarget(story, choice.target, index)
      const s = afterChoice(top().state, choice, schema)
      const once = choice.once ? onceKey(here.id, choiceIndex) : undefined
      if (to.kind === "return") {
        const back = top().returnTo
        if (back === undefined) throw new Error(`choice "${choice.label}" returns, but no interrupt is running`)
        push(back, s, undefined, false, { once, turns: 1 })
        return
      }
      if (to.kind === "missing") throw new Error(`choice "${choice.label}" links to "${choice.target}", which does not exist`)
      push(to.passage.id, applyEffects(s, to.passage.onEnter, schema), top().returnTo, true, { once, turns: 1 })
      // interruptOpen sees the visits with the target counted, and is false inside a detour or at an ending.
      // A choice that links straight to an @auto interrupt does not start it a second time on top of itself.
      const auto = autoInterrupts.find((p) => p.id !== to.passage.id && interruptOpen(p))
      if (auto) enterDetour(auto, 0)
    },
    interrupts: () => contentPassages(story).filter(isInterrupt).map((passage) => ({ passage, open: interruptOpen(passage) })),
    interrupt(name) {
      const p = resolveTarget(story, name, index)
      if (!p || !isInterrupt(p)) throw new Error(`no interrupt passage named "${name}"`)
      if (top().returnTo !== undefined) throw new Error(`an interrupt is already running; take its @return choice first`)
      if (current().isEnding) throw new Error(`the story has ended at ${current().name}`)
      if (!interruptOpen(p)) throw new Error(`${p.name} cannot start: its @when ${formatCond(p.when!)} is false`)
      push(p.id, applyEffects(top().state, p.onEnter, schema), current().id, true)
    },
    storylets: () => storyletPassages.map(storyletState),
    drawStorylet(rng) {
      const open = storyletPassages.map(storyletState).filter((s) => s.open)
      if (open.length === 0) return undefined
      const best = Math.max(...open.map((s) => s.priority))
      const pool = open.filter((s) => s.priority === best)
      const total = pool.reduce((sum, s) => sum + s.weight, 0)
      let r = (rng ?? Math.random)() * total
      let picked = pool[pool.length - 1]!
      for (const s of pool) {
        if (r < s.weight) { picked = s; break }
        r -= s.weight
      }
      const p = picked.passage
      const nextTurn = top().turn + 1
      const cooldowns = { ...top().cooldowns }
      if ((p.cooldown ?? 0) > 0) cooldowns[p.id] = nextTurn + p.cooldown!
      enterDetour(p, 1, cooldowns)
      return p
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
    history: () => steps.map(copyStep),
    isOver() {
      const p = current()
      if (p.isEnding) return true
      return !openChoices(p, top().state, ctx()).some((c) => {
        const to = choiceTarget(story, c.choice.target, index)
        return c.open && (to.kind === "passage" || (to.kind === "return" && top().returnTo !== undefined))
      })
    },
    renderedText() {
      const p = current()
      const t = top()
      return renderProse(proseText(p.text), { state: t.state, visits: t.visits, visitCount: t.visits[p.id] ?? 1 })
    },
    visits: () => ({ ...top().visits }),
  }
}
