import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { loadProject } from "../../src/project/project"
import { parseTwee3 } from "../../src/formats/twee3"
import { formatPacingReport, lintNarrative, pacingReport, sampleTranscripts } from "../../src/lint/narrative"
import { satisfiable } from "../../src/lint/sat"
import { initialBoxes, paths, pathsAnalysis, reachableFromInitial } from "../../src/story/paths"
import { parseCond } from "../../src/story/cond"
import type { StateSchema } from "../../src/story/types"
import { loadExample } from "./helpers"

const story = (...lines: string[]) => parseTwee3([":: StoryData", '{ "ifid": "9B1D7C2E-3F4A-4B5C-8D6E-7F8091A2B3C4", "start": "A" }', "", ...lines].join("\n"), "t.twee").story
const show = (rs: { steps: { passageId: string }[]; end: string; satisfiable: boolean }[]) => rs.map((r) => [r.steps.map((s) => s.passageId).join(">"), r.end, r.satisfiable])

const schema: StateSchema = {
  key: { type: "bool", initial: false },
  coins: { type: "int", min: 0, max: 10, initial: 0 },
  timer: { type: "int", min: 0, max: 10, initial: 0, engine: true },
}

describe("paths stop at an already impossible prefix", () => {
  it("emits one never-true route ending where the state became impossible", () => {
    const s = story(":: A", "--", "[[x->B]] @when coins > 5", "", ":: B", "--", "[[y->C]] @set coins = 0", "", ":: C", "--", "[[p->D]] @when coins > 3", "", ":: D", "--", "[[a->E]]", "[[b->F]]", "", ":: E", "@end", "--", "", ":: F", "@end", "--")
    // D is impossible on arrival: one route ends there, instead of one per ending behind it.
    expect(show(paths(s, schema))).toEqual([["a>b>c>d", "dead-end", false]])
  })

  it("keeps A > B > C when the choice into C makes the state impossible", () => {
    const s = story(":: A", "--", "[[x->B]] @when coins > 5", "", ":: B", "--", "[[y->C]] @when coins < 2", "", ":: C", "--", "[[z->D]]", "[[w->D]]", "", ":: D", "@end", "--")
    expect(show(paths(s, schema))).toEqual([["a>b>c", "dead-end", false]])
  })

  it("does not blow up on a long chain of choices behind an impossible prefix", () => {
    const lines = [":: A", "--", "[[in->P0]] @when coins > 20"]
    for (let i = 0; i < 20; i++) lines.push("", `:: P${i}`, "--", `[[l->P${i + 1}]]`, `[[r->P${i + 1}]]`)
    lines.push("", ":: P20", "@end", "--")
    const routes = paths(story(...lines), schema)
    expect(show(routes)).toEqual([["a>p0", "dead-end", false]])
  })
})

describe("initial state reachability", () => {
  it("initialBoxes pins non-engine variables and leaves engine variables free", () => {
    const boxes = initialBoxes(schema)
    expect(boxes).toHaveLength(1)
    const b = boxes[0]!
    expect(b.has("timer")).toBe(false)
    expect(b.get("coins")).toMatchObject({ lo: 0, hi: 0 })
    expect(satisfiable([parseCond("coins == 0 and not key")], schema)).toBe(true)
  })

  it("finds passages only an impossible-from-start condition guards, through loops and interrupts", () => {
    const s = story(
      ":: A", "--",
      "[[Shop->Shop]] @when coins >= 3",
      "[[Work->A]] @set coins += 1",
      "[[Door->Vault]] @when key",
      "[[Wait->Late]] @when timer > 8",
      "", ":: Shop", "@end", "--",
      "", ":: Vault", "@end", "--",
      "", ":: Late", "@end", "--",
    )
    const r = reachableFromInitial(s, schema)
    // Shop needs three loops of Work; Late needs the engine timer; the key is never set.
    expect([...r.passages].sort()).toEqual(["a", "late", "shop"])
    expect(r.choices.has("a#2")).toBe(false)
    expect(r.choices.has("a#0")).toBe(true)

    const withInterrupt = story(
      ":: A", "--", "[[Door->Vault]] @when key", "[[Rest->A]]",
      "", ":: Vault", "@end", "--",
      "", ":: Find [interrupt]", "--", "[[Take->@return]] @set key = true",
    )
    expect(reachableFromInitial(withInterrupt, schema).passages.has("vault")).toBe(true)
  })

  it("pathsAnalysis reports truncation and the reachable set", () => {
    const { story: s, schema: sch } = loadExample()
    const a = pathsAnalysis(s, sch, { maxPaths: 2 })
    expect(a.routes).toHaveLength(2)
    expect(a.truncated).toBe(true)
    expect(pathsAnalysis(s, sch).truncated).toBe(false)
    expect(show(pathsAnalysis(s, sch).routes)).toEqual(show(paths(s, sch)))
    expect(a.reachableFromInitial.has("gate")).toBe(true)
  })
})

describe("lintNarrative", () => {
  it("finds unused state, false choices and duplicate copy", () => {
    const sch: StateSchema = { ...schema, spare: { type: "int", initial: 0 } }
    const s = story(
      ":: A", "--",
      "{when coins > 0: Rich.} [[Go->B]] @set coins += 1",
      '[[Go->B]] @set coins += 1 @hint "Same old"',
      "", ":: B", "--",
      '[[Left->C]] @set key = true @hint "Same old"',
      "[[Right->C]]",
      "", ":: C", "@end", "--",
    )
    const found = lintNarrative(s, sch).map((d) => [d.severity, d.code, d.message])
    expect(found).toEqual([
      ["info", "unused-state-var", "key is changed (first in B) but no condition, cost or template reads it"],
      ["info", "unused-state-var", "spare is declared in the state schema but nothing reads it"],
      ["info", "false-choice", "A: all 2 choices lead to B with the same effects, so the choice does not change anything"],
      ["info", "duplicate-copy", 'A: 2 choices share the label "Go"'],
      ["info", "duplicate-copy", 'the hint "Same old" is used on 2 choices: A [Go], B [Left]'],
    ])
  })

  it("checks copy budgets by tag and wildcard, taking the tighter limit", () => {
    const s = story(
      ":: A A A A [card]", "@id a", "--",
      "{when coins > 0: short | a much longer branch of text}",
      "line two",
      '[[A long label here->B]] @hint "A hint that runs long"',
      "", ":: B", "@end", "--", "ok",
    )
    const found = lintNarrative(s, schema, { copyBudgets: { "*": { bodyChars: 100, titleChars: 20 }, card: { titleChars: 5, bodyChars: 30, bodyLines: 1, choiceLabelChars: 10, hintChars: 10 } } })
    expect(found.filter((d) => d.code === "copy-budget-exceeded").map((d) => [d.severity, d.passageId, d.message])).toEqual([
      ["warn", "a", "A A A A: the title length is 7 (budget 5)"],
      ["warn", "a", "A A A A: the body length (characters, longest variant) is 37 (budget 30)"],
      ["warn", "a", "A A A A: the body line count is 2 (budget 1)"],
      ["warn", "a", 'A A A A: the label "A long label here" length is 17 (budget 10)'],
      ["warn", "a", 'A A A A: the hint on "A long label here" length is 21 (budget 10)'],
    ])
  })

  it("reads copyBudgets from river.json and rejects bad ones", async () => {
    const dir = mkdtempSync(join(tmpdir(), "river-budget-"))
    try {
      const base = { name: "g", engine: "godot", stories: "stories", state: "state.json", export: "out" }
      writeFileSync(join(dir, "river.json"), JSON.stringify({ ...base, copyBudgets: { "*": { bodyChars: 400 }, card: { titleChars: 24, hintChars: 40 } } }))
      expect((await loadProject(dir)).manifest.copyBudgets).toEqual({ "*": { bodyChars: 400 }, card: { titleChars: 24, hintChars: 40 } })
      writeFileSync(join(dir, "river.json"), JSON.stringify(base))
      expect((await loadProject(dir)).manifest.copyBudgets).toBeUndefined()
      writeFileSync(join(dir, "river.json"), JSON.stringify({ ...base, copyBudgets: { card: { bodyChars: -1 } } }))
      await expect(loadProject(dir)).rejects.toThrow(/invalid/)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("does not call two different broken links a false choice", () => {
    const s = story(":: A", "--", "[[x->Nope1]]", "[[y->Nope2]]")
    expect(lintNarrative(s, schema).filter((d) => d.code === "false-choice")).toEqual([])
  })

  it("warns about passages a new game cannot reach and unknown shots", () => {
    const s = story(":: A", "@shot intro", "--", "[[Door->Vault]] @when key", "[[On->B]]", "", ":: Vault", "@shot vault_cam", "@end", "--", "", ":: B", "@end", "--")
    const found = lintNarrative(s, schema, { shotIds: ["intro"] })
    expect(found.filter((d) => d.severity === "warn").map((d) => [d.code, d.passageId])).toEqual([
      ["unreachable-from-initial", "vault"],
      ["unknown-shot", "vault"],
    ])
  })

  it("does not flag engine-driven variables written by @set as unused-state-var", () => {
    const s = story(
      ":: A", "--",
      "[[Go->B]] @set timer += 2, key = true",
      "", ":: B", "@end", "--", "Done.",
    )
    const unused = lintNarrative(s, schema).filter((d) => d.code === "unused-state-var").map((d) => d.message)
    expect(unused.some((m) => m.startsWith("timer "))).toBe(false)
    expect(unused.some((m) => m.startsWith("key "))).toBe(true)
  })

  it("reports nothing worse than info on the example", () => {
    const { story: s, schema: sch } = loadExample()
    expect(lintNarrative(s, sch).filter((d) => d.severity !== "info")).toEqual([])
  })
})

describe("pacingReport", () => {
  it("summarises words, choices, endings and routes", () => {
    const s = story(
      ":: A", "--", "One two three. {when coins > 5: rich words here | poor}", "[[Left->B]]", "[[Right->C]]",
      "", ":: B", "@end", "--", "Four five.",
      "", ":: C", "--", "Six.", "[[On->B]]",
    )
    const r = pacingReport(s, schema)
    expect(r).toMatchObject({ passages: 3, words: 7, endings: 1, choices: 3, choiceDensity: 1.5, wordsByPassage: { a: 4, b: 2, c: 1 } })
    expect(r.routes.map((x) => [x.steps.join(">"), x.words, x.decisions])).toEqual([["a>b", 6, 1], ["a>c>b", 7, 1]])
    expect(r.routeStats).toMatchObject({ count: 2, minWords: 6, maxWords: 7, avgWords: 6.5 })
    const text = formatPacingReport(r)
    expect(text[0]).toBe("3 passages, 7 words (2.3 per passage), 1 ending")
    expect(text[2]).toBe("2 possible routes: 6-7 words (avg 6.5), 1-1 decisions (avg 1)")
  })
})

describe("sampleTranscripts", () => {
  const s = story(
    ":: A", "--", "The gate. {once: It creaks.}", "@cue sfx creak", "[[Pond->B]]", "[[Path->C]]", "[[Rich->D]] @when coins > 5",
    "", ":: B", "--", "Ducks. Coins: {coins}.", "[[Home->E]] @set coins += 1",
    "", ":: C", "--", 'Rex [tired]: "Slow down."', "[[Home->E]]",
    "", ":: D", "@end", "--", "Gold.",
    "", ":: E", "@end", "--", "Home.",
    "", ":: Trip [interrupt]", "--", "Rex trips.", "[[Up->@return]]",
  )

  it("covers every ending reachable from the start state and as many passages as it can", () => {
    const ts = sampleTranscripts(s, schema)
    expect(ts.map((t) => t.route.join(">"))).toEqual(["a>b>e", "a>c>e"])
    expect(ts.every((t) => t.complete)).toBe(true)
    expect(ts[0]!.ending).toBe("E")
    expect(ts[0]!.text).toBe("## A\n\nThe gate. It creaks.\n\n> Pond\n\n## B\n\nDucks. Coins: 0.\n\n> Home\n\n## E\n\nHome.")
    expect(ts[1]!.lines.find((l) => l.kind === "passage" && l.passageId === "c")).toMatchObject({ text: 'Rex [tired]: "Slow down."' })
  })

  it("can limit, read prose only, and add interrupts", () => {
    const ts = sampleTranscripts(s, schema, { maxTranscripts: 1, proseOnly: true, includeInterrupts: true })
    expect(ts.map((t) => [t.route.join(">"), t.end])).toEqual([["a>b>e", "ending"], ["trip", "return"]])
    expect(ts[0]!.text).toBe("The gate. It creaks.\n\nDucks. Coins: 0.\n\nHome.")
    expect(ts[1]!.text).toBe("Rex trips.")
    expect(sampleTranscripts(s, schema, { maxTranscripts: 0 })).toEqual([])
  })

  it("moves engine-driven variables so engine-gated endings play to completion", () => {
    const engineStory = story(
      ":: A", "--", "Walking.", "[[Keep going->Home]]", "[[Exhausted->Carried]]",
      "", ":: Home", "@end", "--", "Made it home.",
      "", ":: Carried", "@when timer >= 8", "@end", "--", "Carried at timer {timer}.",
    )
    const ts = sampleTranscripts(engineStory, schema)
    const carried = ts.find((t) => t.ending === "Carried")
    expect(carried).toBeDefined()
    expect(carried!.complete).toBe(true)
    expect(carried!.note).toBeUndefined()
    expect(carried!.text).toContain("## Carried\n\nCarried at timer 8.")
  })
})
