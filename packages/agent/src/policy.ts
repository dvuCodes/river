import { existsSync, realpathSync } from "node:fs"
import { readFile } from "node:fs/promises"
import path from "node:path"
import type { CanUseTool, PermissionResult } from "@anthropic-ai/claude-agent-sdk"
import {
  assertConceptFile,
  assertEditAllowed,
  loadStory,
  passageById,
  safePath,
  updatePassageText,
  writeTwee3,
  type ChangePlan,
  type Project,
} from "@river/core"
import { unifiedDiff } from "./diff"
import { applyStoryEdits, newPassage, StoryEditsSchema, type StoryEdit } from "./story-edits"
import {
  AUTO_ALLOWED_WRITES,
  MODE_TOOLS,
  READ_TOOLS,
  WRITE_TOOLS,
  type AgentMode,
  type PermissionDecision,
  type PermissionRequest,
  type RiverToolName,
} from "./types"

export const MCP_PREFIX = "mcp__river__"
/** Built-in SDK tools River allows, and only on paths inside the game root. */
export const BUILTIN_READ_TOOLS = ["Read", "Glob", "Grep"] as const

export interface PolicyContext {
  mode: AgentMode
  project: Project
  /** The approved plan (mode "implement"). */
  plan?: ChangePlan
  /** The job's concept folder (mode "concept"). */
  conceptId?: string
  /** The writing job the turn writes takes for (mode "writer"). */
  writingId?: string
  onPermission(request: PermissionRequest): Promise<PermissionDecision>
}

const WINDOWS = process.platform === "win32"

function isInside(root: string, p: string): boolean {
  const r = path.relative(WINDOWS ? root.toLowerCase() : root, WINDOWS ? p.toLowerCase() : p)
  return r === "" || (!r.startsWith("..") && !path.isAbsolute(r))
}

/** True when `p` (absolute or relative to root) resolves inside root, symlinks included. */
export function pathInsideRoot(root: string, p: string): boolean {
  const abs = path.resolve(root, p)
  if (!isInside(root, abs)) return false
  if (!existsSync(abs)) return true
  try {
    return isInside(realpathSync(root), realpathSync(abs))
  } catch {
    return false
  }
}

function str(input: Record<string, unknown>, ...keys: string[]): string | undefined {
  for (const k of keys) {
    const v = input[k]
    if (typeof v === "string" && v.length > 0) return v
  }
  return undefined
}

/** Strip the MCP prefix. Returns undefined for any tool that is not a River tool. */
export function riverToolName(toolName: string): RiverToolName | undefined {
  if (!toolName.startsWith(MCP_PREFIX)) return undefined
  const name = toolName.slice(MCP_PREFIX.length)
  return ([...READ_TOOLS, ...WRITE_TOOLS] as readonly string[]).includes(name) ? (name as RiverToolName) : undefined
}

/** One line for the approval card. */
export function summarizeToolCall(tool: string, input: Record<string, unknown>): string {
  const file = str(input, "file", "storyFile", "path")
  const passage = str(input, "passageId", "id", "passage", "name")
  switch (tool) {
    case "story_write_passage":
      return `Rewrite passage ${passage ?? "?"}${file ? ` in ${file}` : ""}`
    case "story_add_passage":
      return `Add passage ${str(input, "name", "passage", "id") ?? "?"}${file ? ` to ${file}` : ""}`
    case "review_reply":
      return `Reply on review thread ${str(input, "threadId", "thread") ?? "?"}`
    case "plan_save":
      return `Save change plan "${str(input, "title") ?? "untitled"}"`
    case "implement_edit":
      return `Edit ${file ?? "?"}${str(input, "planId") ? ` (plan ${str(input, "planId")})` : ""}`
    case "plan_mark_implemented":
      return `Mark plan ${str(input, "planId", "id") ?? "?"} implemented`
    case "frames_capture": {
      if (input.all === true) return "Capture all shots"
      if (Array.isArray(input.shotIds) && input.shotIds.length > 0) {
        const ids = input.shotIds.map(String)
        const joined = ids.join(", ")
        const list = joined.length > 80 ? `${joined.slice(0, 77).trimEnd()}...` : joined
        return `Capture ${ids.length} shot${ids.length === 1 ? "" : "s"}: ${list}`
      }
      return `Capture shot ${str(input, "shotId", "shot", "id") ?? "?"}`
    }
    case "concept_write":
      return `Write ${file ?? "?"}`
    case "story_rename_passage":
      return `Rename passage ${str(input, "passageId", "id", "passage") ?? "?"} to "${str(input, "newName") ?? "?"}"${file ? ` in ${file}` : ""}`
    case "story_delete_passage":
      return `Delete passage ${str(input, "passageId", "id", "passage") ?? "?"}${file ? ` from ${file}` : ""}`
    case "story_batch_edit": {
      const n = Array.isArray(input.edits) ? input.edits.length : 0
      return `Edit ${n} passage${n === 1 ? "" : "s"}${file ? ` in ${file}` : ""}${str(input, "title", "summary") ? `: ${str(input, "title", "summary")}` : ""}`
    }
    case "voice_note":
      return `Add to the voice bible (.river/voice.md): ${(str(input, "text", "note") ?? "?").replace(/\s+/g, " ").slice(0, 80)}`
    case "writing_write":
      return `Write take ${(str(input, "variant") ?? "?").toUpperCase()}${str(input, "caption") ? `: ${str(input, "caption")}` : ""}`
    default:
      return `${tool}${file ? ` ${file}` : ""}`
  }
}

async function readRel(project: Project, rel: string): Promise<string> {
  try {
    return await readFile(safePath(project, rel), "utf8")
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return ""
    throw err
  }
}

/**
 * Diff of the change a write tool proposes, when it can be computed. Never throws: a bad input
 * (unknown passage, path outside root) just yields no diff; the MCP server is the real guard.
 */
export async function proposedDiff(project: Project, tool: string, input: Record<string, unknown>): Promise<string | undefined> {
  try {
    if (tool === "story_write_passage") {
      const file = str(input, "file", "storyFile", "path")
      const id = str(input, "passageId", "id", "passage", "name")
      // river-mcp takes { file, passageId, rawText }.
      const text = typeof input.rawText === "string" ? input.rawText : typeof input.text === "string" ? input.text : undefined
      if (!file || !id || text === undefined) return undefined
      const before = await readRel(project, file)
      const { story } = await loadStory(project, file)
      const target = passageById(story, id) ?? story.passages.find((p) => p.name === id)
      if (!target) return undefined
      const after = writeTwee3(updatePassageText(story, target.id, text))
      return unifiedDiff(before, after, file) || undefined
    }
    if (tool === "story_add_passage") {
      // Mirrors river-mcp: { file, name, rawText, tags? } appended as a new passage.
      const file = str(input, "file")
      const name = str(input, "name")
      const text = typeof input.rawText === "string" ? input.rawText : undefined
      if (!file || !name || text === undefined || /[\r\n]/.test(name)) return undefined
      const tags = Array.isArray(input.tags) ? input.tags.filter((t): t is string => typeof t === "string") : []
      const before = await readRel(project, file)
      const { story } = await loadStory(project, file)
      const passage = newPassage(name, tags, text, file)
      return unifiedDiff(before, writeTwee3({ ...story, passages: [...story.passages, passage] }), file) || undefined
    }
    if (tool === "story_rename_passage" || tool === "story_delete_passage" || tool === "story_batch_edit") {
      // Mirrors river-mcp: { file, passageId, newName } / { file, passageId } / { file, edits: StoryEdit[] }.
      const file = str(input, "file", "storyFile", "path")
      if (!file) return undefined
      let edits: StoryEdit[]
      if (tool === "story_batch_edit") {
        const parsed = StoryEditsSchema.safeParse(input.edits)
        if (!parsed.success) return undefined
        edits = parsed.data
      } else {
        const id = str(input, "passageId", "id", "passage")
        const newName = str(input, "newName")
        if (!id || (tool === "story_rename_passage" && !newName)) return undefined
        edits = [tool === "story_rename_passage" ? { op: "rename", passageId: id, newName: newName! } : { op: "delete", passageId: id }]
      }
      const { story } = await loadStory(project, file)
      // Both sides through writeTwee3, so the diff shows the edits and nothing the writer normalises.
      return unifiedDiff(writeTwee3(story), writeTwee3(applyStoryEdits(story, edits)), file) || undefined
    }
    if (tool === "implement_edit") {
      // Mirrors river-mcp: { planId, file, oldText, newText }, oldText must occur exactly once.
      const file = str(input, "file")
      if (!file || typeof input.oldText !== "string" || input.oldText === "" || typeof input.newText !== "string") return undefined
      const before = await readRel(project, file)
      let find = input.oldText
      let put = input.newText
      if (before.includes("\r\n") && !find.includes("\r\n")) {
        find = find.replace(/\n/g, "\r\n")
        put = put.replace(/\r?\n/g, "\r\n")
      }
      const at = before.indexOf(find)
      if (at === -1 || before.indexOf(find, at + find.length) !== -1) return undefined
      const after = before.slice(0, at) + put + before.slice(at + find.length)
      return unifiedDiff(before, after, file) || undefined
    }
  } catch {
    return undefined
  }
  return undefined
}

/** The outcome of the River policy for one tool call. Same shape the SDK and Claude Code's prompt tool expect. */
export type PolicyResult = { behavior: "allow"; updatedInput: Record<string, unknown> } | { behavior: "deny"; message: string }

export interface ToolCallInfo {
  /** The tool_use id, when the caller knows it. Becomes the PermissionRequest id. */
  toolUseId?: string
  /** Path Claude Code flagged as outside the allowed directories (SDK only). */
  blockedPath?: string
  signal?: AbortSignal
}

const deny = (message: string): PolicyResult => ({ behavior: "deny", message })

let requestSeq = 0

/**
 * The River permission policy, shared by both backends (SDK canUseTool and the Claude Code
 * permission prompt tool). Read-only River tools and AUTO_ALLOWED_WRITES are pre-allowed by the
 * backend, so they usually do not get here; they are allowed here too in case they do.
 * - Read/Glob/Grep: allowed only on paths inside the game root.
 * - River write tools of the current mode: ask the user through onPermission (with a diff).
 * - Anything else (including the approval_prompt tool itself): denied.
 */
export async function decideToolCall(ctx: PolicyContext, toolName: string, input: Record<string, unknown>, info: ToolCallInfo = {}): Promise<PolicyResult> {
  if ((BUILTIN_READ_TOOLS as readonly string[]).includes(toolName)) {
    const p = str(input, toolName === "Read" ? "file_path" : "path")
    if (p === undefined && toolName === "Read") return deny("Read needs a file_path")
    const outside = `River only reads inside the game repo (${ctx.project.root})`
    if (p !== undefined && !pathInsideRoot(ctx.project.root, p)) return deny(outside)
    if (info.blockedPath && !pathInsideRoot(ctx.project.root, info.blockedPath)) return deny(outside)
    // A pathless Glob/Grep searches the root, but a glob can still reach out ("C:/Users/**", "../**").
    for (const key of ["pattern", "glob"] as const) {
      if (toolName === "Grep" && key === "pattern") continue // Grep's pattern is a regex, not a path
      const g = str(input, key)
      if (g !== undefined && (path.isAbsolute(g) || /^[A-Za-z]:/.test(g) || g.startsWith("~") || /(^|[\\/])\.\.([\\/]|$)/.test(g))) {
        return deny(outside)
      }
    }
    return { behavior: "allow", updatedInput: input }
  }

  const allowedInMode = new Set<string>(MODE_TOOLS[ctx.mode])
  const tool = riverToolName(toolName)
  if (!tool) return deny(`${toolName} is not available in River`)
  if (!allowedInMode.has(tool)) return deny(`${tool} is not available in ${ctx.mode} mode`)
  // Above the auto-allow below: river-mcp guards concept_write too, this is the second check.
  if (tool === "concept_write") {
    if (!ctx.conceptId) return deny("concept_write needs a concept job")
    try {
      assertConceptFile(ctx.conceptId, str(input, "file") ?? "")
    } catch (err) {
      return deny((err as Error).message)
    }
  }
  if (tool === "writing_write") {
    if (!ctx.writingId) return deny("writing_write needs a writing job")
    const variant = str(input, "variant")
    if (variant !== undefined && !/^[a-e]$/i.test(variant)) return deny(`writing_write: variant must be one of a..e, not ${JSON.stringify(variant)}`)
  }
  if ((READ_TOOLS as readonly string[]).includes(tool) || AUTO_ALLOWED_WRITES.includes(tool)) {
    return { behavior: "allow", updatedInput: input }
  }

  if (tool === "implement_edit" || tool === "plan_mark_implemented") {
    if (!ctx.plan) return deny(`${tool} needs an approved plan`)
    if (input.planId !== undefined && input.planId !== ctx.plan.id) {
      return deny(`This turn runs plan ${ctx.plan.id}; ${tool} must use that planId`)
    }
  }
  if (tool === "implement_edit") {
    if (!ctx.plan) return deny("implement_edit needs an approved plan")
    const file = str(input, "file", "path")
    if (!file) return deny("implement_edit needs a file")
    try {
      assertEditAllowed(ctx.project, ctx.plan, file)
    } catch (err) {
      return deny((err as Error).message)
    }
  }

  const request: PermissionRequest = {
    id: info.toolUseId ?? `river-perm-${Date.now().toString(36)}-${++requestSeq}`,
    tool,
    summary: summarizeToolCall(tool, input),
    input,
  }
  const diff = await proposedDiff(ctx.project, tool, input)
  if (diff) request.diff = diff

  if (info.signal?.aborted) return deny("Turn aborted")
  let decision: PermissionDecision
  try {
    decision = await ctx.onPermission(request)
  } catch (err) {
    return deny(`Permission request failed: ${(err as Error).message}`)
  }
  if (decision.behavior === "allow") return { behavior: "allow", updatedInput: input }
  return deny(decision.message || "The user denied this change")
}

/** The SDK backend's canUseTool: a thin wrapper over decideToolCall. */
export function createCanUseTool(ctx: PolicyContext): (...args: Parameters<CanUseTool>) => Promise<PermissionResult> {
  return (toolName, input, options) =>
    decideToolCall(ctx, toolName, input, {
      toolUseId: options.toolUseID,
      ...(options.blockedPath ? { blockedPath: options.blockedPath } : {}),
      signal: options.signal,
    })
}
