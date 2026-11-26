import { isCueLine } from "./blocks"
import { findLinks, stripLineId } from "./passage"

/**
 * Prose only: drop lines that hold only links (and their @ rules); inline links become their label. A line
 * `@cue name [args]` on its own is dropped too, unless `keepCues` (for `parseProseBlocks`). Trailing `#line:<id>`
 * localization tags are stripped from every line.
 */
export function proseText(text: string, opts?: { keepCues?: boolean }): string {
  const kept: string[] = []
  for (const rawLine of text.split("\n")) {
    const line = stripLineId(rawLine).text
    const links = findLinks(line)
    if (links.length > 0) {
      let rest = ""
      let last = 0
      for (const l of links) { rest += line.slice(last, l.start); last = l.end }
      rest += line.slice(last)
      // A link line starts with a link, and only whitespace and @ rules remain without the links.
      const startsWithLink = line.slice(0, links[0]!.start).trim() === ""
      if (startsWithLink && (rest.trim() === "" || rest.trim().startsWith("@"))) continue
      let out = ""
      last = 0
      for (const l of links) { out += line.slice(last, l.start) + stripLineId(l.label).text; last = l.end }
      kept.push(out + line.slice(last))
    } else if (!opts?.keepCues && isCueLine(line)) {
      continue
    } else {
      kept.push(line)
    }
  }
  return kept.join("\n").replace(/\n{3,}/g, "\n\n").trim()
}
