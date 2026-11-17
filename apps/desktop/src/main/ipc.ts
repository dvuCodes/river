import { randomUUID } from "node:crypto"
import { mkdir, readFile } from "node:fs/promises"
import { join, relative, resolve, sep } from "node:path"
import { type BrowserWindow, dialog, ipcMain } from "electron"
import type { AgentEvent, AgentTurnRequest, ClaudeCodeStatus, JobAgentSettings, JobDeps, PermissionDecision, RunTurn } from "@river/agent"
import { createGodotAdapter, kitFileText, linesToRead } from "@river/adapter-godot"
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
  DEFAULT_BOARD,
  addThread,
  captureShot,
  contentPassages,
  createPlaytest,
  evalCond,
  formatCond,
  lint,
  listBoards,
  listCaptures,
  listPlans,
  listStories,
  listThreads,
  loadBoard,
  loadJob,
  loadMark,
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
  CanvasTheme,
  CaptureDTO,
  FramesDTO,
  JobDTO,
  OpenStateDTO,
  PathDTO,
  PlaySnapshot,
  ProjectInfo,
  StoryDTO,
} from "../shared/api"
import { asciiLine } from "../shared/approval"
import { type JobApi, loadAgent } from "./agent"
import { type Approvals, registerApproval } from "./approval"
import { passageDTO, storyDTO } from "./dto"
import * as settings from "./settings"
import { boardHandlers, closeRowGap, jobLogFile, jobRevisable, lookingJobs } from "./board"
import { type ProjectWatch, noteOwnWrite, watchProject } from "./watch"
import { PermissionWaits } from "./permissions"
import { AgentWork } from "./work"

let project: Project | null = null
let projectError: { root: string; message: string } | null = null
let projectWatch: ProjectWatch | null = null
let getWindow: () => BrowserWindow | null = () => null
let approvals: Approvals | null = null

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
  approvals?.closeAll()
  await projectWatch?.stop()
  projectWatch = null
  try {
    project = await loadProject(abs)
    projectError = null
    if (remember) settings.setLastProject(project.root)
    projectWatch = watchProject(project, (changes) => {
      approvals?.changed(changes)
      send("fs:change", changes)
    })
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
    return projectError ? { root: projectError.root, name: "", board: DEFAULT_BOARD, engine: "", stories: [], shots: [], error: projectError.message } : null
  }
  const boards = await listBoards(project.root)
  const last = settings.getLastBoard(project.root)
  return {
    root: project.root,
    name: project.manifest.name,
    board: last && boards.includes(last) ? last : boards.includes(DEFAULT_BOARD) || boards.length === 0 ? DEFAULT_BOARD : boards[0]!,
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

// ---- agent turns
/** Review threads are committed with the game, so the person at this desk is "you", never their account name. */
const YOU = "you"

const turns = new Map<string, AbortController>()
const permissions = new PermissionWaits()
const work = new AgentWork()

/** On quit: stop every agent turn (chat, concept drawing, look at renders) and wait for them, at most `timeoutMs`. */
export function stopAgentWork(timeoutMs: number): Promise<void> {
  return work.stopAll(timeoutMs)
}

/** A concept job's turns, stopped with the rest of the app's agent work when it quits. */
const tracked =
  (base: RunTurn): RunTurn =>
  (req, h) =>
    work.track(base(req, { ...h, signal: work.signal(h.signal) }))

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
    selfCheck: prefs.selfCheck,
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

/** The look at a job's renders runs as the job's own turns do: the user's model, backend, key or claude path. */
async function lookSettings(): Promise<false | JobAgentSettings> {
  if (!settings.getAgentPrefs().selfCheck) return false
  try {
    const status = await agentStatus()
    return { model: status.model, ...(await turnAuth(status)) }
  } catch (err) {
    // Without a way to run the look, the renders are still worth showing: answer with the note as written.
    console.warn("river: skipping the look at the renders:", err instanceof Error ? err.message : String(err))
    return false
  }
}

/** A short turn, as core's own look at the renders runs it. */
const LOOK_LIMITS = { maxTurns: 6, effort: "low" } as const

/** Approve runs still going (rendering, then the look), settled either way. */
const approving = new Map<string, Promise<void>>()

/** Tell the canvas a job's cards changed although its file did not (the look started or ended). */
const jobTouched = (jobId: string) => send("fs:change", [{ kind: "job", rel: `.river/jobs/${jobId}.json` }])

/** The approval window open now, if any (smoke mode drives it). */
export function approvalWindow(): BrowserWindow | null {
  return approvals?.window() ?? null
}

/**
 * `jobDeps` goes to startConceptJob as its deps (smoke mode passes a fake agent turn); `onApprove` lets a smoke count
 * approve calls; `smoke` gives the approval window smoke mode's window settings.
 */
export function registerIpc(windowGetter: () => BrowserWindow | null, opts: { jobDeps?: JobDeps; onApprove?: () => void; smoke?: boolean } = {}): void {
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
    const { story, schema } = await readStory(rel)
    const out: OpenStateDTO = { passages: {}, choices: {} }
    for (const p of contentPassages(story)) {
      out.passages[p.id] = p.when ? evalCond(p.when, state) : true
      out.choices[p.id] = openChoices(p, state, { story, schema }).map((c) => c.open)
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
  handle("review:add", (target: ReviewThread["target"], text: string) => addThread(need(), target, YOU, text))
  handle("review:reply", (threadId: string, text: string) => reply(need(), threadId, YOU, text))
  handle("review:status", (threadId: string, status: ReviewStatus) => setStatus(need(), threadId, status))
  handle("plan:status", (planId: string, status: ChangePlan["status"]) => setPlanStatus(need(), planId, status))

  for (const [channel, fn] of Object.entries(boardHandlers(need, { add: (dir) => projectWatch?.add(dir), remove: (dir) => projectWatch?.remove(dir) }, getWindow))) {
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
  handle("settings:canvasTheme", () => settings.getCanvasTheme())
  handle("settings:setCanvasTheme", (t: CanvasTheme) => settings.setCanvasTheme(t))
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
    const signal = work.signal(ac.signal)
    let ended = false
    const emit = (event: AgentEvent) => {
      if (event.type === "done" || event.type === "error") ended = true
      send("agent:event", { turnId, event })
    }
    const run = Promise.resolve()
      .then(() =>
        agent.start!(
          { ...turn, root: p.root, ...auth },
          {
            onEvent: emit,
            onPermission: (request) => permissions.wait(request.id, signal, () => send("agent:permission", { turnId, request })),
            signal,
          },
        ),
      )
      .catch((err: unknown) => emit({ type: "error", message: err instanceof Error ? err.message : String(err) }))
      .finally(() => {
        turns.delete(turnId)
        // The renderer stops "working…" only on done/error; make sure one arrives.
        if (!ended) emit({ type: "done" })
      })
    void work.track(run)
    return turnId
  })
  handle("agent:respond", (requestId: string, decision: PermissionDecision) => {
    permissions.answer(requestId, decision)
  })
  handle("agent:abort", (turnId: string) => {
    turns.get(turnId)?.abort()
  })
  handle("agent:restore", (ref: string) => restoreCheckpoint(need().root, ref))

  /** Jobs run in the background; one that fails before its job file exists (bad mark, no git) is thrown here. */
  const runJob = async (start: (jobs: JobApi, settings: JobAgentSettings, deps: JobDeps) => Promise<unknown>) => {
    const p = need()
    const jobs = await jobApi()
    const agent = await loadAgent()
    const base: RunTurn | undefined = opts.jobDeps?.runTurn ?? agent.start
    const deps: JobDeps = { ...opts.jobDeps, ...(base ? { runTurn: tracked(base) } : {}) }
    const status = await agentStatus()
    const auth = await turnAuth(status)
    // Watch the jobs folder before the first job file appears in it.
    const jobsDir = join(p.root, ".river", "jobs")
    await mkdir(jobsDir, { recursive: true })
    projectWatch?.add(jobsDir)
    const run = start(jobs, { model: status.model, ...auth }, deps)
    run.catch((err: unknown) => console.warn("river: concept job failed", err))
    await Promise.race([run, new Promise((r) => setTimeout(r, 1_500))])
  }
  handle("job:start", (board: string, markId: string) => runJob((jobs, settings, deps) => jobs.startConceptJob({ workspaceRoot: need().root, board, markId, ...settings }, deps)))
  handle("job:revise", (jobId: string) => runJob((jobs, settings, deps) => jobs.reviseJob(need().root, jobId, settings, deps)))
  handle("job:get", async (jobId: string): Promise<JobDTO> => {
    const p = need()
    const job = await loadJob(p.root, jobId)
    return { job, revisable: await jobRevisable(p.root, job) }
  })
  /**
   * Approving renders the scripts and then lets the agent look at the renders. During approve only that look runs an
   * agent turn, so the turn is wrapped here: the canvas shows it, and jobStopLook aborts it. Returns once the job has
   * started rendering; a refusal (changed bytes) comes before that and is thrown here.
   */
  const approve = async (root: string, jobId: string, shas: Record<string, string>) => {
    const jobs = await jobApi()
    const agent = await loadAgent()
    const selfCheck = await lookSettings()
    const base: RunTurn | undefined = opts.jobDeps?.runTurn ?? (agent.start ? (req, h) => agent.start!(req, h, LOOK_LIMITS) : undefined)
    const stop = new AbortController()
    const runTurn: RunTurn | undefined =
      base &&
      (async (req, h) => {
        lookingJobs.set(jobId, stop)
        jobTouched(jobId)
        try {
          await work.track(base(req, { ...h, signal: work.signal(stop.signal) }))
        } finally {
          lookingJobs.delete(jobId)
          jobTouched(jobId)
        }
      })
    const run = jobs.approveJobScripts(root, jobId, shas, { ...opts.jobDeps, selfCheck, ...(runTurn ? { runTurn } : {}) })
    const settled = run.then(
      () => undefined,
      (err: unknown) => console.warn("river: approving the scripts failed", err),
    )
    approving.set(jobId, settled)
    void settled.finally(() => approving.delete(jobId))
    await Promise.race([run, new Promise((r) => setTimeout(r, 1_500))])
  }
  approvals = registerApproval({
    parent: getWindow,
    root: () => project?.root ?? null,
    async read(root, jobId) {
      const job = await loadJob(root, jobId)
      if (job.status !== "approval") throw new Error(`This job is ${job.status} now; there is nothing to run.`)
      const [scripts, mark] = await Promise.all([(await jobApi()).readJobScripts(root, jobId), loadMark(root, job.board, job.markId).catch(() => undefined)])
      return {
        jobId,
        board: asciiLine(job.board),
        request: asciiLine(mark?.thread[0]?.text ?? "").slice(0, 300),
        scripts: scripts.map((s) => ({
          file: s.file,
          text: s.text,
          sha256: s.sha256,
          ...(s.variant ? { variant: s.variant } : {}),
          ...(s.caption ? { caption: asciiLine(s.caption) } : {}),
          toRead: linesToRead(s.text),
        })),
      }
    },
    run: approve,
    kit: kitFileText,
    ...(opts.onApprove ? { onApprove: opts.onApprove } : {}),
    smoke: opts.smoke ?? false,
  })
  handle("job:stopLook", (jobId: string) => {
    lookingJobs.get(jobId)?.abort()
  })
  handle("job:log", async (jobId: string): Promise<string | null> => {
    try {
      return await readFile(jobLogFile(need().root, jobId), "utf8")
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return null
      throw err
    }
  })
  handle("job:accept", async (jobId: string, variants?: string[]) => {
    const p = need()
    const { board } = await loadJob(p.root, jobId)
    const options = variants ? (await loadBoard(p.root, board)).cards.filter((c) => c.pending?.jobId === jobId && c.kind === "concept") : []
    await (await jobApi()).acceptJob(p.root, jobId, variants ? { variants } : {})
    if (options.length > 1) await closeRowGap(p.root, board, options).catch((err: unknown) => console.warn("river: could not close the row after accepting", err))
  })
  handle("job:dismiss", async (jobId: string, reason?: string) => {
    // Core's dismissJob does not wait for an approve run, whose last write ("answered") could land after "dismissed".
    lookingJobs.get(jobId)?.abort()
    await approving.get(jobId)
    await (await jobApi()).dismissJob(need().root, jobId, typeof reason === "string" ? reason : undefined)
  })
}
