import {
  Background,
  BackgroundVariant,
  type Node,
  type NodeProps,
  NodeResizeControl,
  type NodeTypes,
  type OnNodeDrag,
  ReactFlow,
  ReactFlowProvider,
  ResizeControlVariant,
  useNodesInitialized,
  useReactFlow,
  useViewport,
} from "@xyflow/react"
import { type ReactNode, createContext, memo, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react"
import type { Mark, MarkShape, MarkStatus } from "@river/core"
import type { BoardDTO, CardDTO, NewMark } from "../../../shared/api"
import { type Pt, type Rect, anchorsFor, arrowPath, bounds, ellipsePoints, flatten, grow, intersects, pointsOf, smoothPath, strokesOf } from "../canvas/geometry"
import { cx, errorText, shortTime, useSmokeReady } from "../util"
import "../canvas/canvas.css"

export const DEFAULT_BOARD = "main"
const ME = "you"
/** Pen strokes this close in time (ms) that overlap the previous stroke join its mark. */
const STROKE_JOIN_MS = 2000

type Tool = "select" | "hand" | "pen" | "circle" | "note" | "arrow" | "pin" | "image"
const DRAW_TOOLS = new Set<Tool>(["pen", "circle", "arrow", "pin", "note"])

type CardNodeData = { dto: CardDTO }
type CardNode = Node<CardNodeData, "card">

interface CanvasActions {
  saveText(id: string, text: string): void
  resize(id: string, w: number): void
  remove(id: string): void
}
const Actions = createContext<CanvasActions | null>(null)

// ---------- cards ----------

function Maker({ by, pending }: { by: string; pending: boolean }) {
  if (by === ME && !pending) return null
  return (
    <span className={cx("cnode-maker", pending && "is-pending")} title={pending ? `${by} · waiting for you to accept` : `Made by ${by}`}>
      <span className="star">✦</span> {by}
      {pending && <span className="cnode-pending"> · pending</span>}
    </span>
  )
}

function NoteBody({ id, text }: { id: string; text: string }) {
  const actions = useContext(Actions)!
  const [draft, setDraft] = useState(text)
  const focused = useRef(false)
  const timer = useRef<number | undefined>(undefined)
  const area = useRef<HTMLTextAreaElement>(null)
  // Follow outside edits unless the user is typing here.
  useEffect(() => {
    if (!focused.current) setDraft(text)
  }, [text])
  useEffect(() => {
    const el = area.current
    if (!el) return
    el.style.height = "auto"
    el.style.height = `${el.scrollHeight}px`
  }, [draft])
  useEffect(() => {
    if (text === "" && area.current) area.current.focus()
    // only on mount: a new empty note is focused for typing
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  const flush = (value: string) => {
    window.clearTimeout(timer.current)
    if (value !== text) actions.saveText(id, value)
  }
  return (
    <textarea
      ref={area}
      className="cnode-note-text nodrag nowheel"
      value={draft}
      placeholder="Write a note…"
      rows={2}
      onFocus={() => (focused.current = true)}
      onBlur={() => {
        focused.current = false
        flush(draft)
      }}
      onChange={(e) => {
        const v = e.target.value
        setDraft(v)
        window.clearTimeout(timer.current)
        timer.current = window.setTimeout(() => flush(v), 700)
      }}
    />
  )
}

function CardImage({ url, alt }: { url: string | undefined; alt: string }) {
  const [failed, setFailed] = useState(false)
  useEffect(() => setFailed(false), [url])
  if (!url || failed) return <div className="cnode-img-missing">{failed ? "Image not found" : "No image"}</div>
  return <img className="cnode-img" src={url} alt={alt} draggable={false} onError={() => setFailed(true)} />
}

const CardView = memo(function CardView({ id, data, selected }: NodeProps<CardNode>) {
  const actions = useContext(Actions)!
  const { card, view } = data.dto
  const pending = Boolean(card.pending)
  let body: ReactNode
  let caption: ReactNode
  switch (view.kind) {
    case "frame":
      body = <CardImage url={view.url} alt={`Frame ${view.shotId}`} />
      caption = (
        <>
          <span className="mono">{view.shotId}</span>
          {view.rev && <span className="mono"> · {view.rev}</span>}
          {view.missing && <span> · {view.missing}</span>}
        </>
      )
      break
    case "passage":
      body = (
        <div className="cnode-passage">
          <div className="cnode-title">{view.title}</div>
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
      )
      caption = (
        <>
          passage · <span className="mono">{view.story.split("/").pop()}</span>
        </>
      )
      break
    case "ref":
      body = <CardImage url={view.url} alt={card.source?.title ?? "Reference"} />
      caption = (
        <>
          {card.source?.title && <span>{card.source.title} · </span>}
          {card.source?.url && (
            <span className="mono" title={card.source.url}>
              {hostOf(card.source.url)} ·{" "}
            </span>
          )}
          <span>{card.source?.licence ?? "no licence"}</span>
        </>
      )
      break
    case "concept":
      body = (
        <div className="cnode-concept">
          <span className="mono">concepts/{view.id}/</span>
        </div>
      )
      caption = <>concept · {view.id}</>
      break
    default:
      body = <NoteBody id={id} text={card.text ?? ""} />
  }
  return (
    <div className={cx("cnode", `cnode-${card.kind}`, selected && "is-selected", pending && "is-pending")}>
      {selected && (
        <NodeResizeControl
          position="right"
          variant={ResizeControlVariant.Line}
          className="cnode-resize"
          minWidth={140}
          maxWidth={900}
          onResizeEnd={(_e, p) => actions.resize(id, p.width)}
        />
      )}
      {(card.madeBy !== ME || pending) && (
        <div className="cnode-head">
          <Maker by={card.madeBy} pending={pending} />
        </div>
      )}
      {body}
      {caption && <div className="cnode-cap">{caption}</div>}
      {selected && (
        <button className="cnode-del nodrag" title="Delete card" aria-label="Delete card" onClick={() => actions.remove(id)}>
          ×
        </button>
      )}
    </div>
  )
})

function hostOf(url: string): string {
  try {
    return new URL(url).host || url
  } catch {
    return url
  }
}

const nodeTypes: NodeTypes = { card: CardView } as unknown as NodeTypes

function toNode(dto: CardDTO, prev: CardNode | undefined): CardNode {
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

// ---------- marks ----------

const STATUS_LABEL: Record<MarkStatus, string> = {
  open: "open",
  working: "working",
  answered: "answered",
  accepted: "accepted",
  dismissed: "dismissed",
}

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

function MarkShapeView({ m, selected, hit, onPick }: { m: Pick<Mark, "shape" | "path" | "breaks" | "madeBy">; selected?: boolean; hit?: boolean; onPick?: () => void }) {
  const cls = cx("mark", m.madeBy === ME ? "by-you" : "by-agent", selected && "is-selected")
  if (m.shape === "pin") {
    const [x, y] = [m.path[0] ?? 0, m.path[1] ?? 0]
    return (
      <g className={cls} onPointerDown={hit ? (e) => (e.stopPropagation(), onPick?.()) : undefined} style={hit ? { pointerEvents: "all", cursor: "pointer" } : undefined}>
        <PinGlyph x={x} y={y} />
      </g>
    )
  }
  const d = markD(m)
  return (
    <g className={cls}>
      {selected && <path className="mark-halo" d={d} />}
      <path className="mark-ink" d={d} />
      {hit && (
        <path
          className="mark-hit"
          d={d}
          onPointerDown={(e) => {
            e.stopPropagation()
            onPick?.()
          }}
        />
      )}
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

interface Draft {
  shape: MarkShape
  points: Pt[]
}

function MarksLayer(props: { marks: Mark[]; draft: Draft | null; selectedId: string | undefined; pickable: boolean; onPick(id: string): void }) {
  const { x, y, zoom } = useViewport()
  const { marks, draft, selectedId, pickable, onPick } = props
  let draftView: ReactNode = null
  if (draft && draft.points.length > 0) {
    const a = draft.points[0]!
    const b = draft.points[draft.points.length - 1]!
    const path =
      draft.shape === "circle" ? flatten(ellipsePoints(a, b)) : draft.shape === "arrow" ? flatten([a, b]) : flatten(draft.points)
    draftView = <MarkShapeView m={{ shape: draft.shape, path, madeBy: ME }} />
  }
  return (
    <svg className="marks-layer" aria-hidden={!pickable}>
      <g transform={`translate(${x} ${y}) scale(${zoom})`}>
        {marks.map((m) => (
          <g key={m.id} data-mark={m.id}>
            <MarkShapeView m={m} selected={m.id === selectedId} hit={pickable} onPick={() => onPick(m.id)} />
            {(() => {
              const [dx, dy] = statusDotAt(m)
              return <circle className={cx("mark-dot", `ms-${m.status}`)} cx={dx} cy={dy} r={4 / Math.max(zoom, 0.4)} />
            })()}
          </g>
        ))}
        {draftView}
      </g>
    </svg>
  )
}

/** "What do you want?" box placed beside a fresh mark. */
function AskBox(props: { at: Pt; onDone(text: string | null): void }) {
  const { x, y, zoom } = useViewport()
  const [text, setText] = useState("")
  const input = useRef<HTMLInputElement>(null)
  useEffect(() => {
    const t = window.setTimeout(() => input.current?.focus(), 0)
    return () => window.clearTimeout(t)
  }, [])
  return (
    <form
      className="ask-box"
      style={{ left: props.at[0] * zoom + x + 8, top: props.at[1] * zoom + y + 8 }}
      onSubmit={(e) => {
        e.preventDefault()
        props.onDone(text.trim())
      }}
      onPointerDown={(e) => e.stopPropagation()}
    >
      <input
        ref={input}
        className="ask-input"
        value={text}
        placeholder="What do you want?"
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.preventDefault()
            props.onDone(null)
          }
        }}
      />
      <span className="ask-hint">Enter to save · Esc to skip</span>
    </form>
  )
}

function MarkPanel(props: { mark: Mark; cardTitle(id: string): string; onDelete(): void; onClose(): void }) {
  const { mark: m } = props
  return (
    <aside className="mark-panel" onPointerDown={(e) => e.stopPropagation()}>
      <header className="mark-panel-head">
        <span className={cx("mark-dot-static", `ms-${m.status}`)} />
        <span className="mark-panel-title">
          {m.shape} · {STATUS_LABEL[m.status]}
        </span>
        <span className="tb-spacer" />
        <button className="icon-btn" onClick={props.onClose} aria-label="Close">
          ×
        </button>
      </header>
      {m.anchors.length > 0 && (
        <p className="mark-panel-anchors">
          On{" "}
          {m.anchors.map((a, i) => (
            <span key={a}>
              {i > 0 && ", "}
              <b>{props.cardTitle(a)}</b>
            </span>
          ))}
        </p>
      )}
      <ul className="mark-thread">
        {m.thread.length === 0 && <li className="mark-thread-empty">No request written.</li>}
        {m.thread.map((t, i) => (
          <li key={i}>
            <span className={cx("msg-who", t.by !== ME && "is-agent")}>
              {t.by !== ME && "✦ "}
              {t.by}
            </span>
            <span className="msg-at">{shortTime(t.at)}</span>
            <p>{t.text}</p>
          </li>
        ))}
      </ul>
      <footer className="mark-panel-foot">
        <span className="mono sec-hint">{m.id}</span>
        <span className="tb-spacer" />
        <button className="btn btn-danger" onClick={props.onDelete}>
          Delete
        </button>
      </footer>
    </aside>
  )
}

// ---------- reference image form ----------

function RefForm(props: { fileName: string; onSubmit(s: { title: string; url: string; licence: string }): Promise<void>; onCancel(): void }) {
  const [title, setTitle] = useState(props.fileName.replace(/\.[^.]+$/, ""))
  const [url, setUrl] = useState("")
  const [licence, setLicence] = useState("")
  const [err, setErr] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  return (
    <div className="canvas-modal" onPointerDown={(e) => e.stopPropagation()}>
      <form
        className="ref-form"
        onSubmit={(e) => {
          e.preventDefault()
          if (!licence.trim()) return setErr("Write the licence (for example CC0, CC BY 4.0, or “own photo”).")
          setBusy(true)
          props.onSubmit({ title, url, licence }).catch((x: unknown) => {
            setErr(errorText(x))
            setBusy(false)
          })
        }}
      >
        <header className="dialog-head">
          <h2>Reference image</h2>
          <span className="mono sec-hint">{props.fileName}</span>
        </header>
        <label className="field">
          <span>Title</span>
          <input value={title} onChange={(e) => setTitle(e.target.value)} />
        </label>
        <label className="field">
          <span>Source URL</span>
          <input value={url} placeholder="https://…" onChange={(e) => setUrl(e.target.value)} />
        </label>
        <label className="field">
          <span>
            Licence <b className="req">required</b>
          </span>
          <input value={licence} placeholder="CC0, CC BY 4.0, own photo…" onChange={(e) => setLicence(e.target.value)} autoFocus />
        </label>
        {err && <p className="err-note">{err}</p>}
        <footer className="dialog-foot">
          <button type="button" className="btn" onClick={props.onCancel}>
            Cancel
          </button>
          <button className="btn btn-primary" disabled={busy}>
            Add to canvas
          </button>
        </footer>
      </form>
    </div>
  )
}

// ---------- toolbar ----------

const TOOLS: { id: Tool; label: string; key: string; icon: ReactNode }[] = [
  { id: "select", label: "Select", key: "v", icon: <path d="M4 2.5l8 5.2-3.6.8 2.2 4.3-1.6.8-2.2-4.3L4 12z" /> },
  { id: "hand", label: "Hand (pan)", key: "h", icon: <path d="M5 8V4.2a1 1 0 0 1 2 0V7.5M7 7V3.2a1 1 0 0 1 2 0V7M9 7V4a1 1 0 0 1 2 0v4.5M5 8.2V7a1 1 0 0 0-2 0v2.2c0 2.6 1.8 4.3 4.4 4.3h1c2.2 0 3.6-1.6 3.6-3.8V6.2a1 1 0 0 0-2 0" /> },
  { id: "pen", label: "Pen", key: "p", icon: <path d="M3 13l1-3.2 6.6-6.6 2.2 2.2L6.2 12zM9.6 4.2l2.2 2.2" /> },
  { id: "circle", label: "Circle", key: "o", icon: <ellipse cx="8" cy="8" rx="5.6" ry="4.6" /> },
  { id: "note", label: "Note", key: "n", icon: <path d="M3 3h10v6.5L9.5 13H3zM9.5 13V9.5H13" /> },
  { id: "arrow", label: "Arrow", key: "a", icon: <path d="M3 13L12.5 3.5M7 3.5h5.5V9" /> },
  { id: "pin", label: "Pin", key: "m", icon: <path d="M8 14C7 11 4.5 9.5 4.5 6.5a3.5 3.5 0 0 1 7 0C11.5 9.5 9 11 8 14zM8 6.6h0" /> },
  { id: "image", label: "Image", key: "i", icon: <path d="M2.5 3.5h11v9h-11zM2.5 10.5l3-2.6 2.6 2 2-1.4 3.4 2.5M10.5 6.2h0" /> },
]

function ToolBar(props: { tool: Tool; onTool(t: Tool): void }) {
  return (
    <div className="canvas-tools" role="toolbar" aria-label="Canvas tools">
      {TOOLS.map((t, i) => (
        <span key={t.id} className="canvas-tool-wrap">
          {(i === 2 || i === 4) && <span className="canvas-tool-sep" />}
          <button className={cx("canvas-tool", props.tool === t.id && "is-on")} data-tool={t.id} title={`${t.label} (${t.key.toUpperCase()})`} aria-label={t.label} onClick={() => props.onTool(t.id)}>
            <svg viewBox="0 0 16 16" aria-hidden>
              {t.icon}
            </svg>
          </button>
        </span>
      ))}
    </div>
  )
}

// ---------- the canvas ----------

interface BoardState {
  cards: Record<string, CardDTO>
  marks: Record<string, Mark>
  openMarks: number
  errors: string[]
}

const byCreated = <T extends { card?: { createdAt: string }; createdAt?: string }>(a: T, b: T) => {
  const ka = a.card?.createdAt ?? a.createdAt ?? ""
  const kb = b.card?.createdAt ?? b.createdAt ?? ""
  return ka < kb ? -1 : ka > kb ? 1 : 0
}

function CanvasInner(props: { board: string; storyTick: { rel: string; n: number } | null }) {
  const { board } = props
  const flow = useReactFlow()
  const [state, setState] = useState<BoardState | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [nodes, setNodes] = useState<CardNode[]>([])
  const [tool, setTool] = useState<Tool>("select")
  const [draft, setDraft] = useState<Draft | null>(null)
  const [ask, setAsk] = useState<{ markId: string; at: Pt } | null>(null)
  const [selectedMark, setSelectedMark] = useState<string | undefined>()
  const [refPick, setRefPick] = useState<{ token: string; fileName: string } | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const [ready, setReady] = useState(false)
  const lastPen = useRef<{ id: string; endedAt: number; box: Rect } | null>(null)
  const stateRef = useRef(state)
  stateRef.current = state
  const wrap = useRef<HTMLDivElement>(null)

  const fail = (err: unknown) => setActionError(errorText(err))

  // Load the board (creating it on first open).
  useEffect(() => {
    let live = true
    window.river.boardOpen(board).then(
      (b: BoardDTO) => {
        if (!live) return
        setState({
          cards: Object.fromEntries(b.cards.map((c) => [c.card.id, c])),
          marks: Object.fromEntries(b.marks.map((m) => [m.id, m])),
          openMarks: b.openMarks,
          errors: b.errors,
        })
      },
      (e) => live && setLoadError(errorText(e)),
    )
    return () => {
      live = false
    }
  }, [board])

  const putCard = useCallback((id: string, dto: CardDTO | null) => {
    setState((s) => {
      if (!s) return s
      const cards = { ...s.cards }
      if (dto) cards[id] = dto
      else delete cards[id]
      return { ...s, cards }
    })
  }, [])
  const putMark = useCallback((id: string, m: Mark | null, openMarks?: number) => {
    setState((s) => {
      if (!s) return s
      const marks = { ...s.marks }
      if (m) marks[id] = m
      else delete marks[id]
      return { ...s, marks, ...(openMarks !== undefined ? { openMarks } : {}) }
    })
  }, [])

  // Live reload: only the cards and marks whose files changed are read again.
  useEffect(
    () =>
      window.river.onFsChange((changes) => {
        let marksChanged = false
        for (const c of changes) {
          if (c.kind !== "board") continue
          const m = /^\.river\/boards\/([^/]+)\/(cards|marks)\/([^/]+)\.json$/.exec(c.rel)
          if (!m || m[1] !== board) continue
          const id = m[3]!
          if (m[2] === "cards") void window.river.boardCard(board, id).then((dto) => putCard(id, dto), fail)
          else {
            marksChanged = true
            void window.river.boardMark(board, id).then((mk) => putMark(id, mk), fail)
          }
        }
        if (marksChanged) void window.river.boardOpenCount(board).then((n) => setState((s) => (s ? { ...s, openMarks: n } : s)))
      }),
    [board, putCard, putMark],
  )

  // Passage cards follow their story file.
  useEffect(() => {
    const t = props.storyTick
    const s = stateRef.current
    if (!t || !s) return
    for (const dto of Object.values(s.cards)) {
      if (dto.view.kind === "passage" && dto.view.story === t.rel) {
        void window.river.boardCard(board, dto.card.id).then((d) => putCard(dto.card.id, d), fail)
      }
    }
  }, [props.storyTick, board, putCard])

  const cardList = useMemo(() => (state ? Object.values(state.cards).sort(byCreated) : []), [state])
  const markList = useMemo(() => (state ? Object.values(state.marks).sort(byCreated) : []), [state])

  useEffect(() => {
    setNodes((prev) => {
      const old = new Map(prev.map((n) => [n.id, n]))
      return cardList.map((dto) => toNode(dto, old.get(dto.card.id)))
    })
  }, [cardList])

  // Fit once the first cards have sizes.
  const measured = useNodesInitialized()
  const fitted = useRef(false)
  useEffect(() => {
    if (fitted.current || !state) return
    if (cardList.length === 0) {
      fitted.current = true
      setReady(true)
      return
    }
    if (!measured) return
    fitted.current = true
    void Promise.resolve(flow.fitView({ padding: 120, maxZoom: 1 })).then(() => setReady(true))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [measured, state, cardList.length])
  useSmokeReady("canvas", ready || loadError !== null)

  const saveCard = useCallback(
    (dto: CardDTO, patch: Partial<CardDTO["card"]>) => {
      const next = { ...dto.card, ...patch }
      putCard(next.id, { ...dto, card: next })
      window.river.boardSaveCard(board, next).then((d) => putCard(d.card.id, d), fail)
    },
    [board, putCard],
  )

  const actions = useMemo<CanvasActions>(
    () => ({
      saveText: (id, text) => {
        const dto = stateRef.current?.cards[id]
        if (dto) saveCard(dto, { text })
      },
      resize: (id, w) => {
        const dto = stateRef.current?.cards[id]
        if (dto) saveCard(dto, { w: Math.round(w) })
      },
      remove: (id) => {
        putCard(id, null)
        window.river.boardDeleteCard(board, id).catch(fail)
      },
    }),
    [board, saveCard, putCard],
  )

  const onDragStop: OnNodeDrag = useCallback(
    (_e, _n, dragged) => {
      for (const n of dragged) {
        const dto = stateRef.current?.cards[n.id]
        if (!dto) continue
        const x = Math.round(n.position.x)
        const y = Math.round(n.position.y)
        if (x !== dto.card.x || y !== dto.card.y) saveCard(dto, { x, y })
      }
    },
    [saveCard],
  )

  const cardRects = (): { id: string; rect: Rect }[] =>
    flow.getNodes().map((n) => ({
      id: n.id,
      rect: { x: n.position.x, y: n.position.y, w: n.measured?.width ?? n.width ?? 200, h: n.measured?.height ?? n.height ?? 120 },
    }))

  const saveMark = async (mark: NewMark): Promise<Mark> => {
    const { mark: saved, openMarks } = await window.river.boardSaveMark(board, mark)
    putMark(saved.id, saved, openMarks)
    return saved
  }

  /** A finished stroke or shape becomes a mark (or joins the last pen mark), then asks what the user wants. */
  const finishDraft = async (d: Draft) => {
    const pts = d.points
    if (pts.length === 0) return
    const a = pts[0]!
    const b = pts[pts.length - 1]!
    let shape = d.shape
    let path: number[]
    if (shape === "circle") {
      if (Math.abs(b[0] - a[0]) < 8 && Math.abs(b[1] - a[1]) < 8) return
      path = flatten(ellipsePoints(a, b))
    } else if (shape === "arrow") {
      if (Math.hypot(b[0] - a[0], b[1] - a[1]) < 8) return
      path = flatten([a, b])
    } else if (shape === "pin") {
      path = flatten([b])
    } else {
      shape = "pen"
      path = flatten(pts.length === 1 ? [a, [a[0] + 0.5, a[1]]] : pts)
    }
    const box = bounds(path)
    const now = Date.now()
    const last = lastPen.current
    const prev = last ? stateRef.current?.marks[last.id] : undefined
    try {
      if (shape === "pen" && last && prev && now - last.endedAt <= STROKE_JOIN_MS && intersects(grow(box, 4), grow(last.box, 4))) {
        const merged = [...prev.path, ...path]
        const breaks = [...(prev.breaks ?? []), prev.path.length / 2]
        const saved = await saveMark({ ...prev, path: merged, breaks, anchors: anchorsFor("pen", merged, cardRects()) })
        const mb = bounds(merged)
        lastPen.current = { id: saved.id, endedAt: Date.now(), box: mb }
        setAsk((cur) => (cur && cur.markId === saved.id ? { markId: saved.id, at: [mb.x + mb.w, mb.y + mb.h] } : cur))
        return
      }
      const saved = await saveMark({ shape, path, anchors: anchorsFor(shape, path, cardRects()), thread: [], madeBy: ME })
      lastPen.current = shape === "pen" ? { id: saved.id, endedAt: Date.now(), box } : null
      setAsk({ markId: saved.id, at: shape === "pin" ? [box.x, box.y] : [box.x + box.w, box.y + box.h] })
    } catch (e) {
      fail(e)
    }
  }

  const answerAsk = (text: string | null) => {
    const a = ask
    setAsk(null)
    lastPen.current = null
    if (!a || !text) return
    const m = stateRef.current?.marks[a.markId]
    if (!m) return
    void saveMark({ ...m, thread: [...m.thread, { by: ME, at: new Date().toISOString(), text }] }).catch(fail)
  }

  const placeNote = async (p: Pt) => {
    try {
      const dto = await window.river.boardSaveCard(board, { kind: "note", ref: "", text: "", x: Math.round(p[0]), y: Math.round(p[1]), w: 220, madeBy: ME })
      putCard(dto.card.id, dto)
      setTool("select")
    } catch (e) {
      fail(e)
    }
  }

  const chooseTool = (t: Tool) => {
    if (t === "image") {
      void window.river.boardPickImage().then((r) => r && setRefPick(r), fail)
      return
    }
    setTool(t)
    setDraft(null)
    if (t !== "select") setSelectedMark(undefined)
  }

  // Tool keys (not while typing).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null
      if (el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable)) return
      if (e.ctrlKey || e.metaKey || e.altKey) return
      if (e.key === "Escape") {
        setDraft(null)
        setSelectedMark(undefined)
        setTool("select")
        return
      }
      const t = TOOLS.find((x) => x.key === e.key.toLowerCase())
      if (t) chooseTool(t.id)
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const toFlow = (e: { clientX: number; clientY: number }): Pt => {
    const p = flow.screenToFlowPosition({ x: e.clientX, y: e.clientY })
    return [p.x, p.y]
  }
  const drawing = useRef<Draft | null>(null)

  if (loadError) {
    return (
      <div className="empty-state">
        <h2>The board did not open</h2>
        <pre className="mono">{loadError}</pre>
      </div>
    )
  }
  const selected = selectedMark ? state?.marks[selectedMark] : undefined
  const titleOf = (id: string) => {
    const v = state?.cards[id]?.view
    if (!v) return id
    return v.kind === "passage" ? v.title : v.kind === "frame" ? v.shotId : v.kind === "concept" ? v.id : (state?.cards[id]?.card.source?.title ?? v.kind)
  }

  return (
    <div className="view canvas-view">
      <div className="toolbar">
        <span className="tb-label">Canvas</span>
        <span className="canvas-board-name">{board}</span>
        <span className="tb-meta">
          {cardList.length} card{cardList.length === 1 ? "" : "s"}
        </span>
        <div className="tb-spacer" />
        <span className={cx("open-marks", (state?.openMarks ?? 0) > 0 && "has-open")} data-open-marks={state?.openMarks ?? 0}>
          <span className="open-marks-dot" />
          {state?.openMarks ?? 0} open mark{state?.openMarks === 1 ? "" : "s"}
        </span>
      </div>
      <div className={cx("canvas-wrap", `tool-${tool}`)} ref={wrap}>
        {(state?.errors.length ?? 0) > 0 && (
          <div className="banner banner-warn canvas-banner">
            Skipped {state!.errors.length} file{state!.errors.length === 1 ? "" : "s"} that did not parse: <span className="mono">{state!.errors.join(" · ")}</span>
          </div>
        )}
        {actionError && (
          <div className="banner banner-err canvas-banner" onClick={() => setActionError(null)}>
            {actionError}
          </div>
        )}
        <Actions.Provider value={actions}>
          <ReactFlow
            nodes={nodes}
            edges={[]}
            nodeTypes={nodeTypes}
            onNodesChange={(changes) =>
              // Height follows the content: never keep a height that a resize wrote.
              setNodes((ns) => changes.applyTo(ns).map((n) => (n.height !== undefined ? { ...n, height: undefined } : n)))
            }
            onNodeDragStop={onDragStop}
            onNodesDelete={(ns) => ns.forEach((n) => actions.remove(n.id))}
            onPaneClick={() => setSelectedMark(undefined)}
            onNodeClick={() => setSelectedMark(undefined)}
            nodesConnectable={false}
            nodesDraggable={tool === "select"}
            elementsSelectable={tool === "select"}
            panOnDrag={tool === "hand" ? true : [1, 2]}
            selectionOnDrag={tool === "select"}
            panOnScroll
            zoomOnDoubleClick={false}
            deleteKeyCode={["Delete", "Backspace"]}
            minZoom={0.1}
            maxZoom={3}
            proOptions={{ hideAttribution: true }}
          >
            <Background variant={BackgroundVariant.Dots} gap={22} size={1} />
            <MarksLayer marks={markList} draft={draft} selectedId={selectedMark} pickable={tool === "select"} onPick={setSelectedMark} />
            {DRAW_TOOLS.has(tool) && (
              <div
                className={cx("draw-capture", `draw-${tool}`)}
                onPointerDown={(e) => {
                  if (e.button !== 0) return
                  e.currentTarget.setPointerCapture(e.pointerId)
                  const p = toFlow(e)
                  if (tool === "note") {
                    void placeNote(p)
                    return
                  }
                  const d: Draft = { shape: tool as MarkShape, points: [p] }
                  drawing.current = d
                  setDraft(d)
                }}
                onPointerMove={(e) => {
                  const d = drawing.current
                  if (!d) return
                  const p = toFlow(e)
                  if (d.shape === "pen") {
                    const last = d.points[d.points.length - 1]!
                    if (Math.hypot(p[0] - last[0], p[1] - last[1]) * flow.getZoom() < 2) return
                    d.points = [...d.points, p]
                  } else d.points = [d.points[0]!, p]
                  setDraft({ ...d })
                }}
                onPointerUp={(e) => {
                  const d = drawing.current
                  drawing.current = null
                  setDraft(null)
                  if (!d) return
                  if (d.shape !== "pen" && d.shape !== "pin") d.points = [d.points[0]!, toFlow(e)]
                  void finishDraft(d)
                }}
              />
            )}
            {ask && <AskBox key={ask.markId} at={ask.at} onDone={answerAsk} />}
          </ReactFlow>
        </Actions.Provider>
        {selected && (
          <MarkPanel
            mark={selected}
            cardTitle={titleOf}
            onClose={() => setSelectedMark(undefined)}
            onDelete={() => {
              const id = selected.id
              setSelectedMark(undefined)
              putMark(id, null)
              window.river.boardDeleteMark(board, id).then((n) => setState((s) => (s ? { ...s, openMarks: n } : s)), fail)
            }}
          />
        )}
        {state && cardList.length === 0 && markList.length === 0 && (
          <div className="canvas-empty">
            <p>An empty board. Pin passages from the Story map or shots from Frames, add an image or a note, and draw on it with the pen.</p>
          </div>
        )}
        <ToolBar tool={tool} onTool={chooseTool} />
        {refPick && (
          <RefForm
            fileName={refPick.fileName}
            onCancel={() => setRefPick(null)}
            onSubmit={async (s) => {
              const el = wrap.current?.getBoundingClientRect()
              const c = el ? flow.screenToFlowPosition({ x: el.left + el.width / 2, y: el.top + el.height / 2 }) : { x: 0, y: 0 }
              const dto = await window.river.boardAddRef(board, refPick.token, s, { x: c.x - 120, y: c.y - 90 })
              putCard(dto.card.id, dto)
              setRefPick(null)
            }}
          />
        )}
      </div>
    </div>
  )
}

export function CanvasView(props: { board?: string; storyTick: { rel: string; n: number } | null }) {
  return (
    <ReactFlowProvider>
      <CanvasInner board={props.board ?? DEFAULT_BOARD} storyTick={props.storyTick} />
    </ReactFlowProvider>
  )
}
