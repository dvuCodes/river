/**
 * The storyboard canvas. A board is a FOLDER, one JSON file per card and per mark:
 *
 *   .river/boards/<board>/board.json        { name, createdAt }
 *   .river/boards/<board>/cards/<id>.json   Card
 *   .river/boards/<board>/marks/<id>.json   Mark
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
  text?: string
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

export interface Board {
  name: string
  cards: Card[]
  marks: Mark[]
}

/**
 * A job: one agent working on one mark, on its own branch, in its own worktree.
 * Stored in the workspace at .river/jobs/<id>.json.
 *
 * The job's base is a checkpoint commit of the user's working tree (so uncommitted
 * edits are included). Accept applies the diff base..head onto the user's working
 * tree with a three-way apply, so a dirty tree is fine; conflicts send the job back.
 */
export interface Job {
  id: string
  markId: string
  board: string
  role: string
  model: string
  backend: "api-key" | "claude-code"
  status: "queued" | "running" | "answered" | "accepted" | "dismissed" | "failed"
  /** Commit the worktree started from (a checkpoint of the user's tree). */
  baseSha: string
  branch: string
  /** Absolute path of the worktree (under .river/worktrees/, excluded from git). */
  worktree: string
  /** Agent session, for revisions. */
  sessionId?: string
  /** Scripts the job wants to run (e.g. concepts/<id>/draw.gd) and whether the user approved their current content. */
  scripts?: { file: string; sha256: string; approved: boolean }[]
  error?: string
  createdAt: string
  updatedAt: string
}
