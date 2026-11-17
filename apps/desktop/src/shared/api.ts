/**
 * The contract between main and renderer. Plain JSON only: the renderer never imports
 * runtime code from @river/core (it pulls in fs and child_process), only types.
 */
import type {
  AgentBackend,
  AgentEvent,
  JobScript,
  AgentMode,
  AgentModel,
  ClaudeCodeStatus,
  PermissionDecision,
  PermissionRequest,
} from "@river/agent"
import type {
  Card,
  ChangePlan,
  Edge,
  Job,
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

/** Pixel size of an image, read from its header so the card has its final height before the image loads. */
export interface ImageSize {
  w: number
  h: number
}

/** What a card shows, resolved by main (the renderer cannot read stories or captures itself). */
export type CardView =
  | { kind: "frame"; shotId: string; rev?: string; url?: string; size?: ImageSize; missing?: string }
  | { kind: "passage"; story: string; passageId: string; title: string; tags: string[]; lines: string[]; missing?: string }
  | { kind: "ref"; url: string; size?: ImageSize }
  | {
      kind: "concept"
      id: string
      /**
       * Pending card: the job's render (.river/jobs/<job>/render_<variant>.png, or render.png without a variant).
       * Accepted card: concepts/<id>/concept_<variant>.png (or concept.png). Absent until the file exists.
       */
      url?: string
      size?: ImageSize
      /** Only on a pending card. */
      job?: ConceptJob
      /** The pending card's job file could not be read. */
      missing?: string
    }
  /** A pending note is a job's answer note: it carries the job, for the answer's actions. */
  | { kind: "note"; job?: ConceptJob }

export type ConceptJob = Pick<Job, "id" | "status" | "summary" | "error" | "scripts"> & {
  /** The user replied on the mark since this answer, or the job failed: it can be revised. */
  revisable: boolean
}

/** A job and, while it waits for approval, the exact bytes of every script it wants to run. */
export interface JobDTO {
  job: Job
  /** Each with the sha256 of exactly these bytes: approving sends them back, so only the shown scripts can run. */
  scripts?: JobScript[]
  revisable: boolean
}

export interface CardDTO {
  card: Card
  view: CardView
}

export interface BoardDTO {
  name: string
  cards: CardDTO[]
  marks: Mark[]
  edges: Edge[]
  /** Count of marks with status "open" (core openMarks). */
  openMarks: number
  /** Files that did not parse, as "<path>: <message>". */
  errors: string[]
}

export type NewCard = Omit<Card, "id" | "createdAt"> & Partial<Pick<Card, "id" | "createdAt">>
export type NewMark = Omit<Mark, "id" | "createdAt" | "status"> & Partial<Pick<Mark, "id" | "createdAt" | "status">>
export type NewEdge = Omit<Edge, "id" | "createdAt"> & Partial<Pick<Edge, "id" | "createdAt">>

/** An image the user picked, pasted or dropped, held by main until the licence form adds it as a card. */
export interface StagedImage {
  token: string
  fileName: string
}

export type FsChangeKind = "story" | "state" | "manifest" | "review" | "plans" | "board" | "job"
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
  /** Board folder names under .river/boards. */
  boardList(): Promise<string[]>
  /** Open (and on first use create) a board; its folder is watched from then on. */
  boardOpen(name: string): Promise<BoardDTO>
  /** One card, mark or edge as it is on disk now; null when it was deleted. */
  boardCard(name: string, cardId: string): Promise<CardDTO | null>
  boardMark(name: string, markId: string): Promise<Mark | null>
  boardEdge(name: string, edgeId: string): Promise<Edge | null>
  boardSaveEdge(name: string, edge: NewEdge): Promise<Edge>
  boardDeleteEdge(name: string, edgeId: string): Promise<void>
  boardSaveCard(name: string, card: NewCard): Promise<CardDTO>
  boardDeleteCard(name: string, cardId: string): Promise<void>
  /** Saves the mark; returns it with the board's open mark count. */
  boardSaveMark(name: string, mark: NewMark): Promise<{ mark: Mark; openMarks: number }>
  boardDeleteMark(name: string, markId: string): Promise<number>
  /** Add your message to a mark's thread (core replyToMark); returns it with the open mark count. */
  boardReply(name: string, markId: string, text: string): Promise<{ mark: Mark; openMarks: number }>
  boardOpenCount(name: string): Promise<number>
  /** Add a passage ("<story>#<id>") or frame (shot id) card at the next free spot. */
  boardPin(name: string, pin: { kind: "passage" | "frame"; ref: string; rev?: string }): Promise<CardDTO>
  /** Pick an image file to import; null when cancelled. */
  boardPickImage(): Promise<StagedImage | null>
  /** Hold a pasted or dropped image's bytes for boardAddRef. `fileName` gives the type (its extension). */
  boardStageImage(bytes: Uint8Array, fileName: string): Promise<StagedImage>
  /** Copy the staged image into .river/refs/<hash>.<ext> and add a ref card. */
  boardAddRef(name: string, token: string, source: { title?: string; url?: string; licence: string }, at: { x: number; y: number }): Promise<CardDTO>
  // concept jobs
  /** Ask the concept artist about a mark. Runs in the background; progress shows on the mark and its concept card. */
  jobStart(board: string, markId: string): Promise<void>
  jobGet(jobId: string): Promise<JobDTO>
  /** Run every script, each only if its bytes still hash to the sha256 shown (file -> sha256, from jobGet). */
  jobApprove(jobId: string, shas: Record<string, string>): Promise<void>
  /** Keep the rendered options `variants` ("a".."e"), or all of them. */
  jobAccept(jobId: string, variants?: string[]): Promise<void>
  /** `reason`, when given, goes into the project brief so later answers avoid it. */
  jobDismiss(jobId: string, reason?: string): Promise<void>
  /** A new job revising this answer after the user's replies on the mark. Runs in the background like jobStart. */
  jobRevise(jobId: string): Promise<void>
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
