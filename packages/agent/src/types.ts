/**
 * The in-app agent contract. The desktop app depends only on this file and on `startAgentTurn`.
 *
 * Modes:
 * - "story":     drafts and edits passages. Each story write asks the user first.
 * - "plan":      READ-ONLY on game files. Answers a review thread with a ChangePlan (draft).
 * - "implement": runs an APPROVED ChangePlan. It can edit only the files the plan names
 *                (core `assertEditAllowed`), then capture the plan's shots again.
 * - "concept":   a concept job's turn, run in the job's worktree. It can write only in
 *                concepts/<conceptId>/ (draw.gd, or options draw_a.gd..draw_e.gd). Nothing runs them here.
 * - "writer":    a writing job's turn, run in the job's worktree. It writes takes (A/B/C versions of passages) only
 *                as .river/writing/<writingId>/take_<v>.json; nothing touches the story until the user accepts a take.
 *
 * Every "story" and "implement" turn starts with a git checkpoint of the game repo.
 */

export type AgentMode = "story" | "plan" | "implement" | "concept" | "writer"

/** Models River knows by name. Any other id that passes isValidModel is accepted too (a newer model, a custom one). */
export const KNOWN_MODELS = ["claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-4-5"] as const

export const DEFAULT_MODEL = "claude-opus-5-5"

/**
 * A model id as the backends take it: starts with a letter or digit (never "-", which the claude CLI would read as a
 * flag), then letters, digits and . _ : - only. No whitespace or shell characters. At most 100 characters.
 */
export const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$/

export function isValidModel(value: unknown): value is string {
  return typeof value === "string" && MODEL_ID.test(value)
}

/** A model id (see KNOWN_MODELS, isValidModel). */
export type AgentModel = string

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
  /** The concept folder the turn writes in, concepts/<conceptId>/ (mode "concept"). Required in that mode. */
  conceptId?: string
  /** Continue an earlier conversation. */
  sessionId?: string
  /** The writing job the turn writes takes for (mode "writer"). Required in that mode; matches WRITING_ID. */
  writingId?: string
  /** The project brief (.river/brief.md), added to the system prompt. */
  brief?: string
  /** The narrative voice bible (.river/voice.md), added to the system prompt beside the brief. */
  voice?: string
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
  /** A piece of assistant text as the model streams it. The whole block still arrives as one "text" event after. */
  | { type: "text-delta"; text: string }
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
  "board_read",
  "marks_open",
  "brief_read",
  "card_read",
  "mark_read",
  "card_view",
  "voice_read",
  "story_outline",
  "story_read_passage",
  "story_search",
  "story_sample_transcripts",
  "story_pacing",
  "story_simulate",
] as const

export const WRITE_TOOLS = [
  "story_write_passage",
  "story_add_passage",
  "review_reply",
  "plan_save",
  "implement_edit",
  "plan_mark_implemented",
  "frames_capture",
  "concept_write",
  "mark_claim",
  "mark_reply",
  "board_add_note",
  "board_add_card",
  "board_connect",
  "board_place_row",
  "board_update_note",
  "board_remove_card",
  "concept_request",
  "story_rename_passage",
  "story_delete_passage",
  "story_batch_edit",
  "voice_note",
  "writing_request",
  "writing_write",
] as const

export type RiverToolName = (typeof READ_TOOLS)[number] | (typeof WRITE_TOOLS)[number]

/**
 * Which tools each mode can see. Built-in SDK tools allowed in every mode: Read, Glob, Grep (inside root).
 * The board write tools, concept_request and writing_request are for agents working the board from outside (Claude
 * Code with river-mcp); no mode has them, a job's runner lays its own answer out, and no job starts another.
 */
export const MODE_TOOLS: Record<AgentMode, readonly RiverToolName[]> = {
  story: [...READ_TOOLS, "story_write_passage", "story_add_passage", "story_rename_passage", "story_delete_passage", "story_batch_edit", "voice_note"],
  plan: [...READ_TOOLS, "review_reply", "plan_save"],
  implement: [...READ_TOOLS, "implement_edit", "frames_capture", "plan_mark_implemented", "review_reply"],
  concept: [...READ_TOOLS, "concept_write"],
  writer: [...READ_TOOLS, "writing_write"],
}

/**
 * Tools that never ask, even though they write: plan_save writes only a draft plan file under .river/plans;
 * concept_write writes only in the job's own folder in its worktree, and nothing runs what it writes
 * until the user approves the exact bytes; writing_write writes only a take file in the writing job's worktree,
 * and nothing changes the story until the user accepts a take.
 */
export const AUTO_ALLOWED_WRITES: readonly RiverToolName[] = ["plan_save", "concept_write", "writing_write"]

/** A writing job id, as the writer turn and river-mcp's --writing take it. */
export const WRITING_ID = /^[A-Za-z0-9_-]{1,64}$/
