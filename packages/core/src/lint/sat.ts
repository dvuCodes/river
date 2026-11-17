/**
 * Can a set of conditions all be true at once, given the schema ranges?
 * Conditions are put in negation normal form, expanded to DNF, and each clause is
 * checked by narrowing one domain per variable (an interval for numbers, a value set
 * for bool and enum). Number/int min and max are hard bounds because applyEffects clamps.
 * Unknown variables are unconstrained. If the DNF grows too large we answer "satisfiable"
 * (we only want to flag conditions that are certainly impossible).
 */
import type { CmpOp, Cond, StateSchema, VarDecl } from "../story/types"

type Atom = { variable: string; op: CmpOp; value: number | string | boolean }

const NEGATE: Record<CmpOp, CmpOp> = { "==": "!=", "!=": "==", "<": ">=", "<=": ">", ">": "<=", ">=": "<" }

/** Push `not` down to the comparisons. */
function nnf(c: Cond, neg: boolean): Cond {
  switch (c.kind) {
    case "cmp": return neg ? { ...c, op: NEGATE[c.op] } : c
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

const MAX_CLAUSES = 2000

/** DNF of an NNF condition: a list of clauses, each a list of atoms. Null if too big. */
function dnf(c: Cond): Atom[][] | null {
  switch (c.kind) {
    case "cmp": return [[{ variable: c.variable, op: c.op, value: c.value }]]
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

interface NumDom { lo: number; loStrict: boolean; hi: number; hiStrict: boolean; isInt: boolean; not: Set<number> }

function numEmpty(d: NumDom): boolean {
  if (d.isInt) {
    const lo = d.lo === -Infinity ? -Infinity : d.loStrict && Number.isInteger(d.lo) ? d.lo + 1 : Math.ceil(d.lo)
    const hi = d.hi === Infinity ? Infinity : d.hiStrict && Number.isInteger(d.hi) ? d.hi - 1 : Math.floor(d.hi)
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

function clauseSatisfiable(clause: Atom[], schema: StateSchema): boolean {
  const nums = new Map<string, NumDom>()
  const sets = new Map<string, Set<string | boolean>>()
  for (const a of clause) {
    const decl: VarDecl | undefined = schema[a.variable]
    if (!decl) continue // unknown variable: no constraint
    if (decl.type === "number" || decl.type === "int") {
      let d = nums.get(a.variable)
      if (!d) {
        d = { lo: decl.min ?? -Infinity, loStrict: false, hi: decl.max ?? Infinity, hiStrict: false, isInt: decl.type === "int", not: new Set() }
        nums.set(a.variable, d)
      }
      if (typeof a.value !== "number") {
        if (a.op !== "!=") return false
        continue
      }
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
      if (numEmpty(d)) return false
    } else {
      let s = sets.get(a.variable)
      if (!s) {
        s = new Set<string | boolean>(decl.type === "bool" ? [true, false] : decl.values)
        sets.set(a.variable, s)
      }
      if (a.op === "==") {
        const keep = s.has(a.value as string | boolean)
        s.clear()
        if (keep) s.add(a.value as string | boolean)
      } else if (a.op === "!=") {
        s.delete(a.value as string | boolean)
      } else {
        return false // ordering on bool/enum is never true
      }
      if (s.size === 0) return false
    }
  }
  return true
}

/** True if some state within the schema ranges makes every condition true. */
export function satisfiable(conds: Cond[], schema: StateSchema): boolean {
  if (conds.length === 0) return true
  const all: Cond = conds.length === 1 ? conds[0]! : { kind: "and", terms: conds }
  const clauses = dnf(nnf(all, false))
  if (!clauses) return true
  return clauses.some((c) => clauseSatisfiable(c, schema))
}
