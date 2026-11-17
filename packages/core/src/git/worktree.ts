import { mkdir, rm } from "node:fs/promises"
import path from "node:path"
import { checkpoint } from "./checkpoint"
import { git, gitBytes, gitTry, identityEnv, RAW } from "./exec"

/** Where a job works: its own branch and worktree, started from a checkpoint of the user's tree. */
export interface JobWorktree {
  baseSha: string
  /** river/job/<jobId> */
  branch: string
  /** Absolute path of the worktree's top level: <git common dir>/river/worktrees/<jobId>. */
  worktree: string
  /** The project root relative to the git top level, with forward slashes ("" at the top). */
  projectSub: string
}

const BRANCH_PREFIX = "river/job/"

/** The git top level that holds `dir`. */
export async function gitTop(dir: string): Promise<string> {
  return path.resolve((await git(dir, ["rev-parse", "--show-toplevel"])).trim())
}

async function worktreesDir(dir: string): Promise<string> {
  const common = (await git(dir, ["rev-parse", "--path-format=absolute", "--git-common-dir"])).trim()
  return path.join(path.resolve(common), "river", "worktrees")
}

/**
 * Checkpoint the user's working tree (uncommitted edits included) and check it out on a new branch
 * in a worktree inside the git common dir, where neither the game nor `git add` can see it.
 */
export async function createJobWorktree(workspaceRoot: string, jobId: string): Promise<JobWorktree> {
  const projectSub = (await git(workspaceRoot, ["rev-parse", "--show-prefix"])).trim().replace(/\/$/, "")
  const { sha: baseSha } = await checkpoint(workspaceRoot, `job ${jobId}`)
  const branch = BRANCH_PREFIX + jobId
  const worktree = path.join(await worktreesDir(workspaceRoot), jobId)
  await mkdir(path.dirname(worktree), { recursive: true })
  await git(workspaceRoot, [...RAW, "worktree", "add", "-q", "-b", branch, worktree, baseSha])
  return { baseSha, branch, worktree, projectSub }
}

/**
 * Commit exactly `paths` (relative to the worktree's top level) on the worktree's branch, with
 * plumbing so the user's hooks never run. Returns the new HEAD, or the current one when nothing changed.
 */
export async function commitPaths(worktree: string, paths: string[], message: string): Promise<string> {
  // -f: a .gitignore rule in the user's repo must not stop River from recording the job's own files.
  await git(worktree, [...RAW, "add", "-f", "-A", "--", ...paths])
  const head = (await git(worktree, ["rev-parse", "HEAD"])).trim()
  const tree = (await git(worktree, ["write-tree"])).trim()
  if (tree === (await git(worktree, ["rev-parse", "HEAD^{tree}"])).trim()) return head
  const sha = (await git(worktree, ["commit-tree", tree, "-p", head, "-m", message], { env: await identityEnv(worktree) })).trim()
  await git(worktree, ["update-ref", "-m", message, "HEAD", sha, head])
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

/** Remove a job's worktree and branch. Missing ones are fine. Refuses paths and branches that are not River's. */
export async function removeJobWorktree(workspaceRoot: string, worktree: string, branch: string): Promise<void> {
  if (branch && !branch.startsWith(BRANCH_PREFIX)) throw new Error(`river: ${branch} is not a River job branch`)
  if (worktree) {
    const rel = path.relative(await worktreesDir(workspaceRoot), path.resolve(worktree))
    if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) throw new Error(`river: ${worktree} is not a River job worktree`)
    await gitTry(workspaceRoot, ["worktree", "remove", "--force", worktree])
    await rm(worktree, { recursive: true, force: true, maxRetries: 3 })
  }
  await git(workspaceRoot, ["worktree", "prune"])
  if (branch && (await gitTry(workspaceRoot, ["rev-parse", "--verify", "-q", `refs/heads/${branch}`]))) {
    await git(workspaceRoot, ["branch", "-D", branch])
  }
}
