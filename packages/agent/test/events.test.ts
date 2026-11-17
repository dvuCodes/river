import { describe, expect, it } from "vitest"
import { MessageMapper } from "../src/events"
import type { AgentEvent } from "../src/types"

function run(messages: unknown[], extra: { checkpointRef?: string } = {}): AgentEvent[] {
  const events: AgentEvent[] = []
  const m = new MessageMapper((e) => events.push(e), extra)
  for (const msg of messages) m.handle(msg)
  return events
}

const init = { type: "system", subtype: "init", session_id: "sess-1", tools: [], mcp_servers: [] }
const assistant = (content: unknown[], extra: object = {}) => ({
  type: "assistant",
  session_id: "sess-1",
  parent_tool_use_id: null,
  message: { role: "assistant", content },
  ...extra,
})
const toolResult = (id: string, content: unknown, extra: object = {}, isError = false) => ({
  type: "user",
  session_id: "sess-1",
  parent_tool_use_id: null,
  message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content, is_error: isError }] },
  ...extra,
})
const success = { type: "result", subtype: "success", is_error: false, num_turns: 3, total_cost_usd: 0.0123, result: "ok", session_id: "sess-1" }

describe("MessageMapper", () => {
  it("maps init, text, tool use, tool result and result", () => {
    const events = run([
      init,
      assistant([
        { type: "thinking", thinking: "" },
        { type: "text", text: "Looking at the story." },
        { type: "tool_use", id: "tu1", name: "mcp__river__story_read", input: { file: "stories/a.twee" } },
      ]),
      toolResult("tu1", [{ type: "text", text: ":: Gate\nThe gate." }]),
      assistant([{ type: "tool_use", id: "tu2", name: "Read", input: { file_path: "/g/river.json" } }]),
      toolResult("tu2", "boom", {}, true),
      success,
    ])
    expect(events).toEqual([
      { type: "session", sessionId: "sess-1" },
      { type: "text", text: "Looking at the story." },
      { type: "tool", tool: "story_read", summary: "story_read stories/a.twee" },
      { type: "tool-result", tool: "story_read", ok: true, summary: ":: Gate" },
      { type: "tool", tool: "Read", summary: "Read /g/river.json" },
      { type: "tool-result", tool: "Read", ok: false, summary: "boom" },
      { type: "done", costUsd: 0.0123, turns: 3 },
    ])
  })

  it("puts the checkpoint ref on the session event, once", () => {
    const events = run([init, init], { checkpointRef: "refs/river/checkpoints/4" })
    expect(events).toEqual([{ type: "session", sessionId: "sess-1", checkpointRef: "refs/river/checkpoints/4" }])
  })

  it("emits plan-saved from a JSON result, structured result or bare text", () => {
    const save = (id: string) => assistant([{ type: "tool_use", id, name: "mcp__river__plan_save", input: { title: "Tighter leash" } }])
    const events = run([
      save("a"),
      toolResult("a", [{ type: "text", text: JSON.stringify({ id: "p_abc123", status: "draft" }) }]),
      save("b"),
      toolResult("b", [{ type: "text", text: "saved" }], { tool_use_result: { structuredContent: { planId: "p_struct" } } }),
      save("c"),
      toolResult("c", "Saved draft plan p_text99: Tighter leash. It needs the user's approval before implement_edit can use it."),
      save("d"),
      toolResult("d", "plan_save failed", {}, true),
    ])
    expect(events.filter((e) => e.type === "plan-saved")).toEqual([
      { type: "plan-saved", planId: "p_abc123" },
      { type: "plan-saved", planId: "p_struct" },
      { type: "plan-saved", planId: "p_text99" },
    ])
    expect(events.find((e) => e.type === "tool")).toMatchObject({ summary: 'Save change plan "Tighter leash"' })
  })

  it("emits capture with shot id and files", () => {
    const cap = (id: string) => assistant([{ type: "tool_use", id, name: "mcp__river__frames_capture", input: { shotId: "walk" } }])
    const events = run([
      cap("a"),
      toolResult("a", JSON.stringify({ shotId: "walk", files: ["frames/abc/walk/0.png", "frames/abc/walk/1.png"] })),
      cap("b"),
      // The river-mcp text form: header line, then absolute paths (which may contain spaces).
      toolResult("b", "Captured walk at rev abc1234 (2 frames):\nC:\\My Games\\park\\.river\\captures\\walk\\t\\0.png\nC:\\My Games\\park\\.river\\captures\\walk\\t\\1.png"),
    ])
    expect(events.filter((e) => e.type === "capture")).toEqual([
      { type: "capture", shotId: "walk", files: ["frames/abc/walk/0.png", "frames/abc/walk/1.png"] },
      {
        type: "capture",
        shotId: "walk",
        files: ["C:\\My Games\\park\\.river\\captures\\walk\\t\\0.png", "C:\\My Games\\park\\.river\\captures\\walk\\t\\1.png"],
      },
    ])
  })

  it("maps API errors and failed results to error events, then done", () => {
    const events = run([
      assistant([{ type: "text", text: "Invalid API key" }], { error: "authentication_failed" }),
      { type: "result", subtype: "error_max_turns", is_error: true, num_turns: 40, total_cost_usd: 1.5, errors: [], session_id: "s" },
    ])
    expect(events).toEqual([
      { type: "session", sessionId: "sess-1" },
      { type: "error", message: "Claude API error: authentication_failed" },
      { type: "text", text: "Invalid API key" },
      { type: "error", message: "Turn ended with error_max_turns: error_max_turns" },
      { type: "done", costUsd: 1.5, turns: 40 },
    ])
  })

  it("ignores subagent frames and unknown message types", () => {
    const events = run([
      { type: "stream_event", event: {} },
      { type: "system", subtype: "status" },
      assistant([{ type: "text", text: "sub" }], { parent_tool_use_id: "x" }),
      null,
      42,
    ])
    expect(events).toEqual([{ type: "session", sessionId: "sess-1" }])
  })
})
