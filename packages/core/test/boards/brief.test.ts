import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import path from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { addTurnedDown, readBrief } from "../../src/boards/brief"
import { removeDir, tempDir } from "../project/helpers"

let root: string
beforeEach(() => {
  root = tempDir("river-brief-")
})
afterEach(() => removeDir(root))

const brief = () => readFileSync(path.join(root, ".river", "brief.md"), "utf8")

describe("project brief", () => {
  it("is undefined until written, and a dismiss reason starts the turned-down section", async () => {
    expect(await readBrief(root)).toBeUndefined()
    await addTurnedDown(root, "j_1", "too dark,\n  needs more light")
    expect(brief()).toBe("## Things the user turned down\n\n- too dark, needs more light (j_1)\n")
    expect(await readBrief(root)).toContain("too dark")
  })

  it("adds under the existing heading, keeps the user's later sections, and adds each job once", async () => {
    mkdirSync(path.join(root, ".river"))
    writeFileSync(path.join(root, ".river", "brief.md"), "# Game\n\nWarm palette.\n\n## Things the user turned down\n\n- neon (j_0)\n\n## Later\n\nkeep me\n")
    await addTurnedDown(root, "j_1", "cartoon genie")
    await addTurnedDown(root, "j_1", "cartoon genie")
    expect(brief()).toBe("# Game\n\nWarm palette.\n\n## Things the user turned down\n\n- neon (j_0)\n- cartoon genie (j_1)\n\n## Later\n\nkeep me\n")
  })
})
