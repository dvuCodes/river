import { query as sdkQuery } from "@anthropic-ai/claude-agent-sdk"
import { checkpoint, loadPlan, loadProject, type ChangePlan, type Project } from "@river/core"
import { MessageMapper } from "./events"
import { buildQueryOptions, type McpLaunch } from "./options"
import { createCanUseTool } from "./policy"
import { turnContext } from "./prompts"
import type { AgentTurnHandlers, AgentTurnRequest } from "./types"

/** Injection points: packaging (MCP command, CLI binary) and tests (query). */
export interface AgentDeps {
  query?: typeof sdkQuery
  /** How to start the River MCP server. Default: this Node + tsx + packages/mcp/src/main.ts. */
  mcpLaunch?: McpLaunch
  /** Claude Code binary. Default: the one shipped in the SDK's platform package. */
  pathToClaudeCodeExecutable?: string
  baseEnv?: Record<string, string | undefined>
  maxTurns?: number
  effort?: "low" | "medium" | "high" | "xhigh" | "max"
}

const errMsg = (err: unknown) => (err instanceof Error ? err.message : String(err))

/**
 * Run one agent turn. Never throws: problems are reported as { type: "error" } events.
 * A turn that reaches the model ends with a "done" event (after any error event).
 */
export async function startAgentTurn(req: AgentTurnRequest, h: AgentTurnHandlers, deps: AgentDeps = {}): Promise<void> {
  const emitError = (message: string) => h.onEvent({ type: "error", message })

  let project: Project
  try {
    project = await loadProject(req.root)
  } catch (err) {
    return emitError(`Not a River project: ${errMsg(err)}`)
  }

  let plan: ChangePlan | undefined
  if (req.mode === "implement") {
    if (!req.planId) return emitError("Implement mode needs an approved plan (planId).")
    try {
      plan = await loadPlan(project, req.planId)
    } catch (err) {
      return emitError(errMsg(err))
    }
    if (plan.status !== "approved") return emitError(`Plan ${plan.id} is ${plan.status}, not approved.`)
  }
  if (!req.apiKey) return emitError("No Anthropic API key.")
  if (h.signal?.aborted) return emitError("Turn aborted.")

  let checkpointRef: string | undefined
  if (req.mode === "story" || req.mode === "implement") {
    try {
      checkpointRef = (await checkpoint(project.root, `${req.mode}: ${req.prompt.slice(0, 60)}`)).ref
    } catch (err) {
      return emitError(`Could not checkpoint the game repo: ${errMsg(err)}`)
    }
  }

  const mapper = new MessageMapper((e) => h.onEvent(e), checkpointRef ? { checkpointRef } : {})
  // The checkpoint happens before the SDK has a session id, so it rides on the first session event.
  // If the turn fails before init, the app still learns the ref (with the session id it asked for, or "").
  const flushSession = () => {
    if (checkpointRef && !mapper.hasEmittedSession) mapper.emitSession(req.sessionId ?? "")
  }

  const abortController = new AbortController()
  const onAbort = () => abortController.abort()
  h.signal?.addEventListener("abort", onAbort, { once: true })

  try {
    const canUseTool = createCanUseTool({
      mode: req.mode,
      project,
      ...(plan ? { plan } : {}),
      onPermission: (r) => h.onPermission(r),
    })
    const options = buildQueryOptions(req, {
      canUseTool,
      abortController,
      root: project.root,
      ...(deps.mcpLaunch ? { mcpLaunch: deps.mcpLaunch } : {}),
      ...(deps.baseEnv ? { baseEnv: deps.baseEnv } : {}),
      ...(deps.pathToClaudeCodeExecutable ? { pathToClaudeCodeExecutable: deps.pathToClaudeCodeExecutable } : {}),
      ...(deps.maxTurns ? { maxTurns: deps.maxTurns } : {}),
      ...(deps.effort ? { effort: deps.effort } : {}),
    })
    const q = (deps.query ?? sdkQuery)({ prompt: turnContext(req) + req.prompt, options })
    for await (const msg of q) {
      mapper.handle(msg)
      if (abortController.signal.aborted) break
    }
    flushSession()
    if (abortController.signal.aborted && !mapper.sawResult) {
      emitError("Turn aborted.")
      h.onEvent({ type: "done" })
    } else if (!mapper.sawResult) {
      emitError("The agent stopped without a result.")
      h.onEvent({ type: "done" })
    }
  } catch (err) {
    flushSession()
    emitError(abortController.signal.aborted ? "Turn aborted." : errMsg(err))
    h.onEvent({ type: "done" })
  } finally {
    h.signal?.removeEventListener("abort", onAbort)
  }
}
