import { describe, expect, it, vi } from "vitest"
import { StoryCache, staleStories, storyIdsFor } from "../src/main/storyCache"

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

describe("StoryCache workspace", () => {
  it("caches workspace and clears it on any story or full invalidation", async () => {
    const cache = new StoryCache<string, number>()
    let n = 0
    const load = vi.fn(async () => ++n)
    const [a, b] = await Promise.all([cache.getWorkspace(load), cache.getWorkspace(load)])
    expect(a).toBe(1)
    expect(b).toBe(1)
    expect(cache.hasWorkspace()).toBe(true)
    cache.invalidate("stories/a.twee")
    expect(cache.hasWorkspace()).toBe(false)
    expect(await cache.getWorkspace(load)).toBe(2)
    cache.invalidate()
    expect(cache.hasWorkspace()).toBe(false)
    expect(await cache.getWorkspace(load)).toBe(3)
    expect(load).toHaveBeenCalledTimes(3)
  })

  it("does not keep a failed workspace load", async () => {
    const cache = new StoryCache<string, string>()
    await expect(cache.getWorkspace(async () => Promise.reject(new Error("boom")))).rejects.toThrow("boom")
    expect(cache.hasWorkspace()).toBe(false)
    expect(await cache.getWorkspace(async () => "ok")).toBe("ok")
  })
})

describe("storyIdsFor", () => {
  it("uses basename without extension when basenames are unique", () => {
    const ids = storyIdsFor(["stories/ch1.twee", "stories/act2/ch2.tw"], "stories")
    expect(ids.get("stories/ch1.twee")).toBe("ch1")
    expect(ids.get("stories/act2/ch2.tw")).toBe("ch2")
  })

  it("uses relative path under manifest.stories when basenames collide (case-insensitively)", () => {
    const ids = storyIdsFor(["stories/act1/Intro.twee", "stories/act2/intro.twee", "stories/outro.twee"], "stories")
    expect(ids.get("stories/act1/Intro.twee")).toBe("act1/Intro")
    expect(ids.get("stories/act2/intro.twee")).toBe("act2/intro")
    expect(ids.get("stories/outro.twee")).toBe("outro")
  })
})
