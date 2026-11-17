import { mkdirSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs"
import path from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import type { ChangePlan } from "../../src/project/types"
import {
  addThread,
  assertEditAllowed,
  listPlans,
  listThreads,
  loadPlan,
  reply,
  savePlan,
  setPlanStatus,
  setStatus,
} from "../../src/review/review"
import { project, removeDir, tempDir } from "./helpers"

let root: string
beforeEach(() => {
  root = tempDir()
})
afterEach(() => removeDir(root))

describe("review threads", () => {
  it("adds, replies to and sets the status of a thread, stored per shot", async () => {
    const p = project(root)
    const t = await addThread(p, { shotId: "walk", rev: "abc1234", frame: 0, box: [1, 2, 3, 4] }, "dat", "leash looks slack")
    expect(t.id).toMatch(/^t_[0-9a-z]{8}$/)
    expect(t.status).toBe("open")
    expect(t.messages[0]).toMatchObject({ author: "dat", text: "leash looks slack" })
    expect(new Date(t.messages[0]!.at).toISOString()).toBe(t.messages[0]!.at)

    const other = await addThread(p, { shotId: "boss_intro", rev: "abc1234" }, "dat", "sprite too small")

    const r = await reply(p, t.id, "agent", "I will plan a fix")
    expect(r.messages.map((m) => m.author)).toEqual(["dat", "agent"])
    const s = await setStatus(p, t.id, "accepted")
    expect(s.status).toBe("accepted")

    const file = path.join(root, ".river", "review", "walk.json")
    const text = readFileSync(file, "utf8")
    expect(text.endsWith("\n")).toBe(true)
    expect(text).toContain('\n  {\n    "id"')
    const stored = JSON.parse(text)
    expect(stored).toHaveLength(1)
    expect(stored[0]).toMatchObject({ id: t.id, status: "accepted" })
    expect(stored[0].messages).toHaveLength(2)

    expect((await listThreads(p, "walk")).map((x) => x.id)).toEqual([t.id])
    expect((await listThreads(p)).map((x) => x.id).sort()).toEqual([t.id, other.id].sort())
    expect(await listThreads(p, "nothing")).toEqual([])
    // no temp files left behind by the atomic writes
    expect(readdirSync(path.join(root, ".river", "review")).sort()).toEqual(["boss_intro.json", "walk.json"])
  })

  it("rejects unsafe shot ids and unknown threads", async () => {
    const p = project(root)
    await expect(addThread(p, { shotId: "../evil", rev: "x" }, "a", "b")).rejects.toThrow(/invalid shot id/)
    await expect(reply(p, "t_missing0", "a", "b")).rejects.toThrow(/no review thread/)
  })
})

describe("change plans", () => {
  it("savePlan writes a draft, links the thread and sets it to planned; approval sets approvedAt", async () => {
    const p = project(root)
    const t = await addThread(p, { shotId: "walk", rev: "abc" }, "dat", "make the leash tighter")
    const plan = await savePlan(p, {
      threadId: t.id,
      title: "Tighten leash",
      rationale: "The comment asks for more tension",
      steps: [{ file: "data/leash.json", change: "raise tension to 0.8" }],
      recapture: ["walk"],
    })
    expect(plan.id).toMatch(/^p_[0-9a-z]{8}$/)
    expect(plan.status).toBe("draft")
    expect(plan.approvedAt).toBeUndefined()

    const [thread] = await listThreads(p, "walk")
    expect(thread).toMatchObject({ planId: plan.id, status: "planned" })

    const onDisk = readFileSync(path.join(root, ".river", "plans", `${plan.id}.json`), "utf8")
    expect(onDisk.endsWith("\n")).toBe(true)
    expect(await loadPlan(p, plan.id)).toEqual(plan)

    const approved = await setPlanStatus(p, plan.id, "approved")
    expect(approved.status).toBe("approved")
    expect(typeof approved.approvedAt).toBe("string")
    expect((await listPlans(p)).map((x) => x.status)).toEqual(["approved"])

    // Saving over an approved plan resets it to draft, so new steps need a new approval.
    const resaved = await savePlan(p, { ...approved, steps: [{ file: "data/other.json", change: "x" }] })
    expect(resaved.id).toBe(plan.id)
    expect(resaved.status).toBe("draft")
    expect(resaved.approvedAt).toBeUndefined()
  })

  it("savePlan fails for an unknown thread", async () => {
    await expect(
      savePlan(project(root), { threadId: "t_nope0000", title: "x", rationale: "x", steps: [], recapture: [] }),
    ).rejects.toThrow(/no review thread/)
  })
})

describe("assertEditAllowed", () => {
  const plan = (over: Partial<ChangePlan> = {}): ChangePlan => ({
    id: "p_test0001",
    title: "t",
    rationale: "r",
    steps: [
      { file: "data/leash.json", change: "c" },
      { file: "tools\\shots\\walk.gd", change: "c" },
      { file: "src/game/walk.gd", change: "c" },
      { file: "../outside.json", change: "c" },
      { file: "data/link/escape.json", change: "c" },
    ],
    recapture: [],
    status: "approved",
    createdAt: new Date().toISOString(),
    approvedAt: new Date().toISOString(),
    ...over,
  })

  it("allows a listed file of an approved plan that matches the editable globs", () => {
    const p = project(root)
    expect(() => assertEditAllowed(p, plan(), "data/leash.json")).not.toThrow()
    expect(() => assertEditAllowed(p, plan(), "data\\leash.json")).not.toThrow()
    expect(() => assertEditAllowed(p, plan(), "./data//leash.json")).not.toThrow()
    expect(() => assertEditAllowed(p, plan(), "tools/shots/walk.gd")).not.toThrow()
    if (process.platform === "win32") {
      expect(() => assertEditAllowed(p, plan(), "DATA/Leash.json")).not.toThrow()
    }
  })

  it("rejects a plan that is not approved", () => {
    const p = project(root)
    for (const status of ["draft", "rejected", "implemented"] as const) {
      expect(() => assertEditAllowed(p, plan({ status }), "data/leash.json")).toThrow(/not approved/)
    }
  })

  it("rejects a file the plan does not list", () => {
    expect(() => assertEditAllowed(project(root), plan(), "data/other.json")).toThrow(/does not name/)
  })

  it("rejects ../ escapes and absolute paths", () => {
    const p = project(root)
    expect(() => assertEditAllowed(p, plan(), "../outside.json")).toThrow(/without '\.\.'/)
    expect(() => assertEditAllowed(p, plan(), "data/../../outside.json")).toThrow(/without '\.\.'/)
    expect(() => assertEditAllowed(p, plan(), "data\\..\\..\\outside.json")).toThrow(/without '\.\.'/)
    const abs = path.join(root, "data", "leash.json")
    expect(() => assertEditAllowed(p, plan({ steps: [{ file: abs, change: "c" }] }), abs)).toThrow(/relative to the project root/)
    expect(() => assertEditAllowed(p, plan(), "/data/leash.json")).toThrow(/relative to the project root/)
    expect(() => assertEditAllowed(p, plan(), "C:data/leash.json")).toThrow(/relative to the project root/)
    expect(() => assertEditAllowed(p, plan(), "")).toThrow(/relative to the project root/)
  })

  it("rejects a listed file outside the editable globs, and honours manifest.editable", () => {
    expect(() => assertEditAllowed(project(root), plan(), "src/game/walk.gd")).toThrow(/editable globs/)
    expect(() => assertEditAllowed(project(root, { editable: ["src/**"] }), plan(), "src/game/walk.gd")).not.toThrow()
    expect(() => assertEditAllowed(project(root, { editable: ["src/**"] }), plan(), "data/leash.json")).toThrow(/editable globs/)
    expect(() => assertEditAllowed(project(root, { editable: [] }), plan(), "data/leash.json")).toThrow(/editable globs/)
  })

  it("rejects a path that escapes the root through a symlink or junction", () => {
    const outside = tempDir("river-outside-")
    try {
      mkdirSync(path.join(root, "data"), { recursive: true })
      // A junction needs no privilege on Windows; on other platforms the type is ignored.
      symlinkSync(outside, path.join(root, "data", "link"), "junction")
      writeFileSync(path.join(outside, "escape.json"), "{}")
      expect(() => assertEditAllowed(project(root), plan(), "data/link/escape.json")).toThrow(/escapes the project root/)
      // Also when the target does not exist yet.
      const p2 = plan({ steps: [{ file: "data/link/new/file.json", change: "c" }] })
      expect(() => assertEditAllowed(project(root), p2, "data/link/new/file.json")).toThrow(/escapes the project root/)
    } finally {
      removeDir(outside)
    }
  })
})
