import { Handle, type Node, type NodeProps, NodeResizeControl, Position, ResizeControlVariant } from "@xyflow/react"
import { type ReactNode, createContext, memo, useContext, useEffect, useRef, useState } from "react"
import type { Card, Mark } from "@river/core"
import type { CardDTO, ConceptJob, ImageSize } from "../../../shared/api"
import { cx } from "../util"
import { type Pt, arrowPath, bounds, markBox, pointsOf, smoothPath, strokesOf } from "./geometry"

export const ME = "you"

export type CardNode = Node<{ dto: CardDTO }, "card">
export type MarkNode = Node<{ mark: Mark }, "mark">
export type BoardNode = CardNode | MarkNode

export interface CanvasActions {
  editText(id: string, text: string): void
  resize(id: string, w: number): void
  /** Read the card from disk again. */
  refresh(id: string): void
  fail(err: unknown): void
  /** Open the review of a job's scripts. */
  review(jobId: string): void
  /** Ask why not, then dismiss a job's whole answer. */
  dismissJob(jobId: string): void
}
export const Actions = createContext<CanvasActions | null>(null)

/** Edges need a handle on both ends; connectors are drawn from the node boxes, so the handles stay invisible. */
function Anchors() {
  return (
    <>
      <Handle type="target" position={Position.Top} isConnectable={false} className="anchor" />
      <Handle type="source" position={Position.Bottom} isConnectable={false} className="anchor" />
    </>
  )
}

// ---------- cards ----------

const aspect = (size: ImageSize | undefined) => (size ? { aspectRatio: `${size.w} / ${size.h}` } : undefined)

/** Until it loads, the image keeps the size its header gave, so the card does not change height while images stream in. */
function CardImage({ url, size, alt }: { url: string | undefined; size: ImageSize | undefined; alt: string }) {
  const [state, setState] = useState<"loading" | "ok" | "failed">("loading")
  useEffect(() => setState("loading"), [url])
  if (!url || state === "failed") return <div className="cnode-img-missing" style={aspect(size)}>{state === "failed" ? "Image not found" : "No image yet"}</div>
  return (
    <img
      className="cnode-img"
      src={url}
      alt={alt}
      draggable={false}
      loading="lazy"
      decoding="async"
      style={state === "ok" ? undefined : aspect(size)}
      onLoad={() => setState("ok")}
      onError={() => setState("failed")}
    />
  )
}

function NoteBody({ id, text }: { id: string; text: string }) {
  const actions = useContext(Actions)!
  const [editing, setEditing] = useState(text === "")
  const [draft, setDraft] = useState(text)
  const area = useRef<HTMLTextAreaElement>(null)
  useEffect(() => {
    if (!editing) setDraft(text)
  }, [text, editing])
  useEffect(() => {
    const el = area.current
    if (!el) return
    el.style.height = "auto"
    el.style.height = `${el.scrollHeight}px`
  }, [draft, editing])
  // React Flow keeps a new node hidden until it has measured it, and a hidden textarea cannot take focus.
  useEffect(() => {
    if (!editing) return
    let frame = 0
    let tries = 0
    const focus = () => {
      const el = area.current
      if (!el || document.activeElement === el) return
      el.focus()
      if (document.activeElement !== el && tries++ < 20) frame = requestAnimationFrame(focus)
    }
    focus()
    return () => cancelAnimationFrame(frame)
  }, [editing])
  const finish = () => {
    setEditing(false)
    if (draft !== text) actions.editText(id, draft)
  }
  // Switching view or board, or culling, unmounts the note without a blur: save what was typed.
  const unsaved = useRef<string | null>(null)
  unsaved.current = editing && draft !== text ? draft : null
  useEffect(
    () => () => {
      if (unsaved.current !== null) actions.editText(id, unsaved.current)
    },
    [actions, id],
  )
  if (!editing) {
    return (
      <div className="note-text" onDoubleClick={() => setEditing(true)}>
        {text || <span className="note-empty">Double-click to write</span>}
      </div>
    )
  }
  return (
    <textarea
      ref={area}
      className="note-text note-input nodrag nowheel"
      value={draft}
      placeholder="Write a note…"
      rows={2}
      onFocus={(e) => e.currentTarget.setSelectionRange(e.currentTarget.value.length, e.currentTarget.value.length)}
      onBlur={finish}
      onChange={(e) => setDraft(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === "Escape" || (e.key === "Enter" && (e.ctrlKey || e.metaKey))) {
          e.preventDefault()
          e.currentTarget.blur()
        }
      }}
    />
  )
}

type ConceptView = Extract<CardDTO["view"], { kind: "concept" }>

/** Jobs whose answer has a note card on the board: that note carries the job's actions, so its option cards do not. */
export const AnswerNotes = createContext<ReadonlySet<string>>(new Set())

function useJobAction(cardId: string) {
  const actions = useContext(Actions)!
  const [busy, setBusy] = useState(false)
  const act = (fn: () => Promise<unknown>) => {
    setBusy(true)
    fn()
      .catch(actions.fail)
      .finally(() => {
        setBusy(false)
        actions.refresh(cardId)
      })
  }
  return { busy, act }
}

/** The answer as a whole: what the job is doing, and Review / Accept / Revise / Dismiss. */
function JobBar({ job, cardId }: { job: ConceptJob; cardId: string }) {
  const actions = useContext(Actions)!
  const { busy, act } = useJobAction(cardId)
  const scripts = job.scripts ?? []
  const rendered = scripts.filter((s) => s.render?.ok).length
  const failed = scripts.filter((s) => s.render && !s.render.ok).length
  let line: ReactNode
  switch (job.status) {
    case "queued":
    case "running":
      line = <p className="job-line is-working">✦ The concept artist is drawing…</p>
      break
    case "approval":
      line = <p className="job-line">✦ {scripts.length > 1 ? `${scripts.length} scripts are` : "A script is"} waiting for you to review</p>
      break
    case "rendering":
      line = <p className="job-line is-working">Running the approved scripts in Godot…</p>
      break
    case "answered":
      line = failed > 0 ? <p className="job-line">{rendered} rendered, {failed} failed to render</p> : null
      break
    case "failed":
      line = <p className="cnode-missing concept-error nodrag nowheel">{job.error ?? "The job failed."}</p>
      break
    default:
      line = null
  }
  const open = job.status !== "accepted" && job.status !== "dismissed"
  if (!open && !job.revisable) return null
  return (
    <div className="job-bar" data-job-status={job.status}>
      {line}
      <div className="concept-actions">
        {job.status === "approval" && (
          <button className="btn btn-primary nodrag" data-action="review" onClick={() => actions.review(job.id)}>
            Review {scripts.length > 1 ? `${scripts.length} scripts` : "script"}
          </button>
        )}
        {job.status === "answered" && rendered > 0 && (
          <button className="btn btn-primary nodrag" data-action="accept" disabled={busy} onClick={() => act(() => window.river.jobAccept(job.id))}>
            {rendered > 1 ? "Accept all" : "Accept"}
          </button>
        )}
        {job.revisable && (
          <button className="btn nodrag" data-action="revise" disabled={busy} title="Answer your replies on the mark with a new set of options" onClick={() => act(() => window.river.jobRevise(job.id))}>
            Revise
          </button>
        )}
        {open && (
          <button className="btn nodrag" data-action="dismiss" disabled={busy} onClick={() => actions.dismissJob(job.id)}>
            Dismiss
          </button>
        )}
      </div>
    </div>
  )
}

/** One option of a job's answer: its own progress, its render or the error Godot gave, and Keep. */
function ConceptBody({ card, view, frame }: { card: Card; view: ConceptView; frame(content: ReactNode): ReactNode }) {
  const notes = useContext(AnswerNotes)
  const { busy, act } = useJobAction(card.id)
  const jobId = card.pending?.jobId
  const image = <CardImage url={view.url} size={view.size} alt={card.caption ?? `Concept ${view.id}`} />
  if (!jobId) return frame(image)
  if (view.missing || !view.job) return <p className="cnode-missing">{view.missing ?? "The job is missing."}</p>
  const job = view.job
  const script = job.scripts?.find((s) => s.variant === card.variant)
  const placeholder = (text: string, working = true) => frame(<div className={cx("concept-wait", working && "is-working")}>{text}</div>)
  // Keeping one option accepts just it; the job's own Accept takes all of them.
  const keepable = job.status === "answered" && script?.render?.ok && card.variant && (job.scripts ?? []).length > 1
  const keep = keepable && (
    <button className="keep-chip nodrag" data-action="keep" disabled={busy} title="Accept only this option" onClick={() => act(() => window.river.jobAccept(job.id, [card.variant!]))}>
      Keep {card.label ?? card.variant!.toUpperCase()}
    </button>
  )
  let body: ReactNode
  if (script?.render && !script.render.ok) {
    body = frame(
      <div className="render-error nodrag nowheel">
        <b>Godot could not render this option</b>
        <pre>{script.render.error}</pre>
      </div>,
    )
  } else
    switch (job.status) {
      case "queued":
      case "running":
        body = placeholder("✦ drawing…")
        break
      case "approval":
        body = placeholder("Waiting for you to review the script", false)
        break
      case "rendering":
        body = script?.render?.ok ? frame(image) : placeholder("Rendering in Godot…")
        break
      case "failed":
        body = placeholder("No render", false)
        break
      default:
        body = frame(
          <>
            {image}
            {keep}
          </>,
        )
    }
  return (
    <div className="concept" data-job-status={job.status} data-variant={card.variant ?? ""}>
      {body}
      {!notes.has(job.id) && <JobBar job={job} cardId={card.id} />}
    </div>
  )
}

function hostOf(url: string): string {
  try {
    return new URL(url).host.replace(/^www\./, "") || url
  } catch {
    return url
  }
}

/** The line under an image card: the card's own caption, else what the card shows, with the licence for a reference. */
function captionOf(card: Card, view: CardDTO["view"]): ReactNode {
  if (card.caption) return card.caption
  switch (view.kind) {
    case "ref": {
      const from = [card.source?.url && hostOf(card.source.url), card.source?.licence ?? "no licence"].filter(Boolean).join(", ")
      return `${card.source?.title ?? "Reference"} (${from})`
    }
    case "frame":
      return (
        <>
          <span className="mono">{view.shotId}</span>
          {view.rev && <span className="mono"> · {view.rev}</span>}
          {view.missing && <span> · {view.missing}</span>}
        </>
      )
    case "concept":
      return <span className="mono">concepts/{view.id}/</span>
    default:
      return null
  }
}

function Star({ by }: { by: string }) {
  return (
    <span className="star" title={`Made by ${by}`}>
      ✦
    </span>
  )
}

export const CardView = memo(function CardView({ id, data, selected }: NodeProps<CardNode>) {
  const actions = useContext(Actions)!
  const { card, view } = data.dto
  const agent = card.madeBy !== ME
  const pending = Boolean(card.pending)
  const badge = card.label && <span className="cnode-badge">{card.label}</span>
  const frame = (content: ReactNode) => (
    <div className="cnode-frame">
      {content}
      {badge}
    </div>
  )
  let body: ReactNode
  switch (view.kind) {
    case "note":
      body = (
        <>
          {agent && <Star by={card.madeBy} />}
          <NoteBody id={id} text={card.text ?? ""} />
          {view.job && <JobBar job={view.job} cardId={id} />}
          {pending && <span className="cnode-pending-tag">pending</span>}
        </>
      )
      break
    case "passage":
      body = (
        <>
          <div className="cnode-passage-body">
            <div className="cnode-title">
              {agent && <Star by={card.madeBy} />} {view.title}
            </div>
            {view.tags.length > 0 && (
              <div className="cnode-tags">
                {view.tags.map((t) => (
                  <span key={t} className="chip">
                    {t}
                  </span>
                ))}
              </div>
            )}
            {view.lines.map((l, i) => (
              <p key={i} className="cnode-line">
                {l}
              </p>
            ))}
            {view.missing && <p className="cnode-missing">{view.missing}</p>}
          </div>
          <div className="cnode-cap">
            passage · <span className="mono">{view.story.split("/").pop()}</span>
          </div>
        </>
      )
      break
    default: {
      const caption = captionOf(card, view)
      body = (
        <>
          {view.kind === "concept" ? <ConceptBody card={card} view={view} frame={frame} /> : frame(<CardImage url={view.url} size={view.size} alt={card.caption ?? card.source?.title ?? view.kind} />)}
          {caption && (
            <div className="cnode-cap" title={card.source?.url}>
              {agent && <Star by={card.madeBy} />} {caption}
            </div>
          )}
        </>
      )
    }
  }
  const imageLike = view.kind === "ref" || view.kind === "frame" || view.kind === "concept"
  return (
    <div className={cx("cnode", `cnode-${card.kind}`, imageLike && "cnode-image", agent ? "by-agent" : "by-you", selected && "is-selected", pending && "is-pending")}>
      <Anchors />
      {selected && (
        <NodeResizeControl
          position="right"
          variant={ResizeControlVariant.Line}
          className="cnode-resize"
          minWidth={120}
          maxWidth={1200}
          onResizeEnd={(_e, p) => actions.resize(id, p.width)}
        />
      )}
      {body}
    </div>
  )
})

// ---------- marks ----------

function markD(m: Pick<Mark, "shape" | "path" | "breaks">): string {
  switch (m.shape) {
    case "arrow":
      return arrowPath(m.path)
    case "circle":
      return smoothPath(pointsOf(m.path), true)
    case "pin":
      return ""
    default:
      return strokesOf(m.path, m.breaks)
        .map((s) => smoothPath(s))
        .join("")
  }
}

function PinGlyph({ x, y }: { x: number; y: number }) {
  return (
    <g transform={`translate(${x} ${y})`}>
      <path className="mark-pin" d="M0 0C-2 -6 -8 -10 -8 -16a8 8 0 0 1 16 0C8 -10 2 -6 0 0z" />
      <circle className="mark-pin-dot" cx={0} cy={-16} r={2.6} />
    </g>
  )
}

/** The ink of a mark. `hit` adds a wide invisible stroke (or the pin glyph) that takes the pointer; nothing else does. */
export function MarkShapeView({ m, selected, hit, link }: { m: Pick<Mark, "shape" | "path" | "breaks" | "madeBy">; selected?: boolean; hit?: boolean; link?: boolean }) {
  const cls = cx("mark", m.madeBy === ME ? "by-you" : "by-agent", selected && "is-selected", link && "is-link", hit && "is-hit")
  if (m.shape === "pin") {
    return (
      <g className={cls}>
        <PinGlyph x={m.path[0] ?? 0} y={m.path[1] ?? 0} />
      </g>
    )
  }
  const d = markD(m)
  return (
    <g className={cls}>
      {selected && <path className="mark-halo" d={d} />}
      <path className="mark-ink" d={d} />
      {hit && <path className="mark-hit" d={d} />}
    </g>
  )
}

function statusDotAt(m: Mark): Pt {
  if (m.shape === "pin") return [(m.path[0] ?? 0) + 7, (m.path[1] ?? 0) - 24]
  // On the stroke, at the point nearest the top-right corner of its bounds.
  const b = bounds(m.path)
  let best: Pt = [b.x + b.w, b.y]
  let bestD = Infinity
  for (const [px, py] of pointsOf(m.path)) {
    const d = Math.hypot(px - (b.x + b.w), py - b.y)
    if (d < bestD) {
      bestD = d
      best = [px, py]
    }
  }
  return best
}

/** A mark is a node whose box is its bounds; the box lets the pointer through to the cards under it, only the ink is hit. */
export const MarkView = memo(function MarkView({ data, selected }: NodeProps<MarkNode>) {
  const m = data.mark
  const b = markBox(m.shape, m.path)
  const [dx, dy] = statusDotAt(m)
  return (
    <>
      <Anchors />
      <svg className="mark-svg" width={b.w} height={b.h} viewBox={`${b.x} ${b.y} ${b.w} ${b.h}`} data-mark={m.id}>
        <MarkShapeView m={m} selected={selected} hit />
        <circle className={cx("mark-dot", `ms-${m.status}`)} cx={dx} cy={dy} r={4} />
      </svg>
    </>
  )
})

export function markNode(m: Mark, prev: BoardNode | undefined): MarkNode {
  if (prev?.type === "mark" && prev.data.mark === m) return prev
  const b = markBox(m.shape, m.path)
  return {
    id: m.id,
    type: "mark",
    position: { x: b.x, y: b.y },
    width: b.w,
    height: b.h,
    data: { mark: m },
    selected: prev?.selected ?? false,
    zIndex: 1,
    style: { pointerEvents: "none" },
  }
}

export function cardNode(dto: CardDTO, prev: BoardNode | undefined): CardNode {
  if (prev?.type === "card" && prev.data.dto === dto) return prev
  const n: CardNode = {
    id: dto.card.id,
    type: "card",
    position: { x: dto.card.x, y: dto.card.y },
    width: dto.card.w,
    data: { dto },
    selected: prev?.selected ?? false,
  }
  if (prev?.measured && prev.width === dto.card.w) n.measured = prev.measured
  return n
}
