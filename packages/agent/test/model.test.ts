import { describe, expect, it } from "vitest"
import { DEFAULT_MODEL, isValidModel, KNOWN_MODELS, MODEL_ID, type AgentModel } from "../src/index"

describe("isValidModel", () => {
  it("accepts the known models and the default", () => {
    expect(KNOWN_MODELS).toEqual(["claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-4-5"])
    for (const m of KNOWN_MODELS) expect(isValidModel(m), m).toBe(true)
    expect(DEFAULT_MODEL).toBe("claude-opus-5-5")
    expect(isValidModel(DEFAULT_MODEL)).toBe(true)
  })

  it("accepts other safe ids, so a new or custom model needs no code change", () => {
    for (const m of ["claude-sonnet-4-6", "openai:gpt-5", "my_model.v2", "a", "9lives", "a".repeat(100)]) expect(isValidModel(m), m).toBe(true)
    const custom: AgentModel = "claude-sonnet-4-6"
    expect(custom).toBe("claude-sonnet-4-6")
  })

  it("rejects flags, whitespace, shell characters, empty and overlong ids, and non-strings", () => {
    for (const m of ["-x", "--model", "--dangerously-skip-permissions", "", " ", "claude opus", " claude-opus-5-5", "claude-opus-5-5\n", "a;b", "a&&b", "a|b", "$(x)", "`x`", "a/b", "a\b", "a\"b", ".hidden", "_x", "a".repeat(101)]) expect(isValidModel(m), JSON.stringify(m)).toBe(false)
    for (const m of [undefined, null, 42, {}, ["claude-opus-5-5"]]) expect(isValidModel(m)).toBe(false)
    expect(MODEL_ID.test("claude-opus-5-5")).toBe(true)
  })
})
