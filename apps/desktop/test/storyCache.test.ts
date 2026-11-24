import { describe, expect, it, vi } from "vitest"
import { StoryCache, staleStories } from "../src/main/storyCache"

describe("StoryCache", () => {
  it("loads a story once and shares the promise with callers that ask while it loads", async () => {
    const cache = new StoryCache<string>()
    const load = vi.fn(async () => "parsed")
    const [a, b] = await Promise.all([cache.get("s.twee", load), cache.get("s.twee", load)])
    expect(a).toBe("parsed")
    expect(b).toBe("parsed")
    await cache.get("s.twee", load)
    expect(load).toHaveBeenCalledTimes(1)
  })

  it("loads again after the story is invalidated, and keeps other stories", async () => {
    const cache = new StoryCache<number>()
    let n = 0
    const load = async () => ++n
    expect(await cache.get("a", load)).toBe(1)
    expect(await cache.get("b", load)).toBe(2)
    cache.invalidate("a")
    expect(await cache.get("a", load)).toBe(3)
    expect(await cache.get("b", load)).toBe(2)
    cache.invalidate()
    expect(await cache.get("b", load)).toBe(4)
  })

  it("does not keep a failed load", async () => {
    const cache = new StoryCache<string>()
    await expect(cache.get("s", async () => Promise.reject(new Error("bad twee")))).rejects.toThrow("bad twee")
    expect(cache.has("s")).toBe(false)
    expect(await cache.get("s", async () => "fixed")).toBe("fixed")
  })

  it("never stores a load that was in flight when the story was invalidated", async () => {
    const cache = new StoryCache<string>()
    let finish!: (v: string) => void
    const stale = cache.get("s", () => new Promise<string>((r) => (finish = r)))
    cache.invalidate("s")
    finish("old text")
    expect(await stale).toBe("old text")
    expect(await cache.get("s", async () => "new text")).toBe("new text")
  })
})

describe("staleStories", () => {
  it("drops every story on a state or manifest change", () => {
    expect(staleStories([{ kind: "story", rel: "stories/a.twee" }, { kind: "state", rel: "state.json" }])).toBe("all")
    expect(staleStories([{ kind: "manifest", rel: "river.json" }])).toBe("all")
  })
  it("drops only the story files that changed, once each", () => {
    expect(
      staleStories([
        { kind: "story", rel: "stories/a.twee" },
        { kind: "board", rel: ".river/boards/main/cards/c_1.json" },
        { kind: "story", rel: "stories/a.twee" },
        { kind: "story", rel: "stories/b.twee" },
      ]),
    ).toEqual(["stories/a.twee", "stories/b.twee"])
    expect(staleStories([{ kind: "job", rel: ".river/jobs/j_1.json" }])).toEqual([])
  })
})
