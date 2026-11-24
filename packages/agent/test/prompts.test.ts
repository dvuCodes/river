import { describe, expect, it } from "vitest"
import { parseTwee3 } from "@river/core"
import { buildClaudeCodeArgs, buildQueryOptions, BRIEF_MAX, preAllowedTools, SYSTEM_PROMPTS, systemPrompt, turnContext, VOICE_MAX } from "../src/index"
import { AUTO_ALLOWED_WRITES, MODE_TOOLS, READ_TOOLS, WRITE_TOOLS, type AgentTurnRequest } from "../src/types"

const req = (over: Partial<AgentTurnRequest> = {}): AgentTurnRequest => ({
  root: "/games/park",
  mode: "story",
  model: "claude-sonnet-5-5",
  prompt: "make the pond funnier",
  backend: "api-key",
  apiKey: "sk-test-not-real",
  ...over,
})

describe("prompts", () => {
  it("documents the v2 story syntax in every story-writing mode", () => {
    for (const mode of ["story", "writer", "plan", "implement"] as const) {
      const p = SYSTEM_PROMPTS[mode]
      for (const word of ["@id", "@when", "visited(", "visits(", "@set", "@cost", "@hint", "@end", "@once", "@meta", "@shot", "@cue", "[interrupt]", "@return", "{when", "{var}", "{once:", "{cycle:", "{shuffle:", "Speaker [mood]:", 'Speaker: "line"', '"..."']) {
        expect(p, `${mode}: ${word}`).toContain(word)
      }
    }
    expect(SYSTEM_PROMPTS.concept).not.toContain("@shot")
  })

  it("documents storylets and @auto interrupts in every story-writing mode", () => {
    for (const mode of ["story", "writer", "plan", "implement"] as const) {
      const p = SYSTEM_PROMPTS[mode]
      for (const word of ["[storylet]", "@weight <n>", "default 1", "@priority <int>", "@cooldown <int>", "@auto", "[interrupt]", "highest @priority first", "story_simulate"]) {
        expect(p, `${mode}: ${word}`).toContain(word)
      }
    }
    expect(SYSTEM_PROMPTS.concept).not.toContain("@auto")
    for (const mode of ["story", "plan", "implement", "concept", "writer"] as const) expect(MODE_TOOLS[mode]).toContain("story_simulate")
  })

  it("shows an example passage that River itself parses cleanly", () => {
    const lines = SYSTEM_PROMPTS.story.split("\n")
    const from = lines.indexOf("  :: Pond [encounter]")
    const to = lines.indexOf("", from)
    expect(from).toBeGreaterThan(0)
    const example = lines.slice(from, to).map((l) => l.slice(2)).join("\n")
    const { story, diagnostics } = parseTwee3(`${example}\n`, "example.twee")
    expect(diagnostics.filter((d) => d.severity !== "info")).toEqual([])
    const [pond] = story.passages
    expect(pond).toMatchObject({ id: "pond", shot: "pond_wide" })
    expect(pond!.choices).toHaveLength(3)
    expect(pond!.choices[0]!.hint).toBe("Costs one treat")
    // The template's escape is shown as the writer types it.
    expect(SYSTEM_PROMPTS.story).toContain("write \\| \\{ \\} for literal characters")
  })

  it("gives story mode a craft guide with the voice bible, the outline tools and the table read", () => {
    const p = SYSTEM_PROMPTS.story
    for (const word of ["voice_read", "brief_read", "story_outline", "story_read_passage", "story_search", "story_batch_edit", "story_lint", "story_sample_transcripts", "copyBudgets", "a testament to", "unused-state-var", "copy-budget-exceeded", "duplicate-copy", "{when ...}"]) {
      expect(p).toContain(word)
    }
  })

  it("gives writer mode the take contract and the closing note rules", () => {
    const p = SYSTEM_PROMPTS.writer
    for (const word of ["writing_write", '"a", "b", "c"', "caption", "summary", "storyFile", '"op":"write"', '"op":"add"', '"op":"rename"', '"op":"delete"', "synonym", "under 90 words", "voice_read"]) {
      expect(p).toContain(word)
    }
  })

  it("injects the brief and the voice bible, each capped with a pointer to its tool", () => {
    const both = systemPrompt({ mode: "writer", brief: "Warm light.", voice: "# Voice\nShort lines. Rex never speaks." })
    expect(both.startsWith(SYSTEM_PROMPTS.writer)).toBe(true)
    expect(both).toContain("The project brief (.river/brief.md), written by the user:\nWarm light.")
    expect(both).toContain("The voice bible (.river/voice.md)")
    expect(both).toContain("Short lines. Rex never speaks.")
    expect(both.indexOf("Warm light.")).toBeLessThan(both.indexOf("Short lines."))
    expect(systemPrompt({ mode: "story", voice: "  " })).toBe(SYSTEM_PROMPTS.story)
    expect(systemPrompt({ mode: "story", voice: "Dry." })).toContain("Dry.")

    const long = systemPrompt({ mode: "story", voice: "v".repeat(VOICE_MAX + 50) })
    expect(long).toContain("v".repeat(VOICE_MAX) + "\n[... the rest is in .river/voice.md; read it with voice_read]")
    expect(long).not.toContain("v".repeat(VOICE_MAX + 1))
  })

  it("names the writing job in the turn context", () => {
    expect(turnContext(req({ mode: "writer", writingId: "j_w1" }))).toContain("Writing job: j_w1")
    expect(turnContext(req())).toBe("")
  })

  it("keeps the claude-code command line under the Windows limit with the brief and voice at their caps", () => {
    for (const mode of ["story", "writer"] as const) {
      const r = req({ mode, writingId: "j_w1", brief: "b".repeat(BRIEF_MAX + 100), voice: "v".repeat(VOICE_MAX + 100), backend: "claude-code" })
      const args = buildClaudeCodeArgs(r, {
        root: "C:/games/park",
        approvalPipe: "\\\\.\\pipe\\river-approval-1234567890",
        mcpLaunch: { command: "C:/node/node.exe", args: ["--import", "file:///C:/river/node_modules/tsx/dist/loader.mjs", "C:/river/packages/mcp/src/main.ts"] },
      })
      expect(args.join(" ").length).toBeLessThan(30_000)
      expect(args).toContain("--include-partial-messages")
    }
  })
})

describe("writer mode tools", () => {
  it("lists the new read and write tools and gives each mode its set", () => {
    for (const t of ["voice_read", "story_outline", "story_read_passage", "story_search", "story_sample_transcripts", "story_pacing", "story_simulate", "card_view"]) expect(READ_TOOLS).toContain(t)
    for (const t of ["story_rename_passage", "story_delete_passage", "story_batch_edit", "voice_note", "writing_request", "writing_write", "concept_request"]) expect(WRITE_TOOLS).toContain(t)
    expect(MODE_TOOLS.story).toEqual([...READ_TOOLS, "story_write_passage", "story_add_passage", "story_rename_passage", "story_delete_passage", "story_batch_edit", "voice_note"])
    expect(MODE_TOOLS.plan).toEqual([...READ_TOOLS, "review_reply", "plan_save"])
    expect(MODE_TOOLS.implement).toEqual([...READ_TOOLS, "implement_edit", "frames_capture", "plan_mark_implemented", "review_reply"])
    expect(MODE_TOOLS.concept).toEqual([...READ_TOOLS, "concept_write"])
    expect(MODE_TOOLS.writer).toEqual([...READ_TOOLS, "writing_write"])
    expect(AUTO_ALLOWED_WRITES).toEqual(["plan_save", "concept_write", "writing_write"])
    for (const mode of Object.keys(MODE_TOOLS) as (keyof typeof MODE_TOOLS)[]) expect(MODE_TOOLS[mode]).not.toContain("writing_request")
  })

  it("pre-allows writing_write in writer mode only, and starts river-mcp with --writing", () => {
    expect(preAllowedTools("writer")).toContain("mcp__river__writing_write")
    expect(preAllowedTools("story")).not.toContain("mcp__river__writing_write")
    expect(preAllowedTools("story")).not.toContain("mcp__river__story_batch_edit")
    const deps = { canUseTool: async () => ({ behavior: "deny" as const, message: "no" }), abortController: new AbortController(), mcpLaunch: { command: "node", args: ["mcp.js"] } }
    const args = (r: AgentTurnRequest) => (buildQueryOptions(r, deps).mcpServers!.river as { args: string[] }).args
    const writer = args(req({ mode: "writer", writingId: "j_w1" }))
    expect(writer.slice(writer.indexOf("--writing"), writer.indexOf("--writing") + 2)).toEqual(["--writing", "j_w1"])
    expect(writer[writer.indexOf("--tools") + 1]!.split(",")).toContain("writing_write")
    expect(args(req({ mode: "story", writingId: "j_w1" }))).not.toContain("--writing")
    const o = buildQueryOptions(req({ mode: "writer", writingId: "j_w1", voice: "Short lines." }), deps)
    expect((o.systemPrompt as { append: string }).append).toContain("Short lines.")
  })
})
