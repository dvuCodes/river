import { describe, expect, it } from "vitest"
import { parseTwee3 } from "../../src/formats/twee3"
import { parseTwineHtml, writeTwineArchive } from "../../src/formats/twine-html"
import { loadExample } from "./helpers"

const strip = (p: { name: string; tags: string[]; rawText: string }) => ({ name: p.name, tags: p.tags, rawText: p.rawText })

describe("Twine 2 archive", () => {
  it("write then parse keeps the example", () => {
    const { story } = loadExample()
    const html = writeTwineArchive(story)
    expect(html).toContain('creator="River"')
    expect(html).toContain("hidden>")
    const { stories, diagnostics } = parseTwineHtml(html, "archive.html")
    expect(diagnostics).toEqual([])
    expect(stories).toHaveLength(1)
    const back = stories[0]!
    expect(back.title).toBe(story.title)
    expect(back.ifid).toBe(story.ifid)
    expect(back.start).toBe(story.start)
    expect(back.storyData["tag-colors"]).toEqual(story.storyData["tag-colors"])
    expect(back.passages.map(strip)).toEqual(story.passages.map(strip))
    expect(back.passages.map((p) => p.choices.length)).toEqual(story.passages.map((p) => p.choices.length))
  })

  it("escapes and unescapes entities, code passages and several stories", () => {
    const src = [
      ":: StoryData",
      '{"ifid":"3F0B6C1E-8A2D-4E57-9C61-2B7D4A9E0F13","format":"Harlowe","format-version":"3.3.9","zoom":0.6}',
      ":: Start [a b]",
      `Tom & "Jerry" <b>'s</b> &lt;not a tag&gt;`,
      "[[Go->Next]] @when x > 1",
      ":: Next",
      "end",
      ":: Css [stylesheet]",
      "body { color: red; }",
      ":: Js [script]",
      "if (a < b && c) {}",
    ].join("\n")
    const story = parseTwee3(src, "f").story
    const one = writeTwineArchive(story)
    const two = writeTwineArchive({ ...story, title: "Second", ifid: "11111111-2222-4333-8444-555555555555" })
    expect(one).not.toMatch(/<b>/)
    const { stories } = parseTwineHtml(`<html><body>${one}\n${two}</body></html>`, "lib.html")
    expect(stories.map((s) => s.title)).toEqual(["", "Second"])
    const s = stories[0]!
    expect(s.start).toBe("Start")
    expect(s.storyData).toMatchObject({ format: "Harlowe", "format-version": "3.3.9", zoom: 0.6 })
    const start = s.passages.find((p) => p.name === "Start")!
    expect(start.rawText).toBe(story.passages[0]!.rawText)
    expect(start.tags).toEqual(["a", "b"])
    expect(start.choices[0]).toMatchObject({ label: "Go", target: "Next", when: { kind: "cmp", variable: "x", op: ">", value: 1 } })
    expect(s.passages.find((p) => p.tags.includes("stylesheet"))!.rawText).toBe("body { color: red; }")
    expect(s.passages.find((p) => p.tags.includes("script"))!.rawText).toBe("if (a < b && c) {}")
  })

  it("decodes in one pass and maps startnode by pid", () => {
    const html = `<tw-storydata name="T" startnode="2" ifid="3f0b6c1e-8a2d-4e57-9c61-2b7d4a9e0f13" hidden>
<tw-passagedata pid="1" name="One" tags="" position="0,0" size="100,100">&amp;lt;x&amp;gt;</tw-passagedata>
<tw-passagedata pid="2" name="Two &amp; more" tags="t" position="200,0">[[One]]</tw-passagedata>
</tw-storydata>`
    const { stories } = parseTwineHtml(html, "x.html")
    const s = stories[0]!
    expect(s.ifid).toBe("3F0B6C1E-8A2D-4E57-9C61-2B7D4A9E0F13")
    expect(s.start).toBe("Two & more")
    expect(s.passages[0]!.rawText).toBe("&lt;x&gt;")
    expect(s.passages[0]!.metadata).toEqual({ position: "0,0", size: "100,100" })
    expect(s.passages[1]!.metadata).toEqual({ position: "200,0" })
  })

  it("reports a file with no story", () => {
    expect(parseTwineHtml("<html></html>", "x").diagnostics[0]!.severity).toBe("error")
  })
})
