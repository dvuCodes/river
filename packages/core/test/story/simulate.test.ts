import { describe, expect, it } from "vitest"
import { parseTwee3 } from "../../src/formats/twee3"
import { formatSimulationReport, mulberry32, simulateStory } from "../../src/lint/simulate"
import type { StateSchema } from "../../src/story/types"
import { loadExample } from "./helpers"

const story = (...lines: string[]) => parseTwee3([":: StoryData", '{ "ifid": "9B1D7C2E-3F4A-4B5C-8D6E-7F8091A2B3C4", "start": "A" }', "", ...lines].join("\n"), "t.twee").story

const schema: StateSchema = {
  gold: { type: "int", min: 0, max: 10, initial: 0 },
  mood: { type: "enum", values: ["calm", "angry"], initial: "calm" },
  lit: { type: "bool", initial: false },
}

describe("mulberry32", () => {
  it("is deterministic per seed and stays in [0, 1)", () => {
    const a = mulberry32(42)
    const b = mulberry32(42)
    const xs = Array.from({ length: 1000 }, () => a())
    expect(Array.from({ length: 1000 }, () => b())).toEqual(xs)
    expect(xs.every((x) => x >= 0 && x < 1)).toBe(true)
    expect(mulberry32(43)()).not.toBe(xs[0])
    // Roughly uniform.
    const mean = xs.reduce((s, x) => s + x, 0) / xs.length
    expect(mean).toBeGreaterThan(0.45)
    expect(mean).toBeLessThan(0.55)
  })
})

describe("simulateStory", () => {
  const fork = () =>
    story(
      ":: A", "--", "[[Left->L]] @set gold += 2", "[[Right->R]] @set mood = \"angry\"", "[[Locked->R]] @when gold > 5", "",
      ":: L", "@end", "--", "",
      ":: R", "@set lit = true", "--", "[[On->End]]", "",
      ":: End", "@end", "--", "",
      ":: Orphan", "@end", "--",
    )

  it("counts endings, visits, untaken choices and final state", () => {
    const r = simulateStory(fork(), schema, { runs: 400, seed: 7 })
    expect(r.runs).toBe(400)
    expect(r.seed).toBe(7)
    expect(r.deadEnds).toBe(0)
    expect(r.maxStepsHit).toBe(0)
    expect(r.endings.map((e) => e.passageId).sort()).toEqual(["end", "l"])
    expect(r.endings.reduce((s, e) => s + e.count, 0)).toBe(400)
    expect(r.endings[0]!.count).toBeGreaterThanOrEqual(r.endings[1]!.count)
    for (const e of r.endings) {
      expect(e.rate).toBeCloseTo(e.count / 400)
      expect(e.rate).toBeGreaterThan(0.4)
      expect(e.rate).toBeLessThan(0.6)
    }
    expect(r.endings.find((e) => e.passageId === "l")!.name).toBe("L")
    expect(r.passageVisits.a).toEqual({ runs: 400, rate: 1 })
    expect(r.passageVisits.orphan).toEqual({ runs: 0, rate: 0 })
    expect(r.passageVisits.r!.runs).toBe(r.passageVisits.end!.runs)
    expect(r.neverVisitedPassages).toEqual(["orphan"])
    expect(r.neverTakenChoices).toEqual([{ passageId: "a", choiceIndex: 2, label: "Locked" }])
    expect(r.steps.min).toBe(1)
    expect(r.steps.max).toBe(2)
    expect(r.steps.avg).toBeGreaterThan(1)
    expect(r.steps.avg).toBeLessThan(2)
    expect(r.finalState.gold).toMatchObject({ type: "int", min: 0, max: 2 })
    const mood = r.finalState.mood as { type: string; counts: Record<string, number> }
    expect(mood.type).toBe("enum")
    expect(mood.counts.calm! + mood.counts.angry!).toBe(400)
    expect(mood.counts.angry).toBe(r.passageVisits.r!.runs)
    expect((r.finalState.lit as { counts: Record<string, number> }).counts.true).toBe(r.passageVisits.r!.runs)
  })

  it("the same seed gives the same report; another seed may differ", () => {
    const s = fork()
    expect(simulateStory(s, schema, { runs: 50, seed: 3 })).toEqual(simulateStory(s, schema, { runs: 50, seed: 3 }))
    const counts = new Set([1, 2, 3, 4, 5, 6].map((seed) => simulateStory(s, schema, { runs: 20, seed }).endings[0]!.count))
    expect(counts.size).toBeGreaterThan(1)
  })

  it("defaults to 200 runs with seed 1", () => {
    const r = simulateStory(fork(), schema)
    expect([r.runs, r.seed]).toEqual([200, 1])
  })

  it("counts dead ends and games cut off by maxSteps", () => {
    const dead = simulateStory(story(":: A", "--", "Nothing here."), schema, { runs: 10 })
    expect([dead.deadEnds, dead.maxStepsHit, dead.endings]).toEqual([10, 0, []])
    expect(dead.steps).toEqual({ min: 0, max: 0, avg: 0 })
    const loop = simulateStory(story(":: A", "--", "[[Again->A]] @set gold += 1"), schema, { runs: 5, maxSteps: 7 })
    expect([loop.deadEnds, loop.maxStepsHit]).toEqual([0, 5])
    expect(loop.steps).toEqual({ min: 7, max: 7, avg: 7 })
    expect(loop.finalState.gold).toEqual({ type: "int", min: 7, max: 7, avg: 7 })
  })

  it("draws storylets when no choice is open, unless includeStorylets is false", () => {
    const s = story(
      ":: A", "--", "[[Leave->Out]] @when gold >= 3", "",
      ":: Out", "@end", "--", "",
      ":: Coin [storylet]", "--", "[[Take->@return]] @set gold += 1", "",
      ":: Unused [storylet]", "@when gold > 99", "--", "[[x->@return]]",
    )
    const r = simulateStory(s, schema, { runs: 20 })
    expect(r.endings).toEqual([{ passageId: "out", name: "Out", count: 20, rate: 1 }])
    // 3 draws, 3 takes, then leave.
    expect(r.steps).toEqual({ min: 7, max: 7, avg: 7 })
    expect(r.passageVisits.coin).toEqual({ runs: 20, rate: 1 })
    expect(r.neverVisitedPassages).toEqual(["unused"])
    const off = simulateStory(s, schema, { runs: 5, includeStorylets: false })
    expect(off.deadEnds).toBe(5)
    expect(off.neverVisitedPassages).toEqual(["out", "coin", "unused"])
  })

  it("an @auto @end interrupt ends the game", () => {
    const s = story(
      ":: A", "--", "[[Spend->A]] @set gold -= 1", "[[Earn->A]] @set gold += 1", "",
      ":: Broke [interrupt]", "@auto", "@when gold == 0 and visits(a) >= 3", "@end", "--", "Broke.",
    )
    const r = simulateStory(s, schema, { runs: 50, maxSteps: 200 })
    expect(r.endings.map((e) => e.passageId)).toEqual(["broke"])
    expect(r.endings[0]!.count + r.maxStepsHit).toBe(50)
    expect(r.passageVisits.broke!.runs).toBe(r.endings[0]!.count)
  })

  it("handles zero runs without NaN", () => {
    const r = simulateStory(fork(), schema, { runs: 0 })
    expect(r.steps).toEqual({ min: 0, max: 0, avg: 0 })
    expect(r.passageVisits.a).toEqual({ runs: 0, rate: 0 })
    expect(r.finalState.gold).toEqual({ type: "int", min: 0, max: 0, avg: 0 })
  })

  it("handles large run counts without blowing the call stack", () => {
    const r = simulateStory(story(":: A", "@end", "--", "Done."), schema, { runs: 150_000 })
    expect(r.runs).toBe(150_000)
    expect(r.steps).toEqual({ min: 0, max: 0, avg: 0 })
    expect(r.finalState.gold).toEqual({ type: "int", min: 0, max: 0, avg: 0 })
  })

  it("plays the park-walk example to its endings", () => {
    const { story: s, schema: sch } = loadExample()
    const r = simulateStory(s, sch, { runs: 100 })
    expect(r.endings.length).toBeGreaterThan(0)
    expect(r.endings.reduce((n, e) => n + e.count, 0) + r.deadEnds + r.maxStepsHit).toBe(100)
  })
})

describe("formatSimulationReport", () => {
  it("prints endings, counts, never-seen content and final state", () => {
    const s = story(":: A", "--", "[[Go->B]] @set gold += 1", "[[Never->B]] @when gold > 5", "", ":: B", "@end", "--", "", ":: C", "@end", "--")
    const lines = formatSimulationReport(simulateStory(s, schema, { runs: 4, seed: 2 }))
    expect(lines[0]).toBe("4 simulated games (seed 2)")
    expect(lines).toContain("endings:")
    expect(lines.some((l) => /^ {2}B +4 {2}100\.0%$/.test(l))).toBe(true)
    expect(lines).toContain("dead ends: 0   max steps hit: 0")
    expect(lines).toContain("steps: min 1, avg 1, max 1")
    expect(lines).toContain("never visited: c")
    expect(lines).toContain('  a#1 "Never"')
    expect(lines).toContain("  gold: min 1, avg 1, max 1")
    expect(lines).toContain("  mood: calm 4")
    expect(lines).toContain("  lit: false 4")
  })

  it("says when no ending was reached", () => {
    expect(formatSimulationReport(simulateStory(story(":: A", "--"), {}, { runs: 1 }))).toContain("  none reached")
  })
})
