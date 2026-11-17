import { execFile } from "node:child_process"
import { mkdtemp, readdir, rm, rmdir } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"

/** A snapshot of the working tree, kept under refs/river/checkpoints/<n>. Branch history is not changed. */
export interface Checkpoint {
  ref: string
  sha: string
  label: string
  /** ISO time. */
  at: string
}

const REF_PREFIX = "refs/river/checkpoints/"
const MESSAGE_PREFIX = "river checkpoint: "
/** Byte-exact snapshots: never convert line endings on the way in or out. */
const RAW = ["-c", "core.autocrlf=false", "-c", "core.eol=lf", "-c", "core.safecrlf=false"]

interface GitOptions {
  env?: NodeJS.ProcessEnv
}

function git(root: string, args: string[], opts: GitOptions = {}): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      "git",
      args,
      { cwd: root, env: { ...process.env, ...opts.env }, maxBuffer: 256 * 1024 * 1024, windowsHide: true, encoding: "utf8" },
      (err, stdout, stderr) => {
        if (err) {
          return reject(new Error(`git ${args.join(" ")} failed in ${root}: ${String(stderr || err.message).trim()}`))
        }
        resolve(stdout)
      },
    )
  })
}

/** Like git(), but resolves to null when git exits non-zero. */
function gitTry(root: string, args: string[], opts: GitOptions = {}): Promise<string | null> {
  return git(root, args, opts).catch(() => null)
}

async function hasHead(root: string): Promise<boolean> {
  return (await gitTry(root, ["rev-parse", "--verify", "-q", "HEAD^{commit}"])) !== null
}

/** Run `fn` with a throwaway index file outside the working tree. */
async function withTempIndex<T>(fn: (env: NodeJS.ProcessEnv) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(path.join(tmpdir(), "river-index-"))
  try {
    return await fn({ GIT_INDEX_FILE: path.join(dir, "index") })
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

/** Write a tree object of the current working tree (tracked + untracked, not ignored) without touching the real index. */
async function snapshotTree(root: string, head?: boolean): Promise<string> {
  head ??= await hasHead(root)
  return withTempIndex(async (env) => {
    if (head) await git(root, ["read-tree", "HEAD"], { env })
    await git(root, [...RAW, "add", "-A", "--", "."], { env })
    return (await git(root, ["write-tree"], { env })).trim()
  })
}

/** Identity for commit-tree when the repo has none configured (checkpoint refs are local only). */
async function identityEnv(root: string): Promise<NodeJS.ProcessEnv> {
  const env: NodeJS.ProcessEnv = {}
  const name = await gitTry(root, ["config", "--get", "user.name"])
  const email = await gitTry(root, ["config", "--get", "user.email"])
  if (!name?.trim() && !process.env.GIT_AUTHOR_NAME) env.GIT_AUTHOR_NAME = env.GIT_COMMITTER_NAME = "river"
  if (!email?.trim() && !process.env.GIT_AUTHOR_EMAIL) env.GIT_AUTHOR_EMAIL = env.GIT_COMMITTER_EMAIL = "river@localhost"
  return env
}

function refNumber(ref: string): number {
  return Number(ref.slice(REF_PREFIX.length))
}

/** Snapshot tracked and untracked (not ignored) files without changing the working tree or the index. */
export async function checkpoint(root: string, label: string): Promise<Checkpoint> {
  const head = await hasHead(root)
  const tree = await snapshotTree(root, head)
  const parents = head ? ["-p", "HEAD"] : []
  const message = MESSAGE_PREFIX + label
  const sha = (await git(root, ["commit-tree", tree, ...parents, "-m", message], { env: await identityEnv(root) })).trim()
  const existing = await listCheckpoints(root)
  const n = existing.reduce((max, c) => Math.max(max, refNumber(c.ref)), 0) + 1
  const ref = REF_PREFIX + n
  // Empty old value: fail rather than overwrite if another process took this number meanwhile.
  await git(root, ["update-ref", ref, sha, ""])
  const at = new Date((await git(root, ["show", "-s", "--format=%cI", sha])).trim()).toISOString()
  return { ref, sha, label, at }
}

export async function listCheckpoints(root: string): Promise<Checkpoint[]> {
  const out = await git(root, ["for-each-ref", "--format=%(refname)%1f%(objectname)%1f%(committerdate:iso-strict)%1f%(contents)%1e", REF_PREFIX])
  const list: Checkpoint[] = []
  for (const record of out.split("\x1e")) {
    const fields = record.replace(/^\r?\n/, "").split("\x1f")
    if (fields.length < 4) continue
    const [ref, sha, at, contents] = fields as [string, string, string, string]
    if (!Number.isInteger(refNumber(ref))) continue
    const message = contents.replace(/\s+$/, "")
    const label = message.startsWith(MESSAGE_PREFIX) ? message.slice(MESSAGE_PREFIX.length) : message
    list.push({ ref, sha, label, at: new Date(at).toISOString() })
  }
  return list.sort((a, b) => refNumber(b.ref) - refNumber(a.ref))
}

/** Paths (posix, root-relative) of all blobs in a tree. */
async function treeFiles(root: string, tree: string): Promise<string[]> {
  const out = await git(root, ["-c", "core.quotepath=false", "ls-tree", "-r", "-z", "--name-only", tree])
  return out.split("\0").filter(Boolean)
}

async function removeEmptyParents(root: string, file: string): Promise<void> {
  let dir = path.dirname(file)
  while (dir !== root && dir.startsWith(root)) {
    try {
      if ((await readdir(dir)).length > 0) return
      await rmdir(dir)
    } catch {
      return
    }
    dir = path.dirname(dir)
  }
}

/** Restore the working tree files to the checkpoint. Files created after it are removed. */
export async function restoreCheckpoint(root: string, ref: string): Promise<void> {
  if (!ref.startsWith(REF_PREFIX) || !/^\d+$/.test(ref.slice(REF_PREFIX.length))) {
    throw new Error(`river: ${JSON.stringify(ref)} is not a river checkpoint ref`)
  }
  const sha = (await gitTry(root, ["rev-parse", "--verify", "-q", `${ref}^{commit}`]))?.trim()
  if (!sha) throw new Error(`river: no checkpoint ${ref}`)

  // Work out what to delete before writing anything (the checkpoint may change .gitignore).
  const nowFiles = await treeFiles(root, await snapshotTree(root))
  const thenFiles = new Set(await treeFiles(root, `${sha}^{tree}`))
  const added = nowFiles.filter((f) => !thenFiles.has(f))

  for (const rel of added) {
    const abs = path.join(root, rel)
    await rm(abs, { force: true })
    await removeEmptyParents(path.resolve(root), path.resolve(abs))
  }

  await withTempIndex(async (env) => {
    await git(root, ["read-tree", sha], { env })
    await git(root, [...RAW, "checkout-index", "-a", "-f"], { env })
  })
}

/** Short SHA of HEAD, plus "+dirty" when the tree has changes. A repo with no commits gives "unborn". */
export async function currentRev(root: string): Promise<string> {
  const sha = (await gitTry(root, ["rev-parse", "--short", "HEAD"]))?.trim() || "unborn"
  const status = await git(root, ["--no-optional-locks", "status", "--porcelain"])
  return status.trim().length > 0 ? `${sha}+dirty` : sha
}
