#!/usr/bin/env node
// A stand-in for the `claude` CLI in tests. It never talks to a model.
// - `--version`                 -> "9.9.9 (Claude Code)"
// - `auth status --json`        -> JSON from FAKE_CLAUDE_AUTH (exit 1 when loggedIn is false)
// - `-p ...`                    -> records argv/stdin/env to FAKE_CLAUDE_RECORD, then prints
//                                  recorded stream-json lines (init, text, a story_lint tool_use, result)
import { writeFileSync } from "node:fs"

const argv = process.argv.slice(2)

if (argv[0] === "--version") {
  process.stdout.write("9.9.9 (Claude Code)\n")
  process.exit(0)
}
if (argv[0] === "auth" && argv[1] === "status") {
  const body = process.env.FAKE_CLAUDE_AUTH ?? '{"loggedIn":false,"authMethod":"none"}'
  process.stdout.write(body + "\n")
  process.exit(JSON.parse(body).loggedIn ? 0 : 1)
}

let stdin = ""
process.stdin.setEncoding("utf8")
process.stdin.on("data", (d) => (stdin += d))
process.stdin.on("end", () => {
  if (process.env.FAKE_CLAUDE_RECORD) {
    const env = {}
    for (const k of Object.keys(process.env)) env[k.toUpperCase()] = true
    writeFileSync(process.env.FAKE_CLAUDE_RECORD, JSON.stringify({ argv, stdin, cwd: process.cwd(), envKeys: Object.keys(env) }))
  }
  if (process.env.FAKE_CLAUDE_HANG) {
    process.stdout.write(JSON.stringify({ type: "system", subtype: "init", session_id: "fake-hang" }) + "\n")
    setInterval(() => {}, 1000)
    return
  }
  const sid = "fake-session-1"
  const lines = [
    { type: "system", subtype: "ui_status", text: "noise the mapper ignores", session_id: sid },
    { type: "system", subtype: "init", session_id: sid, model: "claude-sonnet-5-5", tools: ["Read", "Glob", "Grep", "mcp__river__story_lint"] },
    { type: "assistant", session_id: sid, parent_tool_use_id: null, message: { content: [{ type: "text", text: "Checking the story." }] } },
    {
      type: "assistant",
      session_id: sid,
      parent_tool_use_id: null,
      message: { content: [{ type: "tool_use", id: "toolu_lint", name: "mcp__river__story_lint", input: { file: "stories/park_walk.twee" } }] },
    },
    {
      type: "user",
      session_id: sid,
      parent_tool_use_id: null,
      message: { content: [{ type: "tool_result", tool_use_id: "toolu_lint", content: [{ type: "text", text: "1 error, 2 warnings in 8 passages\nmore" }] }] },
    },
    { type: "assistant", session_id: sid, parent_tool_use_id: null, message: { content: [{ type: "text", text: "One error and two warnings." }] } },
    { type: "result", subtype: "success", is_error: false, num_turns: 2, total_cost_usd: 0.0123, result: "done", session_id: sid },
  ]
  // Split one line across two writes, and end with CRLF, to exercise the line reader.
  const out = lines.map((l) => JSON.stringify(l)).join("\r\n") + "\r\n"
  process.stdout.write(out.slice(0, 50))
  setTimeout(() => process.stdout.write(out.slice(50)), 20)
})
