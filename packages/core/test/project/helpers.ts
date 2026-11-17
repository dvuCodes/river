import { execFileSync } from "node:child_process"
import { mkdtempSync, realpathSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import type { Project, RiverManifest } from "../../src/project/types"

export function tempDir(prefix = "river-test-"): string {
  return realpathSync.native(mkdtempSync(path.join(tmpdir(), prefix)))
}

export function removeDir(dir: string): void {
  rmSync(dir, { recursive: true, force: true, maxRetries: 3 })
}

export function manifest(over: Partial<RiverManifest> = {}): RiverManifest {
  return {
    name: "test-game",
    engine: "godot",
    stories: "stories",
    state: "data/state.json",
    export: "data/export",
    adapter: { godot: { bin: "$GODOT_BIN" } },
    shots: [{ id: "walk", scene: "res://walk.tscn", setup: "res://tools/shots/walk.gd", count: 1 }],
    ...over,
  }
}

export function project(root: string, over: Partial<RiverManifest> = {}): Project {
  return { root, manifest: manifest(over) }
}

/** Run git in `cwd` with a dummy identity and no line-ending conversion. */
export function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-c", "core.autocrlf=false", ...args], {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "River Test",
      GIT_AUTHOR_EMAIL: "test@example.invalid",
      GIT_COMMITTER_NAME: "River Test",
      GIT_COMMITTER_EMAIL: "test@example.invalid",
    },
  })
}

export function initRepo(dir: string): void {
  git(dir, "init", "-q", "-b", "main")
  git(dir, "config", "user.name", "River Test")
  git(dir, "config", "user.email", "test@example.invalid")
  git(dir, "config", "core.autocrlf", "false")
}
