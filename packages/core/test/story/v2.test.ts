import { describe, expect, it } from "vitest"
import { exportStory, proseText } from "../../src/export/export"
import { parseTwee3, writeTwee3 } from "../../src/formats/twee3"
import { lint } from "../../src/lint/lint"
import { satisfiable } from "../../src/lint/sat"
import { createPlaytest } from "../../src/play/playtest"
import { parseProseBlocks } from "../../src/story/blocks"
import { formatClosed } from "../../src/story/choice"
import { evalCond, formatCond, parseCond } from "../../src/story/cond"
import { addPassage, createStoryIndex, deletePassage, passageById, resolveTarget, updatePassageTags } from "../../src/story/model"
import { parseTemplate, renderProse, templateRefs } from "../../src/story/template"
import type { StateSchema } from "../../src/story/types"
import { loadExample } from "./helpers"

const story = (...lines: string[]) => parseTwee3([":: StoryData", '{ "ifid": "9B1D7C2E-3F4A-4B5C-8D6E-7F8091A2B3C4", "start": "A" }', "", ...lines].join("\n"), "t.twee")

const schema: StateSchema = {
  bond: { type: "int", min: 0, max: 100, initial: 40 },
  treats: { type: "int", min: 0, max: 5, initial: 2 },
  mood: { type: "enum", values: ["CALM", "EXCITED"] },
  name: { type: "enum", values: ["Rex", "Bo"] },
}

describe("visit conditions", () => {
  it("parses visited(id) and visits(id) <op> n, and formats them back", () => {
    expect(parseCond("visited(pond)")).toEqual({ kind: "visit", passageId: "pond", op: ">=", value: 1 })
    expect(parseCond("visits(pond) > 2")).toEqual({ kind: "visit", passageId: "pond", op: ">", value: 2 })
    expect(parseCond('not visited("3 doors") and bond > 1')).toEqual({
      kind: "and",
      terms: [{ kind: "not", term: { kind: "visit", passageId: "3 doors", op: ">=", value: 1 } }, { kind: "cmp", variable: "bond", op: ">", value: 1 }],
    })
    for (const src of ["visited(pond)", "visits(pond) == 0", 'visited("3 doors")', "visited(3_doors) or visits(gate) >= 2"]) {
      const c = parseCond(src)
      expect(parseCond(formatCond(c))).toEqual(c)
    }
    expect(formatCond(parseCond("visits(pond) >= 1"))).toBe("visited(pond)")
    expect(formatCond(parseCond("visits(pond) < 3"))).toBe("visits(pond) < 3")
  })

  it("keeps visited and visits usable as plain variable names", () => {
    expect(parseCond("visits >= 3")).toEqual({ kind: "cmp", variable: "visits", op: ">=", value: 3 })
    expect(parseCond("visited")).toEqual({ kind: "cmp", variable: "visited", op: "==", value: true })
  })

  it("rejects a visits() without a comparison or with a non-number", () => {
    expect(() => parseCond("visits(pond)")).toThrow(/needs a comparison/)
    expect(() => parseCond("visits(pond) > many")).toThrow(/number/)
  })

  it("evaluates against a visit map, defaulting to none", () => {
    const c = parseCond("visited(pond) and visits(gate) < 2")
    expect(evalCond(c, {})).toBe(false)
    expect(evalCond(c, {}, { pond: 1, gate: 1 })).toBe(true)
    expect(evalCond(c, {}, { pond: 1, gate: 2 })).toBe(false)
  })

  it("is free for the solver, never falsely impossible", () => {
    expect(satisfiable([parseCond("visited(pond)")], schema)).toBe(true)
    expect(satisfiable([parseCond("not visited(pond)")], schema)).toBe(true)
    expect(satisfiable([parseCond("visited(pond) and bond > 200")], schema)).toBe(false)
  })

  it("lint reports a visit to a passage id that does not exist, naming the passage when a name was used", () => {
    const s = story(":: A", "@when visited(b)", "--", "[[Go->Pond]] @when visited(Pond)", "", ":: Pond", "@end", "--", "{when visited(nowhere): Again.}")
    const found = lint(s.story, schema).filter((d) => d.code === "unknown-passage")
    expect(found.map((d) => [d.severity, d.message])).toEqual([
      ["error", 'A: no passage has id "b"'],
      ["error", 'A → Pond: no passage has id "Pond" (passage Pond has id "pond")'],
      ["error", 'Pond {when visited(nowhere)}: no passage has id "nowhere"'],
    ])
  })
})

describe("inline templates", () => {
  const state = { bond: 60, treats: 2, mood: "CALM" }

  it("renders when/else, variables, once, cycle and shuffle", () => {
    const text = "{when bond > 50: Rex leans on you. | Rex keeps away.} You have {treats} treats.{once: First time here.} {cycle: One. | Two. | Three.} {shuffle: Quack | Honk}"
    expect(renderProse(text, { state, visitCount: 1 })).toBe("Rex leans on you. You have 2 treats.First time here. One. Honk")
    expect(renderProse(text, { state: { ...state, bond: 10 }, visitCount: 2 })).toBe("Rex keeps away. You have 2 treats. Two. Quack")
    expect(renderProse(text, { state, visitCount: 4 })).toBe("Rex leans on you. You have 2 treats. One. Quack")
    expect(renderProse("{shuffle: a | b | c}", { state, rng: () => 0.99 })).toBe("c")
  })

  it("renders nothing for a false when without else, and checks visits", () => {
    expect(renderProse("A{when bond > 90: B}C", { state })).toBe("AC")
    expect(renderProse("{when visited(pond): Back again.}", { state, visits: { pond: 1 } })).toBe("Back again.")
  })

  it("handles nested templates, escapes and links inside branches", () => {
    expect(renderProse("{when bond > 50: {when treats > 1: both | bond only} | neither}", { state })).toBe("both")
    expect(renderProse("{when bond > 50: a \\| b \\} c}", { state })).toBe("a | b } c")
    expect(renderProse("\\{treats\\}", { state })).toBe("{treats}")
    expect(renderProse("{when bond > 50: [[Pet|Pet him]] | no}", { state })).toBe("[[Pet|Pet him]]")
  })

  it("leaves anything that is not a template as written", () => {
    const plain = ['{"position": "1,2"}', "{ spaced }", "{2 + 2}", "a { b", "a } b", "{unknownvar}", "{when}", "[[Go|{x}]]"]
    for (const t of plain) expect(renderProse(t, { state })).toBe(t)
  })

  it("keeps a broken template literal and reports why", () => {
    expect(renderProse("{when bond >: x}", { state })).toBe("{when bond >: x}")
    expect(parseTemplate("{when bond > 1 no colon}")[0]).toMatchObject({ kind: "invalid" })
    const refs = templateRefs("{when bond > 1: {name} | {when mood == CALM: ok}} {treats} {name} {when x >: y}")
    expect(refs.conds.map(formatCond)).toEqual(["bond > 1", "mood == CALM"])
    expect(refs.variables).toEqual(["name", "treats"])
    expect(refs.errors).toHaveLength(1)
  })

  it("is the identity on every passage of the example", () => {
    const { story: s, schema: sch } = loadExample()
    for (const p of s.passages) expect(renderProse(p.text, { state: {} })).toBe(p.text)
    expect(lint(s, sch).filter((d) => d.code.startsWith("template"))).toEqual([])
  })

  it("lint checks template conditions and variable names", () => {
    const s = story(":: A", "@end", "--", "{when bond > 500: never} {when nope == 1: x} {treats} {ghost} {when bond >: y}")
    const found = lint(s.story, schema).map((d) => [d.severity, d.code])
    expect(found).toEqual([
      ["warn", "template"],
      ["warn", "never-true"],
      ["error", "unknown-var"],
      ["warn", "template-var"],
    ])
  })
})

describe("passage and choice rules", () => {
  const src = story(
    ":: A",
    '@meta mood=tense, music="night walk", loud=true, volume=0.8',
    "@shot gate_wide",
    "@cue music night_walk fade=2",
    "@cue camera",
    "--",
    "Rex [excited]: Ducks!",
    '[[Throw->B]] @once @cost treats 1 @meta weight=2, tag="fun" @cue sfx toss',
    "[[Wait->B]]",
    "",
    ":: B",
    "@end",
    "--",
  )

  it("reads @meta, @shot and @cue above the --", () => {
    const a = passageById(src.story, "a")!
    expect(src.diagnostics).toEqual([])
    expect(a.meta).toEqual({ mood: "tense", music: "night walk", loud: true, volume: 0.8 })
    expect(a.shot).toBe("gate_wide")
    expect(a.cues).toEqual([{ name: "music", args: "night_walk fade=2" }, { name: "camera" }])
  })

  it("reads @once, @meta and @cue after a link", () => {
    const c = passageById(src.story, "a")!.choices[0]!
    expect(c).toMatchObject({ once: true, meta: { weight: 2, tag: "fun" }, cues: [{ name: "sfx", args: "toss" }] })
    expect(c.cost).toEqual([{ variable: "treats", op: "add", amount: -1 }])
    expect(passageById(src.story, "a")!.choices[1]).not.toHaveProperty("once")
  })

  it("v1 passages get none of the new fields", () => {
    const { story: s } = loadExample()
    for (const p of s.passages) {
      expect(p).not.toHaveProperty("meta")
      expect(p).not.toHaveProperty("shot")
      expect(p).not.toHaveProperty("cues")
      for (const c of p.choices) for (const k of ["once", "meta", "cues"]) expect(c).not.toHaveProperty(k)
    }
  })

  it("reports bad rules", () => {
    const bad = story(":: A", "@meta nope", "@shot two words", "--", "[[Go->A]] @meta =1")
    expect(bad.diagnostics.map((d) => d.severity)).toEqual(["error", "error", "error"])
  })

  it("survives a write and read byte for byte", () => {
    const text = writeTwee3(src.story)
    expect(parseTwee3(text, "t.twee").story.passages.map((p) => p.rawText)).toEqual(src.story.passages.map((p) => p.rawText))
  })
})

describe("prose blocks", () => {
  it("reads dialogue, cues, beats and narration", () => {
    const prose = [
      "The park is quiet.",
      "Too quiet.",
      "",
      "Rex [excited]: Ducks! So many ducks!",
      'Mara: "Easy, boy."',
      "Note: the gate is shut.",
      "@cue sfx quack loud",
      "...",
      "Rex: whimpers softly",
    ].join("\n")
    expect(parseProseBlocks(prose)).toEqual([
      { kind: "narration", text: "The park is quiet.\nToo quiet." },
      { kind: "dialogue", speaker: "Rex", mood: "excited", text: "Ducks! So many ducks!" },
      { kind: "dialogue", speaker: "Mara", text: "Easy, boy." },
      { kind: "narration", text: "Note: the gate is shut." },
      { kind: "cue", name: "sfx", args: "quack loud" },
      { kind: "beat" },
      { kind: "narration", text: "Rex: whimpers softly" },
    ])
  })

  it("proseText drops cue lines unless asked to keep them, and lint does not call them stray rules", () => {
    const s = story(":: A", "@end", "--", "Hello.", "@cue sfx bell", "@shot nope")
    const p = s.story.passages[0]!
    expect(proseText(p.text)).toBe("Hello.\n@shot nope")
    expect(proseText(p.text, { keepCues: true })).toBe("Hello.\n@cue sfx bell\n@shot nope")
    expect(lint(s.story, schema).map((d) => d.code)).toEqual(["rule-in-prose"])
  })
})

describe("playtest with visits, @once and rendering", () => {
  const src = story(
    ":: A",
    "--",
    "{once: First light.}{when visited(b): You came back.} Visit {cycle: one | two | three}.",
    "[[Pet->B]] @once @set bond += 5",
    "[[Walk->B]]",
    "[[Leave->C]] @when visits(b) >= 2",
    "",
    ":: B",
    "--",
    "Rex wags. Bond {bond}.",
    "[[Back->A]]",
    "",
    ":: C",
    "@end",
    "--",
    "Bye.",
  )

  it("counts visits, closes a @once choice after it is taken, and undo restores both", () => {
    const play = createPlaytest(src.story, schema)
    expect(play.visits()).toEqual({ a: 1 })
    expect(play.renderedText()).toBe("First light. Visit one.")
    expect(play.choices().map((c) => c.open)).toEqual([true, true, false])
    play.choose(0)
    expect(play.renderedText()).toBe("Rex wags. Bond 45.")
    play.choose(0)
    expect(play.visits()).toEqual({ a: 2, b: 1 })
    expect(play.renderedText()).toBe("You came back. Visit two.")
    const pet = play.choices()[0]!
    expect(pet).toMatchObject({ open: false, closed: { by: "once" } })
    expect(formatClosed(pet.closed!)).toBe("already chosen")
    expect(() => play.choose(0)).toThrow('choice "Pet" is closed: already chosen')
    expect(play.history().at(-1)).toMatchObject({ visits: { a: 2, b: 1 }, usedOnce: ["a#0"] })

    play.undo()
    play.undo()
    expect(play.current().id).toBe("a")
    expect(play.visits()).toEqual({ a: 1 })
    expect(play.choices()[0]!.open).toBe(true)

    play.choose(1)
    play.choose(0)
    play.choose(1)
    play.choose(0)
    expect(play.choices()[2]!.open).toBe(true)
    play.choose(2)
    expect(play.isOver()).toBe(true)
  })

  it("a passage's own @when sees the visits before this entry, so `not visited(self)` admits it once", () => {
    const s = story(":: A", "--", "[[In->B]]", "[[Loop->A]]", "", ":: B", "@when not visited(b)", "--", "[[Out->A]]", "", ":: Once [interrupt]", "@id once", "@when not visited(once)", "--", "[[Back->@return]]")
    const play = createPlaytest(s.story, schema)
    expect(play.choices()[0]!.open).toBe(true)
    expect(play.interrupts().map((i) => i.open)).toEqual([true])
    play.interrupt("Once")
    play.choose(0)
    expect(play.interrupts().map((i) => i.open)).toEqual([false])
    play.choose(0)
    play.choose(0)
    expect(play.current().id).toBe("a")
    expect(play.choices()[0]).toMatchObject({ open: false, closed: { by: "target" } })
    // Lint's advice for the choice into B is right because counts exclude the entry being checked.
    expect(lint(s.story, schema).map((d) => d.message)).toEqual([
      "A → B: the choice can show while B's @when not visited(b) is false. Give the choice @when not visited(b), or loosen B's @when.",
    ])
  })

  it("history copies cannot change the playtest", () => {
    const play = createPlaytest(src.story, schema)
    const h = play.history()
    h[0]!.visits.a = 99
    h[0]!.usedOnce.push("x")
    expect(play.visits()).toEqual({ a: 1 })
  })
})

describe("export", () => {
  it("adds the v2 fields only where the story uses them, after the v1 keys", () => {
    const s = story(
      ":: A",
      "@meta mood=tense",
      "@shot gate",
      "@cue music night",
      "--",
      "Rex [happy]: Hi!",
      "@cue sfx bark",
      "{when visited(b): Again.}",
      "[[Go->B]] @once @meta w=1 @cue sfx step",
      "[[Stay->B]]",
      "",
      ":: B",
      "@end",
      "--",
      "Plain prose.",
    )
    const out = exportStory(s.story, schema, "t")
    expect(out.schema).toBe(1)
    const a = out.passages["a"]!
    expect(Object.keys(a)).toEqual(["name", "tags", "onEnter", "ending", "text", "choices", "meta", "shot", "cues", "blocks"])
    expect(a.text).toBe("Rex [happy]: Hi!\n{when visited(b): Again.}")
    expect(a.blocks).toEqual([
      { kind: "dialogue", speaker: "Rex", mood: "happy", text: "Hi!" },
      { kind: "cue", name: "sfx", args: "bark" },
      { kind: "narration", text: "{when visited(b): Again.}" },
    ])
    expect(a.choices[0]).toEqual({ label: "Go", to: "b", cost: [], set: [], once: true, meta: { w: 1 }, cues: [{ name: "sfx", args: "step" }] })
    expect(Object.keys(a.choices[1]!)).toEqual(["label", "to", "cost", "set"])
    expect(Object.keys(out.passages["b"]!)).toEqual(["name", "tags", "onEnter", "ending", "text", "choices"])
  })

  it("exports a v1 story exactly as before", () => {
    const { story: s, schema: sch } = loadExample()
    // The example has a planted broken link; drop it to export.
    const fixed = parseTwee3(writeTwee3(s).replace("[[Let go->Splash]]", "[[Let go->Treat]]"), s.file).story
    const out = exportStory(fixed, sch, "park_walk")
    expect(JSON.stringify(out)).not.toMatch(/"(meta|shot|cues|blocks|once)":/)
    for (const p of Object.values(out.passages)) {
      expect(Object.keys(p).filter((k) => !["when", "interrupt"].includes(k))).toEqual(["name", "tags", "onEnter", "ending", "text", "choices"])
    }
  })
})

describe("story index and edit helpers", () => {
  it("indexes names and ids first-wins, with incoming and outgoing links", () => {
    const s = story(":: A", "--", "[[x->B]]", "[[y->b]]", "[[z->Nope]]", "", ":: B", "@end", "--", "", ":: B2", "@id b", "@end", "--")
    const index = createStoryIndex(s.story)
    expect(index.byId.get("b")!.name).toBe("B")
    expect(resolveTarget(s.story, "b", index)).toBe(resolveTarget(s.story, "b"))
    expect(index.outgoing.get("a")!.map((o) => (o.to && o.to !== "@return" ? o.to.name : o.to))).toEqual(["B", "B", null])
    expect(index.incoming.get("b")!.map((i) => [i.from.id, i.choiceIndex])).toEqual([["a", 0], ["a", 1]])
  })

  it("adds, deletes and retags passages without changing the input, and the file round-trips", () => {
    const s = parseTwee3(":: StoryTitle\nT\n\n:: A\n[[Go->B]]\n\n:: StoryData\n{\"ifid\":\"9B1D7C2E-3F4A-4B5C-8D6E-7F8091A2B3C4\",\"start\":\"A\"}\n\n:: B\n@end\n--\nEnd.\n", "t.twee").story
    const extra = story(":: C", "@end", "--", "New.").story.passages[0]!
    const added = addPassage(s, extra)
    expect(s.passages).toHaveLength(2)
    expect(added.passages.map((p) => p.id)).toEqual(["a", "b", "c"])
    expect(() => addPassage(added, extra)).toThrow(/already exists/)

    const removed = deletePassage(added, "a")
    expect(removed.passages.map((p) => p.id)).toEqual(["b", "c"])
    const text = writeTwee3(removed)
    expect(text.indexOf(":: StoryData")).toBeLessThan(text.indexOf(":: B"))
    expect(parseTwee3(text, "t.twee").story.passages.map((p) => p.id)).toEqual(["b", "c"])
    expect(() => deletePassage(removed, "a")).toThrow(/no passage with id "a"/)

    const tagged = updatePassageTags(removed, "b", ["script"])
    expect(tagged.passages[0]!.tags).toEqual(["script"])
    expect(tagged.passages[0]!.isEnding).toBe(false) // a script passage has no rules
    expect(updatePassageTags(tagged, "b", ["script"])).toBe(tagged)
    expect(parseTwee3(writeTwee3(tagged), "t.twee").story.passages[0]!.tags).toEqual(["script"])
  })
})
