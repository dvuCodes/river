import { useCallback, useEffect, useRef, useState } from "react"
import type { AgentBackend, AgentEvent, AgentMode, AgentModel, PermissionRequest } from "@river/agent"
import { modelLabel, modelOptions } from "../models"
import type { AgentStatus } from "../../../shared/api"
import { cx, errorText, useSmokeReady } from "../util"
import { type ChatItem, endStreaming, withDelta, withText } from "./agentChat"

export type { ChatItem }

/** Concept and writer turns run as jobs from the canvas, never in this chat. */
type ChatMode = Exclude<AgentMode, "concept" | "writer">

export interface AgentContext {
  mode: ChatMode
  threadId?: string | undefined
  planId?: string | undefined
}

/** Conversation state lives in App so it survives switching views. */
export function useAgentSession() {
  const [items, setItems] = useState<ChatItem[]>([])
  const [turnId, setTurnId] = useState<string | null>(null)
  /**
   * One agent session per mode: a story chat, a plan and an implementation are unrelated work, so switching the mode
   * starts (or goes back to) that mode's own conversation instead of carrying another mode's context into it.
   */
  const [sessionByMode, setSessionByMode] = useState<Partial<Record<ChatMode, string>>>({})
  const turnRef = useRef<string | null>(null)
  turnRef.current = turnId
  /** The mode of the turn running now: its session id is kept under that mode, whatever tab is showing when it arrives. */
  const turnModeRef = useRef<ChatMode>("story")

  useEffect(() => {
    const push = (item: ChatItem) => setItems((xs) => [...xs, item])
    const offEvent = window.river.onAgentEvent(({ turnId: t, event }) => {
      if (t !== turnRef.current) return
      const e = event as AgentEvent
      switch (e.type) {
        case "session": {
          const mode = turnModeRef.current
          setSessionByMode((m) => ({ ...m, [mode]: e.sessionId }))
          if (e.checkpointRef) push({ kind: "checkpoint", ref: e.checkpointRef, state: "idle" })
          break
        }
        case "text-delta":
          setItems((xs) => withDelta(xs, e.text))
          break
        case "text":
          setItems((xs) => withText(xs, e.text))
          break
        case "tool":
          push({ kind: "tool", tool: e.tool, summary: e.summary })
          break
        case "tool-result":
          push({ kind: "tool", tool: e.tool, summary: e.summary, ok: e.ok })
          break
        case "plan-saved":
          push({ kind: "note", text: `Plan saved as draft: ${e.planId}. Review it in Frames.` })
          break
        case "capture":
          push({ kind: "note", text: `Captured ${e.shotId}: ${e.files.length} frame(s).` })
          break
        case "done":
          setItems(endStreaming)
          push({ kind: "note", text: `Turn finished${e.turns !== undefined ? ` · ${e.turns} turns` : ""}${e.costUsd !== undefined ? ` · $${e.costUsd.toFixed(4)}` : ""}.` })
          setTurnId(null)
          break
        case "error":
          setItems(endStreaming)
          push({ kind: "error", text: e.message })
          setTurnId(null)
          break
      }
    })
    const offPerm = window.river.onAgentPermission(({ turnId: t, request }) => {
      if (t === turnRef.current) push({ kind: "permission", request })
    })
    return () => {
      offEvent()
      offPerm()
    }
  }, [])

  const start = useCallback(
    async (prompt: string, model: AgentModel, ctx: AgentContext, storyFile: string | undefined) => {
      setItems((xs) => [...xs, { kind: "user", text: prompt, mode: ctx.mode }])
      const id = crypto.randomUUID()
      turnRef.current = id
      turnModeRef.current = ctx.mode
      setTurnId(id)
      const sessionId = sessionByMode[ctx.mode]
      try {
        await window.river.agentStart({
          turnId: id,
          mode: ctx.mode,
          model,
          prompt,
          ...(storyFile ? { storyFile } : {}),
          ...(ctx.threadId ? { threadId: ctx.threadId } : {}),
          ...(ctx.planId ? { planId: ctx.planId } : {}),
          ...(sessionId ? { sessionId } : {}),
        })
      } catch (err) {
        turnRef.current = null
        setTurnId(null)
        setItems((xs) => [...xs, { kind: "error", text: errorText(err) }])
      }
    },
    [sessionByMode],
  )

  const decide = useCallback(async (index: number, request: PermissionRequest, allow: boolean) => {
    setItems((xs) => xs.map((x, i) => (i === index && x.kind === "permission" ? { ...x, decided: allow ? "allow" : "deny" } : x)))
    await window.river.agentRespond(request.id, allow ? { behavior: "allow" } : { behavior: "deny", message: "The user rejected this change." })
  }, [])

  const setCheckpoint = useCallback((index: number, patch: Partial<Extract<ChatItem, { kind: "checkpoint" }>>) => {
    setItems((xs) => xs.map((x, i) => (i === index && x.kind === "checkpoint" ? { ...x, ...patch } : x)))
  }, [])

  const restore = useCallback(
    async (index: number, ref: string) => {
      setCheckpoint(index, { state: "restoring" })
      try {
        await window.river.restoreCheckpoint(ref)
        setCheckpoint(index, { state: "restored" })
      } catch (err) {
        setCheckpoint(index, { state: "idle", error: errorText(err) })
      }
    },
    [setCheckpoint],
  )

  const stop = useCallback(() => {
    if (turnId) void window.river.agentAbort(turnId)
    // The turn's own done/error is ignored once it is no longer the running turn, so stop the streaming here.
    setItems(endStreaming)
    setTurnId(null)
  }, [turnId])

  const reset = useCallback(() => {
    setItems([])
    setSessionByMode({})
  }, [])

  return { items, running: turnId !== null, sessionByMode, start, decide, setCheckpoint, restore, stop, reset }
}

export type AgentSession = ReturnType<typeof useAgentSession>

const MODE_INFO: Record<ChatMode, { label: string; blurb: string }> = {
  story: { label: "Story", blurb: "Drafts and edits passages. Every write asks you first, and the turn starts with a git checkpoint." },
  plan: { label: "Plan", blurb: "Read-only on game files. Answers a review thread with a draft change plan for you to approve." },
  implement: { label: "Implement", blurb: "Runs an approved plan. It may edit only the files the plan names, then recaptures its shots." },
}

function Diff({ text }: { text: string }) {
  return (
    <pre className="diff mono">
      {text.split("\n").map((l, i) => (
        <span key={i} className={cx(l.startsWith("+") && !l.startsWith("+++") && "d-add", l.startsWith("-") && !l.startsWith("---") && "d-del", l.startsWith("@@") && "d-hunk")}>
          {l + "\n"}
        </span>
      ))}
    </pre>
  )
}

/** Plain-text backend names (no logos). */
export const BACKEND_LABEL: Record<AgentBackend, string> = {
  "claude-code": "Claude Code (your Claude sign-in)",
  "api-key": "Anthropic API key",
}

const PLAN_NAME: Record<string, string> = { max: "Max", pro: "Pro", team: "Team", enterprise: "Enterprise", free: "Free" }

/** One line about the Claude Code sign-in, e.g. "Signed in · Max plan". */
export function claudeCodeLine(s: AgentStatus["claudeCode"]): string {
  if (!s) return "Checking Claude Code…"
  if (!s.installed) return "Claude Code not found"
  if (!s.loggedIn) return "Not signed in"
  const plan = s.subscriptionType ? `${PLAN_NAME[s.subscriptionType] ?? s.subscriptionType} plan` : s.authMethod === "claude.ai" ? "Claude account" : (s.authMethod ?? "")
  return plan ? `Signed in · ${plan}` : "Signed in"
}

export function AgentView(props: {
  session: AgentSession
  status: AgentStatus | null
  onStatus(s: AgentStatus): void
  ctx: AgentContext
  setCtx(c: AgentContext): void
  storyRel: string | undefined
  onSettings(): void
}) {
  const { session, status, onStatus, ctx, setCtx, storyRel, onSettings } = props
  const [model, setModel] = useState<AgentModel>(status?.model ?? "claude-opus-5-5")
  const statusModel = status?.model
  useEffect(() => {
    if (statusModel) setModel(statusModel)
  }, [statusModel])
  const pickModel = (m: AgentModel) => {
    setModel(m)
    void window.river.setAgentPrefs({ model: m }).then(onStatus, () => {})
  }
  const [prompt, setPrompt] = useState("")
  const log = useRef<HTMLDivElement>(null)
  useSmokeReady("agent", status !== null)

  useEffect(() => {
    log.current?.scrollTo({ top: log.current.scrollHeight })
  }, [session.items])

  const backend = status?.backend ?? "api-key"
  const cc = status?.claudeCode
  const blocked = !status?.available
    ? "unavailable"
    : backend === "api-key" && !status.hasKey
      ? "nokey"
      : backend === "claude-code" && !(cc?.installed && cc.loggedIn)
        ? "nosignin"
        : ctx.mode === "implement" && !ctx.planId
          ? "noplan"
          : null
  const send = () => {
    const text = prompt.trim() || (ctx.mode === "plan" ? "Answer this review thread with a change plan." : ctx.mode === "implement" ? "Run the approved plan." : "")
    if (!text || blocked || session.running) return
    setPrompt("")
    void session.start(text, model, ctx, storyRel)
  }

  return (
    <div className="view">
      <div className="toolbar">
        <span className="tb-label">Agent</span>
        <div className="seg" role="tablist" aria-label="Mode">
          {(Object.keys(MODE_INFO) as ChatMode[]).map((m) => (
            <button key={m} role="tab" aria-selected={ctx.mode === m} className={cx("seg-btn", ctx.mode === m && "is-on")} onClick={() => setCtx({ mode: m, threadId: m === "plan" ? ctx.threadId : undefined, planId: m === "implement" ? ctx.planId : undefined })}>
              {MODE_INFO[m].label}
            </button>
          ))}
        </div>
        <label className="tb-field">
          <span className="tb-label">Model</span>
          <select value={model} onChange={(e) => pickModel(e.target.value as AgentModel)}>
            {modelOptions(status?.knownModels, model).map((m) => (
              <option key={m} value={m}>
                {modelLabel(m)}
              </option>
            ))}
          </select>
        </label>
        <div className="tb-spacer" />
        {session.items.length > 0 && !session.running && (
          <button className="btn" onClick={session.reset}>
            New conversation
          </button>
        )}
        <button className="chip chip-btn" onClick={onSettings} title="Change the backend in Settings">
          {backend === "claude-code" ? "Claude Code" : "API key"}
          {backend === "claude-code" && cc ? ` · ${claudeCodeLine(cc)}` : ""}
        </button>
      </div>
      <div className="agentview">
        <div className="chat">
          <div className="chat-log" ref={log}>
            {status && !status.available && (
              <div className="banner banner-warn">
                <b>Agent unavailable.</b> {status.reason} The rest of River works without it.
              </div>
            )}
            {blocked === "nokey" && (
              <div className="banner">
                Add an Anthropic API key to talk to the agent. It is encrypted with the system keychain and never leaves the main process.{" "}
                <button className="link-btn" onClick={onSettings}>
                  Add key
                </button>
              </div>
            )}
            {blocked === "nosignin" && (
              <div className="banner">
                {claudeCodeLine(cc ?? null)}. River runs your own Claude Code; sign in to it, or switch to an API key.{" "}
                <button className="link-btn" onClick={onSettings}>
                  Open settings
                </button>
              </div>
            )}
            {session.items.length === 0 && (
              <div className="chat-empty">
                <h2>{MODE_INFO[ctx.mode].label} mode</h2>
                <p>{MODE_INFO[ctx.mode].blurb}</p>
                <ul className="mode-cards">
                  {(Object.keys(MODE_INFO) as ChatMode[]).map((m) => (
                    <li key={m} className={cx(ctx.mode === m && "is-on")}>
                      <b>{MODE_INFO[m].label}</b>
                      <span>{MODE_INFO[m].blurb}</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
            {session.items.map((it, i) => {
              switch (it.kind) {
                case "user":
                  return (
                    <div key={i} className="msg msg-user">
                      <span className="msg-mode">{it.mode}</span>
                      {it.text}
                    </div>
                  )
                case "assistant":
                  return (
                    <div key={i} className={cx("msg msg-agent", it.streaming && "is-streaming")} aria-busy={it.streaming || undefined}>
                      {it.text}
                    </div>
                  )
                case "tool":
                  return (
                    <div key={i} className={cx("tool-line mono", it.ok === false && "is-fail")}>
                      <span className="tool-name">{it.tool}</span> {it.summary}
                      {it.ok !== undefined && <span className="tool-ok">{it.ok ? "ok" : "failed"}</span>}
                    </div>
                  )
                case "permission":
                  return (
                    <div key={i} className={cx("approval", it.decided && `is-${it.decided}`)}>
                      <header>
                        <span className="approval-k">Approval needed</span>
                        <span className="mono approval-tool">{it.request.tool}</span>
                      </header>
                      <p className="approval-sum">{it.request.summary}</p>
                      {it.request.diff && <Diff text={it.request.diff} />}
                      <footer>
                        {it.decided ? (
                          <span className="approval-done">{it.decided === "allow" ? "Approved" : "Rejected"}</span>
                        ) : (
                          <>
                            <button className="btn" onClick={() => void session.decide(i, it.request, false)}>
                              Reject
                            </button>
                            <button className="btn btn-primary" onClick={() => void session.decide(i, it.request, true)}>
                              Approve
                            </button>
                          </>
                        )}
                      </footer>
                    </div>
                  )
                case "checkpoint":
                  return (
                    <div key={i} className="checkpoint">
                      <span className="cp-k">Checkpoint</span>
                      <span className="mono cp-ref">{it.ref}</span>
                      <span className="tb-spacer" />
                      {it.state === "idle" && (
                        <button className="btn" disabled={session.running} onClick={() => session.setCheckpoint(i, { state: "confirm" })}>
                          Undo turn
                        </button>
                      )}
                      {it.state === "confirm" && (
                        <span className="cp-confirm">
                          Restore the game files to before this turn? River's own review threads, plans and boards (.river/) are kept.
                          <button className="btn" onClick={() => session.setCheckpoint(i, { state: "idle" })}>
                            Cancel
                          </button>
                          <button className="btn btn-danger" onClick={() => void session.restore(i, it.ref)}>
                            Restore
                          </button>
                        </span>
                      )}
                      {it.state === "restoring" && <span className="sec-hint">Restoring…</span>}
                      {it.state === "restored" && <span className="cp-done">Files restored</span>}
                      {it.error && <span className="err-note">{it.error}</span>}
                    </div>
                  )
                case "note":
                  return (
                    <div key={i} className="note-line">
                      {it.text}
                    </div>
                  )
                case "error":
                  return (
                    <div key={i} className="banner banner-err">
                      {it.text}
                    </div>
                  )
              }
            })}
            {session.running && !(session.items.at(-1)?.kind === "assistant" && (session.items.at(-1) as { streaming?: boolean }).streaming) && <div className="typing">working…</div>}
          </div>
          <form
            className="composer"
            onSubmit={(e) => {
              e.preventDefault()
              send()
            }}
          >
            <div className="composer-ctx">
              <span className={cx("ctx-pill", `mode-${ctx.mode}`)}>{MODE_INFO[ctx.mode].label}</span>
              {storyRel && ctx.mode === "story" && <span className="ctx-pill mono">{storyRel}</span>}
              {ctx.threadId && <span className="ctx-pill mono">thread {ctx.threadId}</span>}
              {ctx.planId && <span className="ctx-pill mono">plan {ctx.planId}</span>}
              {blocked === "noplan" && <span className="sec-hint">Pick an approved plan in Frames → “Run approved plan”.</span>}
              {session.sessionByMode[ctx.mode] && <span className="sec-hint">continuing session</span>}
            </div>
            <textarea
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
                  e.preventDefault()
                  send()
                }
              }}
              placeholder={ctx.mode === "story" ? "Ask for a new branch, a rewrite, a fix for a lint problem…" : ctx.mode === "plan" ? "Anything to add for the planner (optional)…" : "Notes for the implementer (optional)…"}
              rows={3}
              disabled={Boolean(blocked)}
            />
            <div className="composer-foot">
              <span className="sec-hint">Ctrl+Enter to send</span>
              {session.running ? (
                <button type="button" className="btn btn-danger" onClick={session.stop}>
                  Stop
                </button>
              ) : (
                <button className="btn btn-primary" disabled={Boolean(blocked)}>
                  Send
                </button>
              )}
            </div>
          </form>
        </div>
      </div>
    </div>
  )
}
