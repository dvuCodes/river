import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { describe, expect, it } from "vitest"
import { exportStory } from "../../src/export/export"
import { parseTwee3 } from "../../src/formats/twee3"
import { lint } from "../../src/lint/lint"
import { runCheckData } from "../../src/project/check-data"
import { loadProject } from "../../src/project/project"
import type { StateSchema } from "../../src/story/types"
import {
  lintWorkspace,
  loadStoryWorkspace,
  parseCrossStoryTarget,
  resolveWorkspaceTarget,
} from "../../src/story/workspace"

const makeStory = (file: string, title: string, start: string, ...lines: string[]) =>
  parseTwee3(
    [
      ":: StoryTitle",
      title,
      "",
      ":: StoryData",
      JSON.stringify({ ifid: "9B1D7C2E-3F4A-4B5C-8D6E-7F8091A2B3C4", start }),
      "",
      ...lines,
    ].join("\n"),
    file,
  ).story

const schema: StateSchema = {
  bond: { type: "int", min: 0, max: 100, initial: 50 },
}

describe("parseCrossStoryTarget", () => {
  it("parses valid Story::Passage targets", () => {
    expect(parseCrossStoryTarget("chapter2::Gate")).toEqual({ story: "chapter2", target: "Gate" })
    expect(parseCrossStoryTarget("stories/chapter2.twee::Main Gate")).toEqual({
      story: "stories/chapter2.twee",
      target: "Main Gate",
    })
    expect(parseCrossStoryTarget("  Chapter Two :: Gate  ")).toEqual({
      story: "Chapter Two",
      target: "Gate",
    })
    expect(parseCrossStoryTarget("chapter2::Sub::Gate")).toEqual({
      story: "chapter2",
      target: "Sub::Gate",
    })
  })

  it("ignores local targets, @return, URLs, and malformed :: targets", () => {
    expect(parseCrossStoryTarget("Gate")).toBeUndefined()
    expect(parseCrossStoryTarget("@return")).toBeUndefined()
    expect(parseCrossStoryTarget("http://example.com")).toBeUndefined()
    expect(parseCrossStoryTarget("https://example.com/a::b")).toBeUndefined()
    expect(parseCrossStoryTarget("::Gate")).toBeUndefined()
    expect(parseCrossStoryTarget("chapter2::")).toBeUndefined()
    expect(parseCrossStoryTarget(" :: ")).toBeUndefined()
  })
})

describe("loadStoryWorkspace & resolveWorkspaceTarget", () => {
  const ch1 = makeStory(
    "stories/chapter1.twee",
    "Chapter One",
    "Intro",
    ":: Intro",
    "You stand at the edge of town.",
    "[[Stay here->Town]]",
    "[[Head to Chapter 2->chapter2::Gate]]",
    "",
    ":: Town",
    "@id town_square",
    "@end",
    "--",
    "Quiet streets.",
  )

  const ch2 = makeStory(
    "stories/chapter2.twee",
    "Chapter Two",
    "Gate",
    ":: Gate",
    "@id ch2_gate",
    "@end",
    "--",
    "The iron gate creaks open.",
  )

  const ws = loadStoryWorkspace([
    { file: "stories/chapter1.twee", id: "chapter1", story: ch1 },
    { file: "stories/chapter2.twee", id: "chapter2", story: ch2 },
  ])

  it("resolves local targets by name and id, and @return", () => {
    const byName = resolveWorkspaceTarget(ws, "chapter1", "Town")
    expect(byName.kind).toBe("local")
    if (byName.kind === "local") {
      expect(byName.storyId).toBe("chapter1")
      expect(byName.passage.id).toBe("town_square")
    }

    const byId = resolveWorkspaceTarget(ws, "chapter1", "town_square")
    expect(byId.kind).toBe("local")

    expect(resolveWorkspaceTarget(ws, "chapter1", "@return")).toEqual({ kind: "return" })
  })

  it("resolves cross-story targets by id, relative file, and story title", () => {
    for (const ref of [
      "chapter2::Gate",
      "chapter2::ch2_gate",
      "stories/chapter2.twee::Gate",
      "stories\\chapter2.twee::Gate",
      "Chapter Two::Gate",
    ]) {
      const res = resolveWorkspaceTarget(ws, "chapter1", ref)
      expect(res.kind).toBe("cross")
      if (res.kind === "cross") {
        expect(res.storyId).toBe("chapter2")
        expect(res.passage.id).toBe("ch2_gate")
      }
    }
  })

  it("reports missing story vs missing passage cleanly", () => {
    expect(resolveWorkspaceTarget(ws, "chapter1", "chapter9::Gate")).toEqual({ kind: "missing" })
    expect(resolveWorkspaceTarget(ws, "chapter1", "chapter2::Nowhere")).toEqual({
      kind: "missing",
      storyId: "chapter2",
    })
    expect(resolveWorkspaceTarget(ws, "chapter1", "Nowhere")).toEqual({
      kind: "missing",
      storyId: "chapter1",
    })
  })
})

describe("lintWorkspace", () => {
  it("suppresses resolved cross-links and flags missing cross-story targets as broken-cross-link", () => {
    const ch1 = makeStory(
      "stories/chapter1.twee",
      "Chapter One",
      "Start",
      ":: Start",
      "Ready to go.",
      "[[Go to Gate->chapter2::Gate]]",
      "[[Plain link->chapter2::Secret]]",
      "[[Missing story->chapter9::Gate]]",
      "[[Missing passage->chapter2::Ghost]]",
      "[[Missing local->LocalGhost]]",
    )
    const ch2 = makeStory(
      "stories/chapter2.twee",
      "Chapter Two",
      "Gate",
      ":: Gate",
      "@end",
      "--",
      "Welcome to chapter 2.",
      "",
      ":: Secret",
      "You entered through the side door.",
      "[[Deeper->Vault]]",
      "",
      ":: Vault",
      "@end",
      "--",
      "Gold.",
      "",
      ":: Orphan",
      "@end",
      "--",
      "Nobody links here.",
    )

    // Single-file lint remains backward-compatible and reports cross-links as broken-link.
    const singleCh1 = lint(ch1, schema).filter((d) => d.code === "broken-link")
    expect(singleCh1).toHaveLength(5)

    // Workspace lint suppresses resolved cross-links, reports broken-cross-link, and tracks cross-story reachability.
    const ws = loadStoryWorkspace([
      { file: "stories/chapter1.twee", id: "chapter1", story: ch1 },
      { file: "stories/chapter2.twee", id: "chapter2", story: ch2 },
    ])
    const results = lintWorkspace(ws, schema)
    const ch1Diags = results.find((r) => r.file === "stories/chapter1.twee")!.diagnostics
    const ch2Diags = results.find((r) => r.file === "stories/chapter2.twee")!.diagnostics

    expect(ch1Diags.map((d) => [d.code, d.message])).toEqual([
      ["broken-cross-link", 'Start → chapter9::Gate: no story "chapter9"'],
      ["broken-cross-link", 'Start → chapter2::Ghost: no passage "Ghost" in story "chapter2"'],
      ["broken-link", "Start → LocalGhost: no passage has this name"],
    ])

    // Secret and Vault are reachable from chapter1::Start; only Orphan is unreachable!
    expect(ch2Diags.map((d) => [d.code, d.passageId])).toEqual([["unreachable", "orphan"]])
  })
})

describe("exportStory with workspace", () => {
  const ch1 = makeStory(
    "stories/chapter1.twee",
    "Chapter One",
    "Start",
    ":: Start",
    "Time to move on.",
    "[[Stay->End]]",
    "[[Head to Chapter 2->chapter2::Gate]]",
    "",
    ":: End",
    "@end",
    "--",
    "Done.",
  )
  const ch2 = makeStory(
    "stories/chapter2.twee",
    "Chapter Two",
    "Gate",
    ":: Gate",
    "@id iron_gate",
    "@end",
    "--",
    "Chapter 2 begins.",
  )
  const ws = loadStoryWorkspace([
    { file: "stories/chapter1.twee", id: "chapter1", story: ch1 },
    { file: "stories/chapter2.twee", id: "chapter2", story: ch2 },
  ])

  it("emits <storyId>::<passageId> when exporting with a workspace", () => {
    const exported = exportStory(ch1, schema, "chapter1", { workspace: ws })
    expect(exported.passages["start"]!.choices.map((c) => c.to)).toEqual(["end", "chapter2::iron_gate"])
  })

  it("still throws without a workspace (backward-compatible) and throws on broken cross-links with a workspace", () => {
    expect(() => exportStory(ch1, schema, "chapter1")).toThrow(/broken|no passage/i)

    const broken = makeStory(
      "stories/broken.twee",
      "Broken",
      "Start",
      ":: Start",
      "[[Bad->chapter2::Missing]]",
    )
    const wsBroken = loadStoryWorkspace([
      { file: "stories/broken.twee", id: "broken", story: broken },
      { file: "stories/chapter2.twee", id: "chapter2", story: ch2 },
    ])
    expect(() => exportStory(broken, schema, "broken", { workspace: wsBroken })).toThrow(
      /no passage "Missing" in story "chapter2"/,
    )
  })
})

describe("runCheckData in a multi-file workspace", () => {
  it("exports cross-story links and disambiguates colliding nested basenames", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "river-checkdata-ws-"))
    try {
      mkdirSync(path.join(root, "stories", "act1"), { recursive: true })
      mkdirSync(path.join(root, "stories", "act2"), { recursive: true })
      writeFileSync(path.join(root, "stories", "state.json"), "{}\n", "utf8")
      writeFileSync(
        path.join(root, "stories", "act1", "Intro.twee"),
        [
          ":: StoryTitle",
          "Act 1",
          "",
          ":: StoryData",
          '{ "ifid": "9B1D7C2E-3F4A-4B5C-8D6E-7F8091A2B3C4", "start": "Start" }',
          "",
          ":: Start",
          "[[Next->act2/intro::End]]",
        ].join("\n"),
        "utf8",
      )
      writeFileSync(
        path.join(root, "stories", "act2", "intro.twee"),
        [
          ":: StoryTitle",
          "Act 2",
          "",
          ":: StoryData",
          '{ "ifid": "9B1D7C2E-3F4A-4B5C-8D6E-7F8091A2B3C5", "start": "End" }',
          "",
          ":: End",
          "@end",
          "--",
          "Fin.",
        ].join("\n"),
        "utf8",
      )
      writeFileSync(
        path.join(root, "check.mjs"),
        [
          'import { readFileSync } from "node:fs"',
          'const d = process.env.RIVER_EXPORT_DIR',
          'const a = JSON.parse(readFileSync(d + "/act1/Intro.json", "utf8"))',
          'const b = JSON.parse(readFileSync(d + "/act2/intro.json", "utf8"))',
          'if (a.passages.start.choices[0].to !== "act2/intro::end") process.exit(2)',
          'if (b.id !== "act2/intro") process.exit(3)',
          'console.log("ok")',
        ].join("\n"),
        "utf8",
      )
      writeFileSync(
        path.join(root, "river.json"),
        JSON.stringify({
          name: "ws",
          engine: "none",
          stories: "stories",
          state: "stories/state.json",
          export: "export",
          adapter: {},
          shots: [],
          checkData: "node check.mjs",
        }),
        "utf8",
      )
      const project = await loadProject(root)
      const res = await runCheckData(project, {})
      expect(res.ok).toBe(true)
      expect(res.output.trim()).toBe("ok")
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
