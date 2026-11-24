import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { beforeEach, describe, expect, it } from "vitest"
import { cardRect, ensureBoard, loadBoard, loadMark, loadProject, overlaps, replyToMark, saveCard, saveEdge, saveJob, saveMark, type Card, type Job, type Mark, type Project } from "@river/core"
import { createRiverTools, type JobLaunch, type RiverTool } from "../src/index"
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
    await expect(call("mark_claim", { markId: mark.id })).rejects.toThrow(/answered \(River job j_live0001, answered\)/)
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
    const kept = { file: "concepts/k1/draw_b.gd", sha256: "x", approved: true, variant: "b", render: { ok: true as const }, accepted: true }
    await saveJob(dir, { id: "j_k1", conceptId: "k1", markId: mark.id, board: "main", status: "accepted", scripts: [kept], createdAt: at(3) } as Job)
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

  it("board_add_card makes a captured frame a frame card pinned to its capture, and refuses a file no capture lists", async () => {
    const stamp = join(dir, ".river", "captures", "pond", "2026-01-01T00-00-00.000Z")
    mkdirSync(stamp, { recursive: true })
    writeFileSync(join(stamp, "pond_0.png"), "png")
    writeFileSync(join(stamp, "stray.png"), "png")
    writeFileSync(join(stamp, "capture.json"), JSON.stringify({ shotId: "pond", rev: "abc1234", at: "2026-01-01T00:00:00.000Z", files: [join(stamp, "pond_0.png")] }))
    const frame = (await call("board_add_card", { file: ".river/captures/pond/2026-01-01T00-00-00.000Z/pond_0.png", near: mark.id, caption: "the pond now" })).data as Card
    expect(frame).toMatchObject({ kind: "frame", ref: "pond", rev: "abc1234", caption: "the pond now", madeBy: "claude-code" })
    expect(frame.source).toBeUndefined()
    await expect(call("board_add_card", { file: ".river/captures/pond/2026-01-01T00-00-00.000Z/stray.png" })).rejects.toThrow(/not a frame of a capture/)
  })

  it("a concept card needs a job behind it: an accepted option, or a rendered job's pending render; anything else is a reference", async () => {
    const png = (rel: string) => {
      mkdirSync(join(dir, rel, ".."), { recursive: true })
      writeFileSync(join(dir, rel), "png")
    }
    png("concepts/fake/concept.png")
    png("concepts/k2/concept_a.png")
    png(".river/jobs/j_pend0001/render_a.png")
    png(".river/jobs/j_pend0001/render_b.png")
    const scripts = [
      { file: "concepts/j_pend0001/draw_a.gd", sha256: "x", approved: true, variant: "a", render: { ok: true } },
      { file: "concepts/j_pend0001/draw_b.gd", sha256: "y", approved: true, variant: "b", render: { ok: false, error: "parse error" } },
    ]
    await saveJob(dir, { id: "j_pend0001", conceptId: "j_pend0001", markId: mark.id, board: "main", status: "answered", scripts, createdAt: at(3) } as Job)
    await saveJob(dir, { id: "j_k2", conceptId: "k2", markId: mark.id, board: "main", status: "accepted", scripts: [{ ...scripts[0]!, file: "concepts/k2/draw_a.gd" }], createdAt: at(4) } as Job)

    await expect(call("board_add_card", { file: "concepts/fake/concept.png" })).rejects.toThrow(/reference image: pass source.licence/)
    await expect(call("board_add_card", { file: "concepts/k2/concept_a.png" })).rejects.toThrow(/reference image/)
    await expect(call("board_add_card", { file: ".river/jobs/j_pend0001/render_b.png" })).rejects.toThrow(/reference image/)
    const pending = (await call("board_add_card", { file: ".river/jobs/j_pend0001/render_a.png" })).data as Card
    expect(pending).toMatchObject({ kind: "concept", ref: "j_pend0001", variant: "a", pending: { jobId: "j_pend0001", markId: mark.id } })
    const spoof = (await call("board_add_card", { file: "concepts/fake/concept.png", source: { licence: "own work" } })).data as Card
    expect(spoof).toMatchObject({ kind: "ref", ref: "concepts/fake/concept.png" })
  })

  it("answers: a note goes beside the mark with an arrow, image cards join a labelled row beside the note, and the next answer goes under", async () => {
    mkdirSync(join(dir, "art"))
    for (const n of ["a", "b", "c"]) writeFileSync(join(dir, "art", `${n}.png`), "png")
    const source = { licence: "own work" }
    const note = (await call("board_add_note", { answers: mark.id, text: "Two takes." })).data as Card
    const a = (await call("board_add_card", { answers: mark.id, file: "art/a.png", source })).data as Card
    const b = (await call("board_add_card", { answers: mark.id, file: "art/b.png", source, caption: "the warm one" })).data as Card
    expect(note).toMatchObject({ x: 400, y: 30 })
    expect([a.label, b.label]).toEqual(["A", "B"])
    expect([a.y, b.y]).toEqual([note.y, note.y])
    expect(a.x).toBe(note.x + note.w + 40)
    expect(b.x).toBe(a.x + a.w + 40)
    let board = await loadBoard(dir, "main")
    expect(board.edges.map((e) => [e.from, e.to])).toEqual([[mark.id, note.id], [note.id, a.id], [note.id, b.id]])

    const again = (await call("board_add_note", { answers: mark.id, text: "Warmer, as asked." })).data as Card
    const c = (await call("board_add_card", { answers: mark.id, file: "art/c.png", source })).data as Card
    board = await loadBoard(dir, "main")
    const first = [note, a, b].map(cardRect)
    expect(again.x).toBe(note.x)
    expect(again.y).toBe(Math.max(...first.map((r) => r.y + r.h)) + 40)
    expect(c).toMatchObject({ label: "A", y: again.y, x: again.x + again.w + 40 })
    expect(board.edges.at(-1)).toMatchObject({ from: again.id, to: c.id })
    for (const [i, x] of board.cards.entries()) for (const y of board.cards.slice(i + 1)) expect(overlaps(cardRect(x), cardRect(y)), `${x.id} and ${y.id}`).toBe(false)
    await expect(call("board_add_note", { answers: "m_missing", text: "x" })).rejects.toThrow(/no mark "m_missing"/)
    await expect(call("board_add_note", { answers: mark.id, near: mark.id, text: "x" })).rejects.toThrow(/answers or near/)
  })

  it("answers: the user's arrows and River's job answer are not this agent's answer row", async () => {
    const aside = await saveCard(dir, "main", { kind: "note", x: 2000, y: 2000, w: 200, ref: "", text: "far away", madeBy: "you" })
    await saveEdge(dir, "main", { from: mark.id, to: aside.id, madeBy: "you" })
    const jobNote = await saveCard(dir, "main", { kind: "note", x: 400, y: 30, w: 320, ref: "", text: "job", madeBy: "concept-artist", pending: { markId: mark.id, jobId: "j_x" } })
    await saveEdge(dir, "main", { from: mark.id, to: jobNote.id, madeBy: "concept-artist" })
    const note = (await call("board_add_note", { answers: mark.id, text: "mine" })).data as Card
    expect(note.x).toBe(jobNote.x)
    expect(note.y).toBeLessThan(aside.y)
    mkdirSync(join(dir, "art"))
    writeFileSync(join(dir, "art", "a.png"), "png")
    const card = (await call("board_add_card", { answers: mark.id, file: "art/a.png", source: { licence: "own work" } })).data as Card
    expect(card).toMatchObject({ label: "A", y: note.y, x: note.x + note.w + 40 })
  })

  it("card_read and mark_read show text in full; board_read and marks_open say what a mark is on and where", async () => {
    const long = `${"word ".repeat(200)}END`
    const note = (await call("board_add_note", { answers: mark.id, text: long })).data as Card
    await replyToMark(dir, "main", mark.id, "you", `${"more ".repeat(200)}LAST`)
    expect((await call("board_read")).text).not.toContain("END")
    expect((await call("card_read", { cardId: note.id })).text).toContain(long)
    expect((await call("card_read", { cardId: passage.id })).text).toContain("Ducks. Many ducks.")
    const read = (await call("mark_read", { markId: mark.id })).text
    expect(read).toContain("LAST")
    expect(read).toContain(`answer: ${note.id}  note`)
    const open = (await call("marks_open")).text
    expect(open).toContain(`box 80,30 280x230 on ${passage.id} (passage stories/park_walk.twee#pond)`)
  })

  it("card_view returns the image itself, and refuses what it cannot show", async () => {
    mkdirSync(join(dir, "art"))
    const bytes = Buffer.from("89504e470d0a1a0a", "hex")
    writeFileSync(join(dir, "art", "pond.png"), bytes)
    writeFileSync(join(dir, "art", "huge.png"), Buffer.alloc(4 * 1024 * 1024 + 1))
    const card = (await call("board_add_card", { file: "art/pond.png", source: { licence: "own work" } })).data as Card
    const huge = (await call("board_add_card", { file: "art/huge.png", source: { licence: "own work" } })).data as Card
    const seen = await call("card_view", { cardId: card.id })
    expect(seen.images).toEqual([{ data: bytes.toString("base64"), mimeType: "image/png" }])
    expect(seen.text).toContain("art/pond.png")
    await expect(call("card_view", { cardId: huge.id })).rejects.toThrow(/up to 4 MB/)
    await expect(call("card_view", { cardId: passage.id })).rejects.toThrow(/not an image/)
    const waiting = await saveCard(dir, "main", { kind: "concept", x: 900, y: 900, w: 260, ref: "j_wait0001", variant: "a", madeBy: "concept-artist", pending: { markId: mark.id, jobId: "j_wait0001" } })
    await expect(call("card_view", { cardId: waiting.id })).rejects.toThrow(/has not rendered it yet/)
    await saveCard(dir, "main", { ...card, id: "c_escape01", ref: "../outside.png" })
    await expect(call("card_view", { cardId: "c_escape01" })).rejects.toThrow(/outside the project root/)
  })

  it("an agent changes and removes only its own cards, and never moves River's pending options", async () => {
    const mine = (await call("board_add_note", { answers: mark.id, text: "first" })).data as Card
    expect(((await call("board_update_note", { cardId: mine.id, text: "second" })).data as Card).text).toBe("second")
    await expect(call("board_update_note", { cardId: mine.id, text: "x" }, tools("other-agent"))).rejects.toThrow(/made by claude-code/)
    await expect(call("board_remove_card", { cardId: passage.id })).rejects.toThrow(/made by you/)
    const option = await saveCard(dir, "main", { kind: "concept", x: 900, y: 900, w: 260, ref: "j_x", variant: "b", label: "B", madeBy: "claude-code", pending: { markId: mark.id, jobId: "j_x" } })
    await expect(call("board_remove_card", { cardId: option.id })).rejects.toThrow(/River job j_x/)
    await expect(call("board_place_row", { cards: [option.id], near: mark.id })).rejects.toThrow(/River places and labels it/)
    expect((await call("board_remove_card", { cardId: mine.id })).text).toBe(`Removed ${mine.id} and 1 arrow.`)
    const board = await loadBoard(dir, "main")
    expect(board.cards.some((c) => c.id === mine.id)).toBe(false)
    expect(board.edges).toEqual([])
  })

  it("claims are exclusive: only the claimant changes the status, a stale claim can be taken over, and a mark can be dismissed", async () => {
    await call("mark_claim", { markId: mark.id })
    const other = tools("other-agent")
    await expect(call("mark_claim", { markId: mark.id }, other)).rejects.toThrow(/working by claude-code/)
    await expect(call("mark_reply", { markId: mark.id, text: "done", status: "answered" }, other)).rejects.toThrow(/claimed by claude-code .*only claude-code changes its status/)
    await call("mark_reply", { markId: mark.id, text: "a comment is fine" }, other)
    await saveMark(dir, "main", { ...(await loadMark(dir, "main", mark.id))!, claimedAt: new Date(Date.now() - 31 * 60_000).toISOString() })
    expect((await call("mark_claim", { markId: mark.id }, other)).text).toContain("as other-agent")
    const dismissed = (await call("mark_reply", { markId: mark.id, text: "Out of scope: this is a sound request.", status: "dismissed" }, other)).data
    expect(dismissed).toMatchObject({ status: "dismissed", claimedBy: "other-agent" })
    expect(await replyToMark(dir, "main", mark.id, "you", "It is not sound: the pond scene needs it.")).toMatchObject({ status: "open", claimedBy: "other-agent" })
    await expect(replyToMark(dir, "main", mark.id, "claude-code", "", "accepted")).rejects.toThrow(/only the user accepts/)
    expect(await replyToMark(dir, "main", mark.id, "you", "", "accepted")).toMatchObject({ status: "accepted" })
  })

  it("a mark whose River job failed stays with the job: no claim, no status, and marks_open leaves it out", async () => {
    await saveJob(dir, { id: "j_fail0001", markId: mark.id, board: "main", status: "failed", createdAt: at(2) } as Job)
    await saveMark(dir, "main", { ...mark, jobId: "j_fail0001", status: "open" })
    await expect(call("mark_claim", { markId: mark.id })).rejects.toThrow(/River job j_fail0001, failed; the user can retry it/)
    await expect(call("mark_reply", { markId: mark.id, text: "x", status: "answered" })).rejects.toThrow(/follows its River job/)
    expect((await call("marks_open")).text).toBe("No open marks.")
  })

  it("concept_request starts a job through the launcher and returns its id at once", async () => {
    const launches: unknown[] = []
    const jobLauncher = async (l: JobLaunch) => {
      launches.push(l)
      await saveJob(l.root, { id: l.jobId, markId: l.markId, board: "main", status: "queued", createdAt: at(5) } as Job)
      return { log: "x.log" }
    }
    const list = createRiverTools(project, { author: "claude-code", jobLauncher })
    const r = await call("concept_request", { markId: mark.id }, list)
    const jobId = (r.data as { jobId: string }).jobId
    expect(jobId).toMatch(/^j_[a-z0-9]{8}$/)
    expect(launches).toEqual([{ root: project.root, board: "main", markId: mark.id, jobId, by: "claude-code", backend: "claude-code", model: "claude-sonnet-5-5" }])
    expect(r.text).toContain(`Started River concept job ${jobId}`)
    expect(r.text).toContain("approves the scripts in River")
    await expect(call("concept_request", { markId: "m_missing" }, list)).rejects.toThrow(/no mark/)
    await call("concept_request", { markId: mark.id, model: "claude-haiku-4-5" }, list)
    expect(launches[1]).toMatchObject({ model: "claude-haiku-4-5" })
    await expect(call("concept_request", { markId: mark.id, model: "--bad" }, list)).rejects.toThrow(/invalid input for concept_request/)
    expect(launches).toHaveLength(2)
  })

  it("board_read shows cards with labels and captions, marks with threads, and edges", async () => {
    const note = (await call("board_add_note", { near: mark.id, text: "A note" })).data as Card
    await call("board_connect", { from: mark.id, to: note.id })
    await saveCard(dir, "main", { kind: "concept", x: 900, y: 30, w: 260, ref: "k1", variant: "a", label: "A", caption: "Low sun", madeBy: "concept-artist" })
    const text = (await call("board_read")).text
    expect(text).toMatch(/^board main: 3 cards, 1 marks, 1 edges/)
    expect(text).toContain(`${passage.id}  passage at 100,50 w240 h180  stories/park_walk.twee#pond  by you`)
    expect(text).toMatch(/concept at 900,30 w260 h2\d\d \[A\] "Low sun"  concepts\/k1\/ option a  file: concepts\/k1\/concept_a\.png  by concept-artist/)
    expect(text).toContain(`${mark.id}  circle open  box 80,30 280x230 on ${passage.id} (passage stories/park_walk.twee#pond)`)
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

  it("refuses to write a script that gives anything else the name Kit", async () => {
    await expect(write({ file: `concepts/${CONCEPT}/draw_b.gd`, content: `${draw}\tvar Kit = img\n\tKit.fill(Color.RED)\n` })).rejects.toThrow(/Line 5: "Kit" may appear only as a call/)
    expect(() => readFileSync(file("draw_b.gd"))).toThrow()
  })
})
