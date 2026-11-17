import type { CmpOp, Cond, Effect, GameState, StateSchema, VarDecl } from "./types"

type Value = number | string | boolean

type Token =
  | { t: "ident"; v: string }
  | { t: "num"; v: number }
  | { t: "str"; v: string }
  | { t: "op"; v: CmpOp }
  | { t: "lp" }
  | { t: "rp" }

const KEYWORDS = new Set(["and", "or", "not", "true", "false"])
const IDENT = /^[A-Za-z_][A-Za-z0-9_.]*$/

function tokenize(src: string): Token[] {
  const out: Token[] = []
  let i = 0
  while (i < src.length) {
    const c = src[i]!
    if (/\s/.test(c)) { i++; continue }
    if (c === "(") { out.push({ t: "lp" }); i++; continue }
    if (c === ")") { out.push({ t: "rp" }); i++; continue }
    const two = src.slice(i, i + 2)
    if (two === "==" || two === "!=" || two === "<=" || two === ">=") {
      out.push({ t: "op", v: two }); i += 2; continue
    }
    if (c === "<" || c === ">") { out.push({ t: "op", v: c }); i++; continue }
    if (c === '"') {
      let j = i + 1
      let s = ""
      while (j < src.length && src[j] !== '"') {
        if (src[j] === "\\" && j + 1 < src.length) j++
        s += src[j]
        j++
      }
      if (j >= src.length) throw new Error(`unterminated string in "${src}"`)
      out.push({ t: "str", v: s })
      i = j + 1
      continue
    }
    const num = /^-?\d+(\.\d+)?/.exec(src.slice(i))
    if (num) { out.push({ t: "num", v: Number(num[0]) }); i += num[0].length; continue }
    const id = /^[A-Za-z_][A-Za-z0-9_.]*/.exec(src.slice(i))
    if (id) { out.push({ t: "ident", v: id[0] }); i += id[0].length; continue }
    throw new Error(`unexpected "${c}" in "${src}"`)
  }
  return out
}

/** Parse "a >= 1 and (mood == SURGE or not b)". Bare words on the right are enum values. */
export function parseCond(src: string): Cond {
  const toks = tokenize(src)
  let pos = 0
  const peek = () => toks[pos]
  const isWord = (w: string) => { const t = peek(); return t?.t === "ident" && t.v === w }

  function parseOr(): Cond {
    const terms = [parseAnd()]
    while (isWord("or")) { pos++; terms.push(parseAnd()) }
    return terms.length === 1 ? terms[0]! : { kind: "or", terms }
  }
  function parseAnd(): Cond {
    const terms = [parseUnary()]
    while (isWord("and")) { pos++; terms.push(parseUnary()) }
    return terms.length === 1 ? terms[0]! : { kind: "and", terms }
  }
  function parseUnary(): Cond {
    const t = peek()
    if (!t) throw new Error(`condition ends too early: "${src}"`)
    if (t.t === "ident" && t.v === "not") { pos++; return { kind: "not", term: parseUnary() } }
    if (t.t === "lp") {
      pos++
      const inner = parseOr()
      if (peek()?.t !== "rp") throw new Error(`missing ")" in "${src}"`)
      pos++
      return inner
    }
    if (t.t === "ident" && !KEYWORDS.has(t.v)) {
      pos++
      const op = peek()
      if (op?.t !== "op") {
        // A bare variable means "variable == true".
        return { kind: "cmp", variable: t.v, op: "==", value: true }
      }
      pos++
      return { kind: "cmp", variable: t.v, op: op.v, value: parseValue() }
    }
    throw new Error(`expected a variable in "${src}"`)
  }
  function parseValue(): Value {
    const t = peek()
    if (!t) throw new Error(`missing value in "${src}"`)
    pos++
    if (t.t === "num" || t.t === "str") return t.v
    if (t.t === "ident") {
      if (t.v === "true") return true
      if (t.v === "false") return false
      if (KEYWORDS.has(t.v)) throw new Error(`unexpected "${t.v}" in "${src}"`)
      return t.v
    }
    throw new Error(`expected a value in "${src}"`)
  }

  const cond = parseOr()
  if (pos < toks.length) throw new Error(`unexpected text after condition in "${src}"`)
  return cond
}

/** Format a value as it appears on the right of a comparison or an effect. */
export function formatValue(v: Value): string {
  if (typeof v === "number" || typeof v === "boolean") return String(v)
  if (IDENT.test(v) && !KEYWORDS.has(v)) return v
  return JSON.stringify(v)
}

/** Inverse of parseCond. parseCond(formatCond(c)) deep-equals c. */
export function formatCond(cond: Cond): string {
  const wrap = (c: Cond) => (c.kind === "and" || c.kind === "or" ? `(${formatCond(c)})` : formatCond(c))
  switch (cond.kind) {
    case "cmp": return `${cond.variable} ${cond.op} ${formatValue(cond.value)}`
    case "and": return cond.terms.map(wrap).join(" and ")
    case "or": return cond.terms.map(wrap).join(" or ")
    case "not": return `not ${wrap(cond.term)}`
  }
}

export function evalCond(cond: Cond, state: GameState): boolean {
  switch (cond.kind) {
    case "and": return cond.terms.every((t) => evalCond(t, state))
    case "or": return cond.terms.some((t) => evalCond(t, state))
    case "not": return !evalCond(cond.term, state)
    case "cmp": {
      const a = state[cond.variable]
      const b = cond.value
      if (cond.op === "==") return a === b
      if (cond.op === "!=") return a !== b
      if (typeof a !== "number" || typeof b !== "number") return false
      if (cond.op === "<") return a < b
      if (cond.op === "<=") return a <= b
      if (cond.op === ">") return a > b
      return a >= b
    }
  }
}

/** Split on commas that are not inside double quotes. */
function splitTopLevel(src: string): string[] {
  const parts: string[] = []
  let cur = ""
  let inStr = false
  for (let i = 0; i < src.length; i++) {
    const c = src[i]!
    if (c === '"' && src[i - 1] !== "\\") inStr = !inStr
    if (c === "," && !inStr) { parts.push(cur); cur = "" } else cur += c
  }
  parts.push(cur)
  return parts
}

function parseEffectValue(raw: string, whole: string): Value {
  const s = raw.trim()
  if (s === "") throw new Error(`missing value in "${whole}"`)
  if (s === "true") return true
  if (s === "false") return false
  if (/^-?\d+(\.\d+)?$/.test(s)) return Number(s)
  if (s.startsWith('"')) {
    if (s.length < 2 || !s.endsWith('"')) throw new Error(`unterminated string in "${whole}"`)
    return s.slice(1, -1).replace(/\\(.)/g, "$1")
  }
  if (IDENT.test(s)) return s
  throw new Error(`bad value "${s}" in "${whole}"`)
}

/** Parse "bond += 10, energy -= 8, bond *= 0.5, bond /= 2, mood = CALM". "-=" adds the negative, "/=" multiplies by the inverse. */
export function parseEffects(src: string): Effect[] {
  if (src.trim() === "") return []
  return splitTopLevel(src).map((part): Effect => {
    const whole = part.trim()
    const m = /^([A-Za-z_][A-Za-z0-9_.]*)\s*(\+=|-=|\*=|\/=|=)\s*([\s\S]*)$/.exec(whole)
    if (!m) throw new Error(`bad effect "${whole}" (expected "var += n", "var -= n", "var *= n", "var /= n" or "var = value")`)
    const variable = m[1]!
    const op = m[2]!
    const value = parseEffectValue(m[3]!, whole)
    if (op === "=") return { variable, op: "set", amount: value }
    if (typeof value !== "number") throw new Error(`"${op}" needs a number in "${whole}"`)
    if (op === "/=" && value === 0) throw new Error(`cannot divide by 0 in "${whole}"`)
    if (op === "*=") return { variable, op: "mul", amount: value }
    if (op === "/=") return { variable, op: "mul", amount: 1 / value }
    return { variable, op: "add", amount: op === "-=" ? -value : value }
  })
}

export function formatEffects(effects: Effect[]): string {
  return effects
    .map((e) => {
      if (typeof e.amount === "number" && e.op === "add") return e.amount < 0 ? `${e.variable} -= ${-e.amount}` : `${e.variable} += ${e.amount}`
      if (typeof e.amount === "number" && e.op === "mul") return `${e.variable} *= ${e.amount}`
      return `${e.variable} = ${formatValue(e.amount)}`
    })
    .join(", ")
}

/** A number after an effect: clamped to the schema range, and whole for an int. */
export function settleNumber(v: number, decl: VarDecl | undefined): number {
  if (!decl || (decl.type !== "number" && decl.type !== "int")) return v
  if (decl.type === "int") v = Math.trunc(v)
  if (decl.min !== undefined && v < decl.min) v = decl.min
  if (decl.max !== undefined && v > decl.max) v = decl.max
  return v
}

/** Apply effects and clamp numbers to the schema range. Returns a new object. */
export function applyEffects(state: GameState, effects: Effect[], schema: StateSchema): GameState {
  const next: GameState = { ...state }
  for (const e of effects) {
    const cur = next[e.variable]
    const n = typeof cur === "number" ? cur : 0
    const by = typeof e.amount === "number" ? e.amount : 0
    let v: Value
    switch (e.op) {
      case "add": v = n + by; break
      case "mul": v = n * by; break
      case "set": v = e.amount; break
    }
    next[e.variable] = typeof v === "number" ? settleNumber(v, schema[e.variable]) : v
  }
  return next
}

/** The initial value of each variable: decl.initial, else min (number/int, default 0), false, or the first enum value. */
export function initialState(schema: StateSchema): GameState {
  const s: GameState = {}
  for (const [name, decl] of Object.entries(schema)) {
    switch (decl.type) {
      case "number":
      case "int":
        s[name] = decl.initial ?? decl.min ?? 0
        break
      case "bool":
        s[name] = decl.initial ?? false
        break
      case "enum":
        s[name] = decl.initial ?? decl.values[0] ?? ""
        break
    }
  }
  return s
}
