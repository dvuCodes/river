import type * as Agent from "@river/agent"
import type { AgentTurnHandlers, AgentTurnRequest, ClaudeCodeStatus } from "@river/agent"

/** The third argument limits a short turn, such as the look at a job's renders. */
type StartAgentTurn = (req: AgentTurnRequest, handlers: AgentTurnHandlers, limits?: { maxTurns?: number; effort?: "low" | "medium" | "high" }) => Promise<void>
type GetClaudeCodeStatus = (claudePath?: string) => Promise<ClaudeCodeStatus>
type OpenClaudeSignIn = (claudePath?: string) => Promise<void>

const JOB_FNS = ["startConceptJob", "readJobScripts", "approveJobScripts", "acceptJob", "dismissJob", "reviseJob", "repliesAfter", "recoverJobs"] as const
export type JobApi = Pick<typeof Agent, (typeof JOB_FNS)[number]>
/** Writing jobs are optional: an @river/agent without them still runs concept jobs. */
const WRITING_FNS = ["startWritingJob", "acceptWritingJob", "reviseWritingJob", "dismissWritingJob", "readWritingTakes"] as const
export type WritingApi = Pick<typeof Agent, (typeof WRITING_FNS)[number]>

export interface LoadedAgent {
  start?: StartAgentTurn
  claudeStatus?: GetClaudeCodeStatus
  claudeSignIn?: OpenClaudeSignIn
  reason?: string
  jobs?: JobApi
  jobsReason?: string
  writing?: WritingApi
  writingReason?: string
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
      const missingWritingFn = WRITING_FNS.find((n) => !fn(n))
      return {
        ...(missingJobFn ? { jobsReason: `@river/agent does not export ${missingJobFn} yet.` } : { jobs: mod as unknown as JobApi }),
        ...(missingWritingFn ? { writingReason: `@river/agent does not export ${missingWritingFn} yet.` } : { writing: mod as unknown as WritingApi }),
        ...(start ? { start } : { reason: "@river/agent does not export startAgentTurn yet." }),
        ...(claudeStatus ? { claudeStatus } : {}),
        ...(claudeSignIn ? { claudeSignIn } : {}),
      }
    },
    (err: unknown) => {
      const reason = `Could not load @river/agent: ${err instanceof Error ? err.message : String(err)}`
      return { reason, jobsReason: reason, writingReason: reason }
    },
  )
  return loaded
}
