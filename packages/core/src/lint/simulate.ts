/**
 * Monte Carlo playthroughs: many seeded random games through the real playtest, for balance numbers the static
 * checks cannot give (how often each ending happens, which passages and choices players never see, where the
 * state tends to land).
 */
import { createPlaytest } from "../play/playtest"
import { onceKey } from "../story/choice"
import { choiceTarget, contentPassages, createStoryIndex } from "../story/model"
import type { StateSchema, Story } from "../story/types"

export interface SimulationOptions {
  /** Games to play. Default 200. */
  runs?: number
  /** PRNG seed; the same seed gives the same report. Default 1. */
  seed?: number
  /** Choices and storylet draws per game before it counts as "max-steps". Default 100. */
  maxSteps?: number
  /** Draw a storylet when no choice is open. Default true. */
  includeStorylets?: boolean
}

export type SimulatedVar =
  | { type: "number" | "int"; min: number; max: number; avg: number }
  | { type: "bool" | "enum"; counts: Record<string, number> }

export interface SimulationReport {
  runs: number
  seed: number
  /** Endings reached, most often first. */
  endings: { passageId: string; name: string; count: number; rate: number }[]
  /** Games that stopped at a passage with no open choice, no storylet to draw and no @end. */
  deadEnds: number
  /** Games still going after maxSteps. */
  maxStepsHit: number
  /** Choices and draws per game. */
  steps: { min: number; max: number; avg: number }
  /** Passage id -> in how many games it was entered (and the share of games). Every content passage is listed. */
  passageVisits: Record<string, { runs: number; rate: number }>
  /** Content passage ids no game entered, in file order. */
  neverVisitedPassages: string[]
  /** Choices no game took, in file order. */
  neverTakenChoices: { passageId: string; choiceIndex: number; label: string }[]
  /** Each state variable at the end of the games. */
  finalState: Record<string, SimulatedVar>
}

/** Mulberry32: a small, fast, seeded PRNG. Returns numbers in [0, 1). */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/**
 * Play `runs` random games from the start. At each step a game takes one of the open choices at random (a `@return`
 * only inside a detour); with none open it draws a storylet when one is open, else it is a dead end. A game ends at a
 * passage with @end (an `@auto` interrupt or a storylet with @end counts), or after `maxSteps`.
 */
export function simulateStory(story: Story, schema: StateSchema, opts?: SimulationOptions): SimulationReport {
  const runs = Math.max(0, Math.floor(opts?.runs ?? 200))
  const seed = opts?.seed ?? 1
  const maxSteps = opts?.maxSteps ?? 100
  const includeStorylets = opts?.includeStorylets !== false
  const rng = mulberry32(seed)
  const index = createStoryIndex(story)
  const passages = contentPassages(story)

  const endings = new Map<string, number>()
  let deadEnds = 0
  let maxStepsHit = 0
  const stepCounts: number[] = []
  const visitedRuns = new Map<string, number>()
  const taken = new Set<string>()
  const finals: Record<string, (number | string | boolean)[]> = {}
  for (const v of Object.keys(schema)) finals[v] = []

  for (let run = 0; run < runs; run++) {
    const pt = createPlaytest(story, schema)
    let steps = 0
    for (;;) {
      const here = pt.current()
      if (here.isEnding) {
        endings.set(here.id, (endings.get(here.id) ?? 0) + 1)
        break
      }
      if (steps >= maxSteps) {
        maxStepsHit++
        break
      }
      let inDetour: boolean | undefined
      const open = pt.choices().filter((c) => {
        if (!c.open) return false
        const to = choiceTarget(story, c.choice.target, index)
        if (to.kind === "passage") return true
        if (to.kind !== "return") return false
        inDetour ??= pt.history().at(-1)?.returnTo !== undefined
        return inDetour
      })
      if (open.length > 0) {
        const pick = open[Math.floor(rng() * open.length)]!
        taken.add(onceKey(here.id, pick.index))
        pt.choose(pick.index)
        steps++
        continue
      }
      if (includeStorylets && pt.drawStorylet(rng)) {
        steps++
        continue
      }
      deadEnds++
      break
    }
    stepCounts.push(steps)
    for (const [id, n] of Object.entries(pt.visits())) if (n > 0) visitedRuns.set(id, (visitedRuns.get(id) ?? 0) + 1)
    const state = pt.state()
    for (const v of Object.keys(schema)) if (state[v] !== undefined) finals[v]!.push(state[v]!)
  }

  const rate = (n: number) => (runs === 0 ? 0 : n / runs)
  const order = new Map(passages.map((p, i) => [p.id, i]))
  const endingList = [...endings]
    .map(([passageId, count]) => ({ passageId, name: index.byId.get(passageId)?.name ?? passageId, count, rate: rate(count) }))
    .sort((a, b) => b.count - a.count || (order.get(a.passageId) ?? 0) - (order.get(b.passageId) ?? 0))

  const passageVisits: SimulationReport["passageVisits"] = {}
  for (const p of passages) {
    const n = visitedRuns.get(p.id) ?? 0
    passageVisits[p.id] = { runs: n, rate: rate(n) }
  }

  const neverTakenChoices: SimulationReport["neverTakenChoices"] = []
  for (const p of passages) {
    p.choices.forEach((c, i) => {
      if (!taken.has(onceKey(p.id, i))) neverTakenChoices.push({ passageId: p.id, choiceIndex: i, label: c.label })
    })
  }

  const minMaxAvg = (values: readonly number[]) => {
    if (values.length === 0) return { min: 0, max: 0, avg: 0 }
    let min = values[0]!
    let max = values[0]!
    let sum = 0
    for (let i = 0; i < values.length; i++) {
      const v = values[i]!
      if (v < min) min = v
      if (v > max) max = v
      sum += v
    }
    return { min, max, avg: sum / values.length }
  }

  const finalState: SimulationReport["finalState"] = {}
  for (const [v, decl] of Object.entries(schema)) {
    const values = finals[v]!
    if (decl.type === "number" || decl.type === "int") {
      const nums = values.filter((x): x is number => typeof x === "number")
      finalState[v] = { type: decl.type, ...minMaxAvg(nums) }
    } else {
      const counts: Record<string, number> = {}
      for (const x of values) counts[String(x)] = (counts[String(x)] ?? 0) + 1
      finalState[v] = { type: decl.type, counts }
    }
  }

  return {
    runs,
    seed,
    endings: endingList,
    deadEnds,
    maxStepsHit,
    steps: minMaxAvg(stepCounts),
    passageVisits,
    neverVisitedPassages: passages.filter((p) => (visitedRuns.get(p.id) ?? 0) === 0).map((p) => p.id),
    neverTakenChoices,
    finalState,
  }
}

const pct = (r: number) => `${(r * 100).toFixed(1)}%`
const num = (n: number) => (Number.isInteger(n) ? String(n) : n.toFixed(2))

/** The report as text lines, for a terminal or an agent. */
export function formatSimulationReport(report: SimulationReport): string[] {
  const lines = [`${report.runs} simulated games (seed ${report.seed})`]
  lines.push("endings:")
  if (report.endings.length === 0) lines.push("  none reached")
  for (const e of report.endings) lines.push(`  ${e.name.padEnd(24)} ${String(e.count).padStart(5)}  ${pct(e.rate)}`)
  lines.push(`dead ends: ${report.deadEnds}   max steps hit: ${report.maxStepsHit}`)
  lines.push(`steps: min ${num(report.steps.min)}, avg ${num(report.steps.avg)}, max ${num(report.steps.max)}`)
  if (report.neverVisitedPassages.length > 0) lines.push(`never visited: ${report.neverVisitedPassages.join(", ")}`)
  if (report.neverTakenChoices.length > 0) {
    lines.push("never taken:")
    for (const c of report.neverTakenChoices) lines.push(`  ${c.passageId}#${c.choiceIndex} "${c.label}"`)
  }
  const vars = Object.entries(report.finalState)
  if (vars.length > 0) {
    lines.push("final state:")
    for (const [v, s] of vars) {
      if ("avg" in s) lines.push(`  ${v}: min ${num(s.min)}, avg ${num(s.avg)}, max ${num(s.max)}`)
      else lines.push(`  ${v}: ${Object.entries(s.counts).map(([k, n]) => `${k} ${n}`).join(", ") || "-"}`)
    }
  }
  return lines
}
