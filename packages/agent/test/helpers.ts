import { execFileSync } from "node:child_process"
import { cpSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

export const EXAMPLE = fileURLToPath(new URL("../../../examples/park-walk", import.meta.url))

/** A temp git repo with a copy of examples/park-walk. */
export function tempGame(): string {
  const root = mkdtempSync(path.join(tmpdir(), "river-agent-"))
  cpSync(EXAMPLE, root, { recursive: true })
  execFileSync("git", ["init", "-q"], { cwd: root })
  return root
}

export function removeDir(dir: string): void {
  rmSync(dir, { recursive: true, force: true, maxRetries: 3 })
}
