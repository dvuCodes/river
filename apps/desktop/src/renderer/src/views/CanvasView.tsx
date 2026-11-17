import {
  Background,
  BackgroundVariant,
  type EdgeTypes,
  MiniMap,
  type NodeTypes,
  Panel,
  ReactFlow,
  ReactFlowProvider,
  useNodesInitialized,
  useReactFlow,
  ViewportPortal,
} from "@xyflow/react"
import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import "@fontsource/caveat/600.css"
import type { Card, Edge, Mark, MarkShape } from "@river/core"
import type { BoardDTO, CanvasTheme, CardDTO, StagedImage } from "../../../shared/api"
import { AskBox, BoardPill, DismissDialog, type JumpItem, Lightbox, type LightboxItem, MarkPanel, QuickJump, RefForm, SelectionBar, TextPanel, TOOLS, type Tool, ToolBar, ZoomControls } from "../canvas/chrome"
import { type Pt, type Rect, anchorsFor, bounds, ellipsePoints, flatten, grow, intersects, markBox, readingOrder, translatePath } from "../canvas/geometry"
import { type Step, createHistory } from "../canvas/history"
import { LinkEdge, type LinkEdgeType, linkEdge } from "../canvas/LinkEdge"
import { Actions, AnswerNotes, type BoardNode, type CanvasActions, CardView, ME, MarkShapeView, MarkView, cardNode, markNode } from "../canvas/nodes"
import { cx, errorText, useSmokeReady } from "../util"
import "../canvas/canvas.css"

/** Pen strokes this close in time (ms) that overlap the previous stroke join its mark. */
const STROKE_JOIN_MS = 2000
const DRAW_TOOLS = new Set<Tool>(["pen", "circle", "arrow", "pin", "note"])
const MULTI_SELECT_KEYS = ["Shift", "Control", "Meta"]
/** Offset of a duplicate from its original, and the gap between cards in an arranged row, in board units. */
const NUDGE = 32
const ROW_GAP = 24
/** Smoke runs can compare with and without culling (?cull=0). */
const CULL = new URLSearchParams(window.location.search).get("cull") !== "0"

const nodeTypes: NodeTypes = { card: CardView, mark: MarkView } as unknown as NodeTypes
const edgeTypes: EdgeTypes = { link: LinkEdge } as unknown as EdgeTypes

interface BoardState {
  cards: Record<string, CardDTO>
  marks: Record<string, Mark>
  edges: Record<string, Edge>
  openMarks: number
  errors: string[]
}

interface Draft {
  shape: MarkShape
  points: Pt[]
  /** Arrow drags that start on a card or mark: they become a connector if they end on another one. */
  from?: string
}

/** A staged image waiting for its licence form, and where it goes on the board. */
interface RefPending {
  image: StagedImage
  at: Pt
  licence: string
}

function newId(prefix: "c_" | "m_" | "e_"): string {
  const bytes = crypto.getRandomValues(new Uint8Array(8))
  return prefix + Array.from(bytes, (b) => (b % 36).toString(36)).join("")
}

const byCreated = (a: { createdAt: string; id: string }, b: { createdAt: string; id: string }) =>
  a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0

const isTyping = (el: EventTarget | null) => {
  const t = el as HTMLElement | null
  return Boolean(t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable))
}

function imageOf(dto: CardDTO | undefined): LightboxItem | undefined {
  const v = dto?.view
  if (!dto || !v || (v.kind !== "ref" && v.kind !== "frame" && v.kind !== "concept") || !v.url) return undefined
  const fallback = v.kind === "frame" ? `${v.shotId}${v.frame !== undefined ? ` · frame ${v.frame + 1}` : ""}` : v.kind === "concept" ? v.id : ""
  return { id: dto.card.id, url: v.url, caption: dto.card.caption || dto.card.source?.title || fallback }
}

/** Where a card sits on the board; its height from the image's own shape, so the order does not depend on what has rendered. */
function boardRect(dto: CardDTO): Rect {
  const { card, view } = dto
  const size = "size" in view ? view.size : undefined
  return { x: card.x, y: card.y, w: card.w, h: size ? (card.w * size.h) / size.w : card.w * 0.75 }
}

/** The first steps on an empty board. Drawn on the paper, out of the way of the pointer. */
function EmptyBoard() {
  return (
    <div className="canvas-empty" aria-label="An empty board">
      <div className="empty-sheet">
        <h2 className="empty-title">A blank board</h2>
        <p className="empty-lede">Lay out shots, passages and references, then ask for what you want right where you want it.</p>
        <ol className="empty-steps">
          <li>
            <svg viewBox="0 0 48 40" aria-hidden className="empty-glyph glyph-pen">
              <ellipse cx="18" cy="21" rx="14" ry="11" />
              <path className="glyph-note" d="M33 6h12v9H37l-4 3z" />
            </svg>
            <div>
              <b>Draw a mark, write a request</b>
              <span>
                Circle or scribble on anything with the pen <kbd>P</kbd> or circle <kbd>O</kbd>, then say what you want. An agent answers beside it.
              </span>
            </div>
          </li>
          <li>
            <svg viewBox="0 0 48 40" aria-hidden className="empty-glyph glyph-strip">
              <rect x="2" y="12" width="12" height="9" rx="1.5" />
              <rect x="18" y="12" width="12" height="9" rx="1.5" />
              <rect x="34" y="12" width="12" height="9" rx="1.5" />
              <path d="M14.5 16.5h3M30.5 16.5h3" />
              <path className="glyph-cap" d="M2 26h9M18 26h9M34 26h9" />
            </svg>
            <div>
              <b>Pin passages and frames</b>
              <span>From the Story map, or send a capture from Frames as a strip of frames joined in order.</span>
            </div>
          </li>
          <li>
            <svg viewBox="0 0 48 40" aria-hidden className="empty-glyph glyph-drop">
              <rect x="9" y="8" width="26" height="20" rx="2" />
              <path d="M9 24l7-6 6 5 4-3 9 7" />
              <path className="glyph-arrow" d="M38 2v12M34 10l4 4 4-4" />
            </svg>
            <div>
              <b>Drop in images</b>
              <span>
                Drag reference images here or paste them <kbd>Ctrl</kbd> <kbd>V</kbd>. Each one keeps its source and licence.
              </span>
            </div>
          </li>
        </ol>
      </div>
    </div>
  )
}

function titleOf(dto: CardDTO): string {
  const { card, view } = dto
  if (card.caption) return card.caption
  switch (view.kind) {
    case "passage":
      return view.title
    case "frame":
      return view.shotId
    case "concept":
      return `concept ${view.id}${card.variant ? ` (${card.variant})` : ""}`
    case "ref":
      return card.source?.title ?? "reference"
    default:
      return (card.text ?? "").split("\n")[0]?.trim() || "empty note"
  }
}

/** Only image files; a pasted image has no useful name, so it is named after its type. */
function imageFiles(list: FileList | null | undefined): File[] {
  return Array.from(list ?? []).filter((f) => f.type.startsWith("image/"))
}

async function stageFile(file: File): Promise<StagedImage> {
  const ext = file.type.split("/")[1]?.replace("jpeg", "jpg").replace(/\+.*$/, "") ?? "png"
  const name = file.name && /\.[a-z0-9]+$/i.test(file.name) ? file.name : `pasted.${ext}`
  return window.river.boardStageImage(new Uint8Array(await file.arrayBuffer()), name)
}

interface CanvasProps {
  board: string
  onBoard(name: string): void
  storyTick: { rel: string; n: number } | null
  theme: CanvasTheme
  onTheme(t: CanvasTheme): void
}

function CanvasInner(props: CanvasProps) {
  const { board } = props
  const flow = useReactFlow<BoardNode, LinkEdgeType>()
  const [state, setState] = useState<BoardState | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [nodes, setNodes] = useState<BoardNode[]>([])
  const [links, setLinks] = useState<LinkEdgeType[]>([])
  const [tool, setTool] = useState<Tool>("select")
  const [draft, setDraft] = useState<Draft | null>(null)
  const [ask, setAsk] = useState<{ markId: string; at: Pt } | null>(null)
  const [refs, setRefs] = useState<RefPending[]>([])
  const [actionError, setActionError] = useState<string | null>(null)
  const [ready, setReady] = useState(false)
  const [jumping, setJumping] = useState(false)
  const [lightbox, setLightbox] = useState<string | null>(null)
  const [dropping, setDropping] = useState(false)
  const [dismissing, setDismissing] = useState<string | null>(null)
  const [logOf, setLogOf] = useState<string | null>(null)
  const lastPen = useRef<{ id: string; endedAt: number; box: Rect } | null>(null)
  const pointer = useRef<Pt | null>(null)
  /** Ids to select once their nodes exist (after a duplicate). */
  const selectNext = useRef<Set<string> | null>(null)
  const stateRef = useRef(state)
  stateRef.current = state
  const wrap = useRef<HTMLDivElement>(null)

  const fail = useCallback((err: unknown) => setActionError(errorText(err)), [])
  /**
   * A file drag over the board: enters and leaves are counted, and dragover (sent many times a second while a drag is
   * over the board) keeps the drop hint up, so the hint goes once the drag leaves the window, even if a leave never comes.
   */
  const drag = useRef({ depth: 0, timer: 0 })
  const endDrag = useCallback(() => {
    drag.current.depth = 0
    window.clearTimeout(drag.current.timer)
    setDropping(false)
  }, [])

  // Marks for the perf smoke: open, board loaded, ready (fitted).
  useEffect(() => {
    let live = true
    performance.mark("canvas:open")
    window.river.boardOpen(board).then(
      (b: BoardDTO) => {
        if (!live) return
        performance.mark("canvas:loaded")
        setState({
          cards: Object.fromEntries(b.cards.map((c) => [c.card.id, c])),
          marks: Object.fromEntries(b.marks.map((m) => [m.id, m])),
          edges: Object.fromEntries(b.edges.map((e) => [e.id, e])),
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
  const putEdge = useCallback((id: string, e: Edge | null) => {
    setState((s) => {
      if (!s) return s
      const edges = { ...s.edges }
      if (e) edges[id] = e
      else delete edges[id]
      return { ...s, edges }
    })
  }, [])
  const refresh = useCallback((id: string) => void window.river.boardCard(board, id).then((d) => putCard(id, d), fail), [board, putCard, fail])

  // Live reload: only the cards, marks and edges whose files changed are read again.
  useEffect(
    () =>
      window.river.onFsChange((changes) => {
        let marksChanged = false
        for (const c of changes) {
          if (c.kind === "job") {
            const jobId = /^\.river\/jobs\/([^/]+)\.json$/.exec(c.rel)?.[1]
            for (const dto of Object.values(stateRef.current?.cards ?? {})) {
              if (jobId && dto.card.pending?.jobId === jobId) refresh(dto.card.id)
            }
            continue
          }
          if (c.kind !== "board") continue
          const m = /^\.river\/boards\/([^/]+)\/(cards|marks|edges)\/([^/]+)\.json$/.exec(c.rel)
          if (!m || m[1] !== board) continue
          const id = m[3]!
          if (m[2] === "cards") refresh(id)
          else if (m[2] === "edges") void window.river.boardEdge(board, id).then((e) => putEdge(id, e), fail)
          else {
            marksChanged = true
            void window.river.boardMark(board, id).then((mk) => putMark(id, mk), fail)
          }
        }
        if (marksChanged) void window.river.boardOpenCount(board).then((n) => setState((s) => (s ? { ...s, openMarks: n } : s)))
      }),
    [board, putMark, putEdge, refresh, fail],
  )

  // Passage cards follow their story file.
  useEffect(() => {
    const t = props.storyTick
    const s = stateRef.current
    if (!t || !s) return
    for (const dto of Object.values(s.cards)) if (dto.view.kind === "passage" && dto.view.story === t.rel) refresh(dto.card.id)
  }, [props.storyTick, refresh])

  /**
   * Writes one side of a step: a null side deletes the entity, an edit patches the entity as it is now, a whole entity
   * (it has createdAt) is written as is. The canvas updates first; main's answer replaces the guess.
   */
  const applyStep = useCallback(
    async (step: Step, side: "before" | "after") => {
      for (const c of step) {
        const s = stateRef.current
        const patch = c[side]
        if (!s) return
        if (c.kind === "card") {
          const cur = s.cards[c.id]
          if (patch === null) {
            if (!cur) continue
            putCard(c.id, null)
            await window.river.boardDeleteCard(board, c.id)
          } else if (cur || "createdAt" in patch) {
            const next = { ...cur?.card, ...patch } as Card
            if (cur) putCard(c.id, { ...cur, card: next })
            putCard(c.id, await window.river.boardSaveCard(board, next))
          }
        } else if (c.kind === "mark") {
          const cur = s.marks[c.id]
          if (patch === null) {
            if (!cur) continue
            putMark(c.id, null)
            putMark(c.id, null, await window.river.boardDeleteMark(board, c.id))
          } else if (cur || "createdAt" in patch) {
            const next = { ...cur, ...patch } as Mark
            putMark(c.id, next)
            const saved = await window.river.boardSaveMark(board, next)
            putMark(c.id, saved.mark, saved.openMarks)
          }
        } else {
          const cur = s.edges[c.id]
          if (patch === null) {
            if (!cur) continue
            putEdge(c.id, null)
            await window.river.boardDeleteEdge(board, c.id)
          } else if (cur || "createdAt" in patch) {
            const next = { ...cur, ...patch } as Edge
            putEdge(c.id, next)
            putEdge(c.id, await window.river.boardSaveEdge(board, next))
          }
        }
      }
    },
    [board, putCard, putMark, putEdge],
  )
  const history = useMemo(() => createHistory(applyStep), [applyStep])
  const commit = useCallback((step: Step) => history.commit(step).catch(fail), [history, fail])

  const cardList = useMemo(() => (state ? Object.values(state.cards).sort((a, b) => byCreated(a.card, b.card)) : []), [state?.cards])
  const markList = useMemo(() => (state ? Object.values(state.marks).sort(byCreated) : []), [state?.marks])
  const edgeList = useMemo(() => (state ? Object.values(state.edges).sort(byCreated) : []), [state?.edges])

  // Nodes keep their identity while their card or mark is unchanged, so one change re-renders one node.
  useEffect(() => {
    setNodes((prev) => {
      const old = new Map(prev.map((n) => [n.id, n]))
      const next: BoardNode[] = [...cardList.map((dto) => cardNode(dto, old.get(dto.card.id))), ...markList.map((m) => markNode(m, old.get(m.id)))]
      const select = selectNext.current
      if (!select) return next
      // The copies arrive one by one as main saves them.
      if (next.filter((n) => select.has(n.id)).length === select.size) selectNext.current = null
      return next.map((n) => (n.selected === select.has(n.id) ? n : { ...n, selected: select.has(n.id) }))
    })
  }, [cardList, markList])
  useEffect(() => {
    setLinks((prev) => {
      const old = new Map(prev.map((e) => [e.id, e]))
      const s = stateRef.current
      // An agent may write an edge before the card it points at.
      const exists = (id: string) => Boolean(s?.cards[id] || s?.marks[id])
      return edgeList.filter((e) => exists(e.from) && exists(e.to)).map((e) => linkEdge(e, old.get(e.id)))
    })
  }, [edgeList, cardList, markList])

  // Fit once the first nodes have sizes.
  const measured = useNodesInitialized()
  const fitted = useRef(false)
  useEffect(() => {
    if (fitted.current || !state) return
    if (cardList.length + markList.length === 0) {
      fitted.current = true
      setReady(true)
      return
    }
    if (!measured) return
    fitted.current = true
    void Promise.resolve(flow.fitView({ padding: 64, maxZoom: 1 })).then(() => {
      performance.mark("canvas:ready")
      setReady(true)
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [measured, state, cardList.length, markList.length])
  useSmokeReady("canvas", ready || loadError !== null)

  /** Deletes nodes and the given edges, and every edge touching a deleted node, as one step. A live job's card dismisses the job instead. */
  const deleteItems = useCallback(
    (ids: string[], edgeIds: string[] = []) => {
      const s = stateRef.current
      if (!s) return
      const step: Step = []
      const gone = new Set(ids)
      for (const id of ids) {
        const dto = s.cards[id]
        if (dto) {
          // A live answer's cards belong to its job: deleting one asks to dismiss the whole answer, which is not undoable.
          const live = dto.card.pending && "job" in dto.view && dto.view.job && dto.view.job.status !== "accepted" && dto.view.job.status !== "dismissed"
          if (live) {
            gone.delete(id)
            setDismissing(dto.card.pending!.jobId)
          } else step.push({ kind: "card", id, before: dto.card, after: null })
        }
        const m = s.marks[id]
        if (m) step.push({ kind: "mark", id, before: m, after: null })
      }
      const edges = new Set(edgeIds)
      for (const e of Object.values(s.edges)) if (edges.has(e.id) || gone.has(e.from) || gone.has(e.to)) step.push({ kind: "edge", id: e.id, before: e, after: null })
      void commit(step)
    },
    [commit],
  )

  const actions = useMemo<CanvasActions>(
    () => ({
      editText: (id, text) => {
        const card = stateRef.current?.cards[id]?.card
        if (card) void commit([{ kind: "card", id, before: { text: card.text ?? "" }, after: { text } }])
      },
      editCaption: (id, caption) => {
        const card = stateRef.current?.cards[id]?.card
        if (card && caption !== (card.caption ?? "")) void commit([{ kind: "card", id, before: { caption: card.caption ?? "" }, after: { caption } }])
      },
      resize: (id, w) => {
        const card = stateRef.current?.cards[id]?.card
        if (card && Math.round(w) !== card.w) void commit([{ kind: "card", id, before: { w: card.w }, after: { w: Math.round(w) } }])
      },
      refresh,
      fail,
      review: (jobId) => void window.river.jobReview(jobId).catch(fail),
      dismissJob: setDismissing,
      viewLog: setLogOf,
    }),
    [commit, refresh, fail],
  )
  const answerNotes = useMemo(() => new Set(cardList.flatMap((d) => (d.card.kind === "note" && d.card.pending ? [d.card.pending.jobId] : []))), [cardList])

  const reply = async (markId: string, text: string) => {
    const { mark, openMarks } = await window.river.boardReply(board, markId, text)
    putMark(mark.id, mark, openMarks)
  }
  const settleMark = async (markId: string, status: "dismissed" | "accepted", text: string) => {
    const { mark, openMarks } = await window.river.boardCloseMark(board, markId, status, text)
    putMark(mark.id, mark, openMarks)
  }
  const loadLog = useCallback(() => (logOf ? window.river.jobLog(logOf) : Promise.resolve(null)), [logOf])

  /** Saves where dragged cards and marks ended up, as one step. A moved mark is re-anchored to the cards under it. */
  const persistMoves = (moved: BoardNode[]) => {
    const s = stateRef.current
    if (!s) return
    const step: Step = []
    for (const n of moved) {
      if (n.type === "card") {
        const card = s.cards[n.id]?.card
        const x = Math.round(n.position.x)
        const y = Math.round(n.position.y)
        if (card && (x !== card.x || y !== card.y)) step.push({ kind: "card", id: n.id, before: { x: card.x, y: card.y }, after: { x, y } })
      } else {
        const m = s.marks[n.id]
        if (!m) continue
        const b = markBox(m.shape, m.path)
        const dx = Math.round(n.position.x - b.x)
        const dy = Math.round(n.position.y - b.y)
        if (dx === 0 && dy === 0) continue
        const path = translatePath(m.path, dx, dy)
        step.push({ kind: "mark", id: n.id, before: { path: m.path, anchors: m.anchors }, after: { path, anchors: anchorsFor(m.shape, path, cardRects()) } })
      }
    }
    void commit(step)
  }

  /** Arrow keys move a focused node without a drag; those moves are saved once the keys rest, as one step. */
  const keyMoves = useRef<{ ids: Set<string>; timer: number | undefined }>({ ids: new Set(), timer: undefined })
  const noteSettledMoves = (ids: string[]) => {
    if (ids.length === 0) return
    const km = keyMoves.current
    for (const id of ids) km.ids.add(id)
    window.clearTimeout(km.timer)
    km.timer = window.setTimeout(() => {
      const moved = flow.getNodes().filter((n) => km.ids.has(n.id))
      km.ids.clear()
      persistMoves(moved)
    }, 250)
  }

  const selection = () => ({ nodes: flow.getNodes().filter((n) => n.selected), edges: flow.getEdges().filter((e) => e.selected) })

  const deleteSelection = () => {
    const sel = selection()
    deleteItems(
      sel.nodes.map((n) => n.id),
      sel.edges.map((e) => e.id),
    )
  }

  const duplicateSelection = () => {
    const s = stateRef.current
    if (!s) return
    const now = new Date().toISOString()
    const copies = new Map<string, string>()
    const step: Step = []
    for (const n of selection().nodes) {
      const card = s.cards[n.id]?.card
      const mark = s.marks[n.id]
      // A pending card belongs to its job; a copy of it would show nothing.
      if (card && !card.pending) {
        const id = newId("c_")
        copies.set(card.id, id)
        step.push({ kind: "card", id, before: null, after: { ...card, id, x: card.x + NUDGE, y: card.y + NUDGE, createdAt: now } })
      } else if (mark) {
        const id = newId("m_")
        copies.set(mark.id, id)
        const { jobId: _job, ...rest } = mark
        step.push({ kind: "mark", id, before: null, after: { ...rest, id, path: translatePath(mark.path, NUDGE, NUDGE), status: "open", createdAt: now } })
      }
    }
    for (const e of Object.values(s.edges)) {
      const from = copies.get(e.from)
      const to = copies.get(e.to)
      if (from && to) {
        const id = newId("e_")
        step.push({ kind: "edge", id, before: null, after: { ...e, id, from, to, createdAt: now } })
      }
    }
    if (step.length === 0) return
    selectNext.current = new Set(copies.values())
    void commit(step)
  }

  /** Lines the selected cards up left to right, in their current left-to-right order, top-aligned. */
  const arrangeRow = () => {
    const s = stateRef.current
    if (!s) return
    const cards = selection()
      .nodes.filter((n) => n.type === "card")
      .sort((a, b) => a.position.x - b.position.x || a.position.y - b.position.y)
    if (cards.length < 2) return
    const y = Math.round(Math.min(...cards.map((n) => n.position.y)))
    let x = Math.round(cards[0]!.position.x)
    const step: Step = []
    for (const n of cards) {
      const card = s.cards[n.id]?.card
      if (!card) continue
      if (card.x !== x || card.y !== y) step.push({ kind: "card", id: card.id, before: { x: card.x, y: card.y }, after: { x, y } })
      x += Math.round(n.measured?.width ?? card.w) + ROW_GAP
    }
    void commit(step)
  }

  const cardRects = (): { id: string; rect: Rect }[] =>
    flow
      .getNodes()
      .filter((n) => n.type === "card")
      .map((n) => ({
        id: n.id,
        rect: { x: n.position.x, y: n.position.y, w: n.measured?.width ?? n.width ?? 200, h: n.measured?.height ?? n.height ?? 120 },
      }))

  /** The card under a board point (the smallest, if they overlap), else the mark whose box holds it. */
  const nodeAt = (p: Pt): string | undefined => {
    let best: { id: string; area: number; card: boolean } | undefined
    for (const n of flow.getNodes()) {
      const w = n.measured?.width ?? n.width ?? 0
      const h = n.measured?.height ?? n.height ?? 0
      if (p[0] < n.position.x || p[0] > n.position.x + w || p[1] < n.position.y || p[1] > n.position.y + h) continue
      const card = n.type === "card"
      const area = w * h
      if (!best || (card && !best.card) || (card === best.card && area < best.area)) best = { id: n.id, area, card }
    }
    return best?.id
  }

  /** A finished stroke or shape becomes a mark (or joins the last pen mark), or a connector, then asks what the user wants. */
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
      const to = d.from && nodeAt(b)
      if (d.from && to && to !== d.from) {
        const id = newId("e_")
        void commit([{ kind: "edge", id, before: null, after: { id, from: d.from, to, madeBy: ME, createdAt: new Date().toISOString() } }])
        return
      }
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
    if (shape === "pen" && last && prev && now - last.endedAt <= STROKE_JOIN_MS && intersects(grow(box, 4), grow(last.box, 4))) {
      const merged = [...prev.path, ...path]
      const breaks = [...(prev.breaks ?? []), prev.path.length / 2]
      await commit([
        { kind: "mark", id: prev.id, before: { path: prev.path, breaks: prev.breaks ?? [], anchors: prev.anchors }, after: { path: merged, breaks, anchors: anchorsFor("pen", merged, cardRects()) } },
      ])
      const mb = bounds(merged)
      lastPen.current = { id: prev.id, endedAt: Date.now(), box: mb }
      setAsk((cur) => (cur && cur.markId === prev.id ? { markId: prev.id, at: [mb.x + mb.w, mb.y + mb.h] } : cur))
      return
    }
    const id = newId("m_")
    const mark: Mark = { id, shape, path, anchors: anchorsFor(shape, path, cardRects()), thread: [], madeBy: ME, status: "open", createdAt: new Date().toISOString() }
    await commit([{ kind: "mark", id, before: null, after: mark }])
    lastPen.current = shape === "pen" ? { id, endedAt: Date.now(), box } : null
    setAsk({ markId: id, at: shape === "pin" ? [box.x, box.y] : [box.x + box.w, box.y + box.h] })
  }

  const answerAsk = (text: string | null) => {
    const a = ask
    setAsk(null)
    lastPen.current = null
    if (!a || !text) return
    reply(a.markId, text).catch(fail)
  }

  const placeNote = (p: Pt) => {
    const id = newId("c_")
    void commit([{ kind: "card", id, before: null, after: { id, kind: "note", ref: "", text: "", x: Math.round(p[0]), y: Math.round(p[1]), w: 220, madeBy: ME, createdAt: new Date().toISOString() } }])
    setTool("select")
  }

  const viewCenter = (): Pt => {
    const el = wrap.current?.getBoundingClientRect()
    const c = el ? flow.screenToFlowPosition({ x: el.left + el.width / 2, y: el.top + el.height / 2 }) : { x: 0, y: 0 }
    return [c.x, c.y]
  }

  /** Paste and drop: each image goes to the licence form, "own work" filled in, placed at `at` and stepping right. */
  const stageImages = (files: File[], at: Pt) => {
    files.forEach((f, i) => {
      stageFile(f).then(
        (image) => setRefs((q) => [...q, { image, at: [at[0] + i * NUDGE, at[1] + i * NUDGE], licence: "own work" }]),
        fail,
      )
    })
  }

  const chooseTool = (t: Tool) => {
    if (t === "image") {
      const at = viewCenter()
      void window.river.boardPickImage().then((image) => image && setRefs((q) => [...q, { image, at: [at[0] - 120, at[1] - 90], licence: "" }]), fail)
      return
    }
    setTool(t)
    setDraft(null)
  }

  const setSelected = (pick: (id: string) => boolean) => {
    setNodes((ns) => ns.map((n) => (n.selected === pick(n.id) ? n : { ...n, selected: pick(n.id) })))
    setLinks((es) => es.map((e) => (e.selected === pick(e.id) ? e : { ...e, selected: pick(e.id) })))
  }

  /** Cards answering a mark: the job's pending cards and whatever the mark has connectors to. */
  const answersTo = (markId: string): string[] => {
    const s = stateRef.current
    if (!s) return []
    const ids = new Set(Object.values(s.cards).filter((d) => d.card.pending?.markId === markId).map((d) => d.card.id))
    for (const e of Object.values(s.edges)) if (e.from === markId && s.cards[e.to]) ids.add(e.to)
    return [...ids]
  }

  const showAnswer = (markId: string) => {
    const answers = answersTo(markId)
    setSelected((x) => answers.includes(x))
    void flow.fitView({ nodes: [markId, ...answers].map((id) => ({ id })), maxZoom: 1, padding: 120, duration: 300 })
  }

  const jumpTo = (id: string) => {
    setJumping(false)
    setSelected((x) => x === id)
    void flow.fitView({ nodes: [{ id }], maxZoom: 1.2, padding: 120, duration: 320 })
  }

  const onKey = (e: KeyboardEvent) => {
    if (isTyping(e.target)) return
    const mod = e.ctrlKey || e.metaKey
    const key = e.key.toLowerCase()
    if (mod && key === "z") {
      e.preventDefault()
      void (e.shiftKey ? history.redo() : history.undo()).catch(fail)
    } else if (mod && key === "y") {
      e.preventDefault()
      void history.redo().catch(fail)
    } else if (mod && key === "d") {
      e.preventDefault()
      duplicateSelection()
    } else if (mod && key === "k") {
      e.preventDefault()
      setJumping(true)
    } else if (mod && key === "a") {
      e.preventDefault()
      setSelected(() => true)
    } else if (e.key === "Delete" || e.key === "Backspace") {
      e.preventDefault()
      deleteSelection()
    } else if (e.key === "Escape") {
      setDraft(null)
      setSelected(() => false)
      setTool("select")
    } else if (e.shiftKey && (e.code === "Digit1" || e.key === "!" || e.key === "1")) {
      void flow.fitView({ padding: 48, duration: 260 })
    } else if (!mod && !e.altKey) {
      const t = TOOLS.find((x) => x.key === key)
      if (t) chooseTool(t.id)
    }
  }
  const keyRef = useRef(onKey)
  keyRef.current = onKey
  const pasteRef = useRef((_e: ClipboardEvent) => {})
  pasteRef.current = (e: ClipboardEvent) => {
    if (isTyping(e.target)) return
    const files = imageFiles(e.clipboardData?.files)
    if (files.length === 0) return
    e.preventDefault()
    const [x, y] = pointer.current ?? viewCenter()
    stageImages(files, [x - 120, y - 90])
  }
  useEffect(() => {
    const key = (e: KeyboardEvent) => keyRef.current(e)
    const paste = (e: ClipboardEvent) => pasteRef.current(e)
    window.addEventListener("keydown", key)
    window.addEventListener("paste", paste)
    return () => {
      window.removeEventListener("keydown", key)
      window.removeEventListener("paste", paste)
    }
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

  const selectedNodes = nodes.filter((n) => n.selected)
  const selectedLinks = links.filter((e) => e.selected)
  const soleMark = selectedNodes.length === 1 && selectedLinks.length === 0 && selectedNodes[0]!.type === "mark" ? state?.marks[selectedNodes[0]!.id] : undefined
  const cardTitle = (id: string) => {
    const dto = state?.cards[id]
    return dto ? titleOf(dto) : id
  }
  const images = lightbox ? readingOrder(cardList.filter((d) => imageOf(d)).map((d) => ({ id: d.card.id, rect: boardRect(d) }))) : []
  const ref = refs[0]

  return (
    <div className="view canvas-view">
      <div
        className={cx("canvas-wrap", `tool-${tool}`, dropping && "is-dropping")}
        data-canvas-theme={props.theme}
        ref={wrap}
        onPointerMove={(e) => (pointer.current = toFlow(e))}
        onDragEnter={(e) => {
          if (!e.dataTransfer.types.includes("Files")) return
          drag.current.depth++
          setDropping(true)
        }}
        onDragOver={(e) => {
          if (!e.dataTransfer.types.includes("Files")) return
          e.preventDefault()
          e.dataTransfer.dropEffect = "copy"
          setDropping(true)
          window.clearTimeout(drag.current.timer)
          drag.current.timer = window.setTimeout(endDrag, 1_000)
        }}
        onDragLeave={(e) => {
          if (!e.dataTransfer.types.includes("Files")) return
          if (--drag.current.depth <= 0) endDrag()
        }}
        onDrop={(e) => {
          endDrag()
          if (!e.dataTransfer.types.includes("Files")) return
          e.preventDefault()
          const files = imageFiles(e.dataTransfer.files)
          if (files.length === 0) return setActionError("Only images can be dropped on the board.")
          const [x, y] = toFlow(e)
          stageImages(files, [x - 120, y - 90])
        }}
      >
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
          <AnswerNotes.Provider value={answerNotes}>
          <ReactFlow<BoardNode, LinkEdgeType>
            nodes={nodes}
            edges={links}
            nodeTypes={nodeTypes}
            edgeTypes={edgeTypes}
            onNodesChange={(changes) => {
              noteSettledMoves([...changes].filter((c) => c.type === "position" && c.position && !c.dragging).map((c) => c.id))
              // A card's height follows its content: never keep a height that a resize wrote.
              setNodes((ns) => changes.applyTo(ns).map((n) => (n.type === "card" && n.height !== undefined ? { ...n, height: undefined } : n)))
            }}
            onEdgesChange={(changes) => setLinks((es) => changes.applyTo(es))}
            onNodeDragStop={(_e, _n, moved) => persistMoves(moved)}
            onSelectionDragStop={(_e, moved) => persistMoves(moved)}
            onNodeDoubleClick={(_e, n) => imageOf(state?.cards[n.id]) && setLightbox(n.id)}
            nodesConnectable={false}
            nodesDraggable={tool === "select"}
            elementsSelectable={tool === "select"}
            panOnDrag={tool === "hand" ? true : [1, 2]}
            selectionOnDrag={tool === "select"}
            multiSelectionKeyCode={MULTI_SELECT_KEYS}
            deleteKeyCode={null}
            panOnScroll
            zoomOnDoubleClick={false}
            onlyRenderVisibleElements={CULL}
            elevateEdgesOnSelect={false}
            minZoom={0.05}
            maxZoom={4}
            proOptions={{ hideAttribution: true }}
          >
            <Background variant={BackgroundVariant.Dots} gap={20} size={1.4} />
            {draft && draft.points.length > 0 && <DraftLayer draft={draft} />}
            {DRAW_TOOLS.has(tool) && (
              <div
                className={cx("draw-capture", `draw-${tool}`)}
                onPointerDown={(e) => {
                  if (e.button !== 0) return
                  e.currentTarget.setPointerCapture(e.pointerId)
                  const p = toFlow(e)
                  if (tool === "note") return placeNote(p)
                  const from = tool === "arrow" ? nodeAt(p) : undefined
                  const d: Draft = { shape: tool as MarkShape, points: [p], ...(from ? { from } : {}) }
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
                  finishDraft(d).catch(fail)
                }}
              />
            )}
            {ask && <AskBox key={ask.markId} at={ask.at} onDone={answerAsk} />}
            <MiniMap
              className="canvas-minimap"
              position="bottom-right"
              pannable
              zoomable
              ariaLabel="Board overview"
              nodeBorderRadius={2}
              nodeStrokeWidth={0}
              nodeColor={(n) => minimapColor(n as BoardNode)}
              maskColor="var(--mm-mask)"
              maskStrokeColor="var(--mm-view)"
              maskStrokeWidth={1.5}
              bgColor="var(--mm-bg)"
              style={{ width: 168, height: 108 }}
            />
            <Panel position="bottom-right" className="zoom-panel">
              <ZoomControls />
            </Panel>
          </ReactFlow>
          </AnswerNotes.Provider>
        </Actions.Provider>
        <BoardPill board={board} items={cardList.length} openMarks={state?.openMarks ?? 0} onBoard={props.onBoard} theme={props.theme} onTheme={props.onTheme} />
        {selectedNodes.length + selectedLinks.length > 0 && !soleMark && (
          <SelectionBar
            count={selectedNodes.length + selectedLinks.length}
            cards={selectedNodes.filter((n) => n.type === "card").length}
            onRow={arrangeRow}
            onDuplicate={duplicateSelection}
            onDelete={deleteSelection}
          />
        )}
        {soleMark && (
          <MarkPanel
            mark={soleMark}
            answers={answersTo(soleMark.id).length}
            onShowAnswer={() => showAnswer(soleMark.id)}
            cardTitle={cardTitle}
            onAsk={() => window.river.jobStart(board, soleMark.id).catch(fail)}
            onReply={(text) => reply(soleMark.id, text).catch(fail)}
            onRevise={(jobId) => window.river.jobRevise(jobId).catch(fail)}
            onSettle={(status, text) => settleMark(soleMark.id, status, text).catch(fail)}
            onClose={() => setSelected(() => false)}
            onDelete={() => deleteItems([soleMark.id])}
          />
        )}
        {state && cardList.length === 0 && markList.length === 0 && <EmptyBoard />}
        <ToolBar tool={tool} onTool={chooseTool} />
        {ref && (
          <RefForm
            key={ref.image.token}
            fileName={ref.image.fileName}
            licence={ref.licence}
            left={refs.length - 1}
            onCancel={() => setRefs((q) => q.slice(1))}
            onSubmit={async (s) => {
              const dto = await window.river.boardAddRef(board, ref.image.token, s, { x: ref.at[0], y: ref.at[1] })
              putCard(dto.card.id, dto)
              history.record([{ kind: "card", id: dto.card.id, before: null, after: dto.card }])
              setRefs((q) => q.slice(1))
            }}
          />
        )}
        {jumping && state && (
          <QuickJump
            items={[
              ...cardList.map((dto): JumpItem => ({ id: dto.card.id, title: titleOf(dto), detail: [dto.card.label, dto.card.kind, dto.card.text, dto.card.source?.title].filter(Boolean).join(" · "), agent: dto.card.madeBy !== ME })),
              ...markList.map((m): JumpItem => ({ id: m.id, title: m.thread[0]?.text ?? `${m.shape} mark`, detail: `${m.shape} mark · ${m.status}`, agent: m.madeBy !== ME })),
            ]}
            onPick={jumpTo}
            onClose={() => setJumping(false)}
          />
        )}
        {lightbox && images.includes(lightbox) && (
          <Lightbox items={images.map((id) => imageOf(state?.cards[id])!)} at={images.indexOf(lightbox)} onAt={(i) => setLightbox(images[i]!)} onClose={() => setLightbox(null)} />
        )}
        {logOf && <TextPanel title="Job log" sub={`.river/logs/${logOf}.log`} load={loadLog} onClose={() => setLogOf(null)} />}
        {dismissing && (
          <DismissDialog
            onCancel={() => setDismissing(null)}
            onDismiss={async (reason) => {
              const jobId = dismissing
              await window.river.jobDismiss(jobId, reason || undefined)
              // The job removes its own cards and connectors; the watcher brings that in, this is only quicker.
              for (const d of Object.values(stateRef.current?.cards ?? {})) if (d.card.pending?.jobId === jobId) putCard(d.card.id, null)
              setDismissing(null)
            }}
          />
        )}
      </div>
    </div>
  )
}

function minimapColor(n: BoardNode): string {
  if (n.type === "mark") return "var(--mm-mark)"
  const { card } = n.data.dto
  if (card.kind === "note") return card.madeBy === ME ? "var(--mm-note-you)" : "var(--mm-note-agent)"
  return card.kind === "passage" ? "var(--mm-passage)" : "var(--mm-image)"
}

/** The stroke being drawn, in board coordinates inside the viewport, so panning does not re-render it. */
function DraftLayer({ draft }: { draft: Draft }) {
  const a = draft.points[0]!
  const b = draft.points[draft.points.length - 1]!
  const path = draft.shape === "circle" ? flatten(ellipsePoints(a, b)) : draft.shape === "arrow" ? flatten([a, b]) : flatten(draft.points)
  return (
    <ViewportPortal>
      <svg className="draft-layer">
        <MarkShapeView m={{ shape: draft.shape, path, madeBy: ME }} link={Boolean(draft.from)} />
      </svg>
    </ViewportPortal>
  )
}

export function CanvasView(props: CanvasProps) {
  return (
    <ReactFlowProvider>
      <CanvasInner key={props.board} {...props} />
    </ReactFlowProvider>
  )
}
