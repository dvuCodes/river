import { execFile } from "node:child_process"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"

/** Byte-exact git: never convert line endings on the way in or out. */
export const RAW = ["-c", "core.autocrlf=false", "-c", "core.eol=lf", "-c", "core.safecrlf=false"]

export interface GitOptions {
  env?: NodeJS.ProcessEnv
  /** Written to git's stdin. */
  input?: string | Buffer
}

function run<T extends string | Buffer>(root: string, args: string[], opts: GitOptions, encoding: "utf8" | "buffer"): Promise<T> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      "git",
      args,
      { cwd: root, env: { ...process.env, ...opts.env }, maxBuffer: 256 * 1024 * 1024, windowsHide: true, encoding },
      (err, stdout, stderr) => {
        if (err) {
          return reject(new Error(`git ${args.join(" ")} failed in ${root}: ${String(stderr || err.message).trim()}`))
        }
        resolve(stdout as T)
      },
    )
    if (opts.input !== undefined) child.stdin!.end(opts.input)
  })
}

export function git(root: string, args: string[], opts: GitOptions = {}): Promise<string> {
  return run<string>(root, args, opts, "utf8")
}

/** Like git(), but stdout as bytes (blobs, binary patches). */
export function gitBytes(root: string, args: string[], opts: GitOptions = {}): Promise<Buffer> {
  return run<Buffer>(root, args, opts, "buffer")
}

/** Like git(), but resolves to null when git exits non-zero. */
export function gitTry(root: string, args: string[], opts: GitOptions = {}): Promise<string | null> {
  return git(root, args, opts).catch(() => null)
}

/** identityEnv per resolved root: two `git config` runs per commit add up over a job's many commits. */
const identityCache = new Map<string, Promise<NodeJS.ProcessEnv>>()

/** Forget cached identities (after the user sets user.name or user.email, and in tests). */
export function clearIdentityCache(): void {
  identityCache.clear()
}

/**
 * Identity for commit-tree when the repo has none configured (River's commits are local only). Cached per
 * resolved root for the life of the process; `clearIdentityCache` drops it.
 */
export async function identityEnv(root: string): Promise<NodeJS.ProcessEnv> {
  const key = path.resolve(root)
  let pending = identityCache.get(key)
  if (!pending) {
    pending = (async () => {
      const env: NodeJS.ProcessEnv = {}
      const [name, email] = await Promise.all([gitTry(root, ["config", "--get", "user.name"]), gitTry(root, ["config", "--get", "user.email"])])
      if (!name?.trim() && !process.env.GIT_AUTHOR_NAME) env.GIT_AUTHOR_NAME = env.GIT_COMMITTER_NAME = "river"
      if (!email?.trim() && !process.env.GIT_AUTHOR_EMAIL) env.GIT_AUTHOR_EMAIL = env.GIT_COMMITTER_EMAIL = "river@localhost"
      return env
    })()
    identityCache.set(key, pending)
    pending.catch(() => identityCache.delete(key))
  }
  return { ...(await pending) }
}

/** Run `fn` with a throwaway index file outside the working tree, so the user's index is never touched. */
export async function withTempIndex<T>(fn: (env: NodeJS.ProcessEnv) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(path.join(tmpdir(), "river-index-"))
  try {
    return await fn({ GIT_INDEX_FILE: path.join(dir, "index") })
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}
