import { execFileSync } from "node:child_process"
import { createHash } from "node:crypto"
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import type { RenderConceptRequest } from "@river/adapter-godot"
import { cardRect, ensureBoard, loadBoard, loadJob, loadMark, overlaps, saveCard, saveMark, type Card, type Job, type Mark } from "@river/core"
import {
  acceptJob,
  approveJobScript,
  approveJobScripts,
  dismissJob,
  readJobScript,
  readJobScripts,
  reviseJob,
  startConceptJob,
  type JobDeps,
  type RunTurn,
} from "../src/jobs"
import { systemPrompt } from "../src/prompts"
import type { AgentTurnRequest } from "../src/types"
import { EXAMPLE, removeDir } from "./helpers"

const draw = (color: string, extra = "") => `extends RefCounted\n\nfunc draw(img: Image) -> void:\n\timg.fill(Color(${color}))\n${extra}`
const A = draw("0.8, 0.6, 0.3")
const B = draw("0.2, 0.3, 0.5")
const C = draw("0.5, 0.5, 0.5")
const BROKEN = draw("0.1, 0.1, 0.1", "\tvar a := [1]\n\tvar b = a[3]\n")
const NOTE = "A: warm dusk. Risk: too sweet.\nB: blue hour. Risk: cold.\nC: overcast. Risk: flat.\nI would pick A."
const sha = (text: string | Buffer) => createHash("sha256").update(text).digest("hex")
const GODOT = { GODOT_BIN: "godot-not-run" }

let top: string
let game: string
let mark: Mark
let passage: Card
const git = (...args: string[]) =>
  execFileSync("git", ["-c", "core.autocrlf=false", ...args], {
    cwd: top,
    encoding: "utf8",
    env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.invalid", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.invalid" },
  })

beforeEach(async () => {
  top = realpathSync.native(mkdtempSync(path.join(tmpdir(), "river-answers-")))
  game = path.join(top, "game")
  cpSync(EXAMPLE, game, { recursive: true })
  git("init", "-q", "-b", "main")
  git("add", "-A")
  git("commit", "-q", "-m", "init")
  await ensureBoard(game, "main")
  passage = await saveCard(game, "main", { kind: "passage", x: 100, y: 50, w: 240, ref: "stories/park_walk.twee#pond", madeBy: "you" })
  // Something already sits where the answer would go, so the row has to move down past it.
  await saveCard(game, "main", { kind: "note", x: 900, y: 0, w: 200, ref: "", text: "in the way", madeBy: "you" })
  mark = await saveMark(game, "main", {
    shape: "circle",
    path: [80, 30, 360, 30, 360, 260, 80, 260],
    anchors: [passage.id],
    thread: [{ by: "you", at: new Date().toISOString(), text: "give me three moods for the pond" }],
    madeBy: "you",
  })
})
afterEach(() => removeDir(top))

/** A turn that writes these files into its concept folder (scripts and caption_<v>.txt, as concept_write does) and says `note`. */
function turnWriting(files: Record<string, string>, seen: AgentTurnRequest[] = [], note = NOTE): RunTurn {
  return async (req, h) => {
    seen.push(req)
    if (req.sessionId === "gone") {
      h.onEvent({ type: "session", sessionId: "gone" })
      h.onEvent({ type: "error", message: "Turn ended with error_during_execution: No conversation found with session ID: gone" })
      h.onEvent({ type: "done" })
      return
    }
    h.onEvent({ type: "session", sessionId: req.sessionId ?? `s${seen.length}` })
    const dir = path.join(req.root, "concepts", req.conceptId!)
    mkdirSync(dir, { recursive: true })
    for (const [name, text] of Object.entries(files)) writeFileSync(path.join(dir, name), text)
    h.onEvent({ type: "text", text: note })
    h.onEvent({ type: "done" })
  }
}

const THREE = { "draw_a.gd": A, "caption_a.txt": "Warm dusk", "draw_b.gd": B, "caption_b.txt": "Blue hour\n(cold)", "draw_c.gd": C }

/** Renders by writing the script's text as the PNG, so a test can tell which script made which file. Fails for BROKEN. */
function fakeRender(seen: string[] = []): JobDeps["render"] {
  return async (req: RenderConceptRequest) => {
    const text = Buffer.from(req.script).toString("utf8")
    seen.push(text)
    if (text === BROKEN) throw new Error("river: concept render failed: the script raised an error\nOut of bounds get index '3'")
    mkdirSync(path.dirname(req.outPng), { recursive: true })
    writeFileSync(req.outPng, `png of ${text}`)
  }
}

const start = (deps: JobDeps) => startConceptJob({ workspaceRoot: game, board: "main", markId: mark.id, model: "claude-sonnet-5-5", backend: "claude-code" }, deps)
const settings = { model: "claude-sonnet-5-5" as const, backend: "claude-code" as const }
const answerOf = async (job: Job) => (await loadBoard(game, "main")).cards.filter((c) => c.pending?.jobId === job.id)
const reply = async (text: string) => {
  const m = (await loadMark(game, "main", mark.id))!
  await saveMark(game, "main", { ...m, thread: [...m.thread, { by: "you", at: new Date().toISOString(), text }] })
}
const allShas = async (job: Job) => Object.fromEntries((await readJobScripts(game, job.id)).map((s) => [s.file, s.sha256]))

describe("answers with options", { timeout: 120_000 }, () => {
  it("lays out the note and a labelled, captioned row of options beside the mark, clear of other cards, with edges", async () => {
    const job = await start({ runTurn: turnWriting(THREE) })
    expect(job.status).toBe("approval")
    expect(job.scripts!.map((s) => [s.file, s.variant, s.caption, s.approved])).toEqual([
      [`concepts/${job.id}/draw_a.gd`, "a", "Warm dusk", false],
      [`concepts/${job.id}/draw_b.gd`, "b", "Blue hour (cold)", false],
      [`concepts/${job.id}/draw_c.gd`, "c", undefined, false],
    ])
    const board = await loadBoard(game, "main")
    const answer = await answerOf(job)
    const note = answer.find((c) => c.kind === "note")!
    const options = answer.filter((c) => c.kind === "concept").sort((a, b) => a.x - b.x)
    expect(note).toMatchObject({ text: NOTE, w: 320, madeBy: "concept-artist" })
    expect(options.map((c) => [c.label, c.variant, c.caption, c.ref])).toEqual([
      ["A", "a", "Warm dusk", job.conceptId],
      ["B", "b", "Blue hour (cold)", job.conceptId],
      ["C", "c", undefined, job.conceptId],
    ])
    // One row, note first, right of the mark, moved below the card in its way.
    expect(new Set([note, ...options].map((c) => c.y)).size).toBe(1)
    expect(note.x).toBe(400)
    expect(note.x).toBeLessThan(options[0]!.x)
    const others = board.cards.filter((c) => !c.pending).map(cardRect)
    for (const c of [note, ...options]) for (const o of others) expect(overlaps(cardRect(c), o)).toBe(false)
    expect(board.edges.map((e) => [e.from, e.to]).sort()).toEqual([[mark.id, note.id], ...options.map((o) => [note.id, o.id])].sort())
  })

  it("approves only with every script's sha, renders each, and keeps answering when one option fails", async () => {
    const job = await start({ runTurn: turnWriting({ ...THREE, "draw_b.gd": BROKEN }) })
    const scripts = await readJobScripts(game, job.id)
    expect(scripts.map((s) => [s.variant, s.text, s.sha256])).toEqual([["a", A, sha(A)], ["b", BROKEN, sha(BROKEN)], ["c", C, sha(C)]])
    await expect(readJobScript(game, job.id)).rejects.toThrow(/has 3 scripts/)
    await expect(approveJobScript(game, job.id, sha(A), { render: fakeRender(), env: GODOT })).rejects.toThrow(/approve every one/)

    const rendered: string[] = []
    const deps = { render: fakeRender(rendered), env: GODOT }
    const shas = await allShas(job)
    const [fa, fb] = Object.keys(shas)
    const { [fb!]: _b, ...withoutB } = shas
    await expect(approveJobScripts(game, job.id, withoutB, deps)).rejects.toThrow(/draw_b\.gd hashes to/)
    await expect(approveJobScripts(game, job.id, { ...shas, [fa!]: sha(B) }, deps)).rejects.toThrow(/draw_a\.gd hashes to/)
    await expect(approveJobScripts(game, job.id, { ...shas, [`concepts/${job.id}/draw_d.gd`]: sha(A) }, deps)).rejects.toThrow(/not a script/)
    expect(rendered).toEqual([])
    expect((await loadJob(game, job.id)).status).toBe("approval")

    const answered = await approveJobScripts(game, job.id, shas, deps)
    expect(answered.status).toBe("answered")
    expect(rendered).toEqual([A, BROKEN, C])
    expect(answered.scripts!.map((s) => [s.variant, s.approved, s.render?.ok])).toEqual([["a", true, true], ["b", true, false], ["c", true, true]])
    expect(answered.scripts![1]!.render).toMatchObject({ ok: false, error: expect.stringMatching(/Out of bounds/) })
    const jobDir = path.join(game, ".river", "jobs", job.id)
    expect(readFileSync(path.join(jobDir, "render_a.png"), "utf8")).toBe(`png of ${A}`)
    expect(existsSync(path.join(jobDir, "render_b.png"))).toBe(false)
    expect(readFileSync(path.join(jobDir, "render_c.png"), "utf8")).toBe(`png of ${C}`)
    expect((await loadMark(game, "main", mark.id))!.status).toBe("answered")
  })

  it("accepts only the chosen options: their scripts and renders land, the others' cards and edges go", async () => {
    const job = await start({ runTurn: turnWriting(THREE) })
    await approveJobScripts(game, job.id, await allShas(job), { render: fakeRender(), env: GODOT })
    await expect(acceptJob(game, job.id, { variants: [] })).rejects.toThrow(/at least one/)
    await expect(acceptJob(game, job.id, { variants: ["a", "e"] })).rejects.toThrow(/no rendered option e/)
    const before = await answerOf(job)
    const optionB = before.find((c) => c.variant === "b")!

    const accepted = await acceptJob(game, job.id, { variants: ["A", "c"] })
    expect(accepted.status).toBe("accepted")
    expect(accepted.scripts!.map((s) => [s.variant, s.accepted ?? false])).toEqual([["a", true], ["b", false], ["c", true]])
    const folder = path.join(game, "concepts", job.id)
    expect(readFileSync(path.join(folder, "draw_a.gd"), "utf8")).toBe(A)
    expect(readFileSync(path.join(folder, "concept_a.png"), "utf8")).toBe(`png of ${A}`)
    expect(readFileSync(path.join(folder, "draw_c.gd"), "utf8")).toBe(C)
    expect(readFileSync(path.join(folder, "concept_c.png"), "utf8")).toBe(`png of ${C}`)
    expect(existsSync(path.join(folder, "draw_b.gd"))).toBe(false)
    expect(existsSync(path.join(folder, "concept_b.png"))).toBe(false)
    expect(existsSync(path.join(folder, "caption_a.txt"))).toBe(false)

    const board = await loadBoard(game, "main")
    expect(board.cards.some((c) => c.id === optionB.id)).toBe(false)
    expect(board.edges.some((e) => e.to === optionB.id)).toBe(false)
    const kept = board.cards.filter((c) => before.some((b) => b.id === c.id))
    expect(kept.map((c) => [c.kind, c.label, c.pending]).sort()).toEqual([["concept", "A", undefined], ["concept", "C", undefined], ["note", undefined, undefined]])
    expect(board.edges).toHaveLength(3)
    expect((await loadMark(game, "main", mark.id))!.status).toBe("accepted")
  })

  it.skipIf(!process.env.GODOT_BIN)("renders each option with real Godot: a broken option fails alone, and a chosen one is accepted", async () => {
    const job = await start({ runTurn: turnWriting({ ...THREE, "draw_b.gd": BROKEN }) })
    const answered = await approveJobScripts(game, job.id, await allShas(job))
    expect(answered.status).toBe("answered")
    expect(answered.scripts!.map((s) => s.render?.ok)).toEqual([true, false, true])
    expect(answered.scripts![1]!.render).toMatchObject({ ok: false, error: expect.stringMatching(/script raised an error[\s\S]*Out of bounds/) })
    const png = (file: string) => readFileSync(file)
    for (const v of ["a", "c"]) {
      const bytes = png(path.join(game, ".river", "jobs", job.id, `render_${v}.png`))
      expect(bytes.subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a")
      expect([bytes.readUInt32BE(16), bytes.readUInt32BE(20)]).toEqual([256, 256])
    }
    expect(png(path.join(game, ".river", "jobs", job.id, "render_a.png")).equals(png(path.join(game, ".river", "jobs", job.id, "render_c.png")))).toBe(false)
    await expect(acceptJob(game, job.id, { variants: ["b"] })).rejects.toThrow(/no rendered option b/)
    await acceptJob(game, job.id, { variants: ["c"] })
    expect(png(path.join(game, "concepts", job.id, "concept_c.png")).equals(png(path.join(game, ".river", "jobs", job.id, "render_c.png")))).toBe(true)
    expect(existsSync(path.join(game, "concepts", job.id, "concept_a.png"))).toBe(false)
  })

  it("fails a job that wrote both draw.gd and lettered options", async () => {
    const job = await start({ runTurn: turnWriting({ "draw.gd": A, "draw_a.gd": B }) })
    expect(job.status).toBe("failed")
    expect(job.error).toMatch(/draw\.gd and lettered options/)
  })
})

describe("revisions", { timeout: 120_000 }, () => {
  async function answered(files: Record<string, string> = THREE): Promise<Job> {
    const job = await start({ runTurn: turnWriting(files) })
    return approveJobScripts(game, job.id, await allShas(job), { render: fakeRender(), env: GODOT })
  }

  it("needs a reply, resumes the session with the reply and render results, and puts the new row under the old one", async () => {
    const parent = await answered({ ...THREE, "draw_b.gd": BROKEN })
    await expect(reviseJob(game, parent.id, settings, { runTurn: turnWriting({ "draw.gd": A }) })).rejects.toThrow(/reply on mark/)
    await reply("I like A, try two more takes on A")

    const turns: AgentTurnRequest[] = []
    const child = await reviseJob(game, parent.id, settings, { runTurn: turnWriting({ "draw_a.gd": A, "caption_a.txt": "Dusk, closer", "draw_b.gd": C }, turns, "A: closer. B: wider.") })
    expect(child).toMatchObject({ status: "approval", parentJobId: parent.id, sessionId: "s1" })
    expect(turns).toHaveLength(1)
    expect(turns[0]).toMatchObject({ sessionId: parent.sessionId, conceptId: child.id, mode: "concept" })
    expect(turns[0]!.prompt).toContain("you: I like A, try two more takes on A")
    expect(turns[0]!.prompt).toContain(`concepts/${child.id}/`)
    expect(turns[0]!.prompt).toMatch(/option B \(draw_b\.gd\) "Blue hour \(cold\)": failed to render\. Godot said:\n[\s\S]*Out of bounds/)
    expect(turns[0]!.prompt).not.toContain(BROKEN)

    const parentCards = (await answerOf(parent)).map(cardRect)
    const childCards = (await answerOf(child)).map(cardRect)
    const parentBottom = Math.max(...parentCards.map((r) => r.y + r.h))
    for (const r of childCards) expect(r.y).toBeGreaterThan(parentBottom)
    expect(Math.min(...childCards.map((r) => r.x))).toBe(Math.min(...parentCards.map((r) => r.x)))
    const edges = (await loadBoard(game, "main")).edges
    expect(edges.filter((e) => e.from === mark.id)).toHaveLength(2)

    // The old answer stays answerable; the mark follows the newest job that is not dismissed.
    expect((await loadJob(game, parent.id)).status).toBe("answered")
    expect((await loadMark(game, "main", mark.id))!).toMatchObject({ jobId: child.id, status: "working" })
    await acceptJob(game, parent.id, { variants: ["a"] })
    expect((await loadMark(game, "main", mark.id))!).toMatchObject({ jobId: child.id, status: "working" })
    await dismissJob(game, child.id)
    expect((await loadMark(game, "main", mark.id))!).toMatchObject({ jobId: parent.id, status: "accepted" })
  })

  it("starts a fresh session with the previous scripts when the old one cannot be resumed", async () => {
    const parent = await answered()
    const { sessionId: _s, ...rest } = parent
    await saveJobAs({ ...rest, sessionId: "gone" })
    await reply("warmer")
    const turns: AgentTurnRequest[] = []
    const child = await reviseJob(game, parent.id, settings, { runTurn: turnWriting({ "draw.gd": A }, turns) })
    expect(child.status).toBe("approval")
    expect(turns.map((t) => t.sessionId)).toEqual(["gone", undefined])
    expect(turns[1]!.prompt).toContain("give me three moods for the pond")
    expect(turns[1]!.prompt).toContain(`--- draw_a.gd\n${A.trimEnd()}\n---`)
    expect(child.sessionId).toBe("s2")
  })

  it("revises a failed job without a reply, feeding Godot's error back", async () => {
    const parent = await answered({ "draw.gd": BROKEN })
    expect(parent.status).toBe("failed")
    const turns: AgentTurnRequest[] = []
    const child = await reviseJob(game, parent.id, settings, { runTurn: turnWriting({ "draw.gd": A }, turns) })
    expect(child.status).toBe("approval")
    expect(turns[0]!.prompt).toMatch(/the drawing \(draw\.gd\): failed to render\. Godot said:\n[\s\S]*Out of bounds/)
    expect(turns[0]!.prompt).toContain("make the scripts render")
  })

  it("refuses to revise a job that is not the mark's latest", async () => {
    const parent = await answered()
    await reply("again")
    await reviseJob(game, parent.id, settings, { runTurn: turnWriting({ "draw.gd": A }) })
    await reply("and again")
    await expect(reviseJob(game, parent.id, settings, { runTurn: turnWriting({ "draw.gd": A }) })).rejects.toThrow(/not the latest answer/)
  })

  it("revises an accepted job: says what the user kept, and the new row goes under the kept cards", async () => {
    const parent = await answered()
    await acceptJob(game, parent.id, { variants: ["a"] })
    await expect(reviseJob(game, parent.id, settings, { runTurn: turnWriting({ "draw.gd": A }) })).rejects.toThrow(/reply on mark/)
    await reply("I like A, try two more takes on A")
    const turns: AgentTurnRequest[] = []
    const { sessionId: _s, ...noSession } = (await loadJob(game, parent.id))
    await saveJobAs(noSession)
    const child = await reviseJob(game, parent.id, settings, { runTurn: turnWriting({ "draw_a.gd": B, "draw_b.gd": C }, turns) })
    expect(child.status).toBe("approval")
    expect(turns[0]!.prompt).toContain(`The user kept option A; it is in the project at concepts/${parent.conceptId}/.`)
    expect(turns[0]!.prompt).toContain(`--- draw_a.gd\n${A.trimEnd()}\n---`)
    expect(turns[0]!.prompt).toContain(`What the user kept is in this worktree at concepts/${parent.conceptId}/`)
    expect(readFileSync(path.join(turns[0]!.root, "concepts", parent.conceptId, "draw_a.gd"), "utf8")).toBe(A)
    expect(existsSync(path.join(turns[0]!.root, "concepts", parent.conceptId, "draw_b.gd"))).toBe(false)
    const board = await loadBoard(game, "main")
    const kept = board.cards.filter((c) => !c.pending && (c.ref === parent.conceptId || c.text === NOTE)).map(cardRect)
    expect(kept).toHaveLength(2)
    for (const r of (await answerOf(child)).map(cardRect)) expect(r.y).toBeGreaterThan(Math.max(...kept.map((k) => k.y + k.h)))
  })

  it("a new ask on the mark replaces a failed revision, then stops at the answer it was revising", async () => {
    const parent = await answered()
    await reply("warmer")
    const failed = await reviseJob(game, parent.id, settings, { runTurn: turnWriting({}) })
    expect(failed.status).toBe("failed")
    expect((await loadMark(game, "main", mark.id))!.jobId).toBe(failed.id)
    await expect(start({ runTurn: turnWriting({ "draw.gd": A }) })).rejects.toThrow(new RegExp(`already has job ${parent.id} \\(answered\\); reply on the mark and revise it`))
    expect((await loadJob(game, failed.id)).status).toBe("dismissed")
    expect((await loadMark(game, "main", mark.id))!).toMatchObject({ jobId: parent.id, status: "answered" })
  })
})

describe("project brief", { timeout: 120_000 }, () => {
  it("goes into the concept turn's system prompt, and a dismiss reason is added to it once", async () => {
    mkdirSync(path.join(game, ".river"), { recursive: true })
    writeFileSync(path.join(game, ".river", "brief.md"), "# Park walk\n\nWatercolour, warm light.\n")
    const turns: AgentTurnRequest[] = []
    const job = await start({ runTurn: turnWriting(THREE, turns) })
    expect(turns[0]!.brief).toContain("Watercolour, warm light.")
    expect(systemPrompt(turns[0]!)).toContain("The project brief (.river/brief.md), written by the user:\n# Park walk")

    await dismissJob(game, job.id, "no blue hour, it reads as night")
    await dismissJob(game, job.id, "no blue hour, it reads as night")
    const brief = readFileSync(path.join(game, ".river", "brief.md"), "utf8")
    expect(brief).toBe(`# Park walk\n\nWatercolour, warm light.\n\n## Things the user turned down\n\n- no blue hour, it reads as night (asked: "give me three moods for the pond") (${job.id})\n`)
    expect(await answerOf(job)).toEqual([])
    expect((await loadBoard(game, "main")).edges).toEqual([])
  })
})

async function saveJobAs(job: Job): Promise<void> {
  const { saveJob } = await import("@river/core")
  await saveJob(game, job)
}
