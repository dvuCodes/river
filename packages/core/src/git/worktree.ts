import { access, mkdir, readdir, readFile, rm, rmdir, writeFile } from "node:fs/promises"
import path from "node:path"
import { assertConceptFile, conceptPath } from "../concepts/concepts"
import { safePath } from "../project/project"
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
  // Every job call, not only those that move refs: even a temporary index write runs post-index-change.
  const hooksOff = ["-c", `core.hooksPath=${noHooks}`]
  return {
    common,
    worktrees: path.join(common, "river", "worktrees"),
    hooksOff,
    git: (args: string[], opts?: GitOptions) => git(dir, [...hooksOff, ...args], opts),
  }
}

/**
 * Snapshot the user's working tree (uncommitted edits included) and check it out on a new branch
 * in a worktree inside the git common dir, where neither the game nor `git add` can see it.
 */
export async function createJobWorktree(workspaceRoot: string, jobId: string): Promise<JobWorktree> {
  const branch = jobBranch(jobId)
  const projectSub = (await git(workspaceRoot, ["rev-parse", "--show-prefix"])).trim().replace(/\/$/, "")
  const repo = await riverGit(workspaceRoot)
  // The branch keeps the snapshot alive, so no checkpoint ref lists job bases among the user's checkpoints.
  const baseSha = await snapshotCommit(workspaceRoot, `job ${jobId}`, repo.hooksOff)
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
  const head = (await repo.git(["rev-parse", "--verify", "-q", `${ref}^{commit}`])).trim()
  const blob = (await repo.git(["hash-object", "-w", "--no-filters", "--stdin"], { input: bytes })).trim()
  const tree = await withTempIndex(async (env) => {
    await repo.git(["read-tree", head], { env })
    await repo.git(["update-index", "--add", "--cacheinfo", `100644,${blob},${file}`], { env })
    return (await repo.git(["write-tree"], { env })).trim()
  })
  if (tree === (await repo.git(["rev-parse", `${head}^{tree}`])).trim()) return head
  const sha = (await repo.git(["commit-tree", tree, "-p", head, "-m", message], { env: await identityEnv(dir) })).trim()
  await repo.git(["update-ref", "-m", message, ref, sha, head])
  return sha
}

/** The bytes of `file` (relative to the git top level) in commit `sha`, exactly as stored. Works from any checkout of the repo. */
export async function readCommittedFile(dir: string, sha: string, file: string): Promise<Buffer> {
  return gitBytes(dir, ["cat-file", "blob", `${sha}:${file}`])
}

const exists = (file: string) => access(file).then(
  () => true,
  () => false,
)

const COMMIT_ID = /^[0-9a-f]{40}([0-9a-f]{24})?$/

/**
 * Write the files `names` of concepts/<conceptId>/ (under `projectRoot`) in commit `sha` into the user's working
 * tree as the committed bytes, so no .gitattributes filter or line-ending rule can change them, and the index
 * stays as it is. The commit and the job file that names it may come from a cloned repo, so nothing in them is
 * trusted: each name must be a plain file name the agent could have written there, the project's place in the
 * repo comes from git, every listed entry must be exactly one of those files, and each target must resolve
 * inside the project (no link out of it). Only creates files: one that is already there must hold the same
 * bytes, which makes a second run a no-op. On any failure it removes the files and folders it created and
 * throws. Returns undo(), which removes them later, for when the step after this fails.
 */
export async function applyJobFiles(projectRoot: string, sha: string, conceptId: string, names: readonly string[]): Promise<() => Promise<void>> {
  if (names.length === 0) throw new Error("river: no job files to apply")
  if (!COMMIT_ID.test(sha)) throw new Error(`river: refused: ${JSON.stringify(sha)} is not a commit id`)
  const wanted = names.map((name) => {
    if (name.includes("/") || name.includes("\\")) throw new Error(`river: refused: ${JSON.stringify(name)} is not a file name`)
    return assertConceptFile(conceptId, conceptPath(conceptId, name))
  })
  const top = await gitTop(projectRoot)
  const prefix = (await git(projectRoot, ["rev-parse", "--show-prefix"])).trim()
  const pathspecs = wanted.map((rel) => prefix + rel)
  const listing = await git(top, ["--literal-pathspecs", "-c", "core.quotepath=false", "ls-tree", "-r", "-z", "--full-tree", sha, "--", ...pathspecs])
  const files: { file: string; abs: string; bytes: Buffer }[] = []
  for (const entry of listing.split("\0").filter(Boolean)) {
    const tab = entry.indexOf("\t")
    const [mode, type, object] = entry.slice(0, tab).split(" ")
    const file = entry.slice(tab + 1)
    if (!pathspecs.includes(file)) throw new Error(`river: refused: ${JSON.stringify(file)} on the job branch is not one of the files to apply`)
    if (type !== "blob" || (mode !== "100644" && mode !== "100755")) throw new Error(`river: ${file} on the job branch is not a plain file`)
    const abs = safePath({ root: projectRoot }, file.slice(prefix.length))
    files.push({ file, abs, bytes: await gitBytes(top, ["cat-file", "blob", object!]) })
  }
  const missing = pathspecs.filter((p) => !files.some((f) => f.file === p))
  if (missing.length > 0) throw new Error(`river: ${missing.join(", ")} ${missing.length === 1 ? "is" : "are"} not on the job branch`)
  const created: string[] = []
  const madeDirs: string[] = []
  const undo = async () => {
    for (const abs of created) await rm(abs, { force: true })
    for (const dir of madeDirs.sort((a, b) => b.length - a.length)) await rmdir(dir).catch(() => {})
  }
  try {
    for (const { file, abs, bytes } of files) {
      for (let dir = path.dirname(abs); dir !== path.dirname(dir) && !(await exists(dir)); dir = path.dirname(dir)) madeDirs.push(dir)
      await mkdir(path.dirname(abs), { recursive: true })
      try {
        await writeFile(abs, bytes, { flag: "wx" })
        created.push(abs)
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err
        if (!(await readFile(abs)).equals(bytes)) throw new Error(`river: ${file} is already in your project with other content; move it away, then accept again`)
      }
    }
    for (const { file, abs, bytes } of files) {
      if (!(await readFile(abs)).equals(bytes)) throw new Error(`river: ${file} did not arrive byte for byte`)
    }
  } catch (err) {
    await undo()
    throw err
  }
  return undo
}

/** Ids of the jobs that still have a branch. */
export async function listJobBranches(dir: string): Promise<string[]> {
  const out = await gitTry(dir, ["for-each-ref", "--format=%(refname:lstrip=4)", "refs/heads/river/job/"])
  return (out ?? "").split(/\r?\n/).filter(Boolean)
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
