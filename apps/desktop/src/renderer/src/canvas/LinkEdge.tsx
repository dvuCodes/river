import { BaseEdge, type Edge as FlowEdge, type EdgeProps, type InternalNode, Position, getBezierPath, useInternalNode } from "@xyflow/react"
import { memo } from "react"
import type { Edge } from "@river/core"
import { type Rect, type Side, arrowHead, linkEnds } from "./geometry"

export type LinkEdgeType = FlowEdge<{ edge: Edge }, "link">

const SIDE: Record<Side, Position> = { left: Position.Left, right: Position.Right, top: Position.Top, bottom: Position.Bottom }

function boxOf(n: InternalNode): Rect {
  return { x: n.internals.positionAbsolute.x, y: n.internals.positionAbsolute.y, w: n.measured.width ?? n.width ?? 0, h: n.measured.height ?? n.height ?? 0 }
}

/** A curved connector between two cards or marks, drawn from their boxes (not their handles) with an arrowhead at the target. */
export const LinkEdge = memo(function LinkEdge({ id, source, target, data }: EdgeProps<LinkEdgeType>) {
  const s = useInternalNode(source)
  const t = useInternalNode(target)
  if (!s || !t) return null
  const ends = linkEnds(boxOf(s), boxOf(t))
  const [path, labelX, labelY] = getBezierPath({
    sourceX: ends.from[0],
    sourceY: ends.from[1],
    sourcePosition: SIDE[ends.fromSide],
    targetX: ends.to[0],
    targetY: ends.to[1],
    targetPosition: SIDE[ends.toSide],
  })
  const label = data?.edge.label
  return (
    <>
      <BaseEdge id={id} path={path} interactionWidth={14} {...(label ? { label, labelX, labelY, labelShowBg: true, labelBgPadding: [6, 3] as [number, number], labelBgBorderRadius: 4 } : {})} />
      <path className="link-head" d={arrowHead(ends.to, ends.toSide)} />
    </>
  )
})

export function linkEdge(e: Edge, prev: LinkEdgeType | undefined): LinkEdgeType {
  if (prev && prev.data?.edge === e) return prev
  return { id: e.id, type: "link", source: e.from, target: e.to, data: { edge: e }, selected: prev?.selected ?? false, className: e.madeBy === "you" ? "by-you" : "by-agent" }
}
