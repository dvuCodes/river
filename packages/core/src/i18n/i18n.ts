/**
 * Localization support: Yarn-Spinner-style `#line:<id>` line IDs, deterministic line tagging,
 * string extraction, and CSV / GNU gettext PO / JSON string-table formatters.
 */
import { createHash } from "node:crypto"
import { isCueLine, parseProseBlocks } from "../story/blocks"
import { contentPassages } from "../story/model"
import { findLinks, LINE_ID_RE, parsePassage, ruleBlockEnd, slugify, stripLineId } from "../story/passage"
import type { Passage, Story } from "../story/types"

export { LINE_ID_RE, stripLineId }

export type StringKind = "title" | "line" | "choice" | "hint"

export interface StringEntry {
  /** Stable key: `#line:<id>` value if present, else `<storyId>:<passageId>:...`. */
  key: string
  /** Source file path. */
  file: string
  /** 1-based line number in the source file. */
  line: number
  /** Passage id. */
  passageId: string
  /** Passage display name. */
  passageName: string
  kind: StringKind
  /** Dialogue speaker when the line is dialogue. */
  speaker?: string
  /** Dialogue mood when the line is dialogue with `[mood]`. */
  mood?: string
  /** Localizable text (with any `#line:<id>` stripped). */
  text: string
}

const BEAT_RE = /^(\.\.\.|…)$/

function isCodePassage(p: Passage): boolean {
  return p.tags.includes("script") || p.tags.includes("stylesheet")
}

/** True when `cleanLine` (with `#line:` already stripped) is a link-only choice line. */
function isLinkOnlyLine(cleanLine: string): boolean {
  const links = findLinks(cleanLine)
  if (links.length === 0) return false
  let rest = ""
  let last = 0
  for (const l of links) {
    rest += cleanLine.slice(last, l.start)
    last = l.end
  }
  rest += cleanLine.slice(last)
  const startsWithLink = cleanLine.slice(0, links[0]!.start).trim() === ""
  return startsWithLink && (rest.trim() === "" || rest.trim().startsWith("@"))
}

/** True when a body line (after the rule block) is a non-blank localizable prose line. */
function isProseLine(rawLine: string): boolean {
  const clean = stripLineId(rawLine).text
  const trimmed = clean.trim()
  if (trimmed === "") return false
  if (isCueLine(clean)) return false
  if (BEAT_RE.test(trimmed)) return false
  if (isLinkOnlyLine(clean)) return false
  return true
}

/** Replace inline `[[label->target]]` links on a prose line with their display labels. */
function flattenInlineLinks(cleanLine: string): string {
  const links = findLinks(cleanLine)
  if (links.length === 0) return cleanLine
  let out = ""
  let last = 0
  for (const l of links) {
    out += cleanLine.slice(last, l.start) + stripLineId(l.label).text
    last = l.end
  }
  return out + cleanLine.slice(last)
}

function defaultStoryId(story: Story): string {
  if (story.file) {
    const base = story.file.replace(/\\/g, "/").split("/").pop() ?? ""
    const stem = base.replace(/\.twee$/i, "")
    if (stem) return stem
  }
  return slugify(story.title || "story")
}

function makeLineId(seed: string, used: Set<string>): string {
  for (let salt = 0; ; salt++) {
    const input = salt === 0 ? seed : `${seed}#${salt}`
    const id = createHash("sha256").update(input).digest("hex").slice(0, 8)
    if (!used.has(id)) {
      used.add(id)
      return id
    }
  }
}

/**
 * Deterministically assign stable `#line:<8-char-sha256-hex>` IDs to every untagged non-blank prose line
 * in content passages. Existing `#line:<id>` tags and untouched passages are preserved as-is.
 */
export function tagStoryLines(story: Story): { story: Story; added: number } {
  // Collect all existing line IDs first so new IDs never collide with them.
  const used = new Set<string>()
  for (const p of contentPassages(story)) {
    const lines = p.rawText.replace(/\r\n/g, "\n").split("\n")
    const blockEnd = ruleBlockEnd(lines)
    const start = blockEnd === undefined ? 0 : blockEnd + 1
    for (let i = start; i < lines.length; i++) {
      const id = stripLineId(lines[i]!).lineId
      if (id) used.add(id.toLowerCase())
    }
  }

  let added = 0
  const passages = story.passages.map((p) => {
    if (isCodePassage(p)) return p
    const lines = p.rawText.replace(/\r\n/g, "\n").split("\n")
    const blockEnd = ruleBlockEnd(lines)
    const start = blockEnd === undefined ? 0 : blockEnd + 1
    const occ = new Map<string, number>()
    let passageAdded = 0
    const nextLines = lines.slice()

    for (let i = start; i < lines.length; i++) {
      const ln = lines[i]!
      if (!isProseLine(ln)) continue
      const stripped = stripLineId(ln)
      const normalized = stripped.text.trim()
      const count = occ.get(normalized) ?? 0
      occ.set(normalized, count + 1)
      if (stripped.lineId !== undefined) continue

      const id = makeLineId(`${p.id}\0${count}\0${normalized}`, used)
      nextLines[i] = `${ln.trimEnd()} #line:${id}`
      passageAdded++
    }

    if (passageAdded === 0) return p
    added += passageAdded
    const rawText = nextLines.join("\n")
    const reparsed = parsePassage({
      name: p.name,
      tags: p.tags,
      metadata: p.metadata,
      rawText,
      file: p.span.file,
      line: p.span.line,
    }).passage
    return p.source ? { ...reparsed, source: p.source } : reparsed
  })

  return added === 0 ? { story, added: 0 } : { story: { ...story, passages }, added }
}

/** Extract all localizable strings (titles, prose lines, choice labels, choice hints) from a story. */
export function extractStrings(story: Story, opts?: { storyId?: string }): StringEntry[] {
  const storyId = opts?.storyId ?? defaultStoryId(story)
  const out: StringEntry[] = []

  for (const p of contentPassages(story)) {
    out.push({
      key: `${storyId}:${p.id}:title`,
      file: p.span.file,
      line: p.span.line,
      passageId: p.id,
      passageName: p.name,
      kind: "title",
      text: p.name,
    })

    const rawLines = p.rawText.replace(/\r\n/g, "\n").split("\n")
    const blockEnd = ruleBlockEnd(rawLines)
    const textStart = blockEnd === undefined ? 0 : blockEnd + 1
    let proseIdx = 0

    for (let i = textStart; i < rawLines.length; i++) {
      const rawLine = rawLines[i]!
      if (!isProseLine(rawLine)) continue
      proseIdx++
      const { text: stripped, lineId } = stripLineId(rawLine)
      const flattened = flattenInlineLinks(stripped).trim()
      const fileLine = p.span.line + 1 + i
      const blocks = parseProseBlocks(flattened)
      const first = blocks.length === 1 ? blocks[0] : undefined
      if (first && first.kind === "dialogue") {
        const entry: StringEntry = {
          key: lineId ?? `${storyId}:${p.id}:line:${proseIdx}`,
          file: p.span.file,
          line: fileLine,
          passageId: p.id,
          passageName: p.name,
          kind: "line",
          speaker: first.speaker,
          text: first.text,
        }
        if (first.mood !== undefined) entry.mood = first.mood
        out.push(entry)
      } else {
        out.push({
          key: lineId ?? `${storyId}:${p.id}:line:${proseIdx}`,
          file: p.span.file,
          line: fileLine,
          passageId: p.id,
          passageName: p.name,
          kind: "line",
          text: flattened,
        })
      }
    }

    p.choices.forEach((c, idx) => {
      out.push({
        key: `${storyId}:${p.id}:choice:${idx}:label`,
        file: c.span.file,
        line: c.span.line,
        passageId: p.id,
        passageName: p.name,
        kind: "choice",
        text: stripLineId(c.label).text,
      })
      if (c.hint !== undefined && c.hint !== "") {
        out.push({
          key: `${storyId}:${p.id}:choice:${idx}:hint`,
          file: c.span.file,
          line: c.span.line,
          passageId: p.id,
          passageName: p.name,
          kind: "hint",
          text: stripLineId(c.hint).text,
        })
      }
    })
  }

  return out
}

function csvCell(value: string): string {
  if (/[",\r\n]/.test(value)) return `"${value.replace(/"/g, '""')}"`
  return value
}

/** Format extracted strings as RFC-4180 CSV (`id,file,passage,kind,speaker,text`). */
export function formatStringsCsv(entries: readonly StringEntry[]): string {
  const rows = ["id,file,passage,kind,speaker,text"]
  for (const e of entries) {
    rows.push(
      [e.key, e.file, e.passageId, e.kind, e.speaker ?? "", e.text].map(csvCell).join(","),
    )
  }
  return rows.join("\n") + "\n"
}

function poEscape(value: string): string {
  return value
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\t/g, "\\t")
    .replace(/\r/g, "\\r")
    .replace(/\n/g, "\\n")
}

function poField(keyword: string, value: string): string {
  if (!value.includes("\n")) return `${keyword} "${poEscape(value)}"`
  const parts = value.split("\n")
  const lines = [`${keyword} ""`]
  parts.forEach((part, idx) => {
    const suffix = idx < parts.length - 1 ? "\\n" : ""
    lines.push(`"${poEscape(part)}${suffix}"`)
  })
  return lines.join("\n")
}

/** Format extracted strings as a valid GNU gettext `.po` catalog. */
export function formatStringsPo(
  entries: readonly StringEntry[],
  meta?: { title?: string; language?: string },
): string {
  const headerLines = [
    'msgid ""',
    'msgstr ""',
    `"Project-Id-Version: ${poEscape(meta?.title ?? "River Story")}\\n"`,
    ...(meta?.language ? [`"Language: ${poEscape(meta.language)}\\n"`] : []),
    '"MIME-Version: 1.0\\n"',
    '"Content-Type: text/plain; charset=UTF-8\\n"',
    '"Content-Transfer-Encoding: 8bit\\n"',
  ]
  const blocks: string[] = [headerLines.join("\n")]

  for (const e of entries) {
    const lines: string[] = []
    if (e.speaker) {
      lines.push(`#. speaker: ${e.speaker}${e.mood ? ` [${e.mood}]` : ""}`)
    }
    lines.push(`#: ${e.file}:${e.line}`)
    lines.push(poField("msgctxt", e.key))
    lines.push(poField("msgid", e.text))
    lines.push('msgstr ""')
    blocks.push(lines.join("\n"))
  }

  return blocks.join("\n\n") + "\n"
}

/** Format extracted strings as pretty-printed JSON. */
export function formatStringsJson(entries: readonly StringEntry[]): string {
  return JSON.stringify(entries, null, 2) + "\n"
}
