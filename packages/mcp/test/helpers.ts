import { cpSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

const example = fileURLToPath(new URL("../../../examples/park-walk/", import.meta.url))

/** A temp copy of examples/park-walk with a data file to edit. */
export function tempProject(): string {
  const dir = mkdtempSync(join(tmpdir(), "river-mcp-"))
  cpSync(example, dir, { recursive: true })
  mkdirSync(join(dir, "data"))
  writeFileSync(join(dir, "data/tuning.txt"), "walk_speed = 4.0\nball_throw = 12\nball_throw_alt = 12\nball_throw = 12\n")
  return dir
}
