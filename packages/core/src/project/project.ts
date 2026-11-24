import { existsSync, realpathSync } from "node:fs"
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises"
import { dirname, join, relative, resolve, sep } from "node:path"
import { z } from "zod"
import type { Project, RiverManifest } from "./types"
import type { Diagnostic, StateSchema, Story } from "../story/types"
import { parseTwee3, writeTwee3 } from "../formats/twee3"

export const DEFAULT_EDITABLE = ["data/**", "tools/shots/**"]

const ShotSchema = z.object({
  id: z.string().min(1),
  scene: z.string(),
  setup: z.string().optional(),
  count: z.number().int().min(1),
  ticks: z.number().int().min(0).optional(),
  note: z.string().optional(),
  timeoutS: z.number().positive().optional(),
})

const budget = z.number().int().positive().optional()
const CopyBudgetSchema = z.object({
  titleChars: budget,
  bodyChars: budget,
  bodyLines: budget,
  choiceLabelChars: budget,
  hintChars: budget,
})

const ManifestSchema = z.object({
  name: z.string(),
  engine: z.string(),
  stories: z.string(),
  state: z.string(),
  export: z.string(),
  adapter: z.record(z.string(), z.record(z.string(), z.string())).default({}),
  shots: z.array(ShotSchema).default([]),
  editable: z.array(z.string()).default(DEFAULT_EDITABLE),
  checkData: z.string().min(1).optional(),
  copyBudgets: z.record(z.string(), CopyBudgetSchema).optional(),
})

const engine = z.boolean().optional()
const VarDeclSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("number"), min: z.number().optional(), max: z.number().optional(), initial: z.number().optional(), engine }),
  z.object({ type: z.literal("int"), min: z.number().int().optional(), max: z.number().int().optional(), initial: z.number().int().optional(), engine }),
  z.object({ type: z.literal("bool"), initial: z.boolean().optional(), engine }),
  z.object({ type: z.literal("enum"), values: z.array(z.string()).min(1), initial: z.string().optional(), engine }),
])

const StateSchemaSchema = z.record(z.string(), VarDeclSchema)

async function readJson(path: string, what: string): Promise<unknown> {
  let text: string
  try {
    text = await readFile(path, "utf8")
  } catch (e) {
    throw new Error(`cannot read ${what} at ${path}: ${(e as Error).message}`)
  }
  try {
    return JSON.parse(text.replace(/^﻿/, ""))
  } catch (e) {
    throw new Error(`${what} at ${path} is not valid JSON: ${(e as Error).message}`)
  }
}

const WANT = "River wants the game's root folder, the one that holds river.json"

/** Read and validate <root>/river.json. Applies defaults (editable globs). */
export async function loadProject(root: string): Promise<Project> {
  const want = resolve(root)
  if (!existsSync(want)) throw new Error(`no folder at ${want}. ${WANT}`)
  const abs = realpathSync(want)
  const path = join(abs, "river.json")
  if (!existsSync(path)) {
    let up = dirname(abs)
    while (up !== dirname(up) && !existsSync(join(up, "river.json"))) up = dirname(up)
    const near = existsSync(join(up, "river.json")) ? ` (${up} has one)` : ""
    throw new Error(`no river.json in ${abs}${near}. ${WANT}`)
  }
  const parsed = ManifestSchema.safeParse(await readJson(path, "river.json"))
  if (!parsed.success) throw new Error(`river.json at ${path} is invalid:\n${z.prettifyError(parsed.error)}`)
  const manifest: RiverManifest = parsed.data
  return { root: abs, manifest }
}

const caseInsensitive = process.platform === "win32" || process.platform === "darwin"
const norm = (p: string) => (caseInsensitive ? p.toLowerCase() : p)

function isInside(root: string, p: string): boolean {
  const r = norm(root)
  const q = norm(p)
  return q === r || q.startsWith(r.endsWith(sep) ? r : r + sep)
}

/** Resolve rel inside the root. Throws if the result is outside the root (after resolving .. and symlinks). */
export function safePath(project: Pick<Project, "root">, rel: string): string {
  const root = realpathSync(project.root)
  const target = resolve(root, rel)
  // Resolve symlinks on the deepest part of the path that exists.
  let existing = target
  const rest: string[] = []
  while (!existsSync(existing)) {
    const parent = dirname(existing)
    if (parent === existing) break
    rest.unshift(existing.slice(parent.length).replace(/^[\\/]+/, ""))
    existing = parent
  }
  const real = existsSync(existing) ? realpathSync(existing) : existing
  const full = rest.length > 0 ? join(real, ...rest) : real
  if (!isInside(root, full)) throw new Error(`path "${rel}" is outside the project root`)
  return full
}

export async function loadSchema(project: Project): Promise<StateSchema> {
  const path = safePath(project, project.manifest.state)
  const parsed = StateSchemaSchema.safeParse(await readJson(path, "state schema"))
  if (!parsed.success) throw new Error(`state schema at ${path} is invalid:\n${z.prettifyError(parsed.error)}`)
  return parsed.data as StateSchema
}

/** Story files (.twee, .tw) under manifest.stories, relative to the root with forward slashes, sorted. */
export async function listStories(project: Project): Promise<string[]> {
  const dir = safePath(project, project.manifest.stories)
  const root = realpathSync(project.root)
  const out: string[] = []
  const walk = async (d: string) => {
    let entries
    try {
      entries = await readdir(d, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      const p = join(d, e.name)
      if (e.isDirectory()) await walk(p)
      else if (/\.(twee|tw)$/i.test(e.name)) out.push(relative(root, p).split(sep).join("/"))
    }
  }
  await walk(dir)
  return out.sort()
}

function toRel(project: Project, rel: string): string {
  const full = safePath(project, rel)
  return relative(realpathSync(project.root), full).split(sep).join("/")
}

export async function loadStory(project: Project, rel: string): Promise<{ story: Story; diagnostics: Diagnostic[] }> {
  const full = safePath(project, rel)
  const text = await readFile(full, "utf8")
  return parseTwee3(text, toRel(project, rel))
}

/** Write the story file. Throws if rel is outside the root. */
export async function saveStory(project: Project, rel: string, story: Story): Promise<void> {
  const full = safePath(project, rel)
  await mkdir(dirname(full), { recursive: true })
  await writeFile(full, writeTwee3(story), "utf8")
}
