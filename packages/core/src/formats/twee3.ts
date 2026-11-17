import { randomUUID } from "node:crypto"
import { parsePassage, trimTrailingBlankLines } from "../story/passage"
import type { Diagnostic, Passage, PassageSource, Story, StoryBlockSource, StorySource } from "../story/types"

interface Header {
  name: string
  tags: string[]
  meta?: string
  /** Index in the text after "::" where `meta` starts, or -1. */
  metaAt: number
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
    if (!closed) return { name: name.trim(), tags, metaAt: -1 }
  }
  const tail = rest.slice(i)
  const after = tail.trim()
  const header: Header = { name: name.trim(), tags, metaAt: -1 }
  if (after.startsWith("{")) {
    header.meta = after
    header.metaAt = i + (tail.length - tail.trimStart().length)
  }
  return header
}

function escapeHeaderPart(s: string): string {
  return s.replace(/[\\[\]{}]/g, (c) => `\\${c}`)
}

const UUID_V4 = /^[0-9A-F]{8}-[0-9A-F]{4}-4[0-9A-F]{3}-[89AB][0-9A-F]{3}-[0-9A-F]{12}$/

/** Parse a Twee 3 file, including River @ rules. Never throws on bad input; it reports diagnostics. */
export function parseTwee3(text: string, file: string): { story: Story; diagnostics: Diagnostic[] } {
  const diagnostics: Diagnostic[] = []
  const bom = text.startsWith("\uFEFF")
  const eol = text.includes("\r\n") ? "\r\n" : "\n"
  const lines = text.replace(/^﻿/, "").replace(/\r\n?/g, "\n").split("\n")

  interface Raw { header: Header; headerLine: string; line: number; body: string[]; rawBody: string[] }
  const raws: Raw[] = []
  const preamble: string[] = []
  let cur: Raw | undefined
  lines.forEach((ln, idx) => {
    if (ln.startsWith("::")) {
      cur = { header: parseHeader(ln.slice(2)), headerLine: ln, line: idx + 1, body: [], rawBody: [] }
      raws.push(cur)
    } else if (cur) {
      cur.rawBody.push(ln)
      cur.body.push(ln.startsWith("\\::") ? ln.slice(1) : ln)
    } else {
      preamble.push(ln)
      if (ln.trim() !== "") {
        diagnostics.push({ severity: "warn", code: "parse", message: "text before the first passage header is ignored", span: { file, line: idx + 1, column: 1 } })
      }
    }
  })

  let title = ""
  let ifid: string | undefined
  let start: string | undefined
  let storyData: Record<string, unknown> = {}
  const passages: Passage[] = []
  const blocks: StoryBlockSource[] = []

  for (const r of raws) {
    const rawText = trimTrailingBlankLines(r.body.join("\n"))
    const span = { file, line: r.line, column: 1 }
    if (r.header.name === "StoryTitle") {
      title = rawText.trim()
      blocks.push({ kind: "title", lines: [r.headerLine, ...r.rawBody], index: passages.length })
      continue
    }
    if (r.header.name === "StoryData") {
      blocks.push({ kind: "data", lines: [r.headerLine, ...r.rawBody], index: passages.length })
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
    const source: PassageSource = {
      header: r.headerLine,
      metaStart: r.header.metaAt < 0 ? -1 : r.header.metaAt + 2,
      body: r.rawBody,
      name: res.passage.name,
      tags: [...res.passage.tags],
      metadataJson: JSON.stringify(metadata),
      rawText,
    }
    passages.push({ ...res.passage, source })
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

  const source: StorySource = { eol, bom, preamble, blocks, title, storyDataJson: storyDataJson(ifid, start, storyData) }
  return { story: { title, ifid, start, storyData, passages, file, source }, diagnostics }
}

function storyDataJson(ifid: string, start: string, storyData: Record<string, unknown>): string {
  return JSON.stringify({ ifid, ...(start ? { start } : {}), ...storyData })
}

function escapeBody(rawText: string): string[] {
  return rawText.split("\n").map((ln) => (ln.startsWith("::") ? `\\${ln}` : ln))
}

function newHeader(p: Passage): string {
  let header = `:: ${escapeHeaderPart(p.name)}`
  if (p.tags.length > 0) header += ` [${p.tags.map(escapeHeaderPart).join(" ")}]`
  if (Object.keys(p.metadata).length > 0) header += ` ${JSON.stringify(p.metadata)}`
  return header
}

const sameList = (a: string[], b: string[]) => a.length === b.length && a.every((x, i) => x === b[i])

/** Lines for one passage: verbatim where the passage still matches its source, rebuilt where it changed. */
function passageLines(p: Passage): string[] {
  const s = p.source
  if (!s) return [newHeader(p), ...escapeBody(p.rawText), ""]
  let header: string
  const meta = JSON.stringify(p.metadata)
  if (p.name !== s.name || !sameList(p.tags, s.tags)) header = newHeader(p)
  else if (meta === s.metadataJson) header = s.header
  else {
    // Only the metadata changed: keep ":: Name [tags]" as written and replace the JSON tail.
    const prefix = s.metaStart >= 0 ? s.header.slice(0, s.metaStart) : `${s.header.trimEnd()} `
    header = Object.keys(p.metadata).length > 0 ? prefix + meta : prefix.trimEnd()
  }
  if (p.rawText === s.rawText) return [header, ...s.body]
  // New text, but keep the blank lines that followed the passage.
  let k = s.body.length
  while (k > 0 && s.body[k - 1]!.trim() === "") k--
  const trailing = s.body.slice(k)
  return [header, ...escapeBody(p.rawText), ...(trailing.length > 0 ? trailing : [""])]
}

function titleLines(story: Story): string[] {
  return [":: StoryTitle", story.title, ""]
}

function dataLines(story: Story): string[] {
  const data = { ifid: story.ifid, ...(story.start ? { start: story.start } : {}), ...story.storyData }
  return [":: StoryData", ...JSON.stringify(data, null, 2).split("\n"), ""]
}

/**
 * Write a story as Twee 3. parseTwee3(writeTwee3(s)) gives the same passages, names, tags, text and storyData.
 * A story from parseTwee3 keeps its source: whatever did not change (StoryData text, headers, spacing,
 * line endings) is written back byte for byte, so a diff shows only what changed.
 */
export function writeTwee3(story: Story): string {
  const src = story.source
  if (!src) return writeFresh(story)
  const titleChanged = story.title !== src.title
  const dataChanged = storyDataJson(story.ifid, story.start, story.storyData) !== src.storyDataJson
  const lastOf = (kind: "title" | "data") => src.blocks.filter((b) => b.kind === kind).at(-1)
  const lastTitle = lastOf("title")
  const lastData = lastOf("data")
  const out: string[] = [...src.preamble]
  // A block missing from the file is added at the top only when its value changed.
  if (!lastTitle && titleChanged && story.title) out.push(...titleLines(story))
  if (!lastData && dataChanged) out.push(...dataLines(story))
  const blockLines = (b: StoryBlockSource) => {
    if (b === lastTitle && titleChanged) return titleLines(story)
    if (b === lastData && dataChanged) return dataLines(story)
    return b.lines
  }
  story.passages.forEach((p, i) => {
    for (const b of src.blocks) if (b.index === i) out.push(...blockLines(b))
    out.push(...passageLines(p))
  })
  for (const b of src.blocks) if (b.index >= story.passages.length) out.push(...blockLines(b))
  return (src.bom ? "\uFEFF" : "") + out.join(src.eol)
}

/** Write a story that has no source (built in code or imported from Twine HTML). */
function writeFresh(story: Story): string {
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
