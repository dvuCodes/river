import type { AgentBackend, AgentModel, AgentTurnHandlers, AgentTurnRequest, ClaudeCodeStatus } from "@river/agent"
import type { Job } from "@river/core"

type StartAgentTurn = (req: AgentTurnRequest, handlers: AgentTurnHandlers) => unknown
type GetClaudeCodeStatus = (claudePath?: string) => Promise<ClaudeCodeStatus>
type OpenClaudeSignIn = (claudePath?: string) => Promise<void>

export interface ConceptJobRequest {
  workspaceRoot: string
  board: string
  markId: string
  model: AgentModel
  backend: AgentBackend
  apiKey?: string
  claudePath?: string
}

/** The concept-job half of @river/agent, typed here because it is written in parallel with the app. */
export interface JobApi {
  startConceptJob(req: ConceptJobRequest, deps?: object): Promise<Job>
  approveJobScript(workspaceRoot: string, jobId: string, sha256: string): Promise<unknown>
  acceptJob(workspaceRoot: string, jobId: string): Promise<unknown>
  dismissJob(workspaceRoot: string, jobId: string): Promise<unknown>
  recoverJobs(workspaceRoot: string): Promise<unknown>
}
const JOB_FNS = ["startConceptJob", "approveJobScript", "acceptJob", "dismissJob", "recoverJobs"] as const

export interface LoadedAgent {
  start?: StartAgentTurn
  claudeStatus?: GetClaudeCodeStatus
  claudeSignIn?: OpenClaudeSignIn
  reason?: string
  jobs?: JobApi
  jobsReason?: string
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
      const missingJobFn = JOB_FNS.find((n) => !fn(n))
      return {
        ...(missingJobFn ? { jobsReason: `@river/agent does not export ${missingJobFn} yet.` } : { jobs: mod as unknown as JobApi }),
        ...(start ? { start } : { reason: "@river/agent does not export startAgentTurn yet." }),
        ...(claudeStatus ? { claudeStatus } : {}),
        ...(claudeSignIn ? { claudeSignIn } : {}),
      }
    },
    (err: unknown) => {
      const reason = `Could not load @river/agent: ${err instanceof Error ? err.message : String(err)}`
      return { reason, jobsReason: reason }
    },
  )
  return loaded
}
