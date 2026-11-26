/**
 * Narrative craft checks, a pacing summary and table-read transcripts. These are advice for the writer, apart from
 * `lint` (which decides whether a story can be exported): every diagnostic here is "info" or "warn".
 */
import { createPlaytest, type Playtest } from "../play/playtest"
import type { CopyBudget } from "../project/types"
import { costCond } from "../story/choice"
import { initialState } from "../story/cond"
import { choiceTarget, contentPassages, createStoryIndex, isInterrupt, isStorylet, startPassage, type StoryIndex } from "../story/model"
import { interruptPaths, paths, reachableFromInitial } from "../story/paths"
import { proseText } from "../story/prose"
import { parseTemplate, renderProse, templateRefs, type TemplateNode } from "../story/template"
import type { Choice, Cond, Diagnostic, GameState, InterruptPath, Passage, StateSchema, Story, StoryPath } from "../story/types"
import { beforeEffect, reachable } from "./lint"
import { narrow, sampleEngineUpdates, stateBox } from "./sat"

export interface NarrativeLintOptions {
  /** Copy budgets by passage tag; "*" applies to every passage. Usually `manifest.copyBudgets`. */
  copyBudgets?: Record<string, CopyBudget>
  /** Shot ids from the manifest. When given, a `@shot` naming another id is reported (unknown-shot). */
  shotIds?: readonly string[]
}

function condVars(c: Cond | undefined, out: Set<string>): void {
  if (!c) return
  switch (c.kind) {
    case "cmp": out.add(c.variable); break
    case "and":
    case "or": c.terms.forEach((t) => condVars(t, out)); break
    case "not": condVars(c.term, out); break
    case "visit": break
  }
}

/** The prose a passage shows: rule, link and cue lines removed, templates as written. */
const prose = (p: Passage) => proseText(p.text)

/** The longest text the templates can render to (each `{when}`, `{cycle}` and `{shuffle}` at its longest branch). */
function longestText(nodes: TemplateNode[], state: GameState): string {
  let out = ""
  for (const n of nodes) {
    switch (n.kind) {
      case "text": out += n.text; break
      case "var": out += n.name in state ? String(state[n.name]) : `{${n.name}}`; break
      case "when": {
        const a = longestText(n.then, state)
        const b = n.else ? longestText(n.else, state) : ""
        out += a.length >= b.length ? a : b
        break
      }
      case "once": out += longestText(n.body, state); break
      case "cycle":
      case "shuffle": out += n.options.map((o) => longestText(o, state)).reduce((a, b) => (b.length > a.length ? b : a), ""); break
      case "invalid": out += n.raw; break
    }
  }
  return out
}

/** The budget that applies to a passage: the smallest limit of each kind among its tags' budgets and "*". */
function budgetFor(p: Passage, budgets: Record<string, CopyBudget>): CopyBudget | undefined {
  const apply = [budgets["*"], ...p.tags.map((t) => (Object.hasOwn(budgets, t) ? budgets[t] : undefined))].filter((b): b is CopyBudget => !!b)
  if (apply.length === 0) return undefined
  const out: CopyBudget = {}
  for (const b of apply) {
    for (const k of Object.keys(b) as (keyof CopyBudget)[]) {
      const v = b[k]
      if (typeof v === "number") out[k] = Math.min(out[k] ?? Infinity, v)
    }
  }
  return out
}

const stable = (v: unknown) => JSON.stringify(v ?? null)

/**
 * Narrative craft diagnostics:
 * - unused-state-var (info): a non-engine variable the story writes (or the schema declares) that no
 *   `@when`, `@cost`, `{when}` or `{var}` ever reads.
 * - false-choice (info): two or more choices that all lead to the same passage with the same cost, set, cues and meta.
 * - duplicate-copy (info): one `@hint` text on several choices, or two choices of one passage with the same label.
 * - copy-budget-exceeded (warn): a title, body, choice label or hint longer than the passage's copy budget.
 * - unreachable-from-initial (warn): a passage the links reach, but no game started from the initial state can.
 * - unknown-shot (warn): a `@shot` that names no shot in `opts.shotIds`.
 */
export function lintNarrative(story: Story, schema: StateSchema, opts?: NarrativeLintOptions): Diagnostic[] {
  const out: Diagnostic[] = []
  const index = createStoryIndex(story)
  const passages = contentPassages(story)
  const add = (severity: Diagnostic["severity"], code: string, message: string, p?: Passage, span = p?.span) =>
    out.push({ severity, code, message, ...(p ? { passageId: p.id } : {}), ...(span ? { span } : {}) })

  // unused-state-var
  const read = new Set<string>()
  const written = new Map<string, Passage>()
  for (const p of passages) {
    condVars(p.when, read)
    for (const e of p.onEnter) if (!written.has(e.variable)) written.set(e.variable, p)
    const refs = templateRefs(prose(p))
    refs.conds.forEach((c) => condVars(c, read))
    refs.variables.forEach((v) => read.add(v))
    for (const c of p.choices) {
      condVars(c.when, read)
      condVars(costCond(c), read)
      for (const e of [...c.cost, ...c.set]) if (!written.has(e.variable)) written.set(e.variable, p)
    }
  }
  const candidates = new Set([...written.keys(), ...Object.keys(schema).filter((v) => !schema[v]!.engine)])
  for (const v of candidates) {
    if (read.has(v) || schema[v]?.engine) continue
    const by = written.get(v)
    add("info", "unused-state-var", by ? `${v} is changed (first in ${by.name}) but no condition, cost or template reads it` : `${v} is declared in the state schema but nothing reads it`, by)
  }

  const hints = new Map<string, { p: Passage; label: string }[]>()
  for (const p of passages) {
    // false-choice
    if (p.choices.length >= 2) {
      const keys = p.choices.map((c) => {
        const to = choiceTarget(story, c.target, index)
        // A broken link keys on its name, so two different broken links never look alike.
        const dest = to.kind === "passage" ? to.passage.id : to.kind === "return" ? "@return" : `missing:${c.target}`
        return stable([dest, c.cost, c.set, c.cues ?? [], c.meta ?? {}])
      })
      if (keys.every((k) => k === keys[0])) {
        add("info", "false-choice", `${p.name}: all ${p.choices.length} choices lead to ${p.choices[0]!.target} with the same effects, so the choice does not change anything`, p)
      }
    }
    // duplicate-copy: labels within a passage
    const labels = new Map<string, number>()
    for (const c of p.choices) labels.set(c.label, (labels.get(c.label) ?? 0) + 1)
    for (const [label, n] of labels) if (n > 1) add("info", "duplicate-copy", `${p.name}: ${n} choices share the label "${label}"`, p)
    for (const c of p.choices) {
      if (c.hint === undefined || c.hint.trim() === "") continue
      const list = hints.get(c.hint) ?? []
      list.push({ p, label: c.label })
      hints.set(c.hint, list)
    }
  }
  for (const [hint, uses] of hints) {
    if (uses.length < 2) continue
    add("info", "duplicate-copy", `the hint "${hint}" is used on ${uses.length} choices: ${uses.map((u) => `${u.p.name} [${u.label}]`).join(", ")}`, uses[0]!.p)
  }

  // copy-budget-exceeded
  const budgets = opts?.copyBudgets
  if (budgets && Object.keys(budgets).length > 0) {
    const init = initialState(schema)
    for (const p of passages) {
      const b = budgetFor(p, budgets)
      if (!b) continue
      const over = (what: string, len: number, max: number | undefined, span = p.span) => {
        if (max !== undefined && len > max) add("warn", "copy-budget-exceeded", `${p.name}: ${what} is ${len} (budget ${max})`, p, span)
      }
      over("the title length", p.name.length, b.titleChars)
      const body = longestText(parseTemplate(prose(p)), init)
      over("the body length (characters, longest variant)", body.length, b.bodyChars)
      over("the body line count", body.split("\n").filter((l) => l.trim() !== "").length, b.bodyLines)
      for (const c of p.choices) {
        over(`the label "${c.label}" length`, c.label.length, b.choiceLabelChars, c.span)
        if (c.hint !== undefined) over(`the hint on "${c.label}" length`, c.hint.length, b.hintChars, c.span)
      }
    }
  }

  // unreachable-from-initial
  const start = startPassage(story, index)
  if (start) {
    const linked = reachable(story, [start, ...passages.filter((p) => isInterrupt(p) || isStorylet(p))], index)
    const live = reachableFromInitial(story, schema, index).passages
    for (const p of passages) {
      if (linked.has(p) && !live.has(p.id)) {
        add("warn", "unreachable-from-initial", `${p.name}: links lead here, but no game started from the initial state can get here (check the conditions on the way)`, p)
      }
    }
  }

  // unknown-shot
  if (opts?.shotIds) {
    const known = new Set(opts.shotIds)
    for (const p of passages) {
      if (p.shot !== undefined && !known.has(p.shot)) {
        add("warn", "unknown-shot", `${p.name}: @shot ${p.shot} is not a shot in the manifest${opts.shotIds.length > 0 ? ` (shots: ${opts.shotIds.join(", ")})` : ""}`, p)
      }
    }
  }
  return out
}

// ---- pacing

const words = (text: string) => (text.match(/[\p{L}\p{N}][\p{L}\p{N}'’-]*/gu) ?? []).length

export interface RoutePacing {
  /** Passage ids in order. */
  steps: string[]
  end: StoryPath["end"]
  satisfiable: boolean
  words: number
  /** Steps where the player picks between two or more choices. */
  decisions: number
}

export interface PacingReport {
  /** Content passages. */
  passages: number
  words: number
  avgWordsPerPassage: number
  choices: number
  /** Choices per passage that is not an ending. */
  choiceDensity: number
  endings: number
  /** Words per content passage, by id (prose rendered for the initial state). */
  wordsByPassage: Record<string, number>
  routes: RoutePacing[]
  /** Over the satisfiable routes; zeros when there are none. */
  routeStats: { count: number; minWords: number; maxWords: number; avgWords: number; minDecisions: number; maxDecisions: number; avgDecisions: number }
  /** True when the route list hit its limit. */
  truncated: boolean
}

const round1 = (n: number) => Math.round(n * 10) / 10

/** A pacing summary: how long the story and each route reads, and how often the player gets to choose. */
export function pacingReport(story: Story, schema: StateSchema, opts?: { maxPaths?: number }): PacingReport {
  const passages = contentPassages(story)
  const init = initialState(schema)
  const wordsByPassage: Record<string, number> = {}
  for (const p of passages) wordsByPassage[p.id] = words(renderProse(prose(p), { state: init }))
  const total = Object.values(wordsByPassage).reduce((a, b) => a + b, 0)
  const choices = passages.reduce((n, p) => n + p.choices.length, 0)
  const nonEndings = passages.filter((p) => !p.isEnding).length
  const max = opts?.maxPaths ?? 500
  const all = paths(story, schema, { maxPaths: max + 1 })
  const index = createStoryIndex(story)
  const routes: RoutePacing[] = all.slice(0, max).map((r) => ({
    steps: r.steps.map((s) => s.passageId),
    end: r.end,
    satisfiable: r.satisfiable,
    // A loop's last step repeats a passage already read.
    words: r.steps.slice(0, r.end === "loop" ? -1 : undefined).reduce((n, s) => n + (wordsByPassage[s.passageId] ?? 0), 0),
    decisions: r.steps.filter((s) => s.choiceIndex !== undefined && (index.byId.get(s.passageId)?.choices.length ?? 0) >= 2).length,
  }))
  const ok = routes.filter((r) => r.satisfiable)
  const stat = (f: (r: RoutePacing) => number) => {
    const v = ok.map(f)
    return v.length === 0 ? { min: 0, max: 0, avg: 0 } : { min: Math.min(...v), max: Math.max(...v), avg: round1(v.reduce((a, b) => a + b, 0) / v.length) }
  }
  const w = stat((r) => r.words)
  const d = stat((r) => r.decisions)
  return {
    passages: passages.length,
    words: total,
    avgWordsPerPassage: passages.length === 0 ? 0 : round1(total / passages.length),
    choices,
    choiceDensity: nonEndings === 0 ? 0 : round1(choices / nonEndings),
    endings: passages.filter((p) => p.isEnding).length,
    wordsByPassage,
    routes,
    routeStats: { count: ok.length, minWords: w.min, maxWords: w.max, avgWords: w.avg, minDecisions: d.min, maxDecisions: d.max, avgDecisions: d.avg },
    truncated: all.length > max,
  }
}

/** The pacing report as lines of text. */
export function formatPacingReport(report: PacingReport): string[] {
  const s = report.routeStats
  const lines = [
    `${report.passages} passages, ${report.words} words (${report.avgWordsPerPassage} per passage), ${report.endings} ending${report.endings === 1 ? "" : "s"}`,
    `${report.choices} choices, ${report.choiceDensity} per passage that is not an ending`,
    s.count === 0
      ? "no possible route"
      : `${s.count} possible route${s.count === 1 ? "" : "s"}${report.truncated ? " (list cut short)" : ""}: ${s.minWords}-${s.maxWords} words (avg ${s.avgWords}), ${s.minDecisions}-${s.maxDecisions} decisions (avg ${s.avgDecisions})`,
  ]
  const longest = Object.entries(report.wordsByPassage).sort((a, b) => b[1] - a[1]).slice(0, 3)
  if (longest.length > 0 && longest[0]![1] > 0) lines.push(`longest passages: ${longest.map(([id, n]) => `${id} (${n})`).join(", ")}`)
  return lines
}

// ---- table read

export type TranscriptLine = { kind: "passage"; passageId: string; name: string; text: string } | { kind: "choice"; label: string }

export interface Transcript {
  /** Passage ids of the route. */
  route: string[]
  end: StoryPath["end"] | "return"
  /** The ending passage's name, for a route that ends at one. */
  ending?: string
  lines: TranscriptLine[]
  /** The transcript as readable text. */
  text: string
  /** False when play stopped before the route's end (a choice closed in the initial state); `note` says why. */
  complete: boolean
  note?: string
}

export interface TranscriptOptions {
  /** How many transcripts at most. Default 5. */
  maxTranscripts?: number
  /** Also read one route through each interrupt. Default false. */
  includeInterrupts?: boolean
  /** Only the prose: no passage names, no choices. Default false. */
  proseOnly?: boolean
}

/** Routes covering every ending first, then as many passages not yet covered as possible. */
function pickRoutes<R extends StoryPath | InterruptPath>(routes: R[], max: number): R[] {
  const chosen: R[] = []
  const covered = new Set<string>()
  const gain = (r: R) => new Set(r.steps.map((s) => s.passageId).filter((id) => !covered.has(id))).size
  const take = (r: R) => { chosen.push(r); r.steps.forEach((s) => covered.add(s.passageId)) }
  const endOf = (r: R) => (r.end === "ending" ? r.steps[r.steps.length - 1]!.passageId : undefined)
  const endings = [...new Set(routes.map(endOf).filter((e): e is string => e !== undefined))]
  for (const e of endings) {
    if (chosen.length >= max) break
    const best = routes.filter((r) => endOf(r) === e && !chosen.includes(r)).sort((a, b) => gain(b) - gain(a))[0]
    if (best) take(best)
  }
  while (chosen.length < max) {
    const best = routes.filter((r) => !chosen.includes(r)).sort((a, b) => gain(b) - gain(a))[0]
    if (!best || gain(best) === 0) break
    take(best)
  }
  return chosen
}

/** Try to open a choice by moving only `engine: true` variables (values the game engine can change between passages). */
function openWithEngineVars(pt: Playtest, story: Story, schema: StateSchema, index: StoryIndex, choice: Choice, choiceIndex: number): boolean {
  let boxes = [stateBox(pt.state(), schema, true)]
  if (choice.when) boxes = narrow(boxes, choice.when, schema)
  const cost = costCond(choice)
  if (cost) boxes = narrow(boxes, cost, schema)
  const to = choiceTarget(story, choice.target, index)
  if (to.kind === "passage" && to.passage.when) {
    let needed: Cond | undefined = to.passage.when
    for (const e of [...choice.cost, ...choice.set].reverse()) needed = needed && beforeEffect(needed, e, schema)
    boxes = narrow(boxes, needed ?? to.passage.when, schema)
  }
  if (boxes.length === 0) return false
  const prev = pt.state()
  for (const box of boxes) {
    const updates = sampleEngineUpdates(box, prev, schema)
    if (!updates) continue
    const keys = Object.keys(updates)
    if (keys.length === 0) continue
    for (const k of keys) pt.setVar(k, updates[k]!)
    if (pt.choices()[choiceIndex]?.open) return true
    for (const k of keys) pt.setVar(k, prev[k]!)
  }
  return false
}

function play(story: Story, schema: StateSchema, index: StoryIndex, route: StoryPath | InterruptPath, proseOnly: boolean): Transcript {
  const lines: TranscriptLine[] = []
  const firstId = route.steps[0]!.passageId
  let complete = true
  let note: string | undefined
  const pt = createPlaytest(story, schema, { from: firstId })
  for (const step of route.steps) {
    const p = pt.current()
    if (p.id !== step.passageId) { complete = false; note = `play reached ${p.name}, not ${step.passageId}`; break }
    lines.push({ kind: "passage", passageId: p.id, name: p.name, text: pt.renderedText() })
    if (step.choiceIndex === undefined) break
    const entry = pt.choices()[step.choiceIndex]
    if (!entry) { complete = false; note = `${p.name} has no choice ${step.choiceIndex}`; break }
    lines.push({ kind: "choice", label: entry.choice.label })
    if (route.end === "return" && step === route.steps[route.steps.length - 1]) break
    if (!entry.open && !openWithEngineVars(pt, story, schema, index, entry.choice, step.choiceIndex)) {
      complete = false
      note = `"${entry.choice.label}" is closed in the initial state`
      break
    }
    pt.choose(step.choiceIndex)
    // A loop's last step is the passage it went back to: shown once, already above.
    if (route.end === "loop" && step === route.steps[route.steps.length - 2]) break
  }
  const last = route.steps[route.steps.length - 1]!
  const ending = route.end === "ending" ? index.byId.get(last.passageId)?.name : undefined
  const text = lines
    .map((l) => {
      if (l.kind === "choice") return proseOnly ? "" : `> ${l.label}`
      return proseOnly ? l.text : `## ${l.name}\n\n${l.text}`.trimEnd()
    })
    .filter((t) => t.trim() !== "")
    .join("\n\n")
  const tail = route.end === "return" ? "(back to where the interrupt started)" : route.end === "loop" ? `(loops back to ${last.passageId})` : route.end === "dead-end" ? "(dead end)" : ""
  return {
    route: route.steps.map((s) => s.passageId),
    end: route.end,
    ...(ending !== undefined ? { ending } : {}),
    lines,
    text: proseOnly || !tail ? text : `${text}\n\n${tail}`,
    complete,
    ...(note !== undefined ? { note } : {}),
  }
}

/**
 * Transcripts for a table read: a few possible routes chosen to reach every ending and as many passages as
 * possible, each played from the initial state with its prose rendered (templates filled in, cue lines dropped).
 * Routes possible from the initial state come first; when there are none, routes possible from any state.
 */
export function sampleTranscripts(story: Story, schema: StateSchema, opts?: TranscriptOptions): Transcript[] {
  const max = opts?.maxTranscripts ?? 5
  const index = createStoryIndex(story)
  if (max <= 0 || !startPassage(story, index)) return []
  let routes = paths(story, schema, { fromInitial: true }).filter((r) => r.satisfiable)
  if (routes.length === 0) routes = paths(story, schema).filter((r) => r.satisfiable)
  const out = pickRoutes(routes, max).map((r) => play(story, schema, index, r, !!opts?.proseOnly))
  if (opts?.includeInterrupts) {
    const byStart = new Map<string, InterruptPath>()
    for (const r of interruptPaths(story, schema)) {
      if (r.satisfiable && !byStart.has(r.steps[0]!.passageId)) byStart.set(r.steps[0]!.passageId, r)
    }
    for (const r of byStart.values()) out.push(play(story, schema, index, r, !!opts.proseOnly))
  }
  return out
}
