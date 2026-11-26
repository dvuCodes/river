import { cpSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { PassThrough, Writable } from "node:stream"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"
import { run } from "../src/index"

const example = fileURLToPath(new URL("../../../examples/park-walk/", import.meta.url))

function sink() {
  let text = ""
  const stream = new Writable({ write(chunk, _enc, cb) { text += String(chunk); cb() } })
  return { stream, text: () => text }
}

async function cli(argv: string[]) {
  const out = sink()
  const err = sink()
  const stdin = new PassThrough()
  stdin.end("")
  const code = await run(argv, { stdout: out.stream, stderr: err.stream, stdin })
  return { code, out: out.text(), err: err.text() }
}

function tempProject(edit?: (manifest: Record<string, unknown>) => void) {
  const dir = mkdtempSync(join(tmpdir(), "river-3f-"))
  cpSync(example, dir, { recursive: true })
  if (edit) {
    const manifest = JSON.parse(readFileSync(join(dir, "river.json"), "utf8"))
    edit(manifest)
    writeFileSync(join(dir, "river.json"), JSON.stringify(manifest, null, 2))
  }
  return dir
}

describe("river simulate", () => {
  it("prints a simulation report for the example story", async () => {
    const r = await cli(["simulate", example, "--runs", "50"])
    expect(r.code).toBe(0)
    expect(r.out).toContain("50 simulated games (seed 1)")
    expect(r.out).toContain("endings:")
    expect(r.out).toContain("dead ends:")
    expect(r.out).toContain("steps: min")
  })

  it("defaults to 200 runs and seed 1, and --story picks one story", async () => {
    const r = await cli(["simulate", example, "--story", "park_walk"])
    expect(r.code).toBe(0)
    expect(r.out).toContain("200 simulated games (seed 1)")
    expect((await cli(["simulate", example, "--story", "nope"])).code).toBe(1)
  })

  it("is deterministic for a seed and takes --root instead of a folder", async () => {
    const a = await cli(["simulate", example, "--runs", "80", "--seed", "7"])
    const b = await cli(["simulate", "--root", example, "--runs", "80", "--seed=7"])
    expect(a.code).toBe(0)
    expect(b.out).toBe(a.out)
    expect(a.out).toContain("80 simulated games (seed 7)")
    const other = await cli(["simulate", example, "--runs", "80", "--seed", "8"])
    expect(other.out).toContain("(seed 8)")
  })

  it("--max-steps caps the games", async () => {
    const r = await cli(["simulate", example, "--runs", "20", "--max-steps", "1"])
    expect(r.code).toBe(0)
    expect(r.out).toMatch(/max steps hit: \d+/)
    expect(r.out).toMatch(/steps: min 1, avg 1, max 1/)
  })

  it("exits 2 on bad flags and extra arguments", async () => {
    for (const bad of [
      ["--runs", "0"],
      ["--runs", "-3"],
      ["--runs", "2.5"],
      ["--runs", "many"],
      ["--runs", ""],
      ["--seed", "1.5"],
      ["--seed", "abc"],
      ["--max-steps", "0"],
      ["--max-steps", "x"],
    ]) {
      const r = await cli(["simulate", example, ...bad])
      expect([bad.join(" "), r.code]).toEqual([bad.join(" "), 2])
      // "--runs -3" never reaches the command: parseArgs itself refuses a value that starts with a dash.
      expect(r.err).toMatch(/^river( simulate)?: /)
      expect(r.out).toBe("")
    }
    expect((await cli(["simulate", example, "extra"])).code).toBe(2)
  })

  it("accepts a negative or zero seed", async () => {
    expect((await cli(["simulate", example, "--runs", "5", "--seed=-4"])).out).toContain("(seed -4)")
    expect((await cli(["simulate", example, "--runs", "5", "--seed", "0"])).out).toContain("(seed 0)")
  })
})

describe("river capture with a command engine", () => {
  // No $ and no double quotes inside the JS: river expands $VAR in the command, and cmd.exe and sh both take "...".
  const SINGLE =
    "node -e \"const f=require('fs'),p=require('path');f.appendFileSync(p.join(process.env.RIVER_PROJECT_ROOT,'single-runs.log'),'run\\n');f.writeFileSync(p.join(process.env.RIVER_OUT_DIR,'frame_00.png'),'x')\""
  const BATCH =
    "node -e \"const f=require('fs'),p=require('path');f.appendFileSync(p.join(process.env.RIVER_PROJECT_ROOT,'batch-runs.log'),'run\\n');for(const s of JSON.parse(f.readFileSync(process.env.RIVER_BATCH_MANIFEST,'utf8')))for(let i=0;i<s.count;i++)f.writeFileSync(p.join(s.outDir,'frame_0'+i+'.png'),'x')\""
  const shots = [
    { id: "shot_a", scene: "res://a.tscn", count: 2 },
    { id: "shot_b", scene: "res://b.tscn", count: 1 },
  ]
  const lines = (dir: string, file: string) => (existsSync(join(dir, file)) ? readFileSync(join(dir, file), "utf8").trim().split("\n").length : 0)

  it("capture --all runs batchCommand once for every shot", async () => {
    const dir = tempProject((m) => {
      m.engine = "custom"
      m.shots = shots
      m.adapter = { custom: { command: SINGLE, batchCommand: BATCH } }
    })
    const r = await cli(["capture", dir, "--all"])
    expect([r.code, r.err]).toEqual([0, ""])
    expect(r.out).toMatch(/captured shot_a at rev \S+ \(2 frames\)/)
    expect(r.out).toMatch(/captured shot_b at rev \S+ \(1 frame\)/)
    expect(lines(dir, "batch-runs.log")).toBe(1)
    expect(lines(dir, "single-runs.log")).toBe(0)
    const listed = await cli(["shots", dir])
    expect(listed.out).toMatch(/shot_a .*last capture .*\(rev \S+, 2 frames\)/)
    expect(listed.out).toMatch(/shot_b .*last capture .*\(rev \S+, 1 frame\)/)
  })

  it("frames capture --all and explicit ids batch the same way", async () => {
    const dir = tempProject((m) => {
      m.engine = "custom"
      m.shots = shots
      m.adapter = { custom: { command: SINGLE, batchCommand: BATCH } }
    })
    expect((await cli(["frames", "capture", dir, "--all"])).code).toBe(0)
    expect((await cli(["capture", dir, "shot_a", "shot_b"])).code).toBe(0)
    expect(lines(dir, "batch-runs.log")).toBe(2)
    expect(lines(dir, "single-runs.log")).toBe(0)
  })

  it("without batchCommand every shot runs the command", async () => {
    const dir = tempProject((m) => {
      m.engine = "custom"
      m.shots = shots
      m.adapter = { custom: { command: SINGLE } }
    })
    const r = await cli(["capture", dir, "--all"])
    expect([r.code, r.err]).toEqual([0, ""])
    expect(lines(dir, "single-runs.log")).toBe(2)
    expect(r.out).toContain("captured shot_a")
    expect(r.out).toContain("captured shot_b")
  })

  it("a single shot and an unknown shot still behave", async () => {
    const dir = tempProject((m) => {
      m.engine = "custom"
      m.shots = shots
      m.adapter = { custom: { command: SINGLE, batchCommand: BATCH } }
    })
    expect((await cli(["capture", dir, "shot_b"])).code).toBe(0)
    expect(lines(dir, "single-runs.log")).toBe(1)
    const unknown = await cli(["capture", dir, "shot_a", "nope"])
    expect([unknown.code, unknown.err]).toEqual([1, 'river capture: no shot "nope" in the manifest (shots: shot_a, shot_b); nothing was captured\n'])
    expect(lines(dir, "batch-runs.log")).toBe(0)
  })

  it("a failing batch command exits 1 with its error, and an engine with no adapter is explained", async () => {
    const dir = tempProject((m) => {
      m.engine = "custom"
      m.shots = shots
      m.adapter = { custom: { command: SINGLE, batchCommand: 'node -e "process.exit(3)"' } }
    })
    const r = await cli(["capture", dir, "--all"])
    expect(r.code).toBe(1)
    expect(r.err).toContain("exit code 3")
    const none = await cli(["capture", example, "gate_open"])
    expect(none.code).toBe(1)
    expect(none.err).toContain('engine "none"')
  })
})

describe("--model and --self-check-model", () => {
  const dir = tempProject()

  it("write-job accepts any valid model id and rejects an invalid one with exit 2", async () => {
    // A valid model gets past the settings check and only then fails on the missing mark (exit 1).
    for (const model of ["claude-haiku-4-5", "claude-opus-5-5", "my-custom:model.v2"]) {
      const r = await cli(["write-job", "start", `--root=${dir}`, "--mark=m_none", `--model=${model}`])
      expect([model, r.code]).toEqual([model, 1])
      expect(r.err).toContain("no mark m_none")
    }
    for (const model of ["bad model", "-rf", "x;rm", "", "a".repeat(101)]) {
      const r = await cli(["write-job", "start", `--root=${dir}`, "--mark=m_none", `--model=${model}`])
      expect([model, r.code]).toEqual([model, 2])
      expect(r.err).toContain("--model is a model id")
    }
    const revise = await cli(["write-job", "revise", `--root=${dir}`, "--job=j_none", "--model", "bad model"])
    expect(revise.code).toBe(2)
  })

  it("job start and job revise take the same flexible models", async () => {
    const ok = await cli(["job", "start", `--root=${dir}`, "--mark=m_none", "--model=claude-haiku-4-5"])
    expect(ok.code).toBe(1)
    expect(ok.err).toContain("no mark m_none")
    const bad = await cli(["job", "start", `--root=${dir}`, "--mark=m_none", "--model=bad model"])
    expect(bad.code).toBe(2)
    expect(bad.err).toContain("--model is a model id")
    expect((await cli(["job", "revise", `--root=${dir}`, "--job=j_none", "--model=bad model"])).code).toBe(2)
  })

  it("--self-check-model is validated the same way", async () => {
    const ok = await cli(["write-job", "start", `--root=${dir}`, "--mark=m_none", "--self-check-model=claude-haiku-4-5"])
    expect(ok.code).toBe(1)
    expect(ok.err).toContain("no mark m_none")
    const bad = await cli(["write-job", "start", `--root=${dir}`, "--mark=m_none", "--self-check-model=bad model"])
    expect(bad.code).toBe(2)
    expect(bad.err).toContain("--self-check-model is a model id")
    expect((await cli(["job", "start", `--root=${dir}`, "--mark=m_none", "--self-check-model=bad model"])).code).toBe(2)
    expect((await cli(["write-job", "revise", `--root=${dir}`, "--job=j_none", "--self-check-model=bad model"])).code).toBe(2)
    const sha = "a".repeat(64)
    const approve = await cli(["job", "approve", `--root=${dir}`, "--job=j_none", `--sha256=${sha}`, "--yes", "--self-check-model=bad model"])
    expect(approve.code).toBe(2)
    expect(approve.err).toContain("--self-check-model is a model id")
  })

  it("lists simulate and --self-check-model in the help", async () => {
    const r = await cli(["help"])
    expect(r.out).toContain("simulate [dir]")
    expect(r.out).toContain("--self-check-model")
  })
})
