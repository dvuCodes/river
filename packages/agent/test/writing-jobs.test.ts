import { execFileSync } from "node:child_process"
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { ensureBoard, listCheckpoints, loadBoard, loadJob, loadMark, replyToMark, saveCard, saveJob, saveMark, type Job, type Mark } from "@river/core"
import { dismissJob, recoverJobs } from "../src/jobs"
import type { RunTurn } from "../src/jobs"
import type { AgentTurnRequest } from "../src/types"
import {
  acceptWritingJob,
  applyTakeEdits,
  dismissWritingJob,
  readWritingTakes,
  reviseWritingJob,
  startWritingJob,
  takePath,
  TABLE_READ_ASK,
  type WritingJobDeps,
  type WritingTakeData,
} from "../src/writing-jobs"
import { EXAMPLE, removeDir } from "./helpers"

const STORY = "stories/park_walk.twee"
const NOTE = "A: the leash wins. Risk: quiet. B: Mara talks him down; the bond pays off. Risk: soft. C: a dead end on purpose. Risk: broken. I would pick B."
const POND_CHOICES = "[[Hold the leash tight->Calm down]] @set excitement -= 30, bond -= 5\n[[Throw a treat->Treat]] @cost treats 1 @when treats >= 1\n[[Let go->Splash]] @when excitement > 150"

const TAKES: WritingTakeData[] = [
  {
    variant: "a",
    storyFile: STORY,
    caption: "The leash goes tight",
    summary: "Rex sees the ducks; the leash does the talking.",
    edits: [{ op: "write", passageId: "pond", rawText: `@id pond\n@set excitement += 20\n--\nRex [excited]: Ducks!\n...\nThe leash goes tight in your fist.\n\n${POND_CHOICES}` }],
  },
  {
    variant: "b",
    storyFile: STORY,
    caption: "Mara talks him down",
    summary: "Mara speaks first; bond decides how Rex takes it. The long path gets a better name.",
    edits: [
      { op: "write", passageId: "pond", rawText: `@id pond\n@set excitement += 20\n--\nMara: "Easy, boy."\n{when bond > 40: Rex looks back at her, tail low. | Rex does not look back.}\n\n${POND_CHOICES}` },
      { op: "rename", passageId: "long_path", newName: "Shady path" },
    ],
  },
  {
    variant: "c",
    storyFile: STORY,
    caption: "Straight into the pond",
    summary: "A shortcut to a scene that does not exist yet.",
    edits: [{ op: "write", passageId: "pond", rawText: "@id pond\n--\nRex goes in. All of him.\n\n[[Fish him out->Nowhere yet]]" }],
  },
]

let top: string
let game: string
let mark: Mark
const git = (...args: string[]) =>
  execFileSync("git", ["-c", "core.autocrlf=false", ...args], {
    cwd: top,
    encoding: "utf8",
    env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.invalid", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.invalid" },
  })

/** A git repo with the example project in a subfolder, a voice bible, a brief, a passage card and a mark on it. */
beforeEach(async () => {
  top = realpathSync.native(mkdtempSync(path.join(tmpdir(), "river-writing-")))
  game = path.join(top, "game")
  cpSync(EXAMPLE, game, { recursive: true })
  mkdirSync(path.join(game, ".river"), { recursive: true })
  writeFileSync(path.join(game, ".river", "voice.md"), "# Voice\n\nShort lines. Rex never speaks in words; Mara is dry.\n")
  writeFileSync(path.join(game, ".river", "brief.md"), "# Park walk\n\nA small dog story.\n")
  git("init", "-q", "-b", "main")
  git("add", "-A")
  git("commit", "-q", "-m", "init")
  await ensureBoard(game, "main")
  const passage = await saveCard(game, "main", { kind: "passage", x: 100, y: 50, w: 240, ref: `${STORY}#pond`, madeBy: "you" })
  mark = await saveMark(game, "main", {
    shape: "circle",
    path: [80, 30, 360, 30, 360, 260, 80, 260],
    anchors: [passage.id],
    thread: [{ by: "you", at: new Date().toISOString(), text: "make the pond funnier" }],
    madeBy: "you",
  })
})
afterEach(() => removeDir(top))

/**
 * A writer turn that writes `takes` as river-mcp's writing_write would, then says `note`. A table-read turn (its
 * prompt starts with TABLE_READ_ASK) answers `tableRead` instead, when given.
 */
function fakeTurn(takes: WritingTakeData[], seen: AgentTurnRequest[] = [], opts: { note?: string; tableRead?: string; session?: string } = {}): RunTurn {
  return async (req, h) => {
    seen.push(req)
    h.onEvent({ type: "session", sessionId: opts.session ?? `s-${seen.length}` })
    if (req.prompt.includes(TABLE_READ_ASK)) {
      h.onEvent({ type: "text-delta", text: "{" })
      h.onEvent({ type: "text", text: opts.tableRead ?? "I could not read them." })
    } else {
      for (const take of takes) {
        const file = path.join(req.root, ...takePath(req.writingId!, take.variant).split("/"))
        mkdirSync(path.dirname(file), { recursive: true })
        writeFileSync(file, JSON.stringify(take, null, 2))
      }
      h.onEvent({ type: "text", text: "Reading the voice bible first." })
      h.onEvent({ type: "text", text: opts.note ?? NOTE })
    }
    h.onEvent({ type: "done" })
  }
}

const SETTINGS = { model: "claude-sonnet-5-5", backend: "claude-code" } as const
const start = (deps: WritingJobDeps) => startWritingJob({ workspaceRoot: game, board: "main", markId: mark.id, ...SETTINGS }, deps)
const jobCards = async (job: Job) => (await loadBoard(game, "main")).cards.filter((c) => c.pending?.jobId === job.id)
const branchExists = (job: Job) => git("branch", "--list", `river/job/${job.id}`).trim() !== ""
const storyText = () => readFileSync(path.join(game, STORY), "utf8")
const voiceText = () => readFileSync(path.join(game, ".river", "voice.md"), "utf8")

describe("writing jobs", { timeout: 120_000 }, () => {
  it("answers a mark with A/B/C takes: linted, committed on the job branch and laid out on the board", async () => {
    const turns: AgentTurnRequest[] = []
    const events: string[] = []
    const job = await start({ runTurn: fakeTurn(TAKES, turns), onEvent: (e) => events.push(e.type) })

    expect(job).toMatchObject({ kind: "writing", role: "story-writer", status: "answered", conceptId: job.id, storyFile: STORY, passageIds: ["pond"], summary: NOTE, sessionId: "s-1", projectSub: "game" })
    expect(job.takes).toEqual([
      { variant: "a", file: STORY, caption: "The leash goes tight", summary: TAKES[0]!.summary, lintErrors: 0, lintWarnings: 0 },
      { variant: "b", file: STORY, caption: "Mara talks him down", summary: TAKES[1]!.summary, lintErrors: 0, lintWarnings: 0 },
      expect.objectContaining({ variant: "c", caption: "Straight into the pond", lintErrors: expect.any(Number) }),
    ])
    expect(job.takes![2]!.lintErrors).toBeGreaterThan(0)
    expect(events).toContain("text")

    // The writer turn: writer mode in the worktree, with the voice bible and brief, and the passage in full with its neighbours.
    const [turn] = turns
    expect(turn).toMatchObject({ mode: "writer", writingId: job.id, root: path.join(job.worktree, "game"), storyFile: STORY, backend: "claude-code" })
    expect(turn!.voice).toContain("Rex never speaks in words")
    expect(turn!.brief).toContain("A small dog story.")
    expect(turn!.prompt).toContain(`- you: "make the pond funnier"`)
    expect(turn!.prompt).toContain(`passage "Pond" (id pond, ${STORY}). Its full text as written:`)
    expect(turn!.prompt).toContain("@set excitement += 20")
    expect(turn!.prompt).toContain("[[Let go->Splash]] @when excitement > 150")
    expect(turn!.prompt).toMatch(/Entered from:\n  - "Gate" \(id gate\) by \[Go to the pond\]: "The park gate creaks open\./)
    expect(turn!.prompt).toMatch(/Leads to:\n  - \[Hold the leash tight\] -> "Calm down" \(id calm_down\): "The dog sits\./)
    expect(turn!.prompt).toContain(`Write your takes against ${STORY}, centred on pond.`)

    // Nothing touched the user's story; the takes are committed on the job branch.
    expect(storyText()).toContain("Ducks. Many ducks.")
    expect(branchExists(job)).toBe(true)
    const committed = JSON.parse(git("show", `${job.headSha}:game/${takePath(job.id, "b")}`)) as WritingTakeData
    expect(committed).toEqual(TAKES[1])

    // The board: the note, then A, B, C in a row beside the mark; edges mark -> note -> each take.
    const cards = await jobCards(job)
    const note = cards.find((c) => !c.variant)!
    expect(note).toMatchObject({ kind: "note", x: 400, y: 30, text: NOTE, madeBy: "story-writer", pending: { markId: mark.id, jobId: job.id } })
    const takes = cards.filter((c) => c.variant).sort((a, b) => a.x - b.x)
    expect(takes.map((c) => [c.kind, c.label, c.variant, c.caption])).toEqual([
      ["note", "A", "a", "The leash goes tight"],
      ["note", "B", "b", "Mara talks him down"],
      ["note", "C", "c", "Straight into the pond"],
    ])
    expect(takes.every((c) => c.y === note.y && c.x > note.x)).toBe(true)
    expect(takes[0]!.text).toContain("Rex [excited]: Ducks!")
    expect(takes[0]!.text).toContain("Lint: no new problems")
    expect(takes[1]!.text).toContain("Rex looks back at her, tail low.")
    expect(takes[2]!.text).toMatch(/Lint: new \d+ error/)
    const edges = (await loadBoard(game, "main")).edges.map((e) => [e.from, e.to])
    expect(edges).toEqual(expect.arrayContaining([[mark.id, note.id], ...takes.map((c) => [note.id, c.id])]))
    expect(edges).toHaveLength(4)

    const m = (await loadMark(game, "main", mark.id))!
    expect(m).toMatchObject({ status: "answered", jobId: job.id })
    expect(m.thread.at(-1)).toMatchObject({ by: "story-writer", text: NOTE })

    // The takes as they apply to the user's story now: diff, preview and the lint problems each adds.
    const views = await readWritingTakes(game, job.id)
    expect(views.map((v) => v.variant)).toEqual(["a", "b", "c"])
    expect(views[0]!.diff).toContain("-Ducks. Many ducks.")
    expect(views[0]!.diff).toContain("+Rex [excited]: Ducks!")
    expect(views[0]!.diff.match(/^--- /gm)).toHaveLength(1)
    expect(views[1]!.diff).toContain("+:: Shady path")
    expect(views[1]!.diff).toContain("+[[Take the long path->Shady path]] @set energy -= 10")
    expect(views[1]!.preview).toContain("Mara: \"Easy, boy.\"")
    expect(views[1]!.tableRead).toContain("Rex looks back at her, tail low.")
    expect(views[2]!.diagnostics.some((d) => d.code === "broken-link")).toBe(true)
    expect(views[0]!.diagnostics).toEqual([])
  })

  it("reports the craft problems a take adds, from lintNarrative too", async () => {
    const flat: WritingTakeData = {
      variant: "a",
      storyFile: STORY,
      caption: "Two ways home",
      summary: "Both choices go home.",
      edits: [{ op: "write", passageId: "long_path", rawText: "@id long_path\n--\nTrees.\n\n[[Go home->Home happy]]\n[[Walk home->Home happy]]" }],
    }
    const job = await start({ runTurn: fakeTurn([flat]) })
    const [view] = await readWritingTakes(game, job.id)
    expect(view!.diagnostics.map((d) => d.code)).toContain("false-choice")
    // Craft notes are listed, but only errors and warnings count on the badge.
    expect(job.takes![0]).toMatchObject({ lintErrors: 0 })
  })

  it("applies take edits in memory and names the edit that does not apply", async () => {
    const { loadProject, loadStory } = await import("@river/core")
    const { story } = await loadStory(await loadProject(game), STORY)
    const after = applyTakeEdits(story, TAKES[1]!.edits)
    expect(after.passages.find((p) => p.id === "long_path")?.name).toBe("Shady path")
    expect(story.passages.find((p) => p.id === "long_path")?.name).toBe("Long path")
    expect(() => applyTakeEdits(story, [{ op: "delete", passageId: "nope" }])).toThrow(/edit 1 \(delete nope\): no passage with id "nope"/)
    expect(() => applyTakeEdits(story, [{ op: "add", name: "Gate", rawText: "x" }])).toThrow(/already exists/)
  })

  it("runs the table read on each take's transcript and lets it rewrite the note and captions", async () => {
    const turns: AgentTurnRequest[] = []
    const reread = JSON.stringify({ note: "A: tense, reads well. B: Mara's line lands. C: breaks the walk. Pick B.", captions: { a: "Leash first", c: "Broken on purpose" } })
    const job = await start({ runTurn: fakeTurn(TAKES, turns, { tableRead: `Here it is: ${reread}`, session: "s-w" }), selfCheck: SETTINGS, env: {} })

    expect(turns).toHaveLength(2)
    const read = turns[1]!
    expect(read).toMatchObject({ mode: "writer", writingId: job.id, sessionId: "s-w" })
    expect(read.prompt).toContain(TABLE_READ_ASK)
    // Resumed, but the system prompt is rendered fresh, so the voice bible and brief come along.
    expect(read.voice).toContain("Rex never speaks in words")
    expect(read.brief).toContain("A small dog story.")
    // The player-facing prose, rendered for the initial state, with the choices marked.
    expect(read.prompt).toContain("Rex looks back at her, tail low.")
    expect(read.prompt).toContain("> Go to the pond")
    expect(read.prompt).toContain(`Your note was: ${JSON.stringify(NOTE)}`)

    expect(job.summary).toBe("A: tense, reads well. B: Mara's line lands. C: breaks the walk. Pick B.")
    expect(job.takes!.map((t) => t.caption)).toEqual(["Leash first", "Mara talks him down", "Broken on purpose"])
    const cards = await jobCards(job)
    expect(cards.find((c) => !c.variant)!.text).toBe(job.summary)
    expect(cards.find((c) => c.variant === "a")!.caption).toBe("Leash first")
    expect((await loadMark(game, "main", mark.id))!.thread.at(-1)).toMatchObject({ by: "story-writer", text: job.summary })
  })

  it("runs the table read on selfCheckModel when given, and on the job's model otherwise", async () => {
    const reread = JSON.stringify({ note: "Pick B.", captions: {} })
    const same: AgentTurnRequest[] = []
    const first = await start({ runTurn: fakeTurn(TAKES, same, { tableRead: reread }), selfCheck: SETTINGS, env: {} })
    expect(same.map((t) => t.model)).toEqual(["claude-sonnet-5-5", "claude-sonnet-5-5"])
    // Without explicit selfCheck settings, the default look uses the job's backend and the override model.
    const cheap: AgentTurnRequest[] = []
    await dismissWritingJob(game, first.id)
    await start({ runTurn: fakeTurn(TAKES, cheap, { tableRead: reread }), selfCheckModel: "claude-haiku-4-5", env: {} })
    expect(cheap.map((t) => t.model)).toEqual(["claude-sonnet-5-5", "claude-haiku-4-5"])
    expect(cheap[1]!.backend).toBe("claude-code")
  })

  it("refuses an invalid selfCheckModel before starting anything", async () => {
    const turns: AgentTurnRequest[] = []
    await expect(start({ runTurn: fakeTurn(TAKES, turns), selfCheckModel: "--bad flag", env: {} })).rejects.toThrow(/invalid selfCheckModel/)
    expect(turns).toEqual([])
  })

  it("keeps the note as written when the table read says nothing usable, or is switched off", async () => {
    const turns: AgentTurnRequest[] = []
    const job = await start({ runTurn: fakeTurn(TAKES, turns, { tableRead: "not json" }), selfCheck: SETTINGS, env: {} })
    expect(turns).toHaveLength(2)
    expect(job.summary).toBe(NOTE)
    expect(job.takes![0]!.caption).toBe("The leash goes tight")
    await dismissJob(game, job.id)

    const off: AgentTurnRequest[] = []
    await start({ runTurn: fakeTurn(TAKES, off), env: { RIVER_SELF_CHECK: "off" } })
    expect(off).toHaveLength(1)
  })

  it("accepts take B: applies its edits to the story, keeps a line in the voice bible, settles the cards", async () => {
    const job = await start({ runTurn: fakeTurn(TAKES) })
    const before = (await listCheckpoints(game)).length
    const accepted = await acceptWritingJob(game, job.id, { variant: "B" })

    expect(accepted.status).toBe("accepted")
    expect(accepted.takes!.map((t) => !!t.accepted)).toEqual([false, true, false])
    const story = storyText()
    expect(story).toContain('Mara: "Easy, boy."')
    expect(story).toContain("{when bond > 40: Rex looks back at her, tail low. | Rex does not look back.}")
    expect(story).toContain(":: Shady path")
    expect(story).toContain("[[Take the long path->Shady path]]")
    expect(story).not.toContain("Ducks. Many ducks.")
    expect((await listCheckpoints(game)).length).toBe(before + 1)

    expect(voiceText()).toBe(`# Voice\n\nShort lines. Rex never speaks in words; Mara is dry.\n\n## Lines that landed\n\n- Mara: "Easy, boy." (${job.id}/b)\n`)

    const board = await loadBoard(game, "main")
    const own = board.cards.filter((c) => c.madeBy === "story-writer")
    expect(own.map((c) => c.label ?? "note").sort()).toEqual(["B", "note"])
    expect(own.every((c) => c.pending === undefined)).toBe(true)
    expect(board.edges).toHaveLength(2)
    expect(branchExists(job)).toBe(false)
    expect((await loadMark(game, "main", mark.id))!.status).toBe("accepted")
  })

  it("accepts without an exemplar when asked, and refuses a take that no longer applies or does not exist", async () => {
    const job = await start({ runTurn: fakeTurn(TAKES) })
    await expect(acceptWritingJob(game, job.id, { variant: "d" })).rejects.toThrow(/has no take D; it offers A, B, C/)

    // The user deletes the pond passage meanwhile: take A edits it, so it cannot apply.
    const original = storyText()
    const without = original.replace(/:: Pond \[encounter\][\s\S]*?(?=\n:: Long path)/, "")
    expect(without).not.toContain(":: Pond")
    writeFileSync(path.join(game, STORY), without)
    await expect(acceptWritingJob(game, job.id, { variant: "a" })).rejects.toThrow(/take A of job .* no longer applies to stories\/park_walk\.twee: edit 1 \(write pond\): no passage with id "pond"/)
    expect(storyText()).toBe(without)
    expect((await loadJob(game, job.id)).status).toBe("answered")
    expect((await readWritingTakes(game, job.id))[0]!.error).toMatch(/no passage with id "pond"/)

    writeFileSync(path.join(game, STORY), original)
    await acceptWritingJob(game, job.id, { variant: "a", saveExemplar: false })
    expect(storyText()).toContain("Rex [excited]: Ducks!")
    expect(voiceText()).not.toContain("Lines that landed")
  })

  it("revises with the user's reply, resuming the writer's session, in a new row under the first", async () => {
    const first = await start({ runTurn: fakeTurn(TAKES, [], { session: "s-first" }) })
    await expect(reviseWritingJob(game, first.id, SETTINGS, { runTurn: fakeTurn(TAKES) })).rejects.toThrow(/reply on mark .* first/)
    await replyToMark(game, "main", mark.id, "you", "B, but Rex should steal the treat")

    const turns: AgentTurnRequest[] = []
    const second = await reviseWritingJob(game, first.id, SETTINGS, { runTurn: fakeTurn(TAKES.slice(0, 2), turns) })
    expect(second).toMatchObject({ kind: "writing", status: "answered", parentJobId: first.id, storyFile: STORY, passageIds: ["pond"] })
    expect(turns[0]).toMatchObject({ mode: "writer", writingId: second.id, sessionId: "s-first" })
    expect(turns[0]!.prompt).toContain(`This revises your previous answer (job ${first.id}).`)
    expect(turns[0]!.prompt).toContain('- take B "Mara talks him down"')
    expect(turns[0]!.prompt).toContain('- you: "B, but Rex should steal the treat"')
    expect(turns[0]!.prompt).not.toContain("edits: ")

    const firstNote = (await jobCards(first)).find((c) => !c.variant)!
    const secondNote = (await jobCards(second)).find((c) => !c.variant)!
    expect(secondNote.y).toBeGreaterThan(firstNote.y)
    expect((await loadMark(game, "main", mark.id))!.jobId).toBe(second.id)
    // The first answer stays on the board until the user accepts or dismisses it.
    expect((await jobCards(first)).length).toBe(4)
  })

  it("dismisses with a reason: everything goes, and the reason is kept in the voice bible", async () => {
    const job = await start({ runTurn: fakeTurn(TAKES) })
    const dismissed = await dismissWritingJob(game, job.id, "too cute, Rex is not a cartoon")
    expect(dismissed.status).toBe("dismissed")
    expect(await jobCards(job)).toEqual([])
    expect((await loadBoard(game, "main")).edges).toEqual([])
    expect(branchExists(job)).toBe(false)
    expect(existsSync(path.join(top, ".git", "river", "worktrees", job.id))).toBe(false)
    expect(voiceText()).toContain(`## Lines we cut\n\n- too cute, Rex is not a cartoon (asked: "make the pond funnier") (${job.id})\n`)
    expect(readFileSync(path.join(game, ".river", "brief.md"), "utf8")).not.toContain("turned down")
    expect((await loadMark(game, "main", mark.id))!.status).toBe("dismissed")
  })

  it("fails without takes, keeps the problems, and a new request replaces the failed job", async () => {
    const bad = { ...TAKES[0]!, edits: [{ op: "write", passageId: "nope", rawText: "x" }] } as WritingTakeData
    const failed = await start({ runTurn: fakeTurn([bad]) })
    expect(failed.status).toBe("failed")
    expect(failed.error).toMatch(/take A: edit 1 \(write nope\): no passage with id "nope"/)
    expect((await loadMark(game, "main", mark.id))!.status).toBe("open")

    const job = await start({ runTurn: fakeTurn([TAKES[0]!, { ...TAKES[1]!, storyFile: "../outside.twee" }]) })
    expect(job.status).toBe("answered")
    expect(job.takes!.map((t) => t.variant)).toEqual(["a"])
    expect(job.summary).toContain("River left out: take B:")
    expect((await loadJob(game, failed.id)).status).toBe("dismissed")
  })

  it("recoverJobs fails a writing job its process left running, and dismissJob tidies it", async () => {
    const job = await start({ runTurn: fakeTurn(TAKES) })
    const orphan: Job = { ...job, id: "j_orphan01", conceptId: "j_orphan01", status: "running", takes: undefined, headSha: undefined }
    await saveJob(game, orphan)
    const recovered = await recoverJobs(game)
    expect(recovered.map((j) => j.id)).toEqual(["j_orphan01"])
    expect((await loadJob(game, "j_orphan01")).status).toBe("failed")
    expect((await dismissJob(game, "j_orphan01", "never mind")).status).toBe("dismissed")
    expect(voiceText()).toContain("- never mind")
  })
})
