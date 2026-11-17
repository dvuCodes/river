import { applyEffects, evalCond, formatCond } from "../story/cond"
import { contentPassages, resolveTarget } from "../story/model"
import type { Choice, Cond, Diagnostic, Effect, Passage, SourceSpan, StateSchema, Story } from "../story/types"
import { satisfiable } from "./sat"

/** Type problems in one condition. Empty when it is well typed. */
function checkCond(cond: Cond, schema: StateSchema): { code: string; message: string }[] {
  const out: { code: string; message: string }[] = []
  const walk = (c: Cond) => {
    if (c.kind === "and" || c.kind === "or") return c.terms.forEach(walk)
    if (c.kind === "not") return walk(c.term)
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
    if (e.op === "add" && decl.type !== "number" && decl.type !== "int") {
      out.push({ code: "type-mismatch", message: `${e.variable} is a ${decl.type}; "+=" and "-=" need a number` })
      continue
    }
    switch (decl.type) {
      case "number":
      case "int":
        if (typeof v !== "number") out.push({ code: "type-mismatch", message: `${e.variable} is a ${decl.type}, set to ${JSON.stringify(v)}` })
        else if (decl.type === "int" && !Number.isInteger(v)) out.push({ code: "type-mismatch", message: `${e.variable} is an int, changed by ${v}` })
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
  if (cond.variable !== effect.variable) return cond
  const decl = schema[effect.variable]
  if (effect.op === "set") return evalCond(cond, applyEffects({}, [effect], schema)) ? TRUE : FALSE
  if (!decl || (decl.type !== "number" && decl.type !== "int") || typeof effect.amount !== "number" || typeof cond.value !== "number") return undefined
  const lo = decl.min ?? -Infinity
  const hi = decl.max ?? Infinity
  const x = cond.value
  const shifted: Cond = { ...cond, value: x - effect.amount }
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
 * A choice shows when its @when holds, but its target can be entered only when the target's @when holds on
 * the state after the choice's @cost and @set. The message for a state that allows the first and not the second.
 */
function blockedChoice(p: Passage, choice: Choice, target: Passage, schema: StateSchema): string | undefined {
  if (!target.when || checkCond(target.when, schema).length > 0 || (choice.when && checkCond(choice.when, schema).length > 0)) return undefined
  let needed: Cond | undefined = target.when
  for (const e of [...choice.cost, ...choice.set].reverse()) needed = needed && beforeEffect(needed, e, schema)
  if (!needed) return undefined
  const shows = choice.when ? [choice.when] : []
  if (!satisfiable(shows, schema) || !satisfiable([...shows, { kind: "not", term: needed }], schema)) return undefined
  const effects = choice.cost.length + choice.set.length > 0 ? " after the choice's @cost and @set" : ""
  const where = `${p.name} → ${choice.target}`
  if (!satisfiable([...shows, needed], schema)) {
    return `${where}: ${target.name} has @when ${formatCond(target.when)}, which is never true${effects} when this choice shows, so the move always fails. Loosen one of the two conditions.`
  }
  // When the needed condition already implies the choice's own, it alone is the fix.
  const keepOwn = choice.when && satisfiable([needed, { kind: "not", term: choice.when }], schema)
  return (
    `${where}: the choice can show while ${target.name} cannot be entered (its @when ${formatCond(target.when)} is false${effects}). ` +
    `Give the choice @when ${formatCond(keepOwn ? join("and", [choice.when!, needed]) : needed)}, or loosen ${target.name}'s @when.`
  )
}

/**
 * Rules: broken-link (error), unknown-var (error), type-mismatch (error), duplicate-name (error),
 * duplicate-id (error), never-true (warn: a condition no value in the schema ranges satisfies),
 * blocked-choice (warn: a choice can show while its target's @when keeps the player out),
 * dead-end (warn: no choices and no @end), unreachable (warn: no route from the start).
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

  const start = resolveTarget(story, story.start)
  if (!start) out.push({ severity: "error", code: "broken-link", message: `start passage "${story.start}" does not exist`, span: { file: story.file, line: 1, column: 1 } })

  const condRule = (p: Passage, cond: Cond, where: string, span: SourceSpan) => {
    const problems = checkCond(cond, schema)
    for (const pr of problems) add("error", pr.code, `${where}: ${pr.message}`, p, span)
    if (problems.length === 0 && !satisfiable([cond], schema)) {
      add("warn", "never-true", `${where}: @when ${formatCond(cond)} is never true`, p, span)
    }
  }
  const effectRule = (p: Passage, effects: Effect[], where: string, span: SourceSpan) => {
    for (const pr of checkEffects(effects, schema)) add("error", pr.code, `${where}: ${pr.message}`, p, span)
  }

  for (const p of passages) {
    if (p.when) condRule(p, p.when, p.name, p.span)
    effectRule(p, p.onEnter, p.name, p.span)
    for (const c of p.choices) {
      const where = `${p.name} → ${c.target}`
      const target = resolveTarget(story, c.target)
      if (!target) add("error", "broken-link", `${where}: no passage has this name`, p, c.span)
      if (c.when) condRule(p, c.when, where, c.span)
      const blocked = target && blockedChoice(p, c, target, schema)
      if (blocked) add("warn", "blocked-choice", blocked, p, c.span)
      effectRule(p, c.cost, where, c.span)
      effectRule(p, c.set, where, c.span)
    }
    if (p.choices.length === 0 && !p.isEnding) add("warn", "dead-end", `${p.name}: dead end, no link and no @end`, p)
  }

  // Reachability, ignoring conditions.
  if (start) {
    const seen = new Set<Passage>([start])
    const queue = [start]
    while (queue.length > 0) {
      const p = queue.shift()!
      for (const c of p.choices) {
        const t = resolveTarget(story, c.target)
        if (t && !seen.has(t)) { seen.add(t); queue.push(t) }
      }
    }
    for (const p of passages) if (!seen.has(p)) add("warn", "unreachable", `${p.name}: no route from the start reaches it`, p)
  }

  return out
}
