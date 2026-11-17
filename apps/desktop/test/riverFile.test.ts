import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { riverFilePath } from "../src/main/riverFile"

let base: string
let root: string
beforeEach(() => {
  base = realpathSync.native(mkdtempSync(path.join(tmpdir(), "river-file-")))
  root = path.join(base, "game")
  mkdirSync(path.join(root, "shots"), { recursive: true })
  writeFileSync(path.join(root, "shots", "a.png"), "png")
  mkdirSync(path.join(base, "outside"))
  writeFileSync(path.join(base, "outside", "secret.txt"), "secret")
})
afterEach(() => rmSync(base, { recursive: true, force: true, maxRetries: 3 }))

const url = (rel: string) => `river-file://project/${rel}`

describe("riverFilePath", () => {
  it("serves files inside the project", () => {
    expect(riverFilePath({ root }, url("shots/a.png"))).toBe(path.join(root, "shots", "a.png"))
    expect(riverFilePath({ root }, url("shots/new%20file.png"))).toBe(path.join(root, "shots", "new file.png"))
  })

  it("refuses the root, other hosts, escapes and absolute paths", () => {
    for (const u of [url(""), "river-file://other/shots/a.png", url("shots%2F..%2F..%2Foutside%2Fsecret.txt"), url("C:/Windows/win.ini"), url("%E0%A4%A")]) {
      expect(riverFilePath({ root }, u), u).toBeNull()
    }
  })

  it("refuses a file reached through a link inside the project that points out of it", () => {
    symlinkSync(path.join(base, "outside"), path.join(root, "linked"), "junction")
    expect(riverFilePath({ root }, url("linked/secret.txt"))).toBeNull()
  })
})
