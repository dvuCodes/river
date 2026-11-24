import { choiceGuard, costCond } from "../story/choice"
import { applyEffects, evalCond, formatCond } from "../story/cond"
import { proseText } from "../story/prose"
import { choiceTarget, contentPassages, createStoryIndex, isInterrupt, isStorylet, resolveTarget, type StoryIndex } from "../story/model"
import { findLinks, ruleBlockEnd } from "../story/passage"
import { templateRefs } from "../story/template"
import type { Choice, Cond, Diagnostic, Effect, Passage, SourceSpan, StateSchema, Story } from "../story/types"
import { satisfiable } from "./sat"

/** Type problems in one condition. Empty when it is well typed. */
function checkCond(cond: Cond, schema: StateSchema): { code: string; message: string }[] {
  const out: { code: string; message: string }[] = []
  const walk = (c: Cond) => {
    if (c.kind === "and" || c.kind === "or") return c.terms.forEach(walk)
    if (c.kind === "not") return walk(c.term)
    // Visit counts are not state variables; lint checks their passage ids apart (unknown-passage).
    if (c.kind === "visit") return
    const decl = schema[c.variable]
    if (!decl) {
      out.push({ code: "unknown-var", message: `unknown variable "${c.variable}"` })
      return
    }
    const ordering = c.op !== "==" && c.op !== "!="
    const v = c.value
    switch (decl.type) {
      case "number":
      case "int":
        if (typeof v !== "number") out.push({ code: "type-mismatch", message: `${c.variable} is a ${decl.type}, compared with ${JSON.stringify(v)}` })
        break
      case "bool":
        if (typeof v !== "boolean") out.push({ code: "type-mismatch", message: `${c.variable} is a bool, compared with ${JSON.stringify(v)}` })
        else if (ordering) out.push({ code: "type-mismatch", message: `${c.variable} is a bool; "${c.op}" needs a number` })
        break
      case "enum":
        if (typeof v !== "string") out.push({ code: "type-mismatch", message: `${c.variable} is an enum, compared with ${JSON.stringify(v)}` })
        else if (!decl.values.includes(v)) out.push({ code: "type-mismatch", message: `${c.variable} has no value "${v}" (values: ${decl.values.join(", ")})` })
        if (ordering) out.push({ code: "type-mismatch", message: `${c.variable} is an enum; "${c.op}" needs a number` })
        break
    }
  }
  walk(cond)
  return out
}

function checkEffects(effects: Effect[], schema: StateSchema): { code: string; message: string }[] {
  const out: { code: string; message: string }[] = []
  for (const e of effects) {
    const decl = schema[e.variable]
    if (!decl) {
      out.push({ code: "unknown-var", message: `unknown variable "${e.variable}"` })
      continue
    }
    const v = e.amount
    if (e.op !== "set" && decl.type !== "number" && decl.type !== "int") {
      out.push({ code: "type-mismatch", message: `${e.variable} is a ${decl.type}; "+=", "-=", "*=" and "/=" need a number` })
      continue
    }
    switch (decl.type) {
      case "number":
      case "int":
        if (typeof v !== "number") out.push({ code: "type-mismatch", message: `${e.variable} is a ${decl.type}, set to ${JSON.stringify(v)}` })
        // An int multiplied by a fraction drops the fraction, so only "+=", "-=" and "=" must be whole.
        else if (decl.type === "int" && e.op !== "mul" && !Number.isInteger(v)) out.push({ code: "type-mismatch", message: `${e.variable} is an int, changed by ${v}` })
        break
      case "bool":
        if (typeof v !== "boolean") out.push({ code: "type-mismatch", message: `${e.variable} is a bool, set to ${JSON.stringify(v)}` })
        break
      case "enum":
        if (typeof v !== "string" || !decl.values.includes(v)) {
          out.push({ code: "type-mismatch", message: `${e.variable} has no value ${JSON.stringify(v)} (values: ${decl.values.join(", ")})` })
        }
        break
    }
  }
  return out
}

const TRUE: Cond = { kind: "and", terms: [] }
const FALSE: Cond = { kind: "or", terms: [] }
const isConst = (c: Cond, value: boolean) => c.kind === (value ? "and" : "or") && c.terms.length === 0

function join(kind: "and" | "or", terms: Cond[]): Cond {
  const unit = kind === "and"
  if (terms.some((t) => isConst(t, !unit))) return unit ? FALSE : TRUE
  const kept = terms.filter((t) => !isConst(t, unit))
  return kept.length === 1 ? kept[0]! : { kind, terms: kept }
}

const cmp = (a: number, op: "<" | "<=" | ">" | ">=", b: number) => (op === "<" ? a < b : op === "<=" ? a <= b : op === ">" ? a > b : a >= b)

/**
 * `cond` as a condition on the state before `effect` runs, with the effect's clamping to the schema range;
 * undefined when that cannot be written as a condition River checks.
 */
function beforeEffect(cond: Cond, effect: Effect, schema: StateSchema): Cond | undefined {
  if (cond.kind === "and" || cond.kind === "or") {
    const terms = cond.terms.map((t) => beforeEffect(t, effect, schema))
    return terms.every((t): t is Cond => t !== undefined) ? join(cond.kind, terms) : undefined
  }
  if (cond.kind === "not") {
    const term = beforeEffect(cond.term, effect, schema)
    return term && (isConst(term, true) ? FALSE : isConst(term, false) ? TRUE : { kind: "not", term })
  }
  // Effects never change a visit count.
  if (cond.kind === "visit" || cond.variable !== effect.variable) return cond
  const decl = schema[effect.variable]
  // A set, or a multiply by 0, leaves one value whatever came before.
  if (effect.op === "set" || (effect.op === "mul" && effect.amount === 0)) return evalCond(cond, applyEffects({}, [effect], schema)) ? TRUE : FALSE
  if (!decl || (decl.type !== "number" && decl.type !== "int") || typeof effect.amount !== "number" || typeof cond.value !== "number") return undefined
  const k = effect.amount
  // Undo the effect on the threshold. Only a positive factor keeps the comparison's direction, and an int
  // multiplied by a fraction loses the fraction, so those cannot be undone.
  if (effect.op === "mul" && (k < 0 || (decl.type === "int" && !Number.isInteger(k)))) return undefined
  const lo = decl.min ?? -Infinity
  const hi = decl.max ?? Infinity
  const x = cond.value
  const shifted: Cond = { ...cond, value: effect.op === "add" ? x - k : x / k }
  switch (cond.op) {
    case ">":
    case ">=":
      return cmp(lo, cond.op, x) ? TRUE : !cmp(hi, cond.op, x) ? FALSE : shifted
    case "<":
    case "<=":
      return cmp(hi, cond.op, x) ? TRUE : !cmp(lo, cond.op, x) ? FALSE : shifted
    default:
      return lo < x && x < hi ? shifted : undefined
  }
}

/**
 * A choice is open when its @when holds and its @cost can be paid; its target's @when is meant to hold when the
 * player arrives, on the state after the choice's @cost and @set. The message for a state that allows the first
 * and not the second.
 */
function blockedChoice(p: Passage, choice: Choice, target: Passage, schema: StateSchema): string | undefined {
  const guard = choiceGuard(choice)
  if (!target.when || checkCond(target.when, schema).length > 0 || (guard && checkCond(guard, schema).length > 0)) return undefined
  let needed: Cond | undefined = target.when
  for (const e of [...choice.cost, ...choice.set].reverse()) needed = needed && beforeEffect(needed, e, schema)
  if (!needed) return undefined
  const shows = guard ? [guard] : []
  if (!satisfiable(shows, schema) || !satisfiable([...shows, { kind: "not", term: needed }], schema)) return undefined
  const effects = choice.cost.length + choice.set.length > 0 ? " after the choice's @cost and @set" : ""
  const where = `${p.name} → ${choice.target}`
  if (!satisfiable([...shows, needed], schema)) {
    return `${where}: ${target.name}'s @when ${formatCond(target.when)} is never true${effects} when this choice shows. Loosen one of the two conditions.`
  }
  // When the needed condition already implies the choice's own, it alone is the fix.
  const keepOwn = choice.when && satisfiable([needed, { kind: "not", term: choice.when }], schema)
  return (
    `${where}: the choice can show while ${target.name}'s @when ${formatCond(target.when)} is false${effects}. ` +
    `Give the choice @when ${formatCond(keepOwn ? join("and", [choice.when!, needed]) : needed)}, or loosen ${target.name}'s @when.`
  )
}

/** Rule words that mean nothing in prose. `@cue` is not one: a cue line in prose is a block of its own. */
const RULE_WORD = /^\s*@(id|when|set|end|cost|hint|meta|shot|once|weight|priority|cooldown|auto)\b/
const DASHES = /^[-‐-―−]+$/

/**
 * Rule lines River would read as prose: a rule block closed by `---` or a dash other than `--`, and `@when`,
 * `@set` and the like on a line of their own below the rule block.
 */
function strayRules(p: Passage): { severity: "error" | "warn"; code: string; message: string; line: number }[] {
  const out: { severity: "error" | "warn"; code: string; message: string; line: number }[] = []
  const lines = p.rawText.split("\n")
  const block = ruleBlockEnd(lines)
  let proseFrom = block === undefined ? 0 : block + 1
  if (block === undefined) {
    let i = 0
    while (i < lines.length && lines[i]!.startsWith("@")) i++
    const sep = lines[i]?.trim() ?? ""
    if (i > 0 && DASHES.test(sep)) {
      out.push({
        severity: "error",
        code: "separator",
        message: `${p.name}: rule lines found but the separator is "${sep}"; River expects "--", so the rules above it are read as prose`,
        line: i,
      })
      proseFrom = i + 1
    }
  }
  for (let k = proseFrom; k < lines.length; k++) {
    const ln = lines[k]!
    if (RULE_WORD.test(ln) && findLinks(ln).length === 0) {
      out.push({
        severity: "warn",
        code: "rule-in-prose",
        message: `${p.name}: "${ln.trim()}" is read as prose. Rules go at the top of the passage, then a line "--"; choice rules go on the link's line.`,
        line: k,
      })
    }
  }
  return out
}

/** Passages a breadth-first walk over choice links reaches from the roots, ignoring conditions. */
export function reachable(story: Story, roots: Passage[], index: StoryIndex = createStoryIndex(story)): Set<Passage> {
  const seen = new Set<Passage>(roots)
  const queue = [...roots]
  for (let head = 0; head < queue.length; head++) {
    const p = queue[head]!
    for (const c of p.choices) {
      const to = choiceTarget(story, c.target, index)
      if (to.kind === "passage" && !seen.has(to.passage)) { seen.add(to.passage); queue.push(to.passage) }
    }
  }
  return seen
}

/** Every `visit` atom in a condition. */
export function visitRefs(cond: Cond | undefined, out: string[] = []): string[] {
  if (!cond) return out
  if (cond.kind === "visit") out.push(cond.passageId)
  else if (cond.kind === "and" || cond.kind === "or") cond.terms.forEach((t) => visitRefs(t, out))
  else if (cond.kind === "not") visitRefs(cond.term, out)
  return out
}

/**
 * Rules: broken-link (error), unknown-var (error), type-mismatch (error), duplicate-name (error),
 * duplicate-id (error), separator (error: a rule block closed by something other than `--`),
 * never-true (warn: a condition, or a @cost, no value in the schema ranges satisfies),
 * blocked-choice (warn: a choice can be open while its target's @when is false),
 * rule-in-prose (warn: a rule line River reads as prose), dead-end (warn: no choices and no @end),
 * unreachable (warn: no route from the start, an interrupt or a storylet),
 * auto-not-interrupt (warn: `@auto` on a passage not tagged [interrupt]).
 */
export function lint(story: Story, schema: StateSchema): Diagnostic[] {
  const out: Diagnostic[] = []
  const passages = contentPassages(story)
  const add = (severity: Diagnostic["severity"], code: string, message: string, p: Passage, span?: SourceSpan) =>
    out.push({ severity, code, message, passageId: p.id, span: span ?? p.span })

  // Duplicates (all passages, code passages included: names share one namespace).
  const byName = new Map<string, Passage>()
  const byId = new Map<string, Passage>()
  for (const p of story.passages) {
    const n = byName.get(p.name)
    if (n) add("error", "duplicate-name", `${p.name}: another passage has this name (line ${n.span.line})`, p)
    else byName.set(p.name, p)
    const i = byId.get(p.id)
    if (i) add("error", "duplicate-id", `${p.name}: id "${p.id}" is also used by ${i.name}`, p)
    else byId.set(p.id, p)
  }

  const index = createStoryIndex(story)
  const start = resolveTarget(story, story.start, index)
  if (!start) out.push({ severity: "error", code: "broken-link", message: `start passage "${story.start}" does not exist`, span: { file: story.file, line: 1, column: 1 } })

  const condRule = (p: Passage, cond: Cond, where: string, span: SourceSpan) => {
    const problems = checkCond(cond, schema)
    for (const pr of problems) add("error", pr.code, `${where}: ${pr.message}`, p, span)
    if (problems.length === 0 && !satisfiable([cond], schema)) {
      add("warn", "never-true", `${where}: @when ${formatCond(cond)} is never true`, p, span)
    }
    return problems.length === 0
  }
  const effectRule = (p: Passage, effects: Effect[], where: string, span: SourceSpan) => {
    const problems = checkEffects(effects, schema)
    for (const pr of problems) add("error", pr.code, `${where}: ${pr.message}`, p, span)
    return problems.length === 0
  }

  const interrupts = passages.filter(isInterrupt)
  const storylets = passages.filter(isStorylet)
  // Interrupts and storylets are detours: a `@return` inside one goes back to where it started.
  const fromDetours = reachable(story, [...interrupts, ...storylets], index)
  const visitRule = (p: Passage, cond: Cond | undefined, where: string, span: SourceSpan) => {
    for (const id of new Set(visitRefs(cond))) {
      if (index.byId.has(id)) continue
      const named = index.byName.get(id)
      add("error", "unknown-passage", `${where}: no passage has id "${id}"${named ? ` (passage ${named.name} has id "${named.id}")` : ""}`, p, span)
    }
  }
  const templateRule = (p: Passage) => {
    const prose = proseText(p.text, { keepCues: true })
    if (!prose.includes("{")) return
    const refs = templateRefs(prose)
    for (const e of refs.errors) add("warn", "template", `${p.name}: ${e.message}`, p)
    for (const cond of refs.conds) {
      const where = `${p.name} {when ${formatCond(cond)}}`
      const problems = checkCond(cond, schema)
      for (const pr of problems) add("error", pr.code, `${where}: ${pr.message}`, p)
      if (problems.length === 0 && !satisfiable([cond], schema)) add("warn", "never-true", `${where}: ${formatCond(cond)} is never true`, p)
      visitRule(p, cond, where, p.span)
    }
    for (const v of refs.variables) {
      if (!schema[v]) add("warn", "template-var", `${p.name}: {${v}} names no variable in the state schema, so it shows as written`, p)
    }
  }

  for (const p of passages) {
    for (const s of strayRules(p)) add(s.severity, s.code, s.message, p, { file: p.span.file, line: p.span.line + 1 + s.line, column: 1 })
    if (p.when) condRule(p, p.when, p.name, p.span)
    visitRule(p, p.when, p.name, p.span)
    effectRule(p, p.onEnter, p.name, p.span)
    templateRule(p)
    for (const c of p.choices) {
      const where = `${p.name} → ${c.target}`
      visitRule(p, c.when, where, c.span)
      const to = choiceTarget(story, c.target, index)
      if (to.kind === "missing") add("error", "broken-link", `${where}: no passage has this name`, p, c.span)
      if (to.kind === "return" && !fromDetours.has(p)) {
        add("error", "broken-link", `${where}: no interrupt passage leads here, so there is nothing to return to (tag the passage that starts the detour [interrupt])`, p, c.span)
      }
      const whenOk = !c.when || condRule(p, c.when, where, c.span)
      const costOk = effectRule(p, c.cost, where, c.span)
      const cost = costCond(c)
      if (cost && costOk && whenOk && (!c.when || satisfiable([c.when], schema)) && !satisfiable([choiceGuard(c)!], schema)) {
        add("warn", "never-true", `${where}: @cost needs ${formatCond(cost)}${c.when ? ` with @when ${formatCond(c.when)}` : ""}, which is never true`, p, c.span)
      }
      const blocked = to.kind === "passage" && blockedChoice(p, c, to.passage, schema)
      if (blocked) add("warn", "blocked-choice", blocked, p, c.span)
      effectRule(p, c.set, where, c.span)
    }
    if (p.choices.length === 0 && !p.isEnding) add("warn", "dead-end", `${p.name}: dead end, no link and no @end`, p)
    if (p.auto && !isInterrupt(p)) add("warn", "auto-not-interrupt", `${p.name}: @auto only starts passages tagged [interrupt]; tag it [interrupt] or drop @auto`, p)
  }

  if (start) {
    const seen = reachable(story, [start, ...interrupts, ...storylets], index)
    for (const p of passages) if (!seen.has(p)) add("warn", "unreachable", `${p.name}: no route from the start reaches it`, p)
  }

  return out
}
