import { lint } from "../lint/lint"
import { contentPassages, resolveTarget, startPassage } from "../story/model"
import { findLinks } from "../story/passage"
import type { Cond, Effect, StateSchema, Story } from "../story/types"

/** What a game engine loads. Version 1. Engines never parse Twee. */
export interface ExportedStory {
  schema: 1
  id: string
  title: string
  /** Start passage id. */
  start: string
  state: StateSchema
  passages: Record<string, {
    name: string
    tags: string[]
    when?: Cond
    onEnter: Effect[]
    ending: boolean
    /** Prose without rule lines and without link lines. */
    text: string
    choices: { label: string; to: string; cost: Effect[]; set: Effect[]; when?: Cond }[]
  }>
}

/** Prose only: drop lines that hold only links (and their @ rules); inline links become their label. */
export function proseText(text: string): string {
  const kept: string[] = []
  for (const line of text.split("\n")) {
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
      for (const l of links) { out += line.slice(last, l.start) + l.label; last = l.end }
      kept.push(out + line.slice(last))
    } else {
      kept.push(line)
    }
  }
  return kept.join("\n").replace(/\n{3,}/g, "\n\n").trim()
}

/** Throws if lint reports any error. Choice targets become passage ids. */
export function exportStory(story: Story, schema: StateSchema, id: string): ExportedStory {
  const errors = lint(story, schema).filter((d) => d.severity === "error")
  if (errors.length > 0) {
    const lines = errors.map((d) => `  ${d.span ? `${d.span.file}:${d.span.line}: ` : ""}${d.message}`)
    throw new Error(`cannot export ${story.file}: ${errors.length} lint error${errors.length === 1 ? "" : "s"}\n${lines.join("\n")}`)
  }
  const start = startPassage(story)!
  const passages: ExportedStory["passages"] = {}
  for (const p of contentPassages(story)) {
    passages[p.id] = {
      name: p.name,
      tags: [...p.tags],
      ...(p.when ? { when: p.when } : {}),
      onEnter: p.onEnter,
      ending: p.isEnding,
      text: proseText(p.text),
      choices: p.choices.map((c) => ({
        label: c.label,
        to: resolveTarget(story, c.target)!.id,
        cost: c.cost,
        set: c.set,
        ...(c.when ? { when: c.when } : {}),
      })),
    }
  }
  return { schema: 1, id, title: story.title, start: start.id, state: schema, passages }
}
