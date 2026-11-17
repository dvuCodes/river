import type { AgentTurnHandlers, AgentTurnRequest } from "@river/agent"

type StartAgentTurn = (req: AgentTurnRequest, handlers: AgentTurnHandlers) => unknown

let loaded: Promise<{ start?: StartAgentTurn; reason?: string }> | undefined

/**
 * Import @river/agent lazily. It is built in parallel with the app, so `startAgentTurn` may be
 * missing, or the SDK it needs may not resolve. Either way the app keeps working and the
 * Agent panel says why the agent is unavailable.
 */
export function loadAgent(): Promise<{ start?: StartAgentTurn; reason?: string }> {
  loaded ??= import("@river/agent").then(
    (mod) => {
      const fn = (mod as unknown as Record<string, unknown>)["startAgentTurn"]
      return typeof fn === "function"
        ? { start: fn as StartAgentTurn }
        : { reason: "@river/agent does not export startAgentTurn yet." }
    },
    (err: unknown) => ({ reason: `Could not load @river/agent: ${err instanceof Error ? err.message : String(err)}` }),
  )
  return loaded
}
