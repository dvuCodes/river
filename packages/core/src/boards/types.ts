/**
 * The storyboard canvas. A board is a FOLDER, one JSON file per card and per mark:
 *
 *   .river/boards/<board>/board.json        { name, createdAt }
 *   .river/boards/<board>/cards/<id>.json   Card
 *   .river/boards/<board>/marks/<id>.json   Mark
 *   .river/boards/<board>/edges/<id>.json   Edge
 *
 * One file per entity means the app, an agent's river-mcp and Claude Code can all
 * write the same board at once without losing each other's changes (each write is
 * an atomic rename of one small file).
 *
 * Boards, marks, jobs and captures always live in the USER's checkout (the workspace
 * root), never on a job branch. A job branch only carries game content: concepts/,
 * stories/, data/, tools/shots/.
 */

export type CardKind = "frame" | "passage" | "ref" | "concept" | "note"

export interface Card {
  id: string
  kind: CardKind
  x: number
  y: number
  /** Width in board units. Height follows the content. */
  w: number
  /**
   * What the card shows:
   * - frame:   shot id (the newest capture is shown; `rev` pins one)
   * - passage: "<story file>#<passage id>"
   * - ref:     image path relative to the workspace root (.river/refs/...)
   * - concept: concept id (concepts/<id>/)
   * - note:    unused (text is in `text`)
   */
  ref: string
  rev?: string
  /** A note's text. */
  text?: string
  /** One or two lines shown under an image card ("storage jar (Met, PD)", "B - Stand: wrapped in the shadow"). */
  caption?: string
  /** Short option label shown as a badge, e.g. "A". Agents label the options in a row of answers. */
  label?: string
  /** Concept cards: which variant of the concept's scripts this card shows ("a".."e"); absent for a single draw.gd. */
  variant?: string
  /** Where a reference image came from. Required for kind "ref". */
  source?: { url?: string; title?: string; licence: string }
  /** "you", a role name such as "concept-artist", or "claude-code". */
  madeBy: string
  /** Present while the card is an unaccepted agent answer: drawn faded. */
  pending?: { markId: string; jobId: string }
  createdAt: string
}

export type MarkShape = "pen" | "circle" | "note" | "arrow" | "pin"

export interface MarkMessage {
  by: string
  at: string
  text: string
}

export type MarkStatus = "open" | "working" | "answered" | "accepted" | "dismissed"

export interface Mark {
  id: string
  shape: MarkShape
  /** Points in board units: [x1, y1, x2, y2, ...]. A circle is its outline stroke; a pin is one point. */
  path: number[]
  /**
   * Pen marks made of several strokes (the pen lifted in between): the point index in `path`
   * where each stroke after the first starts. Absent or empty means one continuous stroke.
   */
  breaks?: number[]
  /** Ids of the cards under or next to the mark. */
  anchors: string[]
  /** The request text (a note's text, or text written next to a pen stroke). */
  thread: MarkMessage[]
  status: MarkStatus
  /** "you", or a reviewer role such as "frame-critic". */
  madeBy: string
  /** The job working on this mark, if any. */
  jobId?: string
  createdAt: string
}

/**
 * A connector drawn as a curved arrow from one card or mark to another. Users draw them with the arrow tool;
 * agents draw them from a request to their answer, and between the frames of a sequence.
 */
export interface Edge {
  id: string
  /** Card or mark id. */
  from: string
  /** Card or mark id. */
  to: string
  label?: string
  madeBy: string
  createdAt: string
}

export interface Board {
  name: string
  cards: Card[]
  marks: Mark[]
  edges: Edge[]
}

/**
 * queued     created, worktree not ready yet
 * running    the agent turn is running in the worktree
 * approval   the agent wrote a script; nothing runs it until the user approves its exact bytes (sha256)
 * rendering  River runs the approved bytes in a sandbox Godot project
 * answered   the render is on the canvas as a faded card
 * accepted   the job's files are applied to the user's checkout (terminal)
 * dismissed  thrown away (terminal)
 * failed     something broke; `error` says what. Can still be dismissed.
 */
export type JobStatus = "queued" | "running" | "approval" | "rendering" | "answered" | "accepted" | "dismissed" | "failed"

/** Legal moves. Dismiss is allowed from every non-terminal state, so a stuck job never leaves an undismissable card. */
export const JOB_NEXT: Record<JobStatus, readonly JobStatus[]> = {
  queued: ["running", "failed", "dismissed"],
  running: ["approval", "failed", "dismissed"],
  approval: ["rendering", "failed", "dismissed"],
  rendering: ["answered", "failed", "dismissed"],
  answered: ["accepted", "dismissed", "failed"],
  failed: ["dismissed"],
  accepted: [],
  dismissed: [],
}

/** The mark's status while its job is in each state. */
export const MARK_STATUS_FOR_JOB: Record<JobStatus, MarkStatus> = {
  queued: "working",
  running: "working",
  approval: "working",
  rendering: "working",
  answered: "answered",
  accepted: "accepted",
  dismissed: "dismissed",
  failed: "open",
}

/**
 * A job: one agent working on one mark, on its own branch, in its own worktree.
 * Stored in the workspace at .river/jobs/<id>.json; its render at .river/jobs/<id>/render.png.
 *
 * The job's base is a snapshot commit of the user's working tree, so uncommitted edits are
 * included. The worktree lives in the git common dir (<.git>/river/worktrees/<id>), outside the
 * game folder, so neither Godot nor `git add` sees it. The job only ever commits, diffs and applies
 * `concepts/<conceptId>/`, so stale board or job files in the checkpoint never travel back at Accept.
 */
export interface Job {
  id: string
  markId: string
  board: string
  role: string
  model: string
  backend: "api-key" | "claude-code"
  status: JobStatus
  /** Folder name under concepts/ that this job owns. */
  conceptId: string
  /** Commit the worktree started from (a checkpoint of the user's tree). */
  baseSha: string
  /** Last commit on the job branch (set once the agent's files are committed). */
  headSha?: string
  /** river/job/<id>. River works the branch and worktree out from the id, not from these two fields. */
  branch: string
  /** Absolute path of the worktree's top level when it was made; stale once the user moves the repo. */
  worktree: string
  /** Project root inside the worktree, relative to the git top level ("" when river.json is at the top). */
  projectSub: string
  /** Agent session, for revisions. */
  sessionId?: string
  /** The agent's closing message, shown on the card. */
  summary?: string
  /**
   * The scripts the job wants to run and whether the user approved exactly these bytes. One `draw.gd`, or up to
   * five variants `draw_a.gd`..`draw_e.gd`; `variant` is "a".."e" for those, and each variant gets its own card.
   */
  scripts?: { file: string; sha256: string; approved: boolean; variant?: string }[]
  /** The job this one revises (the user replied on the mark after that job answered). */
  parentJobId?: string
  error?: string
  createdAt: string
  updatedAt: string
}
