import { execFileSync } from "node:child_process"
import { cpSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { Writable } from "node:stream"
import { fileURLToPath } from "node:url"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { startConceptJob, type RunTurn } from "@river/agent"
import { cardRect, claimMark, loadBoard, loadJob, markRect, overlaps, replyToMark, saveCard, saveJob } from "@river/core"
import { run } from "../src/index"

const example = fileURLToPath(new URL("../../../examples/park-walk/", import.meta.url))
const DRAW = "extends RefCounted\n\nfunc draw(img: Image) -> void:\n\timg.fill(Color(0.4, 0.5, 0.6))\n"

async function cli(argv: string[]) {
  let out = ""
  let err = ""
  const stdout = new Writable({ write(c, _e, cb) { out += String(c); cb() } })
  const stderr = new Writable({ write(c, _e, cb) { err += String(c); cb() } })
  const code = await run(argv, { stdout, stderr })
  return { code, out, err }
}

const writeDraw: RunTurn = async (req, h) => {
  const file = path.join(req.root, "concepts", req.conceptId!, "draw.gd")
  mkdirSync(path.dirname(file), { recursive: true })
  writeFileSync(file, DRAW)
  h.onEvent({ type: "text", text: "A calm blue field." })
}

let root: string
beforeEach(() => {
  root = realpathSync.native(mkdtempSync(path.join(tmpdir(), "river-cli-jobs-")))
  cpSync(example, root, { recursive: true })
  const git = (...args: string[]) => execFileSync("git", ["-c", "core.autocrlf=false", "-c", "user.name=t", "-c", "user.email=t@example.invalid", ...args], { cwd: root })
  git("init", "-q", "-b", "main")
  git("add", "-A")
  git("commit", "-q", "-m", "init")
})
afterEach(() => rmSync(root, { recursive: true, force: true, maxRetries: 3 }))

describe("river mark and job", { timeout: 120_000 }, () => {
  it("mark add circles a card, or a free spot under the board, and prints the mark id", async () => {
    const card = await saveCard(root, "main", { kind: "note", x: 100, y: 100, w: 200, ref: "", text: "n", madeBy: "you" })
    const anchored = await cli(["mark", "add", "--root", root, "--text", "make this calmer", "--anchor", card.id])
    expect(anchored.code).toBe(0)
    const loose = await cli(["mark", "add", "--root", root, "--text", "more light"])
    const marks = (await loadBoard(root, "main")).marks
    const m = marks.find((x) => x.id === anchored.out.trim())!
    expect(m).toMatchObject({ shape: "circle", anchors: [card.id], status: "open", thread: [{ by: "you", text: "make this calmer" }] })
    const xs = m.path.filter((_, i) => i % 2 === 0)
    expect(Math.min(...xs)).toBeLessThan(100)
    expect(Math.max(...xs)).toBeGreaterThan(300)
    const free = marks.find((x) => x.id === loose.out.trim())!
    expect(free.anchors).toEqual([])
    expect(overlaps(markRect(free), cardRect(card))).toBe(false)
    expect(Math.min(...free.path.filter((_, i) => i % 2 === 1))).toBeGreaterThan(card.y + 100)
    expect((await cli(["mark", "add", "--root", root])).code).toBe(2)
    expect((await cli(["mark", "add", "--root", root, "--text", "x", "--anchor", "c_missing0"])).code).toBe(1)
  })

  it("card add puts passages, notes and images at free spots; board show hints on an empty board", async () => {
    const empty = await cli(["board", "show", "--root", root])
    expect(empty.code).toBe(1)
    expect(empty.err).toContain("river card add --passage stories/<file>.twee#<passage id>")
    const passage = await cli(["card", "add", "--root", root, "--passage", "stories/park_walk.twee#fetch"])
    expect(passage.code).toBe(0)
    expect((await cli(["card", "add", "--root", root, "--note", "remember the stick", "--anchor", passage.out.trim()])).code).toBe(0)
    mkdirSync(path.join(root, "art"))
    writeFileSync(path.join(root, "art", "pond.png"), "png")
    expect((await cli(["card", "add", "--root", root, "--image", "art/pond.png"])).err).toContain("needs --licence")
    expect((await cli(["card", "add", "--root", root, "--image", "art/pond.png", "--licence", "own work", "--caption", "the pond"])).code).toBe(0)
    const wrong = await cli(["card", "add", "--root", root, "--passage", "stories/park_walk.twee#Fetch"])
    expect([wrong.code, wrong.err]).toEqual([1, 'river card add: stories/park_walk.twee has no passage with id "Fetch" (river paths and story_read list them)\n'])
    expect((await cli(["card", "add", "--root", root, "--note", "a", "--passage", "x#y"])).code).toBe(2)
    const board = await loadBoard(root, "main")
    expect(board.cards.map((c) => [c.kind, c.ref, c.madeBy])).toEqual([
      ["passage", "stories/park_walk.twee#fetch", "you"],
      ["note", "", "you"],
      ["ref", "art/pond.png", "you"],
    ])
    expect(board.cards[1]).toMatchObject({ x: board.cards[0]!.x + board.cards[0]!.w + 40, y: board.cards[0]!.y })
    for (const [i, a] of board.cards.entries()) for (const b of board.cards.slice(i + 1)) expect(overlaps(cardRect(a), cardRect(b))).toBe(false)
    expect((await cli(["board", "show", "--root", root])).out).toContain("file: art/pond.png (own work)")
  })

  it("mark dismiss and accept close a mark; an agent's status change waits for its claim", async () => {
    const markId = (await cli(["mark", "add", "--root", root, "--text", "tighten Fetch"])).out.trim()
    await claimMark(root, "main", markId, "claude-code")
    await replyToMark(root, "main", markId, "claude-code", "Tightened.", "answered")
    const accepted = await cli(["mark", "accept", "--root", root, "--mark", markId])
    expect([accepted.code, accepted.out]).toEqual([0, `${markId}  accepted  2 messages\n`])
    const other = (await cli(["mark", "add", "--root", root, "--text", "add a song"])).out.trim()
    const dismissed = await cli(["mark", "dismiss", "--root", root, "--mark", other, "--text", "No music in this game."])
    expect(dismissed.out).toBe(`${other}  dismissed  2 messages\n`)
    expect((await loadBoard(root, "main")).marks.find((m) => m.id === other)!.thread.at(-1)).toMatchObject({ by: "you", text: "No music in this game." })
    expect((await cli(["mark", "dismiss", "--root", root])).code).toBe(2)
  })

  it("job approve prints the script and its sha256 and runs nothing without --yes; show and dismiss", async () => {
    const markId = (await cli(["mark", "add", "--root", root, "--text", "make this calmer"])).out.trim()
    expect((await cli(["job", "start", "--root", root])).code).toBe(2)
    const job = await startConceptJob({ workspaceRoot: root, board: "main", markId, model: "claude-sonnet-5-5", backend: "claude-code" }, { runTurn: writeDraw })

    const shown = await cli(["job", "show", "--root", root, "--job", job.id])
    expect(shown.out).toContain(`job ${job.id}  approval`)
    expect(shown.out).toContain("summary: A calm blue field.")

    const preview = await cli(["job", "approve", "--root", root, "--job", job.id])
    expect(preview.code).toBe(0)
    expect(preview.out).toContain(`concepts/${job.id}/draw.gd  sha256 ${job.scripts![0]!.sha256}`)
    expect(preview.out).toContain(DRAW)
    expect(preview.out).toContain(`river job approve --root ${root} --job ${job.id} --sha256 ${job.scripts![0]!.sha256} --yes`)
    expect((await loadJob(root, job.id)).status).toBe("approval")

    const unseen = await cli(["job", "approve", "--root", root, "--job", job.id, "--yes"])
    expect(unseen.code).toBe(2)
    expect(unseen.err).toContain("--sha256")
    const wrong = await cli(["job", "approve", "--root", root, "--job", job.id, "--yes", "--sha256", "0".repeat(64)])
    expect(wrong.code).toBe(1)
    expect(wrong.err).toContain("refused")
    expect((await loadJob(root, job.id)).status).toBe("approval")

    const dismissed = await cli(["job", "dismiss", "--root", root, "--job", job.id])
    expect(dismissed.out).toContain(`job ${job.id}  dismissed`)
    const again = await cli(["job", "dismiss", "--root", root, "--job", job.id])
    expect(again.code).toBe(0)
    expect(again.out).toContain(`job ${job.id}  dismissed`)
  })

  it("prints agent text without escape sequences or control characters, keeping its words, tabs and line breaks", async () => {
    const markId = (await cli(["mark", "add", "--root", root, "--text", "make this calmer"])).out.trim()
    const job = await startConceptJob({ workspaceRoot: root, board: "main", markId, model: "claude-sonnet-5-5", backend: "claude-code" }, { runTurn: writeDraw })
    await saveJob(root, {
      ...job,
      summary: "Calm\u001b[2J\u001b[1;1H field.\nSecond\tline.\u0007",
      error: "\u001b]0;owned\u0007Godot \u009b31mfailed\r‮hidden",
      scripts: [{ ...job.scripts![0]!, caption: "Low \u001b[8msun" }],
    })
    await saveCard(root, "main", { kind: "note", x: 900, y: 900, w: 200, ref: "", text: "note \u009b31mred‮", madeBy: "claude-code" })
    const control = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f‪-‮⁦-⁩]/
    const shown = await cli(["job", "show", "--root", root, "--job", job.id])
    expect(shown.out).not.toMatch(control)
    expect(shown.out).toContain("summary: Calm field.\n           Second\tline.")
    expect(shown.out).toContain("error: Godot 31mfailedhidden")
    const board = await cli(["board", "show", "--root", root])
    expect(board.out).not.toMatch(control)
    expect(board.out).toContain('"note 31mred"')
  })

  it.skipIf(!process.env.GODOT_BIN)("job approve --yes renders with Godot and job accept applies the concept", async () => {
    const markId = (await cli(["mark", "add", "--root", root, "--text", "make this calmer"])).out.trim()
    const job = await startConceptJob({ workspaceRoot: root, board: "main", markId, model: "claude-sonnet-5-5", backend: "claude-code" }, { runTurn: writeDraw })
    const approved = await cli(["job", "approve", "--root", root, "--job", job.id, "--sha256", job.scripts![0]!.sha256, "--yes"])
    expect(approved.code).toBe(0)
    expect(approved.out).toContain(`job ${job.id}  answered`)
    expect(approved.out).toContain(`render: ${path.join(root, ".river", "jobs", job.id, "render.png")}`)
    const accepted = await cli(["job", "accept", "--root", root, "--job", job.id])
    expect(accepted.code).toBe(0)
    expect(readFileSync(path.join(root, "concepts", job.id, "draw.gd"), "utf8")).toBe(DRAW)
    expect(readFileSync(path.join(root, "concepts", job.id, "concept.png")).subarray(1, 4).toString()).toBe("PNG")
  })

  const DRAW_B = DRAW.replace("0.4, 0.5, 0.6", "0.8, 0.6, 0.3")
  const writeOptions: RunTurn = async (req, h) => {
    const dir = path.join(req.root, "concepts", req.conceptId!)
    mkdirSync(dir, { recursive: true })
    writeFileSync(path.join(dir, "draw_a.gd"), DRAW)
    writeFileSync(path.join(dir, "caption_a.txt"), "Cool blue")
    writeFileSync(path.join(dir, "draw_b.gd"), DRAW_B)
    h.onEvent({ type: "text", text: "A: cool. B: warm." })
  }

  it("job approve lists every option and needs every sha; mark reply, board show and dismiss --reason", async () => {
    const markId = (await cli(["mark", "add", "--root", root, "--text", "two moods"])).out.trim()
    const job = await startConceptJob({ workspaceRoot: root, board: "main", markId, model: "claude-sonnet-5-5", backend: "claude-code" }, { runTurn: writeOptions })
    const [a, b] = job.scripts!

    const preview = await cli(["job", "approve", "--root", root, "--job", job.id])
    expect(preview.out).toContain(`concepts/${job.id}/draw_a.gd  sha256 ${a!.sha256}  option A "Cool blue"`)
    expect(preview.out).toContain(`concepts/${job.id}/draw_b.gd  sha256 ${b!.sha256}  option B`)
    expect(preview.out).toContain(DRAW_B)
    expect(preview.out).toContain(`--job ${job.id} --sha256 a=${a!.sha256} --sha256 b=${b!.sha256} --yes`)

    const onlyA = await cli(["job", "approve", "--root", root, "--job", job.id, "--sha256", `a=${a!.sha256}`, "--yes"])
    expect(onlyA.code).toBe(1)
    expect(onlyA.err).toMatch(/refused: .*draw_b\.gd/)
    const bare = await cli(["job", "approve", "--root", root, "--job", job.id, "--sha256", a!.sha256, "--yes"])
    expect(bare.code).toBe(2)
    expect(bare.err).toContain("has 2 scripts")
    expect((await cli(["job", "approve", "--root", root, "--job", job.id, "--sha256", `e=${a!.sha256}`, "--yes"])).err).toContain("no option e")
    expect((await loadJob(root, job.id)).status).toBe("approval")

    const board = await cli(["board", "show", "--root", root])
    expect(board.code).toBe(0)
    expect(board.out).toMatch(/\[A\] "Cool blue"  concepts\/j_\w+\/ option a  file: \.river\/jobs\/j_\w+\/render_a\.png \(pending, job j_\w+\)  by concept-artist/)
    expect(board.out).toContain("    concept-artist: A: cool. B: warm.")
    expect((await cli(["board", "show", "--root", root, "--board", "nope"])).code).toBe(1)

    const replied = await cli(["mark", "reply", "--root", root, "--mark", markId, "--text", "warmer"])
    expect(replied.code).toBe(0)
    expect((await loadBoard(root, "main")).marks[0]!.thread.at(-1)).toMatchObject({ by: "you", text: "warmer" })
    const early = await cli(["job", "revise", "--root", root, "--job", job.id])
    expect(early.code).toBe(1)
    expect(early.err).toContain("only an answered, accepted or failed job can be revised")

    const dismissed = await cli(["job", "dismiss", "--root", root, "--job", job.id, "--reason", "too dark"])
    expect(dismissed.code).toBe(0)
    expect(readFileSync(path.join(root, ".river", "brief.md"), "utf8")).toContain(`- too dark (asked: "two moods") (${job.id})`)
  })

  it.skipIf(!process.env.GODOT_BIN)("job approve --yes with every sha renders the options, and job accept --variants keeps the chosen one", async () => {
    const markId = (await cli(["mark", "add", "--root", root, "--text", "two moods"])).out.trim()
    const job = await startConceptJob({ workspaceRoot: root, board: "main", markId, model: "claude-sonnet-5-5", backend: "claude-code" }, { runTurn: writeOptions })
    const [a, b] = job.scripts!
    const approved = await cli(["job", "approve", "--root", root, "--job", job.id, "--sha256", `a=${a!.sha256}`, "--sha256", `B=${b!.sha256}`, "--yes"])
    expect(approved.code).toBe(0)
    expect(approved.out).toContain(`render: ${path.join(root, ".river", "jobs", job.id, "render_a.png")}`)
    expect(approved.out).toContain(`render: ${path.join(root, ".river", "jobs", job.id, "render_b.png")}`)
    expect((await cli(["job", "accept", "--root", root, "--job", job.id, "--variants", "b"])).code).toBe(0)
    expect(readFileSync(path.join(root, "concepts", job.id, "draw_b.gd"), "utf8")).toBe(DRAW_B)
    expect(readFileSync(path.join(root, "concepts", job.id, "concept_b.png")).subarray(1, 4).toString()).toBe("PNG")
    expect(() => readFileSync(path.join(root, "concepts", job.id, "draw_a.gd"))).toThrow()
  })
})
