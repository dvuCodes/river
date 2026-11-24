import { describe, expect, it } from "vitest"
import { type ChatItem, endStreaming, withDelta, withText } from "../src/renderer/src/views/agentChat"

const user: ChatItem = { kind: "user", text: "Write the bridge scene", mode: "story" }

describe("streamed assistant text", () => {
  it("builds a streaming item from deltas, then the whole block replaces it without doubling", () => {
    let items: ChatItem[] = [user]
    items = withDelta(items, "The ")
    items = withDelta(items, "river ")
    expect(items.at(-1)).toMatchObject({ kind: "assistant", text: "The river ", streaming: true })
    items = withText(items, "The river is high.")
    expect(items).toEqual([user, { kind: "assistant", text: "The river is high." }])
  })

  it("joins a second block to the first, as whole blocks did before streaming", () => {
    let items: ChatItem[] = [user]
    items = withText(withDelta(items, "One."), "One.")
    items = withDelta(items, " Tw")
    expect(items.at(-1)).toMatchObject({ text: "One. Tw", streaming: true })
    items = withText(items, " Two.")
    expect(items).toEqual([user, { kind: "assistant", text: "One. Two." }])
  })

  it("keeps a tool line between blocks as its own item", () => {
    let items: ChatItem[] = withText([user], "Reading.")
    items = [...items, { kind: "tool", tool: "story_read", summary: "bridge.twee" }]
    items = withText(withDelta(items, "Done"), "Done.")
    expect(items.map((x) => x.kind)).toEqual(["user", "assistant", "tool", "assistant"])
    expect(items.at(-1)).toEqual({ kind: "assistant", text: "Done." })
  })

  it("works without deltas (a backend that does not stream)", () => {
    expect(withText(withText([user], "a"), "b")).toEqual([user, { kind: "assistant", text: "ab" }])
  })

  it("stops streaming when the turn ends, keeping what arrived", () => {
    const items = withDelta([user], "Half a sent")
    expect(endStreaming(items)).toEqual([user, { kind: "assistant", text: "Half a sent" }])
    const quiet = withText([user], "x")
    expect(endStreaming(quiet)).toBe(quiet)
  })
})
