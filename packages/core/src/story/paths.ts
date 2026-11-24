import { reachable } from "../lint/lint"
import { anyState, applyEffect, boxesKey, narrow, release, unionBoxes, type Box } from "../lint/sat"
import { choiceGuard, onceKey } from "./choice"
import { formatCond, initialState } from "./cond"
import { choiceTarget, contentPassages, createStoryIndex, isInterrupt, isStorylet, passageById, resolveTarget, startPassage, type StoryIndex } from "./model"
import { RETURN_TARGET } from "./types"
import type { Choice, Cond, InterruptPath, Passage, PathStep, StateSchema, Story, StoryPath } from "./types"

export interface PathOptions {
  /** Start passage name. Default: the story start. */
  from?: string
  /** Stop after this many paths. Default 500. */
  maxPaths?: number
  /**
   * Start from the schema's initial state (non-engine variables at their `initial`, engine variables anywhere in
   * range) instead of any state in range. Default false.
   */
  fromInitial?: boolean
}

/**
 * The states a new game starts in: every variable that is not `engine` pinned to its value in `initialState`,
 * engine variables anywhere in their range.
 */
export function initialBoxes(schema: StateSchema): Box[] {
  const init = initialState(schema)
  const terms: Cond[] = Object.keys(schema)
    .filter((v) => !schema[v]!.engine)
    .map((variable) => ({ kind: "cmp", variable, op: "==", value: init[variable]! }))
  return terms.length === 0 ? anyState() : narrow(anyState(), { kind: "and", terms }, schema)
}

/** Append a condition's top-level `and` terms that the list does not hold yet. */
function addConds(conds: Cond[], c: Cond | undefined): Cond[] {
  if (!c) return conds
  const seen = new Set(conds.map(formatCond))
  const out = [...conds]
  for (const t of c.kind === "and" ? c.terms : [c]) {
    const key = formatCond(t)
    if (!seen.has(key)) { seen.add(key); out.push(t) }
  }
  return out
}

/**
 * Routes from `first`, each passage at most once per route, appended to `out`. `returns` lets a `@return`
 * choice end a route (inside an interrupt); otherwise `@return` choices are skipped like broken links.
 */
function walk(story: Story, schema: StateSchema, first: Passage, maxPaths: number, returns: boolean, out: InterruptPath[], index: StoryIndex, startBoxes: Box[] = anyState()): void {
  const engine = Object.keys(schema).filter((v) => schema[v]!.engine)
  const limit = out.length + maxPaths

  // Arriving: the passage's @when, then its @set; then the game is free to move engine variables.
  const enter = (p: Passage, boxes: Box[]) => {
    let b = p.when ? narrow(boxes, p.when, schema) : boxes
    for (const e of p.onEnter) b = applyEffect(b, e, schema)
    return release(b, engine)
  }
  const take = (c: Choice, boxes: Box[]) => {
    const guard = choiceGuard(c)
    let b = guard ? narrow(boxes, guard, schema) : boxes
    for (const e of [...c.cost, ...c.set]) b = applyEffect(b, e, schema)
    return b
  }
  const emit = (steps: PathStep[], conditions: Cond[], end: InterruptPath["end"], boxes: Box[]) => {
    out.push({ steps, conditions, end, satisfiable: boxes.length > 0 })
  }

  const visit = (p: Passage, steps: PathStep[], conditions: Cond[], arriving: Box[], onRoute: Set<Passage>) => {
    if (out.length >= limit) return
    const conds = addConds(conditions, p.when)
    const here = enter(p, arriving)
    if (p.isEnding) return emit([...steps, { passageId: p.id }], conds, "ending", here)
    // Already impossible here: every route on from this passage is impossible too, so stop with one route
    // instead of listing the whole subtree behind it.
    if (here.length === 0) return emit([...steps, { passageId: p.id }], conds, "dead-end", here)
    const live = p.choices
      .map((choice, i) => ({ choice, index: i, to: choiceTarget(story, choice.target, index) }))
      .filter(({ to }) => to.kind === "passage" || (returns && to.kind === "return"))
    if (live.length === 0) return emit([...steps, { passageId: p.id }], conds, "dead-end", here)
    onRoute.add(p)
    for (const { choice, index, to } of live) {
      if (out.length >= limit) break
      const nextSteps = [...steps, { passageId: p.id, choiceIndex: index }]
      const nextConds = addConds(conds, choiceGuard(choice))
      const after = take(choice, here)
      if (to.kind !== "passage") emit(nextSteps, nextConds, "return", after)
      else if (onRoute.has(to.passage)) emit([...nextSteps, { passageId: to.passage.id }], addConds(nextConds, to.passage.when), "loop", enter(to.passage, after))
      else visit(to.passage, nextSteps, nextConds, after, onRoute)
    }
    onRoute.delete(p)
  }

  visit(first, [], [], startBoxes, new Set())
}

/**
 * Every route from the start to an ending, a dead end or a loop. A passage appears at most once per route.
 *
 * - "ending": the passage has @end.
 * - "dead-end": no @end and no choice that leads to an existing passage.
 * - "loop": the next choice leads back to a passage already on the route (the repeated passage is the last step).
 * Choices with broken links, and `@return` choices, are skipped (lint reports the first; interruptPaths follows the second).
 *
 * `satisfiable` follows the route's state: it starts anywhere within the schema ranges, each condition narrows
 * the state the effects before it left (with clamping), and `engine` variables are free again at each passage.
 */
export function paths(story: Story, schema: StateSchema, opts?: PathOptions): StoryPath[] {
  return mainRoutes(story, schema, opts?.maxPaths ?? 500, opts, createStoryIndex(story))
}

function mainRoutes(story: Story, schema: StateSchema, max: number, opts: PathOptions | undefined, index: StoryIndex): StoryPath[] {
  const first = opts?.from !== undefined ? resolveTarget(story, opts.from, index) : startPassage(story, index)
  if (!first) return []
  const out: InterruptPath[] = []
  walk(story, schema, first, max, false, out, index, opts?.fromInitial ? initialBoxes(schema) : anyState())
  return out.filter((r): r is StoryPath => r.end !== "return")
}

/**
 * Routes through each interrupt passage, from its entry (in any state) to `@return`, an ending, a dead end or a
 * loop. A route that ends in "return" has the `@return` choice on its last step.
 */
export function interruptPaths(story: Story, schema: StateSchema, opts?: Pick<PathOptions, "maxPaths">): InterruptPath[] {
  return interruptRoutes(story, schema, opts?.maxPaths ?? 500, createStoryIndex(story))
}

function interruptRoutes(story: Story, schema: StateSchema, max: number, index: StoryIndex): InterruptPath[] {
  const out: InterruptPath[] = []
  for (const p of contentPassages(story).filter(isInterrupt)) {
    if (out.length >= max) break
    walk(story, schema, p, max - out.length, true, out, index)
  }
  return out
}

/** Passage ids and choices (`onceKey`: "<passage id>#<choice index>") a game started from the initial state can reach. */
export interface Reachability {
  passages: Set<string>
  choices: Set<string>
}

/** Rounds a passage's state may grow before it is widened to "anything" (so loops like `x += 1` settle). */
const WIDEN_AFTER = 16

/**
 * Which passages and choices a new game can reach: starting at the start passage in `initialBoxes(schema)`, with
 * every condition and effect applied. Each passage keeps the union of the states it can be entered in, grown until
 * nothing changes (a passage whose state keeps growing is widened to any state). Interrupts can fire anywhere and
 * `@return` brings their effects back, so they are entered in any state, and every variable an interrupt route can
 * change is treated like an engine variable. Storylets are drawn anywhere too, so they are treated the same way. Visit counts are free. The result over-approximates: a passage
 * missing from it is certainly unreachable from the initial state; one in it may still need a lucky engine value.
 */
export function reachableFromInitial(story: Story, schema: StateSchema, index: StoryIndex = createStoryIndex(story)): Reachability {
  const result: Reachability = { passages: new Set(), choices: new Set() }
  const start = startPassage(story, index)
  if (!start) return result
  // Interrupts and storylets are detours the game can start anywhere, and `@return` brings their effects back.
  const detours = contentPassages(story).filter((p) => isInterrupt(p) || isStorylet(p))
  const written = new Set<string>()
  for (const p of reachable(story, detours, index)) {
    for (const e of p.onEnter) written.add(e.variable)
    for (const c of p.choices) for (const e of [...c.cost, ...c.set]) written.add(e.variable)
  }
  const free = [...new Set([...Object.keys(schema).filter((v) => schema[v]!.engine), ...written])]
  const enter = (p: Passage, boxes: Box[]) => {
    let b = p.when ? narrow(boxes, p.when, schema) : boxes
    for (const e of p.onEnter) b = applyEffect(b, e, schema)
    return release(b, free)
  }

  const at = new Map<Passage, Box[]>()
  const rounds = new Map<Passage, number>()
  const widened = new Set<Passage>()
  const queue: Passage[] = []
  const queued = new Set<Passage>()
  const merge = (p: Passage, boxes: Box[]) => {
    if (boxes.length === 0 || widened.has(p)) return
    const old = at.get(p)
    let next = unionBoxes(old ?? [], boxes)
    if (old && boxesKey(next) === boxesKey(old)) return
    const n = (rounds.get(p) ?? 0) + 1
    rounds.set(p, n)
    if (n > WIDEN_AFTER) { next = anyState(); widened.add(p) }
    at.set(p, next)
    if (!queued.has(p)) { queued.add(p); queue.push(p) }
  }

  merge(start, enter(start, initialBoxes(schema)))
  for (const p of detours) merge(p, enter(p, anyState()))
  for (let head = 0; head < queue.length; head++) {
    const p = queue[head]!
    queued.delete(p)
    if (p.isEnding) continue
    const here = at.get(p)!
    p.choices.forEach((choice, i) => {
      const to = choiceTarget(story, choice.target, index)
      if (to.kind === "missing") return
      const guard = choiceGuard(choice)
      let after = guard ? narrow(here, guard, schema) : here
      for (const e of [...choice.cost, ...choice.set]) after = applyEffect(after, e, schema)
      if (after.length === 0) return
      if (to.kind === "return") { result.choices.add(onceKey(p.id, i)); return }
      const entered = enter(to.passage, after)
      if (entered.length === 0) return
      result.choices.add(onceKey(p.id, i))
      merge(to.passage, entered)
    })
  }
  for (const p of at.keys()) result.passages.add(p.id)
  return result
}

export interface PathsAnalysis {
  routes: StoryPath[]
  interrupts: InterruptPath[]
  /** True when `maxPaths` cut either list short. */
  truncated: boolean
  /** Passage ids a new game can reach (see `reachableFromInitial`). */
  reachableFromInitial: Set<string>
}

/** Routes, interrupt routes, whether either list was cut short, and what a new game can reach, from one index. */
export function pathsAnalysis(story: Story, schema: StateSchema, opts?: PathOptions): PathsAnalysis {
  const index = createStoryIndex(story)
  const max = opts?.maxPaths ?? 500
  const routes = mainRoutes(story, schema, max + 1, opts, index)
  const interrupts = interruptRoutes(story, schema, max + 1, index)
  return {
    routes: routes.slice(0, max),
    interrupts: interrupts.slice(0, max),
    truncated: routes.length > max || interrupts.length > max,
    reachableFromInitial: reachableFromInitial(story, schema, index).passages,
  }
}

const nameOf = (story: Story, id: string, index?: StoryIndex) => passageById(story, id, index)?.name ?? id

/** One route as one line: each passage with the choice taken there, how the route ends, its conditions. */
export function formatPath(story: Story, route: StoryPath | InterruptPath, index?: StoryIndex): string {
  const parts = route.steps.map((s) => {
    const p = passageById(story, s.passageId, index)
    const label = s.choiceIndex !== undefined ? p?.choices[s.choiceIndex]?.label : undefined
    return `${p?.name ?? s.passageId}${label !== undefined ? ` [${label}]` : ""}`
  })
  if (route.end === "return") parts.push(RETURN_TARGET)
  let line = parts.join(" → ")
  if (route.end === "dead-end") line += " (dead end)"
  if (route.end === "loop") line += " (loop)"
  if (route.conditions.length > 0) {
    const all: Cond = route.conditions.length === 1 ? route.conditions[0]! : { kind: "and", terms: route.conditions }
    line += `   when ${formatCond(all)}`
  }
  if (!route.satisfiable) line += "   never true"
  return line
}

/** Numbered lines for a list of routes, interrupt routes after the others. */
export function formatPathList(story: Story, routes: StoryPath[], interrupts: InterruptPath[] = []): string[] {
  const width = String(routes.length + interrupts.length).length + 2
  const index = createStoryIndex(story)
  const lines = routes.map((r, i) => `${String(i + 1).padEnd(width)}${formatPath(story, r, index)}`)
  if (interrupts.length > 0) {
    lines.push("interrupts (each can start at any passage while its @when holds):")
    interrupts.forEach((r, i) => lines.push(`${String(routes.length + i + 1).padEnd(width)}${formatPath(story, r, index)}`))
  }
  return lines
}

/** How a route ends, as a group name: the ending passage, or the dead end, loop or return. */
function endKey(story: Story, r: StoryPath | InterruptPath, index: StoryIndex): string {
  const last = r.steps[r.steps.length - 1]!
  switch (r.end) {
    case "ending": return nameOf(story, last.passageId, index)
    case "dead-end": return `dead end at ${nameOf(story, last.passageId, index)}`
    case "loop": return `loop back to ${nameOf(story, last.passageId, index)}`
    case "return": return `${RETURN_TARGET} from ${nameOf(story, r.steps[0]!.passageId, index)}`
  }
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`
const sequence = (r: StoryPath | InterruptPath) => r.steps.map((s) => s.passageId).join(">")

/** Route counts by how they end: how many, how many are possible, how many distinct passage sequences. */
export function summarizePaths(story: Story, routes: StoryPath[], interrupts: InterruptPath[] = []): string[] {
  const all = [...routes, ...interrupts]
  const possible = all.filter((r) => r.satisfiable).length
  const lines = [
    `${plural(all.length, "route")}: ${possible} possible, ${all.length - possible} never true; ${plural(new Set(all.map(sequence)).size, "distinct passage sequence")}`,
  ]
  const groups = new Map<string, (StoryPath | InterruptPath)[]>()
  const index = createStoryIndex(story)
  for (const r of all) {
    const key = endKey(story, r, index)
    groups.set(key, [...(groups.get(key) ?? []), r])
  }
  const width = Math.max(...[...groups.keys()].map((k) => k.length)) + 2
  for (const [key, rs] of groups) {
    lines.push(`  ${key.padEnd(width)}${plural(rs.length, "route")}, ${rs.filter((r) => r.satisfiable).length} possible, ${plural(new Set(rs.map(sequence)).size, "sequence")}`)
  }
  return lines
}
