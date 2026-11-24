/**
 * The Agent chat's items and how streamed text lands in them. Kept apart from the view so it can be tested without
 * React or Electron.
 *
 * The agent sends a block of assistant text twice: piece by piece as "text-delta" events while the model writes it,
 * then whole as one "text" event. The deltas build a streaming item; the whole block then replaces what the deltas
 * wrote (so nothing is doubled) and the item stops streaming. Consecutive blocks with nothing in between join one
 * item, as they did before streaming.
 */
import type { AgentMode, PermissionRequest } from "@river/agent"

export type CheckpointState = "idle" | "confirm" | "restoring" | "restored"

export interface AssistantItem {
  kind: "assistant"
  text: string
  /** Deltas are still arriving for the current block. */
  streaming?: boolean
  /** Where the current block starts in `text`: the final "text" event replaces everything after it. */
  streamFrom?: number
}

export type ChatItem =
  | { kind: "user"; text: string; mode: AgentMode }
  | AssistantItem
  | { kind: "tool"; tool: string; summary: string; ok?: boolean }
  | { kind: "permission"; request: PermissionRequest; decided?: "allow" | "deny" }
  | { kind: "checkpoint"; ref: string; state: CheckpointState; error?: string }
  | { kind: "note"; text: string }
  | { kind: "error"; text: string }

const settled = (text: string): AssistantItem => ({ kind: "assistant", text })

/** A "text-delta" event: grow the streaming item, or start one (joining a finished assistant item right before it). */
export function withDelta(items: readonly ChatItem[], delta: string): ChatItem[] {
  if (!delta) return items as ChatItem[]
  const last = items[items.length - 1]
  if (last?.kind === "assistant") {
    const streamFrom = last.streaming ? (last.streamFrom ?? 0) : last.text.length
    return [...items.slice(0, -1), { kind: "assistant", text: last.text + delta, streaming: true, streamFrom }]
  }
  return [...items, { kind: "assistant", text: delta, streaming: true, streamFrom: 0 }]
}

/** A whole "text" block: it replaces the deltas streamed for it, or joins the assistant item before it. */
export function withText(items: readonly ChatItem[], text: string): ChatItem[] {
  const last = items[items.length - 1]
  if (last?.kind === "assistant") {
    const base = last.streaming ? last.text.slice(0, last.streamFrom ?? 0) : last.text
    return [...items.slice(0, -1), settled(base + text)]
  }
  return [...items, settled(text)]
}

/** The turn ended (done, error or stopped): an item still streaming keeps what arrived and stops streaming. */
export function endStreaming(items: readonly ChatItem[]): ChatItem[] {
  if (!items.some((x) => x.kind === "assistant" && x.streaming)) return items as ChatItem[]
  return items.map((x) => (x.kind === "assistant" && x.streaming ? settled(x.text) : x))
}
