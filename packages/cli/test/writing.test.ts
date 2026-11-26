import { execFileSync } from "node:child_process"
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { PassThrough, Writable } from "node:stream"
import { fileURLToPath } from "node:url"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { startConceptJob, startWritingJob, takePath, type RunTurn, type WritingTakeData } from "@river/agent"
import { checkpoint, ensureBoard, listCheckpoints, loadJob, readVoice, saveCard, saveJob, saveMark } from "@river/core"
import { run } from "../src/index"

const example = fileURLToPath(new URL("../../../examples/park-walk/", import.meta.url))

function sink() {
  let text = ""
  const stream = new Writable({
    write(chunk, _enc, cb) {
      text += String(chunk)
      cb()
    },
  })
  return { stream, text: () => text }
}

async function cli(argv: string[], input?: string) {
  const out = sink()
  const err = sink()
  const stdin = new PassThrough()
  if (input !== undefined) stdin.end(input)
  const code = await run(argv, { stdout: out.stream, stderr: err.stream, stdin })
  return { code, out: out.text(), err: err.text() }
}

const REACTIVE_STORY = [
  ":: StoryTitle",
  "Reactive",
  "",
  ":: StoryData",
  '{ "ifid": "9B1D7C2E-3F4A-4B5C-8D6E-7F8091A2B3C4", "start": "Yard" }',
  "",
  ":: Yard",
  "@id yard",
  "@shot missing_shot",
  "--",
  "{once: First time in the yard.} {cycle: Morning light. | Noon glare.} Treats left: {treats}. {when bond >= 60: Tail wagging! | Tail still.}",
  "[[Loop back->Yard]] @set bond += 15",
  "[[Finish->Home]]",
  "",
  ":: Home",
  "@id home",
  "@end",
  "--",
  "Home at last.",
  "",
  ":: Rain [interrupt]",
  "@id rain",
  "@when excitement >= 80",
  "--",
  "Drops hit the pavement.",
  "[[Shake off->@return]] @set excitement = 0",
].join("\n")

const POND_CHOICES =
  "[[Hold the leash tight->Calm down]] @set excitement -= 30, bond -= 5\n[[Throw a treat->Treat]] @cost treats 1 @when treats >= 1\n[[Let go->Splash]] @when excitement > 150"

const TAKES: WritingTakeData[] = [
  {
    variant: "a",
    storyFile: "stories/park_walk.twee",
    caption: "Tight leash beat",
    summary: "Shortens the pond arrival to the leash pull.",
    edits: [
      {
        op: "write",
        passageId: "pond",
        rawText: `@id pond\n@set excitement += 20\n--\nRex [excited]: Ducks!\nThe leash snaps tight in your hand.\n\n${POND_CHOICES}`,
      },
    ],
  },
  {
    variant: "b",
    storyFile: "stories/park_walk.twee",
    caption: "Mara calls him back",
    summary: "Adds a dry line from Mara with a bond check.",
    edits: [
      {
        op: "write",
        passageId: "pond",
        rawText: `@id pond\n@set excitement += 20\n--\nMara: "Easy, boy."\n{when bond > 40: Rex looks back. | Rex ignores her.}\n\n${POND_CHOICES}`,
      },
    ],
  },
]

function writeTakesTurn(takes: WritingTakeData[], note = "Two takes on the pond beat."): RunTurn {
  return async (req, h) => {
    for (const take of takes) {
      const file = path.join(req.root, ...takePath(req.writingId!, take.variant).split("/"))
      mkdirSync(path.dirname(file), { recursive: true })
      writeFileSync(file, JSON.stringify(take, null, 2))
    }
    h.onEvent({ type: "text", text: note })
  }
}

let root: string
beforeEach(() => {
  root = realpathSync.native(mkdtempSync(path.join(tmpdir(), "river-cli-3a-")))
  cpSync(example, root, { recursive: true })
  const git = (...args: string[]) =>
    execFileSync("git", ["-c", "core.autocrlf=false", "-c", "user.name=t", "-c", "user.email=t@example.invalid", ...args], { cwd: root })
  git("init", "-q", "-b", "main")
  git("add", "-A")
  git("commit", "-q", "-m", "init")
})
afterEach(() => {
  try {
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  } catch {
    // Windows git handles can linger briefly after parallel runs; temp dir cleanup is best-effort.
  }
})

describe("Stage 3A narrative & platform CLI commands", { timeout: 25_000 }, () => {
  it("lint prints narrative notes under narrative: and --no-narrative suppresses them", async () => {
    writeFileSync(path.join(root, "stories/park_walk.twee"), REACTIVE_STORY)
    const manifest = JSON.parse(readFileSync(path.join(root, "river.json"), "utf8"))
    manifest.copyBudgets = { "*": { bodyChars: 20 } }
    writeFileSync(path.join(root, "river.json"), JSON.stringify(manifest))

    const withNotes = await cli(["lint", root])
    expect(withNotes.code).toBe(0)
    expect(withNotes.out).toContain("0 errors, 0 warnings in 3 passages")
    expect(withNotes.out).toContain("narrative:")
    expect(withNotes.out).toContain("(unknown-shot)")
    expect(withNotes.out).toContain("(copy-budget-exceeded)")

    const withoutNotes = await cli(["lint", root, "--no-narrative"])
    expect(withoutNotes.code).toBe(0)
    expect(withoutNotes.out).toContain("0 errors, 0 warnings in 3 passages")
    expect(withoutNotes.out).not.toContain("narrative:")
    expect(withoutNotes.out).not.toContain("(unknown-shot)")
  })

  it("pacing prints the pacing summary and validates --max", async () => {
    const r = await cli(["pacing", root])
    expect(r.code).toBe(0)
    expect(r.out).toContain("9 passages,")
    expect(r.out).toContain("choices,")
    expect(r.out).toContain("possible route")
    expect(r.out).toContain("longest passages:")

    const bad = await cli(["pacing", root, "--max", "0"])
    expect(bad.code).toBe(2)
    expect(bad.err).toContain("--max")
  })

  it("table-read prints rendered player-facing transcripts with --max and --interrupts", async () => {
    writeFileSync(path.join(root, "stories/park_walk.twee"), REACTIVE_STORY)

    const one = await cli(["table-read", root, "--max", "1"])
    expect(one.code).toBe(0)
    expect(one.out).toContain("1 transcript of stories/park_walk.twee")
    expect(one.out).toContain("First time in the yard.")
    expect(one.out).toContain("Morning light.")
    expect(one.out).toContain("Treats left: 2.")
    expect(one.out).not.toContain("{when")
    expect(one.out).not.toContain("Drops hit the pavement.")

    const withIntr = await cli(["table-read", root, "--max", "1", "--interrupts"])
    expect(withIntr.code).toBe(0)
    expect(withIntr.out).toContain("Drops hit the pavement.")
    expect(withIntr.out).toContain("interrupt, back to the story")

    expect((await cli(["table-read", root, "--max", "0"])).code).toBe(2)
  })

  it("voice shows hint when missing, records landed and cut lines, and prints voice.md", async () => {
    const missing = await cli(["voice", root])
    expect(missing.code).toBe(0)
    expect(missing.out).toContain("no voice bible yet")
    expect(missing.out).toContain("river voice landed")

    expect((await cli(["voice", "landed", root])).code).toBe(2)
    expect((await cli(["voice", "cut", root, "--text", "   "])).code).toBe(2)

    const landed = await cli(["voice", "landed", root, "--key", "k1", "--text", 'Mara: "Easy, boy."'])
    expect(landed.code).toBe(0)
    expect(landed.out).toContain('## Lines that landed')
    expect(landed.out).toContain('(k1)')

    const dup = await cli(["voice", "landed", root, "--key", "k1", "--text", "Duplicate key"])
    expect(dup.code).toBe(0)
    expect(dup.out).toContain("not added")

    const cut = await cli(["voice", "cut", root, "--text", "Over-explained inner monologue."])
    expect(cut.code).toBe(0)
    expect(cut.out).toContain('## Lines we cut')

    const shown = await cli(["voice", "show", root])
    expect(shown.code).toBe(0)
    expect(shown.out).toContain("## Lines that landed")
    expect(shown.out).toContain('- Mara: "Easy, boy." (k1)')
    expect(shown.out).toContain("## Lines we cut")
    expect(shown.out).toContain("Over-explained inner monologue.")
  })

  it("checkpoints prune validates --keep and removes older git checkpoint refs", async () => {
    expect((await cli(["checkpoints", "prune", root])).code).toBe(2)
    expect((await cli(["checkpoints", "list", root])).code).toBe(2)
    for (const bad of ["", "abc", "-1", "1.5"]) {
      const r = await cli(["checkpoints", "prune", root, `--keep=${bad}`])
      expect(r.code, bad).toBe(2)
      expect(r.err).toContain("--keep N")
    }

    await checkpoint(root, "first")
    await checkpoint(root, "second")
    await checkpoint(root, "third")
    expect((await listCheckpoints(root)).length).toBe(3)

    const pruned = await cli(["checkpoints", "prune", root, "--keep", "1"])
    expect(pruned.code).toBe(0)
    expect(pruned.out).toContain("deleted 2 checkpoints, keeping the newest 1")
    const remaining = await listCheckpoints(root)
    expect(remaining.map((c) => c.label)).toEqual(["third"])
  })

  it("godot install-runtime copies addon files into addons/river/", async () => {
    expect((await cli(["godot", "nope", root])).code).toBe(2)

    const r = await cli(["godot", "install-runtime", root])
    expect(r.code).toBe(0)
    expect(r.out).toContain("addons/river/plugin.cfg")
    expect(r.out).toContain("addons/river/river_plugin.gd")
    expect(r.out).toContain("addons/river/river_runner.gd")
    expect(r.out).toContain("addons/river/river_story.gd")
    for (const f of ["plugin.cfg", "river_plugin.gd", "river_runner.gd", "river_story.gd"]) {
      expect(existsSync(path.join(root, "addons", "river", f))).toBe(true)
    }
  })

  it("play renders inline {once}, {cycle}, {var}, and {when} templates live across visits", async () => {
    writeFileSync(path.join(root, "stories/park_walk.twee"), REACTIVE_STORY)
    // Visit 1: bond=50, treats=2 -> "First time", "Morning light.", "Treats left: 2.", "Tail still."
    // Choose 1 (Loop back -> bond += 15 -> 65, visit 2): no "First time", "Noon glare.", "Tail wagging!"
    const r = await cli(["play", root], "1\n2\n")
    expect(r.code).toBe(0)
    expect(r.out).toContain("First time in the yard. Morning light. Treats left: 2. Tail still.")
    expect(r.out).toContain("Noon glare. Treats left: 2. Tail wagging!")
    expect(r.out).not.toContain("{when")
    expect(r.out).not.toContain("{once")
    expect(r.out).not.toContain("{cycle")
  })
})

describe("river write-job CLI", { timeout: 120_000 }, () => {
  async function createMarkOnPond(): Promise<string> {
    await ensureBoard(root, "main")
    const card = await saveCard(root, "main", { kind: "passage", x: 50, y: 50, w: 240, ref: "stories/park_walk.twee#pond", madeBy: "you" })
    const mark = await saveMark(root, "main", {
      shape: "circle",
      path: [40, 40, 300, 40, 300, 200, 40, 200],
      anchors: [card.id],
      thread: [{ by: "you", at: new Date().toISOString(), text: "sharpen the pond scene" }],
      madeBy: "you",
    })
    return mark.id
  }

  it("validates subcommands and flags and accepts launchWritingJob's exact --name=value flags", async () => {
    expect((await cli(["write-job"])).code).toBe(2)
    expect((await cli(["write-job", "bogus", root])).code).toBe(2)
    expect((await cli(["write-job", "start", "--root", root])).code).toBe(2)
    expect((await cli(["write-job", "show", "--root", root])).code).toBe(2)
    expect((await cli(["write-job", "accept", "--root", root, "--job", "j_1"])).code).toBe(2)
    expect((await cli(["write-job", "accept", "--root", root, "--job", "j_1", "--variant", "z"])).code).toBe(2)
    expect((await cli(["write-job", "dismiss", "--root", root])).code).toBe(2)

    // Matches packages/mcp/src/jobs.ts launchWritingJob argument list verbatim (including values starting with '-').
    const launch = await cli([
      "write-job",
      "start",
      `--root=${root}`,
      "--board=-x",
      "--mark=-m",
      "--job=j_launch02",
      "--by=claude-code",
      "--backend=claude-code",
      "--model=claude-sonnet-5-5",
    ])
    expect(launch.code).toBe(1)
    expect(launch.err).toContain("river: no mark -m on board -x")
  })

  it("write-job show, job show on a writing job, mark reply hint, and write-job accept apply the take and record exemplar", async () => {
    const markId = await createMarkOnPond()
    const job = await startWritingJob(
      { workspaceRoot: root, board: "main", markId, model: "claude-sonnet-5-5", backend: "claude-code" },
      { runTurn: writeTakesTurn(TAKES), selfCheck: false },
    )
    expect(job.status).toBe("answered")

    const shown = await cli(["write-job", "show", "--root", root, "--job", job.id])
    expect(shown.code).toBe(0)
    expect(shown.out).toContain(`job ${job.id}  answered  (writing)`)
    expect(shown.out).toContain("stories/park_walk.twee")
    expect(shown.out).toContain('take A "Tight leash beat"')
    expect(shown.out).toContain('take B "Mara calls him back"')
    expect(shown.out).toContain("--- take A")
    expect(shown.out).toContain("diff:")
    expect(shown.out).toContain("The leash snaps tight in your hand.")
    expect(shown.out).toContain(`next: river write-job accept --root ${root} --job ${job.id} --variant a`)

    // `river job show` also formats writing jobs cleanly
    const viaJobShow = await cli(["job", "show", "--root", root, "--job", job.id])
    expect(viaJobShow.code).toBe(0)
    expect(viaJobShow.out).toContain(`job ${job.id}  answered  (writing)`)
    expect(viaJobShow.out).toContain('take A "Tight leash beat"')

    // `river mark reply` points to `write-job revise` for a writing job
    const replied = await cli(["mark", "reply", "--root", root, "--mark", markId, "--text", "keep it punchy"])
    expect(replied.code).toBe(0)
    expect(replied.out).toContain(`next: river write-job revise --root ${root} --job ${job.id}`)

    // Accept variant B with exemplar saved
    const accepted = await cli(["write-job", "accept", "--root", root, "--job", job.id, "--variant", "b"])
    expect(accepted.code).toBe(0)
    expect(accepted.out).toContain(`job ${job.id}  accepted  (writing)`)
    expect(accepted.out).toContain("accepted")
    expect(readFileSync(path.join(root, "stories/park_walk.twee"), "utf8")).toContain('Mara: "Easy, boy."')
    const voice = await readVoice(root)
    expect(voice).toContain("## Lines that landed")
    expect(voice).toContain(`(${job.id}/b)`)
  })

  it("write-job accept --no-exemplar skips voice.md, and write-job dismiss --reason logs under Lines we cut", async () => {
    const mark1 = await createMarkOnPond()
    const job1 = await startWritingJob(
      { workspaceRoot: root, board: "main", markId: mark1, model: "claude-sonnet-5-5", backend: "claude-code" },
      { runTurn: writeTakesTurn(TAKES), selfCheck: false },
    )
    const accepted = await cli(["write-job", "accept", "--root", root, "--job", job1.id, "--variant", "a", "--no-exemplar"])
    expect(accepted.code).toBe(0)
    expect(await readVoice(root)).toBeUndefined()

    const mark2 = await createMarkOnPond()
    const job2 = await startWritingJob(
      { workspaceRoot: root, board: "main", markId: mark2, model: "claude-sonnet-5-5", backend: "claude-code" },
      { runTurn: writeTakesTurn(TAKES), selfCheck: false },
    )
    const dismissed = await cli(["write-job", "dismiss", "--root", root, "--job", job2.id, "--reason", "too melodramatic"])
    expect(dismissed.code).toBe(0)
    expect(dismissed.out).toContain(`job ${job2.id}  dismissed  (writing)`)
    expect((await loadJob(root, job2.id)).status).toBe("dismissed")
    const voice = await readVoice(root)
    expect(voice).toContain("## Lines we cut")
    expect(voice).toContain("too melodramatic")
  })

  it("write-job show sanitizes terminal control sequences and refuses concept jobs", async () => {
    const markId = await createMarkOnPond()
    const wJob = await startWritingJob(
      { workspaceRoot: root, board: "main", markId, model: "claude-sonnet-5-5", backend: "claude-code" },
      { runTurn: writeTakesTurn(TAKES), selfCheck: false },
    )
    await saveJob(root, {
      ...wJob,
      summary: "Note\u001b[2J clean",
      takes: wJob.takes!.map((t) => ({ ...t, caption: "Cap\u001b]0;pwn\u0007tion", summary: "Sum\u009b31mmary" })),
    })
    const shown = await cli(["write-job", "show", "--root", root, "--job", wJob.id])
    expect(shown.code).toBe(0)
    expect(shown.out).not.toMatch(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/)
    expect(shown.out).toContain("Note clean")
    expect(shown.out).toContain('take A "Caption"')

    // Concept job rejected by `write-job show`
    const mark2 = await createMarkOnPond()
    const cJob = await startConceptJob(
      { workspaceRoot: root, board: "main", markId: mark2, model: "claude-sonnet-5-5", backend: "claude-code" },
      {
        runTurn: async (req) => {
          const f = path.join(req.root, "concepts", req.conceptId!, "draw.gd")
          mkdirSync(path.dirname(f), { recursive: true })
          writeFileSync(f, "extends RefCounted\nfunc draw(img: Image) -> void:\n\tpass\n")
        },
      },
    )
    const wrongKind = await cli(["write-job", "show", "--root", root, "--job", cJob.id])
    expect(wrongKind.code).toBe(1)
    expect(wrongKind.err).toContain("is not a writing job")
  })
})
