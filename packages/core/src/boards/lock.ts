/**
 * A lock file per thing that is read, changed and written back by more than one process (a mark, the
 * brief). The app, the CLI, River's job runners and every agent's river-mcp write the same files, and a
 * rename makes each write atomic but not each read-modify-write. Locks live in .river/locks/, apart from
 * the board folders the app watches.
 */
import { randomBytes } from "node:crypto"
import { mkdir, open, readFile, rm, stat } from "node:fs/promises"
import { hostname } from "node:os"
import path from "node:path"

/** A lock older than this was left by a process that died; a holder only reads and writes one small file. */
const LOCK_STALE_MS = 30_000
const LOCK_WAIT_MS = 15_000

interface LockOwner {
  pid: number
  host: string
  token: string
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
/** Windows reports a file another process is creating or deleting as EPERM, EBUSY or EACCES. */
const TRANSIENT = new Set(["ENOENT", "EPERM", "EBUSY", "EACCES"])

export function markLockFile(workspaceRoot: string, board: string, markId: string): string {
  return path.join(workspaceRoot, ".river", "locks", "marks", board, `${markId}.lock`)
}

export const briefLockFile = (workspaceRoot: string) => path.join(workspaceRoot, ".river", "locks", "brief.lock")

export const voiceLockFile = (workspaceRoot: string) => path.join(workspaceRoot, ".river", "locks", "voice.lock")

async function readOwner(file: string): Promise<{ text: string; owner?: LockOwner; ageMs: number } | undefined> {
  try {
    const [text, info] = await Promise.all([readFile(file, "utf8"), stat(file)])
    let owner: LockOwner | undefined
    try {
      owner = JSON.parse(text) as LockOwner
    } catch {
      // Created but not written yet, or torn: only its age can say it is stale.
    }
    return { text, ...(owner ? { owner } : {}), ageMs: Date.now() - info.mtimeMs }
  } catch (err) {
    // Gone, or (Windows) being deleted by its holder right now: either way, try to create it again.
    if (TRANSIENT.has((err as NodeJS.ErrnoException).code ?? "")) return undefined
    throw err
  }
}

function deadOnThisHost(owner: LockOwner | undefined): boolean {
  if (!owner || owner.host !== hostname() || typeof owner.pid !== "number") return false
  try {
    process.kill(owner.pid, 0)
    return false
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "ESRCH"
  }
}

/**
 * Remove a stale lock. Only the waiter that creates `<lock>.takeover` may remove it, and only while it still
 * holds what was judged stale, so two waiters never both remove a lock and then both create one. The caller
 * then competes for the lock like everyone else.
 */
async function takeOver(file: string, seen: string): Promise<void> {
  const guard = `${file}.takeover`
  try {
    await (await open(guard, "wx")).close()
  } catch {
    // Another waiter is taking over. A guard left by a waiter that died is old: clear it for the next round.
    const age = await stat(guard).then((s) => Date.now() - s.mtimeMs).catch(() => 0)
    if (age > LOCK_STALE_MS) await rm(guard, { force: true }).catch(() => undefined)
    return
  }
  try {
    const now = await readFile(file, "utf8").catch(() => undefined)
    if (now === seen) await rm(file, { force: true })
  } finally {
    await rm(guard, { force: true }).catch(() => undefined)
  }
}

/**
 * Run `fn` holding the lock file `file`, created with O_EXCL. Waits up to 15 s for another holder.
 * Not reentrant: `fn` must not take the same lock again.
 */
export async function withLock<T>(file: string, what: string, fn: () => Promise<T>): Promise<T> {
  await mkdir(path.dirname(file), { recursive: true })
  const me: LockOwner = { pid: process.pid, host: hostname(), token: randomBytes(8).toString("hex") }
  const until = Date.now() + LOCK_WAIT_MS
  for (let attempt = 0; ; attempt++) {
    try {
      const handle = await open(file, "wx")
      try {
        await handle.writeFile(JSON.stringify(me))
      } finally {
        await handle.close()
      }
      break
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code
      if (code !== "EEXIST" && !TRANSIENT.has(code ?? "")) throw err
      const held = code === "EEXIST" ? await readOwner(file) : undefined
      if (held && (held.ageMs > LOCK_STALE_MS || deadOnThisHost(held.owner))) {
        await takeOver(file, held.text)
        continue
      }
      if (Date.now() > until) throw new Error(`river: ${what} is busy (another process holds ${file}); try again`)
      await sleep(4 + Math.min(attempt, 10) * 4 + Math.random() * 8)
    }
  }
  try {
    return await fn()
  } finally {
    const held = await readOwner(file).catch(() => undefined)
    if (held?.owner?.token === me.token) await rm(file, { force: true }).catch(() => undefined)
  }
}
