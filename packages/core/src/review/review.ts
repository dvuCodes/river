import { lstatSync, realpathSync } from "node:fs"
import { mkdir, readdir } from "node:fs/promises"
import path from "node:path"
import picomatch from "picomatch"
import { DEFAULT_EDITABLE } from "../project/project"
import type { ChangePlan, Project, ReviewStatus, ReviewThread } from "../project/types"
import { assertSafeId, newId, readJson, writeJsonAtomic } from "./store"

const STATUSES: ReviewStatus[] = ["open", "planned", "accepted", "done", "wontfix"]
const PLAN_STATUSES: ChangePlan["status"][] = ["draft", "approved", "rejected", "implemented"]

const reviewDir = (p: Project) => path.join(p.root, ".river", "review")
const plansDir = (p: Project) => path.join(p.root, ".river", "plans")

function threadFile(p: Project, shotId: string): string {
  assertSafeId("shot", shotId)
  return path.join(reviewDir(p), `${shotId}.json`)
}

function planFile(p: Project, planId: string): string {
  assertSafeId("plan", planId)
  return path.join(plansDir(p), `${planId}.json`)
}

async function jsonFilesIn(dir: string): Promise<string[]> {
  try {
    const names = await readdir(dir)
    return names.filter((n) => n.endsWith(".json") && !n.startsWith(".")).sort()
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return []
    throw err
  }
}

async function readThreads(file: string): Promise<ReviewThread[]> {
  const data = await readJson<unknown>(file, [])
  if (!Array.isArray(data)) throw new Error(`river: ${file} is not a JSON array of threads`)
  return data as ReviewThread[]
}

async function writeThreads(p: Project, shotId: string, threads: ReviewThread[]): Promise<void> {
  await mkdir(reviewDir(p), { recursive: true })
  await writeJsonAtomic(threadFile(p, shotId), threads)
}

/** Find a thread by id across all shot files. */
async function findThread(p: Project, threadId: string): Promise<{ shotId: string; threads: ReviewThread[]; thread: ReviewThread }> {
  for (const name of await jsonFilesIn(reviewDir(p))) {
    const threads = await readThreads(path.join(reviewDir(p), name))
    const thread = threads.find((t) => t.id === threadId)
    if (thread) return { shotId: name.slice(0, -".json".length), threads, thread }
  }
  throw new Error(`river: no review thread ${threadId}`)
}

/** Threads from .river/review/*.json. With shotId, only that shot. */
export async function listThreads(project: Project, shotId?: string): Promise<ReviewThread[]> {
  if (shotId !== undefined) return readThreads(threadFile(project, shotId))
  const out: ReviewThread[] = []
  for (const name of await jsonFilesIn(reviewDir(project))) {
    out.push(...(await readThreads(path.join(reviewDir(project), name))))
  }
  return out
}

export async function addThread(project: Project, target: ReviewThread["target"], author: string, text: string): Promise<ReviewThread> {
  const file = threadFile(project, target.shotId)
  const threads = await readThreads(file)
  const thread: ReviewThread = {
    id: newId("t_"),
    target: { ...target },
    status: "open",
    messages: [{ author, at: new Date().toISOString(), text }],
  }
  threads.push(thread)
  await writeThreads(project, target.shotId, threads)
  return thread
}

export async function reply(project: Project, threadId: string, author: string, text: string): Promise<ReviewThread> {
  const { shotId, threads, thread } = await findThread(project, threadId)
  thread.messages.push({ author, at: new Date().toISOString(), text })
  await writeThreads(project, shotId, threads)
  return thread
}

export async function setStatus(project: Project, threadId: string, status: ReviewStatus): Promise<ReviewThread> {
  if (!STATUSES.includes(status)) throw new Error(`river: invalid thread status ${JSON.stringify(status)}`)
  const { shotId, threads, thread } = await findThread(project, threadId)
  thread.status = status
  await writeThreads(project, shotId, threads)
  return thread
}

/**
 * Save a plan to .river/plans/<id>.json. A new plan has status "draft". Links it to its thread and sets the thread to "planned".
 * Saving over an existing id always resets it to "draft" (and drops approvedAt), so changed steps need a fresh approval.
 */
export async function savePlan(project: Project, plan: Omit<ChangePlan, "id" | "status" | "createdAt"> & { id?: string }): Promise<ChangePlan> {
  const id = plan.id ?? newId("p_")
  const file = planFile(project, id)
  const { approvedAt: _dropped, ...rest } = plan
  const saved: ChangePlan = { ...rest, id, status: "draft", createdAt: new Date().toISOString() }
  const linked = saved.threadId !== undefined ? await findThread(project, saved.threadId) : undefined
  await mkdir(plansDir(project), { recursive: true })
  await writeJsonAtomic(file, saved)
  if (linked) {
    linked.thread.planId = id
    linked.thread.status = "planned"
    await writeThreads(project, linked.shotId, linked.threads)
  }
  return saved
}

export async function loadPlan(project: Project, planId: string): Promise<ChangePlan> {
  const plan = await readJson<ChangePlan | undefined>(planFile(project, planId), undefined)
  if (!plan) throw new Error(`river: no change plan ${planId}`)
  return plan
}

export async function listPlans(project: Project): Promise<ChangePlan[]> {
  const out: ChangePlan[] = []
  for (const name of await jsonFilesIn(plansDir(project))) {
    out.push(await loadPlan(project, name.slice(0, -".json".length)))
  }
  return out
}

export async function setPlanStatus(project: Project, planId: string, status: ChangePlan["status"]): Promise<ChangePlan> {
  if (!PLAN_STATUSES.includes(status)) throw new Error(`river: invalid plan status ${JSON.stringify(status)}`)
  const plan = await loadPlan(project, planId)
  plan.status = status
  if (status === "approved") plan.approvedAt = new Date().toISOString()
  await writeJsonAtomic(planFile(project, planId), plan)
  return plan
}

const WINDOWS = process.platform === "win32"

/**
 * Normalise a root-relative path to "a/b/c" form. Returns undefined when it is absolute,
 * drive-relative, empty, has a NUL, or has a ".." segment.
 */
export function normalizeRel(rel: string): string | undefined {
  if (typeof rel !== "string" || rel.length === 0 || rel.includes("\0")) return undefined
  const slashed = rel.replace(/\\/g, "/")
  if (slashed.startsWith("/") || /^[A-Za-z]:/.test(slashed) || path.isAbsolute(rel)) return undefined
  const parts: string[] = []
  for (const seg of slashed.split("/")) {
    if (seg === "" || seg === ".") continue
    if (seg === "..") return undefined
    parts.push(seg)
  }
  return parts.length > 0 ? parts.join("/") : undefined
}

const sameRel = (a: string, b: string) => (WINDOWS ? a.toLowerCase() === b.toLowerCase() : a === b)

/** True when `child` is `parent` or inside it (both absolute). */
function isInside(parent: string, child: string): boolean {
  const r = path.relative(WINDOWS ? parent.toLowerCase() : parent, WINDOWS ? child.toLowerCase() : child)
  return r === "" || (!r.startsWith("..") && !path.isAbsolute(r))
}

function lexists(p: string): boolean {
  try {
    lstatSync(p)
    return true
  } catch {
    return false
  }
}

/**
 * The implementer guard. Throws unless the plan is "approved", the file is one of the plan steps,
 * the file is inside the root, and it matches the manifest editable globs.
 */
export function assertEditAllowed(project: Project, plan: ChangePlan, rel: string): void {
  const deny = (why: string): never => {
    throw new Error(`river: edit of ${JSON.stringify(rel)} denied: ${why}`)
  }
  if (plan.status !== "approved") deny(`plan ${plan.id} is ${plan.status}, not approved`)

  const file = normalizeRel(rel) ?? deny("path must be relative to the project root, without '..'")

  const listed = (plan.steps ?? []).some((s) => {
    const stepFile = normalizeRel(s.file)
    return stepFile !== undefined && sameRel(stepFile, file)
  })
  if (!listed) deny(`plan ${plan.id} does not name this file in its steps`)

  const root = path.resolve(project.root)
  const target = path.resolve(root, file)
  if (!isInside(root, target)) deny("path resolves outside the project root")

  const globs = project.manifest.editable ?? DEFAULT_EDITABLE
  if (globs.length === 0 || !picomatch.isMatch(file, globs, { dot: true, nocase: WINDOWS })) {
    deny(`not matched by editable globs ${JSON.stringify(globs)}`)
  }

  // Symlink / junction escape: realpath the deepest existing ancestor (the file may not exist yet).
  let realRoot = ""
  try {
    realRoot = realpathSync.native(root)
  } catch {
    deny("project root does not exist")
  }
  let probe = target
  while (!lexists(probe)) {
    const parent = path.dirname(probe)
    if (parent === probe) break
    probe = parent
  }
  let realProbe = ""
  try {
    realProbe = realpathSync.native(probe)
  } catch {
    deny("path goes through a broken link")
  }
  if (!isInside(realRoot, realProbe)) deny("path escapes the project root through a link")
}
