import { randomUUID } from "node:crypto"
import { userInfo } from "node:os"
import { isAbsolute, join, relative, resolve, sep } from "node:path"
import { type BrowserWindow, dialog, ipcMain } from "electron"
import type { AgentEvent, AgentTurnRequest, ClaudeCodeStatus, PermissionDecision } from "@river/agent"
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
  loadLayout,
  loadProject,
  loadSchema,
  loadStory,
  openChoices,
  paths,
  renamePassage,
  reply,
  resolveTarget,
  restoreCheckpoint,
  saveLayout,
  saveStory,
  setPlanStatus,
  setStatus,
  updatePassageText,
} from "@river/core"
import type {
  AgentPrefsUpdate,
  AgentStartRequest,
  AgentStatus,
  CaptureDTO,
  FramesDTO,
  OpenStateDTO,
  PathDTO,
  PlaySnapshot,
  ProjectInfo,
  StoryDTO,
} from "../shared/api"
import { loadAgent } from "./agent"
import { passageDTO, storyDTO } from "./dto"
import * as settings from "./settings"
import { watchProject } from "./watch"

let project: Project | null = null
let projectError: { root: string; message: string } | null = null
let stopWatch: (() => Promise<void>) | null = null
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
  await stopWatch?.()
  stopWatch = null
  try {
    project = await loadProject(abs)
    projectError = null
    if (remember) settings.setLastProject(project.root)
    stopWatch = watchProject(project, (changes) => send("fs:change", changes))
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
    dto: async () => {
      const layout = await loadLayout(join(p.root, rel))
      return storyDTO(story, [...diagnostics, ...lint(story, schema)], layout.positions, schema)
    },
  }
}

async function storyAfterWrite(rel: string, story: Story): Promise<StoryDTO> {
  await saveStory(need(), rel, story)
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

export function registerIpc(windowGetter: () => BrowserWindow | null): void {
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
  handle("story:saveLayout", async (rel: string, positions: Record<string, [number, number]>) => {
    const p = need()
    const round = (n: number) => Math.round(n)
    const clean: Record<string, [number, number]> = {}
    for (const [id, [x, y]] of Object.entries(positions)) clean[id] = [round(x), round(y)]
    await saveLayout(join(p.root, rel), { version: 1, positions: clean })
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
    let auth: Pick<AgentTurnRequest, "backend" | "apiKey" | "claudePath">
    if (status.backend === "api-key") {
      const apiKey = await settings.getApiKey()
      if (!apiKey) throw new Error("Add an Anthropic API key in Settings first.")
      auth = { backend: "api-key", apiKey }
    } else {
      auth = { backend: "claude-code", ...(status.claudePath ? { claudePath: status.claudePath } : {}) }
    }
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
}
