import { mkdir, readdir, readFile, rm } from "node:fs/promises"
import path from "node:path"
import { snapshotCommit } from "./checkpoint"
import { git, gitBytes, gitTry, identityEnv, RAW, withTempIndex, type GitOptions } from "./exec"

/** Where a job works: its own branch and worktree, started from a snapshot of the user's tree. */
export interface JobWorktree {
  baseSha: string
  /** river/job/<jobId> */
  branch: string
  /** Absolute path of the worktree's top level when it was made: <git common dir>/river/worktrees/<jobId>. */
  worktree: string
  /** The project root relative to the git top level, with forward slashes ("" at the top). */
  projectSub: string
}

const SAFE_JOB_ID = /^[A-Za-z0-9_-]{1,64}$/

function jobBranch(jobId: string): string {
  if (typeof jobId !== "string" || !SAFE_JOB_ID.test(jobId)) throw new Error(`river: invalid job id ${JSON.stringify(jobId)}`)
  return `river/job/${jobId}`
}

/** The git top level that holds `dir`. */
export async function gitTop(dir: string): Promise<string> {
  return path.resolve((await git(dir, ["rev-parse", "--show-toplevel"])).trim())
}

/**
 * River's places in the repo that holds `dir`, worked out from where the repo is now (an absolute
 * path saved earlier goes stale when the user moves the folder), and git with the user's hooks off.
 */
async function riverGit(dir: string) {
  const common = path.resolve((await git(dir, ["rev-parse", "--path-format=absolute", "--git-common-dir"])).trim())
  const noHooks = path.join(common, "river", "no-hooks")
  await mkdir(noHooks, { recursive: true })
  return {
    common,
    worktrees: path.join(common, "river", "worktrees"),
    git: (args: string[], opts?: GitOptions) => git(dir, ["-c", `core.hooksPath=${noHooks}`, ...args], opts),
  }
}

/**
 * Snapshot the user's working tree (uncommitted edits included) and check it out on a new branch
 * in a worktree inside the git common dir, where neither the game nor `git add` can see it.
 */
export async function createJobWorktree(workspaceRoot: string, jobId: string): Promise<JobWorktree> {
  const branch = jobBranch(jobId)
  const projectSub = (await git(workspaceRoot, ["rev-parse", "--show-prefix"])).trim().replace(/\/$/, "")
  // The branch keeps the snapshot alive, so no checkpoint ref lists job bases among the user's checkpoints.
  const baseSha = await snapshotCommit(workspaceRoot, `job ${jobId}`)
  const repo = await riverGit(workspaceRoot)
  const worktree = path.join(repo.worktrees, jobId)
  await mkdir(repo.worktrees, { recursive: true })
  await repo.git([...RAW, "worktree", "add", "-q", "-b", branch, worktree, baseSha])
  return { baseSha, branch, worktree, projectSub }
}

/**
 * Commit `bytes` as `file` (relative to the git top level) on top of the job's branch, byte for byte:
 * no filters, no hooks and no worktree, so it works from any checkout of the repo, wherever it has
 * moved. Returns the new tip, or the current one when the file already holds these bytes.
 */
export async function commitJobFile(dir: string, jobId: string, file: string, bytes: Buffer, message: string): Promise<string> {
  const ref = `refs/heads/${jobBranch(jobId)}`
  const repo = await riverGit(dir)
  const head = (await git(dir, ["rev-parse", "--verify", "-q", `${ref}^{commit}`])).trim()
  const blob = (await git(dir, ["hash-object", "-w", "--no-filters", "--stdin"], { input: bytes })).trim()
  const tree = await withTempIndex(async (env) => {
    await git(dir, ["read-tree", head], { env })
    await git(dir, ["update-index", "--add", "--cacheinfo", `100644,${blob},${file}`], { env })
    return (await git(dir, ["write-tree"], { env })).trim()
  })
  if (tree === (await git(dir, ["rev-parse", `${head}^{tree}`])).trim()) return head
  const sha = (await git(dir, ["commit-tree", tree, "-p", head, "-m", message], { env: await identityEnv(dir) })).trim()
  await repo.git(["update-ref", "-m", message, ref, sha, head])
  return sha
}

/** The bytes of `file` (relative to the git top level) in commit `sha`, exactly as stored. Works from any checkout of the repo. */
export async function readCommittedFile(dir: string, sha: string, file: string): Promise<Buffer> {
  return gitBytes(dir, ["cat-file", "blob", `${sha}:${file}`])
}

/** True when every file already has headSha's content in the working tree (an earlier apply finished). */
async function alreadyApplied(top: string, headSha: string, files: string[]): Promise<boolean> {
  for (const f of files) {
    const want = await gitTry(top, ["rev-parse", "--verify", "-q", `${headSha}:${f}`])
    const have = await gitTry(top, [...RAW, "hash-object", "--", f])
    if (!want || !have || want.trim() !== have.trim()) return false
  }
  return true
}

/**
 * Apply baseSha..headSha, limited to `pathPrefix` (relative to the git top level), onto the user's
 * working tree. Plain `git apply` (never --3way, which stages into the user's index), so the index
 * and every other file stay as they are. Returns the changed files. Running it again is a no-op.
 */
export async function applyJobPaths(workspaceRoot: string, baseSha: string, headSha: string, pathPrefix: string): Promise<string[]> {
  const top = await gitTop(workspaceRoot)
  const range = [baseSha, headSha, "--", pathPrefix]
  const names = await git(top, ["-c", "core.quotepath=false", "diff", "--name-only", "-z", "--no-renames", "--no-relative", ...range])
  const files = names.split("\0").filter(Boolean)
  if (files.length === 0 || (await alreadyApplied(top, headSha, files))) return files
  const patch = await gitBytes(top, [
    ...RAW, "diff", "--binary", "--full-index", "--no-color", "--no-ext-diff", "--no-textconv", "--no-renames", "--no-relative",
    "--src-prefix=a/", "--dst-prefix=b/", ...range,
  ])
  const apply = [...RAW, "apply", "--whitespace=nowarn"]
  await git(top, [...apply, "--check", "-"], { input: patch })
  await git(top, [...apply, "-"], { input: patch })
  return files
}

/**
 * Remove a job's worktree folder, git's record of it and its branch, found from the job id in the repo
 * as it is now. Missing pieces are fine, so it can run again after a partial run. Other worktrees,
 * the user's included, are left alone.
 */
export async function removeJobWorktree(dir: string, jobId: string): Promise<void> {
  const branch = jobBranch(jobId)
  const repo = await riverGit(dir)
  await rm(path.join(repo.worktrees, jobId), { recursive: true, force: true, maxRetries: 3 })
  // After a move git's record still names the old path, so it is found by the branch it has checked out.
  const records = path.join(repo.common, "worktrees")
  for (const name of await readdir(records).catch(() => [])) {
    const head = await readFile(path.join(records, name, "HEAD"), "utf8").catch(() => "")
    if (head.trim() === `ref: refs/heads/${branch}`) await rm(path.join(records, name), { recursive: true, force: true, maxRetries: 3 })
  }
  if (await gitTry(dir, ["rev-parse", "--verify", "-q", `refs/heads/${branch}`])) await repo.git(["branch", "-D", branch])
}
