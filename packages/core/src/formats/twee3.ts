import { randomUUID } from "node:crypto"
import { parsePassage, trimTrailingBlankLines } from "../story/passage"
import type { Diagnostic, Passage, Story } from "../story/types"

interface Header {
  name: string
  tags: string[]
  meta?: string
}

/** Parse the part of a header line after "::". Backslash + any char -> that char. */
function parseHeader(rest: string): Header {
  let i = 0
  let name = ""
  while (i < rest.length) {
    const c = rest[i]!
    if (c === "\\" && i + 1 < rest.length) { name += rest[i + 1]; i += 2; continue }
    if (c === "[" || c === "{") break
    name += c
    i++
  }
  const tags: string[] = []
  if (rest[i] === "[") {
    i++
    let cur = ""
    let closed = false
    while (i < rest.length) {
      const c = rest[i]!
      if (c === "\\" && i + 1 < rest.length) { cur += rest[i + 1]; i += 2; continue }
      if (c === "]") { closed = true; i++; break }
      if (/\s/.test(c)) { if (cur) tags.push(cur); cur = ""; i++; continue }
      cur += c
      i++
    }
    if (cur) tags.push(cur)
    if (!closed) return { name: name.trim(), tags }
  }
  const after = rest.slice(i).trim()
  const header: Header = { name: name.trim(), tags }
  if (after.startsWith("{")) header.meta = after
  return header
}

function escapeHeaderPart(s: string): string {
  return s.replace(/[\\[\]{}]/g, (c) => `\\${c}`)
}

const UUID_V4 = /^[0-9A-F]{8}-[0-9A-F]{4}-4[0-9A-F]{3}-[89AB][0-9A-F]{3}-[0-9A-F]{12}$/

/** Parse a Twee 3 file, including River @ rules. Never throws on bad input; it reports diagnostics. */
export function parseTwee3(text: string, file: string): { story: Story; diagnostics: Diagnostic[] } {
  const diagnostics: Diagnostic[] = []
  const lines = text.replace(/^﻿/, "").replace(/\r\n?/g, "\n").split("\n")

  interface Raw { header: Header; line: number; body: string[] }
  const raws: Raw[] = []
  let cur: Raw | undefined
  lines.forEach((ln, idx) => {
    if (ln.startsWith("::")) {
      cur = { header: parseHeader(ln.slice(2)), line: idx + 1, body: [] }
      raws.push(cur)
    } else if (cur) {
      cur.body.push(ln.startsWith("\\::") ? ln.slice(1) : ln)
    } else if (ln.trim() !== "") {
      diagnostics.push({ severity: "warn", code: "parse", message: "text before the first passage header is ignored", span: { file, line: idx + 1, column: 1 } })
    }
  })

  let title = ""
  let ifid: string | undefined
  let start: string | undefined
  let storyData: Record<string, unknown> = {}
  const passages: Passage[] = []

  for (const r of raws) {
    const rawText = trimTrailingBlankLines(r.body.join("\n"))
    const span = { file, line: r.line, column: 1 }
    if (r.header.name === "StoryTitle") {
      title = rawText.trim()
      continue
    }
    if (r.header.name === "StoryData") {
      try {
        const data: unknown = JSON.parse(rawText)
        if (typeof data !== "object" || data === null || Array.isArray(data)) throw new Error("not an object")
        const { ifid: id, start: st, ...rest } = data as Record<string, unknown>
        if (typeof id === "string") ifid = id
        if (typeof st === "string") start = st
        storyData = rest
      } catch (e) {
        diagnostics.push({ severity: "warn", code: "parse", message: `StoryData is not valid JSON (${(e as Error).message}); ignored`, span })
      }
      continue
    }
    let metadata: Record<string, unknown> = {}
    if (r.header.meta !== undefined) {
      try {
        const m: unknown = JSON.parse(r.header.meta)
        if (typeof m !== "object" || m === null || Array.isArray(m)) throw new Error("not an object")
        metadata = m as Record<string, unknown>
      } catch (e) {
        diagnostics.push({ severity: "warn", code: "parse", message: `${r.header.name}: metadata is not valid JSON (${(e as Error).message}); ignored`, span })
      }
    }
    if (r.header.name === "") {
      diagnostics.push({ severity: "error", code: "parse", message: "passage header has no name", span })
    }
    const res = parsePassage({ name: r.header.name, tags: r.header.tags, metadata, rawText, file, line: r.line })
    passages.push(res.passage)
    diagnostics.push(...res.diagnostics)
  }

  if (ifid === undefined) {
    ifid = randomUUID().toUpperCase()
    diagnostics.push({ severity: "info", code: "parse", message: `StoryData has no ifid; generated ${ifid}`, span: { file, line: 1, column: 1 } })
  } else if (!UUID_V4.test(ifid)) {
    if (UUID_V4.test(ifid.toUpperCase())) ifid = ifid.toUpperCase()
    else diagnostics.push({ severity: "warn", code: "parse", message: `ifid "${ifid}" is not an uppercase v4 UUID`, span: { file, line: 1, column: 1 } })
  }

  if (start === undefined || !passages.some((p) => p.name === start)) {
    if (start !== undefined) {
      diagnostics.push({ severity: "warn", code: "parse", message: `StoryData start "${start}" is not a passage name`, span: { file, line: 1, column: 1 } })
    }
    const content = passages.filter((p) => !p.tags.includes("script") && !p.tags.includes("stylesheet"))
    start = start ?? (content.find((p) => p.name === "Start") ?? content[0])?.name ?? ""
  }

  return { story: { title, ifid, start, storyData, passages, file }, diagnostics }
}

/** Write a story as Twee 3. parseTwee3(writeTwee3(s)) gives the same passages, names, tags, text and storyData. */
export function writeTwee3(story: Story): string {
  const out: string[] = []
  out.push(":: StoryTitle", story.title, "")
  const data = { ifid: story.ifid, ...(story.start ? { start: story.start } : {}), ...story.storyData }
  out.push(":: StoryData", JSON.stringify(data, null, 2), "")
  for (const p of story.passages) {
    let header = `:: ${escapeHeaderPart(p.name)}`
    if (p.tags.length > 0) header += ` [${p.tags.map(escapeHeaderPart).join(" ")}]`
    if (Object.keys(p.metadata).length > 0) header += ` ${JSON.stringify(p.metadata)}`
    out.push(header)
    const body = p.rawText
      .split("\n")
      .map((ln) => (ln.startsWith("::") ? `\\${ln}` : ln))
      .join("\n")
    out.push(body, "")
  }
  return out.join("\n")
}
