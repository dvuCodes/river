import type { AgentTurnHandlers, AgentTurnRequest, ClaudeCodeStatus } from "@river/agent"

type StartAgentTurn = (req: AgentTurnRequest, handlers: AgentTurnHandlers) => unknown
type GetClaudeCodeStatus = (claudePath?: string) => Promise<ClaudeCodeStatus>
type OpenClaudeSignIn = (claudePath?: string) => Promise<void>

export interface LoadedAgent {
  start?: StartAgentTurn
  claudeStatus?: GetClaudeCodeStatus
  claudeSignIn?: OpenClaudeSignIn
  reason?: string
}

let loaded: Promise<LoadedAgent> | undefined

/**
 * Import @river/agent lazily. It is built in parallel with the app, so `startAgentTurn` may be
 * missing, or the SDK it needs may not resolve. Either way the app keeps working and the
 * Agent panel says why the agent is unavailable.
 */
export function loadAgent(): Promise<LoadedAgent> {
  loaded ??= import("@river/agent").then(
    (mod) => {
      const m = mod as unknown as Record<string, unknown>
      const fn = (name: string) => (typeof m[name] === "function" ? m[name] : undefined)
      const start = fn("startAgentTurn") as StartAgentTurn | undefined
      const claudeStatus = fn("getClaudeCodeStatus") as GetClaudeCodeStatus | undefined
      const claudeSignIn = fn("openClaudeSignIn") as OpenClaudeSignIn | undefined
      return {
        ...(start ? { start } : { reason: "@river/agent does not export startAgentTurn yet." }),
        ...(claudeStatus ? { claudeStatus } : {}),
        ...(claudeSignIn ? { claudeSignIn } : {}),
      }
    },
    (err: unknown) => ({ reason: `Could not load @river/agent: ${err instanceof Error ? err.message : String(err)}` }),
  )
  return loaded
}
