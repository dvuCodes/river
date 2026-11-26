import { describe, expect, it } from "vitest"
import { reconcileNodes, sameArray, sameSet } from "../src/renderer/src/components/reconcile"

type N = { id: string; type?: string; position: { x: number; y: number }; data: { selected: boolean; lit?: Set<number> }; measured?: { width: number; height: number }; selected?: boolean }
const node = (id: string, selected = false, lit?: Set<number>): N => ({ id, type: "passage", position: { x: 0, y: 0 }, data: { selected, ...(lit ? { lit } : {}) } })
const same = (a: N, b: N) => a.data.selected === b.data.selected && sameSet(a.data.lit, b.data.lit)

describe("reconcileNodes", () => {
  it("keeps every unchanged node object and returns the same list when nothing changed", () => {
    const prev = [node("a"), node("b"), node("c")]
    const next = [node("a"), node("b"), node("c")]
    expect(reconcileNodes(prev, next, same)).toBe(prev)
  })

  it("replaces only the nodes whose data changed (a click: old and new selection)", () => {
    const prev = [node("a", true), node("b"), node("c")]
    prev[0]!.measured = { width: 248, height: 120 }
    const out = reconcileNodes(prev, [node("a"), node("b", true), node("c")], same)
    expect(out[0]).not.toBe(prev[0])
    expect(out[0]!.measured).toEqual({ width: 248, height: 120 })
    expect(out[1]).not.toBe(prev[1])
    expect(out[2]).toBe(prev[2])
  })

  it("compares highlight sets by content, so a new Set with the same members is unchanged", () => {
    const prev = [node("a", false, new Set([0, 2]))]
    expect(reconcileNodes(prev, [node("a", false, new Set([2, 0]))], same)).toBe(prev)
  })

  it("replaces a moved node and adds new ones", () => {
    const prev = [node("a")]
    const moved = { ...node("a"), position: { x: 10, y: 0 } }
    const out = reconcileNodes(prev, [moved, node("b")], same)
    expect(out[0]).not.toBe(prev[0])
    expect(out[0]!.position.x).toBe(10)
    expect(out.map((n) => n.id)).toEqual(["a", "b"])
  })
})

describe("sameArray / sameSet", () => {
  it("treat two absent values as equal and compare members", () => {
    expect(sameArray(undefined, undefined)).toBe(true)
    expect(sameArray([true, false], [true, false])).toBe(true)
    expect(sameArray([true], [false])).toBe(false)
    expect(sameSet(new Set([1]), undefined)).toBe(false)
  })
})
