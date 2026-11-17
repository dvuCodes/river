import { Handle, type Node, type NodeProps, NodeResizeControl, Position, ResizeControlVariant } from "@xyflow/react"
import { type ReactNode, createContext, memo, useContext, useEffect, useRef, useState } from "react"
import type { Card, Mark } from "@river/core"
import type { CardDTO, ImageSize, JobDTO } from "../../../shared/api"
import { cx } from "../util"
import { type Pt, arrowPath, bounds, markBox, pointsOf, smoothPath, strokesOf } from "./geometry"

export const ME = "you"

export type CardNode = Node<{ dto: CardDTO }, "card">
export type MarkNode = Node<{ mark: Mark }, "mark">
export type BoardNode = CardNode | MarkNode

export interface CanvasActions {
  editText(id: string, text: string): void
  resize(id: string, w: number): void
  /** Deletes the card; a pending agent card dismisses its job instead. */
  remove(id: string): void
  /** Read the card from disk again. */
  refresh(id: string): void
  fail(err: unknown): void
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

/** A concept card follows its job: drawing, waiting for the user to approve the script, rendering, then Accept or Dismiss. */
function ConceptBody({ card, view, frame }: { card: Card; view: ConceptView; frame(content: ReactNode): ReactNode }) {
  const actions = useContext(Actions)!
  const [script, setScript] = useState<JobDTO["script"] | null>(null)
  const [busy, setBusy] = useState(false)
  const jobId = card.pending?.jobId
  const status = view.job?.status
  useEffect(() => {
    if (status !== "approval") setScript(null)
  }, [status])
  const image = <CardImage url={view.url} size={view.size} alt={`Concept ${view.id}`} />
  if (!jobId) return frame(image)
  const act = (fn: () => Promise<unknown>) => {
    setBusy(true)
    fn()
      .catch(actions.fail)
      .finally(() => {
        setBusy(false)
        actions.refresh(card.id)
      })
  }
  const placeholder = (text: string) => frame(<div className="concept-wait">{text}</div>)
  // Variant cards of one job share its summary; the agent's note card carries it.
  const summary = !card.variant && view.job?.summary && <p className="concept-summary">{view.job.summary}</p>
  let content: ReactNode
  if (view.missing) content = <p className="cnode-missing">{view.missing}</p>
  else
    switch (status) {
      case "queued":
      case "running":
        content = placeholder("✦ concept artist is drawing…")
        break
      case "approval":
        content = (
          <>
            <div className="concept-panel">
              <p className="concept-status">✦ Waiting for you to review the script</p>
              {summary}
              <p className="concept-warn">Running the script executes its code on this computer. Read it before you run it.</p>
              {script && (
                <div className="concept-script">
                  <div className="concept-script-head">
                    <span className="mono" title={script.file}>
                      {script.file.split("/").pop()}
                    </span>
                    <span className="mono" title={script.sha256}>
                      sha256 {script.sha256.slice(0, 12)}
                    </span>
                  </div>
                  <pre className="concept-script-text nodrag nowheel">{script.text}</pre>
                </div>
              )}
            </div>
          </>
        )
        break
      case "rendering":
        content = placeholder("Running the approved script in Godot…")
        break
      case "failed":
        content = (
          <div className="concept-panel">
            <p className="cnode-missing concept-error nodrag nowheel">{view.job?.error ?? "The job failed."}</p>
          </div>
        )
        break
      default:
        content = (
          <>
            {frame(image)}
            {summary && <div className="concept-panel">{summary}</div>}
          </>
        )
    }
  const open = status !== "accepted" && status !== "dismissed"
  return (
    <div className="concept" data-job-status={status ?? "missing"}>
      {content}
      {open && (
        <div className="concept-actions">
          {status === "approval" &&
            (script ? (
              <button className="btn btn-primary nodrag" data-action="run" disabled={busy} onClick={() => act(() => window.river.jobApprove(jobId, script.sha256))}>
                Run script
              </button>
            ) : (
              <button className="btn btn-primary nodrag" data-action="review" disabled={busy} onClick={() => act(() => window.river.jobGet(jobId).then((d) => setScript(d.script ?? null)))}>
                Review script
              </button>
            ))}
          {status === "answered" && (
            <button className="btn btn-primary nodrag" data-action="accept" disabled={busy} onClick={() => act(() => window.river.jobAccept(jobId))}>
              Accept
            </button>
          )}
          <button className="btn nodrag" data-action="dismiss" disabled={busy} onClick={() => actions.remove(card.id)}>
            Dismiss
          </button>
        </div>
      )}
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
