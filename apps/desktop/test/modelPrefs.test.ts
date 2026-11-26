import { DEFAULT_MODEL, KNOWN_MODELS } from "@river/agent"
import { describe, expect, it } from "vitest"
import { parseModel, parseSelfCheckModel, storedModel, storedSelfCheckModel } from "../src/main/modelPrefs"
import { modelLabel, modelOptions } from "../src/renderer/src/models"

describe("model prefs (main)", () => {
  it("keeps any saved safe model id and falls back to the default otherwise", () => {
    for (const m of KNOWN_MODELS) expect(storedModel(m)).toBe(m)
    expect(storedModel("claude-future-9")).toBe("claude-future-9")
    expect(storedModel(undefined)).toBe(DEFAULT_MODEL)
    expect(storedModel("--dangerous")).toBe(DEFAULT_MODEL)
    expect(storedModel("has space")).toBe(DEFAULT_MODEL)
    expect(storedModel(42)).toBe(DEFAULT_MODEL)
  })

  it("leaves the self-check model unset unless a safe id is saved", () => {
    expect(storedSelfCheckModel("claude-haiku-4-5")).toBe("claude-haiku-4-5")
    expect(storedSelfCheckModel(undefined)).toBeUndefined()
    expect(storedSelfCheckModel("")).toBeUndefined()
    expect(storedSelfCheckModel("a;rm -rf")).toBeUndefined()
  })

  it("accepts known and custom model ids, trimmed, and refuses unsafe ones", () => {
    expect(parseModel(" claude-sonnet-5-5 ")).toBe("claude-sonnet-5-5")
    expect(parseModel("my-org:custom.model_1")).toBe("my-org:custom.model_1")
    expect(() => parseModel("")).toThrow(/Not a model id/)
    expect(() => parseModel("-p")).toThrow(/Not a model id/)
    expect(() => parseModel("x $(whoami)")).toThrow(/Not a model id/)
    expect(() => parseModel("a".repeat(101))).toThrow(/Not a model id/)
    expect(() => parseModel(null)).toThrow(/Not a model id/)
  })

  it("clears the self-check model on an empty string", () => {
    expect(parseSelfCheckModel("")).toBeUndefined()
    expect(parseSelfCheckModel("   ")).toBeUndefined()
    expect(parseSelfCheckModel("claude-haiku-4-5")).toBe("claude-haiku-4-5")
    expect(() => parseSelfCheckModel("bad model")).toThrow(/Not a model id/)
  })
})

describe("model picker options (renderer)", () => {
  it("lists the known models and adds a custom current model", () => {
    const known = [...KNOWN_MODELS]
    expect(modelOptions(known, "claude-opus-5-5")).toEqual(known)
    expect(modelOptions(known, "claude-custom-1")).toEqual([...known, "claude-custom-1"])
    expect(modelOptions(undefined, "claude-opus-5-5")).toEqual(["claude-opus-5-5"])
    expect(modelOptions(undefined)).toEqual([])
  })

  it("names every known model and shows other ids as they are", () => {
    for (const m of KNOWN_MODELS) expect(modelLabel(m)).not.toBe(m)
    expect(modelLabel("claude-haiku-4-5")).toBe("Haiku 4.5")
    expect(modelLabel("claude-custom-1")).toBe("claude-custom-1")
  })
})
