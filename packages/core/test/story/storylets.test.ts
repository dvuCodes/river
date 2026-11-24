import { describe, expect, it } from "vitest"
import { exportStory } from "../../src/export/export"
import { parseTwee3 } from "../../src/formats/twee3"
import { lint } from "../../src/lint/lint"
import { lintNarrative } from "../../src/lint/narrative"
import { createPlaytest } from "../../src/play/playtest"
import { isStorylet, passageById } from "../../src/story/model"
import { reachableFromInitial } from "../../src/story/paths"
import type { StateSchema } from "../../src/story/types"

const story = (...lines: string[]) => parseTwee3([":: StoryData", '{ "ifid": "9B1D7C2E-3F4A-4B5C-8D6E-7F8091A2B3C4", "start": "Hub" }', "", ...lines].join("\n"), "t.twee")

const schema: StateSchema = {
  energy: { type: "int", min: 0, max: 10, initial: 5 },
  rain: { type: "bool", initial: false },
}

/** A hub with a wait loop, three storylets and an ending. */
const deck = () =>
  story(
    ":: Hub",
    "--",
    "[[Wait->Hub2]]",
    "[[Go home->Home]]",
    "",
    ":: Hub2",
    "--",
    "[[Back->Hub]]",
    "",
    ":: Home",
    "@end",
    "--",
    "",
    ":: Squirrel [storylet]",
    "@weight 3",
    "@cooldown 2",
    "@set energy -= 1",
    "--",
    "A squirrel!",
    "[[Carry on->@return]]",
    "",
    ":: Puddle [storylet]",
    "@when energy >= 3",
    "--",
    "[[Splash->@return]] @set energy -= 2",
    "",
    ":: Storm [storylet]",
    "@priority 5",
    "@when rain == true",
    "--",
    "[[Shelter->@return]]",
  )

describe("parsing @weight, @priority, @cooldown and @auto", () => {
  it("reads valid values and sets fields only when present", () => {
    const { story: s, diagnostics } = deck()
    expect(diagnostics).toEqual([])
    const sq = passageById(s, "squirrel")!
    expect(sq).toMatchObject({ weight: 3, cooldown: 2 })
    expect("priority" in sq).toBe(false)
    expect(passageById(s, "storm")!.priority).toBe(5)
    const hub = passageById(s, "hub")!
    for (const k of ["weight", "priority", "cooldown", "auto"]) expect(k in hub).toBe(false)
    expect(isStorylet(sq)).toBe(true)
    expect(isStorylet(hub)).toBe(false)
  })

  it("accepts negative priority, zero cooldown and fractional weight", () => {
    const { story: s, diagnostics } = story(":: Hub", "@weight 0.5", "@priority -2", "@cooldown 0", "@auto", "--", "x")
    expect(diagnostics).toEqual([])
    expect(passageById(s, "hub")).toMatchObject({ weight: 0.5, priority: -2, cooldown: 0, auto: true })
  })

  it.each([
    ["@weight 0", "@weight needs a positive number"],
    ["@weight -1", "@weight needs a positive number"],
    ["@weight", "@weight needs a positive number"],
    ["@weight 1e3", "@weight needs a positive number"],
    ["@weight abc", "@weight needs a positive number"],
    ["@priority 1.5", "@priority needs a whole number"],
    ["@priority", "@priority needs a whole number"],
    ["@priority 0x10", "@priority needs a whole number"],
    ["@cooldown -1", "@cooldown needs a whole number of turns"],
    ["@cooldown 2.5", "@cooldown needs a whole number of turns"],
    ["@cooldown", "@cooldown needs a whole number of turns"],
  ])("%s is an error", (rule, message) => {
    const { story: s, diagnostics } = story(":: Hub", rule, "--", "x")
    expect(diagnostics).toHaveLength(1)
    expect(diagnostics[0]).toMatchObject({ severity: "error", code: "parse" })
    expect(diagnostics[0]!.message).toContain(message)
    const hub = passageById(s, "hub")!
    for (const k of ["weight", "priority", "cooldown"]) expect(k in hub).toBe(false)
  })

  it("@auto with a value warns but still sets the flag", () => {
    const { story: s, diagnostics } = story(":: Hub [interrupt]", "@auto now", "--", "x")
    expect(diagnostics.map((d) => [d.severity, d.message])).toEqual([["warn", 'Hub: @auto takes no value (found "now")']])
    expect(passageById(s, "hub")!.auto).toBe(true)
  })
})

describe("lint and paths with storylets", () => {
  it("storylets can @return and are not unreachable", () => {
    const { story: s } = deck()
    expect(lint(s, schema)).toEqual([])
  })

  it("a @return outside any detour is still a broken link", () => {
    const { story: s } = story(":: Hub", "--", "[[Back->@return]]")
    expect(lint(s, schema).map((d) => d.code)).toContain("broken-link")
  })

  it("passages linked only from a storylet are reachable", () => {
    const { story: s } = story(":: Hub", "@end", "--", "", ":: Deck [storylet]", "--", "[[More->Deeper]]", "", ":: Deeper", "--", "[[Back->@return]]")
    expect(lint(s, schema)).toEqual([])
  })

  it("warns about @auto on a passage that is not an interrupt", () => {
    const { story: s } = story(":: Hub", "@end", "--", "", ":: Deck [storylet]", "@auto", "--", "[[Back->@return]]")
    expect(lint(s, schema).map((d) => [d.code, d.message])).toEqual([
      ["auto-not-interrupt", "Deck: @auto only starts passages tagged [interrupt]; tag it [interrupt] or drop @auto"],
    ])
  })

  it("a rule word below the rule block is flagged as prose", () => {
    const { story: s } = story(":: Hub", "@end", "--", "@weight 2")
    expect(lint(s, schema).map((d) => d.code)).toEqual(["rule-in-prose"])
  })

  it("reachableFromInitial includes satisfiable storylets and leaves out impossible ones", () => {
    const { story: s } = story(
      ":: Hub", "--", "[[Home->Home]]", "",
      ":: Home", "@end", "--", "",
      ":: Ok [storylet]", "@when energy >= 3", "--", "[[Back->@return]]", "",
      ":: Never [storylet]", "@when energy > 10", "--", "[[Back->@return]]",
    )
    const r = reachableFromInitial(s, schema)
    expect(r.passages.has("ok")).toBe(true)
    expect(r.passages.has("never")).toBe(false)
    const flagged = lintNarrative(s, schema).filter((d) => d.code === "unreachable-from-initial").map((d) => d.passageId)
    expect(flagged).toEqual(["never"])
  })

  it("lintNarrative does not flag the deck story's storylets", () => {
    const { story: s } = deck()
    expect(lintNarrative(s, schema).filter((d) => d.code === "unreachable-from-initial")).toEqual([])
  })
})

describe("export", () => {
  it("adds storylet fields only where used", () => {
    const { story: s } = deck()
    const out = exportStory(s, schema, "deck")
    expect(out.schema).toBe(1)
    expect(out.passages.squirrel).toMatchObject({ storylet: true, weight: 3, cooldown: 2 })
    expect("priority" in out.passages.squirrel!).toBe(false)
    expect(out.passages.storm).toMatchObject({ storylet: true, priority: 5 })
    expect(Object.keys(out.passages.hub!)).toEqual(["name", "tags", "onEnter", "ending", "text", "choices"])
    const { story: a } = story(":: Hub", "@end", "--", "", ":: Alarm [interrupt]", "@auto", "@priority 2", "@when rain == true", "--", "[[Ok->@return]]")
    expect(exportStory(a, schema, "a").passages.alarm).toMatchObject({ interrupt: true, auto: true, priority: 2 })
  })

  it("a story without the new rules exports exactly as before", () => {
    const { story: s } = story(":: Hub", "@set energy += 1", "--", "Hi.", "[[Go->End]]", "", ":: End", "@end", "--", "Bye.")
    expect(exportStory(s, schema, "plain")).toEqual({
      schema: 1,
      id: "plain",
      title: "",
      start: "hub",
      state: schema,
      passages: {
        hub: { name: "Hub", tags: [], onEnter: [{ variable: "energy", op: "add", amount: 1 }], ending: false, text: "Hi.", choices: [{ label: "Go", to: "end", cost: [], set: [] }] },
        end: { name: "End", tags: [], onEnter: [], ending: true, text: "Bye.", choices: [] },
      },
    })
  })
})

describe("playtest storylets", () => {
  it("lists storylets with weight, priority, cooldown and whether they are open", () => {
    const { story: s } = deck()
    const play = createPlaytest(s, schema)
    expect(play.storylets().map((x) => [x.passage.id, x.open, x.weight, x.priority, x.cooldownLeft])).toEqual([
      ["squirrel", true, 3, 0, 0],
      ["puddle", true, 1, 0, 0],
      ["storm", false, 1, 5, 0],
    ])
    expect(play.history()[0]).toMatchObject({ turn: 0, cooldowns: {} })
  })

  it("draws by weight with the given rng, enters the storylet, and @return comes back", () => {
    const { story: s } = deck()
    const play = createPlaytest(s, schema)
    // weights squirrel 3, puddle 1 (total 4): r * 4 < 3 picks squirrel.
    expect(play.drawStorylet(() => 0.74)!.id).toBe("squirrel")
    expect(play.current().id).toBe("squirrel")
    expect(play.state().energy).toBe(4)
    expect(play.history().at(-1)).toMatchObject({ returnTo: "hub", turn: 1, cooldowns: { squirrel: 3 } })
    // Inside a detour nothing more can be drawn.
    expect(play.storylets().every((x) => !x.open)).toBe(true)
    expect(play.drawStorylet(() => 0)).toBeUndefined()
    play.choose(0)
    expect(play.current().id).toBe("hub")
    expect(play.history().at(-1)).toMatchObject({ turn: 2 })
    expect(play.history().at(-1)!.returnTo).toBeUndefined()

    play.undo()
    play.undo()
    const fresh = createPlaytest(s, schema)
    expect(fresh.drawStorylet(() => 0.76)!.id).toBe("puddle")
  })

  it("cooldown blocks the storylet for its turns and undo restores it", () => {
    const { story: s } = deck()
    const play = createPlaytest(s, schema)
    play.drawStorylet(() => 0) // squirrel, turn 1, cooldown until 3
    play.choose(0) // back to hub, turn 2
    const sq = () => play.storylets().find((x) => x.passage.id === "squirrel")!
    expect(sq()).toMatchObject({ open: false, cooldownLeft: 1 })
    expect(play.drawStorylet(() => 0)!.id).toBe("puddle") // only puddle is open; turn 3
    play.choose(0) // turn 4
    expect(sq()).toMatchObject({ open: true, cooldownLeft: 0 })
    play.undo()
    play.undo()
    expect(sq()).toMatchObject({ open: false, cooldownLeft: 1 })
    play.undo()
    play.undo()
    expect(play.history()).toHaveLength(1)
    expect(sq()).toMatchObject({ open: true, cooldownLeft: 0 })
    expect(play.history()[0]!.cooldowns).toEqual({})
  })

  it("the highest open priority wins whatever the weights", () => {
    const { story: s } = deck()
    const play = createPlaytest(s, schema)
    play.setVar("rain", true)
    expect(play.drawStorylet(() => 0.99)!.id).toBe("storm")
  })

  it("no open storylet: returns undefined and changes nothing", () => {
    const { story: s } = story(":: Hub", "--", "[[Go->End]]", "", ":: End", "@end", "--", "", ":: S [storylet]", "@when rain == true", "--", "[[Back->@return]]")
    const play = createPlaytest(s, schema)
    expect(play.drawStorylet()).toBeUndefined()
    expect(play.history()).toHaveLength(1)
    play.choose(0)
    play.setVar("rain", true)
    expect(play.storylets()[0]!.open).toBe(false) // the story has ended
  })

  it("a storylet with @end has nowhere to return to", () => {
    const { story: s } = story(":: Hub", "--", "[[Loop->Hub]]", "", ":: Doom [storylet]", "@end", "--", "The end.")
    const play = createPlaytest(s, schema)
    expect(play.drawStorylet()!.id).toBe("doom")
    expect(play.isOver()).toBe(true)
    expect(play.history().at(-1)!.returnTo).toBeUndefined()
  })

  it("history copies do not share cooldowns", () => {
    const { story: s } = deck()
    const play = createPlaytest(s, schema)
    play.drawStorylet(() => 0)
    play.history().at(-1)!.cooldowns.squirrel = 0
    expect(play.history().at(-1)!.cooldowns.squirrel).toBe(3)
  })
})

describe("playtest @auto interrupts", () => {
  const auto = () =>
    story(
      ":: Hub", "--", "[[Run->Hub]] @set energy -= 3", "[[Rest->Hub]] @set energy += 1", "",
      ":: Tired [interrupt]", "@auto", "@when energy <= 2", "--", "[[Sit->@return]] @set energy += 5", "",
      ":: Collapse [interrupt]", "@auto", "@priority 10", "@when energy == 0", "@end", "--", "You collapse.", "",
      ":: Manual [interrupt]", "@when energy <= 2", "--", "[[Ok->@return]]",
    )

  it("starts as its own step once its @when holds, and one undo takes it back", () => {
    const { story: s } = auto()
    expect(lint(s, schema)).toEqual([])
    const play = createPlaytest(s, schema)
    play.choose(0) // energy 2
    expect(play.current().id).toBe("tired")
    expect(play.history().map((h) => [h.passageId, h.turn])).toEqual([["hub", 0], ["hub", 1], ["tired", 1]])
    expect(play.history().at(-1)!.returnTo).toBe("hub")
    play.undo()
    expect(play.current().id).toBe("hub")
    expect(play.state().energy).toBe(2)
  })

  it("does not fire again on the @return", () => {
    const { story: s } = story(
      ":: Hub", "--", "[[Run->Hub]] @set energy -= 3", "",
      ":: Tired [interrupt]", "@auto", "@when energy <= 2", "--", "[[Sit->@return]]",
    )
    const play = createPlaytest(s, schema)
    play.choose(0)
    expect(play.current().id).toBe("tired")
    play.choose(0)
    expect(play.current().id).toBe("hub")
    expect(play.history().at(-1)!.returnTo).toBeUndefined()
  })

  it("the higher priority wins, and an @auto @end interrupt ends the story", () => {
    const { story: s } = auto()
    const play = createPlaytest(s, schema)
    play.setVar("energy", 3)
    play.choose(0) // energy 0: both auto interrupts hold, collapse has priority 10
    expect(play.current().id).toBe("collapse")
    expect(play.isOver()).toBe(true)
    expect(play.history().at(-1)!.returnTo).toBeUndefined()
  })

  it("equal priority keeps file order; interrupts without @auto never start by themselves", () => {
    const { story: s } = story(
      ":: Hub", "--", "[[Go->Hub]] @set rain = true", "",
      ":: Manual [interrupt]", "@when rain == true", "--", "[[Ok->@return]]", "",
      ":: First [interrupt]", "@auto", "@when rain == true", "--", "[[Ok->@return]]", "",
      ":: Second [interrupt]", "@auto", "@when rain == true", "--", "[[Ok->@return]]",
    )
    const play = createPlaytest(s, schema)
    play.choose(0)
    expect(play.current().id).toBe("first")
  })

  it("does not fire inside an interrupt or a storylet", () => {
    const { story: s } = story(
      ":: Hub", "--", "[[Wait->Hub]]", "",
      ":: Deck [storylet]", "--", "[[Deeper->Inner]]", "",
      ":: Inner", "--", "[[Back->@return]]", "",
      ":: Alarm [interrupt]", "@auto", "--", "[[Ok->@return]]",
    )
    const play = createPlaytest(s, schema)
    expect(play.drawStorylet()!.id).toBe("deck")
    play.choose(0)
    expect(play.current().id).toBe("inner")
    play.choose(0)
    expect(play.current().id).toBe("hub")
    play.choose(0)
    expect(play.current().id).toBe("alarm")
  })

  it("a choice linking straight to an @auto interrupt does not start it again on top of itself", () => {
    const { story: s } = story(":: Hub", "--", "[[Go->Alarm]]", "", ":: Alarm [interrupt]", "@auto", "@when rain == false", "--", "[[Ok->Hub]]")
    const play = createPlaytest(s, schema)
    play.choose(0)
    expect(play.history().map((h) => h.passageId)).toEqual(["hub", "alarm"])
  })

  it("sees the visit counts with the new passage counted", () => {
    const { story: s } = story(
      ":: Hub", "--", "[[Go->Room]]", "",
      ":: Room", "--", "[[Back->Hub]]", "",
      ":: Welcome [interrupt]", "@auto", "@when visited(room) and visits(welcome) == 0", "--", "[[Ok->@return]]",
    )
    const play = createPlaytest(s, schema)
    play.choose(0)
    expect(play.current().id).toBe("welcome")
    play.choose(0)
    play.choose(0)
    play.choose(0)
    expect(play.current().id).toBe("room")
  })
})
