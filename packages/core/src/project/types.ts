/**
 * The project manifest (river.json at the game repo root), frames, review threads,
 * change plans and engine adapters. All of these are files in the game repo, so git,
 * Claude Code and the in-app agent can read them.
 */

/** One deterministic shot: a scene, a setup script that freezes it, and how many frames to save. */
export interface ShotDef {
  id: string
  /** Engine path of the scene, e.g. "res://scenes/level_1.tscn". */
  scene: string
  /** Engine path of the setup script, e.g. "res://tools/shots/intro_frozen.gd". */
  setup?: string
  /** 1 = a single screenshot. More than 1 = consecutive frames. */
  count: number
  /** Physics ticks between consecutive frames. */
  ticks?: number
  /** Free text that the review board shows under the shot. */
  note?: string
  /** Seconds the engine may take before River stops it. Default: 60 plus half a second per frame. */
  timeoutS?: number
}

export interface RiverManifest {
  name: string
  /** Adapter id, e.g. "godot". */
  engine: string
  /** Folder of .twee stories, relative to the root. */
  stories: string
  /** State schema file, relative to the root. */
  state: string
  /** Folder that `river export` writes JSON to, relative to the root. */
  export: string
  /** Adapter settings. Values can reference environment variables as "$NAME". */
  adapter: Record<string, Record<string, string>>
  shots: ShotDef[]
  /**
   * Globs (relative to the root) that a change plan can name for the implementer.
   * Default: ["data/**", "tools/shots/**"].
   */
  editable?: string[]
  /**
   * A command `river lint` and `river check-data` run from the root after a fresh export, to compare the
   * story with the game's own data, e.g. "node tools/check_story.mjs". It gets RIVER_ROOT and RIVER_EXPORT_DIR
   * (a temporary folder holding <story>.json for every story); a non-zero exit is a lint error.
   */
  checkData?: string
  /**
   * Copy budgets by passage tag ("*" applies to every passage): how long a title, body, choice label or hint
   * may be before `lintNarrative` warns (copy-budget-exceeded). Body lengths count the longest text the prose's templates can render.
   */
  copyBudgets?: Record<string, CopyBudget>
}

/** Limits on the copy a passage shows, so it fits the game's text box. */
export interface CopyBudget {
  /** Characters in the passage name. */
  titleChars?: number
  /** Characters in the prose (rule, link and cue lines removed), at its longest template variant. */
  bodyChars?: number
  /** Non-blank lines in the prose. */
  bodyLines?: number
  /** Characters in each choice label. */
  choiceLabelChars?: number
  /** Characters in each choice @hint. */
  hintChars?: number
}

/** A project after load: the manifest plus the absolute root. */
export interface Project {
  root: string
  manifest: RiverManifest
}

/** One capture run of one shot. */
export interface Capture {
  shotId: string
  /** Git short SHA of the game repo at capture time, plus "+dirty" if the tree had changes. */
  rev: string
  /** ISO time. */
  at: string
  /** Absolute paths of the PNG files, in frame order. capture.json on disk stores them relative to the root. */
  files: string[]
}

export interface ReviewMessage {
  author: string
  /** ISO time. */
  at: string
  text: string
}

export type ReviewStatus = "open" | "planned" | "accepted" | "done" | "wontfix"

/** One comment thread on a shot. Stored in .river/review/<shotId>.json as ReviewThread[]. */
export interface ReviewThread {
  id: string
  target: {
    shotId: string
    rev: string
    frame?: number
    /** A box on the frame, in pixels: x, y, width, height. */
    box?: [number, number, number, number]
  }
  status: ReviewStatus
  messages: ReviewMessage[]
  /** The change plan that answers this thread, if any. */
  planId?: string
}

/**
 * A change plan. The in-app agent writes it read-only from a review thread.
 * The user approves it. Then an implementer (River's own, or Claude Code through
 * river-mcp) changes ONLY the files the plan names.
 * Stored in .river/plans/<id>.json.
 */
export interface ChangePlan {
  id: string
  threadId?: string
  title: string
  /** Why this change answers the comment. */
  rationale: string
  steps: {
    file: string
    /** What to change in this file, in words. */
    change: string
    /** Optional exact edit the planner proposes. The implementer can refine it. */
    oldText?: string
    newText?: string
  }[]
  /** Shots to capture again after the change, to show before and after. */
  recapture: string[]
  status: "draft" | "approved" | "rejected" | "implemented"
  /** ISO times. */
  createdAt: string
  approvedAt?: string
}

/** What an engine adapter must do. The core knows an engine only through this. */
export interface EngineAdapter {
  id: string
  /** Run the engine to capture one shot into outDir. Resolves to the PNG paths in frame order. */
  capture(project: Project, shot: ShotDef, outDir: string): Promise<string[]>
  /**
   * Optional: capture several shots in one engine run (one start-up instead of one per shot). Each item's outDir
   * already exists. Resolves to shot id -> PNG paths in frame order, with an entry for every item.
   */
  captureBatch?(project: Project, items: { shot: ShotDef; outDir: string }[]): Promise<Record<string, string[]>>
}
