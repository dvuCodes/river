import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { beforeEach, describe, expect, it } from "vitest"
import { ensureBoard, loadProject, saveJob, saveMark, type Job, type Project } from "@river/core"
import { createRiverTools, selectTools, type JobLaunch, type RiverTool, type WritingTakeFile } from "../src/index"
import { tempProject } from "./helpers"

const PARK = "stories/park_walk.twee"
const KENNEL = "stories/kennel.twee"

/** A story with reactive prose, dialogue, a false choice, a repeated hint, an unknown shot, a passage no new game reaches, and an interrupt. */
const KENNEL_TWEE = `:: StoryTitle
Kennel

:: StoryData
{
  "ifid": "7B1F0C52-3D64-4E1A-9B7E-5A2C8D9E0F21",
  "start": "Door"
}

:: Door [start]
@id door
--
{when bond > 40: Rex leans on you. | Rex keeps his distance.}
You have {treats} treats left.

Rex [excited]: Ducks! So many ducks!
Mara: "Easy, boy."

[[Go in->Yard]] @hint "Mind the step"
[[Wait->Yard]] @set bond += 1 @hint "Mind the step"
[[Sneak down->Cellar]]

:: Yard
@id yard
@shot nowhere
@set bond += 10
--
The yard is quiet.

[[Leave->Out]]
[[Slip out->Out]]

:: Cellar
@id cellar
@when treats >= 9
--
Dark and damp.

[[Back up->Yard]]

:: Out [ending]
@id out
@end
--
Done.

:: Thunder [interrupt]
@id thunder
@when noise >= 80
--
{when noise >= 90: The sky splits. | A low rumble.}

[[Hold him->@return]] @set bond += 5
`

const YARD_LOUD = "@id yard\n@set bond += 10\n--\nThe yard is loud now.\n\n[[Leave->Out]]"

let dir: string
let project: Project
let tools: RiverTool[]
const call = (name: string, input: unknown = {}, list: RiverTool[] = tools) => {
  const t = list.find((x) => x.name === name)
  if (!t) throw new Error(`no tool ${name}`)
  return t.handler(input)
}
const disk = (rel: string) => readFileSync(join(dir, rel), "utf8")

beforeEach(async () => {
  dir = tempProject()
  writeFileSync(join(dir, KENNEL), KENNEL_TWEE)
  const manifest = JSON.parse(readFileSync(join(dir, "river.json"), "utf8"))
  writeFileSync(join(dir, "river.json"), JSON.stringify({ ...manifest, copyBudgets: { "*": { bodyLines: 3 } } }))
  project = await loadProject(dir)
  tools = createRiverTools(project, { author: "claude-code" })
})

describe("voice_read and voice_note", () => {
  it("voice_read says when there is no bible, then returns the file with its landed and cut lines", async () => {
    const none = await call("voice_read")
    expect(none.text).toBe("No voice bible yet (.river/voice.md does not exist or is empty).")
    expect(none.data).toEqual({ voice: null, landed: [], cut: [] })

    mkdirSync(join(dir, ".river"), { recursive: true })
    const bible = "# Voice\n\n## Pillars\n\n- Dry. The dog gets the last word.\n\n## Lines that landed\n\n- A walk. Technically. (j_1)\n"
    writeFileSync(join(dir, ".river/voice.md"), bible)
    const r = await call("voice_read")
    expect(r.text).toBe(bible)
    expect(r.data).toMatchObject({ landed: ["A walk. Technically. (j_1)"], cut: [] })
    expect(tools.find((t) => t.name === "voice_read")!.mutating).toBe(false)
  })

  it("voice_note records landed and cut lines under their headings and leaves the user's text alone", async () => {
    mkdirSync(join(dir, ".river"), { recursive: true })
    writeFileSync(join(dir, ".river/voice.md"), "# Voice\n\n## Pillars\n\n- Dry.\n")
    const landed = await call("voice_note", { kind: "landed", key: "take a", text: "A walk.   Technically.\n" })
    expect(landed.text).toBe('Recorded under "## Lines that landed" in .river/voice.md:\n- A walk. Technically. (take a)')
    const cut = await call("voice_note", { kind: "cut", text: "The ducks, in their infinite wisdom, quacked." })
    expect(cut.data).toMatchObject({ added: true, kind: "cut", key: expect.stringMatching(/^claude-code-[a-z0-9]+$/) })

    const text = disk(".river/voice.md")
    expect(text).toMatch(/^# Voice\n\n## Pillars\n\n- Dry\.\n\n## Lines that landed\n\n- A walk\. Technically\. \(take a\)\n\n## Lines we cut\n\n- The ducks, in their infinite wisdom, quacked\. \(claude-code-[a-z0-9]+\)\n$/)
    expect((await call("voice_read")).data).toMatchObject({ landed: ["A walk. Technically. (take a)"], cut: [expect.stringContaining("infinite wisdom")] })
  })

  it("voice_note adds neither the same line nor the same key twice, and refuses a key that would break the bullet", async () => {
    await call("voice_note", { kind: "landed", key: "take a", text: "A walk. Technically." })
    const sameLine = await call("voice_note", { kind: "landed", key: "take b", text: "A walk.  Technically." })
    expect(sameLine.text).toContain("Already recorded")
    expect(sameLine.data).toMatchObject({ added: false })
    const sameKey = await call("voice_note", { kind: "landed", key: "take a", text: "Another line." })
    expect(sameKey.text).toContain("already has a line with the key (take a)")
    expect(sameKey.data).toMatchObject({ added: false })
    // The same line can be both an example and a cut: the sections are separate.
    expect((await call("voice_note", { kind: "cut", key: "take a", text: "A walk. Technically." })).data).toMatchObject({ added: true })
    expect(disk(".river/voice.md").match(/A walk\. Technically\./g)).toHaveLength(2)

    await expect(call("voice_note", { kind: "cut", key: "bad(key)", text: "x" })).rejects.toThrow(/invalid input for voice_note/)
    await expect(call("voice_note", { kind: "kept", text: "x" })).rejects.toThrow(/invalid input for voice_note/)
    await expect(call("voice_note", { kind: "cut", text: "   " })).rejects.toThrow(/needs a line of text/)
  })
})

describe("story_outline", () => {
  it("lists ids, tags, rules, word counts and choices with their targets and rules, and no prose", async () => {
    const r = await call("story_outline", { file: KENNEL })
    expect(r.text.split("\n")[0]).toBe('stories/kennel.twee  "Kennel"  5 passages, 29 words, start: Door')
    expect(r.text).toContain("- Door (id door) [start]  18 words")
    expect(r.text).toContain('    1: Wait -> Yard (id yard)  @set bond += 1 @hint "Mind the step"')
    expect(r.text).toContain("- Yard (id yard)  @set bond += 10 @shot nowhere  4 words")
    expect(r.text).toContain("- Cellar (id cellar)  @when treats >= 9  3 words")
    expect(r.text).toContain("- Out (id out) [ending]  @end  1 word")
    expect(r.text).toContain("    0: Hold him -> @return (back to the interrupted passage)  @set bond += 5")
    for (const prose of ["The yard is quiet", "Rex leans on you", "Ducks!", "Easy, boy", "Dark and damp"]) expect(r.text).not.toContain(prose)
    const data = r.data as { words: number; passages: { id: string; words: number; rules: string[]; choices: { target: string; targetId?: string; rules: string[] }[] }[] }
    expect(data.passages.map((p) => p.id)).toEqual(["door", "yard", "cellar", "out", "thunder"])
    expect(data.passages[1]).toMatchObject({ rules: ["@set bond += 10", "@shot nowhere"], choices: [{ target: "Out", targetId: "out", rules: [] }, { target: "Out", targetId: "out" }] })
    expect(data.words).toBe(data.passages.reduce((n, p) => n + p.words, 0))
  })

  it("marks a broken link and writes @cost the way the story does", async () => {
    const r = await call("story_outline", { file: PARK })
    expect(r.text).toContain("    1: Throw a treat -> Treat (id treat)  @cost treats 1 @when treats >= 1")
    expect(r.text).toContain("    2: Let go -> Splash (MISSING: no such passage)  @when excitement > 150")
    expect(r.text.length).toBeLessThan(disk(PARK).length * 1.6)
    await expect(call("story_outline", { file: "../x.twee" })).rejects.toThrow(/outside the project root/)
  })
})

describe("story_read_passage", () => {
  it("gives the raw text, the rendered prose, both directions of links, the neighbours and only the variables they use", async () => {
    const r = await call("story_read_passage", { file: KENNEL, passageId: "yard" })
    expect(r.text).toContain("Yard (id yard) in stories/kennel.twee")
    expect(r.text).toContain("Raw text:\n@id yard\n@shot nowhere\n@set bond += 10\n--\nThe yard is quiet.\n\n[[Leave->Out]]\n[[Slip out->Out]]")
    expect(r.text).toContain("Prose as a new game shows it (initial state, first visit):\nThe yard is quiet.")
    expect(r.text).toContain("Links to it (3):\n  Door (id door) choice 0: Go in\n  Door (id door) choice 1: Wait\n  Cellar (id cellar) choice 0: Back up")
    expect(r.text).toContain("Its links (2):\n  0: Leave -> Out (id out)\n  1: Slip out -> Out (id out)")
    expect(r.text).toContain("Neighbourhood, up to 1 link away (3 passages):")
    expect(r.text).toContain(":: Door (id door) [start], 1 link away\n@id door\n--\n{when bond > 40: Rex leans on you. | Rex keeps his distance.}")
    expect(r.text).toContain(":: Out (id out) [ending], 1 link away")
    // Thunder is not linked to Yard, so neither it nor its variable (noise) is here.
    expect(r.text).not.toContain("Thunder")
    expect(r.text).toMatch(/State variables these passages use \(stories\/state\.json\):\n {2}bond: number 0\.\.100, initial 50\n {2}treats: int 0\.\.10, initial 2$/)
    const data = r.data as { neighbours: { id: string; distance: number }[]; variables: Record<string, unknown>; incoming: unknown[] }
    expect(data.neighbours).toEqual([expect.objectContaining({ id: "door", distance: 1 }), expect.objectContaining({ id: "cellar", distance: 1 }), expect.objectContaining({ id: "out", distance: 1 })])
    expect(Object.keys(data.variables)).toEqual(["bond", "treats"])
    expect(data.incoming).toHaveLength(3)
  })

  it("renders templates for the initial state, takes a name for an id, and depth 0 reads the passage alone", async () => {
    const r = await call("story_read_passage", { file: KENNEL, passageId: "Door", depth: 0 })
    expect(r.text).toContain("Door (id door) [start] in stories/kennel.twee\nThe story starts here.")
    expect(r.text).toContain("Prose as a new game shows it (initial state, first visit):\nRex leans on you.\nYou have 2 treats left.")
    expect(r.text).toContain('  1: Wait -> Yard (id yard)  @set bond += 1 @hint "Mind the step"')
    expect(r.text).not.toContain("Neighbourhood")
    expect((r.data as { neighbours: unknown[] }).neighbours).toEqual([])

    const interrupt = await call("story_read_passage", { file: KENNEL, passageId: "thunder" })
    expect(interrupt.text).toContain("An [interrupt] passage")
    expect(interrupt.text).toContain("  0: Hold him -> @return (back to the interrupted passage)  @set bond += 5")
    expect(interrupt.text).toMatch(/State variables these passages use[^\n]*\n {2}bond: [^\n]*\n {2}noise: number 0\.\.100, initial 0$/)
  })

  it("depth 2 reaches the neighbours' neighbours, nearest first; a wrong id gets a suggestion", async () => {
    const one = (await call("story_read_passage", { file: PARK, passageId: "home_happy" })).data as { neighbours: { id: string }[] }
    expect(one.neighbours.map((n) => n.id)).toEqual(["long_path", "treat"])
    const two = (await call("story_read_passage", { file: PARK, passageId: "home_happy", depth: 2 })).data as { neighbours: { id: string; distance: number }[] }
    expect(two.neighbours.map((n) => `${n.id}:${n.distance}`)).toEqual(["long_path:1", "treat:1", "gate:2", "pond:2", "fetch:2"])
    await expect(call("story_read_passage", { file: PARK, passageId: "Pnd" })).rejects.toThrow('no passage with id "Pnd". Did you mean "pond" (passage Pond)?')
    await expect(call("story_read_passage", { file: PARK, passageId: "pond", depth: 3 })).rejects.toThrow(/invalid input for story_read_passage/)
  })
})

describe("story_search", () => {
  it("query finds text in names, prose, choice lines and hints, in any case, across every story", async () => {
    const r = await call("story_search", { query: "DUCK" })
    expect(r.text).toContain('3 passages match query "DUCK" in 2 story files:')
    expect(r.text).toContain("stories/kennel.twee\n- Door (id door) [start]\n    text: Rex [excited]: Ducks! So many ducks!")
    expect(r.text).toContain("stories/park_walk.twee\n- Pond (id pond) [encounter]\n    text: Ducks. Many ducks.")
    expect((r.data as { matches: { id: string }[] }).matches.map((m) => m.id)).toEqual(["door", "pond", "treat"])

    const hint = await call("story_search", { file: KENNEL, query: "mind the" })
    expect(hint.text).toContain('1 passage matches query "mind the" in stories/kennel.twee:')
    expect(hint.text).toContain('    text: [[Go in->Yard]] @hint "Mind the step"')
    expect((await call("story_search", { file: PARK, query: "long pa" })).text).toContain("    name: Long path")
    expect((await call("story_search", { file: KENNEL, query: "zzz" })).text).toBe('No passage matches query "zzz" in stories/kennel.twee.')
  })

  it("tag, variable and speaker each find passages and say why", async () => {
    expect(((await call("story_search", { tag: "Interrupt" })).data as { matches: { id: string }[] }).matches.map((m) => m.id)).toEqual(["thunder", "loud_bang"])

    const bond = await call("story_search", { file: KENNEL, variable: "bond" })
    expect(bond.text).toContain("3 passages match variable bond in stories/kennel.twee:")
    expect(bond.text).toContain("- Door (id door) [start]\n    bond: prose {when}, choice 1 @set")
    expect(bond.text).toContain("- Yard (id yard)\n    bond: @set")
    expect(bond.text).toContain("- Thunder (id thunder) [interrupt]\n    bond: choice 0 @set")
    const treats = (await call("story_search", { variable: "treats" })).data as { matches: { id: string; why: string[] }[] }
    expect(treats.matches).toEqual([
      expect.objectContaining({ id: "door", why: ["treats: prose {var}"] }),
      expect.objectContaining({ id: "cellar", why: ["treats: @when"] }),
      expect.objectContaining({ id: "pond", why: ["treats: choice 1 @when, choice 1 @cost"] }),
    ])

    const rex = await call("story_search", { file: KENNEL, speaker: "rex" })
    expect(rex.text).toBe("1 passage matches speaker rex in stories/kennel.twee:\n- Door (id door) [start]\n    Rex [excited]: Ducks! So many ducks!")
    expect((await call("story_search", { speaker: "Mara" })).text).toContain("    Mara: Easy, boy.")
    expect((await call("story_search", { speaker: "Nobody" })).text).toBe("No passage matches speaker Nobody in 2 story files.")
  })

  it("several filters narrow the result, and it needs at least one", async () => {
    const both = (await call("story_search", { query: "home", tag: "ending" })).data as { matches: { id: string }[] }
    expect(both.matches.map((m) => m.id)).toEqual(["home_happy", "home_grumpy"])
    expect(((await call("story_search", { variable: "bond", tag: "interrupt", file: PARK })).data as { matches: { id: string }[] }).matches.map((m) => m.id)).toEqual(["loud_bang"])
    await expect(call("story_search", {})).rejects.toThrow(/needs at least one of query, tag, variable, speaker/)
    await expect(call("story_search", { file: "river.json", query: "x" })).rejects.toThrow(/not a story file/)
  })
})

describe("story_pacing", () => {
  it("returns the pacing lines and the report as data", async () => {
    const r = await call("story_pacing", { file: PARK })
    expect(r.text).toBe(
      [
        "stories/park_walk.twee",
        "9 passages, 60 words (6.7 per passage), 2 endings",
        "11 choices, 1.6 per passage that is not an ending",
        "4 possible routes: 20-27 words (avg 23.8), 2-2 decisions (avg 2)",
        "longest passages: gate (11), calm_down (10), loud_bang (10)",
      ].join("\n"),
    )
    const data = r.data as { file: string; passages: number; words: number; endings: number; wordsByPassage: Record<string, number>; routes: unknown[]; routeStats: { count: number }; truncated: boolean }
    expect(data).toMatchObject({ file: PARK, passages: 9, words: 60, endings: 2, truncated: false, routeStats: { count: 4 } })
    expect(data.wordsByPassage["gate"]).toBe(11)
    expect(((await call("story_pacing", { file: PARK, maxPaths: 2 })).data as { truncated: boolean; routes: unknown[] }).routes).toHaveLength(2)
  })
})

describe("story_sample_transcripts", () => {
  it("reads routes as the player does: templates filled in, no rules, links or cue lines", async () => {
    const r = await call("story_sample_transcripts", { file: KENNEL })
    expect(r.text).toContain("of stories/kennel.twee")
    expect(r.text).toContain("door > yard > out (ending: Out) ---\n## Door\n\nRex leans on you.\nYou have 2 treats left.\n\nRex [excited]: Ducks! So many ducks!\nMara: \"Easy, boy.\"\n\n> ")
    expect(r.text).toContain("## Yard\n\nThe yard is quiet.\n\n> ")
    expect(r.text).not.toMatch(/\[\[|@hint|@set|@when|@id|\{when|\{treats\}/)
    const data = r.data as { transcripts: { route: string[]; end: string; complete: boolean }[] }
    expect(data.transcripts.every((t) => t.complete && t.route[0] === "door")).toBe(true)
    expect(r.text).not.toContain("Thunder")
  })

  it("covers every ending, reads interrupts when asked, and proseOnly drops names and choices", async () => {
    const park = (await call("story_sample_transcripts", { file: PARK })).data as { transcripts: { end: string; ending?: string }[] }
    expect(new Set(park.transcripts.map((t) => t.ending).filter(Boolean))).toEqual(new Set(["Home happy", "Home grumpy"]))
    expect(((await call("story_sample_transcripts", { file: PARK, maxTranscripts: 1 })).data as { transcripts: unknown[] }).transcripts).toHaveLength(1)

    const withInterrupts = await call("story_sample_transcripts", { file: KENNEL, includeInterrupts: true })
    expect(withInterrupts.text).toContain("thunder (interrupt, back to the story) ---\n## Thunder\n\nA low rumble.\n\n> Hold him\n\n(back to where the interrupt started)")

    const prose = await call("story_sample_transcripts", { file: KENNEL, maxTranscripts: 1, proseOnly: true })
    expect(prose.text.split("---\n")[1]).toBe("Rex leans on you.\nYou have 2 treats left.\n\nRex [excited]: Ducks! So many ducks!\nMara: \"Easy, boy.\"\n\nThe yard is quiet.\n\nDone.")
    await expect(call("story_sample_transcripts", { file: KENNEL, maxTranscripts: 0 })).rejects.toThrow(/invalid input/)
  })
})

describe("story_lint with narrative notes", () => {
  it("keeps the lint summary line and its counts, and adds the notes after it", async () => {
    const r = await call("story_lint", { file: PARK })
    expect(r.text).toContain(
      "1 error, 3 warnings in 9 passages\nNarrative notes (craft advice, never blocks an export): 0 warnings, 1 info\ninfo   bond is changed (first in Pond) but no condition, cost or template reads it  (unused-state-var)",
    )
    expect(r.data).toMatchObject({ errors: 1, warnings: 3, narrative: { warnings: 0, infos: 1 } })
    const off = await call("story_lint", { file: PARK, narrative: false })
    expect(off.text.split("\n").at(-1)).toBe("1 error, 3 warnings in 9 passages")
    expect(off.text).not.toContain("Narrative")
    expect(off.data).toEqual({ errors: 1, warnings: 3, files: [{ file: PARK, diagnostics: expect.any(Array) }] })
  })

  it("reports every narrative rule: unused variable, false choice, duplicate copy, copy budget, unreachable from the start, unknown shot", async () => {
    const r = await call("story_lint", { file: KENNEL })
    expect(r.text).toContain("0 errors, 1 warning in 5 passages\nNarrative notes (craft advice, never blocks an export): 3 warnings, 4 info")
    expect(r.text).toContain("info   energy is declared in the state schema but nothing reads it  (unused-state-var)")
    expect(r.text).toContain("info   Yard: all 2 choices lead to Out with the same effects, so the choice does not change anything  (false-choice)")
    expect(r.text).toContain('info   the hint "Mind the step" is used on 2 choices: Door [Go in], Door [Wait]  (duplicate-copy)')
    expect(r.text).toContain("warn   Door: the body line count is 4 (budget 3)  (copy-budget-exceeded)")
    expect(r.text).toContain("warn   Cellar: links lead here, but no game started from the initial state can get here (check the conditions on the way)  (unreachable-from-initial)")
    expect(r.text).toContain("warn   Yard: @shot nowhere is not a shot in the manifest  (unknown-shot)")
    const data = r.data as { files: { narrative: { severity: string; code: string }[] }[] }
    expect(data.files[0]!.narrative.every((d) => d.severity === "info" || d.severity === "warn")).toBe(true)
    expect(new Set(data.files[0]!.narrative.map((d) => d.code))).toEqual(new Set(["unused-state-var", "false-choice", "duplicate-copy", "copy-budget-exceeded", "unreachable-from-initial", "unknown-shot"]))

    // Every story at once: the notes are grouped by file under one heading.
    const all = await call("story_lint")
    expect(all.text).toContain("1 error, 4 warnings in 14 passages\nNarrative notes (craft advice, never blocks an export): 3 warnings, 5 info\nstories/kennel.twee\n")
    expect(all.text).toContain("stories/park_walk.twee\ninfo   bond is changed")
  })
})

describe("playtest_run with steps", () => {
  it("choices alone work as before, now with the prose rendered", async () => {
    const r = await call("playtest_run", { file: KENNEL, choices: [0, 0] })
    expect(r.text).toContain("== Door == (id door)\nRex leans on you.\nYou have 2 treats left.")
    expect(r.text).toContain("  2: Sneak down -> Cellar  [closed: Cellar needs treats >= 9 on arrival]")
    expect(r.text).toContain("> 0: Go in\n\n== Yard == (id yard)\nThe yard is quiet.")
    expect(r.text).toMatch(/== Out == \(id out\)\nDone\.\n {2}state: [^\n]*bond=60[^\n]*\n {2}-- the end --$/)
    // A run without steps cannot start an interrupt, so its transcript does not list them.
    expect(r.text).not.toContain("interrupt")
    const data = r.data as { steps: { passageId: string; choice?: number }[]; over: boolean }
    expect(data.steps.map((s) => [s.passageId, s.choice])).toEqual([["door", undefined], ["yard", 0], ["out", 0]])
    expect(data.over).toBe(true)
    expect((await call("playtest_run", { file: KENNEL })).text).toMatch(/^== Door == \(id door\)/)
    await expect(call("playtest_run", { file: KENNEL, choices: [2] })).rejects.toThrow(/step 1 \(choice 2\) failed: choice "Sneak down" is closed/)
  })

  it("a step can set state mid-run, which changes the reactive prose and what is open", async () => {
    const r = await call("playtest_run", { file: KENNEL, steps: [{ set: { bond: 10, treats: 9 } }, { choice: 2 }] })
    expect(r.text).toContain("~ set bond=10, treats=9\n\n== Door == (id door)\nRex keeps his distance.\nYou have 9 treats left.")
    expect(r.text).toContain("  2: Sneak down -> Cellar\n")
    expect(r.text).toContain("> 2: Sneak down\n\n== Cellar == (id cellar)\nDark and damp.")
    const data = r.data as { steps: { passageId: string; text: string; set?: unknown; choice?: number; state: Record<string, unknown> }[] }
    expect(data.steps.map((s) => s.passageId)).toEqual(["door", "door", "cellar"])
    expect(data.steps[1]).toMatchObject({ set: { bond: 10, treats: 9 }, text: expect.stringContaining("Rex keeps his distance."), state: { bond: 10, treats: 9 } })
    expect(data.steps[2]).toMatchObject({ choice: 2 })
  })

  it("starts an interrupt once its @when holds, and @return comes back with its effects", async () => {
    const first = await call("playtest_run", { file: KENNEL, steps: [] })
    expect(first.text).toContain("  interrupt Thunder  [closed: noise >= 80]")
    await expect(call("playtest_run", { file: KENNEL, steps: [{ interrupt: "Thunder" }] })).rejects.toThrow(/step 1 \(interrupt "Thunder"\) failed: Thunder cannot start: its @when noise >= 80 is false\n\nTranscript so far:\n== Door ==/)

    const r = await call("playtest_run", { file: KENNEL, steps: [{ set: { noise: 95 }, interrupt: "thunder", choice: 0 }, { choice: 0 }] })
    expect(r.text).toContain("~ set noise=95\n\n! interrupt: Thunder\n\n== Thunder == (id thunder)\nThe sky splits.\n  0: Hold him -> @return\n")
    expect(r.text).toContain("> 0: Hold him\n\n== Door == (id door)")
    expect(r.text).toContain("  interrupt Thunder  [can start]")
    const data = r.data as { steps: { passageId: string; interrupt?: string; set?: unknown; choice?: number; state: { bond: number } }[]; over: boolean }
    expect(data.steps.map((s) => s.passageId)).toEqual(["door", "thunder", "door", "yard"])
    expect(data.steps[1]).toMatchObject({ interrupt: "thunder", set: { noise: 95 } })
    expect(data.steps[2]).toMatchObject({ choice: 0, state: { bond: 55 } })
    // Yard's own @set runs on top of the interrupt's.
    expect(data.steps[3]!.state.bond).toBe(65)
    expect(data.over).toBe(false)
    // A lower noise picks the other branch of the interrupt's template.
    expect((await call("playtest_run", { file: KENNEL, steps: [{ set: { noise: 85 }, interrupt: "Thunder" }] })).text).toContain("== Thunder == (id thunder)\nA low rumble.")
  })

  it("proseOnly gives what the player reads, once per entry, and choices run before steps", async () => {
    const r = await call("playtest_run", { file: KENNEL, proseOnly: true, steps: [{ set: { noise: 85 }, interrupt: "thunder" }, { choice: 0 }, { set: { bond: 0 } }, { choice: 1 }, { choice: 0 }] })
    expect(r.text).toBe(
      [
        "Rex leans on you.\nYou have 2 treats left.\n\nRex [excited]: Ducks! So many ducks!\nMara: \"Easy, boy.\"",
        "A low rumble.",
        // Back from the interrupt the door is not read again; it is once the state changes its text.
        "Rex keeps his distance.\nYou have 2 treats left.\n\nRex [excited]: Ducks! So many ducks!\nMara: \"Easy, boy.\"",
        "The yard is quiet.",
        "Done.",
      ].join("\n\n"),
    )
    expect(r.text).not.toMatch(/==|state:|>|\[\[/)
    expect((r.data as { prose: string[] }).prose).toHaveLength(5)

    const mixed = (await call("playtest_run", { file: KENNEL, choices: [0], steps: [{ choice: 1 }] })).data as { steps: { passageId: string; choice?: number }[] }
    expect(mixed.steps.map((s) => [s.passageId, s.choice])).toEqual([["door", undefined], ["yard", 0], ["out", 1]])
  })

  it("names the step that failed: an empty step, an unknown variable, a value outside the schema", async () => {
    await expect(call("playtest_run", { file: KENNEL, steps: [{ choice: 0 }, {}] })).rejects.toThrow(/step 2 \(empty\) failed: a step needs set, interrupt, drawStorylet or choice/)
    await expect(call("playtest_run", { file: KENNEL, steps: [{ set: { nope: 1 } }] })).rejects.toThrow(/step 1 \(set nope\) failed: unknown variable "nope"/)
    await expect(call("playtest_run", { file: KENNEL, steps: [{ set: { treats: 99 } }] })).rejects.toThrow(/step 1 \(set treats\) failed: treats must be between 0 and 10/)
    await expect(call("playtest_run", { file: KENNEL, steps: [{ interrupt: "Yard" }] })).rejects.toThrow(/no interrupt passage named "Yard"/)
    await expect(call("playtest_run", { file: KENNEL, steps: [{ choice: "0" }] })).rejects.toThrow(/invalid input for playtest_run/)
  })
})

describe("story_rename_passage and story_delete_passage", () => {
  it("rename rewrites every link, keeps the id, and returns the diff", async () => {
    const r = await call("story_rename_passage", { file: KENNEL, passageId: "yard", newName: "Back yard" })
    expect(r.text).toContain('Renamed passage yard from "Yard" to "Back yard" in stories/kennel.twee (3 links to it). Its id is still yard.')
    expect(r.text).toContain("-:: Yard\n+:: Back yard\n @id yard")
    expect(r.text).toContain('-[[Wait->Yard]] @set bond += 1 @hint "Mind the step"\n+[[Go in->Back yard]] @hint "Mind the step"\n+[[Wait->Back yard]] @set bond += 1 @hint "Mind the step"')
    expect(r.text).toContain("-[[Back up->Yard]]\n+[[Back up->Back yard]]")
    expect(r.text).toContain("No new lint problems.\n0 errors in the file now.")
    const text = disk(KENNEL)
    expect(text).toContain(":: Back yard\n@id yard\n")
    expect(text).toContain("[[Back up->Back yard]]")
    expect(text).not.toMatch(/->Yard\]\]/)
    expect(tools.find((t) => t.name === "story_rename_passage")!.mutating).toBe(true)
  })

  it("rename adds an @id when the id came from the old name, and refuses a taken name", async () => {
    await call("story_add_passage", { file: KENNEL, name: "Shed", rawText: "Tools.\n\n[[Out->Out]]" })
    await call("story_rename_passage", { file: KENNEL, passageId: "shed", newName: "Tool shed" })
    expect(disk(KENNEL)).toContain(":: Tool shed\n@id shed\n--\nTools.")
    const before = disk(KENNEL)
    await expect(call("story_rename_passage", { file: KENNEL, passageId: "yard", newName: "Door" })).rejects.toThrow('a passage named "Door" already exists')
    await expect(call("story_rename_passage", { file: KENNEL, passageId: "yard", newName: "Yard" })).rejects.toThrow(/already named "Yard"/)
    await expect(call("story_rename_passage", { file: KENNEL, passageId: "yard", newName: " padded " })).rejects.toThrow(/would not read back as written/)
    await expect(call("story_rename_passage", { file: KENNEL, passageId: "Yrd", newName: "X" })).rejects.toThrow('Did you mean "yard" (passage Yard)?')
    await expect(call("story_rename_passage", { file: KENNEL, passageId: "yard", newName: "two\nlines" })).rejects.toThrow(/invalid input/)
    expect(disk(KENNEL)).toBe(before)
  })

  it("renaming a passage that already has lint problems reports nothing new, in any of the three tools", async () => {
    // Pond has a broken link (Splash) and a never-true warning; both name the passage, so both read differently after.
    const before = disk(PARK)
    const writer = createRiverTools(project, { writingId: "w_rename01" })
    const take = await call("writing_write", { variant: "a", storyFile: PARK, caption: "Duck pond", summary: "Names the pond for what it is.", edits: [{ op: "rename", passageId: "pond", newName: "Duck pond" }] }, writer)
    expect(take.text).toContain("error  Duck pond → Splash: no passage has this name\n")
    expect(take.text).not.toContain("(new)")
    expect(take.text).not.toContain("Links this take breaks")
    expect(take.text).toMatch(/This take brings no new errors or warnings\.$/)
    expect(disk(PARK)).toBe(before)

    // Two renames of the same passage in one batch: the problems follow it through both names.
    const batch = await call("story_batch_edit", { file: PARK, edits: [{ op: "rename", passageId: "pond", newName: "Duck pond" }, { op: "rename", passageId: "fetch", newName: "Stick" }, { op: "rename", passageId: "pond", newName: "The pond" }] })
    expect(batch.text).toContain("Lint: 1 error, 3 warnings\nerror  The pond → Splash: no passage has this name\n")
    expect(batch.text).toContain("warn   Long path → Stick: the choice can show while Stick's @when energy >= 20 is false.")
    expect(batch.text).not.toContain("(new)")
    expect(batch.text).not.toContain("Links these edits broke")
    expect((batch.data as { newProblems: unknown[]; brokenLinks: unknown[] }).newProblems).toEqual([])

    const single = await call("story_rename_passage", { file: PARK, passageId: "pond", newName: "Pond again" })
    expect(single.text).toContain("No new lint problems.\n1 error in the file now.")
    // A problem the rename does bring is still new: the old name is free, and a link to it is now broken.
    await call("story_rename_passage", { file: PARK, passageId: "treat", newName: "Snack" })
    const broke = await call("story_batch_edit", { file: PARK, edits: [{ op: "rename", passageId: "pond", newName: "Pond" }, { op: "write", passageId: "gate", rawText: "@id gate\n--\nThe gate.\n\n[[Go->Pond]]\n[[Old name->Treat]]" }] })
    expect(broke.text).toContain("Links these edits broke (1):\n  Gate [Old name] -> Treat\n")
    expect(broke.text).toContain("error  Gate → Treat: no passage has this name  (new)")
    expect(broke.text).toContain("error  Pond → Splash: no passage has this name\n")
  })

  it("delete removes the passage and names every link it broke", async () => {
    const r = await call("story_delete_passage", { file: KENNEL, passageId: "yard" })
    expect(r.text).toContain("Deleted passage Yard (id yard) from stories/kennel.twee.")
    expect(r.text).toContain("-:: Yard\n-@id yard\n")
    expect(r.text).toContain("New lint problems:\nerror  Door → Yard: no passage has this name")
    expect(r.text).toContain("Links this broke (3); point them at another passage or remove them:\n  Door [Go in] -> Yard\n  Door [Wait] -> Yard\n  Cellar [Back up] -> Yard\n3 errors in the file now.")
    expect((r.data as { brokenLinks: string[] }).brokenLinks).toEqual(["Door [Go in] -> Yard", "Door [Wait] -> Yard", "Cellar [Back up] -> Yard"])
    expect(disk(KENNEL)).not.toContain(":: Yard")
    // StoryData and the other passages keep their place.
    expect(disk(KENNEL)).toContain('"start": "Door"\n}\n\n:: Door [start]')
  })

  it("delete says when nothing led to the passage, flags a deleted start, and suggests ids", async () => {
    const cellar = await call("story_delete_passage", { file: KENNEL, passageId: "cellar" })
    expect(cellar.text).toContain("Links this broke (1); point them at another passage or remove them:\n  Door [Sneak down] -> Cellar")
    const thunder = await call("story_delete_passage", { file: KENNEL, passageId: "thunder" })
    expect(thunder.text).toContain("No new lint problems.\nNo link led to it.")
    const start = await call("story_delete_passage", { file: KENNEL, passageId: "door" })
    expect(start.text).toContain(`Door was the story's start passage: set "start" in StoryData to another passage.`)
    await expect(call("story_delete_passage", { file: KENNEL, passageId: "Out" })).rejects.toThrow('no passage with id "Out". Did you mean "out" (passage Out)?')
  })
})

describe("story_batch_edit", () => {
  const edits = [
    { op: "write", passageId: "yard", rawText: "@id yard\n@set bond += 10\n--\nThe yard is loud now.\n\n[[Leave->Gate]]\n" },
    { op: "add", name: "Gate", rawText: "@id gate\n--\nA gate.\n\n[[Out->Out]]", tags: ["exit"] },
    { op: "rename", passageId: "gate", newName: "Side gate" },
    { op: "delete", passageId: "cellar" },
  ]

  it("applies write, add, rename and delete in order as one change, with one diff and the whole report", async () => {
    const r = await call("story_batch_edit", { file: KENNEL, edits })
    expect(r.text).toContain("Applied 4 edits to stories/kennel.twee in one write:\n  1. write yard\n  2. add Gate (id gate)\n  3. rename gate: Gate -> Side gate\n  4. delete cellar")
    expect(r.text.match(/^--- a\/stories\/kennel\.twee$/gm)).toHaveLength(1)
    // The rename (edit 3) rewrote the link the write (edit 1) made.
    expect(r.text).toContain("-The yard is quiet.\n-\n-[[Leave->Out]]\n-[[Slip out->Out]]")
    expect(r.text).toContain("+The yard is loud now.\n \n-[[Back up->Yard]]\n+[[Leave->Side gate]]")
    expect(r.text).toContain("+:: Side gate [exit]\n+@id gate\n+--\n+A gate.\n+\n+[[Out->Out]]")
    expect(r.text).toContain("Links these edits broke (1):\n  Door [Sneak down] -> Cellar\nLint: 1 error, 0 warnings\nerror  Door → Cellar: no passage has this name  (new)\nNarrative notes (craft advice, never blocks an export): 1 warning, 3 info\n")
    expect(r.text).toContain('info   the hint "Mind the step" is used on 2 choices: Door [Go in], Door [Wait]  (duplicate-copy)\n')
    // The false choice and the unknown shot left with the old yard text, so they are not in the report.
    expect(r.text).not.toMatch(/false-choice|unknown-shot|unreachable-from-initial/)

    const text = disk(KENNEL)
    expect(text).toContain(":: Yard\n@id yard\n@set bond += 10\n--\nThe yard is loud now.\n\n[[Leave->Side gate]]\n\n:: Out [ending]")
    expect(text).toMatch(/:: Side gate \[exit\]\n@id gate\n--\nA gate\.\n\n\[\[Out->Out\]\]\n$/)
    expect(text).not.toContain(":: Cellar")
    const data = r.data as { applied: string[]; passageIds: string[]; newProblems: { code: string }[]; brokenLinks: string[]; diagnostics: unknown[]; narrative: unknown[] }
    expect(data.passageIds).toEqual(["yard", "gate"])
    expect(data.newProblems.map((d) => d.code)).toEqual(["broken-link"])
    expect(data.narrative).toHaveLength(4)
  })

  it("is all or nothing: one failing edit leaves the file byte for byte as it was", async () => {
    const before = disk(KENNEL)
    await expect(call("story_batch_edit", { file: KENNEL, edits: [edits[0], edits[1], { op: "delete", passageId: "nope" }] })).rejects.toThrow(
      'edit 3 of 3 (delete nope) failed: no passage with id "nope".\nNothing was written: fix this edit and send all of them again.',
    )
    await expect(call("story_batch_edit", { file: KENNEL, edits: [edits[1], edits[1]] })).rejects.toThrow('edit 2 of 2 (add "Gate") failed: a passage named "Gate" already exists')
    await expect(call("story_batch_edit", { file: KENNEL, edits: [edits[0], { op: "rename", passageId: "yard", newName: "Door" }] })).rejects.toThrow(/edit 2 of 2 \(rename yard\) failed: a passage named "Door" already exists/)
    await expect(call("story_batch_edit", { file: KENNEL, edits: [edits[0], { op: "add", name: "Other", rawText: "@id yard\n--\nx" }] })).rejects.toThrow(/edit 2 of 2 \(add "Other"\) failed: a passage with id "yard" already exists/)
    // A name the file's header would not give back is refused before anything is saved.
    await expect(call("story_batch_edit", { file: KENNEL, edits: [edits[0], { op: "rename", passageId: "out", newName: " padded " }] })).rejects.toThrow(/would not read back as written: passage " padded " \(id out\) reads back as "padded"/)
    expect(disk(KENNEL)).toBe(before)
  })

  it("checks the input: at least one edit, a known op, a story file", async () => {
    await expect(call("story_batch_edit", { file: KENNEL, edits: [] })).rejects.toThrow(/invalid input for story_batch_edit/)
    await expect(call("story_batch_edit", { file: KENNEL, edits: [{ op: "move", passageId: "yard" }] })).rejects.toThrow(/invalid input for story_batch_edit/)
    await expect(call("story_batch_edit", { file: KENNEL, edits: [{ op: "write", passageId: "yard" }] })).rejects.toThrow(/invalid input for story_batch_edit/)
    await expect(call("story_batch_edit", { file: "river.json", edits: [edits[3]] })).rejects.toThrow(/not a story file/)
    await expect(call("story_batch_edit", { file: "../x.twee", edits: [edits[3]] })).rejects.toThrow(/outside the project root/)
  })

  it("a text line that starts with :: stays text of its passage", async () => {
    await call("story_batch_edit", { file: KENNEL, edits: [{ op: "write", passageId: "cellar", rawText: "@id cellar\n--\nA sign:\n:: Keep out\n\n[[Back up->Yard]]" }] })
    const outline = (await call("story_outline", { file: KENNEL })).data as { passages: { id: string }[] }
    expect(outline.passages.map((p) => p.id)).toEqual(["door", "yard", "cellar", "out", "thunder"])
    expect((await call("story_read_passage", { file: KENNEL, passageId: "cellar", depth: 0 })).text).toContain("A sign:\n:: Keep out")
  })
})

describe("writing_write", () => {
  const WRITING = "w_test0001"
  const writer = () => createRiverTools(project, { writingId: WRITING })
  const write = (input: unknown) => call("writing_write", input, writer())
  const takePath = (v: string) => join(dir, ".river", "writing", WRITING, `take_${v}.json`)
  const take = (v: string) => JSON.parse(readFileSync(takePath(v), "utf8")) as WritingTakeFile
  const loud = { variant: "a", storyFile: KENNEL, caption: "Louder  yard", summary: " The yard gets noise and one way out. ", edits: [{ op: "write", passageId: "yard", rawText: YARD_LOUD }] }

  it("exists only for a writing job, whose server starts no job and writes no concept", () => {
    expect(tools.some((t) => t.name === "writing_write")).toBe(false)
    const names = writer().map((t) => t.name)
    expect(names).toContain("writing_write")
    for (const gone of ["concept_request", "concept_write", "writing_request"]) expect(names).not.toContain(gone)
    expect(writer().find((t) => t.name === "writing_write")!.mutating).toBe(true)
    expect(selectTools(writer(), ["story_outline", "writing_write"]).map((t) => t.name)).toEqual(["story_outline", "writing_write"])
    expect(() => selectTools(tools, ["writing_write"])).toThrow(/writing_write needs --writing <id>/)
    expect(() => selectTools(writer(), ["writing_request"])).toThrow(/a --writing server has no concept_request, concept_write or writing_request/)
    expect(() => selectTools(writer(), ["concept_write"])).toThrow(/concept_write needs --concept/)
    // A concept job's server has no writing tools either.
    const concept = createRiverTools(project, { conceptId: "k_test0001" }).map((t) => t.name)
    expect(concept).not.toContain("writing_request")
    expect(concept).not.toContain("writing_write")
  })

  it("refuses an id that could leave .river/writing/, and a server for both kinds of job", () => {
    for (const id of ["../x", "a/b", "a\\b", "", ".", "con", "NUL", "x".repeat(65)]) expect(() => createRiverTools(project, { writingId: id }), id).toThrow(/invalid writing id/)
    expect(() => createRiverTools(project, { writingId: WRITING, conceptId: "k_test0001" })).toThrow(/--concept\) or a writing job \(--writing\), not both/)
  })

  it("saves the take beside the story, with its diff and lint, and never changes the story", async () => {
    const before = disk(KENNEL)
    const r = await write(loud)
    expect(r.text).toContain(`Wrote take A of stories/kennel.twee to .river/writing/${WRITING}/take_a.json (1 edit). The story file is unchanged`)
    expect(r.text).toContain("-The yard is quiet.\n+The yard is loud now.\n \n [[Leave->Out]]\n-[[Slip out->Out]]")
    expect(r.text).toContain("Lint: 0 errors, 1 warning\nwarn   Door → Cellar:")
    expect(r.text).toContain("Narrative notes (craft advice, never blocks an export): 2 warnings, 3 info")
    expect(r.text).toMatch(/This take brings no new errors or warnings\.$/)
    expect(r.text).not.toContain("(new)")
    expect(disk(KENNEL)).toBe(before)

    const saved = take("a")
    expect(saved).toMatchObject({
      version: 1,
      writingId: WRITING,
      variant: "a",
      caption: "Louder yard",
      summary: "The yard gets noise and one way out.",
      storyFile: KENNEL,
      edits: loud.edits,
      passageIds: ["yard"],
      lintErrors: 0,
      lintWarnings: 1,
      narrativeWarnings: 2,
      narrativeInfos: 3,
    })
    expect(saved.baseSha256).toMatch(/^[0-9a-f]{64}$/)
    expect(saved.text).toBe(before.replace("@shot nowhere\n", "").replace("The yard is quiet.", "The yard is loud now.").replace("[[Slip out->Out]]\n", ""))
    expect(saved.diff).toContain("+The yard is loud now.")
    expect(Number.isNaN(Date.parse(saved.writtenAt))).toBe(false)
    // Only the take is written: nothing else under .river/writing/, no temp file left.
    expect(readdirSync(join(dir, ".river", "writing"))).toEqual([WRITING])
    expect(readdirSync(join(dir, ".river", "writing", WRITING))).toEqual(["take_a.json"])
  })

  it("stores the edits as it applied them, so applying a take's edits again gives the take's text", async () => {
    await write({ ...loud, edits: [{ op: "write", passageId: "yard", rawText: `${YARD_LOUD.replace(/\n/g, "\r\n")}\r\n\r\n` }, { op: "rename", passageId: "out", newName: "Street" }] })
    const saved = take("a")
    // What River's writing job reads back: the variant, the story file, the caption, the summary and the edits.
    expect(Object.keys(saved)).toEqual(expect.arrayContaining(["variant", "storyFile", "caption", "summary", "edits"]))
    expect(saved.edits).toEqual([{ op: "write", passageId: "yard", rawText: YARD_LOUD }, { op: "rename", passageId: "out", newName: "Street" }])
    expect(saved.text).toContain("The yard is loud now.\n\n[[Leave->Street]]\n\n:: Cellar")
    expect(saved.text).not.toContain("\r")

    // Applied to the story for real, the same edits give the same file.
    await call("story_batch_edit", { file: KENNEL, edits: saved.edits, summary: "Keep  take A" })
    expect(disk(KENNEL)).toBe(saved.text)
    await expect(write({ ...loud, edits: Array.from({ length: 65 }, () => loud.edits[0]) })).rejects.toThrow(/invalid input for writing_write/)
  })

  it("marks the problems a take brings so the writer can fix them, and every take starts from the story on disk", async () => {
    const broken = await write({ ...loud, variant: "b", edits: [{ op: "write", passageId: "yard", rawText: YARD_LOUD.replace("->Out", "->Nowhere") }, { op: "add", name: "Kennel", rawText: "@id kennel\n@shot nowhere\n--\nStraw.\n\n[[Out->Out]]" }] })
    expect(broken.text).toContain("Links this take breaks (1):\n  Yard [Leave] -> Nowhere")
    expect(broken.text).toContain("error  Yard → Nowhere: no passage has this name  (new)")
    expect(broken.text).toContain("warn   Kennel: @shot nowhere is not a shot in the manifest  (unknown-shot)  (new)")
    expect(broken.text).toMatch(/This take brings \d+ new problems, marked \(new\) above\. Fix that and write take B again\.$/)
    expect(take("b")).toMatchObject({ lintErrors: 1, passageIds: ["yard", "kennel"] })

    // Take A does not see the passage take B added, and writing B again replaces it.
    await write(loud)
    expect(take("b").text).toContain(":: Kennel\n@id kennel")
    expect(take("a").text).not.toContain(":: Kennel")
    const fixed = await write({ ...loud, variant: "b", caption: "Fixed" })
    expect(fixed.text).toMatch(/no new errors or warnings\.$/)
    expect(take("b")).toMatchObject({ caption: "Fixed", lintErrors: 0, passageIds: ["yard"] })
    expect(readdirSync(join(dir, ".river", "writing", WRITING)).sort()).toEqual(["take_a.json", "take_b.json"])
    expect(disk(KENNEL)).toBe(KENNEL_TWEE)
  })

  it("remove deletes a take; a take needs edits that change something, a caption and a summary", async () => {
    await write(loud)
    await expect(write({ ...loud, remove: true })).rejects.toThrow(/remove deletes the take; send it with edits: \[\]/)
    expect((await write({ variant: "a", storyFile: KENNEL, edits: [], remove: true })).text).toBe(`Removed take A (.river/writing/${WRITING}/take_a.json).`)
    expect(existsSync(takePath("a"))).toBe(false)
    expect((await write({ variant: "a", storyFile: KENNEL, edits: [], remove: true })).text).toBe("There is no take A to remove.")

    await expect(write({ ...loud, edits: [] })).rejects.toThrow(/a take needs at least one edit/)
    await expect(write({ ...loud, caption: "  " })).rejects.toThrow(/a take needs a caption/)
    await expect(write({ variant: "a", storyFile: KENNEL, caption: "x", edits: loud.edits })).rejects.toThrow(/a take needs a summary/)
    const same = "@id yard\n@shot nowhere\n@set bond += 10\n--\nThe yard is quiet.\n\n[[Leave->Out]]\n[[Slip out->Out]]"
    await expect(write({ ...loud, edits: [{ op: "write", passageId: "yard", rawText: same }] })).rejects.toThrow(/these edits change nothing in stories\/kennel\.twee/)
    await expect(write({ ...loud, edits: [...loud.edits, { op: "delete", passageId: "nope" }] })).rejects.toThrow(/edit 2 of 2 \(delete nope\) failed/)
    await expect(write({ ...loud, variant: "f" })).rejects.toThrow(/invalid input for writing_write/)
    await expect(write({ ...loud, caption: "x".repeat(161) })).rejects.toThrow(/invalid input for writing_write/)
    await expect(write({ ...loud, summary: "x".repeat(601) })).rejects.toThrow(/invalid input for writing_write/)
    await expect(write({ ...loud, storyFile: "river.json" })).rejects.toThrow(/not a story file/)
    await expect(write({ ...loud, storyFile: "../x.twee" })).rejects.toThrow(/outside the project root/)
    expect(readdirSync(join(dir, ".river", "writing", WRITING))).toEqual([])
    expect(disk(KENNEL)).toBe(KENNEL_TWEE)
  })

  it("a refused take creates nothing, not even its folder", async () => {
    await expect(write({ ...loud, edits: [{ op: "delete", passageId: "nope" }] })).rejects.toThrow(/edit 1 of 1 \(delete nope\) failed/)
    await expect(write({ ...loud, caption: undefined })).rejects.toThrow(/a take needs a caption/)
    expect(existsSync(join(dir, ".river", "writing"))).toBe(false)
  })
})

describe("writing_request", () => {
  const at = (n: number) => new Date(Date.UTC(2026, 0, 1, 0, 0, n)).toISOString()

  it("starts a writing job through the launcher and returns its id at once", async () => {
    await ensureBoard(dir, "main")
    const mark = await saveMark(dir, "main", { shape: "pin", path: [0, 0], anchors: [], thread: [{ by: "you", at: at(1), text: "make the yard scene drier" }], madeBy: "you", createdAt: at(1) })
    const launches: JobLaunch[] = []
    const conceptLaunches: JobLaunch[] = []
    const writingJobLauncher = async (l: JobLaunch) => {
      launches.push(l)
      await saveJob(l.root, { id: l.jobId, kind: "writing", markId: l.markId, board: "main", status: "queued", createdAt: at(5) } as Job)
      return { log: "w.log" }
    }
    const list = createRiverTools(project, { author: "claude-code", writingJobLauncher, jobLauncher: async (l) => (conceptLaunches.push(l), { log: "c.log" }) })
    expect(list.find((t) => t.name === "writing_request")!.mutating).toBe(true)

    const r = await call("writing_request", { markId: mark.id }, list)
    const jobId = (r.data as { jobId: string; log: string }).jobId
    expect(jobId).toMatch(/^j_[a-z0-9]{8}$/)
    expect(launches).toEqual([{ root: project.root, board: "main", markId: mark.id, jobId, by: "claude-code", backend: "claude-code", model: "claude-sonnet-5-5" }])
    expect(conceptLaunches).toEqual([])
    expect(r.text).toContain(`Started River writing job ${jobId} for ${mark.id} (claude-code, claude-sonnet-5-5); it is queued. Its log: w.log.`)
    expect(r.text).toContain("The story files do not change until the user keeps a take in River.")
    expect(r.text).toContain("do not reply on it with a status")

    await call("writing_request", { board: "main", markId: mark.id, backend: "api-key", model: "claude-opus-5-5" }, list)
    expect(launches[1]).toMatchObject({ backend: "api-key", model: "claude-opus-5-5" })
    await expect(call("writing_request", { markId: "m_missing" }, list)).rejects.toThrow(/no mark "m_missing" on board main/)
    await call("writing_request", { markId: mark.id, model: "claude-haiku-4-5" }, list)
    expect(launches[2]).toMatchObject({ model: "claude-haiku-4-5" })
    await expect(call("writing_request", { markId: mark.id, model: "--bad" }, list)).rejects.toThrow(/invalid input for writing_request/)
    await expect(call("writing_request", { markId: mark.id, model: "a b" }, list)).rejects.toThrow(/invalid input for writing_request/)
    expect(launches).toHaveLength(3)
  })
})
