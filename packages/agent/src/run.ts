import { query as sdkQuery } from "@anthropic-ai/claude-agent-sdk"
import { assertConceptId, checkpoint, loadPlan, loadProject, type ChangePlan, type Project } from "@river/core"
import { startApprovalServer, type ApprovalServer } from "./approval"
import { runClaudeCodeProcess } from "./claude-code"
import { MessageMapper } from "./events"
import { buildQueryOptions, type McpLaunch } from "./options"
import { createCanUseTool, decideToolCall, type PolicyContext } from "./policy"
import { turnContext } from "./prompts"
import type { AgentTurnHandlers, AgentTurnRequest } from "./types"

/** Injection points: packaging (MCP command, CLI binary) and tests (query). */
export interface AgentDeps {
  query?: typeof sdkQuery
  /** How to start the River MCP server. Default: this Node + tsx + packages/mcp/src/main.ts. */
  mcpLaunch?: McpLaunch
  /** Claude Code binary for the "api-key" backend. Default: the one shipped in the SDK's platform package. */
  pathToClaudeCodeExecutable?: string
  baseEnv?: Record<string, string | undefined>
  maxTurns?: number
  effort?: "low" | "medium" | "high" | "xhigh" | "max"
}

const errMsg = (err: unknown) => (err instanceof Error ? err.message : String(err))

/** What both backends share for one turn, after the checks and the checkpoint. */
interface Turn {
  project: Project
  policy: PolicyContext
  mapper: MessageMapper
  abortController: AbortController
}

/**
 * Run one agent turn. Never throws: problems are reported as { type: "error" } events.
 * A turn that reaches the model ends with a "done" event (after any error event).
 */
export async function startAgentTurn(req: AgentTurnRequest, h: AgentTurnHandlers, deps: AgentDeps = {}): Promise<void> {
  const emitError = (message: string) => h.onEvent({ type: "error", message })
  const backend = req.backend ?? "api-key"

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
  if (req.mode === "concept") {
    if (!req.conceptId) return emitError("Concept mode needs a conceptId.")
    try {
      assertConceptId(req.conceptId)
    } catch (err) {
      return emitError(errMsg(err))
    }
  }
  if (backend !== "api-key" && backend !== "claude-code") return emitError(`Unknown agent backend: ${String(backend)}`)
  if (backend === "api-key" && !req.apiKey) return emitError("No Anthropic API key.")
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
  // The checkpoint happens before the backend has a session id, so it rides on the first session event.
  // If the turn fails before init, the app still learns the ref (with the session id it asked for, or "").
  const flushSession = () => {
    if (checkpointRef && !mapper.hasEmittedSession) mapper.emitSession(req.sessionId ?? "")
  }

  const abortController = new AbortController()
  const onAbort = () => abortController.abort()
  h.signal?.addEventListener("abort", onAbort, { once: true })

  const turn: Turn = {
    project,
    policy: {
      mode: req.mode,
      project,
      ...(plan ? { plan } : {}),
      ...(req.mode === "concept" && req.conceptId ? { conceptId: req.conceptId } : {}),
      onPermission: (r) => h.onPermission(r),
    },
    mapper,
    abortController,
  }
  try {
    if (backend === "claude-code") await runClaudeCode(req, turn, deps)
    else await runSdk(req, turn, deps)
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

/** "api-key": the Agent SDK with the app's API key. */
async function runSdk(req: AgentTurnRequest, turn: Turn, deps: AgentDeps): Promise<void> {
  const options = buildQueryOptions(req, {
    canUseTool: createCanUseTool(turn.policy),
    abortController: turn.abortController,
    root: turn.project.root,
    ...(deps.mcpLaunch ? { mcpLaunch: deps.mcpLaunch } : {}),
    ...(deps.baseEnv ? { baseEnv: deps.baseEnv } : {}),
    ...(deps.pathToClaudeCodeExecutable ? { pathToClaudeCodeExecutable: deps.pathToClaudeCodeExecutable } : {}),
    ...(deps.maxTurns ? { maxTurns: deps.maxTurns } : {}),
    ...(deps.effort ? { effort: deps.effort } : {}),
  })
  const q = (deps.query ?? sdkQuery)({ prompt: turnContext(req) + req.prompt, options })
  for await (const msg of q) {
    turn.mapper.handle(msg)
    if (turn.abortController.signal.aborted) break
  }
}

/** "claude-code": the user's own `claude` CLI, with permission prompts answered over a local pipe. */
async function runClaudeCode(req: AgentTurnRequest, turn: Turn, deps: AgentDeps): Promise<void> {
  const signal = turn.abortController.signal
  let approvals: ApprovalServer | undefined
  try {
    approvals = await startApprovalServer((toolName, input, toolUseId) =>
      decideToolCall(turn.policy, toolName, input, { ...(toolUseId ? { toolUseId } : {}), signal }),
    )
    const { code, stderr } = await runClaudeCodeProcess(req, turn.project.root, approvals.pipe, turn.mapper, signal, {
      ...(deps.mcpLaunch ? { mcpLaunch: deps.mcpLaunch } : {}),
      ...(deps.baseEnv ? { baseEnv: deps.baseEnv } : {}),
      ...(deps.maxTurns ? { maxTurns: deps.maxTurns } : {}),
      ...(deps.effort ? { effort: deps.effort } : {}),
    })
    if (!turn.mapper.sawResult && !signal.aborted && code !== 0) {
      const tail = stderr.trim().split(/\r?\n/).slice(-3).join(" ").slice(0, 400)
      throw new Error(`Claude Code exited with code ${String(code)}${tail ? `: ${tail}` : ""}`)
    }
  } finally {
    await approvals?.close()
  }
}
