import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { exportStory, proseText } from "../../src/export/export"
import { parseTwee3, writeTwee3 } from "../../src/formats/twee3"
import { lint } from "../../src/lint/lint"
import { satisfiable } from "../../src/lint/sat"
import { createPlaytest } from "../../src/play/playtest"
import { listStories, loadProject, loadSchema, loadStory, safePath, saveStory } from "../../src/project/project"
import { parseCond } from "../../src/story/cond"
import { passageById } from "../../src/story/model"
import { paths } from "../../src/story/paths"
import type { StateSchema } from "../../src/story/types"
import { exampleRoot, loadExample } from "./helpers"

describe("lint", () => {
  it("finds exactly the planted problems in the example", () => {
    const { story, schema, diagnostics } = loadExample()
    expect(diagnostics).toEqual([])
    const found = lint(story, schema)
    expect(found.map((d) => [d.severity, d.code, d.passageId])).toEqual([
      ["error", "broken-link", "pond"],
      ["warn", "never-true", "pond"],
      ["warn", "blocked-choice", "long_path"],
      ["warn", "dead-end", "fetch"],
    ])
    expect(found[0]!.message).toBe("Pond → Splash: no passage has this name")
    expect(found[0]!.span?.line).toBe(27)
  })

  it("warns when a choice can show while its target cannot be entered, counting the choice's own costs and clamping", () => {
    const schema: StateSchema = { energy: { type: "number", min: 0, max: 100, initial: 80 } }
    const src = [
      ":: Gate",
      "--",
      "[[Throw->Fetch]] @cost energy 10 @when energy >= 10",
      "[[Rest->Fetch]] @set energy = 50",
      "[[Ready->Fetch]] @cost energy 10 @when energy >= 30",
      "[[Tired->Fetch]] @set energy = 5",
      "[[Full->Low]] @set energy += 50",
      "",
      ":: Fetch",
      "@when energy >= 20",
      "@end",
      "--",
      "",
      ":: Low",
      "@when energy <= 100",
      "@end",
      "--",
    ].join("\n")
    const found = lint(parseTwee3(src, "t.twee").story, schema).filter((d) => d.code === "blocked-choice")
    expect(found.map((d) => d.message)).toEqual([
      "Gate → Fetch: the choice can show while Fetch cannot be entered (its @when energy >= 20 is false after the choice's @cost and @set). Give the choice @when energy >= 10 and energy >= 30, or loosen Fetch's @when.",
      "Gate → Fetch: Fetch has @when energy >= 20, which is never true after the choice's @cost and @set when this choice shows, so the move always fails. Loosen one of the two conditions.",
    ])
    expect(found.map((d) => d.span?.line)).toEqual([3, 6])
  })

  it("checks variables, types, duplicates and reachability", () => {
    const schema: StateSchema = {
      n: { type: "int", min: 0, max: 10 },
      mood: { type: "enum", values: ["CALM", "SURGE"] },
      seen: { type: "bool" },
    }
    const src = [
      ":: A",
      "@when ghost > 1",
      "--",
      "[[B]] @when mood == ANGRY",
      "[[C]] @when mood > CALM",
      "[[A2->B]] @set seen = 3, n += 1",
      ":: B",
      "@end",
      "--",
      ":: C",
      "@id b",
      "@end",
      "--",
      ":: Lost",
      "@when n > 3 and n < 4",
      "@end",
      "--",
    ].join("\n")
    const { story } = parseTwee3(src, "f")
    const codes = lint(story, schema).map((d) => `${d.severity}:${d.code}`)
    expect(codes).toContain("error:unknown-var")
    expect(codes.filter((c) => c === "error:type-mismatch")).toHaveLength(3)
    expect(codes).toContain("error:duplicate-id")
    expect(codes).toContain("warn:unreachable")
    expect(codes).toContain("warn:never-true") // n > 3 and n < 4 has no int
  })
})

describe("satisfiable", () => {
  const schema: StateSchema = {
    x: { type: "number", min: 0, max: 100 },
    i: { type: "int", min: 0, max: 3 },
    m: { type: "enum", values: ["A", "B"] },
    b: { type: "bool" },
  }
  const sat = (...src: string[]) => satisfiable(src.map(parseCond), schema)
  it("uses ranges and handles and/or/not", () => {
    expect(sat("x > 150")).toBe(false)
    expect(sat("x > 50", "x < 20")).toBe(false)
    expect(sat("x > 50 or x < 20")).toBe(true)
    expect(sat("not (x >= 0)")).toBe(false)
    expect(sat("x == 100")).toBe(true)
    expect(sat("x > 100")).toBe(false)
    expect(sat("i != 0 and i != 1 and i != 2 and i != 3")).toBe(false)
    expect(sat("m != A and m != B")).toBe(false)
    expect(sat("b and not b")).toBe(false)
    expect(sat("unknown > 1000")).toBe(true)
  })
})

describe("paths", () => {
  it("lists the routes of the example", () => {
    const { story, schema } = loadExample()
    const routes = paths(story, schema)
    const show = routes.map((r) => [r.steps.map((s) => s.passageId).join(">"), r.end, r.satisfiable])
    expect(show).toEqual([
      ["gate>pond>calm_down>home_grumpy", "ending", true],
      ["gate>pond>treat>home_happy", "ending", true],
      ["gate>long_path>fetch", "dead-end", true],
      ["gate>long_path>home_happy", "ending", true],
    ])
    expect(routes[1]!.steps[1]).toEqual({ passageId: "pond", choiceIndex: 1 })
    expect(routes[1]!.conditions).toEqual([parseCond("treats >= 1")])
  })

  it("finds loops, unsatisfiable routes and respects maxPaths", () => {
    const schema: StateSchema = { x: { type: "number", min: 0, max: 100 } }
    const src = [
      ":: A",
      "[[up->B]] @when x > 50",
      "[[again->A]]",
      ":: B",
      "[[down->C]] @when x < 20",
      ":: C",
      "@end",
      "--",
    ].join("\n")
    const { story } = parseTwee3(src, "f")
    const routes = paths(story, schema)
    expect(routes.map((r) => [r.steps.map((s) => s.passageId).join(">"), r.end, r.satisfiable])).toEqual([
      ["a>b>c", "ending", false],
      ["a>a", "loop", true],
    ])
    expect(paths(story, schema, { maxPaths: 1 })).toHaveLength(1)
    expect(paths(story, schema, { from: "B" })[0]!.steps.map((s) => s.passageId)).toEqual(["b", "c"])
  })
})

describe("playtest", () => {
  it("chooses, applies effects, closes choices and undoes", () => {
    const { story, schema } = loadExample()
    const play = createPlaytest(story, schema)
    expect(play.current().id).toBe("gate")
    play.choose(0)
    expect(play.current().id).toBe("pond")
    expect(play.state().excitement).toBe(30) // 10 + 20 on entry
    const choices = play.choices()
    expect(choices.map((c) => c.open)).toEqual([true, true, false]) // Let go needs excitement > 150
    expect(() => play.choose(2)).toThrow(/closed/)
    play.choose(1) // Throw a treat: cost treats 1, then Treat onEnter bond += 10
    expect(play.current().id).toBe("treat")
    expect(play.state()).toMatchObject({ treats: 1, bond: 60 })
    play.undo()
    expect(play.current().id).toBe("pond")
    expect(play.state().treats).toBe(2)
    play.setVar("treats", 0)
    expect(play.choices()[1]!.open).toBe(false)
    expect(() => play.setVar("treats", 1.5)).toThrow()
    expect(() => play.setVar("nope", 1)).toThrow()
    play.setVar("excitement", 100)
    play.choose(0) // Hold the leash: excitement -= 30, bond -= 5
    expect(play.state()).toMatchObject({ excitement: 70, bond: 45 })
    expect(play.isOver()).toBe(false)
    play.choose(0)
    expect(play.current().id).toBe("home_grumpy")
    expect(play.isOver()).toBe(true)
    expect(play.history().map((h) => h.passageId)).toEqual(["gate", "pond", "calm_down", "home_grumpy"])
  })

  it("throws on a broken choice and ends at a dead end", () => {
    const { story, schema } = loadExample()
    const play = createPlaytest(story, schema, { from: "Pond", state: { excitement: 100 } })
    // excitement starts at 100, onEnter +20 is clamped to 100; > 150 still false, so closed.
    expect(play.state().excitement).toBe(100)
    const fetch = createPlaytest(story, schema, { from: "Fetch" })
    expect(fetch.isOver()).toBe(true)
  })
})

describe("export", () => {
  it("refuses a story with lint errors", () => {
    const { story, schema } = loadExample()
    expect(() => exportStory(story, schema, "park_walk")).toThrow(/Splash/)
  })

  it("exports a clean story", () => {
    const { story, schema } = loadExample()
    const fixed = parseTwee3(writeTwee3(story).replace("[[Let go->Splash]] @when excitement > 150\n", ""), story.file).story
    const out = exportStory(fixed, schema, "park_walk")
    expect(out.schema).toBe(1)
    expect(out.start).toBe("gate")
    expect(Object.keys(out.passages)).toEqual(["gate", "pond", "long_path", "calm_down", "treat", "fetch", "home_happy", "home_grumpy"])
    expect(out.passages.gate!.text).toBe("The park gate creaks open. The dog pulls toward the pond.")
    expect(out.passages.pond!.choices[1]).toEqual({
      label: "Throw a treat",
      to: "treat",
      cost: [{ variable: "treats", op: "add", amount: -1 }],
      set: [],
      when: { kind: "cmp", variable: "treats", op: ">=", value: 1 },
    })
    expect(out.passages.home_happy!.ending).toBe(true)
    expect(out.passages.pond!.onEnter).toEqual([{ variable: "excitement", op: "add", amount: 20 }])
    expect(JSON.parse(JSON.stringify(out))).toEqual(out)
  })

  it("turns inline links into their label", () => {
    expect(proseText("You could [[run->Run]] away.\n\n[[Stay]] @set a += 1\nEnd.")).toBe("You could run away.\n\nEnd.")
  })
})

describe("project", () => {
  it("loads the example project with defaults", async () => {
    const project = await loadProject(exampleRoot)
    expect(project.manifest.editable).toEqual(["data/**", "tools/shots/**"])
    expect(await listStories(project)).toEqual(["stories/park_walk.twee"])
    const schema = await loadSchema(project)
    expect(schema.treats).toEqual({ type: "int", min: 0, max: 10, initial: 2 })
    const { story } = await loadStory(project, "stories/park_walk.twee")
    expect(story.file).toBe("stories/park_walk.twee")
  })

  it("safePath rejects escapes from the root", async () => {
    const project = await loadProject(exampleRoot)
    expect(() => safePath(project, "../river.json")).toThrow(/outside/)
    expect(() => safePath(project, "stories/../../x")).toThrow(/outside/)
    expect(() => safePath(project, join(tmpdir(), "x.twee"))).toThrow(/outside/)
    expect(safePath(project, "stories/new/deeper/file.twee")).toMatch(/file\.twee$/)
  })

  it("rejects an invalid manifest and saves stories inside the root", async () => {
    const dir = mkdtempSync(join(tmpdir(), "river-test-"))
    writeFileSync(join(dir, "river.json"), JSON.stringify({ name: 1 }))
    await expect(loadProject(dir)).rejects.toThrow(/invalid/)
    writeFileSync(join(dir, "river.json"), JSON.stringify({ name: "t", engine: "none", stories: "stories", state: "state.json", export: "out" }))
    mkdirSync(join(dir, "stories"))
    const project = await loadProject(dir)
    const { story } = loadExample()
    await saveStory(project, "stories/sub/a.twee", story)
    expect(await listStories(project)).toEqual(["stories/sub/a.twee"])
    const back = await loadStory(project, "stories/sub/a.twee")
    expect(back.story.passages.map((p) => p.rawText)).toEqual(story.passages.map((p) => p.rawText))
    await expect(saveStory(project, "../escape.twee", story)).rejects.toThrow(/outside/)
  })
})

describe("passageById", () => {
  it("finds a passage by id", () => {
    expect(passageById(loadExample().story, "gate")?.name).toBe("Gate")
  })
})
