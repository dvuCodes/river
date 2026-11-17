import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import path from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { checkpoint, currentRev, listCheckpoints, restoreCheckpoint } from "../../src/git/checkpoint"
import { git, initRepo, removeDir, tempDir } from "./helpers"

let root: string
beforeEach(() => {
  root = tempDir()
  initRepo(root)
})
afterEach(() => removeDir(root))

const write = (rel: string, text: string) => {
  mkdirSync(path.dirname(path.join(root, rel)), { recursive: true })
  writeFileSync(path.join(root, rel), text)
}
const read = (rel: string) => readFileSync(path.join(root, rel), "utf8")

describe("git checkpoints", { timeout: 30_000 }, () => {
  it("snapshots and restores the working tree without touching HEAD, the index or ignored files", async () => {
    write(".gitignore", "ignored/\n*.log\n")
    write("a.txt", "a1\n")
    write("dir/b.txt", "b1\nline two\n")
    write("gone.txt", "will be deleted\n")
    git(root, "add", "-A")
    git(root, "commit", "-q", "-m", "init")
    // State at checkpoint: a staged change, an unstaged change, an untracked file, ignored files.
    write("a.txt", "a2 staged\n")
    git(root, "add", "a.txt")
    write("dir/b.txt", "b2 unstaged\n")
    write("untracked-then.txt", "u\n")
    write("ignored/cache.bin", "cache1")
    write("debug.log", "log1")

    const head = git(root, "rev-parse", "HEAD").trim()
    const branch = git(root, "symbolic-ref", "HEAD").trim()
    const index = git(root, "ls-files", "-s")
    const status = git(root, "status", "--porcelain")

    const cp = await checkpoint(root, "before edit")
    expect(cp.ref).toBe("refs/river/checkpoints/1")
    expect(cp.label).toBe("before edit")
    expect(new Date(cp.at).toISOString()).toBe(cp.at)
    // Taking a checkpoint changed nothing visible.
    expect(git(root, "rev-parse", "HEAD").trim()).toBe(head)
    expect(git(root, "ls-files", "-s")).toBe(index)
    expect(git(root, "status", "--porcelain")).toBe(status)
    expect(git(root, "rev-parse", `${cp.sha}^`).trim()).toBe(head)
    const treeFiles = git(root, "ls-tree", "-r", "--name-only", cp.sha).trim().split("\n").sort()
    expect(treeFiles).toEqual([".gitignore", "a.txt", "dir/b.txt", "gone.txt", "untracked-then.txt"])

    // Now mess the tree up: modify a tracked file, add an untracked file, delete files, touch ignored files.
    write("a.txt", "a3 changed\n")
    write("dir/b.txt", "b3\r\nCRLF\r\n")
    write("new/deep/untracked-now.txt", "new\n")
    rmSync(path.join(root, "gone.txt"))
    rmSync(path.join(root, "untracked-then.txt"))
    write("ignored/cache.bin", "cache2")
    write("ignored/extra.bin", "extra")

    const cp2 = await checkpoint(root, "after edit")
    expect(cp2.ref).toBe("refs/river/checkpoints/2")
    const list = await listCheckpoints(root)
    expect(list.map((c) => [c.ref, c.label, c.sha])).toEqual([
      [cp2.ref, "after edit", cp2.sha],
      [cp.ref, "before edit", cp.sha],
    ])

    await restoreCheckpoint(root, cp.ref)

    expect(read("a.txt")).toBe("a2 staged\n")
    expect(read("dir/b.txt")).toBe("b2 unstaged\n")
    expect(read("gone.txt")).toBe("will be deleted\n")
    expect(read("untracked-then.txt")).toBe("u\n")
    expect(existsSync(path.join(root, "new/deep/untracked-now.txt"))).toBe(false)
    expect(existsSync(path.join(root, "new"))).toBe(false)
    // Ignored files are not part of checkpoints and are left alone.
    expect(read("ignored/cache.bin")).toBe("cache2")
    expect(read("ignored/extra.bin")).toBe("extra")
    expect(read("debug.log")).toBe("log1")
    // HEAD, branch and the real index are unchanged; status is back to what it was.
    expect(git(root, "rev-parse", "HEAD").trim()).toBe(head)
    expect(git(root, "symbolic-ref", "HEAD").trim()).toBe(branch)
    expect(git(root, "ls-files", "-s")).toBe(index)
    expect(git(root, "status", "--porcelain")).toBe(status)

    // And forward again to the second checkpoint.
    await restoreCheckpoint(root, cp2.ref)
    expect(read("dir/b.txt")).toBe("b3\r\nCRLF\r\n")
    expect(read("new/deep/untracked-now.txt")).toBe("new\n")
    expect(existsSync(path.join(root, "gone.txt"))).toBe(false)
  })

  it("restores the game files and keeps River's own data in .river/ as it is now, at the repo top or in a subfolder", async () => {
    for (const sub of ["", "game"]) {
      const at = (rel: string) => (sub ? `${sub}/${rel}` : rel)
      const dir = path.join(root, sub)
      write(at("story.twee"), "then\n")
      write(at(".river/review/t_old.json"), '{"text":"then"}\n')
      write(at(".river/boards/main/cards/c_old.json"), "{}\n")
      const cp = await checkpoint(dir, `with .river at ${sub || "the top"}`)

      write(at("story.twee"), "now\n")
      write(at("added.twee"), "added\n")
      write(at(".river/review/t_old.json"), '{"text":"now"}\n')
      write(at(".river/review/t_new.json"), "{}\n")
      write(at(".river/plans/p_new.json"), "{}\n")
      rmSync(path.join(dir, ".river/boards/main/cards/c_old.json"))
      await restoreCheckpoint(dir, cp.ref)

      expect(read(at("story.twee"))).toBe("then\n")
      expect(existsSync(path.join(dir, "added.twee"))).toBe(false)
      expect(read(at(".river/review/t_old.json"))).toBe('{"text":"now"}\n')
      expect(existsSync(path.join(dir, ".river/review/t_new.json"))).toBe(true)
      expect(existsSync(path.join(dir, ".river/plans/p_new.json"))).toBe(true)
      expect(existsSync(path.join(dir, ".river/boards/main/cards/c_old.json"))).toBe(false)
    }
  })

  it("works in a repo with no commits, and rejects foreign refs", async () => {
    write("only.txt", "x\n")
    const cp = await checkpoint(root, "first")
    expect(await currentRev(root)).toBe("unborn+dirty")
    write("only.txt", "y\n")
    write("more.txt", "z\n")
    await restoreCheckpoint(root, cp.ref)
    expect(read("only.txt")).toBe("x\n")
    expect(existsSync(path.join(root, "more.txt"))).toBe(false)
    await expect(restoreCheckpoint(root, "refs/heads/main")).rejects.toThrow(/not a river checkpoint ref/)
    await expect(restoreCheckpoint(root, "refs/river/checkpoints/99")).rejects.toThrow(/no checkpoint/)
  })

  it("numbers checkpoints past 9 and lists them newest first", async () => {
    write("f.txt", "0\n")
    for (let i = 1; i <= 11; i++) await checkpoint(root, `cp ${i}`)
    const list = await listCheckpoints(root)
    expect(list.map((c) => c.label)).toEqual(Array.from({ length: 11 }, (_, i) => `cp ${11 - i}`))
    expect(list[0]!.ref).toBe("refs/river/checkpoints/11")
  }, 60_000)

  it("currentRev is the short HEAD plus +dirty when the tree changed", async () => {
    write("f.txt", "1\n")
    git(root, "add", "-A")
    git(root, "commit", "-q", "-m", "c")
    const short = git(root, "rev-parse", "--short", "HEAD").trim()
    expect(await currentRev(root)).toBe(short)
    write("g.txt", "untracked\n")
    expect(await currentRev(root)).toBe(`${short}+dirty`)
  })
})
