import { describe, expect, it } from "vitest"
import { exportStory, proseText } from "../../src/export/export"
import { parseTwee3, writeTwee3 } from "../../src/formats/twee3"
import {
  extractStrings,
  formatStringsCsv,
  formatStringsJson,
  formatStringsPo,
  stripLineId,
  tagStoryLines,
} from "../../src/i18n/i18n"
import { parseProseBlocks } from "../../src/story/blocks"
import { renderProse } from "../../src/story/template"
import type { StateSchema } from "../../src/story/types"

const makeStory = (...lines: string[]) =>
  parseTwee3(
    [
      ":: StoryTitle",
      "Park Walk",
      "",
      ":: StoryData",
      '{ "ifid": "9B1D7C2E-3F4A-4B5C-8D6E-7F8091A2B3C4", "start": "Pond" }',
      "",
      ...lines,
    ].join("\n"),
    "stories/park_walk.twee",
  ).story

const schema: StateSchema = {
  treats: { type: "int", min: 0, max: 5, initial: 2 },
  bond: { type: "int", min: 0, max: 100, initial: 50 },
}

describe("stripLineId", () => {
  it("extracts trailing #line:<id> and strips it cleanly", () => {
    expect(stripLineId("Ducks. Many ducks. #line:a1b2c3d4")).toEqual({
      text: "Ducks. Many ducks.",
      lineId: "a1b2c3d4",
    })
    expect(stripLineId('Mara: "Easy, boy."   #line:intro_01  ')).toEqual({
      text: 'Mara: "Easy, boy."',
      lineId: "intro_01",
    })
    expect(stripLineId("Plain line without tag.")).toEqual({
      text: "Plain line without tag.",
    })
    // Too short (<4 chars) or not at end of line: untouched
    expect(stripLineId("Short #line:abc")).toEqual({ text: "Short #line:abc" })
    expect(stripLineId("Mid #line:abcd1234 text")).toEqual({ text: "Mid #line:abcd1234 text" })
  })
})

describe("proseText, renderProse, and parsePassage with #line:<id>", () => {
  it("strips #line:<id> from prose, dialogue, templates, and choice lines", () => {
    const s = makeStory(
      ":: Pond",
      "@id pond",
      "--",
      "Ducks. Many ducks. #line:a1b2c3d4",
      'Rex [excited]: Ducks! #line:b2c3d4e5',
      'Mara: "Easy, boy." #line:c3d4e5f6',
      "You have {treats} treats. #line:d4e5f6a7",
      "[[Throw a treat->End]] @cost treats 1 @hint \"Costs one treat\" #line:e5f6a7b8",
      "",
      ":: End",
      "@end",
      "--",
      "The ducks waddle away. #line:f6a7b8c9",
    )

    const pond = s.passages[0]!
    expect(pond.choices).toHaveLength(1)
    expect(pond.choices[0]!.cost).toEqual([{ variable: "treats", op: "add", amount: -1 }])
    expect(pond.choices[0]!.hint).toBe("Costs one treat")

    const clean = proseText(pond.text)
    expect(clean).not.toContain("#line:")
    expect(clean).toBe(
      ["Ducks. Many ducks.", "Rex [excited]: Ducks!", 'Mara: "Easy, boy."', "You have {treats} treats."].join("\n"),
    )

    const rendered = renderProse("You have {treats} treats. #line:d4e5f6a7", { state: { treats: 2 } })
    expect(rendered).toBe("You have 2 treats.")

    const blocks = parseProseBlocks(proseText(pond.text, { keepCues: true }))
    expect(blocks).toEqual([
      { kind: "narration", text: "Ducks. Many ducks." },
      { kind: "dialogue", speaker: "Rex", mood: "excited", text: "Ducks!" },
      { kind: "dialogue", speaker: "Mara", text: "Easy, boy." },
      { kind: "narration", text: "You have {treats} treats." },
    ])

    const exported = exportStory(s, schema, "park_walk")
    expect(exported.passages["pond"]!.text).not.toContain("#line:")
    expect(exported.passages["end"]!.text).toBe("The ducks waddle away.")
  })
})

describe("tagStoryLines", () => {
  it("deterministically tags untagged prose lines, preserves existing tags & untouched passages, and is idempotent", () => {
    const s = makeStory(
      ":: Pond",
      "@id pond",
      "--",
      "@cue sfx quack",
      "Ducks. Many ducks.",
      "Ducks. Many ducks.",
      "Already tagged. #line:deadbeef",
      "...",
      "[[Next->End]]",
      "",
      ":: End",
      "@end",
      "--",
      "All done. #line:cafebabe",
      "",
      ":: Helper [script]",
      "console.log('not prose')",
    )

    const first = tagStoryLines(s)
    expect(first.added).toBe(2)

    // Untouched passages (End and Helper) keep exact reference equality.
    expect(first.story.passages[1]).toBe(s.passages[1])
    expect(first.story.passages[2]).toBe(s.passages[2])

    const pondLines = first.story.passages[0]!.text.split("\n")
    expect(pondLines[0]).toBe("@cue sfx quack")
    expect(pondLines[1]).toMatch(/^Ducks\. Many ducks\. #line:[0-9a-f]{8}$/)
    expect(pondLines[2]).toMatch(/^Ducks\. Many ducks\. #line:[0-9a-f]{8}$/)
    // Duplicate lines get distinct IDs.
    expect(stripLineId(pondLines[1]!).lineId).not.toBe(stripLineId(pondLines[2]!).lineId)
    // Existing tag preserved.
    expect(pondLines[3]).toBe("Already tagged. #line:deadbeef")
    // Beat and link-only lines are not tagged.
    expect(pondLines[4]).toBe("...")
    expect(pondLines[5]).toBe("[[Next->End]]")

    // Deterministic across runs.
    const repeat = tagStoryLines(s)
    expect(repeat.story.passages[0]!.rawText).toBe(first.story.passages[0]!.rawText)

    // Idempotent: second pass adds nothing and returns same story.
    const second = tagStoryLines(first.story)
    expect(second.added).toBe(0)
    expect(second.story).toBe(first.story)

    // Survives Twee3 round-trip.
    const roundTripped = parseTwee3(writeTwee3(first.story), "stories/park_walk.twee").story
    expect(tagStoryLines(roundTripped).added).toBe(0)
  })
})

describe("extractStrings & formatters (CSV, PO, JSON)", () => {
  const s = makeStory(
    ":: Pond",
    "@id pond",
    "--",
    "Ducks, \"many\" ducks. #line:a1b2c3d4",
    "Rex [excited]: Ducks!",
    'Mara: "Easy, boy."',
    '[[Throw a treat->End]] @hint "Costs one treat"',
    "",
    ":: End",
    "@end",
    "--",
    "Peaceful.",
    "",
    ":: Style [stylesheet]",
    "body { color: red; }",
  )

  it("extracts titles, prose lines (with speaker/mood and lineId), choice labels, and hints", () => {
    const entries = extractStrings(s, { storyId: "park" })
    expect(entries).toEqual([
      {
        key: "park:pond:title",
        file: "stories/park_walk.twee",
        line: 7,
        passageId: "pond",
        passageName: "Pond",
        kind: "title",
        text: "Pond",
      },
      {
        key: "a1b2c3d4",
        file: "stories/park_walk.twee",
        line: 10,
        passageId: "pond",
        passageName: "Pond",
        kind: "line",
        text: 'Ducks, "many" ducks.',
      },
      {
        key: "park:pond:line:2",
        file: "stories/park_walk.twee",
        line: 11,
        passageId: "pond",
        passageName: "Pond",
        kind: "line",
        speaker: "Rex",
        mood: "excited",
        text: "Ducks!",
      },
      {
        key: "park:pond:line:3",
        file: "stories/park_walk.twee",
        line: 12,
        passageId: "pond",
        passageName: "Pond",
        kind: "line",
        speaker: "Mara",
        text: "Easy, boy.",
      },
      {
        key: "park:pond:choice:0:label",
        file: "stories/park_walk.twee",
        line: 13,
        passageId: "pond",
        passageName: "Pond",
        kind: "choice",
        text: "Throw a treat",
      },
      {
        key: "park:pond:choice:0:hint",
        file: "stories/park_walk.twee",
        line: 13,
        passageId: "pond",
        passageName: "Pond",
        kind: "hint",
        text: "Costs one treat",
      },
      {
        key: "park:end:title",
        file: "stories/park_walk.twee",
        line: 15,
        passageId: "end",
        passageName: "End",
        kind: "title",
        text: "End",
      },
      {
        key: "park:end:line:1",
        file: "stories/park_walk.twee",
        line: 18,
        passageId: "end",
        passageName: "End",
        kind: "line",
        text: "Peaceful.",
      },
    ])
  })

  it("formats RFC-4180 CSV, GNU gettext PO, and JSON", () => {
    const entries = extractStrings(s, { storyId: "park" })

    const csv = formatStringsCsv(entries)
    const csvLines = csv.trim().split("\n")
    expect(csvLines[0]).toBe("id,file,passage,kind,speaker,text")
    expect(csvLines[2]).toBe('a1b2c3d4,stories/park_walk.twee,pond,line,,"Ducks, ""many"" ducks."')
    expect(csvLines[3]).toBe("park:pond:line:2,stories/park_walk.twee,pond,line,Rex,Ducks!")

    const po = formatStringsPo(entries, { title: "Park Walk", language: "fr" })
    expect(po).toContain('"Project-Id-Version: Park Walk\\n"')
    expect(po).toContain('"Language: fr\\n"')
    expect(po).toContain("#: stories/park_walk.twee:10")
    expect(po).toContain('msgctxt "a1b2c3d4"')
    expect(po).toContain('msgid "Ducks, \\"many\\" ducks."')
    expect(po).toContain("#. speaker: Rex [excited]")
    expect(po).toContain('msgstr ""')

    const json = formatStringsJson(entries)
    expect(JSON.parse(json)).toEqual(entries)
  })
})
