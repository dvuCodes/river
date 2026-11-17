import { existsSync } from "node:fs"
import path from "node:path"
import { describe, expect, it } from "vitest"
import { buildQueryOptions, defaultMcpLaunch, mcpEntryPath, SYSTEM_PROMPTS } from "../src/index"
import type { AgentTurnRequest } from "../src/types"

const req = (over: Partial<AgentTurnRequest> = {}): AgentTurnRequest => ({
  root: "/games/park",
  mode: "plan",
  model: "claude-sonnet-5-5",
  prompt: "make the leash look tighter",
  backend: "api-key",
  apiKey: "sk-test-not-real",
  ...over,
})

const deps = () => ({
  canUseTool: async () => ({ behavior: "deny" as const, message: "no" }),
  abortController: new AbortController(),
  mcpLaunch: { command: "node", args: ["--import", "file:///tsx.mjs", "/river/packages/mcp/src/main.ts"] },
  baseEnv: { PATH: "/usr/bin" } as Record<string, string | undefined>,
})

describe("buildQueryOptions", () => {
  it("sets model, cwd, isolation and manual permissions", () => {
    const o = buildQueryOptions(req(), deps())
    expect(o.model).toBe("claude-sonnet-5-5")
    expect(o.cwd).toBe("/games/park")
    expect(o.settingSources).toEqual([])
    expect(o.strictMcpConfig).toBe(true)
    expect(o.permissionMode).toBe("default")
    expect(o.tools).toEqual(["Read", "Glob", "Grep"])
    expect(o.includePartialMessages).toBe(false)
    expect(o.resume).toBeUndefined()
  })

  it("disallows the writing, shell, web and subagent built-ins", () => {
    const o = buildQueryOptions(req(), deps())
    for (const t of ["Bash", "Write", "Edit", "MultiEdit", "NotebookEdit", "WebFetch", "WebSearch", "Agent", "Task"]) {
      expect(o.disallowedTools).toContain(t)
    }
    for (const t of ["Read", "Glob", "Grep"]) expect(o.disallowedTools).not.toContain(t)
  })

  it("auto-allows only read tools and plan_save, per mode", () => {
    const plan = buildQueryOptions(req({ mode: "plan" }), deps()).allowedTools!
    expect(plan).toContain("mcp__river__story_read")
    expect(plan).toContain("mcp__river__plan_save")
    expect(plan).not.toContain("mcp__river__review_reply")
    expect(plan.every((t) => t.startsWith("mcp__river__"))).toBe(true)

    const story = buildQueryOptions(req({ mode: "story" }), deps()).allowedTools!
    expect(story).not.toContain("mcp__river__plan_save")
    expect(story).not.toContain("mcp__river__story_write_passage")
    expect(story).toHaveLength(10)

    const impl = buildQueryOptions(req({ mode: "implement", planId: "p_1" }), deps()).allowedTools!
    expect(impl).not.toContain("mcp__river__implement_edit")
    expect(impl).not.toContain("mcp__river__frames_capture")
  })

  it("starts the river MCP server with root and the mode's tools", () => {
    const o = buildQueryOptions(req({ mode: "story" }), deps())
    const river = o.mcpServers!.river as { command: string; args: string[]; env: Record<string, string> }
    expect(river.command).toBe("node")
    expect(river.args.slice(0, 3)).toEqual(["--import", "file:///tsx.mjs", "/river/packages/mcp/src/main.ts"])
    expect(river.args[river.args.indexOf("--root") + 1]).toBe("/games/park")
    const tools = river.args[river.args.indexOf("--tools") + 1]!.split(",")
    expect(tools).toContain("story_write_passage")
    expect(tools).not.toContain("plan_save")
    expect(river.env.ANTHROPIC_API_KEY).toBe("")
  })

  it("puts the key in the child env without touching process.env", () => {
    const before = process.env.ANTHROPIC_API_KEY
    const base = { PATH: "/usr/bin" }
    const o = buildQueryOptions(req(), { ...deps(), baseEnv: base })
    expect(o.env!.ANTHROPIC_API_KEY).toBe("sk-test-not-real")
    expect(o.env!.PATH).toBe("/usr/bin")
    expect(base).toEqual({ PATH: "/usr/bin" })
    expect(process.env.ANTHROPIC_API_KEY).toBe(before)

    const { baseEnv: _drop, ...noBase } = deps()
    const fromProcess = buildQueryOptions(req(), noBase)
    expect(fromProcess.env!.ANTHROPIC_API_KEY).toBe("sk-test-not-real")
    expect(process.env.ANTHROPIC_API_KEY).toBe(before)
  })

  it("appends the mode prompt to the claude_code preset, fresh on resume", () => {
    const o = buildQueryOptions(req({ mode: "implement", sessionId: "abc" }), deps())
    expect(o.systemPrompt).toMatchObject({ type: "preset", preset: "claude_code", append: SYSTEM_PROMPTS.implement, snapshot: false })
    expect(o.resume).toBe("abc")
    expect(SYSTEM_PROMPTS.plan).toContain("You cannot change game files")
    expect(SYSTEM_PROMPTS.implement).toContain("plan_mark_implemented")
    expect(SYSTEM_PROMPTS.story).toContain("@when")
  })

  it("resolves the default MCP launch to this Node, a tsx file URL and the mcp entry", () => {
    const launch = defaultMcpLaunch()
    expect(launch.command).toBe(process.execPath)
    expect(launch.args[0]).toBe("--import")
    expect(launch.args[1]).toMatch(/^file:\/\/.*tsx/)
    expect(launch.args[2]).toBe(mcpEntryPath())
    expect(path.isAbsolute(mcpEntryPath())).toBe(true)
    expect(existsSync(path.dirname(mcpEntryPath()))).toBe(true)
    expect(mcpEntryPath().replace(/\\/g, "/")).toMatch(/packages\/mcp\/src\/main\.ts$/)
  })
})
