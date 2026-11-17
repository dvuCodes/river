import { execFile } from "node:child_process"
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs"
import path from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import {
  boardDir,
  claimMark,
  deleteCard,
  formatBoard,
  deleteMark,
  ensureBoard,
  listBoards,
  listJobs,
  loadBoard,
  loadJob,
  openMarks,
  replyToMark,
  saveCard,
  saveJob,
  saveMark,
} from "../../src/boards/boards"
import type { Job } from "../../src/boards/types"
import { removeDir, tempDir } from "../project/helpers"

let root: string
beforeEach(() => {
  root = tempDir("river-boards-")
})
afterEach(() => removeDir(root))

const note = { kind: "note" as const, x: 10, y: 20, w: 200, ref: "", text: "hello", madeBy: "you" }
const pen = (x: number) => ({ shape: "pen" as const, path: [x, 0, x + 5, 5], anchors: [], thread: [], madeBy: "you" })

describe("boards", () => {
  it("creates, reads, updates and deletes cards and marks", async () => {
    expect(await loadBoard(root, "main")).toEqual({ name: "main", cards: [], marks: [], edges: [] })
    await ensureBoard(root, "main")
    expect(JSON.parse(readFileSync(path.join(boardDir(root, "main"), "board.json"), "utf8")).name).toBe("main")
    expect(await listBoards(root)).toEqual(["main"])

    const c = await saveCard(root, "main", note)
    expect(c.id).toMatch(/^c_[0-9a-z]{8}$/)
    expect(new Date(c.createdAt).toISOString()).toBe(c.createdAt)
    const file = path.join(boardDir(root, "main"), "cards", `${c.id}.json`)
    const text = readFileSync(file, "utf8")
    expect(text.endsWith("\n")).toBe(true)
    expect(JSON.parse(text)).toEqual(c)

    const moved = await saveCard(root, "main", { ...c, x: 99 })
    expect(moved.id).toBe(c.id)
    expect(moved.createdAt).toBe(c.createdAt)

    const m = await saveMark(root, "main", { ...pen(0), anchors: [c.id], thread: [{ by: "you", at: c.createdAt, text: "calmer" }] })
    expect(m.id).toMatch(/^m_[0-9a-z]{8}$/)
    expect(m.status).toBe("open")
    const done = await saveMark(root, "main", { ...pen(1), status: "accepted" })

    const board = await loadBoard(root, "main")
    expect(board.cards).toEqual([moved])
    expect(board.marks.map((x) => x.id)).toEqual([m.id, done.id])
    expect(openMarks(board).map((x) => x.id)).toEqual([m.id])

    await deleteCard(root, "main", c.id)
    await deleteMark(root, "main", m.id)
    await deleteMark(root, "main", m.id) // deleting twice is fine
    const after = await loadBoard(root, "main")
    expect(after.cards).toEqual([])
    expect(after.marks.map((x) => x.id)).toEqual([done.id])
    // no temp files left behind
    expect(readdirSync(path.join(boardDir(root, "main"), "cards"))).toEqual([])
  })

  it("requires a licence on reference image cards", async () => {
    await expect(saveCard(root, "main", { kind: "ref", x: 0, y: 0, w: 200, ref: ".river/refs/a.png", madeBy: "you" })).rejects.toThrow(/licence/)
    await expect(saveCard(root, "main", { kind: "ref", x: 0, y: 0, w: 200, ref: ".river/refs/a.png", madeBy: "you", source: { licence: " " } })).rejects.toThrow(/licence/)
    const ok = await saveCard(root, "main", { kind: "ref", x: 0, y: 0, w: 200, ref: ".river/refs/a.png", madeBy: "you", source: { licence: "CC0", url: "https://example.invalid/a" } })
    expect(ok.source?.licence).toBe("CC0")
  })

  it("loses nothing when two writers save marks at the same time", async () => {
    await ensureBoard(root, "main")
    const marksDir = path.join(boardDir(root, "main"), "marks")
    // A second process (as an agent's river-mcp would be) writing its own marks with temp file + rename.
    const script = `
      const fs = require("node:fs"), path = require("node:path")
      const dir = process.argv[1]
      for (let i = 0; i < 50; i++) {
        const id = "m_other" + String(i).padStart(3, "0")
        const tmp = path.join(dir, "." + id + ".json." + process.pid + ".tmp")
        fs.writeFileSync(tmp, JSON.stringify({ id, shape: "pin", path: [i, i], anchors: [], thread: [], status: "open", madeBy: "frame-critic", createdAt: new Date().toISOString() }))
        fs.renameSync(tmp, path.join(dir, id + ".json"))
      }`
    const other = new Promise<void>((resolve, reject) =>
      execFile(process.execPath, ["-e", script, marksDir], (err) => (err ? reject(err) : resolve())),
    )
    const ours = Promise.all(Array.from({ length: 50 }, (_, i) => saveMark(root, "main", pen(i))))
    const [saved] = await Promise.all([ours, other])
    expect(new Set(saved.map((m) => m.id)).size).toBe(50)

    const board = await loadBoard(root, "main")
    expect(board.marks).toHaveLength(100)
    const ids = new Set(board.marks.map((m) => m.id))
    for (const m of saved) expect(ids.has(m.id)).toBe(true)
    for (let i = 0; i < 50; i++) expect(ids.has("m_other" + String(i).padStart(3, "0"))).toBe(true)
    expect(readdirSync(marksDir).filter((n) => n.endsWith(".tmp"))).toEqual([])
  })

  it("keeps every message when the user and agents reply to one mark at once, from two processes", async () => {
    await ensureBoard(root, "main")
    const mark = await saveMark(root, "main", { ...pen(0), thread: [{ by: "you", at: "2026-01-01T00:00:00.000Z", text: "ask" }] })
    const boards = new URL("../../src/boards/boards.ts", import.meta.url).href
    const script = `const { replyToMark } = await import(${JSON.stringify(boards)}); for (let i = 0; i < 15; i++) await replyToMark(process.argv[1], "main", process.argv[2], "other-agent", "other " + i)`
    const other = new Promise<void>((resolve, reject) =>
      execFile(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script, root, mark.id], (err) => (err ? reject(err) : resolve())),
    )
    const ours = Promise.all(Array.from({ length: 15 }, (_, i) => replyToMark(root, "main", mark.id, i % 2 ? "you" : "claude-code", `ours ${i}`)))
    await Promise.all([ours, other])
    const texts = (await loadBoard(root, "main")).marks[0]!.thread.map((m) => m.text)
    expect(texts).toHaveLength(31)
    for (let i = 0; i < 15; i++) expect(texts).toContain(`ours ${i}`)
    for (let i = 0; i < 15; i++) expect(texts).toContain(`other ${i}`)
    expect(readdirSync(path.join(root, ".river", "locks", "marks", "main"))).toEqual([])
  })

  it("lets exactly one of many claims win, and takes over a lock its holder left behind", async () => {
    await ensureBoard(root, "main")
    const mark = await saveMark(root, "main", pen(0))
    const lock = path.join(root, ".river", "locks", "marks", "main", `${mark.id}.lock`)
    mkdirSync(path.dirname(lock), { recursive: true })
    writeFileSync(lock, JSON.stringify({ pid: 999999, host: (await import("node:os")).hostname(), token: "dead" }))
    const results = await Promise.allSettled(["a", "b", "c", "d"].map((who) => claimMark(root, "main", mark.id, who)))
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1)
  })

  it("refuses cards and marks it cannot place, and skips such files when it reads a board", async () => {
    await ensureBoard(root, "main")
    await expect(saveCard(root, "main", { ...note, w: Number.POSITIVE_INFINITY })).rejects.toThrow(/w must be a finite number/)
    await expect(saveCard(root, "main", { ...note, x: Number.NaN })).rejects.toThrow(/x and y must be finite/)
    await expect(saveMark(root, "main", { ...pen(0), path: [0, Number.NaN] })).rejects.toThrow(/finite numbers/)
    const cards = path.join(boardDir(root, "main"), "cards")
    const marks = path.join(boardDir(root, "main"), "marks")
    writeFileSync(path.join(cards, "c_bad1.json"), '{"id":"c_bad1","kind":"note","x":"10","y":0,"w":200,"ref":"","madeBy":"you","createdAt":"2026-01-01T00:00:00.000Z"}')
    writeFileSync(path.join(cards, "c_bad2.json"), '{"id":"c_bad2","kind":"note","x":0,"y":0,"ref":"","madeBy":"you","createdAt":"2026-01-01T00:00:00.000Z"}')
    writeFileSync(path.join(marks, "m_bad1.json"), '{"id":"m_bad1","shape":"pen","path":["10","x",50,50],"anchors":[],"thread":[],"status":"open","madeBy":"you","createdAt":"2026-01-01T00:00:00.000Z"}')
    const problems: string[] = []
    const board = await loadBoard(root, "main", (file, err) => problems.push(`${path.basename(file)}: ${(err as Error).message}`))
    expect(board.cards).toEqual([])
    expect(board.marks).toEqual([])
    expect(problems.sort()).toEqual(["c_bad1.json: not a card: x and y must be finite numbers", "c_bad2.json: not a card: w must be a finite number above 0", "m_bad1.json: not a mark: path must hold finite numbers"])
  })

  it("prints what a mark is on, its box, and each card's height and image file", async () => {
    await ensureBoard(root, "main")
    const passage = await saveCard(root, "main", { kind: "passage", x: 0, y: 0, w: 280, ref: "stories/park_walk.twee#fetch", madeBy: "you" })
    await saveCard(root, "main", { kind: "ref", x: 400, y: 0, w: 260, ref: "art/pond.png", source: { licence: "own work" }, madeBy: "you" })
    await saveMark(root, "main", { shape: "circle", path: [-20, -20, 300, -20, 300, 230, -20, 230], anchors: [passage.id], thread: [{ by: "you", at: "2026-01-01T00:00:00.000Z", text: "a way out" }], madeBy: "you" })
    const text = formatBoard(await loadBoard(root, "main"))
    expect(text).toContain(`${passage.id}  passage at 0,0 w280 h210  stories/park_walk.twee#fetch  by you`)
    expect(text).toContain("ref at 400,0 w260 h260  file: art/pond.png (own work)  by you")
    expect(text).toMatch(new RegExp(`circle open  box -20,-20 320x250 on ${passage.id} \\(passage stories/park_walk\\.twee#fetch\\)`))
  })

  it("skips and reports files that do not parse, and ignores temp files", async () => {
    await ensureBoard(root, "main")
    const dir = boardDir(root, "main")
    const good = await saveCard(root, "main", note)
    writeFileSync(path.join(dir, "cards", "c_broken01.json"), "{ not json")
    writeFileSync(path.join(dir, "cards", "c_nokind01.json"), JSON.stringify({ id: "c_nokind01" }))
    writeFileSync(path.join(dir, "cards", ".c_inflight.json.abc.tmp"), "{")
    writeFileSync(path.join(dir, "marks", "m_broken01.json"), "")
    const errors: string[] = []
    const board = await loadBoard(root, "main", (file) => errors.push(path.basename(file)))
    expect(board.cards.map((c) => c.id)).toEqual([good.id])
    expect(board.marks).toEqual([])
    expect(errors.sort()).toEqual(["c_broken01.json", "c_nokind01.json", "m_broken01.json"])
  })

  it("rejects unsafe board names and ids", async () => {
    for (const bad of ["../x", "Main", "a/b", "", "x".repeat(65), "a b", ".."]) {
      expect(() => boardDir(root, bad)).toThrow(/invalid board name/)
    }
    expect(boardDir(root, "my_board-2")).toBe(path.join(root, ".river", "boards", "my_board-2"))
    await expect(saveCard(root, "../evil", note)).rejects.toThrow(/invalid board name/)
    await expect(saveCard(root, "main", { ...note, id: "../c" })).rejects.toThrow(/invalid card id/)
    await expect(deleteMark(root, "main", "a/b")).rejects.toThrow(/invalid mark id/)
    await expect(loadJob(root, "..\\j")).rejects.toThrow(/invalid job id/)
  })
})

describe("jobs", () => {
  it("saves, loads and lists jobs", async () => {
    const base: Job = {
      id: "",
      markId: "m_aaaaaaaa",
      board: "main",
      role: "concept-artist",
      model: "claude-opus-5-5",
      backend: "claude-code",
      status: "queued",
      conceptId: "concept_aaaaaaaa",
      baseSha: "abc1234",
      branch: "river/job/x",
      worktree: path.join(root, ".git", "river", "worktrees", "x"),
      projectSub: "",
      createdAt: "2026-01-02T00:00:00.000Z",
      updatedAt: "2026-01-02T00:00:00.000Z",
    }
    const a = await saveJob(root, base)
    expect(a.id).toMatch(/^j_[0-9a-z]{8}$/)
    const b = await saveJob(root, { ...base, id: "j_older000", createdAt: "2026-01-01T00:00:00.000Z" })
    expect(await loadJob(root, a.id)).toEqual(a)
    await saveJob(root, { ...a, status: "running" })
    expect((await loadJob(root, a.id)).status).toBe("running")
    mkdirSync(path.join(root, ".river", "jobs"), { recursive: true })
    writeFileSync(path.join(root, ".river", "jobs", "j_bad00000.json"), "nope")
    const errors: string[] = []
    expect((await listJobs(root, (f) => errors.push(path.basename(f)))).map((j) => j.id)).toEqual([b.id, a.id])
    expect(errors).toEqual(["j_bad00000.json"])
    await expect(loadJob(root, "j_missing0")).rejects.toThrow(/no job/)
  })
})

describe("edges", () => {
  it("saves, lists and deletes connectors between cards and marks", async () => {
    const { saveEdge, deleteEdge } = await import("../../src/boards/boards")
    const e = await saveEdge(root, "edgy", { from: "m_aaaaaaaa", to: "c_bbbbbbbb", madeBy: "concept-artist" })
    expect(e.id).toMatch(/^e_/)
    expect((await loadBoard(root, "edgy")).edges).toEqual([e])
    await deleteEdge(root, "edgy", e.id)
    expect((await loadBoard(root, "edgy")).edges).toEqual([])
  })
})
