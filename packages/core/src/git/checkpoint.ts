import { readdir, rm, rmdir } from "node:fs/promises"
import path from "node:path"
import { git, gitTry, identityEnv, RAW, withTempIndex } from "./exec"

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

async function hasHead(root: string): Promise<boolean> {
  return (await gitTry(root, ["rev-parse", "--verify", "-q", "HEAD^{commit}"])) !== null
}

/**
 * Write a tree object of the current working tree (tracked + untracked, not ignored) without touching
 * the real index. `config` goes before each git command.
 */
async function snapshotTree(root: string, head?: boolean, config: string[] = []): Promise<string> {
  head ??= await hasHead(root)
  return withTempIndex(async (env) => {
    if (head) await git(root, [...config, "read-tree", "HEAD"], { env })
    await git(root, [...config, ...RAW, "add", "-A", "--", "."], { env })
    return (await git(root, [...config, "write-tree"], { env })).trim()
  })
}

function refNumber(ref: string): number {
  return Number(ref.slice(REF_PREFIX.length))
}

/**
 * A commit of the working tree (tracked and untracked, not ignored) on top of HEAD, without changing
 * the working tree or the index. Nothing refers to it yet: the caller keeps it with a ref or branch.
 * `config` goes before each git command (a job passes core.hooksPath so the user's hooks stay off).
 */
export async function snapshotCommit(root: string, label: string, config: string[] = []): Promise<string> {
  const head = await hasHead(root)
  const tree = await snapshotTree(root, head, config)
  const parents = head ? ["-p", "HEAD"] : []
  return (await git(root, [...config, "commit-tree", tree, ...parents, "-m", MESSAGE_PREFIX + label], { env: await identityEnv(root) })).trim()
}

/** Snapshot tracked and untracked (not ignored) files without changing the working tree or the index. */
export async function checkpoint(root: string, label: string): Promise<Checkpoint> {
  const sha = await snapshotCommit(root, label)
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
