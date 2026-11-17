import { describe, expect, it } from "vitest"
import { parseTwee3, writeTwee3 } from "../../src/formats/twee3"
import { passageById, renamePassage, resolveTarget } from "../../src/story/model"
import { loadExample } from "./helpers"

describe("renamePassage keeps the passage id", () => {
  it("adds a rules block with @id when the passage has none", () => {
    const { story } = parseTwee3(":: A\n[[Go->Old name]]\n:: Old name\nHello.\n[[Back->A]]", "f")
    expect(passageById(story, "old_name")).toBeDefined()
    const next = renamePassage(story, "old_name", "New name")
    const p = resolveTarget(next, "New name")!
    expect(p.id).toBe("old_name")
    expect(p.rawText).toBe("@id old_name\n--\nHello.\n[[Back->A]]")
    expect(p.text).toBe("Hello.\n[[Back->A]]")
    expect(p.choices.map((c) => c.target)).toEqual(["A"])
    expect(next.passages[0]!.choices[0]!.target).toBe("New name")
  })

  it("adds @id to an existing rules block that has no @id", () => {
    const { story } = parseTwee3(":: Start\n[[Shop]]\n:: Shop\n@set coins += 1\n@when coins < 9\n--\nA shop.", "f")
    const next = renamePassage(story, "shop", "Market")
    const p = resolveTarget(next, "Market")!
    expect(p.id).toBe("shop")
    expect(p.rawText).toBe("@id shop\n@set coins += 1\n@when coins < 9\n--\nA shop.")
    expect(p.onEnter).toHaveLength(1)
    expect(p.when).toBeDefined()
  })

  it("leaves the text alone when the passage already has @id", () => {
    const { story } = loadExample()
    const before = passageById(story, "pond")!.rawText
    const next = renamePassage(story, "pond", "Duck pond")
    expect(passageById(next, "pond")!.rawText).toBe(before)
    expect(passageById(next, "pond")!.name).toBe("Duck pond")
  })

  it("adds nothing when the new name has the same slug", () => {
    const { story } = parseTwee3(":: Start\n[[Shop]]\n:: Shop\nA shop.", "f")
    const next = renamePassage(story, "shop", "shop")
    expect(passageById(next, "shop")!.rawText).toBe("A shop.")
  })

  it("the id survives a write and read", () => {
    const { story } = parseTwee3(":: Start\n[[Shop]]\n:: Shop\nA shop.", "f")
    const reread = parseTwee3(writeTwee3(renamePassage(story, "shop", "Market")), "f").story
    expect(resolveTarget(reread, "Market")?.id).toBe("shop")
    expect(passageById(reread, "start")!.choices[0]!.target).toBe("Market")
  })
})
