import { execFileSync, spawn, type ChildProcess } from "node:child_process"
import { createHash } from "node:crypto"
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { lintConceptScript, type RenderConceptRequest } from "@river/adapter-godot"
import { ensureBoard, listCheckpoints, loadBoard, loadJob, loadMark, saveCard, saveJob, saveMark, type Job, type Mark } from "@river/core"
import { acceptJob, approveJobScript, dismissJob, readJobScript, recoverJobs, startConceptJob, type JobDeps, type RunTurn } from "../src/jobs"
import { SYSTEM_PROMPTS } from "../src/prompts"
import type { AgentTurnRequest } from "../src/types"
import { EXAMPLE, removeDir } from "./helpers"

const DRAW = "extends RefCounted\n\nfunc draw(img: Image) -> void:\n\timg.fill(Color(0.55, 0.62, 0.7))\n\timg.fill_rect(Rect2i(0, 170, 256, 86), Color(0.36, 0.48, 0.38))\n"
const SUMMARY = "A low evening sky over a soft hill. Fewer shapes and cooler colours make the scene feel calmer."
const FAKE_PNG = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex")
const sha = (text: string | Buffer) => createHash("sha256").update(text).digest("hex")

let top: string
let game: string
let mark: Mark
const git = (...args: string[]) =>
  execFileSync("git", ["-c", "core.autocrlf=false", ...args], {
    cwd: top,
    encoding: "utf8",
    env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.invalid", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.invalid" },
  })

/** A git repo with the example project in a subfolder (like examples/park-walk in River), a passage card, a note and a mark on both. */
beforeEach(async () => {
  top = realpathSync.native(mkdtempSync(path.join(tmpdir(), "river-jobs-")))
  game = path.join(top, "game")
  cpSync(EXAMPLE, game, { recursive: true })
  git("init", "-q", "-b", "main")
  git("add", "-A")
  git("commit", "-q", "-m", "init")
  await ensureBoard(game, "main")
  const passage = await saveCard(game, "main", { kind: "passage", x: 100, y: 50, w: 240, ref: "stories/park_walk.twee#pond", madeBy: "you" })
  const note = await saveCard(game, "main", { kind: "note", x: 100, y: 300, w: 200, ref: "", text: "dusk, not night", madeBy: "you" })
  mark = await saveMark(game, "main", {
    shape: "circle",
    path: [80, 30, 360, 30, 360, 420, 80, 420],
    anchors: [passage.id, note.id],
    thread: [{ by: "you", at: new Date().toISOString(), text: "make this calmer" }],
    madeBy: "you",
  })
})
afterEach(() => removeDir(top))

/** A turn that writes `script` as the agent would (through concept_write) and says `summary`. */
function fakeTurn(script: string | undefined, seen: AgentTurnRequest[] = []): RunTurn {
  return async (req, h) => {
    seen.push(req)
    h.onEvent({ type: "text", text: "Reading the passage first." })
    if (script !== undefined) {
      const file = path.join(req.root, "concepts", req.conceptId!, "draw.gd")
      mkdirSync(path.dirname(file), { recursive: true })
      writeFileSync(file, script)
    } else {
      h.onEvent({ type: "error", message: "Turn ended with error_max_turns: out of turns" })
    }
    h.onEvent({ type: "text", text: SUMMARY })
    h.onEvent({ type: "done" })
  }
}

function fakeRender(seen: Buffer[] = []): JobDeps["render"] {
  return async (req: RenderConceptRequest) => {
    seen.push(Buffer.from(req.script))
    mkdirSync(path.dirname(req.outPng), { recursive: true })
    writeFileSync(req.outPng, FAKE_PNG)
  }
}

const start = (deps: JobDeps) => startConceptJob({ workspaceRoot: game, board: "main", markId: mark.id, model: "claude-sonnet-5-5", backend: "claude-code" }, deps)
const pending = async (job: Job) => (await loadBoard(game, "main")).cards.find((c) => c.pending?.jobId === job.id)
const branchExists = (job: Job) => git("branch", "--list", `river/job/${job.id}`).trim() !== ""

/** Rename the repo folder, as a user moving their project does. */
function moveRepo(): void {
  const moved = `${top}-moved`
  renameSync(top, moved)
  top = moved
  game = path.join(moved, "game")
}

/** No worktree folder, git registration or branch is left for the job. */
function expectNoTrace(job: Job): void {
  expect(existsSync(path.join(top, ".git", "river", "worktrees", job.id))).toBe(false)
  expect(git("worktree", "list", "--porcelain")).not.toContain(job.id)
  expect(branchExists(job)).toBe(false)
}

describe("concept jobs", { timeout: 120_000 }, () => {
  it("runs start -> approval -> approve -> answered -> accept, and leaves the user's other edits and index alone", async () => {
    // The user's uncommitted work, which must survive and must not be staged.
    const storyFile = path.join(game, "stories", "park_walk.twee")
    const edited = readFileSync(storyFile, "utf8").replace("Ducks.", "Ducks, edited.")
    writeFileSync(storyFile, edited)
    writeFileSync(path.join(top, "scratch.txt"), "untracked\n")
    const index = git("ls-files", "-s")
    const head = git("rev-parse", "HEAD")

    const turns: AgentTurnRequest[] = []
    const job = await start({ runTurn: fakeTurn(DRAW, turns) })
    expect(job).toMatchObject({ status: "approval", summary: SUMMARY, conceptId: job.id, projectSub: "game", branch: `river/job/${job.id}` })
    expect(job.scripts).toEqual([{ file: `concepts/${job.id}/draw.gd`, sha256: sha(DRAW), approved: false }])
    expect(job.worktree).toBe(path.join(top, ".git", "river", "worktrees", job.id))

    const [turn] = turns
    expect(turn).toMatchObject({ mode: "concept", conceptId: job.id, root: path.join(job.worktree, "game"), backend: "claude-code" })
    expect(turn!.prompt).toContain("you: make this calmer")
    expect(turn!.prompt).toMatch(/passage "Pond" \(stories\/park_walk\.twee#pond\): Ducks, edited\./)
    expect(turn!.prompt).toContain("note: dusk, not night")

    let m = (await loadMark(game, "main", mark.id))!
    expect(m).toMatchObject({ status: "working", jobId: job.id })
    expect(m.thread.at(-1)).toMatchObject({ by: "concept-artist", text: SUMMARY })
    expect(await pending(job)).toMatchObject({ kind: "concept", ref: job.conceptId, x: 400, y: 30, w: 260, madeBy: "concept-artist", pending: { markId: mark.id, jobId: job.id } })

    const script = await readJobScript(game, job.id)
    expect(script).toEqual({ file: `concepts/${job.id}/draw.gd`, text: DRAW, sha256: sha(DRAW) })

    await expect(approveJobScript(game, job.id, sha(DRAW + " "), { render: fakeRender() })).rejects.toThrow(/refused/)
    expect((await loadJob(game, job.id)).status).toBe("approval")

    const rendered: Buffer[] = []
    const answered = await approveJobScript(game, job.id, script.sha256, { render: fakeRender(rendered), env: { GODOT_BIN: "godot-not-run" } })
    expect(answered.status).toBe("answered")
    expect(answered.scripts![0]!.approved).toBe(true)
    expect(rendered.map((b) => b.toString("utf8"))).toEqual([DRAW])
    expect(readFileSync(path.join(game, ".river", "jobs", job.id, "render.png")).equals(FAKE_PNG)).toBe(true)
    expect((await loadMark(game, "main", mark.id))!.status).toBe("answered")

    const accepted = await acceptJob(game, job.id)
    expect(accepted.status).toBe("accepted")
    expect(readFileSync(path.join(game, "concepts", job.id, "draw.gd"), "utf8")).toBe(DRAW)
    expect(readFileSync(path.join(game, "concepts", job.id, "concept.png")).equals(FAKE_PNG)).toBe(true)
    const card = (await loadBoard(game, "main")).cards.find((c) => c.kind === "concept")!
    expect(card.ref).toBe(job.conceptId)
    expect(card.pending).toBeUndefined()
    m = (await loadMark(game, "main", mark.id))!
    expect(m.status).toBe("accepted")
    expect(existsSync(job.worktree)).toBe(false)
    expect(branchExists(job)).toBe(false)

    expect(readFileSync(storyFile, "utf8")).toBe(edited)
    expect(readFileSync(path.join(top, "scratch.txt"), "utf8")).toBe("untracked\n")
    expect(git("ls-files", "-s")).toBe(index)
    expect(git("rev-parse", "HEAD")).toBe(head)
    await expect(acceptJob(game, job.id)).rejects.toThrow(/only an answered job/)
  })

  it("dismisses from approval: card, worktree and branch go, and a dismissed job stays dismissed", async () => {
    const job = await start({ runTurn: fakeTurn(DRAW) })
    await expect(start({ runTurn: fakeTurn(DRAW) })).rejects.toThrow(/already has job/)
    expect(branchExists(job)).toBe(true)
    const dismissed = await dismissJob(game, job.id)
    expect(dismissed.status).toBe("dismissed")
    expect(await pending(job)).toBeUndefined()
    expect((await loadBoard(game, "main")).cards.some((c) => c.kind === "concept")).toBe(false)
    expect(existsSync(job.worktree)).toBe(false)
    expect(branchExists(job)).toBe(false)
    expect((await loadMark(game, "main", mark.id))!.status).toBe("dismissed")
    await expect(dismissJob(game, job.id)).rejects.toThrow(/cannot be dismissed/)
    await expect(approveJobScript(game, job.id, sha(DRAW))).rejects.toThrow(/only a job waiting for approval/)
  })

  it("dismisses a job while its agent turn runs: the turn is stopped and the worktree, branch and card go", async () => {
    let child: ChildProcess | undefined
    let aborted = false
    const busyTurn: RunTurn = (req, h) =>
      new Promise<void>((resolve) => {
        // Like the claude CLI: a process whose working folder is inside the job worktree.
        child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { cwd: req.root, stdio: "ignore" })
        child.once("exit", () => resolve())
        h.signal?.addEventListener("abort", () => {
          aborted = true
          child!.kill()
        })
      })
    const run = start({ runTurn: busyTurn })
    while (!child) await new Promise((r) => setTimeout(r, 50))
    const job = (await loadBoard(game, "main")).cards.find((c) => c.kind === "concept")!.pending!
    expect((await loadJob(game, job.jobId)).status).toBe("running")

    const dismissed = await dismissJob(game, job.jobId)
    expect(aborted).toBe(true)
    expect(dismissed.status).toBe("dismissed")
    expect((await run).status).toBe("dismissed")
    expect((await loadBoard(game, "main")).cards.some((c) => c.kind === "concept")).toBe(false)
    expect(existsSync(dismissed.worktree)).toBe(false)
    expect(branchExists(dismissed)).toBe(false)
    expect((await loadMark(game, "main", mark.id))!.status).toBe("dismissed")
  })

  it("fails a script that does not pass the lint, or a turn that wrote none, and a new ask replaces the failed job", async () => {
    const bad = await start({ runTurn: fakeTurn(DRAW + '\tOS.execute("calc", [])\n') })
    expect(bad.status).toBe("failed")
    expect(bad.error).toContain("does not pass the concept lint")
    expect(bad.error).toContain('remove "OS."')
    expect((await loadMark(game, "main", mark.id))!.status).toBe("open")
    expect(await pending(bad)).toBeDefined()

    const none = await start({ runTurn: fakeTurn(undefined) })
    expect((await loadJob(game, bad.id)).status).toBe("dismissed")
    expect(await pending(bad)).toBeUndefined()
    expect(branchExists(bad)).toBe(false)
    expect(none.status).toBe("failed")
    expect(none.error).toContain("out of turns")
    await dismissJob(game, none.id)
  })

  it("keeps working after the repo folder moves: approve and accept from the new place", async () => {
    const job = await start({ runTurn: fakeTurn(DRAW) })
    moveRepo()
    expect((await approveJobScript(game, job.id, sha(DRAW), { render: fakeRender(), env: { GODOT_BIN: "godot-not-run" } })).status).toBe("answered")
    expect((await acceptJob(game, job.id)).status).toBe("accepted")
    expect(readFileSync(path.join(game, "concepts", job.id, "draw.gd"), "utf8")).toBe(DRAW)
    expect(readFileSync(path.join(game, "concepts", job.id, "concept.png")).equals(FAKE_PNG)).toBe(true)
    expectNoTrace(job)
  })

  it("dismisses after the repo folder moves, and the mark can be asked again", async () => {
    const job = await start({ runTurn: fakeTurn(DRAW) })
    moveRepo()
    expect((await dismissJob(game, job.id)).status).toBe("dismissed")
    expectNoTrace(job)
    expect((await start({ runTurn: fakeTurn(DRAW) })).status).toBe("approval")
  })

  it("leaves the user's own worktrees registered, even one whose folder is missing", async () => {
    const userWorktree = `${top}-feature`
    git("worktree", "add", "-q", "-b", "feature", userWorktree)
    renameSync(userWorktree, `${userWorktree}-unplugged`)
    try {
      const job = await start({ runTurn: fakeTurn(DRAW) })
      await dismissJob(game, job.id)
      expect(git("worktree", "list", "--porcelain")).toContain("branch refs/heads/feature")
    } finally {
      removeDir(`${userWorktree}-unplugged`)
    }
  })

  it("never runs the user's git hooks, and adds no checkpoint", async () => {
    const marker = path.join(top, "hooks-ran.txt")
    for (const hook of ["post-checkout", "reference-transaction"]) {
      writeFileSync(path.join(top, ".git", "hooks", hook), `#!/bin/sh\necho ${hook} >> "${marker.replace(/\\/g, "/")}"\n`, { mode: 0o755 })
    }
    const job = await start({ runTurn: fakeTurn(DRAW) })
    await approveJobScript(game, job.id, sha(DRAW), { render: fakeRender(), env: { GODOT_BIN: "godot-not-run" } })
    await acceptJob(game, job.id)
    expect((await start({ runTurn: fakeTurn(DRAW) })).status).toBe("approval")
    await dismissJob(game, (await loadMark(game, "main", mark.id))!.jobId!)
    expect(existsSync(marker)).toBe(false)
    expect(await listCheckpoints(game)).toEqual([])
    git("branch", "hooks-still-run")
    expect(readFileSync(marker, "utf8")).toContain("reference-transaction")
  })

  it("dismiss removes the worktree and branch of a job whose file never recorded them", async () => {
    const job = await start({ runTurn: fakeTurn(DRAW) })
    await saveJob(game, { ...job, status: "failed", error: "could not record the running state", worktree: "", branch: "" })
    await dismissJob(game, job.id)
    expectNoTrace(job)
  })

  it("says how to configure Godot when there is none, and changes nothing", async () => {
    const job = await start({ runTurn: fakeTurn(DRAW) })
    await expect(approveJobScript(game, job.id, sha(DRAW), { env: {} })).rejects.toThrow(/GODOT_BIN/)
    expect((await loadJob(game, job.id)).status).toBe("approval")
  })

  it("refuses before creating a job when the project is not in a git repository", async () => {
    const loose = realpathSync.native(mkdtempSync(path.join(tmpdir(), "river-nogit-")))
    try {
      cpSync(game, loose, { recursive: true })
      await expect(startConceptJob({ workspaceRoot: loose, board: "main", markId: mark.id, model: "claude-sonnet-5-5", backend: "claude-code" }, { runTurn: fakeTurn(DRAW) })).rejects.toThrow(/not in a git repository/)
      expect(existsSync(path.join(loose, ".river", "jobs"))).toBe(false)
    } finally {
      removeDir(loose)
    }
  })

  it("recovers jobs a stopped process left queued, running or rendering as failed", async () => {
    const job = await start({ runTurn: fakeTurn(DRAW) })
    const at = new Date().toISOString()
    const stuck = await saveJob(game, { ...job, id: "j_stuck000", status: "running", createdAt: at, updatedAt: at })
    await saveMark(game, "main", { ...(await loadMark(game, "main", mark.id))!, jobId: stuck.id, status: "working" })
    const recovered = await recoverJobs(game)
    expect(recovered.map((j) => [j.id, j.status])).toEqual([[stuck.id, "failed"]])
    expect(recovered[0]!.error).toMatch(/interrupted/)
    expect((await loadJob(game, job.id)).status).toBe("approval")
    expect((await loadMark(game, "main", mark.id))!.status).toBe("open")
  })

  it.skipIf(!process.env.GODOT_BIN)("renders the approved script with real Godot and accepts the PNG", async () => {
    const job = await start({ runTurn: fakeTurn(DRAW) })
    const answered = await approveJobScript(game, job.id, (await readJobScript(game, job.id)).sha256)
    expect(answered.error).toBeUndefined()
    expect(answered.status).toBe("answered")
    await acceptJob(game, job.id)
    const png = readFileSync(path.join(game, "concepts", job.id, "concept.png"))
    expect(png.subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a")
    expect([png.readUInt32BE(16), png.readUInt32BE(20)]).toEqual([256, 256])
    expect(png.equals(readFileSync(path.join(game, ".river", "jobs", job.id, "render.png")))).toBe(true)
  })

  it("fails the job with Godot's output when the approved script breaks at runtime", { skip: !process.env.GODOT_BIN }, async () => {
    const job = await start({ runTurn: fakeTurn(DRAW + "\tvar a := [1]\n\tvar b = a[3]\n") })
    const failed = await approveJobScript(game, job.id, (await readJobScript(game, job.id)).sha256)
    expect(failed.status).toBe("failed")
    expect(failed.error).toMatch(/script raised an error[\s\S]*Out of bounds/)
    expect((await loadMark(game, "main", mark.id))!.status).toBe("open")
  })
})

describe("concept prompt", () => {
  it("shows an example draw.gd that passes the concept lint", () => {
    const prompt = SYSTEM_PROMPTS.concept
    const example = prompt.slice(prompt.indexOf("  extends RefCounted"), prompt.indexOf("\n\n- ")).split("\n").map((l) => l.replace(/^ {2}/, "")).join("\n")
    expect(example).toContain("func draw(img: Image) -> void:")
    expect(lintConceptScript(example)).toEqual([])
  })
})
