import { describe, expect, it, vi } from "vitest"
import { PermissionWaits } from "../src/main/permissions"

const allow = { behavior: "allow" } as const

describe("PermissionWaits", () => {
  it("resolves a request with the user's answer, once", async () => {
    const waits = new PermissionWaits()
    const show = vi.fn()
    const asked = waits.wait("toolu_1", new AbortController().signal, show)
    expect(show).toHaveBeenCalledOnce()
    expect(waits.answer("toolu_1", allow)).toBe(true)
    await expect(asked).resolves.toEqual(allow)
    expect(waits.answer("toolu_1", allow)).toBe(false)
  })

  it("denies a second request with an id already waiting, without showing it, and keeps the first", async () => {
    const waits = new PermissionWaits()
    const real = waits.wait("toolu_1", new AbortController().signal, () => {})
    const show = vi.fn()
    const spoof = await waits.wait("toolu_1", new AbortController().signal, show)
    expect(spoof).toMatchObject({ behavior: "deny" })
    expect(show).not.toHaveBeenCalled()
    expect(waits.answer("toolu_1", allow)).toBe(true)
    await expect(real).resolves.toEqual(allow)
  })

  it("denies a waiting request when its turn stops, and one that arrives after", async () => {
    const waits = new PermissionWaits()
    const stop = new AbortController()
    const asked = waits.wait("toolu_1", stop.signal, () => {})
    stop.abort()
    await expect(asked).resolves.toEqual({ behavior: "deny", message: "Turn stopped." })
    expect(waits.answer("toolu_1", allow)).toBe(false)
    const show = vi.fn()
    await expect(waits.wait("toolu_2", stop.signal, show)).resolves.toEqual({ behavior: "deny", message: "Turn stopped." })
    expect(show).not.toHaveBeenCalled()
  })
})
