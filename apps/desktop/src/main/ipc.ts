import { randomUUID } from "node:crypto"
import { mkdir } from "node:fs/promises"
import { userInfo } from "node:os"
import { isAbsolute, join, relative, resolve, sep } from "node:path"
import { type BrowserWindow, dialog, ipcMain } from "electron"
import type { AgentEvent, AgentTurnRequest, ClaudeCodeStatus, JobDeps, PermissionDecision } from "@river/agent"
import { createGodotAdapter } from "@river/adapter-godot"
import {
  type Capture,
  type ChangePlan,
  type GameState,
  type Playtest,
  type Project,
  type ReviewStatus,
  type ReviewThread,
  type StateSchema,
  type Story,
  addThread,
  captureShot,
  contentPassages,
  createPlaytest,
  evalCond,
  formatCond,
  lint,
  listCaptures,
  listPlans,
  listStories,
  listThreads,
  loadJob,
  loadProject,
  loadSchema,
  loadStory,
  openChoices,
  paths,
  renamePassage,
  reply,
  resolveTarget,
  restoreCheckpoint,
  safePath,
  saveStory,
  setPassagePositions,
  setPlanStatus,
  setStatus,
  updatePassageText,
  writeTwee3,
} from "@river/core"
import type {
  AgentPrefsUpdate,
  AgentStartRequest,
  AgentStatus,
  CaptureDTO,
  FramesDTO,
  JobDTO,
  OpenStateDTO,
  PathDTO,
  PlaySnapshot,
  ProjectInfo,
  StoryDTO,
} from "../shared/api"
import { type JobApi, loadAgent } from "./agent"
import { passageDTO, storyDTO } from "./dto"
import * as settings from "./settings"
import { boardHandlers } from "./board"
import { type ProjectWatch, noteOwnWrite, watchProject } from "./watch"

let project: Project | null = null
let projectError: { root: string; message: string } | null = null
let projectWatch: ProjectWatch | null = null
let getWindow: () => BrowserWindow | null = () => null

export function currentProject(): Project | null {
  return project
}

const send = (channel: string, payload: unknown) => {
  const win = getWindow()
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload)
}

function need(): Project {
  if (!project) throw new Error("No project is open.")
  return project
}

/** Open a project folder (the one with river.json). Remembers it unless `remember` is false. */
export async function openProject(root: string, remember = true): Promise<void> {
  const abs = resolve(root)
  await projectWatch?.stop()
  projectWatch = null
  try {
    project = await loadProject(abs)
    projectError = null
    if (remember) settings.setLastProject(project.root)
    projectWatch = watchProject(project, (changes) => send("fs:change", changes))
    const opened = project.root
    // Fails only jobs whose owning process is gone, so a job this app or the CLI is running survives a re-open.
    void loadAgent()
      .then((a) => a.jobs?.recoverJobs(opened))
      .catch((err: unknown) => console.warn("river: could not recover jobs", err))
  } catch (err) {
    project = null
    projectError = { root: abs, message: err instanceof Error ? err.message : String(err) }
  }
}

async function projectInfo(): Promise<ProjectInfo | null> {
  if (!project) {
    return projectError ? { root: projectError.root, name: "", engine: "", stories: [], shots: [], error: projectError.message } : null
  }
  return {
    root: project.root,
    name: project.manifest.name,
    engine: project.manifest.engine,
    stories: await listStories(project),
    shots: project.manifest.shots,
  }
}

async function readStory(rel: string): Promise<{ story: Story; schema: StateSchema; dto: () => Promise<StoryDTO> }> {
  const p = need()
  const [{ story, diagnostics }, schema] = await Promise.all([loadStory(p, rel), loadSchema(p)])
  return {
    story,
    schema,
    dto: async () => storyDTO(story, [...diagnostics, ...lint(story, schema)], schema),
  }
}

const storyWritten = new Set<(rel: string) => void>()

/** Call `cb` after River writes a story file (used by smoke mode). Returns an unsubscribe function. */
export function onStoryWritten(cb: (rel: string) => void): () => void {
  storyWritten.add(cb)
  return () => storyWritten.delete(cb)
}

/** Write a story file, telling the watcher first so it does not report River's own write as an outside change. */
async function writeStory(rel: string, story: Story): Promise<void> {
  const p = need()
  noteOwnWrite(safePath(p, rel), writeTwee3(story))
  await saveStory(p, rel, story)
  for (const cb of storyWritten) cb(rel)
}

async function storyAfterWrite(rel: string, story: Story): Promise<StoryDTO> {
  await writeStory(rel, story)
  return (await readStory(rel)).dto()
}

// ---- playtest sessions live here; the Playtest object holds closures and cannot cross IPC.
const sessions = new Map<string, { pt: Playtest; story: Story }>()

function snapshot(sessionId: string): PlaySnapshot {
  const s = sessions.get(sessionId)
  if (!s) throw new Error("This playtest has ended. Start it again.")
  const { pt, story } = s
  const byId = new Map(story.passages.map((p) => [p.id, p]))
  const history = pt.history()
  return {
    sessionId,
    passage: passageDTO(story, pt.current()),
    choices: pt.choices().map(({ choice, open }) => ({
      label: choice.label,
      target: choice.target,
      open,
      broken: !resolveTarget(story, choice.target),
      ...(choice.when ? { when: formatCond(choice.when) } : {}),
    })),
    state: pt.state(),
    history: history.map((h) => byId.get(h.passageId)?.name ?? h.passageId),
    isOver: pt.isOver(),
    canUndo: history.length > 1,
  }
}

// ---- frames
function fileUrl(p: Project, abs: string): string {
  const rel = relative(p.root, abs)
  return "river-file://project/" + rel.split(sep).map(encodeURIComponent).join("/")
}

function captureDTO(p: Project, c: Capture): CaptureDTO {
  return { shotId: c.shotId, rev: c.rev, at: c.at, urls: c.files.map((f) => fileUrl(p, f)) }
}

/** Resolve a river-file:// URL to an absolute path inside the project root, or null if it escapes. */
export function resolveRiverFile(url: string): string | null {
  if (!project) return null
  const u = new URL(url)
  if (u.host !== "project") return null
  const rel = decodeURIComponent(u.pathname).replace(/^\/+/, "")
  const abs = resolve(project.root, rel)
  const back = relative(project.root, abs)
  if (!back || back.startsWith("..") || isAbsolute(back)) return null
  return abs
}

const author = () => {
  try {
    return userInfo().username || "you"
  } catch {
    return "you"
  }
}

// ---- agent turns
const turns = new Map<string, AbortController>()
const pendingPermissions = new Map<string, (d: PermissionDecision) => void>()

/** Last `claude auth status` result (allowlisted fields only; never written to disk). */
let claudeCache: ClaudeCodeStatus | null = null
let claudeCheck: Promise<ClaudeCodeStatus | null> | undefined
const CLAUDE_STATUS_TIMEOUT_MS = 20_000

async function claudeStatus(refresh: boolean): Promise<ClaudeCodeStatus | null> {
  if (claudeCache && !refresh) return claudeCache
  claudeCheck ??= (async () => {
    const agent = await loadAgent()
    if (!agent.claudeStatus) return null
    const timeout = new Promise<null>((r) => setTimeout(() => r(null), CLAUDE_STATUS_TIMEOUT_MS))
    const s = await Promise.race([agent.claudeStatus(settings.getAgentPrefs().claudePath).catch(() => null), timeout])
    if (s) claudeCache = s
    return claudeCache
  })().finally(() => {
    claudeCheck = undefined
  })
  return claudeCheck
}

async function agentStatus(refreshClaude = false): Promise<AgentStatus> {
  const agent = await loadAgent()
  const prefs = settings.getAgentPrefs()
  const claudeCode = await claudeStatus(refreshClaude)
  const fallback = claudeCode?.installed && claudeCode.loggedIn ? "claude-code" : "api-key"
  return {
    available: Boolean(agent.start),
    ...(agent.reason ? { reason: agent.reason } : {}),
    hasKey: settings.hasApiKey(),
    encryptionAvailable: await settings.encryptionAvailable(),
    backend: prefs.backend ?? fallback,
    backendChosen: prefs.backend !== undefined,
    model: prefs.model,
    ...(prefs.claudePath ? { claudePath: prefs.claudePath } : {}),
    claudeCode,
  }
}

type TurnAuth = Pick<AgentTurnRequest, "backend" | "apiKey" | "claudePath">

async function turnAuth(status: AgentStatus): Promise<TurnAuth> {
  if (status.backend === "api-key") {
    const apiKey = await settings.getApiKey()
    if (!apiKey) throw new Error("Add an Anthropic API key in Settings first.")
    return { backend: "api-key", apiKey }
  }
  return { backend: "claude-code", ...(status.claudePath ? { claudePath: status.claudePath } : {}) }
}

async function jobApi(): Promise<JobApi> {
  const agent = await loadAgent()
  if (!agent.jobs) throw new Error(agent.jobsReason ?? "Concept jobs are unavailable.")
  return agent.jobs
}

/** `jobDeps` goes to startConceptJob as its deps (smoke mode passes a fake agent turn). */
export function registerIpc(windowGetter: () => BrowserWindow | null, opts: { jobDeps?: JobDeps } = {}): void {
  getWindow = windowGetter
  const handle = <A extends unknown[], R>(channel: string, fn: (...args: A) => Promise<R> | R) =>
    ipcMain.handle(channel, (_e, ...args) => fn(...(args as A)))

  handle("project:get", () => projectInfo())
  handle("project:pick", async () => {
    const win = getWindow()
    const opts = { title: "Open a River project (the folder with river.json)", properties: ["openDirectory" as const] }
    const res = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts)
    const dir = res.filePaths[0]
    if (res.canceled || !dir) return projectInfo()
    await openProject(dir)
    sessions.clear()
    return projectInfo()
  })

  handle("story:load", async (rel: string) => (await readStory(rel)).dto())
  handle("story:savePassage", async (rel: string, id: string, raw: string) => {
    const { story } = await readStory(rel)
    return storyAfterWrite(rel, updatePassageText(story, id, raw))
  })
  handle("story:rename", async (rel: string, id: string, name: string) => {
    const trimmed = name.trim()
    if (!trimmed) throw new Error("A passage name cannot be empty.")
    const { story } = await readStory(rel)
    return storyAfterWrite(rel, renamePassage(story, id, trimmed))
  })
  handle("story:savePositions", async (rel: string, positions: Record<string, [number, number]>) => {
    const { story } = await loadStory(need(), rel)
    const next = setPassagePositions(story, positions)
    if (next !== story) await writeStory(rel, next)
  })
  handle("story:paths", async (rel: string): Promise<PathDTO[]> => {
    const { story, schema } = await readStory(rel)
    return paths(story, schema).map((r) => ({
      steps: r.steps,
      end: r.end,
      satisfiable: r.satisfiable,
      conditions: r.conditions.map(formatCond),
    }))
  })
  handle("story:openState", async (rel: string, state: GameState): Promise<OpenStateDTO> => {
    const { story } = await readStory(rel)
    const out: OpenStateDTO = { passages: {}, choices: {} }
    for (const p of contentPassages(story)) {
      out.passages[p.id] = p.when ? evalCond(p.when, state) : true
      out.choices[p.id] = openChoices(p, state).map((c) => c.open)
    }
    return out
  })

  handle("play:start", async (rel: string, from?: string) => {
    const { story, schema } = await readStory(rel)
    const pt = createPlaytest(story, schema, from !== undefined ? { from } : undefined)
    const id = randomUUID()
    sessions.set(id, { pt, story })
    if (sessions.size > 20) sessions.delete(sessions.keys().next().value as string)
    return snapshot(id)
  })
  handle("play:choose", (id: string, index: number) => {
    sessions.get(id)?.pt.choose(index)
    return snapshot(id)
  })
  handle("play:undo", (id: string) => {
    sessions.get(id)?.pt.undo()
    return snapshot(id)
  })
  handle("play:setVar", (id: string, name: string, value: number | string | boolean) => {
    sessions.get(id)?.pt.setVar(name, value)
    return snapshot(id)
  })

  handle("frames:get", async (): Promise<FramesDTO> => {
    const p = need()
    const shots = await Promise.all(
      p.manifest.shots.map(async (s) => ({ ...s, captures: (await listCaptures(p, s.id)).map((c) => captureDTO(p, c)) })),
    )
    const [threads, plans] = await Promise.all([listThreads(p), listPlans(p)])
    return { engine: p.manifest.engine, canCapture: p.manifest.engine === "godot", shots, threads, plans }
  })
  handle("frames:capture", async (shotId: string) => {
    const p = need()
    if (p.manifest.engine !== "godot") throw new Error(`Engine "${p.manifest.engine}" has no capture adapter.`)
    return captureDTO(p, await captureShot(p, shotId, createGodotAdapter()))
  })
  handle("review:add", (target: ReviewThread["target"], text: string) => addThread(need(), target, author(), text))
  handle("review:reply", (threadId: string, text: string) => reply(need(), threadId, author(), text))
  handle("review:status", (threadId: string, status: ReviewStatus) => setStatus(need(), threadId, status))
  handle("plan:status", (planId: string, status: ChangePlan["status"]) => setPlanStatus(need(), planId, status))

  for (const [channel, fn] of Object.entries(boardHandlers(need, (dir) => projectWatch?.add(dir), getWindow))) {
    handle(channel, fn as (...args: unknown[]) => Promise<unknown>)
  }

  handle("agent:status", () => agentStatus())
  handle("agent:refreshStatus", () => agentStatus(true))
  handle("settings:setAgentPrefs", (p: AgentPrefsUpdate) => {
    settings.setAgentPrefs(p)
    // A new claude path needs a new status check.
    return agentStatus(p.claudePath !== undefined)
  })
  handle("claude:signIn", async () => {
    const agent = await loadAgent()
    if (!agent.claudeSignIn) throw new Error(agent.reason ?? "The agent is unavailable.")
    await agent.claudeSignIn(settings.getAgentPrefs().claudePath)
  })
  handle("settings:setKey", async (key: string) => {
    await settings.setApiKey(key)
    return agentStatus()
  })
  handle("settings:clearKey", () => {
    settings.clearApiKey()
    return agentStatus()
  })
  handle("agent:start", async (req: AgentStartRequest) => {
    const p = need()
    const agent = await loadAgent()
    if (!agent.start) throw new Error(agent.reason ?? "The agent is unavailable.")
    const status = await agentStatus()
    const { turnId, ...turn } = req
    const auth = await turnAuth(status)
    // The model picker is per turn; remember the last one.
    if (turn.model !== status.model) settings.setAgentPrefs({ model: turn.model })
    const ac = new AbortController()
    turns.set(turnId, ac)
    let ended = false
    const emit = (event: AgentEvent) => {
      if (event.type === "done" || event.type === "error") ended = true
      send("agent:event", { turnId, event })
    }
    Promise.resolve()
      .then(() =>
        agent.start!(
          { ...turn, root: p.root, ...auth },
          {
            onEvent: emit,
            onPermission: (request) =>
              new Promise<PermissionDecision>((resolveDecision) => {
                pendingPermissions.set(request.id, resolveDecision)
                ac.signal.addEventListener("abort", () => {
                  if (pendingPermissions.delete(request.id)) resolveDecision({ behavior: "deny", message: "Turn stopped." })
                })
                send("agent:permission", { turnId, request })
              }),
            signal: ac.signal,
          },
        ),
      )
      .catch((err: unknown) => emit({ type: "error", message: err instanceof Error ? err.message : String(err) }))
      .finally(() => {
        turns.delete(turnId)
        // The renderer stops "working…" only on done/error; make sure one arrives.
        if (!ended) emit({ type: "done" })
      })
    return turnId
  })
  handle("agent:respond", (requestId: string, decision: PermissionDecision) => {
    const resolveDecision = pendingPermissions.get(requestId)
    pendingPermissions.delete(requestId)
    resolveDecision?.(decision)
  })
  handle("agent:abort", (turnId: string) => {
    turns.get(turnId)?.abort()
  })
  handle("agent:restore", (ref: string) => restoreCheckpoint(need().root, ref))

  handle("job:start", async (board: string, markId: string) => {
    const p = need()
    const jobs = await jobApi()
    const status = await agentStatus()
    const auth = await turnAuth(status)
    // Watch the jobs folder before the first job file appears in it.
    const jobsDir = join(p.root, ".river", "jobs")
    await mkdir(jobsDir, { recursive: true })
    projectWatch?.add(jobsDir)
    const run = jobs.startConceptJob({ workspaceRoot: p.root, board, markId, model: status.model, ...auth }, opts.jobDeps)
    run.catch((err: unknown) => console.warn("river: concept job failed", err))
    // Once the job exists its errors land in its file; one that fails before that (bad mark, no git) is thrown here.
    await Promise.race([run, new Promise((r) => setTimeout(r, 1_500))])
  })
  handle("job:get", async (jobId: string): Promise<JobDTO> => {
    const p = need()
    const job = await loadJob(p.root, jobId)
    if (job.status !== "approval") return { job }
    // The committed bytes, hashed as read: the only bytes approveJobScript will run.
    return { job, script: await (await jobApi()).readJobScript(p.root, jobId) }
  })
  handle("job:approve", async (jobId: string, sha256: string) => {
    await (await jobApi()).approveJobScript(need().root, jobId, sha256)
  })
  handle("job:accept", async (jobId: string) => {
    await (await jobApi()).acceptJob(need().root, jobId)
  })
  handle("job:dismiss", async (jobId: string) => {
    await (await jobApi()).dismissJob(need().root, jobId)
  })
}
