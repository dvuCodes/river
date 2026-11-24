import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { PassThrough, Writable } from "node:stream"
import { describe, expect, it } from "vitest"
import { run } from "../src/index"

function sink() {
  let text = ""
  const stream = new Writable({ write(chunk, _enc, cb) { text += String(chunk); cb() } })
  return { stream, text: () => text }
}

async function cli(argv: string[], cwd?: string) {
  const out = sink()
  const err = sink()
  const stdin = new PassThrough()
  stdin.end("")
  const code = await run(argv, { stdout: out.stream, stderr: err.stream, stdin, ...(cwd ? { cwd } : {}) })
  return { code, out: out.text(), err: err.text() }
}

function makeProject(stories: Record<string, string>) {
  const dir = mkdtempSync(join(tmpdir(), "river-4a-"))
  mkdirSync(join(dir, "stories"), { recursive: true })
  mkdirSync(join(dir, "data"), { recursive: true })
  writeFileSync(
    join(dir, "river.json"),
    JSON.stringify(
      {
        name: "Phase4Test",
        engine: "none",
        stories: "stories",
        state: "state.schema.json",
        export: "data",
      },
      null,
      2,
    ),
  )
  writeFileSync(
    join(dir, "state.schema.json"),
    JSON.stringify({ bond: { type: "int", min: 0, max: 100, initial: 50 } }, null, 2),
  )
  for (const [name, content] of Object.entries(stories)) {
    writeFileSync(join(dir, "stories", name), content, "utf8")
  }
  return dir
}

const CH1 = `:: StoryTitle
Chapter One

:: StoryData
{"ifid": "9B1D7C2E-3F4A-4B5C-8D6E-7F8091A2B3C4", "start": "Intro"}

:: Intro
Mina: "Ready to cross the bridge?"
The fog lifts over the gate.
[[Cross into Chapter 2->ch2::End]]
`

const CH2 = `:: StoryTitle
Chapter Two

:: StoryData
{"ifid": "7A2E9C1D-4B5C-4D6E-9F80-1A2B3C4D5E6F", "start": "End"}

:: End
@end
--
You arrive at the far side of the valley.
`

const CH1_BROKEN_CROSS = `:: StoryTitle
Chapter One

:: StoryData
{"ifid": "9B1D7C2E-3F4A-4B5C-8D6E-7F8091A2B3C4", "start": "Intro"}

:: Intro
[[Missing target->ch2::Nowhere]]
`

describe("multi-file workspace lint and export", () => {
  it("lints and exports cross-story links cleanly with 0 errors", async () => {
    const dir = makeProject({ "ch1.twee": CH1, "ch2.twee": CH2 })

    const lintRes = await cli(["lint", dir, "--no-narrative"])
    expect([lintRes.code, lintRes.err]).toEqual([0, ""])
    expect(lintRes.out).toContain("0 errors, 0 warnings in 2 passages")

    // Single-story --story selection still resolves cross-story links via the workspace
    const lintSingle = await cli(["lint", dir, "--story", "ch1", "--no-narrative"])
    expect([lintSingle.code, lintSingle.err]).toEqual([0, ""])
    expect(lintSingle.out).toContain("0 errors, 0 warnings in 1 passage")

    const exportRes = await cli(["export", dir])
    expect([exportRes.code, exportRes.err]).toEqual([0, ""])
    expect(exportRes.out).toContain("wrote data/ch1.json")
    expect(exportRes.out).toContain("wrote data/ch2.json")

    const exportedCh1 = JSON.parse(readFileSync(join(dir, "data", "ch1.json"), "utf8"))
    expect(exportedCh1.passages.intro.choices[0].to).toBe("ch2::end")
  })

  it("reports broken cross-story links and exits 1", async () => {
    const dir = makeProject({ "ch1.twee": CH1_BROKEN_CROSS, "ch2.twee": CH2 })

    const lintRes = await cli(["lint", dir, "--no-narrative"])
    expect(lintRes.code).toBe(1)
    expect(lintRes.out).toContain('no passage "Nowhere" in story "ch2"')
  })
})

describe("river i18n tag and extract", () => {
  it("tags prose lines with #line: IDs and is idempotent on second run", async () => {
    const dir = makeProject({ "ch1.twee": CH1 })

    const first = await cli(["i18n", "tag", dir])
    expect([first.code, first.err]).toEqual([0, ""])
    expect(first.out).toContain("stories/ch1.twee: tagged 2 line(s)")

    const taggedContent = readFileSync(join(dir, "stories", "ch1.twee"), "utf8")
    expect(taggedContent).toMatch(/Mina: "Ready to cross the bridge\?" #line:[0-9a-f]{8}/)
    expect(taggedContent).toMatch(/The fog lifts over the gate\. #line:[0-9a-f]{8}/)

    const second = await cli(["i18n", "tag", dir])
    expect([second.code, second.err]).toEqual([0, ""])
    expect(second.out).toContain("stories/ch1.twee: tagged 0 line(s)")
    expect(readFileSync(join(dir, "stories", "ch1.twee"), "utf8")).toBe(taggedContent)
  })

  it("extracts strings in csv, po, and json formats to stdout and --out", async () => {
    const dir = makeProject({ "ch1.twee": CH1, "ch2.twee": CH2 })
    expect((await cli(["i18n", "tag", dir])).code).toBe(0)

    // Default format (csv) to stdout
    const csvRes = await cli(["i18n", "extract", dir, "--story", "ch1"])
    expect([csvRes.code, csvRes.err]).toEqual([0, ""])
    expect(csvRes.out).toContain("id,file,passage,kind,speaker,text")
    expect(csvRes.out).toContain("Ready to cross the bridge?")
    expect(csvRes.out).toContain("Cross into Chapter 2")

    // PO format to stdout
    const poRes = await cli(["i18n", "extract", dir, "--format", "po"])
    expect([poRes.code, poRes.err]).toEqual([0, ""])
    expect(poRes.out).toContain('msgid ""')
    expect(poRes.out).toContain("#. speaker: Mina")
    expect(poRes.out).toContain('msgid "Ready to cross the bridge?"')
    expect(poRes.out).toContain('msgid "You arrive at the far side of the valley."')

    // JSON format to --out file
    const outFile = join(dir, "loc", "strings.json")
    const jsonRes = await cli(["i18n", "extract", dir, "--format", "json", "--out", outFile])
    expect([jsonRes.code, jsonRes.err]).toEqual([0, ""])
    expect(jsonRes.out).toContain(`wrote ${outFile}`)

    const parsed = JSON.parse(readFileSync(outFile, "utf8")) as Array<{ kind: string; text: string; speaker?: string }>
    expect(parsed.some((e) => e.kind === "line" && e.speaker === "Mina" && e.text === "Ready to cross the bridge?")).toBe(true)
    expect(parsed.some((e) => e.kind === "line" && e.text === "You arrive at the far side of the valley.")).toBe(true)
    expect(parsed.some((e) => e.kind === "choice" && e.text === "Cross into Chapter 2")).toBe(true)
  })

  it("exits 2 on invalid --format or unknown i18n subcommand and lists i18n in help", async () => {
    const dir = makeProject({ "ch1.twee": CH1 })

    const badFmt = await cli(["i18n", "extract", dir, "--format", "yaml"])
    expect(badFmt.code).toBe(2)
    expect(badFmt.err).toContain("--format")

    const badSub = await cli(["i18n", "nope", dir])
    expect(badSub.code).toBe(2)
    expect(badSub.err).toContain('i18n has "tag" and "extract"')

    const missingSub = await cli(["i18n"])
    expect(missingSub.code).toBe(2)

    const help = await cli(["help"])
    expect(help.out).toContain("i18n tag [dir]")
    expect(help.out).toContain("i18n extract [dir]")
  })
})
