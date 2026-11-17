import { describe, expect, it } from "vitest"
import { applyEffects, evalCond, formatCond, formatEffects, initialState, parseCond, parseEffects } from "../../src/story/cond"
import type { StateSchema } from "../../src/story/types"

describe("conditions", () => {
  it("parses comparisons, and/or/not, parentheses and value kinds", () => {
    expect(parseCond("a >= 1")).toEqual({ kind: "cmp", variable: "a", op: ">=", value: 1 })
    expect(parseCond('a >= 1 and (mood == SURGE or not seen) and name != "Rex the dog"')).toEqual({
      kind: "and",
      terms: [
        { kind: "cmp", variable: "a", op: ">=", value: 1 },
        {
          kind: "or",
          terms: [
            { kind: "cmp", variable: "mood", op: "==", value: "SURGE" },
            { kind: "not", term: { kind: "cmp", variable: "seen", op: "==", value: true } },
          ],
        },
        { kind: "cmp", variable: "name", op: "!=", value: "Rex the dog" },
      ],
    })
    expect(parseCond("x < -2.5 or flag == false")).toEqual({
      kind: "or",
      terms: [
        { kind: "cmp", variable: "x", op: "<", value: -2.5 },
        { kind: "cmp", variable: "flag", op: "==", value: false },
      ],
    })
  })

  it("rejects bad input", () => {
    expect(() => parseCond("a >=")).toThrow()
    expect(() => parseCond("(a > 1")).toThrow()
    expect(() => parseCond("a > 1 b")).toThrow()
    expect(() => parseCond("")).toThrow()
  })

  it("format is the inverse of parse", () => {
    for (const src of [
      "a >= 1",
      "a >= 1 and (mood == SURGE or not seen)",
      "not (a < 2 and b > 3)",
      '(a == 1 and b == 2) and c == "two words"',
      "a <= 1 or b != x or (c == true and d == false)",
    ]) {
      const c = parseCond(src)
      expect(parseCond(formatCond(c))).toEqual(c)
    }
  })

  it("evaluates against a state", () => {
    const c = parseCond("a >= 1 and (mood == SURGE or not seen)")
    expect(evalCond(c, { a: 1, mood: "SURGE", seen: true })).toBe(true)
    expect(evalCond(c, { a: 1, mood: "CALM", seen: false })).toBe(true)
    expect(evalCond(c, { a: 1, mood: "CALM", seen: true })).toBe(false)
    expect(evalCond(c, { a: 0, mood: "SURGE", seen: false })).toBe(false)
  })
})

describe("effects", () => {
  const schema: StateSchema = {
    fear: { type: "number", min: 0, max: 100 },
    energy: { type: "int", min: 0, max: 10, initial: 5 },
    mood: { type: "enum", values: ["CALM", "SURGE"] },
    seen: { type: "bool" },
  }

  it("parses and formats", () => {
    const e = parseEffects("fear += 35, energy -= 8, mood = SURGE, seen = true")
    expect(e).toEqual([
      { variable: "fear", op: "add", amount: 35 },
      { variable: "energy", op: "add", amount: -8 },
      { variable: "mood", op: "set", amount: "SURGE" },
      { variable: "seen", op: "set", amount: true },
    ])
    expect(formatEffects(e)).toBe("fear += 35, energy -= 8, mood = SURGE, seen = true")
    expect(parseEffects(formatEffects(e))).toEqual(e)
    expect(() => parseEffects("fear += lots")).toThrow()
    expect(() => parseEffects("fear")).toThrow()
  })

  it("applies with clamping and leaves the input alone", () => {
    const s0 = initialState(schema)
    expect(s0).toEqual({ fear: 0, energy: 5, mood: "CALM", seen: false })
    const s1 = applyEffects(s0, parseEffects("fear += 135, energy -= 8, mood = SURGE, seen = true"), schema)
    expect(s1).toEqual({ fear: 100, energy: 0, mood: "SURGE", seen: true })
    expect(s0.fear).toBe(0)
  })
})
