import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import path from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { applyJobPaths, commitPaths, createJobWorktree, gitTop, removeJobWorktree } from "../../src/git/worktree"
import { git, initRepo, removeDir, tempDir } from "../project/helpers"

let top: string
beforeEach(() => {
  top = tempDir("river-worktree-")
  initRepo(top)
})
afterEach(() => removeDir(top))

const write = (dir: string, rel: string, data: string | Buffer) => {
  mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true })
  writeFileSync(path.join(dir, rel), data)
}
const read = (dir: string, rel: string) => readFileSync(path.join(dir, rel))

const DRAW = "extends RefCounted\r\n\r\nfunc draw(img: Image) -> void:\n\timg.fill(Color(0.2, 0.3, 0.4))\n"
// Every byte value, so CRLF, NUL and high bytes must survive the binary patch.
const PNG = Buffer.from(Array.from({ length: 512 }, (_, i) => i % 256))

describe("job worktrees", { timeout: 60_000 }, () => {
  it("branches from the user's dirty tree, commits only the given paths, and applies them without touching the index or other files", async () => {
    write(top, "README.md", "readme\n")
    write(top, "game/river.json", "{}\n")
    write(top, "game/stories/a.twee", "one\n")
    git(top, "add", "-A")
    git(top, "commit", "-q", "-m", "init")
    // The user's uncommitted work: an unrelated edit outside the project, a staged edit, an untracked file.
    write(top, "README.md", "readme, edited\n")
    write(top, "game/stories/a.twee", "one, staged\n")
    git(top, "add", "game/stories/a.twee")
    write(top, "game/notes.txt", "untracked\n")
    const head = git(top, "rev-parse", "HEAD")
    const index = git(top, "ls-files", "-s")
    const status = git(top, "status", "--porcelain")

    const game = path.join(top, "game")
    expect(await gitTop(game)).toBe(top)
    const job = await createJobWorktree(game, "j_test0001")
    expect(job.projectSub).toBe("game")
    expect(job.branch).toBe("river/job/j_test0001")
    expect(job.worktree).toBe(path.join(top, ".git", "river", "worktrees", "j_test0001"))
    expect(git(top, "rev-parse", `${job.baseSha}^`)).toBe(head)
    expect(read(job.worktree, "game/stories/a.twee").toString()).toBe("one, staged\n")
    expect(read(job.worktree, "game/notes.txt").toString()).toBe("untracked\n")
    expect(git(top, "status", "--porcelain")).toBe(status)

    write(job.worktree, "game/concepts/k1/draw.gd", DRAW)
    write(job.worktree, "game/concepts/k1/concept.png", PNG)
    write(job.worktree, "game/concepts/k1/scratch.txt", "never committed\n")
    write(job.worktree, "game/stories/a.twee", "an edit that must not travel\n")
    const first = await commitPaths(job.worktree, ["game/concepts/k1/draw.gd"], "river: concept k1")
    expect(first).not.toBe(job.baseSha)
    expect(await commitPaths(job.worktree, ["game/concepts/k1/draw.gd"], "again")).toBe(first)
    const second = await commitPaths(job.worktree, ["game/concepts/k1/concept.png"], "river: render k1")
    expect(git(top, "diff", "--name-only", job.baseSha, second).trim().split("\n").sort()).toEqual(["game/concepts/k1/concept.png", "game/concepts/k1/draw.gd"])

    const files = await applyJobPaths(game, job.baseSha, second, "game/concepts/k1")
    expect(files.sort()).toEqual(["game/concepts/k1/concept.png", "game/concepts/k1/draw.gd"])
    expect(read(top, "game/concepts/k1/draw.gd").toString()).toBe(DRAW)
    expect(read(top, "game/concepts/k1/concept.png").equals(PNG)).toBe(true)
    expect(existsSync(path.join(top, "game/concepts/k1/scratch.txt"))).toBe(false)
    expect(read(top, "game/stories/a.twee").toString()).toBe("one, staged\n")
    expect(read(top, "README.md").toString()).toBe("readme, edited\n")
    expect(git(top, "rev-parse", "HEAD")).toBe(head)
    expect(git(top, "ls-files", "-s")).toBe(index)
    const lines = (text: string) => text.trim().split("\n").sort()
    expect(lines(git(top, "status", "--porcelain"))).toEqual(lines(status + "?? game/concepts/\n"))

    expect((await applyJobPaths(game, job.baseSha, second, "game/concepts/k1")).length).toBe(2)
    expect(read(top, "game/concepts/k1/draw.gd").toString()).toBe(DRAW)

    await removeJobWorktree(game, job.worktree, job.branch)
    expect(existsSync(job.worktree)).toBe(false)
    expect(git(top, "branch", "--list", job.branch)).toBe("")
    await removeJobWorktree(game, job.worktree, job.branch)
  })

  it("works with the project at the top level, refuses a conflicting apply, and guards what it removes", async () => {
    write(top, "river.json", "{}\n")
    git(top, "add", "-A")
    git(top, "commit", "-q", "-m", "init")
    const job = await createJobWorktree(top, "j_test0002")
    expect(job.projectSub).toBe("")
    write(job.worktree, "concepts/k2/draw.gd", DRAW)
    const sha = await commitPaths(job.worktree, ["concepts/k2/draw.gd"], "river: concept k2")

    write(top, "concepts/k2/draw.gd", "the user's own file\n")
    await expect(applyJobPaths(top, job.baseSha, sha, "concepts/k2")).rejects.toThrow(/apply/)
    expect(read(top, "concepts/k2/draw.gd").toString()).toBe("the user's own file\n")

    await expect(removeJobWorktree(top, job.worktree, "main")).rejects.toThrow(/not a River job branch/)
    await expect(removeJobWorktree(top, top, job.branch)).rejects.toThrow(/not a River job worktree/)
    expect(existsSync(path.join(top, "river.json"))).toBe(true)

    removeDir(job.worktree)
    await removeJobWorktree(top, job.worktree, job.branch)
    expect(git(top, "worktree", "list", "--porcelain")).not.toContain("j_test0002")
    expect(git(top, "branch", "--list", job.branch)).toBe("")
  })
})
