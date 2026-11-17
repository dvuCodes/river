import { readFileSync } from "node:fs"
import path from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { loadProject, type ChangePlan, type Project } from "@river/core"
import { createCanUseTool } from "../src/policy"
import type { PermissionDecision, PermissionRequest } from "../src/types"
import { removeDir, tempGame } from "./helpers"

let root: string
let project: Project
beforeEach(async () => {
  root = tempGame()
  project = await loadProject(root)
  project.manifest.editable = ["data/**", "tools/shots/**", "stories/**"] // this test edits a story file
})
afterEach(() => removeDir(root))

const opts = (id = "toolu_1") => ({ signal: new AbortController().signal, toolUseID: id, requestId: "r1" }) as never

const plan = (over: Partial<ChangePlan> = {}): ChangePlan => ({
  id: "p_test",
  title: "t",
  rationale: "r",
  steps: [{ file: "stories/state.json", change: "raise max" }],
  recapture: [],
  status: "approved",
  createdAt: new Date().toISOString(),
  ...over,
})

function recorder(decision: PermissionDecision = { behavior: "allow" }) {
  const seen: PermissionRequest[] = []
  const onPermission = async (r: PermissionRequest): Promise<PermissionDecision> => {
    seen.push(r)
    return decision
  }
  return { seen, onPermission }
}

describe("canUseTool policy", () => {
  it("allows read tools without asking and denies unknown tools", async () => {
    const onPermission = vi.fn()
    const can = createCanUseTool({ mode: "plan", project, onPermission })
    expect((await can("mcp__river__story_read", { file: "x" }, opts())).behavior).toBe("allow")
    expect((await can("mcp__river__plan_save", { title: "x" }, opts())).behavior).toBe("allow")
    expect((await can("Bash", { command: "ls" }, opts())).behavior).toBe("deny")
    expect((await can("Write", { file_path: "a", content: "b" }, opts())).behavior).toBe("deny")
    expect((await can("mcp__other__thing", {}, opts())).behavior).toBe("deny")
    expect((await can("mcp__river__nope", {}, opts())).behavior).toBe("deny")
    expect(onPermission).not.toHaveBeenCalled()
  })

  it("allows Read/Glob/Grep inside the root only", async () => {
    const can = createCanUseTool({ mode: "plan", project, onPermission: vi.fn() })
    expect((await can("Read", { file_path: path.join(root, "river.json") }, opts())).behavior).toBe("allow")
    expect((await can("Read", { file_path: "stories/park_walk.twee" }, opts())).behavior).toBe("allow")
    expect((await can("Grep", { pattern: "x" }, opts())).behavior).toBe("allow")
    expect((await can("Read", { file_path: path.join(root, "..", "secret.txt") }, opts())).behavior).toBe("deny")
    expect((await can("Glob", { pattern: "*", path: path.parse(root).root }, opts())).behavior).toBe("deny")
    // Pathless searches cannot escape through the glob.
    expect((await can("Glob", { pattern: "stories/**/*.twee" }, opts())).behavior).toBe("allow")
    expect((await can("Glob", { pattern: "C:/Users/**/id_rsa" }, opts())).behavior).toBe("deny")
    expect((await can("Glob", { pattern: "/etc/*" }, opts())).behavior).toBe("deny")
    expect((await can("Glob", { pattern: "../**/*.json" }, opts())).behavior).toBe("deny")
    expect((await can("Grep", { pattern: "\\.\\./x", glob: "*.ts" }, opts())).behavior).toBe("allow")
    expect((await can("Grep", { pattern: "x", glob: "../../**" }, opts())).behavior).toBe("deny")
    const blocked = { ...(opts() as object), blockedPath: path.join(root, "..", "x") } as never
    expect((await can("Grep", { pattern: "x" }, blocked)).behavior).toBe("deny")
  })

  it("denies tools from another mode", async () => {
    const onPermission = vi.fn()
    const can = createCanUseTool({ mode: "plan", project, onPermission })
    expect((await can("mcp__river__implement_edit", { file: "stories/state.json" }, opts())).behavior).toBe("deny")
    expect((await can("mcp__river__story_write_passage", {}, opts())).behavior).toBe("deny")
    expect(onPermission).not.toHaveBeenCalled()
  })

  it("lets concept_write through only for the turn's own concept folder, without asking", async () => {
    const onPermission = vi.fn()
    const can = createCanUseTool({ mode: "concept", project, conceptId: "k_policy01", onPermission })
    expect((await can("mcp__river__concept_write", { file: "concepts/k_policy01/draw.gd", content: "x" }, opts())).behavior).toBe("allow")
    for (const file of ["concepts/k_other000/draw.gd", "concepts/k_policy01/../../river.json", "stories/park_walk.twee", "concepts/k_policy01/extra.gd"]) {
      expect((await can("mcp__river__concept_write", { file, content: "x" }, opts())).behavior, file).toBe("deny")
    }
    expect((await can("mcp__river__concept_write", { content: "x" }, opts())).behavior).toBe("deny")
    const noJob = createCanUseTool({ mode: "concept", project, onPermission })
    expect((await noJob("mcp__river__concept_write", { file: "concepts/k_policy01/draw.gd", content: "x" }, opts())).behavior).toBe("deny")
    const story = createCanUseTool({ mode: "story", project, conceptId: "k_policy01", onPermission })
    expect((await story("mcp__river__concept_write", { file: "concepts/k_policy01/draw.gd", content: "x" }, opts())).behavior).toBe("deny")
    expect((await can("mcp__river__story_write_passage", {}, opts())).behavior).toBe("deny")
    expect(onPermission).not.toHaveBeenCalled()
  })

  it("asks for a story write, with a diff of the passage change", async () => {
    const { seen, onPermission } = recorder()
    const can = createCanUseTool({ mode: "story", project, onPermission })
    const input = {
      file: "stories/park_walk.twee",
      passageId: "long_path",
      rawText: "@id long_path\n--\nTrees and shade.\n\n[[Head home->Home happy]]",
    }
    const r = await can("mcp__river__story_write_passage", input, opts("toolu_9"))
    expect(r).toEqual({ behavior: "allow", updatedInput: input })
    expect(seen).toHaveLength(1)
    expect(seen[0]).toMatchObject({ id: "toolu_9", tool: "story_write_passage", input })
    expect(seen[0]!.summary).toContain("long_path")
    expect(seen[0]!.diff).toContain("-Trees, shade and one interesting stick.")
    expect(seen[0]!.diff).toContain("+Trees and shade.")
    expect(seen[0]!.diff).toContain("-[[Pick up the stick->Fetch]]")
    // Asking never writes.
    expect(readFileSync(path.join(root, "stories/park_walk.twee"), "utf8")).toContain("interesting stick")
  })

  it("shows the appended passage for story_add_passage", async () => {
    const { seen, onPermission } = recorder()
    const can = createCanUseTool({ mode: "story", project, onPermission })
    await can("mcp__river__story_add_passage", { file: "stories/park_walk.twee", name: "Bench", rawText: "@id bench\n--\nA quiet bench.", tags: ["rest"] }, opts())
    expect(seen[0]!.summary).toBe("Add passage Bench to stories/park_walk.twee")
    expect(seen[0]!.diff).toContain("+:: Bench [rest]")
    expect(seen[0]!.diff).toContain("+A quiet bench.")
    // The new passage is appended at the end of the file.
    expect(seen[0]!.diff!.trimEnd().endsWith("+A quiet bench.")).toBe(true)
  })

  it("denies implement_edit for a plan other than the turn's", async () => {
    const onPermission = vi.fn()
    const can = createCanUseTool({ mode: "implement", project, plan: plan(), onPermission })
    const r = await can("mcp__river__implement_edit", { planId: "p_other", file: "stories/state.json", oldText: "a", newText: "b" }, opts())
    expect(r).toMatchObject({ behavior: "deny", message: expect.stringContaining("p_test") })
    expect(onPermission).not.toHaveBeenCalled()
  })

  it("passes the user's denial back to the model", async () => {
    const { onPermission } = recorder({ behavior: "deny", message: "too long" })
    const can = createCanUseTool({ mode: "story", project, onPermission })
    expect(await can("mcp__river__story_add_passage", { name: "New" }, opts())).toEqual({ behavior: "deny", message: "too long" })
  })

  it("asks for implement_edit with a diff only when the plan allows the file", async () => {
    const { seen, onPermission } = recorder()
    const can = createCanUseTool({ mode: "implement", project, plan: plan(), onPermission })
    const before = readFileSync(path.join(root, "stories/state.json"), "utf8")
    const line = before.split(/\r?\n/).find((l) => l.trim().length > 2)!
    const r = await can("mcp__river__implement_edit", { planId: "p_test", file: "stories/state.json", oldText: line, newText: line + " " }, opts())
    expect(r.behavior).toBe("allow")
    expect(seen[0]!.diff).toContain("-" + line)
    expect(seen[0]!.diff).toContain("+" + line + " ")

    const denied = await can("mcp__river__implement_edit", { planId: "p_test", file: "stories/park_walk.twee", oldText: "x", newText: "y" }, opts())
    expect(denied).toMatchObject({ behavior: "deny", message: expect.stringMatching(/does not name this file/) })
    expect(seen).toHaveLength(1)
  })

  it("refuses implement_edit without an approved plan", async () => {
    const onPermission = vi.fn()
    const noPlan = createCanUseTool({ mode: "implement", project, onPermission })
    expect((await noPlan("mcp__river__implement_edit", { file: "stories/state.json", content: "{}" }, opts())).behavior).toBe("deny")
    const draft = createCanUseTool({ mode: "implement", project, plan: plan({ status: "draft" }), onPermission })
    const r = await draft("mcp__river__implement_edit", { file: "stories/state.json", content: "{}" }, opts())
    expect(r).toMatchObject({ behavior: "deny", message: expect.stringMatching(/not approved/) })
    expect(onPermission).not.toHaveBeenCalled()
  })

  it("still asks, without a diff, when the input points outside the root", async () => {
    const { seen, onPermission } = recorder()
    const can = createCanUseTool({ mode: "story", project, onPermission })
    await can("mcp__river__story_write_passage", { file: "../../etc/passwd", passageId: "x", rawText: "y" }, opts())
    expect(seen).toHaveLength(1)
    expect(seen[0]!.diff).toBeUndefined()
  })
})
