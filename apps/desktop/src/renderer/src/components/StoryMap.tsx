import {
  Background,
  BackgroundVariant,
  Controls,
  type Edge,
  Handle,
  MarkerType,
  MiniMap,
  type Node,
  type NodeProps,
  type NodeTypes,
  type OnNodeDrag,
  Position,
  ReactFlow,
  ReactFlowProvider,
  useNodesInitialized,
  useReactFlow,
} from "@xyflow/react"
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react"
import type { OpenStateDTO, PassageDTO, StoryDTO } from "../../../shared/api"
import { NODE_W, autoLayout, estimateHeight } from "../layout"
import { cx } from "../util"
import { reconcileNodes, sameArray, sameSet } from "./reconcile"

export interface Highlight {
  passages: Set<string>
  /** "<passageId>:<choiceIndex>" */
  edges: Set<string>
}

type PassageNodeData = {
  passage: PassageDTO
  selected: boolean
  dim: boolean
  closed: boolean
  closedChoices: boolean[] | undefined
  litChoices: Set<number> | undefined
}
type PassageNode = Node<PassageNodeData, "passage">
type GhostNode = Node<{ name: string }, "ghost">

const HIDDEN_TAGS = new Set(["start", "ending"])

const PassageCard = memo(function PassageCard({ data }: NodeProps<PassageNode>) {
  const { passage: p, selected, dim, closed, closedChoices, litChoices } = data
  const tags = p.tags.filter((t) => !HIDDEN_TAGS.has(t))
  return (
    <div className={cx("pnode", selected && "is-selected", dim && "is-dim", closed && "is-closed", p.isStart && "is-start", p.isEnding && "is-ending")}>
      <Handle type="target" position={Position.Left} className="h-in" />
      <div className="pnode-head">
        <span className="pnode-name" title={p.name}>
          {p.name}
        </span>
        {p.isStart && <span className="badge badge-start">start</span>}
        {p.isEnding && <span className="badge badge-end">end</span>}
      </div>
      {tags.length > 0 && (
        <div className="pnode-tags">
          {tags.map((t) => (
            <span key={t} className="chip">
              {t}
            </span>
          ))}
        </div>
      )}
      {p.when && (
        <div className="pnode-when mono" title={`@when ${p.when}`}>
          <span className="kw">when</span> {p.when}
        </div>
      )}
      {p.choices.length > 0 ? (
        <ul className="pnode-choices">
          {p.choices.map((c, i) => (
            <li
              key={i}
              className={cx(!c.targetId && "is-broken", closedChoices?.[i] === false && "is-shut", litChoices?.has(i) && "is-lit")}
              title={[c.when && `@when ${c.when}`, c.cost && `@cost ${c.cost}`, c.set && `@set ${c.set}`].filter(Boolean).join("\n") || c.target}
            >
              <span className="lbl">{c.label}</span>
              {c.when && <span className="cond-mark mono">?</span>}
              <Handle type="source" id={`c${i}`} position={Position.Right} className="h-out" />
            </li>
          ))}
        </ul>
      ) : (
        <div className="pnode-foot">{p.isEnding ? "ending" : "no choices"}</div>
      )}
    </div>
  )
})

function GhostCard({ data }: NodeProps<GhostNode>) {
  return (
    <div className="gnode">
      <Handle type="target" position={Position.Left} className="h-in" />
      <span className="gnode-k">missing</span>
      <span className="gnode-name">{data.name}</span>
    </div>
  )
}

const nodeTypes: NodeTypes = { passage: PassageCard, ghost: GhostCard } as unknown as NodeTypes

type MapNode = PassageNode | GhostNode

/** A node's data is unchanged: same passage object and the same overlay flags. */
function sameNodeData(a: MapNode, b: MapNode): boolean {
  if (a.type === "ghost" || b.type === "ghost") return a.type === "ghost" && b.type === "ghost" && a.data.name === b.data.name
  const x = a.data
  const y = b.data
  return (
    x.passage === y.passage &&
    x.selected === y.selected &&
    x.dim === y.dim &&
    x.closed === y.closed &&
    sameArray(x.closedChoices, y.closedChoices) &&
    sameSet(x.litChoices, y.litChoices)
  )
}

interface EdgeColors {
  danger: string
  accent: string
  edge: string
}

/** The theme colours edges are drawn in, read from the CSS variables. */
function readEdgeColors(): EdgeColors {
  const css = getComputedStyle(document.documentElement)
  const color = (name: string) => css.getPropertyValue(name).trim() || "#888"
  return { danger: color("--danger"), accent: color("--accent"), edge: color("--edge") }
}

/** Edge colours, read once and again only when the OS switches between light and dark. */
function useEdgeColors(): EdgeColors {
  const [colors, setColors] = useState(readEdgeColors)
  useEffect(() => {
    const mq = window.matchMedia?.("(prefers-color-scheme: dark)")
    if (!mq) return
    const update = () => setColors(readEdgeColors())
    mq.addEventListener("change", update)
    return () => mq.removeEventListener("change", update)
  }, [])
  return colors
}

export interface StoryMapProps {
  story: StoryDTO
  selectedId?: string | undefined
  onSelect(id: string | undefined): void
  highlight?: Highlight | undefined
  open?: OpenStateDTO | undefined
  /** Called when a drag ends, with the new positions of the dragged passages only. */
  onMoved?: ((positions: Record<string, [number, number]>) => void) | undefined
  /** Change the nonce to center the map on `focus.id`. */
  focus?: { id: string; nonce: number } | undefined
  onReady?: (() => void) | undefined
}

function MapInner(props: StoryMapProps) {
  const { story, selectedId, onSelect, highlight, open, onMoved, focus, onReady } = props
  const flow = useReactFlow()
  const positions = useRef<Record<string, [number, number]>>({})
  const fileRef = useRef(story.file)
  if (fileRef.current !== story.file) {
    fileRef.current = story.file
    positions.current = {}
  }
  // Laid out once per story; drags write into positions.current, which the next layout keeps.
  const layout = useMemo(() => {
    positions.current = autoLayout(story, positions.current)
    return positions.current
  }, [story])
  const colors = useEdgeColors()

  /** Missing targets go in their own column right of the map, so they never sit on a card. Placed once per layout. */
  const ghostNodes = useMemo(() => {
    const ghosts = new Map<string, GhostNode>()
    const ghostX = Math.max(0, ...Object.values(layout).map(([px]) => px)) + NODE_W + 96
    const usedGhostY: number[] = []
    for (const p of story.passages) {
      const [, y] = layout[p.id] ?? [0, 0]
      p.choices.forEach((c, i) => {
        if (c.targetId) return
        const target = `missing:${c.target}`
        if (ghosts.has(target)) return
        let gy = y + 30 + i * 24
        while (usedGhostY.some((u) => Math.abs(u - gy) < 52)) gy += 52
        usedGhostY.push(gy)
        ghosts.set(target, { id: target, type: "ghost", position: { x: ghostX, y: gy }, data: { name: c.target }, draggable: false })
      })
    }
    return [...ghosts.values()]
  }, [story, layout])

  const builtNodes = useMemo(() => {
    const ns: MapNode[] = []
    for (const p of story.passages) {
      const [x, y] = layout[p.id] ?? [0, 0]
      const closedChoices = open?.choices[p.id]
      const lit = highlight
        ? new Set(p.choices.map((_, i) => i).filter((i) => highlight.edges.has(`${p.id}:${i}`)))
        : undefined
      ns.push({
        id: p.id,
        type: "passage",
        position: { x, y },
        width: NODE_W,
        data: {
          passage: p,
          selected: p.id === selectedId,
          dim: highlight ? !highlight.passages.has(p.id) : false,
          closed: open ? open.passages[p.id] === false : false,
          closedChoices,
          litChoices: lit,
        },
      })
    }
    ns.push(...ghostNodes)
    return ns
    // The selection only changes node data, so edges are built apart and do not depend on it.
  }, [story, layout, ghostNodes, selectedId, highlight, open])

  const edges = useMemo(() => {
    const es: Edge[] = []
    for (const p of story.passages) {
      const closedChoices = open?.choices[p.id]
      p.choices.forEach((c, i) => {
        const id = `${p.id}:${i}`
        const target = c.targetId ?? `missing:${c.target}`
        const isLit = highlight?.edges.has(id) ?? false
        const isDim = (highlight && !isLit) || closedChoices?.[i] === false
        const stroke = !c.targetId ? colors.danger : isLit ? colors.accent : colors.edge
        es.push({
          id,
          source: p.id,
          sourceHandle: `c${i}`,
          target,
          className: cx(isDim && "edge-dim"),
          style: {
            stroke,
            strokeWidth: isLit ? 2.4 : 1.4,
            ...(c.when ? { strokeDasharray: "5 4" } : {}),
          },
          markerEnd: { type: MarkerType.ArrowClosed, width: 14, height: 14, color: stroke },
          zIndex: isLit ? 2 : 0,
        })
      })
    }
    return es
  }, [story, highlight, open, colors])

  const [nodes, setNodes] = useState<MapNode[]>(builtNodes)
  // Unchanged nodes keep their objects (and React Flow's measured size), so a click redraws two cards, not all of them.
  useEffect(() => setNodes((prev) => reconcileNodes(prev, builtNodes, sameNodeData)), [builtNodes])

  // Fit once the cards have real sizes. In xyflow v13 a numeric padding is pixels, not a fraction.
  const measured = useNodesInitialized()
  const fittedFor = useRef<string | null>(null)
  useEffect(() => {
    if (!measured || fittedFor.current === story.file) return
    fittedFor.current = story.file
    void Promise.resolve(flow.fitView({ padding: { top: 40, bottom: 56, left: 40, right: 40 }, maxZoom: 1.15 })).then(() => onReady?.())
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [measured, story.file])

  const onDragStop: OnNodeDrag = useCallback(
    (_e, _node, dragged) => {
      const moved: Record<string, [number, number]> = {}
      for (const n of dragged) {
        if (n.type !== "passage") continue
        const pos: [number, number] = [Math.round(n.position.x), Math.round(n.position.y)]
        positions.current[n.id] = pos
        moved[n.id] = pos
      }
      if (Object.keys(moved).length > 0) onMoved?.(moved)
    },
    [onMoved],
  )

  useEffect(() => {
    if (!focus) return
    const pos = positions.current[focus.id]
    const p = story.passages.find((q) => q.id === focus.id)
    if (!pos || !p) return
    void flow.setCenter(pos[0] + NODE_W / 2, pos[1] + estimateHeight(p) / 2, { zoom: Math.max(flow.getZoom(), 0.9), duration: 300 })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focus?.nonce])

  return (
    <ReactFlow
      nodes={nodes}
      edges={edges}
      nodeTypes={nodeTypes}
      onNodesChange={(changes) => setNodes((ns) => changes.applyTo(ns))}
      onNodeDragStop={onDragStop}
      onNodeClick={(_e, n) => onSelect(n.type === "passage" ? n.id : undefined)}
      onPaneClick={() => onSelect(undefined)}
      nodesConnectable={false}
      nodesDraggable={Boolean(onMoved)}
      edgesFocusable={false}
      deleteKeyCode={null}
      minZoom={0.2}
      maxZoom={2}
      proOptions={{ hideAttribution: true }}
    >
      <Background variant={BackgroundVariant.Dots} gap={18} size={1.2} />
      <Controls showInteractive={false} position="bottom-right" />
      <MiniMap pannable zoomable position="top-right" nodeStrokeWidth={2} className="minimap" />
    </ReactFlow>
  )
}

export function StoryMap(props: StoryMapProps) {
  return (
    <ReactFlowProvider>
      <MapInner {...props} />
    </ReactFlowProvider>
  )
}
