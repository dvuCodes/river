/**
 * The contract between main and renderer. Plain JSON only: the renderer never imports
 * runtime code from @river/core (it pulls in fs and child_process), only types.
 */
import type {
  AgentBackend,
  AgentEvent,
  AgentMode,
  AgentModel,
  ClaudeCodeStatus,
  PermissionDecision,
  PermissionRequest,
} from "@river/agent"
import type {
  Card,
  ChangePlan,
  Mark,
  Diagnostic,
  GameState,
  ReviewStatus,
  ReviewThread,
  ShotDef,
  StateSchema,
} from "@river/core"

export type ViewId = "story-map" | "paths" | "playtest" | "canvas" | "frames" | "agent"
export const VIEWS: readonly ViewId[] = ["story-map", "paths", "playtest", "canvas", "frames", "agent"]

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
  /** passage id -> [x, y] from the passage header metadata {"position":"x,y"}. Passages without one are absent. */
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
  /** The backend turns use: the saved choice, or a default (Claude Code when it is installed and signed in). */
  backend: AgentBackend
  /** True when the user picked the backend (false: it is the default). */
  backendChosen: boolean
  model: AgentModel
  claudePath?: string
  /** Only installed / version / loggedIn / authMethod / subscriptionType. Null while unknown. */
  claudeCode: ClaudeCodeStatus | null
}

export interface AgentPrefsUpdate {
  backend?: AgentBackend
  model?: AgentModel
  /** Empty string clears it (use PATH). */
  claudePath?: string
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

/** What a card shows, resolved by main (the renderer cannot read stories or captures itself). */
export type CardView =
  | { kind: "frame"; shotId: string; rev?: string; url?: string; missing?: string }
  | { kind: "passage"; story: string; passageId: string; title: string; tags: string[]; lines: string[]; missing?: string }
  | { kind: "ref"; url: string }
  | { kind: "concept"; id: string }
  | { kind: "note" }

export interface CardDTO {
  card: Card
  view: CardView
}

export interface BoardDTO {
  name: string
  cards: CardDTO[]
  marks: Mark[]
  /** Count of marks with status "open" (core openMarks). */
  openMarks: number
  /** Files that did not parse, as "<path>: <message>". */
  errors: string[]
}

export type NewCard = Omit<Card, "id" | "createdAt"> & Partial<Pick<Card, "id" | "createdAt">>
export type NewMark = Omit<Mark, "id" | "createdAt" | "status"> & Partial<Pick<Mark, "id" | "createdAt" | "status">>

export type FsChangeKind = "story" | "state" | "manifest" | "review" | "plans" | "board"
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
  /** Write card positions (passage id -> [x, y]) into the story file passage headers. Only the given passages change. */
  savePositions(rel: string, positions: Record<string, [number, number]>): Promise<void>
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
  // storyboard canvas
  /** Open (and on first use create) a board; its folder is watched from then on. */
  boardOpen(name: string): Promise<BoardDTO>
  /** One card or mark as it is on disk now; null when it was deleted. */
  boardCard(name: string, cardId: string): Promise<CardDTO | null>
  boardMark(name: string, markId: string): Promise<Mark | null>
  boardSaveCard(name: string, card: NewCard): Promise<CardDTO>
  boardDeleteCard(name: string, cardId: string): Promise<void>
  /** Saves the mark; returns it with the board's open mark count. */
  boardSaveMark(name: string, mark: NewMark): Promise<{ mark: Mark; openMarks: number }>
  boardDeleteMark(name: string, markId: string): Promise<number>
  boardOpenCount(name: string): Promise<number>
  /** Add a passage ("<story>#<id>") or frame (shot id) card at the next free spot. */
  boardPin(name: string, pin: { kind: "passage" | "frame"; ref: string; rev?: string }): Promise<CardDTO>
  /** Pick an image file to import; null when cancelled. */
  boardPickImage(): Promise<{ token: string; fileName: string } | null>
  /** Copy the picked image into .river/refs/<hash>.<ext> and add a ref card. */
  boardAddRef(name: string, token: string, source: { title?: string; url?: string; licence: string }, at: { x: number; y: number }): Promise<CardDTO>
  // agent
  agentStatus(): Promise<AgentStatus>
  agentStart(req: AgentStartRequest): Promise<string>
  agentRespond(requestId: string, decision: PermissionDecision): Promise<void>
  agentAbort(turnId: string): Promise<void>
  restoreCheckpoint(ref: string): Promise<void>
  setApiKey(key: string): Promise<AgentStatus>
  clearApiKey(): Promise<AgentStatus>
  setAgentPrefs(p: AgentPrefsUpdate): Promise<AgentStatus>
  /** Re-run `claude auth status` (on window focus, or the Refresh button). */
  refreshAgentStatus(): Promise<AgentStatus>
  /** Open a new terminal window running `claude auth login`. */
  openClaudeSignIn(): Promise<void>
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
