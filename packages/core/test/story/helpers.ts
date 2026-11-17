import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { parseTwee3 } from "../../src/formats/twee3"
import type { StateSchema } from "../../src/story/types"

export const exampleRoot = fileURLToPath(new URL("../../../../examples/park-walk/", import.meta.url))

export function loadExample() {
  const text = readFileSync(`${exampleRoot}stories/park_walk.twee`, "utf8")
  const schema = JSON.parse(readFileSync(`${exampleRoot}stories/state.json`, "utf8")) as StateSchema
  return { text, schema, ...parseTwee3(text, "stories/park_walk.twee") }
}

/** Fields that must survive a write and read. */
export function essence(p: { name: string; tags: string[]; metadata: Record<string, unknown>; rawText: string }) {
  return { name: p.name, tags: p.tags, metadata: p.metadata, rawText: p.rawText }
}
