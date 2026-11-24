/**
 * Reactive prose: small inline templates inside passage text.
 *
 *   {when bond > 50: Rex leans on you. | Rex keeps his distance.}
 *   You have {treats} treats left.
 *   {once: The gate creaks the first time.}
 *   {cycle: A duck. | Two ducks. | Too many ducks.}
 *   {shuffle: Quack. | Honk. | Splash.}
 *
 * Only these forms are templates. Any other `{...}` (CSS, JSON, a bracketed aside) stays as written, and a
 * `[[link]]` is never split, so ordinary Twine prose renders unchanged. Inside a template, `\|`, `\{`, `\}` and
 * `\\` are literal; in plain prose only `\{` and `\}` are.
 */
import { evalCond, parseCond } from "./cond"
import { stripLineId } from "./passage"
import type { Cond, GameState } from "./types"

export type TemplateNode =
  | { kind: "text"; text: string }
  | { kind: "var"; name: string }
  | { kind: "when"; cond: Cond; source: string; then: TemplateNode[]; else?: TemplateNode[] }
  | { kind: "once"; body: TemplateNode[] }
  | { kind: "cycle"; options: TemplateNode[][] }
  | { kind: "shuffle"; options: TemplateNode[][] }
  /** A template keyword with a body River cannot read (a bad condition, no ":"). It renders as written. */
  | { kind: "invalid"; raw: string; error: string }

const VAR = /^[A-Za-z_][A-Za-z0-9_.]*$/

/** Index of the `}` that closes the `{` at `open`, or -1. Skips escapes and `[[...]]` links, counts nested braces. */
function closingBrace(text: string, open: number): number {
  let depth = 0
  for (let i = open; i < text.length; i++) {
    const c = text[i]!
    if (c === "\\") { i++; continue }
    if (c === "[" && text[i + 1] === "[") {
      const end = text.indexOf("]]", i + 2)
      if (end < 0) return -1
      i = end + 1
      continue
    }
    if (c === "{") depth++
    else if (c === "}" && --depth === 0) return i
  }
  return -1
}

/** Split `text` on `sep` at brace depth 0, outside `[[...]]` links, escapes and (with quotes) double-quoted strings. */
function splitTop(text: string, sep: string, opts: { quotes?: boolean; max?: number } = {}): string[] {
  const parts: string[] = []
  let depth = 0
  let inStr = false
  let from = 0
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!
    if (c === "\\") { i++; continue }
    if (opts.quotes && c === '"') { inStr = !inStr; continue }
    if (inStr) continue
    if (c === "[" && text[i + 1] === "[") {
      const end = text.indexOf("]]", i + 2)
      if (end >= 0) { i = end + 1; continue }
    }
    if (c === "{") depth++
    else if (c === "}") depth--
    else if (c === sep && depth === 0 && (opts.max === undefined || parts.length < opts.max - 1)) {
      parts.push(text.slice(from, i))
      from = i + 1
    }
  }
  parts.push(text.slice(from))
  return parts
}

function nodes(text: string, nested: boolean): TemplateNode[] {
  const out: TemplateNode[] = []
  let buf = ""
  const flush = () => {
    if (buf) out.push({ kind: "text", text: buf })
    buf = ""
  }
  const literal = nested ? "{}|\\" : "{}"
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!
    if (c === "\\" && i + 1 < text.length && literal.includes(text[i + 1]!)) {
      buf += text[i + 1]
      i++
      continue
    }
    if (c === "[" && text[i + 1] === "[") {
      const end = text.indexOf("]]", i + 2)
      if (end >= 0) { buf += text.slice(i, end + 2); i = end + 1; continue }
    }
    if (c !== "{") { buf += c; continue }
    const close = closingBrace(text, i)
    if (close < 0) { buf += c; continue }
    const node = templateNode(text.slice(i + 1, close), text.slice(i, close + 1))
    if (node) { flush(); out.push(node) } else buf += text.slice(i, close + 1)
    i = close
  }
  flush()
  return out
}

const branch = (s: string) => nodes(s.trim(), true)

/** The node for the inside of one `{...}`, or undefined when it is not a template (it stays literal text). */
function templateNode(inner: string, raw: string): TemplateNode | undefined {
  if (VAR.test(inner)) return { kind: "var", name: inner }
  const when = /^\s*when\s+([\s\S]*)$/.exec(inner)
  if (when) {
    const [source, body] = splitTop(when[1]!, ":", { quotes: true, max: 2 })
    if (body === undefined) return { kind: "invalid", raw, error: `{when ...} needs ":" after the condition` }
    let cond: Cond
    try {
      cond = parseCond(source!.trim())
    } catch (e) {
      return { kind: "invalid", raw, error: `{when ${source!.trim()}: ...}: ${(e as Error).message}` }
    }
    const options = splitTop(body, "|")
    if (options.length > 2) return { kind: "invalid", raw, error: `{when ...} takes one "|" (then | else); escape a literal one as \\|` }
    const node: TemplateNode = { kind: "when", cond, source: source!.trim(), then: branch(options[0]!) }
    if (options.length === 2) node.else = branch(options[1]!)
    return node
  }
  const keyed = /^\s*(once|cycle|shuffle)\s*:([\s\S]*)$/.exec(inner)
  if (!keyed) return undefined
  const body = keyed[2]!
  if (keyed[1] === "once") return { kind: "once", body: branch(body) }
  const options = splitTop(body, "|").map(branch)
  return { kind: keyed[1] as "cycle" | "shuffle", options }
}

/** Parse prose into template nodes. Never throws; text that is not a template comes back as text nodes. */
export function parseTemplate(text: string): TemplateNode[] {
  return nodes(text, false)
}

export interface RenderContext {
  state: GameState
  /** Passage id -> times entered, for `visited(id)` / `visits(id)` in `{when}`. */
  visits?: Readonly<Record<string, number>>
  /** How many times the player has entered the passage being rendered (1 on the first visit). Default 1. */
  visitCount?: number
  /** For `{shuffle}`: a number in [0, 1). Without it the pick is `visitCount % n`, so renders repeat. */
  rng?: () => number
}

function renderNodes(list: TemplateNode[], ctx: RenderContext): string {
  const visitCount = ctx.visitCount ?? 1
  let out = ""
  for (const n of list) {
    switch (n.kind) {
      case "text": out += n.text; break
      case "var": {
        const v = ctx.state[n.name]
        out += v === undefined ? `{${n.name}}` : String(v)
        break
      }
      case "when": {
        const pick = evalCond(n.cond, ctx.state, ctx.visits ?? {}) ? n.then : n.else
        if (pick) out += renderNodes(pick, ctx)
        break
      }
      case "once": if (visitCount === 1) out += renderNodes(n.body, ctx); break
      case "cycle":
      case "shuffle": {
        const len = n.options.length
        if (len === 0) break
        const at = n.kind === "cycle" ? visitCount - 1 : ctx.rng ? Math.floor(ctx.rng() * len) : visitCount
        out += renderNodes(n.options[((at % len) + len) % len]!, ctx)
        break
      }
      case "invalid": out += n.raw; break
    }
  }
  return out
}

/** The prose with its templates filled in for this state. Text that is not a template is returned as written. */
export function renderProse(text: string, ctx: RenderContext): string {
  const cleaned = text.includes("#line:")
    ? text.split("\n").map((ln) => stripLineId(ln).text).join("\n")
    : text
  return renderNodes(parseTemplate(cleaned), ctx)
}

export interface TemplateRefs {
  /** Every `{when}` condition, in order. */
  conds: Cond[]
  /** Every `{var}` name, without duplicates, in order. */
  variables: string[]
  /** Templates River cannot read, with why. */
  errors: { raw: string; message: string }[]
}

/** What the prose's templates read, so lint can check the names, types and passage ids. */
export function templateRefs(text: string): TemplateRefs {
  const out: TemplateRefs = { conds: [], variables: [], errors: [] }
  const walk = (list: TemplateNode[]) => {
    for (const n of list) {
      switch (n.kind) {
        case "var": if (!out.variables.includes(n.name)) out.variables.push(n.name); break
        case "when": out.conds.push(n.cond); walk(n.then); if (n.else) walk(n.else); break
        case "once": walk(n.body); break
        case "cycle":
        case "shuffle": n.options.forEach(walk); break
        case "invalid": out.errors.push({ raw: n.raw, message: n.error }); break
        case "text": break
      }
    }
  }
  walk(parseTemplate(text))
  return out
}
