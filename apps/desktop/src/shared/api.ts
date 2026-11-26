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
  CheckDataResult,
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

/** The canvas's look: paper (the default), dark, or whatever the OS uses. The rest of the app follows the OS. */
export type CanvasTheme = "paper" | "dark" | "system"
export const CANVAS_THEMES: readonly CanvasTheme[] = ["paper", "dark", "system"]

export interface ProjectInfo {
  root: string
  name: string
  /** The board to open: the one last open in this project if it still exists, else "main" or the first board. */
  board: string
  engine: string
  stories: string[]
  shots: ShotDef[]
  /** river.json names a checkData command (the Story map's Check data button runs it). */
  hasCheckData?: boolean
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
  /** "return": an interrupt route that ends by taking its `@return` choice. */
  end: "ending" | "dead-end" | "loop" | "return"
  satisfiable: boolean
  conditions: string[]
}

export interface PathsResultDTO {
  /** Routes from the start passage. */
  routes: PathDTO[]
  /** Routes through each interrupt passage, from its entry to `@return` (or an ending, dead end or loop). */
  interrupts: PathDTO[]
  /** The route limit (500 per list) cut either list short. */
  truncated: boolean
}

export interface PlayChoiceDTO {
  label: string
  target: string
  open: boolean
  when?: string
  /** The choice's `@hint`, a short line a game shows with the option. */
  hint?: string
  /** Why a closed choice is closed: its @when, what its @cost needs, its target's @when on arrival, or "already chosen". */
  closedReason?: string
  broken: boolean
}

export interface PlayInterruptDTO {
  id: string
  name: string
  /** Can start now: its @when holds, no interrupt is running, and the story has not ended. */
  open: boolean
  when?: string
}

export interface PlayStoryletDTO {
  id: string
  name: string
  open: boolean
  weight: number
  priority: number
  cooldownLeft: number
}

export interface OpenStateDTO {
  passages: Record<string, boolean>
  choices: Record<string, boolean[]>
}

export interface PlaySnapshot {
  sessionId: string
  passage: PassageDTO
  /** The passage prose with its templates ({when}, {var}, {once}, {cycle}…) filled in for this state and visit. */
  renderedText: string
  choices: PlayChoiceDTO[]
  /** The story's interrupt passages and whether each can start now. */
  interrupts: PlayInterruptDTO[]
  /** The story's storylet passages, with whether each can be drawn now, its weight, priority and cooldown. */
  storylets?: PlayStoryletDTO[]
  /** An interrupt is running: a `@return` choice goes back to where it started. */
  inInterrupt: boolean
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
  /** Models River knows by name (@river/agent KNOWN_MODELS), for the pickers. Any other safe model id is accepted too. */
  knownModels: AgentModel[]
  /** The model for self-check turns (the look at renders, the table read). Absent: the job's own model. */
  selfCheckModel?: AgentModel
  claudePath?: string
  /** After Godot renders a job's scripts, one more short turn looks at the pictures and may rewrite the note and captions. */
  selfCheck: boolean
  /** Only installed / version / loggedIn / authMethod / subscriptionType. Null while unknown. */
  claudeCode: ClaudeCodeStatus | null
}

export interface AgentPrefsUpdate {
  backend?: AgentBackend
  model?: AgentModel
  /** Empty string clears it (self-check turns use the job's own model). */
  selfCheckModel?: AgentModel
  /** Empty string clears it (use PATH). */
  claudePath?: string
  selfCheck?: boolean
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
  | { kind: "frame"; shotId: string; rev?: string; frame?: number; url?: string; size?: ImageSize; missing?: string }
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
  /** "writing" for a story writer's job; absent or "concept" for the concept artist's. */
  kind?: "concept" | "writing"
  /** Writing jobs: the takes the writer offered, one note card each. */
  takes?: Job["takes"]
  /** The user replied on the mark since this answer, or the job failed: it can be revised. */
  revisable: boolean
  /** The agent is looking at the renders this app approved (the job is still "rendering"); jobStopLook ends it. */
  looking?: boolean
  /** The job has a runner log, .river/logs/<job>.log (jobs started outside the app by concept_request). */
  log?: boolean
}

export interface JobDTO {
  job: Job
  revisable: boolean
}

/**
 * A card as River writes it. Frame cards in a strip also name their capture (its `at`) and frame index, since a rev
 * can have several captures and a capture several frames. Core's Card does not declare these two fields yet.
 */
export type BoardCard = Card & { capture?: string; frame?: number }

export interface CardDTO {
  card: BoardCard
  view: CardView
}

/** Frames of one capture to put on a board as a row joined by connectors. */
export interface FrameStrip {
  shotId: string
  /** The capture's `at`. */
  capture: string
  /** Frame indices, in the order they go on the board. */
  frames: number[]
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

export type NewCard = Omit<BoardCard, "id" | "createdAt"> & Partial<Pick<BoardCard, "id" | "createdAt">>
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
  paths(rel: string): Promise<PathsResultDTO>
  openState(rel: string, state: GameState): Promise<OpenStateDTO>
  /** Add a passage (name, optional tags, raw body text) to the story file. */
  addPassage(rel: string, name: string, rawText: string, tags?: string[]): Promise<StoryDTO>
  /** Replace a passage's tags. */
  setPassageTags(rel: string, passageId: string, tags: string[]): Promise<StoryDTO>
  /** Remove a passage (never the start passage). Links to it are left as written; lint reports them. */
  deletePassage(rel: string, passageId: string): Promise<StoryDTO>
  /** Write the story's JSON export to `<manifest export folder>/<stem>.json`. */
  exportStory(rel: string): Promise<{ outFile: string; passageCount: number }>
  /** Run river.json's checkData command after a fresh export of every story. */
  checkData(): Promise<CheckDataResult>
  // playtest
  playStart(rel: string, from?: string): Promise<PlaySnapshot>
  playChoose(sessionId: string, index: number): Promise<PlaySnapshot>
  playUndo(sessionId: string): Promise<PlaySnapshot>
  playSetVar(sessionId: string, name: string, value: number | string | boolean): Promise<PlaySnapshot>
  /** Start an interrupt passage (by name) from the current passage. */
  playInterrupt(sessionId: string, name: string): Promise<PlaySnapshot>
  /** Draw one open storylet from the deck. */
  playDrawStorylet(sessionId: string): Promise<PlaySnapshot>
  // frames and review
  frames(): Promise<FramesDTO>
  capture(shotId: string): Promise<CaptureDTO>
  /** Capture every shot in river.json (one engine call when the adapter can batch). */
  captureAll(): Promise<CaptureDTO[]>
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
  /** Several cards at once, resolved together (each story file and capture folder is read once). Null for a deleted card. */
  boardCards(name: string, cardIds: string[]): Promise<Record<string, CardDTO | null>>
  boardMark(name: string, markId: string): Promise<Mark | null>
  boardEdge(name: string, edgeId: string): Promise<Edge | null>
  boardSaveEdge(name: string, edge: NewEdge): Promise<Edge>
  boardDeleteEdge(name: string, edgeId: string): Promise<void>
  boardSaveCard(name: string, card: NewCard): Promise<CardDTO>
  boardDeleteCard(name: string, cardId: string): Promise<void>
  /**
   * Saves a mark under its lock. A new mark is written whole; for one already on disk only its shape, path, breaks and
   * anchors come from `mark`, and its thread, status, job and claim stay as an agent may have just written them.
   * Returns the mark as saved, with the board's open mark count.
   */
  boardSaveMark(name: string, mark: NewMark): Promise<{ mark: Mark; openMarks: number }>
  boardDeleteMark(name: string, markId: string): Promise<number>
  /** Add your message to a mark's thread (core replyToMark); returns it with the open mark count. */
  boardReply(name: string, markId: string, text: string): Promise<{ mark: Mark; openMarks: number }>
  /** Close a mark that follows no job: dismissed (`text` says why) or accepted as resolved. `text` joins the thread when not empty. */
  boardCloseMark(name: string, markId: string, status: "dismissed" | "accepted", text: string): Promise<{ mark: Mark; openMarks: number }>
  boardOpenCount(name: string): Promise<number>
  /** Rename a board's folder (and the jobs that point at it). Refused while one of its jobs is still working. */
  boardRename(from: string, to: string): Promise<void>
  /** Move a board's folder to the OS trash. Refused for the last board, or while one of its jobs is still working. Returns the boards left. */
  boardDelete(name: string): Promise<string[]>
  /** Frame cards for `strip.frames`, captioned, in a row at a free spot, each joined to the next by a connector. */
  boardAddFrames(name: string, strip: FrameStrip): Promise<CardDTO[]>
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
  /** Open the approval window for a job waiting for approval: main reads its scripts and shows them there. */
  jobReview(jobId: string): Promise<void>
  /**
   * Always refused: main runs a job's scripts only on a Run from the approval window. River's window keeps the call so
   * the refusal is checked through the same channel the approval window uses.
   */
  jobApprove(jobId: string, shas: Record<string, string>): Promise<void>
  /** Keep the rendered options `variants` ("a".."e"), or all of them. */
  jobAccept(jobId: string, variants?: string[]): Promise<void>
  /** `reason`, when given, goes into the project brief so later answers avoid it. */
  jobDismiss(jobId: string, reason?: string): Promise<void>
  /** A new job revising this answer after the user's replies on the mark. Runs in the background like jobStart. */
  jobRevise(jobId: string): Promise<void>
  /** End the agent's look at the renders; the job is answered with its note as first written. */
  jobStopLook(jobId: string): Promise<void>
  /** The runner's output for a job started outside the app (.river/logs/<job>.log); null when there is none. */
  jobLog(jobId: string): Promise<string | null>
  // writing jobs (the story writer answers a mark with takes, one note card each)
  /** Ask the story writer about a mark. Runs in the background like jobStart. */
  writeJobStart(board: string, markId: string): Promise<void>
  /** New takes answering the user's replies on the mark. */
  writeJobRevise(jobId: string): Promise<void>
  /** Apply take `variant` ("a".."e") to the story file. `saveExemplar` (default true) keeps a line of it in .river/voice.md. */
  writeJobAccept(jobId: string, variant: string, saveExemplar?: boolean): Promise<void>
  /** `reason`, when given, goes into .river/voice.md under "Lines we cut". */
  writeJobDismiss(jobId: string, reason?: string): Promise<void>
  // agent
  agentStatus(): Promise<AgentStatus>
  agentStart(req: AgentStartRequest): Promise<string>
  agentRespond(requestId: string, decision: PermissionDecision): Promise<void>
  agentAbort(turnId: string): Promise<void>
  restoreCheckpoint(ref: string): Promise<void>
  setApiKey(key: string): Promise<AgentStatus>
  clearApiKey(): Promise<AgentStatus>
  setAgentPrefs(p: AgentPrefsUpdate): Promise<AgentStatus>
  canvasTheme(): Promise<CanvasTheme>
  setCanvasTheme(t: CanvasTheme): Promise<void>
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
