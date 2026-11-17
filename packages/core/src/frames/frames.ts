import { existsSync } from "node:fs"
import { mkdir, readdir, rm } from "node:fs/promises"
import path from "node:path"
import { listBoards, loadBoard } from "../boards/boards"
import { currentRev } from "../git/checkpoint"
import type { Board } from "../boards/types"
import type { Capture, EngineAdapter, Project } from "../project/types"
import { assertSafeId, readJson, writeJsonAtomic } from "../review/store"

const capturesRoot = (root: string) => path.join(root, ".river", "captures")

const capturesDir = (root: string, shotId: string) => {
  assertSafeId("shot", shotId)
  return path.join(capturesRoot(root), shotId)
}

/** Git rev of the game repo, or "unknown" when the root is not a git repo. */
async function revOf(root: string): Promise<string> {
  try {
    return await currentRev(root)
  } catch {
    return "unknown"
  }
}

/**
 * Capture one shot with the adapter into .river/captures/<shotId>/<stamp>/ and write capture.json there.
 * capture.json stores the frame paths relative to the project root, so the folder survives a move;
 * the returned Capture has them absolute. .river/captures is meant to be gitignored in the game repo.
 */
export async function captureShot(project: Project, shotId: string, adapter: EngineAdapter): Promise<Capture> {
  const shot = project.manifest.shots.find((s) => s.id === shotId)
  if (!shot) {
    const ids = project.manifest.shots.map((s) => s.id)
    throw new Error(`river: no shot ${JSON.stringify(shotId)} in the manifest (shots: ${ids.join(", ") || "none yet"})`)
  }
  // Read the rev before the adapter writes anything, so the capture itself never makes it "+dirty".
  const rev = await revOf(project.root)
  const at = new Date().toISOString()
  const outDir = path.join(capturesDir(project.root, shotId), at.replace(/:/g, "-"))
  await mkdir(outDir, { recursive: true })
  const files = await adapter.capture(project, shot, outDir)
  const rel = files.map((f) => path.relative(project.root, f).split(path.sep).join("/"))
  await writeJsonAtomic(path.join(outDir, "capture.json"), { shotId, rev, at, files: rel } satisfies Capture)
  return { shotId, rev, at, files }
}

/**
 * A frame path from capture.json as an absolute path. New captures store it relative to the root. Older ones
 * stored it absolute; when that file is gone (the repo moved), the frame of the same name beside capture.json is used.
 */
function framePath(root: string, captureFolder: string, file: string): string {
  if (!path.isAbsolute(file)) return path.join(root, file)
  return existsSync(file) ? file : path.join(captureFolder, path.basename(file))
}

async function capturesIn(root: string, shotId: string): Promise<(Capture & { folder: string })[]> {
  const dir = capturesDir(root, shotId)
  let entries: import("node:fs").Dirent[]
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return []
    throw err
  }
  const captures: (Capture & { folder: string })[] = []
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const folder = path.join(dir, entry.name)
    const capture = await readJson<Capture | undefined>(path.join(folder, "capture.json"), undefined)
    if (capture) captures.push({ ...capture, files: capture.files.map((f) => framePath(root, folder, f)), folder })
  }
  return captures.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0))
}

/** Captures of one shot, newest first, with absolute frame paths. */
export async function listCaptures(project: Project, shotId: string): Promise<Capture[]> {
  return (await capturesIn(project.root, shotId)).map(({ folder: _, ...c }) => c)
}

/** The capture a frame card shows: the one it names, else the newest at its rev, else the newest. */
export function captureForCard<C extends Capture>(captures: C[], card: { capture?: string | undefined; rev?: string | undefined }): C | undefined {
  if (card.capture) return captures.find((c) => c.at === card.capture)
  if (card.rev) return captures.find((c) => c.rev === card.rev)
  return captures[0]
}

/** For each frame card of the board, the PNG it shows, relative to the root. Cards whose capture or frame is gone are left out. */
export async function frameCardFiles(root: string, board: Board): Promise<Record<string, string>> {
  const out: Record<string, string> = {}
  const byShot = new Map<string, Capture[]>()
  for (const card of board.cards) {
    if (card.kind !== "frame") continue
    let captures = byShot.get(card.ref)
    if (!captures) {
      captures = await capturesIn(root, card.ref).catch(() => [])
      byShot.set(card.ref, captures)
    }
    const file = captureForCard(captures, card)?.files[card.frame ?? 0]
    if (file) out[card.id] = path.relative(root, file).split(path.sep).join("/")
  }
  return out
}

export interface PrunedCapture { shotId: string; at: string; rev: string }

/**
 * Delete all but the newest `keep` captures of each shot under .river/captures. A capture that a frame card
 * pins (by its time, or as the newest at the card's rev) is kept, so pruning never empties a pinned card.
 * With dryRun nothing is deleted. Returns what was (or would be) deleted and the pinned captures it kept.
 */
export async function pruneCaptures(project: Project, keep: number, opts?: { dryRun?: boolean }): Promise<{ removed: PrunedCapture[]; pinned: PrunedCapture[] }> {
  let shotIds: string[]
  try {
    shotIds = (await readdir(capturesRoot(project.root), { withFileTypes: true })).filter((e) => e.isDirectory()).map((e) => e.name)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return { removed: [], pinned: [] }
    throw err
  }
  const boards = await Promise.all((await listBoards(project.root)).map((b) => loadBoard(project.root, b)))
  const pins = boards.flatMap((b) => b.cards).filter((c) => c.kind === "frame" && (c.capture || c.rev))
  const removed: PrunedCapture[] = []
  const pinned: PrunedCapture[] = []
  for (const shotId of shotIds.sort()) {
    const captures = await capturesIn(project.root, shotId)
    const shown = new Set(pins.filter((c) => c.ref === shotId).map((c) => captureForCard(captures, c)?.folder))
    for (const c of captures.slice(keep)) {
      const entry = { shotId, at: c.at, rev: c.rev }
      if (shown.has(c.folder)) { pinned.push(entry); continue }
      removed.push(entry)
      if (!opts?.dryRun) await rm(c.folder, { recursive: true, force: true })
    }
  }
  return { removed, pinned }
}
