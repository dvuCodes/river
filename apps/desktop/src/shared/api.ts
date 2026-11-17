/**
 * The contract between main and renderer. Plain JSON only: the renderer never imports
 * runtime code from @river/core (it pulls in fs and child_process), only types.
 */
import type {
  AgentEvent,
  AgentMode,
  AgentModel,
  PermissionDecision,
  PermissionRequest,
} from "@river/agent"
import type {
  ChangePlan,
  Diagnostic,
  GameState,
  ReviewStatus,
  ReviewThread,
  ShotDef,
  StateSchema,
} from "@river/core"

export type ViewId = "story-map" | "paths" | "playtest" | "frames" | "agent"
export const VIEWS: readonly ViewId[] = ["story-map", "paths", "playtest", "frames", "agent"]

export interface ProjectInfo {
  root: string
  name: string
  engine: string
  stories: string[]
  shots: ShotDef[]
  /** Project could not be loaded: the message, with root set to the folder tried. */
  error?: string
}

export interface ChoiceDTO {
  label: string
  /** Target name as written. */
  target: string
  /** Resolved target passage id, absent for a broken link. */
  targetId?: string
  when?: string
  cost: string
  set: string
}

export interface PassageDTO {
  id: string
  name: string
  tags: string[]
  when?: string
  onEnter: string
  isEnding: boolean
  isStart: boolean
  rawText: string
  /** Prose with rule lines removed and choice lines kept. */
  text: string
  choices: ChoiceDTO[]
  line: number
}

export interface StoryDTO {
  file: string
  title: string
  start: string
  passages: PassageDTO[]
  /** Parse diagnostics plus lint results. */
  diagnostics: Diagnostic[]
  /** passage id -> [x, y] from <story>.layout.json. */
  positions: Record<string, [number, number]>
  schema: StateSchema
}

export interface PathDTO {
  steps: { passageId: string; choiceIndex?: number }[]
  end: "ending" | "dead-end" | "loop"
  satisfiable: boolean
  conditions: string[]
}

export interface OpenStateDTO {
  passages: Record<string, boolean>
  choices: Record<string, boolean[]>
}

export interface PlaySnapshot {
  sessionId: string
  passage: PassageDTO
  choices: { label: string; target: string; open: boolean; when?: string; broken: boolean }[]
  state: GameState
  /** Passage names visited, oldest first. */
  history: string[]
  isOver: boolean
  canUndo: boolean
}

export interface CaptureDTO {
  shotId: string
  rev: string
  at: string
  /** river-file:// URLs, frame order. */
  urls: string[]
}

export interface ShotDTO extends ShotDef {
  captures: CaptureDTO[]
}

export interface FramesDTO {
  engine: string
  canCapture: boolean
  shots: ShotDTO[]
  threads: ReviewThread[]
  plans: ChangePlan[]
}

export interface AgentStatus {
  available: boolean
  reason?: string
  hasKey: boolean
  encryptionAvailable: boolean
}

export interface AgentStartRequest {
  /** Chosen by the renderer so it can match events that arrive before agentStart resolves. */
  turnId: string
  mode: AgentMode
  model: AgentModel
  prompt: string
  storyFile?: string
  threadId?: string
  planId?: string
  sessionId?: string
}

export type FsChangeKind = "story" | "state" | "manifest" | "review" | "plans"
export interface FsChange {
  kind: FsChangeKind
  /** Path relative to the project root, forward slashes. */
  rel: string
}

export interface RiverApi {
  // project
  getProject(): Promise<ProjectInfo | null>
  pickProject(): Promise<ProjectInfo | null>
  // story
  loadStory(rel: string): Promise<StoryDTO>
  savePassage(rel: string, passageId: string, rawText: string): Promise<StoryDTO>
  renamePassage(rel: string, passageId: string, newName: string): Promise<StoryDTO>
  saveLayout(rel: string, positions: Record<string, [number, number]>): Promise<void>
  paths(rel: string): Promise<PathDTO[]>
  openState(rel: string, state: GameState): Promise<OpenStateDTO>
  // playtest
  playStart(rel: string, from?: string): Promise<PlaySnapshot>
  playChoose(sessionId: string, index: number): Promise<PlaySnapshot>
  playUndo(sessionId: string): Promise<PlaySnapshot>
  playSetVar(sessionId: string, name: string, value: number | string | boolean): Promise<PlaySnapshot>
  // frames and review
  frames(): Promise<FramesDTO>
  capture(shotId: string): Promise<CaptureDTO>
  addThread(target: ReviewThread["target"], text: string): Promise<ReviewThread>
  reply(threadId: string, text: string): Promise<ReviewThread>
  setThreadStatus(threadId: string, status: ReviewStatus): Promise<ReviewThread>
  setPlanStatus(planId: string, status: ChangePlan["status"]): Promise<ChangePlan>
  // agent
  agentStatus(): Promise<AgentStatus>
  agentStart(req: AgentStartRequest): Promise<string>
  agentRespond(requestId: string, decision: PermissionDecision): Promise<void>
  agentAbort(turnId: string): Promise<void>
  restoreCheckpoint(ref: string): Promise<void>
  setApiKey(key: string): Promise<AgentStatus>
  clearApiKey(): Promise<AgentStatus>
  // events from main; each returns an unsubscribe function
  onAgentEvent(cb: (e: { turnId: string; event: AgentEvent }) => void): () => void
  onAgentPermission(cb: (e: { turnId: string; request: PermissionRequest }) => void): () => void
  onFsChange(cb: (changes: FsChange[]) => void): () => void
  onNavigate(cb: (view: ViewId) => void): () => void
  // smoke mode (the renderer knows it is in smoke mode from the ?smoke=1 query)
  smokeReady(view: ViewId): void
}

declare global {
  interface Window {
    river: RiverApi
  }
}
