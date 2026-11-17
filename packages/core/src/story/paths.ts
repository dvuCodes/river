import { anyState, applyEffect, narrow, release, type Box } from "../lint/sat"
import { choiceGuard } from "./choice"
import { formatCond } from "./cond"
import { choiceTarget, contentPassages, isInterrupt, passageById, resolveTarget, startPassage } from "./model"
import { RETURN_TARGET } from "./types"
import type { Choice, Cond, InterruptPath, Passage, PathStep, StateSchema, Story, StoryPath } from "./types"

export interface PathOptions {
  /** Start passage name. Default: the story start. */
  from?: string
  /** Stop after this many paths. Default 500. */
  maxPaths?: number
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
function walk(story: Story, schema: StateSchema, first: Passage, maxPaths: number, returns: boolean, out: InterruptPath[]): void {
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
    const live = p.choices
      .map((choice, index) => ({ choice, index, to: choiceTarget(story, choice.target) }))
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

  visit(first, [], [], anyState(), new Set())
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
  const first = opts?.from !== undefined ? resolveTarget(story, opts.from) : startPassage(story)
  if (!first) return []
  const out: InterruptPath[] = []
  walk(story, schema, first, opts?.maxPaths ?? 500, false, out)
  return out.filter((r): r is StoryPath => r.end !== "return")
}

/**
 * Routes through each interrupt passage, from its entry (in any state) to `@return`, an ending, a dead end or a
 * loop. A route that ends in "return" has the `@return` choice on its last step.
 */
export function interruptPaths(story: Story, schema: StateSchema, opts?: Pick<PathOptions, "maxPaths">): InterruptPath[] {
  const out: InterruptPath[] = []
  const max = opts?.maxPaths ?? 500
  for (const p of contentPassages(story).filter(isInterrupt)) {
    if (out.length >= max) break
    walk(story, schema, p, max - out.length, true, out)
  }
  return out
}

const nameOf = (story: Story, id: string) => passageById(story, id)?.name ?? id

/** One route as one line: each passage with the choice taken there, how the route ends, its conditions. */
export function formatPath(story: Story, route: StoryPath | InterruptPath): string {
  const parts = route.steps.map((s) => {
    const p = passageById(story, s.passageId)
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
  const lines = routes.map((r, i) => `${String(i + 1).padEnd(width)}${formatPath(story, r)}`)
  if (interrupts.length > 0) {
    lines.push("interrupts (each can start at any passage while its @when holds):")
    interrupts.forEach((r, i) => lines.push(`${String(routes.length + i + 1).padEnd(width)}${formatPath(story, r)}`))
  }
  return lines
}

/** How a route ends, as a group name: the ending passage, or the dead end, loop or return. */
function endKey(story: Story, r: StoryPath | InterruptPath): string {
  const last = r.steps[r.steps.length - 1]!
  switch (r.end) {
    case "ending": return nameOf(story, last.passageId)
    case "dead-end": return `dead end at ${nameOf(story, last.passageId)}`
    case "loop": return `loop back to ${nameOf(story, last.passageId)}`
    case "return": return `${RETURN_TARGET} from ${nameOf(story, r.steps[0]!.passageId)}`
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
  for (const r of all) {
    const key = endKey(story, r)
    groups.set(key, [...(groups.get(key) ?? []), r])
  }
  const width = Math.max(...[...groups.keys()].map((k) => k.length)) + 2
  for (const [key, rs] of groups) {
    lines.push(`  ${key.padEnd(width)}${plural(rs.length, "route")}, ${rs.filter((r) => r.satisfiable).length} possible, ${plural(new Set(rs.map(sequence)).size, "sequence")}`)
  }
  return lines
}
