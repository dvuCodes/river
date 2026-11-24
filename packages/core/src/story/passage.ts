/**
 * Shared passage-body parsing: links, River `@` rules, choices. Used by the Twee 3 and
 * Twine HTML readers and by model edits (updatePassageText, renamePassage).
 */
import { parseCond, parseEffects } from "./cond"
import type { Choice, Cond, Cue, Diagnostic, Effect, MetaValue, Passage } from "./types"

/** Lowercase, [a-z0-9_] only. */
export function slugify(name: string): string {
  const s = name
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
  return s === "" ? "passage" : s
}

/** Yarn-Spinner-style stable localization line ID suffix (`#line:<id>`). */
export const LINE_ID_RE = /\s*#line:([a-z0-9_-]{4,32})\s*$/i

/** Strip a trailing `#line:<id>` suffix from a line or string, returning the clean text and optional id. */
export function stripLineId(text: string): { text: string; lineId?: string } {
  const m = LINE_ID_RE.exec(text)
  if (!m) return { text }
  return { text: text.slice(0, m.index), lineId: m[1]! }
}

export interface LinkParts {
  label: string
  target: string
  /** How the link was written, so it can be rebuilt with a new target. */
  form: "arrow" | "back" | "pipe" | "plain"
  /** A `][setter` part, kept verbatim (including the leading "]["). */
  setter: string
}

/**
 * Split the inside of `[[...]]` the way Twine's editor finds link targets:
 * drop `][setter`, then the rightmost `->`, else the leftmost `<-`, else the last `|`,
 * else the whole text is both label and target.
 */
export function splitLink(inner: string): LinkParts {
  let body = inner
  let setter = ""
  const s = body.indexOf("][")
  if (s >= 0) { setter = body.slice(s); body = body.slice(0, s) }
  const arrow = body.lastIndexOf("->")
  if (arrow >= 0) return { label: body.slice(0, arrow).trim(), target: body.slice(arrow + 2).trim(), form: "arrow", setter }
  const back = body.indexOf("<-")
  if (back >= 0) return { label: body.slice(back + 2).trim(), target: body.slice(0, back).trim(), form: "back", setter }
  const pipe = body.lastIndexOf("|")
  if (pipe >= 0) return { label: body.slice(0, pipe).trim(), target: body.slice(pipe + 1).trim(), form: "pipe", setter }
  return { label: body.trim(), target: body.trim(), form: "plain", setter }
}

export function isExternalTarget(target: string): boolean {
  return /^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(target)
}

export interface FoundLink extends LinkParts {
  /** Offsets of `[[` and just after `]]` in the searched text. */
  start: number
  end: number
}

/** Every `[[...]]` link in the text (non-greedy), excluding external URLs. */
export function findLinks(text: string): FoundLink[] {
  const out: FoundLink[] = []
  const re = /\[\[([\s\S]*?)\]\]/g
  let m: RegExpExecArray | null
  while ((m = re.exec(text))) {
    const parts = splitLink(m[1]!)
    if (parts.target === "" || isExternalTarget(parts.target)) continue
    out.push({ ...parts, start: m.index, end: m.index + m[0].length })
  }
  return out
}

function buildLink(p: LinkParts): string {
  switch (p.form) {
    case "arrow": return `[[${p.label}->${p.target}${p.setter}]]`
    case "back": return `[[${p.target}<-${p.label}${p.setter}]]`
    case "pipe": return `[[${p.label}|${p.target}${p.setter}]]`
    case "plain": return `[[${p.label}${p.setter}]]`
  }
}

/** Rewrite every link that targets oldName so it targets newName. The label text stays the same. */
export function rewriteLinks(text: string, oldName: string, newName: string): string {
  let out = ""
  let last = 0
  for (const l of findLinks(text)) {
    if (l.target !== oldName) continue
    const form = l.form === "plain" ? "arrow" : l.form
    out += text.slice(last, l.start) + buildLink({ ...l, form, target: newName })
    last = l.end
  }
  return out + text.slice(last)
}

/** Split `@cost a 1 @set b += 2 @when c > 1` into its rules. */
function splitRules(segment: string): { word: string; body: string }[] {
  const out: { word: string; body: string }[] = []
  const re = /(?:^|\s)@([A-Za-z]+)\b/g
  const marks: { word: string; at: number; bodyStart: number }[] = []
  let m: RegExpExecArray | null
  while ((m = re.exec(segment))) {
    if (insideQuotes(segment, m.index)) continue
    marks.push({ word: m[1]!, at: m.index, bodyStart: m.index + m[0].length })
  }
  marks.forEach((mk, i) => {
    const end = i + 1 < marks.length ? marks[i + 1]!.at : segment.length
    out.push({ word: mk.word, body: segment.slice(mk.bodyStart, end).trim() })
  })
  return out
}

/** Parse "treats 1, bond 2" into effects that subtract. */
export function parseCost(src: string): Effect[] {
  return src.split(",").map((part) => {
    const m = /^\s*([A-Za-z_][A-Za-z0-9_.]*)\s+(-?\d+(?:\.\d+)?)\s*$/.exec(part)
    if (!m) throw new Error(`bad cost "${part.trim()}" (expected "var n")`)
    return { variable: m[1]!, op: "add" as const, amount: -Number(m[2]!) }
  })
}

/** True when `at` is inside a double-quoted string of `text` (backslash escapes the next character). */
function insideQuotes(text: string, at: number): boolean {
  let inside = false
  for (let i = 0; i < at; i++) {
    if (text[i] === "\\") i++
    else if (text[i] === '"') inside = !inside
  }
  return inside
}

/** Split on commas outside double quotes (backslash escapes the next character). */
function splitCommas(src: string): string[] {
  const parts: string[] = []
  let cur = ""
  let inStr = false
  for (let i = 0; i < src.length; i++) {
    const c = src[i]!
    if (c === "\\" && i + 1 < src.length) { cur += c + src[i + 1]; i++; continue }
    if (c === '"') inStr = !inStr
    if (c === "," && !inStr) { parts.push(cur); cur = "" } else cur += c
  }
  parts.push(cur)
  return parts
}

/**
 * Parse `key=value, key2="text", flag=true` into a record. Values: numbers, true/false, quoted strings
 * (backslash escapes), or bare words taken as strings.
 */
export function parseMeta(src: string): Record<string, MetaValue> {
  const out: Record<string, MetaValue> = {}
  if (src.trim() === "") throw new Error(`@meta needs key=value pairs`)
  for (const part of splitCommas(src)) {
    const whole = part.trim()
    if (whole === "") continue
    const m = /^([A-Za-z_][A-Za-z0-9_.-]*)\s*=\s*([\s\S]*)$/.exec(whole)
    if (!m) throw new Error(`bad @meta "${whole}" (expected key=value)`)
    const raw = m[2]!.trim()
    let value: MetaValue
    if (raw === "") throw new Error(`missing value in @meta "${whole}"`)
    else if (raw === "true" || raw === "false") value = raw === "true"
    else if (/^-?\d+(\.\d+)?$/.test(raw)) value = Number(raw)
    else if (raw.startsWith('"')) {
      if (raw.length < 2 || !raw.endsWith('"')) throw new Error(`unterminated string in @meta "${whole}"`)
      value = raw.slice(1, -1).replace(/\\(.)/g, "$1")
    } else value = raw
    out[m[1]!] = value
  }
  return out
}

/** `@meta` values written back the way parseMeta reads them. */
export function formatMeta(meta: Record<string, MetaValue>): string {
  return Object.entries(meta)
    .map(([k, v]) => {
      const bare = typeof v !== "string" || (/^[A-Za-z_][A-Za-z0-9_.-]*$/.test(v) && v !== "true" && v !== "false")
      return `${k}=${bare ? String(v) : JSON.stringify(v)}`
    })
    .join(", ")
}

/** Parse the body of `@cue name [args]`. */
export function parseCue(body: string): Cue {
  const m = /^(\S+)(?:\s+([\s\S]*))?$/.exec(body.trim())
  if (!m) throw new Error(`@cue needs a name`)
  const args = m[2]?.trim()
  return args ? { name: m[1]!, args } : { name: m[1]! }
}

/** `"Costs one treat"` -> Costs one treat. Unquoted text is taken as written. */
function parseHint(body: string): string {
  if (!body.startsWith('"')) return body
  if (body.length < 2 || !body.endsWith('"')) throw new Error(`unterminated string in @hint ${body}`)
  return body.slice(1, -1).replace(/\\(.)/g, "$1")
}

/**
 * The line index of the `--` that ends a passage's rule block, or undefined when the text has none.
 * A rule block is the lines starting with `@` at the very top (there may be none), then `--` (trailing spaces allowed).
 */
export function ruleBlockEnd(lines: string[]): number | undefined {
  let i = 0
  while (i < lines.length && lines[i]!.startsWith("@")) i++
  return i < lines.length && lines[i]!.trimEnd() === "--" ? i : undefined
}

function andCond(a: Cond | undefined, b: Cond): Cond {
  if (!a) return b
  if (a.kind === "and") return { kind: "and", terms: [...a.terms, b] }
  return { kind: "and", terms: [a, b] }
}

/** A plain decimal number: `2`, `0.5`, `+1.25`. Not `1e3`, `0x10` or empty. */
const DECIMAL = /^[-+]?(\d+(\.\d*)?|\.\d+)$/

export interface PassageInput {
  name: string
  tags: string[]
  metadata: Record<string, unknown>
  rawText: string
  file: string
  /** Line of the header (`:: Name`). The text starts on the next line. */
  line: number
}

/** Parse one passage body: River rules, prose, choices. Never throws. */
export function parsePassage(input: PassageInput): { passage: Passage; diagnostics: Diagnostic[] } {
  const { name, tags, metadata, rawText, file, line } = input
  const diagnostics: Diagnostic[] = []
  const lines = rawText.split("\n")
  const isCode = tags.includes("script") || tags.includes("stylesheet")

  let id: string | undefined
  let when: Cond | undefined
  const onEnter: Effect[] = []
  let isEnding = false
  let meta: Record<string, MetaValue> | undefined
  let shot: string | undefined
  const cues: Cue[] = []
  let weight: number | undefined
  let priority: number | undefined
  let cooldown: number | undefined
  let auto = false
  let textStart = 0

  const diag = (severity: Diagnostic["severity"], message: string, lineNo: number, column = 1) =>
    diagnostics.push({ severity, code: "parse", message: `${name}: ${message}`, span: { file, line: lineNo, column } })

  const blockEnd = isCode ? undefined : ruleBlockEnd(lines)
  if (blockEnd !== undefined) {
    textStart = blockEnd + 1
    for (let k = 0; k < blockEnd; k++) {
      const ln = lines[k]!
      const lineNo = line + 1 + k
      const m = /^@([A-Za-z]+)\s*([\s\S]*)$/.exec(ln)
      const word = m?.[1] ?? ""
      const body = (m?.[2] ?? "").trim()
      try {
        switch (word) {
          case "id":
            if (!body) diag("error", "@id needs a value", lineNo)
            else id = body
            break
          case "when":
            when = andCond(when, parseCond(body))
            break
          case "set":
            onEnter.push(...parseEffects(body))
            break
          case "end":
            isEnding = true
            break
          case "meta":
            meta = { ...meta, ...parseMeta(body) }
            break
          case "shot":
            if (!body || /\s/.test(body)) diag("error", "@shot needs one shot id", lineNo)
            else shot = body
            break
          case "cue":
            cues.push(parseCue(body))
            break
          case "weight":
            if (!DECIMAL.test(body) || !(Number(body) > 0)) diag("error", `@weight needs a positive number (found "${body}")`, lineNo)
            else weight = Number(body)
            break
          case "priority":
            if (!/^[-+]?\d+$/.test(body)) diag("error", `@priority needs a whole number (found "${body}")`, lineNo)
            else priority = Number(body)
            break
          case "cooldown":
            if (!/^\+?\d+$/.test(body)) diag("error", `@cooldown needs a whole number of turns, 0 or more (found "${body}")`, lineNo)
            else cooldown = Number(body)
            break
          case "auto":
            if (body) diag("warn", `@auto takes no value (found "${body}")`, lineNo)
            auto = true
            break
          default:
            diag("warn", `unknown rule "@${word}"`, lineNo)
        }
      } catch (e) {
        diag("error", (e as Error).message, lineNo)
      }
    }
  }

  const textLines = lines.slice(textStart)
  const text = textLines.join("\n")
  const choices: Choice[] = []

  if (!isCode) {
    textLines.forEach((ln, li) => {
      const lineNo = line + 1 + textStart + li
      const links = findLinks(ln)
      links.forEach((l, k) => {
        const segEnd = k + 1 < links.length ? links[k + 1]!.start : ln.length
        const rawSegment = ln.slice(l.end, segEnd)
        const segment = k === links.length - 1 ? stripLineId(rawSegment).text : rawSegment
        const choice: Choice = {
          label: stripLineId(l.label).text,
          target: l.target,
          cost: [],
          set: [],
          span: { file, line: lineNo, column: l.start + 1 },
        }
        if (segment.trim().startsWith("@")) {
          for (const r of splitRules(segment)) {
            try {
              switch (r.word) {
                case "cost": choice.cost.push(...parseCost(r.body)); break
                case "set": choice.set.push(...parseEffects(r.body)); break
                case "when": choice.when = andCond(choice.when, parseCond(r.body)); break
                case "hint": choice.hint = stripLineId(parseHint(r.body)).text; break
                case "once":
                  if (r.body) diag("warn", `@once takes no value (found "${r.body}")`, lineNo, l.end + 1)
                  choice.once = true
                  break
                case "meta": choice.meta = { ...choice.meta, ...parseMeta(r.body) }; break
                case "cue": (choice.cues ??= []).push(parseCue(r.body)); break
                default: diag("warn", `unknown choice rule "@${r.word}"`, lineNo, l.end + 1)
              }
            } catch (e) {
              diag("error", (e as Error).message, lineNo, l.end + 1)
            }
          }
        }
        choices.push(choice)
      })
    })
  }

  const passage: Passage = {
    id: id ?? slugify(name),
    name,
    tags,
    metadata,
    onEnter,
    isEnding,
    text,
    choices,
    rawText,
    span: { file, line, column: 1 },
  }
  if (when) passage.when = when
  if (meta) passage.meta = meta
  if (shot !== undefined) passage.shot = shot
  if (cues.length > 0) passage.cues = cues
  if (weight !== undefined) passage.weight = weight
  if (priority !== undefined) passage.priority = priority
  if (cooldown !== undefined) passage.cooldown = cooldown
  if (auto) passage.auto = true
  return { passage, diagnostics }
}

/** Drop trailing blank lines. */
export function trimTrailingBlankLines(text: string): string {
  const lines = text.split("\n")
  while (lines.length > 0 && lines[lines.length - 1]!.trim() === "") lines.pop()
  return lines.join("\n")
}
