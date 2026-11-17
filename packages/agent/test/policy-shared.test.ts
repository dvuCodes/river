import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { loadProject, type Project } from "@river/core"
import { createCanUseTool, decideToolCall, type PolicyContext } from "../src/policy"
import type { PermissionDecision, PermissionRequest } from "../src/types"
import { removeDir, tempGame } from "./helpers"

let root: string
let project: Project
beforeEach(async () => {
  root = tempGame()
  project = await loadProject(root)
})
afterEach(() => removeDir(root))

describe("one policy, two entry points", () => {
  const opts = (id: string) => ({ signal: new AbortController().signal, toolUseID: id, requestId: "r1" }) as never

  function ctx(mode: PolicyContext["mode"], decision: PermissionDecision = { behavior: "allow" }) {
    const seen: PermissionRequest[] = []
    const c: PolicyContext = {
      mode,
      project,
      onPermission: async (r) => {
        seen.push(r)
        return decision
      },
    }
    return { c, seen }
  }

  const cases: { mode: PolicyContext["mode"]; tool: string; input: Record<string, unknown>; expect: "allow" | "deny"; asks: boolean }[] = [
    { mode: "plan", tool: "mcp__river__story_lint", input: { file: "x" }, expect: "allow", asks: false },
    { mode: "plan", tool: "mcp__river__plan_save", input: { title: "t" }, expect: "allow", asks: false },
    { mode: "plan", tool: "mcp__river__story_write_passage", input: {}, expect: "deny", asks: false },
    { mode: "plan", tool: "Bash", input: { command: "ls" }, expect: "deny", asks: false },
    { mode: "plan", tool: "mcp__river__approval_prompt", input: { tool_name: "Bash", input: {} }, expect: "deny", asks: false },
    { mode: "plan", tool: "Read", input: { file_path: "stories/park_walk.twee" }, expect: "allow", asks: false },
    { mode: "plan", tool: "Read", input: { file_path: "../../etc/passwd" }, expect: "deny", asks: false },
    { mode: "plan", tool: "Glob", input: { pattern: "C:/Users/**" }, expect: "deny", asks: false },
    { mode: "implement", tool: "mcp__river__implement_edit", input: { file: "stories/state.json" }, expect: "deny", asks: false },
    {
      mode: "story",
      tool: "mcp__river__story_write_passage",
      input: { file: "stories/park_walk.twee", passageId: "gate", rawText: "The park gate swings open." },
      expect: "allow",
      asks: true,
    },
  ]

  for (const k of cases) {
    it(`${k.mode} ${k.tool} -> ${k.expect}`, async () => {
      const a = ctx(k.mode)
      const b = ctx(k.mode)
      const viaSdk = await createCanUseTool(a.c)(k.tool, k.input, opts("toolu_x"))
      const viaPipe = await decideToolCall(b.c, k.tool, k.input, { toolUseId: "toolu_x" })
      expect(viaSdk.behavior).toBe(k.expect)
      expect(viaPipe).toEqual(viaSdk)
      expect(a.seen.length > 0).toBe(k.asks)
      expect(b.seen).toEqual(a.seen)
    })
  }

  it("builds the same PermissionRequest, diff included, and passes a denial through", async () => {
    const input = { file: "stories/park_walk.twee", passageId: "gate", rawText: "@id gate\n--\nThe park gate swings open." }
    const a = ctx("story", { behavior: "deny", message: "nope" })
    const b = ctx("story", { behavior: "deny", message: "nope" })
    const viaSdk = await createCanUseTool(a.c)("mcp__river__story_write_passage", input, opts("toolu_d"))
    const viaPipe = await decideToolCall(b.c, "mcp__river__story_write_passage", input, { toolUseId: "toolu_d" })
    expect(viaSdk).toEqual({ behavior: "deny", message: "nope" })
    expect(viaPipe).toEqual(viaSdk)
    expect(a.seen[0]!.diff).toBeTruthy()
    expect(b.seen).toEqual(a.seen)
    // Without a tool_use id the pipe path still gets a unique request id.
    const c = ctx("story")
    await decideToolCall(c.c, "mcp__river__story_write_passage", input)
    await decideToolCall(c.c, "mcp__river__story_write_passage", input)
    expect(c.seen[0]!.id).not.toBe(c.seen[1]!.id)
  })
})
