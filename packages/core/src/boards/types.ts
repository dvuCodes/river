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
   * - note:    unused (text is in `text`). A writing job's take is a note card with `label`, `caption` and `pending`.
   */
  ref: string
  rev?: string
  /** Frame cards: the capture shown, by its time (Capture.at). Absent: the newest capture (at `rev`, when set). */
  capture?: string
  /** Frame cards: which frame of the capture, from 0. Absent: the first. */
  frame?: number
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
  /** The mark's newest job that is not dismissed (or the newest job, once all are). River keeps it and `status` in step with its jobs. */
  jobId?: string
  /** An agent working the mark without a River job (mark_claim), such as "claude-code". */
  claimedBy?: string
  /** When claimedBy took the mark, refreshed by the claimant's replies. A claim older than CLAIM_STALE_MS can be taken over. */
  claimedAt?: string
  createdAt: string
}

/** A claim nobody refreshed for this long is abandoned: another agent may take the mark over. */
export const CLAIM_STALE_MS = 30 * 60_000

/** The status changes a reply can make: an agent answers, gives back or dismisses; the user can also accept. */
export type MarkStatusChange = "answered" | "open" | "dismissed" | "accepted"

/** The role River's concept jobs write as. */
export const CONCEPT_ROLE = "concept-artist"

/** The role River's writing jobs write as. */
export const WRITER_ROLE = "story-writer"

/** Names an agent may not write as: the user, and River's own job roles. */
export const RESERVED_AUTHORS: readonly string[] = ["you", CONCEPT_ROLE, WRITER_ROLE]

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
 * approval   the agent wrote its scripts; nothing runs them until the user approves every script's exact bytes (sha256)
 * rendering  River runs the approved bytes in a sandbox Godot project, one script at a time
 * answered   at least one render is on the canvas as a faded card (a script that failed to render says why)
 * accepted   the job's files are applied to the user's checkout (terminal)
 * dismissed  thrown away (terminal)
 * failed     something broke; `error` says what. Can still be dismissed.
 */
export type JobStatus = "queued" | "running" | "approval" | "rendering" | "answered" | "accepted" | "dismissed" | "failed"

/** Legal moves. Dismiss is allowed from every non-terminal state, so a stuck job never leaves an undismissable card. */
export const JOB_NEXT: Record<JobStatus, readonly JobStatus[]> = {
  queued: ["running", "failed", "dismissed"],
  running: ["approval", "answered", "failed", "dismissed"],
  approval: ["rendering", "failed", "dismissed"],
  rendering: ["answered", "failed", "dismissed"],
  answered: ["accepted", "dismissed", "failed"],
  failed: ["dismissed"],
  accepted: [],
  dismissed: [],
}

/** How River's run of one approved script went. */
export type ScriptRender = { ok: true } | { ok: false; error: string }

/** One script of a job. */
export interface JobScriptRecord {
  /** concepts/<conceptId>/draw.gd, or draw_<v>.gd for an option, relative to the project root. */
  file: string
  sha256: string
  approved: boolean
  /** "a".."e" for draw_a.gd..draw_e.gd; absent for a single draw.gd. Its card is labelled with the upper-case letter. */
  variant?: string
  /** The agent's one-line caption for this option, shown under its card. */
  caption?: string
  /** Set once River has run the approved bytes. A failed render keeps Godot's output here; the other options still show. */
  render?: ScriptRender
  /** The user kept this option at accept: its script and render are in the checkout. */
  accepted?: boolean
}

/**
 * One take of a writing job: a version of the passages the job rewrites. On the board a take is a "note" card
 * with `label` (the variant letter), `caption`, and `pending` until the user accepts it.
 */
export interface WritingTakeRecord {
  /** "a".."e". */
  variant: string
  /** The agent's one-line caption for this take. */
  caption?: string
  /** The take's story file, relative to the project root (in the job's worktree until accepted). */
  file: string
  /** What the take changes, in a sentence or two. */
  summary?: string
  /** The user kept this take at accept. */
  accepted?: boolean
  /** `lint` errors and warnings in the take's story, counted when the take was written. */
  lintErrors?: number
  lintWarnings?: number
}

/** What a job makes: concept art scripts (the default) or story text. */
export type JobKind = "concept" | "writing"

/** A job's kind, with the default for jobs that have none. */
export const jobKind = (job: Pick<Job, "kind">): JobKind => job.kind ?? "concept"

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
 * Stored in the workspace at .river/jobs/<id>.json; its renders at .river/jobs/<id>/render.png, or render_<v>.png per option.
 *
 * The job's base is a snapshot commit of the user's working tree, so uncommitted edits are
 * included. The worktree lives in the git common dir (<.git>/river/worktrees/<id>), outside the
 * game folder, so neither Godot nor `git add` sees it. The job only ever commits, diffs and applies
 * `concepts/<conceptId>/`, so stale board or job files in the checkpoint never travel back at Accept.
 */
export interface Job {
  id: string
  /** Absent means "concept" (jobs written before writing jobs existed have none). */
  kind?: JobKind
  markId: string
  board: string
  role: string
  model: string
  backend: "api-key" | "claude-code"
  status: JobStatus
  /** Folder name under concepts/ that this job owns. Writing jobs keep an id here too, for the job's own files. */
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
   * One approval covers all of them.
   */
  scripts?: JobScriptRecord[]
  /** Writing jobs: the story file the job rewrites, relative to the project root. */
  storyFile?: string
  /** Writing jobs: ids of the passages the job may change. */
  passageIds?: string[]
  /** Writing jobs: the takes the agent wrote, one card each. */
  takes?: WritingTakeRecord[]
  /** The job this one revises (the user replied on the mark after that job answered, or it failed). */
  parentJobId?: string
  error?: string
  createdAt: string
  updatedAt: string
}
