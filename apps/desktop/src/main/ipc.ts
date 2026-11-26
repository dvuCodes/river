import { randomUUID } from "node:crypto"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { basename, dirname, join, relative, resolve, sep } from "node:path"
import { type BrowserWindow, dialog, ipcMain } from "electron"
import type { AgentEvent, AgentTurnRequest, ClaudeCodeStatus, JobAgentSettings, JobDeps, PermissionDecision, RunTurn, WritingJobDeps } from "@river/agent"
import { KNOWN_MODELS, isValidModel } from "@river/agent"
import { createGodotAdapter, kitFileText, linesToRead } from "@river/adapter-godot"
import {
  type Capture,
  type ChangePlan,
  type CheckDataResult,
  type Diagnostic,
  type EngineAdapter,
  type GameState,
  type Playtest,
  type Project,
  type ReviewStatus,
  type ReviewThread,
  type StateSchema,
  type Story,
  type StoryWorkspace,
  DEFAULT_BOARD,
  addPassage,
  addThread,
  captureShot,
  captureShots,
  choiceTarget,
  contentPassages,
  createPlaytest,
  deletePassage,
  evalCond,
  exportStory,
  formatClosed,
  formatCond,
  lint,
  lintNarrative,
  lintStoryInWorkspace,
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
  loadStoryWorkspace,
  openChoices,
  parseTwee3,
  pathsAnalysis,
  readBrief,
  readVoice,
  renamePassage,
  reply,
  resolveAdapter,
  restoreCheckpoint,
  runCheckData,
  safePath,
  saveStory,
  setPassagePositions,
  setPlanStatus,
  setStatus,
  startPassage,
  updatePassageTags,
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
  PathsResultDTO,
  PlaySnapshot,
  ProjectInfo,
  StoryDTO,
} from "../shared/api"
import { asciiLine } from "../shared/approval"
import { type JobApi, type WritingApi, loadAgent } from "./agent"
import { type Approvals, registerApproval } from "./approval"
import { passageDTO, storyDTO } from "./dto"
import * as settings from "./settings"
import { boardHandlers, closeRowGap, jobLogFile, jobRevisable, lookingJobs } from "./board"
import { type ProjectWatch, noteOwnWrite, watchProject } from "./watch"
import { PermissionWaits } from "./permissions"
import { StoryCache, staleStories, storyIdsFor } from "./storyCache"
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
  storyCache.invalidate()
  try {
    project = await loadProject(abs)
    // Again now the new project is current: a read during loadProject may have cached the old project's story.
    storyCache.invalidate()
    projectError = null
    if (remember) settings.setLastProject(project.root)
    projectWatch = watchProject(project, (changes) => {
      const stale = staleStories(changes)
      if (stale === "all") storyCache.invalidate()
      else for (const rel of stale) storyCache.invalidate(rel)
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
    storyCache.invalidate()
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
    ...(project.manifest.checkData ? { hasCheckData: true } : {}),
  }
}

interface ParsedStory {
  story: Story
  schema: StateSchema
  /** The StoryDTO with parse, lint and narrative diagnostics, built on first use and kept for the given workspace. */
  dto(ws?: StoryWorkspace, storyId?: string): StoryDTO
}

interface CachedWorkspace {
  ids: Map<string, string>
  workspace: StoryWorkspace | undefined
}

/**
 * Parsed stories by file, for the read-only handlers (load, paths, open state, playtest start). Cleared when a project
 * opens, when River writes a story, and when the watcher reports a story, state or manifest change. Handlers that
 * write read the file fresh, so an outside edit the watcher has not reported yet is never written over.
 */
const storyCache = new StoryCache<ParsedStory, CachedWorkspace>()

async function parseStory(p: Project, rel: string): Promise<ParsedStory> {
  const [{ story, diagnostics }, schema] = await Promise.all([loadStory(p, rel), loadSchema(p)])
  let cached: { ws: StoryWorkspace | undefined; storyId: string | undefined; dto: StoryDTO } | undefined
  return {
    story,
    schema,
    dto: (ws, storyId) => {
      if (!cached || cached.ws !== ws || cached.storyId !== storyId) {
        const core = ws && storyId ? lintStoryInWorkspace(ws, storyId, story, schema) : lint(story, schema)
        const narrative: Diagnostic[] = lintNarrative(story, schema, {
          ...(p.manifest.copyBudgets ? { copyBudgets: p.manifest.copyBudgets } : {}),
          shotIds: p.manifest.shots.map((s) => s.id),
        })
        cached = { ws, storyId, dto: storyDTO(story, [...diagnostics, ...core, ...narrative], schema) }
      }
      return cached.dto
    },
  }
}

/** The story as parsed now, from the cache when it is there. */
function readStory(rel: string): Promise<ParsedStory> {
  const p = need()
  return storyCache.get(rel, () => parseStory(p, rel))
}

/**
 * Multi-story workspace (cached alongside parsed stories and dropped on any story, state or manifest change).
 * Single-story projects skip building a workspace so their performance and behavior stay unchanged.
 */
function readWorkspace(p: Project): Promise<CachedWorkspace> {
  return storyCache.getWorkspace(async () => {
    const files = await listStories(p)
    const ids = storyIdsFor(files, p.manifest.stories)
    if (files.length < 2) return { ids, workspace: undefined }
    const loaded = await Promise.all(
      files.map(async (file) => ({
        file,
        id: ids.get(file) ?? basename(file).replace(/\.(twee|tw)$/i, ""),
        story: (await storyCache.get(file, () => parseStory(p, file))).story,
      })),
    )
    return { ids, workspace: loadStoryWorkspace(loaded) }
  })
}

function storyIdFrom(ws: CachedWorkspace, rel: string): string {
  const norm = rel.replace(/\\/g, "/")
  return ws.ids.get(norm) ?? basename(norm).replace(/\.(twee|tw)$/i, "")
}

async function storyDto(rel: string): Promise<StoryDTO> {
  const p = need()
  const [entry, ws] = await Promise.all([readStory(rel), readWorkspace(p)])
  return ws.workspace ? entry.dto(ws.workspace, storyIdFrom(ws, rel)) : entry.dto()
}

/** The story read from disk now, for a handler that writes it. */
async function freshStory(rel: string): Promise<Story> {
  return (await loadStory(need(), rel)).story
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
  storyCache.invalidate(rel)
  try {
    await saveStory(p, rel, story)
  } finally {
    // Again after the write: a read that started during it may have cached the old text.
    storyCache.invalidate(rel)
  }
  for (const cb of storyWritten) cb(rel)
}

async function storyAfterWrite(rel: string, story: Story): Promise<StoryDTO> {
  await writeStory(rel, story)
  return storyDto(rel)
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
    renderedText: pt.renderedText(),
    choices: pt.choices().map(({ choice, open, closed }) => ({
      label: choice.label,
      target: choice.target,
      open,
      // A `@return` choice has no passage target but is not broken.
      broken: choiceTarget(story, choice.target).kind === "missing",
      ...(choice.when ? { when: formatCond(choice.when) } : {}),
      ...(choice.hint ? { hint: choice.hint } : {}),
      ...(closed ? { closedReason: formatClosed(closed) } : {}),
    })),
    interrupts: pt.interrupts().map(({ passage, open }) => ({
      id: passage.id,
      name: passage.name,
      open,
      ...(passage.when ? { when: formatCond(passage.when) } : {}),
    })),
    storylets: pt.storylets().map(({ passage, open, weight, priority, cooldownLeft }) => ({
      id: passage.id,
      name: passage.name,
      open,
      weight,
      priority,
      cooldownLeft,
    })),
    inInterrupt: history.at(-1)?.returnTo !== undefined,
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

/** Adapters River ships. A project on another engine captures through river.json's `adapter.<engine>.command`. */
const ADAPTERS: readonly EngineAdapter[] = [createGodotAdapter()]

/** The project's capture adapter. Throws (saying what to set in river.json) when its engine has none. */
const adapterFor = (p: Project): EngineAdapter => resolveAdapter(p, ADAPTERS)

function canCapture(p: Project): boolean {
  try {
    adapterFor(p)
    return true
  } catch {
    return false
  }
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
    knownModels: [...KNOWN_MODELS],
    ...(prefs.selfCheckModel ? { selfCheckModel: prefs.selfCheckModel } : {}),
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

async function writingApi(): Promise<WritingApi> {
  const agent = await loadAgent()
  if (!agent.writing) throw new Error(agent.writingReason ?? "Writing jobs are unavailable.")
  return agent.writing
}

/** A passage named `name` with `rawText` as its body, parsed as the story file parses it (river-mcp's story_add_passage does the same). */
function newPassage(name: string, tags: readonly string[], rawText: string, file: string) {
  const escape = (x: string) => x.replace(/[\\[\]{}]/g, (c) => `\\${c}`)
  const header = `:: ${escape(name)}${tags.length > 0 ? ` [${tags.map(escape).join(" ")}]` : ""}`
  // A body line starting with "::" would start another passage.
  const body = rawText.replace(/\r\n?/g, "\n").split("\n").map((l) => (l.startsWith("::") ? `\\${l}` : l)).join("\n")
  const passage = parseTwee3(`${header}\n${body}\n`, file).story.passages[0]
  if (!passage) throw new Error(`Could not read the new passage ${JSON.stringify(name)}.`)
  return passage
}

/**
 * The look at a job's renders (and a writing job's table read) runs as the job's own turns do: the user's backend, key
 * or claude path, and model — the self-check model from Settings when one is set.
 */
async function lookSettings(): Promise<false | JobAgentSettings> {
  if (!settings.getAgentPrefs().selfCheck) return false
  try {
    const status = await agentStatus()
    return { model: status.selfCheckModel ?? status.model, ...(await turnAuth(status)) }
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

  handle("story:load", async (rel: string) => storyDto(rel))
  handle("story:savePassage", async (rel: string, id: string, raw: string) => storyAfterWrite(rel, updatePassageText(await freshStory(rel), id, raw)))
  handle("story:rename", async (rel: string, id: string, name: string) => {
    const trimmed = name.trim()
    if (!trimmed) throw new Error("A passage name cannot be empty.")
    return storyAfterWrite(rel, renamePassage(await freshStory(rel), id, trimmed))
  })
  handle("story:addPassage", async (rel: string, name: string, rawText: string, tags?: string[]) => {
    const trimmed = typeof name === "string" ? name.trim() : ""
    if (!trimmed) throw new Error("A passage name cannot be empty.")
    if (/[\r\n]/.test(trimmed)) throw new Error("A passage name is one line.")
    const tagList = Array.isArray(tags) ? tags.map((t) => String(t).trim()).filter(Boolean) : []
    const story = await freshStory(rel)
    return storyAfterWrite(rel, addPassage(story, newPassage(trimmed, tagList, typeof rawText === "string" ? rawText : "", story.file)))
  })
  handle("story:setTags", async (rel: string, id: string, tags: string[]) => {
    if (!Array.isArray(tags)) throw new Error("Tags are a list of words.")
    const list = [...new Set(tags.map((t) => String(t).trim()).filter(Boolean))]
    if (list.some((t) => /[\s\[\]]/.test(t))) throw new Error("A tag is one word, with no spaces or brackets.")
    return storyAfterWrite(rel, updatePassageTags(await freshStory(rel), id, list))
  })
  handle("story:deletePassage", async (rel: string, id: string) => {
    const story = await freshStory(rel)
    const start = startPassage(story)
    if (start && start.id === id) throw new Error(`"${start.name}" is the story's start passage, so it cannot be deleted. Make another passage the start first.`)
    return storyAfterWrite(rel, deletePassage(story, id))
  })
  handle("story:export", async (rel: string): Promise<{ outFile: string; passageCount: number }> => {
    const p = need()
    const [{ story, schema }, ws] = await Promise.all([readStory(rel), readWorkspace(p)])
    const id = storyIdFrom(ws, rel)
    const data = ws.workspace ? exportStory(story, schema, id, { workspace: ws.workspace }) : exportStory(story, schema, id)
    const outFile = `${p.manifest.export}/${id}.json`.replace(/\\/g, "/")
    const target = safePath(p, outFile)
    await mkdir(dirname(target), { recursive: true })
    await writeFile(target, JSON.stringify(data, null, 2) + "\n", "utf8")
    return { outFile, passageCount: Object.keys(data.passages).length }
  })
  handle("project:checkData", async (): Promise<CheckDataResult> => {
    const p = need()
    if (!p.manifest.checkData) throw new Error("river.json has no checkData command.")
    return runCheckData(p, await loadSchema(p))
  })
  handle("story:savePositions", async (rel: string, positions: Record<string, [number, number]>) => {
    const { story } = await loadStory(need(), rel)
    const next = setPassagePositions(story, positions)
    if (next !== story) await writeStory(rel, next)
  })
  handle("story:paths", async (rel: string): Promise<PathsResultDTO> => {
    const { story, schema } = await readStory(rel)
    const a = pathsAnalysis(story, schema)
    const dto = (r: (typeof a.interrupts)[number]) => ({ steps: r.steps, end: r.end, satisfiable: r.satisfiable, conditions: r.conditions.map(formatCond) })
    return { routes: a.routes.map(dto), interrupts: a.interrupts.map(dto), truncated: a.truncated }
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
  handle("play:interrupt", (id: string, name: string) => {
    sessions.get(id)?.pt.interrupt(name)
    return snapshot(id)
  })
  handle("play:drawStorylet", (id: string) => {
    sessions.get(id)?.pt.drawStorylet()
    return snapshot(id)
  })

  handle("frames:get", async (): Promise<FramesDTO> => {
    const p = need()
    const shots = await Promise.all(
      p.manifest.shots.map(async (s) => ({ ...s, captures: (await listCaptures(p, s.id)).map((c) => captureDTO(p, c)) })),
    )
    const [threads, plans] = await Promise.all([listThreads(p), listPlans(p)])
    return { engine: p.manifest.engine, canCapture: canCapture(p), shots, threads, plans }
  })
  handle("frames:capture", async (shotId: string) => {
    const p = need()
    return captureDTO(p, await captureShot(p, shotId, adapterFor(p)))
  })
  // Captures are listed from disk on every frames:get, so there is no capture cache to clear afterwards.
  handle("frames:captureAll", async (): Promise<CaptureDTO[]> => {
    const p = need()
    const adapter = adapterFor(p)
    const ids = p.manifest.shots.map((s) => s.id)
    if (ids.length === 0) throw new Error("river.json has no shots to capture.")
    return (await captureShots(p, ids, adapter)).map((c) => captureDTO(p, c))
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
    if (!isValidModel(turn.model)) throw new Error(`Not a model id: ${JSON.stringify(String(turn.model).slice(0, 80))}`)
    const auth = await turnAuth(status)
    // The project brief and the voice bible go into the system prompt; a file that cannot be read is left out.
    const [brief, voice] = await Promise.all([readBrief(p.root).catch(() => undefined), readVoice(p.root).catch(() => undefined)])
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
          { ...turn, root: p.root, ...auth, ...(brief ? { brief } : {}), ...(voice ? { voice } : {}) },
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
  handle("agent:restore", async (ref: string) => {
    try {
      await restoreCheckpoint(need().root, ref)
    } finally {
      storyCache.invalidate()
    }
  })

  /** Jobs run in the background; one that fails before its job file exists (bad mark, no git) is thrown here. */
  /** The settings and agent turn a job runs with, once the jobs folder is watched. */
  const jobSetup = async (): Promise<{ settings: JobAgentSettings; runTurn: RunTurn | undefined }> => {
    const p = need()
    const agent = await loadAgent()
    const base: RunTurn | undefined = opts.jobDeps?.runTurn ?? agent.start
    const status = await agentStatus()
    const auth = await turnAuth(status)
    // Watch the jobs folder before the first job file appears in it.
    const jobsDir = join(p.root, ".river", "jobs")
    await mkdir(jobsDir, { recursive: true })
    projectWatch?.add(jobsDir)
    return { settings: { model: status.model, ...auth }, runTurn: base ? tracked(base) : undefined }
  }
  /** Let a job run on; a failure in its first moments (before its job file exists) is thrown to the caller. */
  const background = async (run: Promise<unknown>, what: string) => {
    run.catch((err: unknown) => console.warn(`river: ${what} failed`, err))
    await Promise.race([run, new Promise((r) => setTimeout(r, 1_500))])
  }
  const runJob = async (start: (jobs: JobApi, settings: JobAgentSettings, deps: JobDeps) => Promise<unknown>) => {
    const jobs = await jobApi()
    const selfCheckModel = settings.getAgentPrefs().selfCheckModel
    const { settings: jobSettings, runTurn } = await jobSetup()
    const deps: JobDeps = { ...opts.jobDeps, ...(selfCheckModel ? { selfCheckModel } : {}), ...(runTurn ? { runTurn } : {}) }
    await background(start(jobs, jobSettings, deps), "concept job")
  }
  /** Writing jobs run their table read inside the job, with the same self-check setting as the look at renders. */
  const runWritingJob = async (start: (writing: WritingApi, settings: JobAgentSettings, deps: WritingJobDeps) => Promise<unknown>) => {
    const writing = await writingApi()
    const selfCheckModel = settings.getAgentPrefs().selfCheckModel
    const { settings: jobSettings, runTurn } = await jobSetup()
    // Quitting the app aborts the table read; the job is still answered, with the note as the writer wrote it.
    const deps: WritingJobDeps = { selfCheck: await lookSettings(), signal: work.signal(), ...(selfCheckModel ? { selfCheckModel } : {}), ...(runTurn ? { runTurn } : {}) }
    await background(start(writing, jobSettings, deps), "writing job")
  }
  handle("job:start", (board: string, markId: string) => runJob((jobs, settings, deps) => jobs.startConceptJob({ workspaceRoot: need().root, board, markId, ...settings }, deps)))
  handle("job:revise", (jobId: string) => runJob((jobs, settings, deps) => jobs.reviseJob(need().root, jobId, settings, deps)))
  handle("writeJob:start", (board: string, markId: string) =>
    runWritingJob((writing, settings, deps) => writing.startWritingJob({ workspaceRoot: need().root, board, markId, ...settings }, deps)),
  )
  handle("writeJob:revise", (jobId: string) => runWritingJob((writing, settings, deps) => writing.reviseWritingJob(need().root, jobId, settings, deps)))
  handle("writeJob:accept", async (jobId: string, variant: string, saveExemplar?: boolean) => {
    const p = need()
    if (typeof variant !== "string" || !/^[a-e]$/i.test(variant.trim())) throw new Error(`Not a take: ${JSON.stringify(variant)} (a to e).`)
    const { board } = await loadJob(p.root, jobId)
    // The take cards as they are before the accept removes the takes not kept.
    const takes = (await loadBoard(p.root, board)).cards.filter((c) => c.pending?.jobId === jobId && c.kind === "note" && c.label)
    try {
      await (await writingApi()).acceptWritingJob(p.root, jobId, { variant: variant.trim().toLowerCase(), ...(saveExemplar === false ? { saveExemplar: false } : {}) })
    } finally {
      // The accept writes the story file itself, not through writeStory.
      storyCache.invalidate()
    }
    if (takes.length > 1) await closeRowGap(p.root, board, takes).catch((err: unknown) => console.warn("river: could not close the row after keeping a take", err))
  })
  handle("writeJob:dismiss", async (jobId: string, reason?: string) => {
    await (await writingApi()).dismissWritingJob(need().root, jobId, typeof reason === "string" && reason ? reason : undefined)
  })
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
    const selfCheckModel = settings.getAgentPrefs().selfCheckModel
    const run = jobs.approveJobScripts(root, jobId, shas, { ...opts.jobDeps, selfCheck, ...(selfCheckModel ? { selfCheckModel } : {}), ...(runTurn ? { runTurn } : {}) })
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
        // Only your own words: a mark can carry an agent's messages too.
        request: asciiLine(mark?.thread.find((t) => t.by === YOU)?.text ?? "").slice(0, 300),
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
