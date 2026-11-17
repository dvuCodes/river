import { execFileSync } from "node:child_process"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { loadProject, savePlan, setPlanStatus } from "@river/core"
import { startAgentTurn, type AgentDeps } from "../src/run"
import type { AgentEvent, AgentTurnRequest } from "../src/types"
import { removeDir, tempGame } from "./helpers"

let root: string
beforeEach(() => {
  root = tempGame()
})
afterEach(() => removeDir(root))

const req = (over: Partial<AgentTurnRequest> = {}): AgentTurnRequest => ({
  root,
  mode: "plan",
  model: "claude-sonnet-5-5",
  prompt: "brighten the pond",
  backend: "api-key",
  apiKey: "sk-test-not-real",
  ...over,
})

const launch = { command: "node", args: ["fake-mcp.js"] }

/** A fake query() that records its options and yields the given messages. */
function fakeQuery(messages: unknown[]) {
  const calls: { prompt: unknown; options: Record<string, unknown> }[] = []
  const query = ((params: { prompt: unknown; options: Record<string, unknown> }) => {
    calls.push(params)
    return (async function* () {
      for (const m of messages) yield m
    })()
  }) as unknown as NonNullable<AgentDeps["query"]>
  return { query, calls }
}

function handlers() {
  const events: AgentEvent[] = []
  return { events, h: { onEvent: (e: AgentEvent) => events.push(e), onPermission: vi.fn() } }
}

const okRun = [
  { type: "system", subtype: "init", session_id: "s-1" },
  { type: "result", subtype: "success", is_error: false, num_turns: 1, total_cost_usd: 0.01, result: "", session_id: "s-1" },
]

describe("startAgentTurn", () => {
  it("refuses a folder without river.json", async () => {
    const empty = mkdtempSync(path.join(tmpdir(), "river-empty-"))
    const { query, calls } = fakeQuery(okRun)
    const { events, h } = handlers()
    await startAgentTurn(req({ root: empty }), h, { query, mcpLaunch: launch })
    removeDir(empty)
    expect(calls).toHaveLength(0)
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({ type: "error", message: expect.stringContaining("Not a River project") })
  })

  it("refuses implement without a plan, or with a plan that is not approved", async () => {
    const { query, calls } = fakeQuery(okRun)
    const a = handlers()
    await startAgentTurn(req({ mode: "implement" }), a.h, { query, mcpLaunch: launch })
    expect(a.events).toEqual([{ type: "error", message: "Implement mode needs an approved plan (planId)." }])

    const project = await loadProject(root)
    const plan = await savePlan(project, { title: "t", rationale: "r", steps: [{ file: "stories/state.json", change: "c" }], recapture: [] })
    const b = handlers()
    await startAgentTurn(req({ mode: "implement", planId: plan.id }), b.h, { query, mcpLaunch: launch })
    expect(b.events).toEqual([{ type: "error", message: `Plan ${plan.id} is draft, not approved.` }])

    const c = handlers()
    await startAgentTurn(req({ mode: "implement", planId: "p_missing" }), c.h, { query, mcpLaunch: launch })
    expect(c.events[0]).toMatchObject({ type: "error" })
    expect(calls).toHaveLength(0)
    // No checkpoint was taken for refused turns.
    expect(execFileSync("git", ["for-each-ref", "refs/river/"], { cwd: root, encoding: "utf8" }).trim()).toBe("")
  })

  it("runs an approved implement turn: checkpoint, options, events", async () => {
    const project = await loadProject(root)
    const plan = await savePlan(project, { title: "t", rationale: "r", steps: [{ file: "stories/state.json", change: "c" }], recapture: [] })
    await setPlanStatus(project, plan.id, "approved")
    const { query, calls } = fakeQuery(okRun)
    const { events, h } = handlers()
    await startAgentTurn(req({ mode: "implement", planId: plan.id, prompt: "x".repeat(100) }), h, { query, mcpLaunch: launch })

    expect(events[0]).toMatchObject({ type: "session", sessionId: "s-1", checkpointRef: "refs/river/checkpoints/1" })
    expect(events.at(-1)).toEqual({ type: "done", costUsd: 0.01, turns: 1 })
    const label = execFileSync("git", ["log", "-1", "--format=%s", "refs/river/checkpoints/1"], { cwd: root, encoding: "utf8" }).trim()
    expect(label).toBe(`river checkpoint: implement: ${"x".repeat(60)}`)

    expect(calls).toHaveLength(1)
    const opts = calls[0]!.options
    expect(opts.cwd).toBe(project.root)
    expect(opts.model).toBe("claude-sonnet-5-5")
    expect((opts.env as Record<string, string>).ANTHROPIC_API_KEY).toBe("sk-test-not-real")
    expect(typeof opts.canUseTool).toBe("function")
    expect(String(calls[0]!.prompt)).toContain(`Approved plan: ${plan.id}`)
  })

  it("does not checkpoint in plan mode and passes resume", async () => {
    const { query, calls } = fakeQuery(okRun)
    const { events, h } = handlers()
    await startAgentTurn(req({ sessionId: "old-session" }), h, { query, mcpLaunch: launch })
    expect(events[0]).toEqual({ type: "session", sessionId: "s-1" })
    expect(calls[0]!.options.resume).toBe("old-session")
    expect(execFileSync("git", ["for-each-ref", "refs/river/"], { cwd: root, encoding: "utf8" }).trim()).toBe("")
  })

  it("runs a concept turn without a checkpoint, and refuses one without a valid conceptId", async () => {
    for (const conceptId of [undefined, "../x"]) {
      const { query, calls } = fakeQuery(okRun)
      const { events, h } = handlers()
      await startAgentTurn(req({ mode: "concept", ...(conceptId ? { conceptId } : {}) }), h, { query, mcpLaunch: launch })
      expect(calls).toHaveLength(0)
      expect(events).toEqual([{ type: "error", message: expect.stringMatching(/conceptId|invalid concept id/) }])
    }
    const { query, calls } = fakeQuery(okRun)
    const { h } = handlers()
    await startAgentTurn(req({ mode: "concept", conceptId: "k_run00001" }), h, { query, mcpLaunch: launch })
    expect(String(calls[0]!.prompt)).toContain("Concept id: k_run00001 (write concepts/k_run00001/draw.gd, or options draw_a.gd..draw_e.gd)")
    expect(execFileSync("git", ["for-each-ref", "refs/river/"], { cwd: root, encoding: "utf8" }).trim()).toBe("")
  })

  it("reports a thrown query as error + done and still reports the checkpoint", async () => {
    const query = (() =>
      (async function* () {
        throw new Error("spawn failed")
      })()) as unknown as NonNullable<AgentDeps["query"]>
    const { events, h } = handlers()
    await startAgentTurn(req({ mode: "story" }), h, { query, mcpLaunch: launch })
    expect(events).toEqual([
      { type: "session", sessionId: "", checkpointRef: "refs/river/checkpoints/1" },
      { type: "error", message: "spawn failed" },
      { type: "done" },
    ])
  })

  it("aborts through the handler signal", async () => {
    const ac = new AbortController()
    let seenSignal: AbortSignal | undefined
    const query = ((params: { options: { abortController: AbortController } }) => {
      seenSignal = params.options.abortController.signal
      return (async function* () {
        yield { type: "system", subtype: "init", session_id: "s-2" }
        ac.abort()
        yield { type: "assistant", session_id: "s-2", parent_tool_use_id: null, message: { content: [{ type: "text", text: "late" }] } }
      })()
    }) as unknown as NonNullable<AgentDeps["query"]>
    const { events, h } = handlers()
    await startAgentTurn(req(), { ...h, signal: ac.signal }, { query, mcpLaunch: launch })
    expect(seenSignal?.aborted).toBe(true)
    expect(events).toEqual([
      { type: "session", sessionId: "s-2" },
      { type: "text", text: "late" },
      { type: "error", message: "Turn aborted." },
      { type: "done" },
    ])
  })
})
