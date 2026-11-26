/**
 * Which states the conditions and effects along a route allow, one variable at a time: an interval for numbers,
 * a value set for bool and enum. A Box maps each constrained variable to its domain; a variable missing from a
 * box can be anything in its schema range. A list of boxes is their union: a condition with `or` splits a box.
 *
 * Conditions compare one variable with a constant and effects change one variable by a constant, so variables
 * only interact through `or`. Every step over-approximates (too many boxes merge into one that covers them all,
 * an int `*=` keeps whole bounds), so an empty list means "certainly impossible". Number/int min and max are hard
 * bounds because applyEffects clamps. Unknown variables are never constrained.
 */
import { settleNumber } from "../story/cond"
import type { CmpOp, Cond, Effect, GameState, StateSchema, VarDecl } from "../story/types"

type Atom = { variable: string; op: CmpOp; value: number | string | boolean }

const NEGATE: Record<CmpOp, CmpOp> = { "==": "!=", "!=": "==", "<": ">=", "<=": ">", ">": "<=", ">=": "<" }

/** Push `not` down to the comparisons. */
function nnf(c: Cond, neg: boolean): Cond {
  switch (c.kind) {
    case "cmp": return neg ? { ...c, op: NEGATE[c.op] } : c
    case "visit": return neg ? { ...c, op: NEGATE[c.op] } : c
    case "not": return nnf(c.term, !neg)
    case "and": {
      const terms = c.terms.map((t) => nnf(t, neg))
      return neg ? { kind: "or", terms } : { kind: "and", terms }
    }
    case "or": {
      const terms = c.terms.map((t) => nnf(t, neg))
      return neg ? { kind: "and", terms } : { kind: "or", terms }
    }
  }
}

/** The name a visit count goes by inside the solver. It is not an identifier, so no schema declares it. */
export const visitVariable = (passageId: string) => `@visits(${passageId})`

const MAX_CLAUSES = 2000
const MAX_BOXES = 32

/** DNF of an NNF condition: a list of clauses, each a list of atoms. Null if too big. */
function dnf(c: Cond): Atom[][] | null {
  switch (c.kind) {
    case "cmp": return [[{ variable: c.variable, op: c.op, value: c.value }]]
    // Visit counts are not part of the state schema: a variable no schema declares, so never constrained.
    case "visit": return [[{ variable: visitVariable(c.passageId), op: c.op, value: c.value }]]
    case "not": return null // never happens after nnf
    case "or": {
      const out: Atom[][] = []
      for (const t of c.terms) {
        const d = dnf(t)
        if (!d) return null
        out.push(...d)
        if (out.length > MAX_CLAUSES) return null
      }
      return out
    }
    case "and": {
      let acc: Atom[][] = [[]]
      for (const t of c.terms) {
        const d = dnf(t)
        if (!d) return null
        const next: Atom[][] = []
        for (const a of acc) for (const b of d) next.push([...a, ...b])
        if (next.length > MAX_CLAUSES) return null
        acc = next
      }
      return acc
    }
  }
}

interface NumDom { kind: "num"; lo: number; loStrict: boolean; hi: number; hiStrict: boolean; isInt: boolean; not: Set<number> }
interface SetDom { kind: "set"; values: Set<string | boolean> }
type Dom = NumDom | SetDom
export type Box = Map<string, Dom>

/** Any state within the schema ranges. */
export const anyState = (): Box[] => [new Map()]

function fullDom(decl: VarDecl): Dom {
  if (decl.type === "number" || decl.type === "int") {
    return { kind: "num", lo: decl.min ?? -Infinity, loStrict: false, hi: decl.max ?? Infinity, hiStrict: false, isInt: decl.type === "int", not: new Set() }
  }
  return { kind: "set", values: new Set<string | boolean>(decl.type === "bool" ? [true, false] : decl.values) }
}

const copyDom = (d: Dom): Dom => (d.kind === "num" ? { ...d, not: new Set(d.not) } : { kind: "set", values: new Set(d.values) })

/** The smallest and largest whole numbers an int domain allows. */
function intBounds(d: NumDom): { lo: number; hi: number } {
  const lo = d.lo === -Infinity ? -Infinity : d.loStrict && Number.isInteger(d.lo) ? d.lo + 1 : Math.ceil(d.lo)
  const hi = d.hi === Infinity ? Infinity : d.hiStrict && Number.isInteger(d.hi) ? d.hi - 1 : Math.floor(d.hi)
  return { lo, hi }
}

function numEmpty(d: NumDom): boolean {
  if (d.isInt) {
    const { lo, hi } = intBounds(d)
    if (lo > hi) return true
    if (hi - lo + 1 <= d.not.size) {
      for (let v = lo; v <= hi; v++) if (!d.not.has(v)) return false
      return true
    }
    return false
  }
  if (d.lo > d.hi) return true
  if (d.lo === d.hi) return d.loStrict || d.hiStrict || d.not.has(d.lo)
  return false
}

/** Narrow one domain to the values that satisfy the atom. False when none is left. */
function narrowDom(d: Dom, a: Atom): boolean {
  if (d.kind === "num") {
    if (typeof a.value !== "number") return a.op === "!="
    const v = a.value
    switch (a.op) {
      case "==":
        if (v > d.lo || (v === d.lo && !d.loStrict)) { d.lo = v; d.loStrict = false } else return false
        if (v < d.hi || (v === d.hi && !d.hiStrict)) { d.hi = v; d.hiStrict = false } else return false
        break
      case "!=": d.not.add(v); break
      case ">": if (v >= d.lo) { d.lo = v; d.loStrict = true } break
      case ">=": if (v > d.lo) { d.lo = v; d.loStrict = false } break
      case "<": if (v <= d.hi) { d.hi = v; d.hiStrict = true } break
      case "<=": if (v < d.hi) { d.hi = v; d.hiStrict = false } break
    }
    return !numEmpty(d)
  }
  if (a.op === "==") {
    const keep = d.values.has(a.value as string | boolean)
    d.values.clear()
    if (keep) d.values.add(a.value as string | boolean)
  } else if (a.op === "!=") {
    d.values.delete(a.value as string | boolean)
  } else {
    return false // ordering on bool/enum is never true
  }
  return d.values.size > 0
}

function narrowBox(box: Box, clause: Atom[], schema: StateSchema): Box | undefined {
  const out: Box = new Map(box)
  const copied = new Set<string>()
  for (const a of clause) {
    const decl = schema[a.variable]
    if (!decl) continue // unknown variable: no constraint
    if (!copied.has(a.variable)) {
      const cur = out.get(a.variable)
      out.set(a.variable, cur ? copyDom(cur) : fullDom(decl))
      copied.add(a.variable)
    }
    if (!narrowDom(out.get(a.variable)!, a)) return undefined
  }
  return out
}

/** One box that covers all of them. A variable free in any box is free in the result. */
function hull(boxes: Box[]): Box {
  const [first, ...rest] = boxes
  const out: Box = new Map()
  for (const [name, d0] of first!) {
    const d = copyDom(d0)
    const others = rest.map((b) => b.get(name))
    if (others.some((e) => e === undefined)) continue
    for (const e of others as Dom[]) {
      if (d.kind === "set" && e.kind === "set") {
        for (const v of e.values) d.values.add(v)
      } else if (d.kind === "num" && e.kind === "num") {
        if (e.lo < d.lo) { d.lo = e.lo; d.loStrict = e.loStrict } else if (e.lo === d.lo) d.loStrict &&= e.loStrict
        if (e.hi > d.hi) { d.hi = e.hi; d.hiStrict = e.hiStrict } else if (e.hi === d.hi) d.hiStrict &&= e.hiStrict
        for (const v of d.not) if (!e.not.has(v)) d.not.delete(v)
      }
    }
    out.set(name, d)
  }
  return out
}

const capped = (boxes: Box[]): Box[] => (boxes.length > MAX_BOXES ? [hull(boxes)] : boxes)

/** The part of the boxes where the condition holds. */
export function narrow(boxes: Box[], cond: Cond, schema: StateSchema): Box[] {
  const clauses = dnf(nnf(cond, false))
  if (!clauses) return boxes
  const out: Box[] = []
  for (const box of boxes) {
    for (const clause of clauses) {
      const b = narrowBox(box, clause, schema)
      if (b) out.push(b)
    }
  }
  return capped(out)
}

const point = (v: number, isInt: boolean): NumDom => ({ kind: "num", lo: v, loStrict: false, hi: v, hiStrict: false, isInt, not: new Set() })

/** Where a number domain lands once applyEffects clamps it to the schema range. */
function clampDom(d: NumDom, decl: VarDecl): NumDom {
  if (decl.type !== "number" && decl.type !== "int") return d
  const min = decl.min ?? -Infinity
  const max = decl.max ?? Infinity
  if (d.hi < min || (d.hi === min && d.hiStrict)) return point(min, d.isInt)
  if (d.lo > max || (d.lo === max && d.loStrict)) return point(max, d.isInt)
  if (d.lo < min) { d.lo = min; d.loStrict = false; d.not.clear() }
  if (d.hi > max) { d.hi = max; d.hiStrict = false; d.not.clear() }
  return d
}

function effectOnNum(d: NumDom, e: Effect, decl: VarDecl): NumDom | undefined {
  if (typeof e.amount !== "number") return undefined
  const k = e.amount
  switch (e.op) {
    case "set":
      return point(settleNumber(k, decl), d.isInt)
    case "add":
      return clampDom({ ...d, lo: d.lo + k, hi: d.hi + k, not: new Set([...d.not].map((v) => v + k)) }, decl)
    case "mul": {
      if (k === 0) return point(settleNumber(0, decl), d.isInt)
      if (d.isInt) {
        // trunc is monotone, so whole bounds scaled and truncated cover every result.
        const b = intBounds(d)
        const ends = [Math.trunc(b.lo * k), Math.trunc(b.hi * k)]
        return clampDom({ ...point(0, true), lo: Math.min(...ends), hi: Math.max(...ends) }, decl)
      }
      const flip = k < 0
      return clampDom(
        {
          ...d,
          lo: flip ? d.hi * k : d.lo * k,
          hi: flip ? d.lo * k : d.hi * k,
          loStrict: flip ? d.hiStrict : d.loStrict,
          hiStrict: flip ? d.loStrict : d.hiStrict,
          not: new Set([...d.not].map((v) => v * k)),
        },
        decl,
      )
    }
  }
}

/** The boxes after one effect. */
export function applyEffect(boxes: Box[], e: Effect, schema: StateSchema): Box[] {
  const decl = schema[e.variable]
  if (!decl) return boxes
  return boxes.map((box) => {
    const out: Box = new Map(box)
    const cur = box.get(e.variable) ?? fullDom(decl)
    let next: Dom | undefined
    if (cur.kind === "num") next = effectOnNum(cur, e, decl)
    else if (e.op === "set") next = { kind: "set", values: new Set([e.amount as string | boolean]) }
    // A type error (lint reports it) leaves the variable free.
    if (next) out.set(e.variable, next)
    else out.delete(e.variable)
    return out
  })
}

/** The boxes with these variables free again: the game moved them. */
export function release(boxes: Box[], variables: string[]): Box[] {
  if (variables.length === 0) return boxes
  return boxes.map((box) => {
    const out: Box = new Map(box)
    for (const v of variables) out.delete(v)
    return out
  })
}

/** True if some state within the schema ranges makes every condition true. */
export function satisfiable(conds: Cond[], schema: StateSchema): boolean {
  if (conds.length === 0) return true
  const all: Cond = conds.length === 1 ? conds[0]! : { kind: "and", terms: conds }
  return narrow(anyState(), all, schema).length > 0
}

function domKey(d: Dom): string {
  if (d.kind === "set") return `s${JSON.stringify([...d.values].map(String).sort())}`
  const lo = `${d.loStrict ? "(" : "["}${d.lo}`
  const hi = `${d.hi}${d.hiStrict ? ")" : "]"}`
  return `n${d.isInt ? "i" : ""}${lo},${hi}${d.not.size > 0 ? `!${[...d.not].sort((a, b) => a - b).join("|")}` : ""}`
}

/** A canonical string for one box: equal keys mean the same set of states. */
export function boxKey(box: Box): string {
  return [...box.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([v, d]) => `${v}=${domKey(d)}`).join(";")
}

/** The union of two box lists, without duplicates; too many boxes merge into one that covers them all. */
export function unionBoxes(a: Box[], b: Box[]): Box[] {
  const seen = new Set<string>()
  const out: Box[] = []
  for (const box of [...a, ...b]) {
    const k = boxKey(box)
    if (!seen.has(k)) { seen.add(k); out.push(box) }
  }
  return capped(out)
}

/** A canonical string for a box list (order does not matter). */
export function boxesKey(boxes: Box[]): string {
  return boxes.map(boxKey).sort().join(" | ")
}

/** A box pinning every schema variable to its value in `state`, optionally leaving `engine` variables free. */
export function stateBox(state: GameState, schema: StateSchema, leaveEngineFree = false): Box {
  const box: Box = new Map()
  for (const [name, decl] of Object.entries(schema)) {
    if (leaveEngineFree && decl.engine) continue
    const v = state[name]
    if (v === undefined) continue
    if (decl.type === "number" || decl.type === "int") {
      if (typeof v === "number") box.set(name, point(v, decl.type === "int"))
    } else if (typeof v === "string" || typeof v === "boolean") {
      box.set(name, { kind: "set", values: new Set([v]) })
    }
  }
  return box
}

function pickDomValue(d: Dom, current?: number | string | boolean): number | string | boolean | undefined {
  if (d.kind === "set") {
    if (current !== undefined && d.values.has(current as string | boolean)) return current
    for (const v of d.values) return v
    return undefined
  }
  const inNum = (x: number) =>
    !d.not.has(x) &&
    (d.loStrict ? x > d.lo : x >= d.lo) &&
    (d.hiStrict ? x < d.hi : x <= d.hi) &&
    (!d.isInt || Number.isInteger(x))
  if (typeof current === "number" && inNum(current)) return current
  if (d.isInt) {
    const { lo, hi } = intBounds(d)
    if (lo > hi) return undefined
    if (Number.isFinite(lo)) {
      for (let x = lo; x <= hi; x++) if (!d.not.has(x)) return x
      return undefined
    }
    if (Number.isFinite(hi)) {
      for (let x = hi; x >= lo; x--) if (!d.not.has(x)) return x
      return undefined
    }
    for (let k = 0; ; k++) {
      if (!d.not.has(k)) return k
      if (!d.not.has(-k)) return -k
    }
  }
  if (Number.isFinite(d.lo) && !d.loStrict && inNum(d.lo)) return d.lo
  if (Number.isFinite(d.hi) && !d.hiStrict && inNum(d.hi)) return d.hi
  if (Number.isFinite(d.lo) && Number.isFinite(d.hi)) {
    if (d.lo >= d.hi) return undefined
    for (let n = 2; n <= 16; n++) {
      const mid = d.lo + (d.hi - d.lo) / n
      if (inNum(mid)) return mid
    }
    return undefined
  }
  if (Number.isFinite(d.lo)) {
    for (let k = 1; ; k++) if (inNum(d.lo + k)) return d.lo + k
  }
  if (Number.isFinite(d.hi)) {
    for (let k = 1; ; k++) if (inNum(d.hi - k)) return d.hi - k
  }
  for (let k = 0; ; k++) if (inNum(k)) return k
}

/** Pick values for any `engine: true` variables constrained by `box` that differ from `state`. */
export function sampleEngineUpdates(box: Box, state: GameState, schema: StateSchema): GameState | undefined {
  const updates: GameState = {}
  for (const [name, dom] of box) {
    if (!schema[name]?.engine) continue
    const val = pickDomValue(dom, state[name])
    if (val === undefined) return undefined
    if (val !== state[name]) updates[name] = val
  }
  return updates
}
