import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { beforeEach, describe, expect, it } from "vitest"
import { cardRect, ensureBoard, loadBoard, loadMark, loadProject, overlaps, replyToMark, saveCard, saveJob, saveMark, type Card, type Job, type Mark, type Project } from "@river/core"
import { createRiverTools, type RiverTool } from "../src/index"
import { tempProject } from "./helpers"

let dir: string
let project: Project
let passage: Card
let mark: Mark
const tools = (author?: string, conceptId?: string) => createRiverTools(project, { ...(author ? { author } : {}), ...(conceptId ? { conceptId } : {}) })
const call = (name: string, input: unknown = {}, list: RiverTool[] = tools("claude-code")) => list.find((t) => t.name === name)!.handler(input)
const at = (n: number) => new Date(Date.UTC(2026, 0, 1, 0, 0, n)).toISOString()

beforeEach(async () => {
  dir = tempProject()
  project = await loadProject(dir)
  await ensureBoard(dir, "main")
  passage = await saveCard(dir, "main", { kind: "passage", x: 100, y: 50, w: 240, ref: "stories/park_walk.twee#pond", madeBy: "you" })
  mark = await saveMark(dir, "main", {
    shape: "circle",
    path: [80, 30, 360, 30, 360, 260, 80, 260],
    anchors: [passage.id],
    thread: [{ by: "you", at: at(1), text: "make the pond feel calmer" }],
    madeBy: "you",
    createdAt: at(1),
  })
})

describe("board tools", () => {
  it("are read-only or write-marked as they should be, and refuse to write as the user", () => {
    const list = tools()
    const by = (name: string) => list.find((t) => t.name === name)!.mutating
    expect(["board_read", "marks_open", "brief_read"].map(by)).toEqual([false, false, false])
    expect(["mark_claim", "mark_reply", "board_add_note", "board_add_card", "board_connect", "board_place_row"].map(by)).toEqual([true, true, true, true, true, true])
    expect(() => tools("You")).toThrow(/is the user/)
  })

  it("marks_open lists open marks on every board, oldest first; claim and reply take one through to answered", async () => {
    await ensureBoard(dir, "act2")
    await saveMark(dir, "act2", { shape: "pin", path: [0, 0], anchors: [], thread: [{ by: "you", at: at(0), text: "older ask" }], madeBy: "you", createdAt: at(0) })
    const open = await call("marks_open")
    expect(open.text.split("\n").filter((l) => l.startsWith("board "))).toEqual(["board act2:", "board main:"])
    expect(open.text).toContain("you: make the pond feel calmer")

    expect((await call("mark_claim", { markId: mark.id })).text).toContain("as claude-code")
    expect(await loadMark(dir, "main", mark.id)).toMatchObject({ status: "working", claimedBy: "claude-code" })
    await call("mark_claim", { markId: mark.id })
    await expect(call("mark_claim", { markId: mark.id }, tools("other-agent"))).rejects.toThrow(/working by claude-code/)
    expect((await call("marks_open")).text).not.toContain("make the pond feel calmer")

    await call("mark_reply", { markId: mark.id, text: "Three takes on the right.", status: "answered" })
    let m = (await loadMark(dir, "main", mark.id))!
    expect(m).toMatchObject({ status: "answered", claimedBy: "claude-code" })
    expect(m.thread.at(-1)).toMatchObject({ by: "claude-code", text: "Three takes on the right." })

    // The user's reply opens it again for the agent that answered.
    await replyToMark(dir, "main", mark.id, "you", "warmer, please")
    m = (await loadMark(dir, "main", mark.id))!
    expect(m).toMatchObject({ status: "open", claimedBy: "claude-code" })
    await call("mark_claim", { markId: mark.id })
    await call("mark_reply", { markId: mark.id, text: "Giving this back.", status: "open" })
    expect((await loadMark(dir, "main", mark.id))!.claimedBy).toBeUndefined()
  })

  it("leaves the status of a mark a River job works on to the job", async () => {
    const job = { id: "j_live0001", markId: mark.id, board: "main", status: "answered", createdAt: at(2) } as Job
    await saveJob(dir, job)
    await saveMark(dir, "main", { ...mark, jobId: job.id, status: "answered" })
    await expect(call("mark_claim", { markId: mark.id })).rejects.toThrow(/answered \(River job j_live0001\)/)
    await expect(call("mark_reply", { markId: mark.id, text: "x", status: "answered" })).rejects.toThrow(/follows its River job/)
    await call("mark_reply", { markId: mark.id, text: "A comment only." })
    expect((await loadMark(dir, "main", mark.id))!.status).toBe("answered")
  })

  it("adds a note and cards beside a mark without covering anything, connects them once, and places a labelled row", async () => {
    const note = (await call("board_add_note", { near: mark.id, text: "Three takes. A is the safe one." })).data as Card
    expect(note).toMatchObject({ kind: "note", x: 400, y: 30, madeBy: "claude-code" })

    mkdirSync(join(dir, "art"))
    writeFileSync(join(dir, "art", "pond.png"), "png")
    await expect(call("board_add_card", { file: "art/pond.png", near: note.id })).rejects.toThrow(/needs source.licence|pass source.licence/)
    await expect(call("board_add_card", { file: "../pond.png" })).rejects.toThrow(/relative to the project root/)
    await expect(call("board_add_card", { file: "stories/park_walk.twee" })).rejects.toThrow(/not an image/)
    const ref = (await call("board_add_card", { file: "art/pond.png", near: note.id, caption: "made in Godot", source: { licence: "made for this project" } })).data as Card
    expect(ref).toMatchObject({ kind: "ref", ref: "art/pond.png", caption: "made in Godot", source: { licence: "made for this project" } })
    mkdirSync(join(dir, "concepts", "k1"), { recursive: true })
    writeFileSync(join(dir, "concepts", "k1", "concept_b.png"), "png")
    const concept = (await call("board_add_card", { file: "concepts/k1/concept_b.png" })).data as Card
    expect(concept).toMatchObject({ kind: "concept", ref: "k1", variant: "b" })
    expect(concept.source).toBeUndefined()

    const edge = (await call("board_connect", { from: mark.id, to: note.id })).data as { id: string }
    expect(((await call("board_connect", { from: mark.id, to: note.id })).data as { id: string }).id).toBe(edge.id)
    await expect(call("board_connect", { from: mark.id, to: "c_missing0" })).rejects.toThrow(/no card or mark/)

    await call("board_place_row", { cards: [ref.id, concept.id], near: note.id })
    const board = await loadBoard(dir, "main")
    const row = [ref.id, concept.id].map((id) => board.cards.find((c) => c.id === id)!)
    expect(row.map((c) => c.label)).toEqual(["A", "B"])
    expect(row[0]!.y).toBe(row[1]!.y)
    expect(row[0]!.x).toBe(note.x + note.w + 40)
    for (const [i, a] of board.cards.entries()) for (const b of board.cards.slice(i + 1)) expect(overlaps(cardRect(a), cardRect(b)), `${a.id} and ${b.id}`).toBe(false)
    expect(board.edges).toHaveLength(1)
    expect(board.edges[0]).toMatchObject({ from: mark.id, to: note.id, madeBy: "claude-code" })
  })

  it("board_read shows cards with labels and captions, marks with threads, and edges", async () => {
    const note = (await call("board_add_note", { near: mark.id, text: "A note" })).data as Card
    await call("board_connect", { from: mark.id, to: note.id })
    await saveCard(dir, "main", { kind: "concept", x: 900, y: 30, w: 260, ref: "k1", variant: "a", label: "A", caption: "Low sun", madeBy: "concept-artist" })
    const text = (await call("board_read")).text
    expect(text).toMatch(/^board main: 3 cards, 1 marks, 1 edges/)
    expect(text).toContain(`${passage.id}  passage at 100,50 w240  stories/park_walk.twee#pond  by you`)
    expect(text).toMatch(/concept at 900,30 w260 \[A\] "Low sun"  concepts\/k1\/ option a  by concept-artist/)
    expect(text).toContain(`${mark.id}  circle open on ${passage.id}`)
    expect(text).toContain("    you: make the pond feel calmer")
    expect(text).toContain(`${mark.id} -> ${note.id}  by claude-code`)
    await expect(call("board_read", { board: "nope" })).rejects.toThrow(/no board "nope". Boards: main/)
  })

  it("brief_read reads .river/brief.md", async () => {
    expect((await call("brief_read")).text).toMatch(/No brief yet/)
    writeFileSync(join(dir, ".river", "brief.md"), "# Park walk\nWatercolour.\n")
    expect((await call("brief_read")).text).toBe("# Park walk\nWatercolour.\n")
  })
})

describe("concept_write options", () => {
  const CONCEPT = "k_test0002"
  const draw = "extends RefCounted\n\nfunc draw(img: Image) -> void:\n\timg.fill(Color(0.5, 0.6, 0.7))\n"
  const write = (input: unknown) => call("concept_write", input, tools(undefined, CONCEPT))
  const file = (name: string) => join(dir, "concepts", CONCEPT, name)

  it("writes lettered options with captions beside them, removes a script on empty content, and warns about mixing the two forms", async () => {
    expect((await write({ file: `concepts/${CONCEPT}/draw_a.gd`, content: draw, caption: "Low sun:\n long shadows" })).text).toBe(`Wrote concepts/${CONCEPT}/draw_a.gd. Lint: no problems.`)
    expect(readFileSync(file("draw_a.gd"), "utf8")).toBe(draw)
    expect(readFileSync(file("caption_a.txt"), "utf8")).toBe("Low sun: long shadows")
    await expect(write({ file: `concepts/${CONCEPT}/draw_f.gd`, content: draw })).rejects.toThrow(/the only scripts are/)
    await expect(write({ file: `concepts/${CONCEPT}/notes.md`, content: "x", caption: "no" })).rejects.toThrow(/caption is for scripts/)

    const mixed = await write({ file: `concepts/${CONCEPT}/draw.gd`, content: draw })
    expect(mixed.text).toContain("has draw.gd and lettered options")
    expect((await write({ file: `concepts/${CONCEPT}/draw_a.gd`, content: "" })).text).toBe(`Removed concepts/${CONCEPT}/draw_a.gd.`)
    expect(() => readFileSync(file("draw_a.gd"))).toThrow()
    expect(() => readFileSync(file("caption_a.txt"))).toThrow()
    expect((await write({ file: `concepts/${CONCEPT}/draw.gd`, content: draw })).text).not.toContain("lettered options")
  })
})
