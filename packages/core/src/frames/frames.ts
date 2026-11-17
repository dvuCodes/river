import type { Capture, EngineAdapter, Project } from "../project/types"

/**
 * Capture one shot with the adapter into .river/captures/<shotId>/<stamp>/ and write capture.json there.
 * .river/captures is meant to be gitignored in the game repo.
 */
export function captureShot(project: Project, shotId: string, adapter: EngineAdapter): Promise<Capture> {
  throw new Error("not implemented")
}

/** Captures of one shot, newest first. */
export function listCaptures(project: Project, shotId: string): Promise<Capture[]> {
  throw new Error("not implemented")
}
