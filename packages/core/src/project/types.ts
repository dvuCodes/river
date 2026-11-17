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
  /** Absolute paths of the PNG files, in frame order. */
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
  /** Check the state schema against the game's own definitions. Optional. */
  checkSchema?(project: Project): Promise<{ ok: boolean; messages: string[] }>
}
