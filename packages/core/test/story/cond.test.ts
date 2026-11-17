import { describe, expect, it } from "vitest"
import { applyEffects, evalCond, formatCond, formatEffects, initialState, parseCond, parseEffects } from "../../src/story/cond"
import type { StateSchema } from "../../src/story/types"

describe("conditions", () => {
  it("parses comparisons, and/or/not, parentheses and value kinds", () => {
    expect(parseCond("a >= 1")).toEqual({ kind: "cmp", variable: "a", op: ">=", value: 1 })
    expect(parseCond('a >= 1 and (mood == EXCITED or not seen) and name != "Rex the dog"')).toEqual({
      kind: "and",
      terms: [
        { kind: "cmp", variable: "a", op: ">=", value: 1 },
        {
          kind: "or",
          terms: [
            { kind: "cmp", variable: "mood", op: "==", value: "EXCITED" },
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
      "a >= 1 and (mood == EXCITED or not seen)",
      "not (a < 2 and b > 3)",
      '(a == 1 and b == 2) and c == "two words"',
      "a <= 1 or b != x or (c == true and d == false)",
    ]) {
      const c = parseCond(src)
      expect(parseCond(formatCond(c))).toEqual(c)
    }
  })

  it("evaluates against a state", () => {
    const c = parseCond("a >= 1 and (mood == EXCITED or not seen)")
    expect(evalCond(c, { a: 1, mood: "EXCITED", seen: true })).toBe(true)
    expect(evalCond(c, { a: 1, mood: "CALM", seen: false })).toBe(true)
    expect(evalCond(c, { a: 1, mood: "CALM", seen: true })).toBe(false)
    expect(evalCond(c, { a: 0, mood: "EXCITED", seen: false })).toBe(false)
  })
})

describe("effects", () => {
  const schema: StateSchema = {
    excitement: { type: "number", min: 0, max: 100 },
    energy: { type: "int", min: 0, max: 10, initial: 5 },
    mood: { type: "enum", values: ["CALM", "EXCITED"] },
    seen: { type: "bool" },
  }

  it("parses and formats", () => {
    const e = parseEffects("excitement += 20, energy -= 7, mood = EXCITED, seen = true")
    expect(e).toEqual([
      { variable: "excitement", op: "add", amount: 20 },
      { variable: "energy", op: "add", amount: -7 },
      { variable: "mood", op: "set", amount: "EXCITED" },
      { variable: "seen", op: "set", amount: true },
    ])
    expect(formatEffects(e)).toBe("excitement += 20, energy -= 7, mood = EXCITED, seen = true")
    expect(parseEffects(formatEffects(e))).toEqual(e)
    expect(() => parseEffects("excitement += lots")).toThrow()
    expect(() => parseEffects("excitement")).toThrow()
  })

  it("applies with clamping and leaves the input alone", () => {
    const s0 = initialState(schema)
    expect(s0).toEqual({ excitement: 0, energy: 5, mood: "CALM", seen: false })
    const s1 = applyEffects(s0, parseEffects("excitement += 135, energy -= 7, mood = EXCITED, seen = true"), schema)
    expect(s1).toEqual({ excitement: 100, energy: 0, mood: "EXCITED", seen: true })
    expect(s0.excitement).toBe(0)
  })
})
