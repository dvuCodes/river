import { describe, expect, it } from "vitest"
import { AgentWork } from "../src/main/work"

/** A turn that runs until its signal aborts, as a turn whose process River kills does. */
const turn = (signal: AbortSignal) => new Promise<void>((resolve) => signal.addEventListener("abort", () => setTimeout(resolve, 20), { once: true }))

describe("AgentWork", () => {
  it("stopAll aborts every turn and waits for each to end", async () => {
    const work = new AgentWork()
    const own = new AbortController()
    const signals = [work.signal(own.signal), work.signal()]
    const ended: string[] = []
    signals.forEach((s, i) => void work.track(turn(s)).then(() => ended.push(`turn ${i}`)))
    await work.stopAll(5_000)
    expect(signals.every((s) => s.aborted)).toBe(true)
    expect(ended.sort()).toEqual(["turn 0", "turn 1"])
    expect(work.signal().aborted).toBe(true)
  })

  it("a turn's own stop aborts only that turn", () => {
    const work = new AgentWork()
    const own = new AbortController()
    const mine = work.signal(own.signal)
    const other = work.signal(new AbortController().signal)
    own.abort()
    expect([mine.aborted, other.aborted]).toEqual([true, false])
  })

  it("stopAll gives up on a turn that will not end after the timeout", async () => {
    const work = new AgentWork()
    void work.track(new Promise(() => {}))
    const started = Date.now()
    await work.stopAll(100)
    expect(Date.now() - started).toBeLessThan(2_000)
  })
})
