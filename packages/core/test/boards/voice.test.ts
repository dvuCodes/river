import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import path from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { countOpenMarks, ensureBoard, loadBoard, markFile, openMarks, saveCard, saveMark } from "../../src/boards/boards"
import { RESERVED_AUTHORS, WRITER_ROLE, jobKind } from "../../src/boards/types"
import { CUT_HEADING, LANDED_HEADING, addVoiceCut, addVoiceExemplar, readVoice, voicePath, voiceSection } from "../../src/boards/voice"
import { checkpoint, listCheckpoints, pruneCheckpoints } from "../../src/git/checkpoint"
import { clearIdentityCache, identityEnv } from "../../src/git/exec"
import { mapLimit } from "../../src/util/map-limit"
import { git, initRepo, removeDir, tempDir } from "../project/helpers"

let root: string
beforeEach(() => {
  root = tempDir("river-voice-")
})
afterEach(() => removeDir(root))

const voice = () => readFileSync(voicePath(root), "utf8")

describe("voice bible", () => {
  it("is undefined until written, then each line lands under its own heading once", async () => {
    expect(await readVoice(root)).toBeUndefined()
    expect(await addVoiceExemplar(root, "j_1/a", "Rex  leans\n on you.")).toBe(true)
    expect(await addVoiceCut(root, "j_1/b", "The dog was very happy.")).toBe(true)
    expect(await addVoiceExemplar(root, "j_2/a", "Ducks. Many ducks.")).toBe(true)
    expect(await addVoiceExemplar(root, "j_1/a", "again")).toBe(false)
    expect(voice()).toBe(`${LANDED_HEADING}\n\n- Rex leans on you. (j_1/a)\n- Ducks. Many ducks. (j_2/a)\n\n${CUT_HEADING}\n\n- The dog was very happy. (j_1/b)\n`)
    expect(voiceSection(voice(), LANDED_HEADING)).toEqual(["Rex leans on you. (j_1/a)", "Ducks. Many ducks. (j_2/a)"])
    // The same key may still be cut once: dedupe is per section.
    expect(await addVoiceCut(root, "j_1/a", "on second thought")).toBe(true)
  })

  it("keeps the user's text and sections, and their CRLF line endings", async () => {
    mkdirSync(path.join(root, ".river"))
    writeFileSync(voicePath(root), `# Voice\r\n\r\nDry, short.\r\n\r\n${CUT_HEADING}\r\n\r\n- purple prose (j_0)\r\n\r\n## Later\r\n\r\nkeep me\r\n`)
    await addVoiceCut(root, "j_1", "it was a dark and stormy night")
    await addVoiceExemplar(root, "j_2", "Rex sneezes.")
    expect(voice()).toBe(
      `# Voice\r\n\r\nDry, short.\r\n\r\n${CUT_HEADING}\r\n\r\n- purple prose (j_0)\r\n- it was a dark and stormy night (j_1)\r\n\r\n## Later\r\n\r\nkeep me\r\n\r\n${LANDED_HEADING}\r\n\r\n- Rex sneezes. (j_2)\r\n`,
    )
  })

  it("serialises concurrent appends", async () => {
    await Promise.all(Array.from({ length: 8 }, (_, i) => addVoiceExemplar(root, `k${i}`, `line ${i}`)))
    expect(voiceSection(voice(), LANDED_HEADING).sort()).toEqual(Array.from({ length: 8 }, (_, i) => `line ${i} (k${i})`).sort())
  })

  it("matches keys only at the end of a bullet so prose containing (key) does not collide", async () => {
    expect(await addVoiceExemplar(root, "j_0", "Step (1) is to breathe.")).toBe(true)
    expect(await addVoiceExemplar(root, "1", "Short line.")).toBe(true)
    expect(await addVoiceExemplar(root, "1", "Duplicate key.")).toBe(false)
    expect(voiceSection(voice(), LANDED_HEADING)).toEqual(["Step (1) is to breathe. (j_0)", "Short line. (1)"])
  })
})

describe("board helpers", () => {
  it("countOpenMarks reads only marks and agrees with openMarks", async () => {
    await ensureBoard(root, "main")
    const pen = { shape: "pen" as const, path: [0, 0, 1, 1], anchors: [], thread: [], madeBy: "you" }
    await saveMark(root, "main", pen)
    await saveMark(root, "main", pen)
    await saveMark(root, "main", { ...pen, status: "answered" })
    await saveCard(root, "main", { kind: "note", ref: "", x: 0, y: 0, w: 100, text: "hi", madeBy: "you" })
    // A broken card must not matter: countOpenMarks never reads cards.
    writeFileSync(path.join(root, ".river", "boards", "main", "cards", "broken.json"), "{")
    writeFileSync(markFile(root, "main", "bad"), "{")
    expect(await countOpenMarks(root, "main")).toBe(2)
    expect(openMarks(await loadBoard(root, "main")).length).toBe(2)
    expect(await countOpenMarks(root, "nothing_here")).toBe(0)
  })

  it("names the writer role as River's own and defaults job kinds to concept", () => {
    expect(WRITER_ROLE).toBe("story-writer")
    expect(RESERVED_AUTHORS).toContain(WRITER_ROLE)
    expect(jobKind({})).toBe("concept")
    expect(jobKind({ kind: "writing" })).toBe("writing")
  })

  it("mapLimit keeps input order, bounds concurrency and rethrows", async () => {
    let running = 0
    let peak = 0
    const out = await mapLimit([5, 1, 4, 2, 3], 2, async (n, i) => {
      running++
      peak = Math.max(peak, running)
      await new Promise((r) => setTimeout(r, n * 2))
      running--
      return n * 10 + i
    })
    expect(out).toEqual([50, 11, 42, 23, 34])
    expect(peak).toBe(2)
    await expect(mapLimit([1, 2], 4, async (n) => { if (n === 2) throw new Error("boom"); return n })).rejects.toThrow("boom")
    expect(await mapLimit([], 4, async () => 1)).toEqual([])
  })
})

describe("git", { timeout: 30_000 }, () => {
  it("pruneCheckpoints keeps the newest refs and deletes the rest", async () => {
    initRepo(root)
    writeFileSync(path.join(root, "a.txt"), "1")
    git(root, "add", "-A")
    git(root, "commit", "-q", "-m", "init")
    for (let i = 1; i <= 4; i++) {
      writeFileSync(path.join(root, "a.txt"), String(i))
      await checkpoint(root, `cp ${i}`)
    }
    await expect(pruneCheckpoints(root, -1)).rejects.toThrow(/whole number/)
    await expect(pruneCheckpoints(root, Number.NaN)).rejects.toThrow(/whole number/)
    const removed = await pruneCheckpoints(root, 2)
    expect(removed.map((c) => c.label)).toEqual(["cp 2", "cp 1"])
    expect((await listCheckpoints(root)).map((c) => c.label)).toEqual(["cp 4", "cp 3"])
    expect(await pruneCheckpoints(root, 5)).toEqual([])
    // Numbering continues past the pruned refs.
    const next = await checkpoint(root, "cp 5")
    expect(next.ref).toBe("refs/river/checkpoints/5")
    expect((await pruneCheckpoints(root, 0)).length).toBe(3)
    expect(await listCheckpoints(root)).toEqual([])
  })

  it("identityEnv is cached per root and handed out as a copy", async () => {
    initRepo(root)
    clearIdentityCache()
    const a = await identityEnv(root)
    expect(a).toEqual({})
    a.GIT_AUTHOR_NAME = "changed"
    // An empty local name hides any global one, and counts as no name.
    git(root, "config", "user.name", "")
    // Cached: the config change is not seen until the cache is cleared.
    expect(await identityEnv(root)).toEqual({})
    clearIdentityCache()
    if (!process.env.GIT_AUTHOR_NAME) expect((await identityEnv(root)).GIT_AUTHOR_NAME).toBe("river")
  })
})
