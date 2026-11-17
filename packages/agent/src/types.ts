/**
 * The in-app agent contract. The desktop app depends only on this file and on `startAgentTurn`.
 *
 * Modes:
 * - "story":     drafts and edits passages. Each story write asks the user first.
 * - "plan":      READ-ONLY on game files. Answers a review thread with a ChangePlan (draft).
 * - "implement": runs an APPROVED ChangePlan. It can edit only the files the plan names
 *                (core `assertEditAllowed`), then capture the plan's shots again.
 *
 * Every "story" and "implement" turn starts with a git checkpoint of the game repo.
 */

export type AgentMode = "story" | "plan" | "implement"

export type AgentModel = "claude-opus-5-5" | "claude-sonnet-5-5"

/**
 * Who runs the model:
 * - "api-key":     the Agent SDK with an Anthropic API key the app passes in.
 * - "claude-code": the user's own installed `claude` CLI, signed in with their own account.
 *                  River never sees or stores that sign-in; it only starts the CLI.
 */
export type AgentBackend = "api-key" | "claude-code"

export interface AgentTurnRequest {
  /** Absolute path of the game repo (the folder with river.json). */
  root: string
  mode: AgentMode
  model: AgentModel
  prompt: string
  /** Story file the user has open, relative to root. */
  storyFile?: string
  /** Review thread to answer (mode "plan"). */
  threadId?: string
  /** Approved plan to run (mode "implement"). Required in that mode. */
  planId?: string
  /** Continue an earlier conversation. */
  sessionId?: string
  backend: AgentBackend
  /** ANTHROPIC_API_KEY for the "api-key" backend. The app passes it in; the agent never reads it from disk. */
  apiKey?: string
  /** The `claude` executable for the "claude-code" backend. Default: `claude` found on PATH. */
  claudePath?: string
}

/** What River shows about the user's Claude Code install. Never email, org or token fields. */
export interface ClaudeCodeStatus {
  installed: boolean
  version?: string
  loggedIn: boolean
  /** e.g. "claude.ai", "api_key", "none". */
  authMethod?: string
  /** e.g. "max", "pro". */
  subscriptionType?: string
  error?: string
}

/** A request for the user to approve one tool call. */
export interface PermissionRequest {
  id: string
  /** MCP tool name without the server prefix, e.g. "story_write_passage". */
  tool: string
  /** One line for the approval card. */
  summary: string
  /** Unified diff of the change, when the tool writes a file. */
  diff?: string
  input: Record<string, unknown>
}

export type PermissionDecision =
  | { behavior: "allow" }
  | { behavior: "deny"; message: string }

export type AgentEvent =
  | { type: "session"; sessionId: string; checkpointRef?: string }
  | { type: "text"; text: string }
  | { type: "tool"; tool: string; summary: string }
  | { type: "tool-result"; tool: string; ok: boolean; summary: string }
  | { type: "plan-saved"; planId: string }
  | { type: "capture"; shotId: string; files: string[] }
  | { type: "done"; costUsd?: number; turns?: number }
  | { type: "error"; message: string }

export interface AgentTurnHandlers {
  onEvent(event: AgentEvent): void
  /** Called for every mutating tool. The turn waits for the answer. */
  onPermission(request: PermissionRequest): Promise<PermissionDecision>
  /** Abort the turn. */
  signal?: AbortSignal
}

/**
 * The River MCP tools. Server name "river"; full names are "mcp__river__<name>".
 * Read-only tools never ask. Mutating tools always ask through onPermission.
 */
export const READ_TOOLS = [
  "project_info",
  "story_list",
  "story_read",
  "story_lint",
  "story_paths",
  "playtest_run",
  "frames_list",
  "review_list",
  "plan_list",
  "plan_read",
] as const

export const WRITE_TOOLS = [
  "story_write_passage",
  "story_add_passage",
  "review_reply",
  "plan_save",
  "implement_edit",
  "plan_mark_implemented",
  "frames_capture",
] as const

export type RiverToolName = (typeof READ_TOOLS)[number] | (typeof WRITE_TOOLS)[number]

/** Which tools each mode can see. Built-in SDK tools allowed in every mode: Read, Glob, Grep (inside root). */
export const MODE_TOOLS: Record<AgentMode, readonly RiverToolName[]> = {
  story: [...READ_TOOLS, "story_write_passage", "story_add_passage"],
  plan: [...READ_TOOLS, "review_reply", "plan_save"],
  implement: [...READ_TOOLS, "implement_edit", "frames_capture", "plan_mark_implemented", "review_reply"],
}

/** Tools that never ask, even though they write: plan_save writes only a draft plan file under .river/plans. */
export const AUTO_ALLOWED_WRITES: readonly RiverToolName[] = ["plan_save"]
