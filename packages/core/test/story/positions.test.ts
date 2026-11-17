import { describe, expect, it } from "vitest"
import { parseTwee3, writeTwee3 } from "../../src/formats/twee3"
import { passagePosition, renamePassage, setPassagePositions, updatePassageText } from "../../src/story/model"
import { loadExample } from "./helpers"

const IFID = "3F0B6C1E-8A2D-4E57-9C61-2B7D4A9E0F13"

/** StoryData on one odd line, extra spaces, a blank-line run, a header with spaced JSON, no final newline. */
const ODD = [
  ":: StoryTitle",
  "Odd",
  "",
  ":: StoryData",
  `{ "ifid" : "${IFID}",   "format":"Harlowe",`,
  `     "zoom": 1.0 }`,
  "",
  "",
  "",
  `:: A   [t1  t2]   { "size" : "100,100",  "note": "x" }`,
  "@id a",
  "--",
  "Hello [[B]]",
  "",
  ":: B",
  "\\:: escaped",
  "Bye",
].join("\n")

const roundTrip = (text: string) => writeTwee3(parseTwee3(text, "f.twee").story)

describe("byte-preserving write", () => {
  it("writes odd formatting back byte for byte", () => {
    expect(roundTrip(ODD)).toBe(ODD)
  })

  it("keeps CRLF, a BOM, text before the first header and StoryData after passages", () => {
    const text = "﻿notes\r\n\r\n:: A\r\nHi\r\n\r\n:: StoryData\r\n{\"ifid\":\"" + IFID + "\"}\r\n"
    expect(roundTrip(text)).toBe(text)
  })

  it("keeps the example file byte for byte", () => {
    const { text, story } = loadExample()
    expect(writeTwee3(story)).toBe(text)
  })

  it("does not add StoryData to a file without one", () => {
    const text = ":: A\nHi\n"
    expect(roundTrip(text)).toBe(text)
  })

  it("changes only the edited passage body and keeps its trailing blank lines", () => {
    const { story } = parseTwee3(ODD, "f.twee")
    const before = ODD.split("\n")
    const after = writeTwee3(updatePassageText(story, "a", "@id a\n--\nHello again [[B]]")).split("\n")
    expect(after.length).toBe(before.length)
    expect(after.filter((l, i) => l !== before[i])).toEqual(["Hello again [[B]]"])
  })

  it("rewrites the header of a renamed passage", () => {
    const { story } = parseTwee3(ODD, "f.twee")
    const out = parseTwee3(writeTwee3(renamePassage(story, "b", "C")), "f.twee").story
    expect(out.passages.map((p) => p.name)).toEqual(["A", "C"])
    expect(out.passages[0]!.rawText).toContain("[[B->C]]")
  })
})

describe("passage positions", () => {
  it("setPassagePositions changes exactly one line for one passage", () => {
    const { text, story } = loadExample()
    const before = text.split("\n")
    const after = writeTwee3(setPassagePositions(story, { pond: [600.4, -399.6] })).split("\n")
    expect(after.length).toBe(before.length)
    const changed = before.map((l, i) => [l, after[i]] as const).filter(([a, b]) => a !== b)
    expect(changed).toEqual([[":: Pond [encounter]", ':: Pond [encounter] {"position":"600,-400"}']])
  })

  it("keeps other metadata keys, their order and the header prefix", () => {
    const { story } = parseTwee3(ODD, "f.twee")
    const moved = setPassagePositions(story, { a: [10, 20] })
    const lines = writeTwee3(moved).split("\n")
    expect(lines[9]).toBe(`:: A   [t1  t2]   {"size":"100,100","note":"x","position":"10,20"}`)
    const again = setPassagePositions(parseTwee3(lines.join("\n"), "f.twee").story, { a: [11, 20] })
    expect(writeTwee3(again).split("\n")[9]).toBe(`:: A   [t1  t2]   {"size":"100,100","note":"x","position":"11,20"}`)
  })

  it("returns the same story when nothing changes and ignores unknown ids", () => {
    const { story } = parseTwee3(':: A {"position":"5,6"}\nHi\n', "f.twee")
    expect(setPassagePositions(story, { a: [5, 6] })).toBe(story)
    expect(setPassagePositions(story, { nope: [1, 2] })).toBe(story)
    expect(setPassagePositions(story, { a: [Number.NaN, 2] })).toBe(story)
  })

  it("reads positions leniently and ignores bad values", () => {
    const at = (meta: string) => passagePosition(parseTwee3(`:: A ${meta}\nHi\n`, "f.twee").story.passages[0]!)
    expect(at('{"position":"600,400"}')).toEqual([600, 400])
    expect(at('{"position":" -12.5 , 3 "}')).toEqual([-12.5, 3])
    expect(at('{"position":"abc"}')).toBeUndefined()
    expect(at('{"position":"1,2,3"}')).toBeUndefined()
    expect(at('{"position":"1,"}')).toBeUndefined()
    expect(at('{"position":"x,2"}')).toBeUndefined()
    expect(at('{"position":[1,2]}')).toBeUndefined()
    expect(at("{not json}")).toBeUndefined()
  })

  it("leaves passages without a position without one", () => {
    const { text, story } = loadExample()
    const moved = setPassagePositions(story, { pond: [1, 2] })
    const reread = parseTwee3(writeTwee3(moved), story.file).story
    for (const p of reread.passages) {
      if (p.id === "pond") expect(p.metadata).toEqual({ position: "1,2" })
      else expect(p.metadata).toEqual({})
    }
    expect(text.includes("position")).toBe(false)
  })
})
