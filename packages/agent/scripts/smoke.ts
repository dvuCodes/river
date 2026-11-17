/**
 * Live smoke test: one small "plan" turn against a temp copy of examples/park-walk.
 * Spends real API credit. Needs ANTHROPIC_API_KEY in the environment and packages/mcp/src/main.ts.
 *
 *   pnpm tsx packages/agent/scripts/smoke.ts [claude-sonnet-5-5|claude-opus-5-5]
 */
import { execFileSync } from "node:child_process"
import { cpSync, existsSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { mcpEntryPath, startAgentTurn, type AgentModel } from "../src/index"

const apiKey = process.env.ANTHROPIC_API_KEY
if (!apiKey) {
  console.error("ANTHROPIC_API_KEY is not set; not running the smoke test.")
  process.exit(2)
}
if (!existsSync(mcpEntryPath())) {
  console.error(`River MCP entry not found at ${mcpEntryPath()}; build packages/mcp first.`)
  process.exit(2)
}

const model = (process.argv[2] ?? "claude-sonnet-5-5") as AgentModel
const example = fileURLToPath(new URL("../../../examples/park-walk", import.meta.url))
const root = mkdtempSync(path.join(tmpdir(), "river-smoke-"))
cpSync(example, root, { recursive: true })
execFileSync("git", ["init", "-q"], { cwd: root })

const started = Date.now()
try {
  await startAgentTurn(
    {
      root,
      mode: "plan",
      model,
      prompt:
        "Read the story with story_read, then save a one-step plan (plan_save) that shortens the text of the Long path passage. Keep it short. Do not reply to any thread.",
      backend: "api-key",
      apiKey,
    },
    {
      onEvent: (e) => console.log(JSON.stringify(e)),
      onPermission: async (r) => {
        console.log("PERMISSION", JSON.stringify({ tool: r.tool, summary: r.summary, diff: r.diff }))
        return { behavior: "deny", message: "smoke test: writes are denied" }
      },
    },
  )
} finally {
  console.log(`elapsed ${((Date.now() - started) / 1000).toFixed(1)}s, root ${root}`)
  if (!process.env.RIVER_SMOKE_KEEP) rmSync(root, { recursive: true, force: true })
}
