import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { beforeEach, describe, expect, it } from "vitest"
import { addThread, loadPlan, loadProject, setPlanStatus } from "@river/core"
import type { EngineAdapter, Project } from "@river/core"
import { createRiverTools, RIVER_TOOL_NAMES, selectTools, unifiedDiff } from "../src/index"
import type { RiverTool } from "../src/index"

const example = fileURLToPath(new URL("../../../examples/park-walk/", import.meta.url))
const STORY = "stories/park_walk.twee"

export const EXPECTED_TOOLS = [
  "project_info", "story_list", "story_read", "story_lint", "story_paths", "playtest_run",
  "frames_list", "review_list", "plan_list", "plan_read",
  "story_write_passage", "story_add_passage", "review_reply", "plan_save",
  "implement_edit", "plan_mark_implemented", "frames_capture",
]

export function tempProject(): string {
  const dir = mkdtempSync(join(tmpdir(), "river-mcp-"))
  cpSync(example, dir, { recursive: true })
  mkdirSync(join(dir, "data"))
  writeFileSync(join(dir, "data/tuning.txt"), "leash_max = 4.0\nsurge_force = 12\nsurge_force_alt = 12\nsurge_force = 12\n")
  return dir
}

let dir: string
let project: Project
let tools: RiverTool[]
const call = (name: string, input: unknown = {}) => {
  const t = tools.find((x) => x.name === name)
  if (!t) throw new Error(`no tool ${name}`)
  return t.handler(input)
}

beforeEach(async () => {
  dir = tempProject()
  project = await loadProject(dir)
  tools = createRiverTools(project)
})

describe("tool list", () => {
  it("has the 17 contract names, with the write tools marked mutating", () => {
    expect([...tools.map((t) => t.name)].sort()).toEqual([...EXPECTED_TOOLS].sort())
    expect([...RIVER_TOOL_NAMES].sort()).toEqual([...EXPECTED_TOOLS, "concept_write"].sort())
    expect(tools.filter((t) => t.mutating).map((t) => t.name).sort()).toEqual(
      ["story_write_passage", "story_add_passage", "review_reply", "plan_save", "implement_edit", "plan_mark_implemented", "frames_capture"].sort(),
    )
  })
})

describe("read tools", () => {
  it("project_info and story_list", async () => {
    expect((await call("project_info")).text).toContain(`story files: ${STORY}`)
    expect((await call("story_list")).text).toContain(`${STORY}  "Park Walk"  8 passages, start: Gate`)
  })

  it("story_read returns the raw text and the passages", async () => {
    const r = await call("story_read", { file: STORY })
    expect(r.text).toContain(readFileSync(join(dir, STORY), "utf8"))
    expect(r.text).toContain("- Pond (id pond) [encounter]")
    expect(r.text).toContain("    1: Throw a treat -> Treat")
    const data = r.data as { passages: { id: string; choices: { target: string }[] }[] }
    expect(data.passages.find((p) => p.id === "pond")!.choices.map((c) => c.target)).toEqual(["Calm down", "Treat", "Splash"])
  })

  it("story_lint reports the planted problems", async () => {
    const r = await call("story_lint", { file: STORY })
    expect(r.text).toContain("error  Pond → Splash: no passage has this name")
    expect(r.text).toContain("1 error, 2 warnings in 8 passages")
    expect((await call("story_lint")).text).toContain("1 error, 2 warnings in 8 passages")
  })

  it("story_paths formats routes like the CLI", async () => {
    const r = await call("story_paths", { file: STORY })
    expect(r.text).toContain("2  Gate → Pond → Treat → Home happy   [treats >= 1]")
  })

  it("playtest_run plays choices and shows state", async () => {
    const r = await call("playtest_run", { file: STORY, choices: [0, 1] })
    expect(r.text).toContain("== Treat == (id treat)")
    expect(r.text).toContain("> 1: Throw a treat")
    const data = r.data as { steps: { passageId: string; state: Record<string, unknown> }[] }
    expect(data.steps.map((s) => s.passageId)).toEqual(["gate", "pond", "treat"])
    await expect(call("playtest_run", { file: STORY, choices: [0, 2] })).rejects.toThrow(/step 2 \(choice 2\) failed/)
  })

  it("frames_list, review_list and plan_list are empty on a fresh project", async () => {
    expect((await call("frames_list")).text).toBe("No shots in river.json.")
    expect((await call("review_list")).text).toBe("No review threads.")
    expect((await call("plan_list")).text).toBe("No change plans.")
  })
})

describe("story writes", () => {
  it("story_write_passage writes the file and returns a diff and new lint problems", async () => {
    const r = await call("story_write_passage", {
      file: STORY,
      passageId: "fetch",
      rawText: "@id fetch\n@when energy >= 20\n--\nThree throws. Then a nap.\n\n[[Wake up->Nowhere]]",
    })
    const disk = readFileSync(join(dir, STORY), "utf8")
    expect(disk).toContain("Three throws. Then a nap.\n\n[[Wake up->Nowhere]]")
    expect(r.text).toContain("-Three throws. Then a nap under a tree.")
    expect(r.text).toContain("+Three throws. Then a nap.")
    expect(r.text).toContain("+[[Wake up->Nowhere]]")
    expect(r.text).toMatch(/^--- a\/stories\/park_walk\.twee$/m)
    expect(r.text).toContain("New lint problems:\nerror  Fetch → Nowhere: no passage has this name")
    // The planted Splash error was there before, so it is not new.
    expect(r.text).not.toMatch(/New lint problems:[\s\S]*Splash/)
    expect(r.text).toContain("2 errors in the file now.")
  })

  it("story_add_passage appends a passage", async () => {
    const r = await call("story_add_passage", { file: STORY, name: "Splash", rawText: "@id splash\n@end\n--\nWet dog.", tags: ["ending"] })
    expect(readFileSync(join(dir, STORY), "utf8")).toMatch(/:: Splash \[ending\]\n@id splash\n@end\n--\nWet dog\.\n?$/)
    expect(r.text).toContain("+:: Splash [ending]")
    expect(r.text).toContain("0 errors in the file now.")
    await expect(call("story_add_passage", { file: STORY, name: "Splash", rawText: "x" })).rejects.toThrow(/already exists/)
  })

  it("rejects paths outside the root", async () => {
    await expect(call("story_read", { file: "../x" })).rejects.toThrow(/outside the project root/)
    await expect(call("story_write_passage", { file: "../x.twee", passageId: "a", rawText: "" })).rejects.toThrow(/outside the project root/)
    await expect(call("plan_save", { title: "t", rationale: "r", steps: [{ file: "../x", change: "c" }], recapture: [] })).rejects.toThrow(/relative to the project root/)
    await expect(call("story_read", { file: "river.json" })).rejects.toThrow(/not a story file/)
  })
})

describe("plans and the implementer guard", () => {
  const save = async (files: string[]) =>
    ((await call("plan_save", { title: "Softer surge", rationale: "Comment says the surge is too strong", steps: files.map((file) => ({ file, change: "lower surge_force" })), recapture: [] })).data as { id: string }).id

  it("implement_edit is denied while draft, allowed once approved, and only for listed files", async () => {
    const planId = await save(["data/tuning.txt"])
    expect((await loadPlan(project, planId)).status).toBe("draft")
    const edit = { planId, file: "data/tuning.txt", oldText: "leash_max = 4.0", newText: "leash_max = 3.5" }
    await expect(call("implement_edit", edit)).rejects.toThrow(/is draft, not approved/)

    await setPlanStatus(project, planId, "approved")
    const r = await call("implement_edit", edit)
    expect(readFileSync(join(dir, "data/tuning.txt"), "utf8")).toContain("leash_max = 3.5\n")
    expect(r.text).toContain("-leash_max = 4.0\n+leash_max = 3.5")

    await expect(call("implement_edit", { ...edit, file: "stories/state.json", oldText: "{", newText: "{" })).rejects.toThrow(/does not name this file/)
    await expect(call("implement_edit", { ...edit, oldText: "surge_force = 12\n", newText: "surge_force = 8\n" })).rejects.toThrow(/occurs 2 times/)
    await expect(call("implement_edit", { ...edit, oldText: "missing", newText: "x" })).rejects.toThrow(/not found/)
    // `$&` in newText is literal, not a replace pattern.
    await call("implement_edit", { ...edit, oldText: "leash_max = 3.5", newText: "leash_max = $&" })
    expect(readFileSync(join(dir, "data/tuning.txt"), "utf8")).toContain("leash_max = $&\n")

    expect((await call("plan_mark_implemented", { planId })).text).toContain("implemented")
    expect((await loadPlan(project, planId)).status).toBe("implemented")
    await expect(call("implement_edit", edit)).rejects.toThrow(/is implemented, not approved/)
  })

  it("a file listed in an approved plan but outside the editable globs is denied", async () => {
    const planId = await save(["river.json"])
    await setPlanStatus(project, planId, "approved")
    await expect(call("implement_edit", { planId, file: "river.json", oldText: "none", newText: "godot" })).rejects.toThrow(/editable globs/)
  })

  it("plan_save links a review thread and review_reply answers it", async () => {
    const thread = await addThread(project, { shotId: "leash", rev: "abc" }, "dat", "Too strong")
    const planId = ((await call("plan_save", { threadId: thread.id, title: "t", rationale: "r", steps: [{ file: "data/tuning.txt", change: "c" }], recapture: [] })).data as { id: string }).id
    await call("review_reply", { threadId: thread.id, text: `See plan ${planId}` })
    const listed = await call("review_list", { shotId: "leash" })
    expect(listed.text).toContain(`[planned]  plan ${planId}`)
    expect(listed.text).toContain(`agent (`)
    expect((await call("plan_read", { planId })).text).toContain('"status": "draft"')
  })
})

describe("frames_capture", () => {
  it("explains engine none and uses an injected adapter", async () => {
    const manifest = JSON.parse(readFileSync(join(dir, "river.json"), "utf8"))
    manifest.shots = [{ id: "gate", scene: "res://gate.tscn", count: 1 }]
    writeFileSync(join(dir, "river.json"), JSON.stringify(manifest))
    project = await loadProject(dir)
    await expect(createRiverTools(project).find((t) => t.name === "frames_capture")!.handler({ shotId: "gate" })).rejects.toThrow(/engine "none"/)

    const fake: EngineAdapter = {
      id: "fake",
      async capture(_p, _shot, outDir) {
        const f = join(outDir, "frame_00.png")
        writeFileSync(f, "png")
        return [f]
      },
    }
    const withFake = createRiverTools(project, { adapter: fake })
    const r = await withFake.find((t) => t.name === "frames_capture")!.handler({ shotId: "gate" })
    const files = (r.data as { files: string[] }).files
    expect(existsSync(files[0]!)).toBe(true)
    expect((await withFake.find((t) => t.name === "frames_list")!.handler({})).text).toContain(files[0]!)
  })
})

describe("unifiedDiff", () => {
  it("makes hunks with 3 lines of context and ignores CRLF", () => {
    const a = ["1", "2", "3", "4", "5", "6", "7", "8", "9", "10", "11", "12"].join("\n") + "\n"
    const b = a.replace("2\n", "two\n").replace("11\n", "eleven\n")
    expect(unifiedDiff(a, b, "f")).toBe(
      ["--- a/f", "+++ b/f", "@@ -1,5 +1,5 @@", " 1", "-2", "+two", " 3", " 4", " 5", "@@ -8,5 +8,5 @@", " 8", " 9", " 10", "-11", "+eleven", " 12", ""].join("\n"),
    )
    expect(unifiedDiff(a, a.replace(/\n/g, "\r\n"))).toBe("")
    expect(unifiedDiff("", "x\n", "f")).toBe("--- a/f\n+++ b/f\n@@ -0,0 +1 @@\n+x\n")
  })
})

describe("concept_write", () => {
  const CONCEPT = "k_test0001"
  const write = (input: unknown) => createRiverTools(project, { conceptId: CONCEPT }).find((t) => t.name === "concept_write")!.handler(input)
  const draw = "extends RefCounted\n\nfunc draw(img: Image) -> void:\n\timg.fill(Color(0.5, 0.6, 0.7))\n"

  it("exists only for a concept job, and --tools cannot ask for it without one", () => {
    expect(tools.some((t) => t.name === "concept_write")).toBe(false)
    const concept = createRiverTools(project, { conceptId: CONCEPT })
    expect(concept.find((t) => t.name === "concept_write")!.mutating).toBe(true)
    expect(selectTools(concept, ["story_read", "concept_write"]).map((t) => t.name)).toEqual(["story_read", "concept_write"])
    expect(() => selectTools(tools, ["story_read", "concept_write"])).toThrow(/concept_write needs --concept/)
    expect(() => createRiverTools(project, { conceptId: "../x" })).toThrow(/invalid concept id/)
  })

  it("writes draw.gd byte for byte and reports lint problems for the agent to fix", async () => {
    const ok = await write({ file: `concepts/${CONCEPT}/draw.gd`, content: draw })
    expect(ok.text).toContain("Lint: no problems")
    expect(readFileSync(join(dir, "concepts", CONCEPT, "draw.gd"), "utf8")).toBe(draw)

    const bad = await write({ file: `concepts\\${CONCEPT}\\draw.gd`, content: draw + '\tvar f = FileAccess.open("user://x", FileAccess.READ)\n' })
    expect(bad.text).toContain("does not pass the concept lint")
    expect((bad.data as { problems: string[] }).problems).toEqual([expect.stringContaining('remove "FileAccess"')])

    expect((await write({ file: `concepts/${CONCEPT}/notes.md`, content: "palette notes\n" })).text).toBe(`Wrote concepts/${CONCEPT}/notes.md.`)
  })

  it("refuses anything outside concepts/<id>/ and any second script", async () => {
    const refused = [
      "river.json",
      "stories/park_walk.twee",
      `concepts/${CONCEPT}/../../river.json`,
      `concepts/k_other000/draw.gd`,
      `concepts/${CONCEPT}`,
      join(dir, "concepts", CONCEPT, "draw.gd"),
      `/concepts/${CONCEPT}/draw.gd`,
      `concepts/${CONCEPT}/helper.gd`,
      `concepts/${CONCEPT}/draw.gd:stream`,
      `concepts/${CONCEPT}/x.gd.`,
      `concepts/${CONCEPT}/draw.gd.`,
      `concepts/${CONCEPT}/notes.md.`,
      `concepts/${CONCEPT}/.gitattributes`,
      `concepts/${CONCEPT}/.git/HEAD`,
      `concepts/${CONCEPT}/sub/.hidden`,
      `concepts/${CONCEPT}/nul`,
      `concepts/${CONCEPT}/NUL.txt`,
      `concepts/${CONCEPT}/con.png`,
      `concepts/${CONCEPT}/Aux`,
      `concepts/${CONCEPT}/prn.md`,
      `concepts/${CONCEPT}/com1`,
      `concepts/${CONCEPT}/LPT9.txt`,
    ]
    for (const file of refused) await expect(write({ file, content: draw }), file).rejects.toThrow(/cannot write/)
    expect(readFileSync(join(dir, "river.json"), "utf8")).not.toContain("extends")
    expect(existsSync(join(dir, "concepts"))).toBe(false)
  })

  it("refuses a draw.gd a person could not read as shown, and writes nothing", async () => {
    const hidden = [
      draw + "\tpass # \u001b[2K\u001b[1G\n",
      draw.replace(/\n/g, "\r\n"),
      draw + "\tpass # a\rb\n",
      draw + "\tpass # ‮ x\n",
      draw + "\t# dusk — calm\n",
    ]
    for (const content of hidden) {
      await expect(write({ file: `concepts/${CONCEPT}/draw.gd`, content }), JSON.stringify(content)).rejects.toThrow(/cannot write[\s\S]*Line \d+, column \d+/)
    }
    expect(existsSync(join(dir, "concepts"))).toBe(false)
  })
})
