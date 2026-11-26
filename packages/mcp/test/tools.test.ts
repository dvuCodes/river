import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { beforeEach, describe, expect, it } from "vitest"
import { addThread, loadPlan, loadProject, setPlanStatus } from "@river/core"
import type { EngineAdapter, Project } from "@river/core"
import { createRiverTools, RIVER_TOOL_NAMES, selectTools, unifiedDiff } from "../src/index"
import type { RiverTool } from "../src/index"
import { tempProject } from "./helpers"

const STORY = "stories/park_walk.twee"

export const EXPECTED_TOOLS = [
  "project_info", "story_list", "story_read", "story_lint", "story_paths", "playtest_run",
  "frames_list", "review_list", "plan_list", "plan_read", "board_read", "marks_open", "brief_read",
  "card_read", "mark_read", "card_view",
  "story_write_passage", "story_add_passage", "review_reply", "plan_save",
  "implement_edit", "plan_mark_implemented", "frames_capture",
  "mark_claim", "mark_reply", "board_add_note", "board_add_card", "board_connect", "board_place_row",
  "board_update_note", "board_remove_card", "concept_request",
  "story_outline", "story_read_passage", "story_search", "story_pacing", "story_sample_transcripts", "story_simulate", "voice_read",
  "story_rename_passage", "story_delete_passage", "story_batch_edit", "voice_note", "writing_request",
]

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
  it("has the 44 contract names, with the write tools marked mutating", () => {
    expect([...tools.map((t) => t.name)].sort()).toEqual([...EXPECTED_TOOLS].sort())
    expect(tools).toHaveLength(44)
    expect([...RIVER_TOOL_NAMES].sort()).toEqual([...EXPECTED_TOOLS, "concept_write", "writing_write"].sort())
    expect(tools.filter((t) => t.mutating).map((t) => t.name).sort()).toEqual(
      ["story_write_passage", "story_add_passage", "review_reply", "plan_save", "implement_edit", "plan_mark_implemented", "frames_capture", "mark_claim", "mark_reply", "board_add_note", "board_add_card", "board_connect", "board_place_row", "board_update_note", "board_remove_card", "concept_request", "story_rename_passage", "story_delete_passage", "story_batch_edit", "voice_note", "writing_request"].sort(),
    )
  })

  it("a concept job's server has concept_write and no concept_request, so a job never starts another", () => {
    const names = createRiverTools(project, { conceptId: "j_abc" }).map((t) => t.name)
    expect(names).toContain("concept_write")
    expect(names).not.toContain("concept_request")
    expect(() => selectTools(createRiverTools(project, { conceptId: "j_abc" }), ["concept_request"])).toThrow(/a --concept server has no concept_request/)
  })

  it("refuses to write as the user or as River's own job role, per server and per review reply", async () => {
    expect(() => createRiverTools(project, { author: "concept-artist" })).toThrow(/River's own role/)
    expect(() => createRiverTools(project, { author: " You " })).toThrow(/is the user/)
    await expect(call("review_reply", { threadId: "t_x", text: "hi", author: "you" })).rejects.toThrow(/is the user/)
    await expect(call("review_reply", { threadId: "t_x", text: "hi", author: "Concept-Artist" })).rejects.toThrow(/River's own role/)
  })
})

describe("read tools", () => {
  it("project_info and story_list", async () => {
    const info = (await call("project_info")).text
    expect(info).toContain(`story files: ${STORY}`)
    expect(info).toContain("state variables (stories/state.json):\n  energy: number 0..100, initial 80\n")
    expect(info).toContain("  treats: int 0..10, initial 2")
    expect((await call("story_list")).text).toContain(`${STORY}  "Park Walk"  9 passages, start: Gate`)
  })

  it("story_read returns the raw text and the passages", async () => {
    const r = await call("story_read", { file: STORY })
    expect(r.text).toContain(readFileSync(join(dir, STORY), "utf8"))
    expect(r.text).toContain("- Pond (id pond) [encounter]")
    expect(r.text).toContain("    1: Throw a treat -> Treat")
    expect(r.text).toContain("State variables (stories/state.json):\n  energy: number 0..100, initial 80\n")
    const data = r.data as { passages: { id: string; choices: { target: string }[] }[] }
    expect(data.passages.find((p) => p.id === "pond")!.choices.map((c) => c.target)).toEqual(["Calm down", "Treat", "Splash"])
  })

  it("story_lint reports the planted problems", async () => {
    const r = await call("story_lint", { file: STORY })
    expect(r.text).toContain("error  Pond → Splash: no passage has this name")
    expect(r.text).toContain("1 error, 3 warnings in 9 passages")
    expect((await call("story_lint")).text).toContain("1 error, 3 warnings in 9 passages")
    expect(r.text).toContain(
      "warn   Long path → Fetch: the choice can show while Fetch's @when energy >= 20 is false. Give the choice @when energy >= 20, or loosen Fetch's @when.",
    )
  })

  it("story_lint resolves cross-story links in multi-file workspaces and reports broken-cross-link", async () => {
    const wsDir = mkdtempSync(join(tmpdir(), "river-mcp-ws-"))
    mkdirSync(join(wsDir, "stories"), { recursive: true })
    writeFileSync(
      join(wsDir, "river.json"),
      JSON.stringify({ name: "WsTest", engine: "none", stories: "stories", state: "state.json", export: "data" }),
    )
    writeFileSync(join(wsDir, "state.json"), JSON.stringify({ energy: { type: "int", min: 0, max: 100, initial: 50 } }))
    writeFileSync(
      join(wsDir, "stories", "ch1.twee"),
      `:: StoryTitle\nCh1\n\n:: StoryData\n{"ifid":"11111111-1111-4111-8111-111111111111","start":"Intro"}\n\n:: Intro\nHello.\n[[Go->ch2::End]]\n`,
    )
    writeFileSync(
      join(wsDir, "stories", "ch2.twee"),
      `:: StoryTitle\nCh2\n\n:: StoryData\n{"ifid":"22222222-2222-4222-8222-222222222222","start":"End"}\n\n:: End\n@end\n--\nDone.\n`,
    )
    const wsProject = await loadProject(wsDir)
    const wsLint = createRiverTools(wsProject).find((t) => t.name === "story_lint")!

    const okAll = await wsLint.handler({ narrative: false })
    expect(okAll.text).toContain("0 errors, 0 warnings in 2 passages")
    const okSingle = await wsLint.handler({ file: "stories/ch1.twee", narrative: false })
    expect(okSingle.text).toContain("0 errors, 0 warnings in 1 passage")

    // Invalid cross-story link reports broken-cross-link
    writeFileSync(
      join(wsDir, "stories", "ch1.twee"),
      `:: StoryTitle\nCh1\n\n:: StoryData\n{"ifid":"11111111-1111-4111-8111-111111111111","start":"Intro"}\n\n:: Intro\nHello.\n[[Go->ch2::Missing]]\n`,
    )
    const bad = await wsLint.handler({ file: "stories/ch1.twee", narrative: false })
    expect(bad.text).toContain('no passage "Missing" in story "ch2"')
    const filesData = (bad.data as { files: { diagnostics: { code: string }[] }[] }).files
    expect(filesData[0]!.diagnostics.some((d) => d.code === "broken-cross-link")).toBe(true)
  })

  it("story_paths formats routes like the CLI", async () => {
    const r = await call("story_paths", { file: STORY })
    expect(r.text).toContain("2  Gate [Go to the pond] → Pond [Throw a treat] → Treat [Head home] → Home happy   when treats >= 1")
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

  it("story_write_passage keeps one blank line before the next passage, and suggests ids for a wrong one", async () => {
    const r = await call("story_write_passage", { file: STORY, passageId: "fetch", rawText: "@id fetch\n--\nThe dog drops the stick.\n\n[[Head home->Home happy]]\n\n" })
    expect(readFileSync(join(dir, STORY), "utf8")).toContain("[[Head home->Home happy]]\n\n:: Home happy [ending]")
    expect(r.text).toContain("+[[Head home->Home happy]]\n \n :: Home happy")
    await expect(call("story_write_passage", { file: STORY, passageId: "Fetch", rawText: "x" })).rejects.toThrow('no passage with id "Fetch". Did you mean "fetch" (passage Fetch)?')
    await expect(call("story_write_passage", { file: STORY, passageId: "Long path", rawText: "x" })).rejects.toThrow('Did you mean "long_path" (passage Long path)')
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
    ((await call("plan_save", { title: "Shorter throw", rationale: "Comment says the ball goes too far", steps: files.map((file) => ({ file, change: "lower ball_throw" })), recapture: [] })).data as { id: string }).id

  it("implement_edit is denied while draft, allowed once approved, and only for listed files", async () => {
    const planId = await save(["data/tuning.txt"])
    expect((await loadPlan(project, planId)).status).toBe("draft")
    const edit = { planId, file: "data/tuning.txt", oldText: "walk_speed = 4.0", newText: "walk_speed = 3.5" }
    await expect(call("implement_edit", edit)).rejects.toThrow(/is draft, not approved/)

    await setPlanStatus(project, planId, "approved")
    const r = await call("implement_edit", edit)
    expect(readFileSync(join(dir, "data/tuning.txt"), "utf8")).toContain("walk_speed = 3.5\n")
    expect(r.text).toContain("-walk_speed = 4.0\n+walk_speed = 3.5")

    await expect(call("implement_edit", { ...edit, file: "stories/state.json", oldText: "{", newText: "{" })).rejects.toThrow(/does not name this file/)
    await expect(call("implement_edit", { ...edit, oldText: "ball_throw = 12\n", newText: "ball_throw = 8\n" })).rejects.toThrow(/occurs 2 times/)
    await expect(call("implement_edit", { ...edit, oldText: "missing", newText: "x" })).rejects.toThrow(/not found/)
    // `$&` in newText is literal, not a replace pattern.
    await call("implement_edit", { ...edit, oldText: "walk_speed = 3.5", newText: "walk_speed = $&" })
    expect(readFileSync(join(dir, "data/tuning.txt"), "utf8")).toContain("walk_speed = $&\n")

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
    const thread = await addThread(project, { shotId: "walk", rev: "abc" }, "you", "Throws too far")
    const planId = ((await call("plan_save", { threadId: thread.id, title: "t", rationale: "r", steps: [{ file: "data/tuning.txt", change: "c" }], recapture: [] })).data as { id: string }).id
    await call("review_reply", { threadId: thread.id, text: `See plan ${planId}` })
    const listed = await call("review_list", { shotId: "walk" })
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
