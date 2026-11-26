import { riverToolName, summarizeToolCall } from "./policy"
import type { AgentEvent } from "./types"

/**
 * Maps SDK messages to AgentEvents. Messages are read through structural guards rather than
 * the SDK's types, so a field the SDK adds or drops degrades to "no event" instead of a crash.
 */

type Obj = Record<string, unknown>
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v)

const BUILTIN_SUMMARY: Record<string, (input: Obj) => string> = {
  Read: (i) => `Read ${String(i.file_path ?? "")}`,
  Glob: (i) => `Glob ${String(i.pattern ?? "")}`,
  Grep: (i) => `Grep ${String(i.pattern ?? "")}`,
}

function displayName(toolName: string): string {
  return riverToolName(toolName) ?? toolName
}

/** Text from a tool_result `content`: a string or an array of blocks. */
export function toolResultText(content: unknown): string {
  if (typeof content === "string") return content
  if (!Array.isArray(content)) return ""
  return content
    .map((b) => (isObj(b) && b.type === "text" && typeof b.text === "string" ? b.text : ""))
    .filter(Boolean)
    .join("\n")
}

function firstLine(text: string, max = 160): string {
  const line = text.trim().split(/\r?\n/, 1)[0] ?? ""
  return line.length > max ? line.slice(0, max - 1) + "…" : line
}

/** Parse JSON from a tool result: structured content first, then the text (whole, or the first {...} in it). */
function parseResult(text: string, structured: unknown): Obj | undefined {
  if (isObj(structured)) {
    if (isObj(structured.structuredContent)) return structured.structuredContent
    return structured
  }
  const tryParse = (s: string): Obj | undefined => {
    try {
      const v = JSON.parse(s)
      return isObj(v) ? v : undefined
    } catch {
      return undefined
    }
  }
  const whole = tryParse(text.trim())
  if (whole) return whole
  const start = text.indexOf("{")
  const end = text.lastIndexOf("}")
  return start >= 0 && end > start ? tryParse(text.slice(start, end + 1)) : undefined
}

function findString(o: Obj | undefined, ...keys: string[]): string | undefined {
  if (!o) return undefined
  for (const k of keys) if (typeof o[k] === "string") return o[k] as string
  for (const nest of ["plan", "shot", "result", "capture"]) {
    const inner = o[nest]
    if (isObj(inner)) for (const k of keys) if (typeof inner[k] === "string") return inner[k] as string
  }
  return undefined
}

function findFiles(o: Obj | undefined): string[] {
  if (!o) return []
  for (const k of ["files", "frames", "paths"]) {
    const v = o[k]
    if (Array.isArray(v)) return v.filter((x): x is string => typeof x === "string")
  }
  const inner = o.capture ?? o.result
  return isObj(inner) ? findFiles(inner) : []
}

export class MessageMapper {
  /** tool_use_id -> { full tool name, input } */
  private readonly toolUses = new Map<string, { name: string; input: Obj }>()
  sessionId: string | undefined
  sawResult = false

  constructor(
    private readonly emit: (e: AgentEvent) => void,
    /** Extra fields for the first session event (the checkpoint). */
    private readonly sessionExtra: { checkpointRef?: string } = {},
  ) {}

  private sessionEmitted = false

  /** Emit the session event once. */
  emitSession(sessionId: string): void {
    if (this.sessionEmitted) return
    this.sessionEmitted = true
    this.sessionId = sessionId
    const e: AgentEvent = { type: "session", sessionId }
    if (this.sessionExtra.checkpointRef) e.checkpointRef = this.sessionExtra.checkpointRef
    this.emit(e)
  }

  get hasEmittedSession(): boolean {
    return this.sessionEmitted
  }

  handle(msg: unknown): void {
    if (!isObj(msg)) return
    switch (msg.type) {
      case "system":
        if (msg.subtype === "init" && typeof msg.session_id === "string") this.emitSession(msg.session_id)
        return
      case "assistant":
        return this.assistant(msg)
      case "user":
        return this.user(msg)
      case "result":
        return this.result(msg)
      case "stream_event":
        return this.streamEvent(msg)
      default:
        return
    }
  }

  /** A partial message (includePartialMessages): text deltas become "text-delta" events; everything else is ignored. */
  private streamEvent(msg: Obj): void {
    if (msg.parent_tool_use_id) return
    const event = isObj(msg.event) ? msg.event : undefined
    if (event?.type !== "content_block_delta" || !isObj(event.delta)) return
    if (event.delta.type === "text_delta" && typeof event.delta.text === "string" && event.delta.text) {
      this.emit({ type: "text-delta", text: event.delta.text })
    }
  }

  private assistant(msg: Obj): void {
    if (typeof msg.session_id === "string" && !this.sessionEmitted) this.emitSession(msg.session_id)
    if (typeof msg.error === "string") {
      this.emit({ type: "error", message: `Claude API error: ${msg.error}` })
    }
    // Subagent frames are not expected (no Agent tool), but skip them if they come.
    if (msg.parent_tool_use_id) return
    const message = isObj(msg.message) ? msg.message : undefined
    const content = Array.isArray(message?.content) ? message.content : []
    for (const block of content) {
      if (!isObj(block)) continue
      if (block.type === "text" && typeof block.text === "string" && block.text.trim()) {
        this.emit({ type: "text", text: block.text })
      } else if (block.type === "tool_use" && typeof block.name === "string") {
        const input = isObj(block.input) ? block.input : {}
        if (typeof block.id === "string") this.toolUses.set(block.id, { name: block.name, input })
        const river = riverToolName(block.name)
        const summary = river ? summarizeToolCall(river, input) : (BUILTIN_SUMMARY[block.name]?.(input) ?? block.name)
        this.emit({ type: "tool", tool: displayName(block.name), summary })
      }
    }
  }

  private user(msg: Obj): void {
    if (msg.parent_tool_use_id) return
    const message = isObj(msg.message) ? msg.message : undefined
    const content = Array.isArray(message?.content) ? message.content : []
    const results = content.filter((b): b is Obj => isObj(b) && b.type === "tool_result")
    for (const block of results) {
      const use = typeof block.tool_use_id === "string" ? this.toolUses.get(block.tool_use_id) : undefined
      const name = use?.name ?? "unknown"
      const tool = displayName(name)
      const ok = block.is_error !== true
      const text = toolResultText(block.content)
      this.emit({ type: "tool-result", tool, ok, summary: firstLine(text) || (ok ? "ok" : "failed") })
      if (!ok) continue
      // tool_use_result is the structured result when exactly one tool result is in this message.
      const structured = results.length === 1 ? msg.tool_use_result : undefined
      if (tool === "plan_save") {
        const data = parseResult(text, structured)
        // river-mcp text: "Saved draft plan p_xxx: <title>. ..."
        const planId =
          findString(data, "planId", "id") ?? text.match(/\bplan (p_[A-Za-z0-9_-]+)/)?.[1] ?? text.match(/\bp_[A-Za-z0-9_-]+/)?.[0]
        if (planId) this.emit({ type: "plan-saved", planId })
      } else if (tool === "frames_capture") {
        const data = parseResult(text, structured)
        const shotId = findString(data, "shotId", "shot", "id") ?? (typeof use?.input.shotId === "string" ? use.input.shotId : undefined)
        let files = findFiles(data)
        // river-mcp text: "Captured <shot> at rev <rev> (n frames):" then one absolute PNG path per line.
        if (files.length === 0) files = text.split(/\r?\n/).map((l) => l.trim()).filter((l) => /\.png$/i.test(l))
        if (shotId) this.emit({ type: "capture", shotId, files })
      }
    }
  }

  private result(msg: Obj): void {
    this.sawResult = true
    if (typeof msg.session_id === "string" && !this.sessionEmitted) this.emitSession(msg.session_id)
    const costUsd = typeof msg.total_cost_usd === "number" ? msg.total_cost_usd : undefined
    const turns = typeof msg.num_turns === "number" ? msg.num_turns : undefined
    if (msg.subtype !== "success" || msg.is_error === true) {
      const errors = Array.isArray(msg.errors) ? msg.errors.filter((e): e is string => typeof e === "string") : []
      const reason = errors.join("; ") || (typeof msg.result === "string" ? msg.result : "") || String(msg.subtype)
      this.emit({ type: "error", message: `Turn ended with ${String(msg.subtype)}: ${reason}` })
    }
    const done: AgentEvent = { type: "done" }
    if (costUsd !== undefined) done.costUsd = costUsd
    if (turns !== undefined) done.turns = turns
    this.emit(done)
  }
}
