import { describe, expect, it } from "vitest"
import { exportStory } from "../../src/export/export"
import { parseTwee3 } from "../../src/formats/twee3"
import { lint } from "../../src/lint/lint"
import { createPlaytest } from "../../src/play/playtest"
import { applyEffects, formatEffects, parseEffects } from "../../src/story/cond"
import { passageById } from "../../src/story/model"
import { interruptPaths, paths } from "../../src/story/paths"
import type { StateSchema } from "../../src/story/types"

const story = (...lines: string[]) => parseTwee3([":: StoryData", '{ "ifid": "9B1D7C2E-3F4A-4B5C-8D6E-7F8091A2B3C4", "start": "A" }', "", ...lines].join("\n"), "t.twee")
const routeNames = (s: ReturnType<typeof story>["story"], r: { steps: { passageId: string }[] }) => r.steps.map((x) => passageById(s, x.passageId)!.name).join(" > ")

const schema: StateSchema = {
  coins: { type: "int", min: 0, max: 10, initial: 0 },
  hp: { type: "number", min: 0, max: 10, initial: 5 },
}

describe("a passage's @when gates the choice that enters it", () => {
  const { story: s } = story(":: A", "--", "[[Open->Vault]]", "[[Wait->A2]]", "", ":: A2", "@end", "--", "", ":: Vault", "@when coins >= 5", "@end", "--", "Opened.")

  it("play shows the choice closed with the target's reason and refuses it", () => {
    const play = createPlaytest(s, schema)
    const open = play.choices()[0]!
    expect(open.open).toBe(false)
    expect(open.closed?.by).toBe("target")
    expect(() => play.choose(0)).toThrow('choice "Open" is closed: Vault needs coins >= 5 on arrival')
    expect(play.current().name).toBe("A")
    play.setVar("coins", 5)
    play.choose(0)
    expect(play.current().name).toBe("Vault")
  })

  it("paths still lists the route, and play and paths agree it needs coins >= 5", () => {
    const routes = paths(s, schema)
    expect(routes.map((r) => [routeNames(s, r), r.satisfiable])).toEqual([["A > Vault", true], ["A > A2", true]])
  })
})

describe("@cost gates its choice", () => {
  const src = story(":: A", "--", "[[Buy->Shop]] @cost coins 5", "", ":: Shop", "@end", "--", "Bought.")

  it("play refuses a purchase the player cannot pay, instead of clamping it to free", () => {
    const play = createPlaytest(src.story, schema)
    expect(play.choices()[0]).toMatchObject({ open: false, closed: { by: "cost" } })
    expect(() => play.choose(0)).toThrow("@cost needs coins >= 5")
    play.setVar("coins", 7)
    play.choose(0)
    expect(play.state().coins).toBe(2)
  })

  it("paths shows what the cost needs, and a route needing more than the maximum is never true", () => {
    expect(paths(src.story, schema).map((r) => [r.conditions.length, r.satisfiable])).toEqual([[1, true]])
    const poor: StateSchema = { coins: { type: "int", min: 0, max: 3 } }
    expect(paths(src.story, poor)[0]!.satisfiable).toBe(false)
  })

  it("lint warns about a cost no value in range can pay", () => {
    const poor: StateSchema = { coins: { type: "int", min: 0, max: 3 } }
    expect(lint(src.story, poor).map((d) => [d.code, d.message])).toEqual([["never-true", "A → Shop: @cost needs coins >= 5, which is never true"]])
    expect(lint(src.story, schema)).toEqual([])
  })

  it("blocked-choice counts the cost as part of when the choice is open", () => {
    const s = story(":: A", "--", "[[Buy->Shop]] @cost coins 2", "", ":: Shop", "@when coins >= 3", "@end", "--")
    expect(lint(s.story, schema).map((d) => d.message)).toEqual([
      "A → Shop: the choice can show while Shop's @when coins >= 3 is false after the choice's @cost and @set. Give the choice @when coins >= 5, or loosen Shop's @when.",
    ])
  })
})

describe("paths follow effects along the route", () => {
  it("a condition after an effect is checked on the changed state, with clamping", () => {
    const s = story(":: A", "--", "[[Hit->B]] @when hp > 0 @set hp -= 10", "", ":: B", "--", "[[Faint->C]] @when hp <= 0", "", ":: C", "@end", "--")
    expect(paths(s.story, schema).map((r) => r.satisfiable)).toEqual([true])
    const healed = story(":: A", "--", "[[Heal->B]] @set hp = 10", "", ":: B", "--", "[[Faint->C]] @when hp <= 0", "[[Over->C]] @when hp > 9.5", "", ":: C", "@end", "--")
    expect(paths(healed.story, schema).map((r) => r.satisfiable)).toEqual([false, true])
  })

  it("multiplying narrows the range: half of at most 10 is never above 5", () => {
    const s = story(":: A", "--", "[[Halve->B]] @set hp *= 0.5", "", ":: B", "--", "[[High->C]] @when hp > 5", "[[Mid->C]] @when hp >= 5", "", ":: C", "@end", "--")
    expect(paths(s.story, schema).map((r) => r.satisfiable)).toEqual([false, true])
  })

  it("lists each condition once per route, keeping `or` grouped", () => {
    const s = story(":: A", "--", "[[Go->B]] @when hp > 0", "", ":: B", "--", "[[Go->C]] @when hp > 0 and (coins < 1 or coins > 8)", "", ":: C", "@end", "--")
    expect(paths(s.story, schema)[0]!.conditions.map((c) => c.kind)).toEqual(["cmp", "or"])
  })
})

describe("engine variables", () => {
  const src = story(":: A", "@set hp = 0", "--", "[[Jump->B]] @when hp >= 9", "", ":: B", "@end", "--")

  it("are free again at every passage, whatever the story set them to", () => {
    expect(paths(src.story, schema)[0]!.satisfiable).toBe(false)
    const engine: StateSchema = { ...schema, hp: { ...schema.hp!, engine: true } }
    expect(paths(src.story, engine)[0]!.satisfiable).toBe(true)
  })
})

describe("interrupts", () => {
  const engine: StateSchema = { ...schema, hp: { type: "number", min: 0, max: 10, initial: 5, engine: true } }
  const src = story(
    ":: A", "--", "[[On->B]]", "",
    ":: B", "@end", "--", "",
    ":: Stumble [interrupt]", "@id stumble", "@when hp <= 2", "--", "Down you go.",
    '[[Get up->@return]] @set coins += 1 @hint "Takes a moment"', "[[Stay down->Rest]]", "",
    ":: Rest", "@end", "--",
  )

  it("lint treats them as reachable and accepts @return inside them", () => {
    expect(lint(src.story, engine)).toEqual([])
  })

  it("lint rejects @return where no interrupt leads", () => {
    const s = story(":: A", "--", "[[Back->@return]]")
    expect(lint(s.story, engine).map((d) => [d.code, d.message])).toEqual([
      ["broken-link", "A → @return: no interrupt passage leads here, so there is nothing to return to (tag the passage that starts the detour [interrupt])"],
    ])
  })

  it("paths lists each interrupt's routes, ending in return, apart from the main routes", () => {
    expect(paths(src.story, engine).map((r) => routeNames(src.story, r))).toEqual(["A > B"])
    expect(interruptPaths(src.story, engine).map((r) => [routeNames(src.story, r), r.end, r.satisfiable])).toEqual([
      ["Stumble", "return", true],
      ["Stumble > Rest", "ending", true],
    ])
  })

  it("play starts one while its @when holds and @return goes back with the effects kept", () => {
    const play = createPlaytest(src.story, engine)
    expect(play.interrupts().map((i) => i.open)).toEqual([false])
    expect(() => play.interrupt("Stumble")).toThrow("its @when hp <= 2 is false")
    play.setVar("hp", 1)
    play.interrupt("Stumble")
    expect(play.current().name).toBe("Stumble")
    expect(play.interrupts().map((i) => i.open)).toEqual([false])
    expect(play.choices()[0]!.choice.hint).toBe("Takes a moment")
    play.choose(0)
    expect([play.current().name, play.state().coins]).toEqual(["A", 1])
    play.undo()
    expect(play.current().name).toBe("Stumble")
  })

  it("play refuses @return when no interrupt is running", () => {
    const s = story(":: A", "--", "[[Back->@return]]")
    expect(() => createPlaytest(s.story, engine).choose(0)).toThrow("no interrupt is running")
  })

  it("export marks interrupt passages and @return targets, and keeps hints", () => {
    const data = exportStory(src.story, engine, "t")
    expect(data.passages["stumble"]).toMatchObject({ interrupt: true, choices: [{ to: "@return", hint: "Takes a moment" }, { to: "rest" }] })
    expect("interrupt" in data.passages["a"]!).toBe(false)
    expect("hint" in data.passages["stumble"]!.choices[1]!).toBe(false)
  })
})

describe("multiply and divide effects", () => {
  it("parse, apply with clamping and whole ints, and format back", () => {
    const effects = parseEffects("hp *= 0.5, coins /= 4")
    expect(effects).toEqual([{ variable: "hp", op: "mul", amount: 0.5 }, { variable: "coins", op: "mul", amount: 0.25 }])
    expect(applyEffects({ hp: 7, coins: 7 }, effects, schema)).toEqual({ hp: 3.5, coins: 1 })
    expect(applyEffects({ hp: 7 }, parseEffects("hp *= 3"), schema)).toEqual({ hp: 10 })
    expect(formatEffects(effects)).toBe("hp *= 0.5, coins *= 0.25")
    expect(() => parseEffects("hp /= 0")).toThrow("cannot divide by 0")
  })

  it("lint wants a number variable", () => {
    const s = story(":: A", "@set flag *= 2", "@end", "--")
    expect(lint(s.story, { flag: { type: "bool" } }).map((d) => d.message)).toEqual(['A: flag is a bool; "+=", "-=", "*=" and "/=" need a number'])
  })
})

describe("@hint on a choice", () => {
  it("takes quoted text, even with @ or a closing quote escaped inside", () => {
    const { story: s, diagnostics } = story(':: A', '--', '[[Leave it->B]] @cost coins 1 @hint "Costs one coin @when \\"broke\\"" @when coins < 9', "", ":: B", "@end", "--")
    expect(diagnostics).toEqual([])
    const c = s.passages.find((p) => p.name === "A")!.choices[0]!
    expect([c.hint, c.when?.kind, c.cost.length]).toEqual(['Costs one coin @when "broke"', "cmp", 1])
  })
})

describe("rule lines River would read as prose", () => {
  it("an error for a rule block closed by --- or a dash, so export refuses it", () => {
    for (const sep of ["---", "—", "----"]) {
      const s = story(":: A", "@set hp = 9", "@end", sep, "Text.")
      const found = lint(s.story, schema).filter((d) => d.code === "separator")
      expect(found.map((d) => [d.severity, d.message, d.span?.line])).toEqual([
        ["error", `A: rule lines found but the separator is "${sep}"; River expects "--", so the rules above it are read as prose`, 7],
      ])
      expect(() => exportStory(s.story, schema, "t")).toThrow("separator")
    }
  })

  it("a warning for a rule word on its own line in the prose, but not in code passages or on a link line", () => {
    const s = story(":: A", "@id a", "--", "Text.", "@set hp = 1", "[[B]] @when hp > 0", "", ":: B", "@end", "--", "", ":: Style [stylesheet]", "@media print {}")
    expect(lint(s.story, schema).map((d) => [d.code, d.span?.line])).toEqual([["rule-in-prose", 8]])
  })

  it("accepts a -- line with trailing spaces", () => {
    const s = story(":: A", "@end", "--  ", "Text.")
    expect(s.story.passages.find((p) => p.name === "A")!.isEnding).toBe(true)
  })
})
