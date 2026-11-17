import { randomUUID } from "node:crypto"
import { readFileSync } from "node:fs"
import { parsePassage, trimTrailingBlankLines } from "../story/passage"
import type { Diagnostic, Passage, Story } from "../story/types"

/** Decode HTML entities in one pass (so "&amp;lt;" becomes "&lt;", not "<"). */
function decodeEntities(s: string): string {
  const named: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " }
  return s.replace(/&(#x[0-9a-fA-F]+|#\d+|[A-Za-z]+);/g, (m, body: string) => {
    if (body.startsWith("#x") || body.startsWith("#X")) return String.fromCodePoint(parseInt(body.slice(2), 16))
    if (body.startsWith("#")) return String.fromCodePoint(parseInt(body.slice(1), 10))
    return named[body] ?? m
  })
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!)
}

/** Attributes of one start tag. Valueless attributes (hidden) map to "". */
function parseAttrs(src: string): Record<string, string> {
  const out: Record<string, string> = {}
  const re = /([A-Za-z_:][-A-Za-z0-9_:.]*)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g
  let m: RegExpExecArray | null
  while ((m = re.exec(src))) {
    out[m[1]!.toLowerCase()] = decodeEntities(m[2] ?? m[3] ?? m[4] ?? "")
  }
  return out
}

interface Element { attrs: Record<string, string>; body: string; index: number }

function findElements(html: string, tag: string): Element[] {
  const out: Element[] = []
  const re = new RegExp(`<${tag}\\b([^>]*)>([\\s\\S]*?)</${tag}\\s*>`, "gi")
  let m: RegExpExecArray | null
  while ((m = re.exec(html))) out.push({ attrs: parseAttrs(m[1]!), body: m[2]!, index: m.index })
  return out
}

function lineAt(text: string, index: number): number {
  let n = 1
  for (let i = 0; i < index && i < text.length; i++) if (text.charCodeAt(i) === 10) n++
  return n
}

const UUID_V4 = /^[0-9A-F]{8}-[0-9A-F]{4}-4[0-9A-F]{3}-[89AB][0-9A-F]{3}-[0-9A-F]{12}$/

/** Parse Twine 2 published HTML or a Twine 2 archive (one or more tw-storydata elements). */
export function parseTwineHtml(html: string, file: string): { stories: Story[]; diagnostics: Diagnostic[] } {
  const diagnostics: Diagnostic[] = []
  const stories: Story[] = []
  const text = html.replace(/\r\n?/g, "\n")

  for (const sd of findElements(text, "tw-storydata")) {
    const a = sd.attrs
    const storyLine = lineAt(text, sd.index)
    const span = { file, line: storyLine, column: 1 }
    const passages: Passage[] = []
    const pidToName = new Map<string, string>()

    for (const pd of findElements(sd.body, "tw-passagedata")) {
      const pa = pd.attrs
      const name = pa.name ?? ""
      const line = storyLine + lineAt(sd.body, pd.index) - 1
      const metadata: Record<string, unknown> = {}
      if (pa.position) metadata.position = pa.position
      if (pa.size) metadata.size = pa.size
      const tags = (pa.tags ?? "").split(/\s+/).filter(Boolean)
      if (pa.pid) pidToName.set(pa.pid, name)
      const res = parsePassage({ name, tags, metadata, rawText: trimTrailingBlankLines(decodeEntities(pd.body)), file, line })
      passages.push(res.passage)
      diagnostics.push(...res.diagnostics)
    }

    // Story stylesheet and script become Twee 3 code passages.
    const css = findElements(sd.body, "style").map((e) => decodeEntities(e.body)).join("\n").trim()
    const js = findElements(sd.body, "script").map((e) => decodeEntities(e.body)).join("\n").trim()
    if (css) passages.push(parsePassage({ name: "Story Stylesheet", tags: ["stylesheet"], metadata: {}, rawText: css, file, line: storyLine }).passage)
    if (js) passages.push(parsePassage({ name: "Story JavaScript", tags: ["script"], metadata: {}, rawText: js, file, line: storyLine }).passage)

    const storyData: Record<string, unknown> = {}
    if (a.format) storyData.format = a.format
    if (a["format-version"]) storyData["format-version"] = a["format-version"]
    const tagColors: Record<string, string> = {}
    // tw-tag is an empty element; read the start tag only (closed or not).
    const tagRe = /<tw-tag\b([^>]*)\/?>/gi
    let tm: RegExpExecArray | null
    while ((tm = tagRe.exec(sd.body))) {
      const ta = parseAttrs(tm[1]!.replace(/\/$/, ""))
      if (ta.name && ta.color) tagColors[ta.name] = ta.color
    }
    if (Object.keys(tagColors).length > 0) storyData["tag-colors"] = tagColors
    if (a.zoom !== undefined && a.zoom !== "") {
      const z = Number(a.zoom)
      if (Number.isFinite(z)) storyData.zoom = z
    }

    let ifid = (a.ifid ?? "").toUpperCase()
    if (!ifid) {
      ifid = randomUUID().toUpperCase()
      diagnostics.push({ severity: "info", code: "parse", message: `story "${a.name ?? ""}" has no ifid; generated ${ifid}`, span })
    } else if (!UUID_V4.test(ifid)) {
      diagnostics.push({ severity: "warn", code: "parse", message: `ifid "${ifid}" is not a v4 UUID`, span })
    }

    let start = a.startnode ? pidToName.get(a.startnode) : undefined
    if (start === undefined) {
      if (a.startnode) diagnostics.push({ severity: "warn", code: "parse", message: `startnode ${a.startnode} is not a passage pid`, span })
      const content = passages.filter((p) => !p.tags.includes("script") && !p.tags.includes("stylesheet"))
      start = (content.find((p) => p.name === "Start") ?? content[0])?.name ?? ""
    }

    stories.push({ title: a.name ?? "", ifid, start, storyData, passages, file })
  }

  if (stories.length === 0) {
    diagnostics.push({ severity: "error", code: "parse", message: "no <tw-storydata> element found", span: { file, line: 1, column: 1 } })
  }
  return { stories, diagnostics }
}

function creatorVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(new URL("../../../cli/package.json", import.meta.url), "utf8")) as { version?: unknown }
    return typeof pkg.version === "string" ? pkg.version : "0.1.0"
  } catch {
    return "0.1.0"
  }
}

/** Write one story as a Twine 2 archive fragment (a hidden tw-storydata element) that the Twine library import accepts. */
export function writeTwineArchive(story: Story): string {
  const isCss = (p: Passage) => p.tags.includes("stylesheet")
  const isJs = (p: Passage) => p.tags.includes("script")
  const content = story.passages.filter((p) => !isCss(p) && !isJs(p))
  const css = story.passages.filter(isCss).map((p) => p.rawText).join("\n")
  const js = story.passages.filter(isJs).map((p) => p.rawText).join("\n")
  const startIdx = content.findIndex((p) => p.name === story.start)
  const sd = story.storyData
  const attr = (k: string, v: string) => ` ${k}="${escapeHtml(v)}"`

  let out = "<tw-storydata"
  out += attr("name", story.title)
  out += attr("startnode", startIdx >= 0 ? String(startIdx + 1) : "")
  out += attr("creator", "River")
  out += attr("creator-version", creatorVersion())
  out += attr("ifid", story.ifid)
  out += attr("zoom", typeof sd.zoom === "number" ? String(sd.zoom) : "1")
  out += attr("format", typeof sd.format === "string" ? sd.format : "")
  out += attr("format-version", typeof sd["format-version"] === "string" ? sd["format-version"] : "")
  out += attr("options", "")
  out += attr("tags", "")
  out += " hidden>"
  out += `<style role="stylesheet" id="twine-user-stylesheet" type="text/twine-css">${escapeHtml(css)}</style>`
  out += `<script role="script" id="twine-user-script" type="text/twine-javascript">${escapeHtml(js)}</script>`
  const colors = sd["tag-colors"]
  if (colors && typeof colors === "object") {
    for (const [name, color] of Object.entries(colors as Record<string, unknown>)) {
      if (typeof color === "string") out += `<tw-tag${attr("name", name)}${attr("color", color)}></tw-tag>`
    }
  }
  content.forEach((p, i) => {
    out += "<tw-passagedata"
    out += attr("pid", String(i + 1))
    out += attr("name", p.name)
    out += attr("tags", p.tags.join(" "))
    out += attr("position", typeof p.metadata.position === "string" ? p.metadata.position : `${100 + (i % 10) * 125},${100 + Math.floor(i / 10) * 125}`)
    out += attr("size", typeof p.metadata.size === "string" ? p.metadata.size : "100,100")
    out += `>${escapeHtml(p.rawText)}</tw-passagedata>`
  })
  out += "</tw-storydata>"
  return out
}
