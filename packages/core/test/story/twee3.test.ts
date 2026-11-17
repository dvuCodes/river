import { describe, expect, it } from "vitest"
import { parseTwee3, writeTwee3 } from "../../src/formats/twee3"
import { renamePassage, resolveTarget, slug, updatePassageText } from "../../src/story/model"
import { findLinks, splitLink } from "../../src/story/passage"
import { essence, loadExample } from "./helpers"

const IFID = "3F0B6C1E-8A2D-4E57-9C61-2B7D4A9E0F13"

describe("link split", () => {
  it("follows the editor's rules", () => {
    expect(splitLink("Go->Pond")).toMatchObject({ label: "Go", target: "Pond" })
    expect(splitLink("a->b->c")).toMatchObject({ label: "a->b", target: "c" })
    expect(splitLink("Pond<-Go")).toMatchObject({ label: "Go", target: "Pond" })
    expect(splitLink("x<-y<-z")).toMatchObject({ label: "y<-z", target: "x" })
    expect(splitLink("Go|Pond")).toMatchObject({ label: "Go", target: "Pond" })
    expect(splitLink("a|b|c")).toMatchObject({ label: "a|b", target: "c" })
    expect(splitLink("Pond")).toMatchObject({ label: "Pond", target: "Pond" })
    expect(splitLink("Go->Pond][$x to 1")).toMatchObject({ label: "Go", target: "Pond" })
    expect(splitLink("a|b->c")).toMatchObject({ label: "a|b", target: "c" })
  })

  it("finds links non-greedily and ignores URLs", () => {
    const links = findLinks("[[A]] and [[B->C]] and [[site->https://example.com]]")
    expect(links.map((l) => l.target)).toEqual(["A", "C"])
  })
})

describe("slug", () => {
  it("makes ids", () => {
    expect(slug("Pond!")).toBe("pond")
    expect(slug("Maple corner")).toBe("maple_corner")
    expect(slug("Café  Noir 2")).toBe("cafe_noir_2")
  })
})

describe("parseTwee3", () => {
  it("parses the header with escapes, tags and metadata", () => {
    const src = [
      ":: StoryTitle",
      "Test",
      "",
      ":: StoryData",
      `{"ifid": "${IFID}", "start": "A [1] {x} back\\\\slash", "format": "Harlowe", "zoom": 1}`,
      "",
      `:: A \\[1\\] \\{x\\} back\\\\slash [tag-one two\\]x] {"position":"10,20","size":"100,100"}`,
      "Hello",
      "\\:: not a header",
      "",
      "",
    ].join("\n")
    const { story, diagnostics } = parseTwee3(src, "t.twee")
    expect(diagnostics).toEqual([])
    expect(story.title).toBe("Test")
    expect(story.ifid).toBe(IFID)
    expect(story.start).toBe("A [1] {x} back\\slash")
    expect(story.storyData).toEqual({ format: "Harlowe", zoom: 1 })
    const p = story.passages[0]!
    expect(p.name).toBe("A [1] {x} back\\slash")
    expect(p.tags).toEqual(["tag-one", "two]x"])
    expect(p.metadata).toEqual({ position: "10,20", size: "100,100" })
    expect(p.rawText).toBe("Hello\n:: not a header")
    expect(p.id).toBe("a_1_x_back_slash")
  })

  it("parses passage rules and choice rules", () => {
    const src = [
      ":: Squirrel! [encounter]",
      "@id squirrel",
      "@when distance_m >= 90",
      "@set irk += 5",
      "--",
      "A squirrel freezes halfway up the oak.",
      "[[Leave it->Standoff]] @cost treats 1",
      "[[Hold tight->Strain]] @set irk += 35, energy -= 8 @when bond < 50",
      "You could also [[run|Run]] away.",
      ":: End",
      "@end",
      "--",
      "Done.",
    ].join("\n")
    const { story, diagnostics } = parseTwee3(src, "s.twee")
    expect(diagnostics.filter((d) => d.severity !== "info")).toEqual([])
    const p = story.passages[0]!
    expect(p.id).toBe("squirrel")
    expect(p.when).toEqual({ kind: "cmp", variable: "distance_m", op: ">=", value: 90 })
    expect(p.onEnter).toEqual([{ variable: "irk", op: "add", amount: 5 }])
    expect(p.text.startsWith("A squirrel")).toBe(true)
    expect(p.choices).toHaveLength(3)
    expect(p.choices[0]).toMatchObject({ label: "Leave it", target: "Standoff", cost: [{ variable: "treats", op: "add", amount: -1 }], set: [] })
    expect(p.choices[0]!.span).toEqual({ file: "s.twee", line: 7, column: 1 })
    expect(p.choices[1]).toMatchObject({
      label: "Hold tight",
      target: "Strain",
      set: [{ variable: "irk", op: "add", amount: 35 }, { variable: "energy", op: "add", amount: -8 }],
      when: { kind: "cmp", variable: "bond", op: "<", value: 50 },
    })
    expect(p.choices[2]).toMatchObject({ label: "run", target: "Run", cost: [], set: [] })
    expect(story.passages[1]!.isEnding).toBe(true)
    // No StoryData: start falls back to the first passage, ifid is generated.
    expect(story.start).toBe("Squirrel!")
    expect(story.ifid).toMatch(/^[0-9A-F]{8}-[0-9A-F]{4}-4[0-9A-F]{3}-[89AB][0-9A-F]{3}-[0-9A-F]{12}$/)
    expect(diagnostics.some((d) => d.severity === "info" && /ifid/.test(d.message))).toBe(true)
  })

  it("treats text without a -- line as prose, and warns on unknown rules", () => {
    const { story, diagnostics } = parseTwee3([":: A", "@note hi", "--", "x", ":: B", "@id b", "no separator"].join("\n"), "f")
    expect(diagnostics.some((d) => d.severity === "warn" && /@note/.test(d.message))).toBe(true)
    const b = story.passages[1]!
    expect(b.id).toBe("b")
    expect(b.text).toBe("@id b\nno separator")
  })

  it("reports bad JSON and keeps going", () => {
    const src = [":: StoryData", "{ not json", "", ":: A {bad meta", "text", ":: B", "more"].join("\n")
    const { story, diagnostics } = parseTwee3(src, "f")
    expect(story.passages.map((p) => p.name)).toEqual(["A", "B"])
    expect(story.passages[0]!.metadata).toEqual({})
    expect(diagnostics.filter((d) => d.severity === "warn")).toHaveLength(2)
  })

  it("reports bad rule syntax as an error diagnostic", () => {
    const { diagnostics } = parseTwee3([":: A", "@when a >=", "--", "[[B]] @set x += lots", ":: B", "@end", "--"].join("\n"), "f")
    expect(diagnostics.filter((d) => d.severity === "error")).toHaveLength(2)
  })

  it("marks script and stylesheet passages and does not read rules in them", () => {
    const { story } = parseTwee3([":: S [script]", "@id nope", "--", "if (a) [[x]]", ":: A", "hi"].join("\n"), "f")
    expect(story.passages[0]!.choices).toEqual([])
    expect(story.passages[0]!.id).toBe("s")
    expect(story.start).toBe("A")
  })
})

describe("writeTwee3", () => {
  it("round-trips the example", () => {
    const { story, diagnostics } = loadExample()
    expect(diagnostics).toEqual([])
    const again = parseTwee3(writeTwee3(story), story.file)
    expect(again.diagnostics).toEqual([])
    expect(again.story.passages.map(essence)).toEqual(story.passages.map(essence))
    expect(again.story.storyData).toEqual(story.storyData)
    expect(again.story.title).toBe(story.title)
    expect(again.story.ifid).toBe(story.ifid)
    expect(again.story.start).toBe(story.start)
    expect(again.story.passages.map((p) => p.choices.map((c) => c.target))).toEqual(story.passages.map((p) => p.choices.map((c) => c.target)))
  })

  it("round-trips escapes and :: lines", () => {
    const src = `:: StoryData\n{"ifid":"${IFID}"}\n\n:: A\\[x\\] [t\\{1\\}] {"position":"1,2"}\n\\:: inside\n\\:: also\nend\n`
    const a = parseTwee3(src, "f").story
    const b = parseTwee3(writeTwee3(a), "f").story
    expect(b.passages.map(essence)).toEqual(a.passages.map(essence))
    expect(a.passages[0]!.rawText).toBe(":: inside\n:: also\nend")
  })
})

describe("model edits", () => {
  it("updatePassageText re-parses one passage and leaves the input alone", () => {
    const { story } = loadExample()
    const next = updatePassageText(story, "fetch", "@id fetch\n@end\n--\nNap.")
    expect(next.passages.find((p) => p.id === "fetch")!.isEnding).toBe(true)
    expect(story.passages.find((p) => p.id === "fetch")!.isEnding).toBe(false)
  })

  it("renamePassage rewrites links", () => {
    const { story } = loadExample()
    const next = renamePassage(story, "pond", "Duck pond")
    expect(resolveTarget(next, "Duck pond")?.id).toBe("pond")
    expect(next.passages[0]!.rawText).toContain("[[Go to the pond->Duck pond]]")
    expect(next.passages[0]!.choices[0]!.target).toBe("Duck pond")
    // Rules after the link survive.
    const plain = parseTwee3(":: A\n[[B]] @set x += 1\n:: B\nhi", "f").story
    const renamed = renamePassage(plain, "b", "C")
    expect(renamed.passages[0]!.rawText).toBe("[[B->C]] @set x += 1")
    expect(renamed.passages[0]!.choices[0]!.set).toHaveLength(1)
  })
})
