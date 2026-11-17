/**
 * Shared passage-body parsing: links, River `@` rules, choices. Used by the Twee 3 and
 * Twine HTML readers and by model edits (updatePassageText, renamePassage).
 */
import { parseCond, parseEffects } from "./cond"
import type { Choice, Cond, Diagnostic, Effect, Passage } from "./types"

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

function andCond(a: Cond | undefined, b: Cond): Cond {
  if (!a) return b
  if (a.kind === "and") return { kind: "and", terms: [...a.terms, b] }
  return { kind: "and", terms: [a, b] }
}

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
  let textStart = 0

  const diag = (severity: Diagnostic["severity"], message: string, lineNo: number, column = 1) =>
    diagnostics.push({ severity, code: "parse", message: `${name}: ${message}`, span: { file, line: lineNo, column } })

  if (!isCode) {
    let i = 0
    while (i < lines.length && lines[i]!.startsWith("@")) i++
    if (i < lines.length && lines[i] === "--") {
      textStart = i + 1
      for (let k = 0; k < i; k++) {
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
            default:
              diag("warn", `unknown rule "@${word}"`, lineNo)
          }
        } catch (e) {
          diag("error", (e as Error).message, lineNo)
        }
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
        const segment = ln.slice(l.end, segEnd)
        const choice: Choice = {
          label: l.label,
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
  return { passage, diagnostics }
}

/** Drop trailing blank lines. */
export function trimTrailingBlankLines(text: string): string {
  const lines = text.split("\n")
  while (lines.length > 0 && lines[lines.length - 1]!.trim() === "") lines.pop()
  return lines.join("\n")
}
