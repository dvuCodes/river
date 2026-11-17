/**
 * The River tools, as plain functions over a loaded project. `server.ts` registers them on an
 * MCP server; the in-app agent can register the same list in-process.
 *
 * Every path argument is relative to the project root and goes through core `safePath`.
 * Handlers throw on bad input; the MCP server turns a throw into an `isError` tool result.
 */
import { existsSync } from "node:fs"
import { mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises"
import path from "node:path"
import { conceptScriptProblem, createGodotAdapter, lintConceptScript } from "@river/adapter-godot"
import {
  answerStart,
  assertConceptFile,
  assertConceptId,
  BOARD_GAP,
  besideRect,
  cardHeight,
  cardImageFile,
  cardRect,
  claimMark,
  conceptCaptionName,
  conceptPath,
  DEFAULT_BOARD,
  deleteCard,
  deleteEdge,
  elementRect,
  formatBoard,
  formatClosed,
  formatPathList,
  interruptPaths,
  summarizePaths,
  frameCardFiles,
  captureForCard,
  formatCard,
  formatMark,
  IMAGE_CARD_W,
  jobRenderName,
  listBoards,
  listJobs,
  loadBoard,
  loadCard,
  loadJob,
  markRect,
  newBoardId,
  NOTE_CARD_W,
  occupiedRects,
  openMarks,
  optionLabels,
  parseConceptScriptName,
  placeRow,
  readBrief,
  replyToMark,
  RESERVED_AUTHORS,
  saveCard,
  saveEdge,
  assertEditAllowed,
  captureShot,
  contentPassages,
  createPlaytest,
  formatCond,
  lint,
  listCaptures,
  listPlans,
  listStories,
  listThreads,
  loadPlan,
  loadSchema,
  loadStory,
  normalizeRel,
  parseTwee3,
  passageById,
  paths,
  proseText,
  reply,
  safePath,
  savePlan,
  saveStory,
  setPlanStatus,
  updatePassageText,
} from "@river/core"
import type { Board, Card, ChangePlan, Diagnostic, EngineAdapter, Job, Mark, Passage, Project, StateSchema, Story } from "@river/core"
import { z } from "zod"
import { unifiedDiff } from "./diff"
import { launchConceptJob, type JobLauncher } from "./jobs"

export const READ_TOOL_NAMES = [
  "project_info",
  "story_list",
  "story_read",
  "story_lint",
  "story_paths",
  "playtest_run",
  "frames_list",
  "review_list",
  "plan_list",
  "plan_read",
  "board_read",
  "marks_open",
  "brief_read",
  "card_read",
  "mark_read",
  "card_view",
] as const

export const WRITE_TOOL_NAMES = [
  "story_write_passage",
  "story_add_passage",
  "review_reply",
  "plan_save",
  "implement_edit",
  "plan_mark_implemented",
  "frames_capture",
  "concept_write",
  "mark_claim",
  "mark_reply",
  "board_add_note",
  "board_add_card",
  "board_connect",
  "board_place_row",
  "board_update_note",
  "board_remove_card",
  "concept_request",
] as const

export type RiverToolName = (typeof READ_TOOL_NAMES)[number] | (typeof WRITE_TOOL_NAMES)[number]

export const RIVER_TOOL_NAMES: readonly RiverToolName[] = [...READ_TOOL_NAMES, ...WRITE_TOOL_NAMES]

export interface RiverToolResult {
  /** What the model reads. Complete on its own. */
  text: string
  /** The same result as structured data, for in-process callers (diffs, plan ids, capture files). Never sent over MCP. */
  data?: unknown
  /** Images the model sees after the text (card_view). */
  images?: { data: string; mimeType: string }[]
}

export interface RiverTool {
  name: RiverToolName
  description: string
  /** A zod raw shape (the MCP SDK `inputSchema` form). */
  inputSchema: Record<string, z.ZodType>
  /** True when the tool writes to the game repo. */
  mutating: boolean
  /** Validates the input against inputSchema, then runs. Throws on any error. */
  handler(input: unknown): Promise<RiverToolResult>
}

export interface RiverToolsOptions {
  /** Engine adapter for frames_capture. Default: picked by manifest.engine. */
  adapter?: EngineAdapter
  /** Who this server writes as: review_reply's default author, and madeBy/by on board writes. Default "agent". Never "you", which is the user. */
  author?: string
  /** The concept job this server works for. concept_write exists only when this is set, and writes only in concepts/<conceptId>/. */
  conceptId?: string
  /** How concept_request starts a job in its own process. Default: River's CLI, `river job start`, detached. */
  jobLauncher?: JobLauncher
}

/** The engine adapter for a project, by manifest.engine. */
export function adapterFor(project: Project): EngineAdapter {
  const engine = project.manifest.engine
  if (engine === "godot") return createGodotAdapter()
  if (engine === "none" || engine === "") {
    throw new Error(`river: this project has engine "${engine}" in river.json, so it cannot capture frames (set "engine": "godot" and adapter.godot.bin)`)
  }
  throw new Error(`river: unknown engine "${engine}" in river.json; supported: godot`)
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`

/** Throws for a name an agent may not write as: the user ("you") and River's own job role. */
function assertAgentAuthor(author: string): void {
  const name = author.trim().toLowerCase()
  if (name === "you") throw new Error('river: the author "you" is the user; run the server as an agent role such as "claude-code"')
  if (RESERVED_AUTHORS.includes(name)) throw new Error(`river: "${author}" is River's own role; run the server as an agent role such as "claude-code"`)
}

/** The state schema, one variable per line: type, range and starting value. */
function schemaLines(schema: StateSchema): string[] {
  return Object.entries(schema).map(([name, d]) => {
    const range = d.type === "number" || d.type === "int" ? ` ${d.min ?? "-inf"}..${d.max ?? "inf"}` : d.type === "enum" ? ` (${d.values.join(" | ")})` : ""
    return `  ${name}: ${d.type}${range}, initial ${d.initial === undefined ? "(none)" : String(d.initial)}`
  })
}
const formatDiag = (d: Diagnostic) => `${d.severity.padEnd(6)} ${d.message}`
const diagKey = (d: Diagnostic) => `${d.severity}|${d.code}|${d.message}`

const escapeHeaderPart = (s: string) => s.replace(/[\\[\]{}]/g, (c) => `\\${c}`)

/** Parse one new passage the way the Twee 3 reader will see it in the file. */
function parseOnePassage(name: string, tags: string[], rawText: string, file: string): Passage {
  const header = `:: ${escapeHeaderPart(name)}${tags.length > 0 ? ` [${tags.map(escapeHeaderPart).join(" ")}]` : ""}`
  const body = rawText
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((ln) => (ln.startsWith("::") ? `\\${ln}` : ln))
    .join("\n")
  const passage = parseTwee3(`${header}\n${body}\n`, file).story.passages[0]
  if (!passage || passage.name !== name) throw new Error(`cannot use "${name}" as a passage name`)
  return passage
}

function define<S extends Record<string, z.ZodType>>(def: {
  name: RiverToolName
  description: string
  inputSchema: S
  mutating: boolean
  run(input: z.infer<z.ZodObject<S>>): Promise<RiverToolResult>
}): RiverTool {
  const schema = z.object(def.inputSchema)
  return {
    name: def.name,
    description: def.description,
    inputSchema: def.inputSchema,
    mutating: def.mutating,
    async handler(input) {
      const parsed = schema.safeParse(input ?? {})
      if (!parsed.success) throw new Error(`invalid input for ${def.name}:\n${z.prettifyError(parsed.error)}`)
      return def.run(parsed.data)
    },
  }
}

const relPath = z.string().min(1).describe("Path relative to the project root, with forward slashes")
const storyFile = z.string().min(1).describe("Story file relative to the project root, e.g. stories/park_walk.twee")
const scalar = z.union([z.number(), z.string(), z.boolean()])

export function createRiverTools(project: Project, opts: RiverToolsOptions = {}): RiverTool[] {
  const defaultAuthor = opts.author ?? "agent"
  // River trusts "you" as the user's own words (a reply that starts a revision), and concept-artist as its job's answer.
  assertAgentAuthor(defaultAuthor)

  /** The story file, checked to be inside the root and one of the project's story files. */
  async function storyRel(file: string): Promise<string> {
    const rel = normalizeRel(file)
    safePath(project, file) // throws "outside the project root" for ../ and absolute paths
    if (!rel) throw new Error(`path "${file}" must be relative to the project root`)
    const stories = await listStories(project)
    const caseInsensitive = process.platform === "win32" || process.platform === "darwin"
    const match = stories.find((s) => s === rel) ?? (caseInsensitive ? stories.find((s) => s.toLowerCase() === rel.toLowerCase()) : undefined)
    if (!match) throw new Error(`"${file}" is not a story file of this project. Story files: ${stories.join(", ") || "(none)"}`)
    return match
  }

  async function readText(rel: string): Promise<string> {
    return readFile(safePath(project, rel), "utf8")
  }

  async function lintFile(rel: string): Promise<{ story: Story; diagnostics: Diagnostic[] }> {
    const schema = await loadSchema(project)
    const { story, diagnostics } = await loadStory(project, rel)
    return { story, diagnostics: [...diagnostics, ...lint(story, schema)] }
  }

  /** Save a changed story, then diff and re-lint it from disk. */
  async function writeStory(rel: string, before: string, beforeDiags: Diagnostic[], next: Story, what: string): Promise<RiverToolResult> {
    await saveStory(project, rel, next)
    const after = await readText(rel)
    const diff = unifiedDiff(before, after, rel)
    const { diagnostics } = await lintFile(rel)
    const known = new Set(beforeDiags.map(diagKey))
    const newProblems = diagnostics.filter((d) => !known.has(diagKey(d)) && d.severity !== "info")
    const errors = diagnostics.filter((d) => d.severity === "error").length
    const lines = [what, "", diff || "(no change to the file)"]
    if (newProblems.length > 0) lines.push("New lint problems:", ...newProblems.map(formatDiag))
    else lines.push("No new lint problems.")
    lines.push(`${plural(errors, "error")} in the file now.`)
    return { text: lines.join("\n"), data: { file: rel, diff, newProblems, diagnostics } }
  }

  function passageSummary(story: Story) {
    return story.passages.map((p) => ({
      id: p.id,
      name: p.name,
      tags: p.tags,
      isEnding: p.isEnding,
      choices: p.choices.map((c, index) => ({ index, label: c.label, target: c.target })),
    }))
  }

  const tools: RiverTool[] = [
    define({
      name: "project_info",
      description: "Summary of the River project: name, engine, folders, editable globs, story files, shot ids, and the state variables with their type, range and starting value.",
      inputSchema: {},
      mutating: false,
      async run() {
        const m = project.manifest
        const stories = await listStories(project)
        const schema = await loadSchema(project).catch(() => undefined)
        const data = {
          root: project.root,
          name: m.name,
          engine: m.engine,
          stories: m.stories,
          state: m.state,
          export: m.export,
          editable: m.editable,
          storyFiles: stories,
          shots: m.shots.map((s) => ({ id: s.id, scene: s.scene, count: s.count, ...(s.note ? { note: s.note } : {}) })),
          ...(schema ? { schema } : {}),
        }
        const text = [
          `${m.name} (engine: ${m.engine})`,
          `root: ${project.root}`,
          `stories folder: ${m.stories}, state: ${m.state}, export: ${m.export}`,
          `editable: ${(m.editable ?? []).join(", ")}`,
          `story files: ${stories.join(", ") || "(none)"}`,
          `shots: ${m.shots.map((s) => s.id).join(", ") || "(none)"}`,
          ...(schema ? [`state variables (${m.state}):`, ...schemaLines(schema)] : [`state variables: ${m.state} is missing or invalid`]),
        ].join("\n")
        return { text, data }
      },
    }),

    define({
      name: "story_list",
      description: "List the story files (.twee) with their titles and passage counts.",
      inputSchema: {},
      mutating: false,
      async run() {
        const out: { file: string; title: string; passages: number; start: string }[] = []
        for (const file of await listStories(project)) {
          const { story } = await loadStory(project, file)
          out.push({ file, title: story.title, passages: contentPassages(story).length, start: story.start })
        }
        const text = out.length === 0 ? "No story files." : out.map((s) => `${s.file}  "${s.title}"  ${plural(s.passages, "passage")}, start: ${s.start}`).join("\n")
        return { text, data: out }
      },
    }),

    define({
      name: "story_read",
      description:
        "Read a story file: the raw Twee 3 text, then each passage with id, name, tags and choices, then the state variables (type, range, starting value). Choice indexes start at 0 (the same indexes playtest_run uses).",
      inputSchema: { file: storyFile },
      mutating: false,
      async run({ file }) {
        const rel = await storyRel(file)
        const raw = await readText(rel)
        const { story } = await loadStory(project, rel)
        const passages = passageSummary(story)
        const list = passages.map((p) => {
          const tags = p.tags.length > 0 ? ` [${p.tags.join(" ")}]` : ""
          const choices = p.choices.map((c) => `\n    ${c.index}: ${c.label} -> ${c.target}`).join("")
          return `- ${p.name} (id ${p.id})${tags}${p.isEnding ? " @end" : ""}${choices}`
        })
        const schema = await loadSchema(project).catch(() => undefined)
        const state = schema ? `\n\nState variables (${project.manifest.state}):\n${schemaLines(schema).join("\n")}` : ""
        const text = `${rel}\n\n${raw}\n\nPassages (${passages.length}), start: ${story.start}\n${list.join("\n")}${state}`
        return { text, data: { file: rel, raw, title: story.title, start: story.start, passages } }
      },
    }),

    define({
      name: "story_lint",
      description: "Check stories for broken links, dead ends, never-true conditions, unknown variables and type mismatches. Without file, checks every story.",
      inputSchema: { file: storyFile.optional() },
      mutating: false,
      async run({ file }) {
        const files = file !== undefined ? [await storyRel(file)] : await listStories(project)
        let errors = 0, warnings = 0, infos = 0, passages = 0
        const lines: string[] = []
        const data: { file: string; diagnostics: Diagnostic[] }[] = []
        for (const rel of files) {
          const { story, diagnostics } = await lintFile(rel)
          passages += contentPassages(story).length
          if (files.length > 1) lines.push(rel)
          for (const d of diagnostics) {
            lines.push(formatDiag(d))
            if (d.severity === "error") errors++
            else if (d.severity === "warn") warnings++
            else infos++
          }
          data.push({ file: rel, diagnostics })
        }
        let summary = `${plural(errors, "error")}, ${plural(warnings, "warning")}`
        if (infos > 0) summary += `, ${infos} info`
        lines.push(`${summary} in ${plural(passages, "passage")}`)
        return { text: lines.join("\n"), data: { errors, warnings, files: data } }
      },
    }),

    define({
      name: "story_paths",
      description:
        "List every route from the start (or from a passage) to an ending, dead end or loop: each passage with the choice label taken there, then the conditions along it. Routes through [interrupt] passages follow the others. A route is \"never true\" when no state lets a player take it, following @set and @cost along the way. summary: true gives counts by ending instead.",
      inputSchema: {
        file: storyFile,
        from: z.string().optional().describe("Passage name (or id) to start from. Default: the story start"),
        maxPaths: z.number().int().min(1).max(5000).optional().describe("Stop after this many routes. Default 500"),
        summary: z.boolean().optional().describe("Route counts by ending and distinct passage sequences instead of every route"),
      },
      mutating: false,
      async run({ file, from, maxPaths, summary }) {
        const rel = await storyRel(file)
        const schema = await loadSchema(project)
        const { story } = await loadStory(project, rel)
        const max = maxPaths !== undefined ? { maxPaths } : {}
        const routes = paths(story, schema, { ...(from !== undefined ? { from } : {}), ...max })
        const detours = from === undefined ? interruptPaths(story, schema, max) : []
        const lines = summary ? summarizePaths(story, routes, detours) : formatPathList(story, routes, detours)
        if (routes.length === 0) lines.push(from !== undefined ? `no routes (no passage "${from}")` : "no routes (the start passage is missing)")
        return { text: lines.join("\n"), data: { routes, interrupts: detours } }
      },
    }),

    define({
      name: "playtest_run",
      description:
        "Play a story without the engine. Takes a list of choice indexes (0-based, as story_read lists them) and returns the transcript: each passage, its choices (a closed one says why) and the state after each step. A choice is open when its @when holds, its @cost can be paid, and its target's @when holds after the cost and set.",
      inputSchema: {
        file: storyFile,
        from: z.string().optional().describe("Passage name (or id) to start from. Default: the story start"),
        choices: z.array(z.number().int().min(0)).describe("Choice indexes to take in order, 0-based"),
        state: z.record(z.string(), scalar).optional().describe("Starting values for state variables, over the schema initial values"),
      },
      mutating: false,
      async run({ file, from, choices, state }) {
        const rel = await storyRel(file)
        const schema = await loadSchema(project)
        const { story } = await loadStory(project, rel)
        const play = createPlaytest(story, schema, { ...(from !== undefined ? { from } : {}), ...(state !== undefined ? { state } : {}) })
        const lines: string[] = []
        const steps: { passageId: string; name: string; choice?: number; state: Record<string, unknown> }[] = []
        const show = () => {
          const p = play.current()
          lines.push(`== ${p.name} == (id ${p.id})`)
          const prose = proseText(p.text)
          if (prose) lines.push(prose)
          for (const c of play.choices()) {
            lines.push(`  ${c.index}: ${c.choice.label} -> ${c.choice.target}${c.choice.hint ? `  (${c.choice.hint})` : ""}${c.closed ? `  [closed: ${formatClosed(c.closed)}]` : ""}`)
          }
          const st = play.state()
          lines.push(`  state: ${Object.entries(st).map(([k, v]) => `${k}=${String(v)}`).join(", ")}`)
          if (play.isOver()) lines.push(p.isEnding ? "  -- the end --" : "  -- no open choices --")
          lines.push("")
          return { passageId: p.id, name: p.name, state: st }
        }
        steps.push(show())
        for (const [k, index] of choices.entries()) {
          const label = play.choices()[index]?.choice.label
          try {
            play.choose(index)
          } catch (e) {
            throw new Error(`step ${k + 1} (choice ${index}) failed: ${(e as Error).message}\n\nTranscript so far:\n${lines.join("\n")}`)
          }
          lines.push(`> ${index}: ${label ?? ""}`, "")
          steps.push({ ...show(), choice: index })
        }
        return { text: lines.join("\n").trimEnd(), data: { steps, over: play.isOver() } }
      },
    }),

    define({
      name: "frames_list",
      description: "List the shots in river.json with their captures, newest first. Each capture lists its PNG file paths (absolute).",
      inputSchema: {},
      mutating: false,
      async run() {
        const shots = []
        const lines: string[] = []
        for (const s of project.manifest.shots) {
          const captures = await listCaptures(project, s.id)
          shots.push({ id: s.id, scene: s.scene, count: s.count, note: s.note, captures })
          lines.push(`${s.id}  (${s.scene}, ${plural(s.count, "frame")})${s.note ? `  ${s.note}` : ""}`)
          if (captures.length === 0) lines.push("  no captures yet")
          for (const c of captures) {
            lines.push(`  ${c.at}  rev ${c.rev}`)
            for (const f of c.files) lines.push(`    ${f}`)
          }
        }
        if (lines.length === 0) lines.push("No shots in river.json.")
        return { text: lines.join("\n"), data: shots }
      },
    }),

    define({
      name: "review_list",
      description: "List review threads (comments on shots), optionally for one shot.",
      inputSchema: { shotId: z.string().min(1).optional() },
      mutating: false,
      async run({ shotId }) {
        const threads = await listThreads(project, shotId)
        const lines = threads.flatMap((t) => {
          const head = `${t.id}  shot ${t.target.shotId} rev ${t.target.rev}${t.target.frame !== undefined ? ` frame ${t.target.frame}` : ""}${t.target.box ? ` box ${t.target.box.join(",")}` : ""}  [${t.status}]${t.planId ? `  plan ${t.planId}` : ""}`
          return [head, ...t.messages.map((m) => `  ${m.author} (${m.at}): ${m.text}`)]
        })
        return { text: lines.length > 0 ? lines.join("\n") : "No review threads.", data: threads }
      },
    }),

    define({
      name: "plan_list",
      description: "List change plans with their status.",
      inputSchema: {},
      mutating: false,
      async run() {
        const plans = await listPlans(project)
        const lines = plans.map((p) => `${p.id}  [${p.status}]  ${p.title}${p.threadId ? `  (thread ${p.threadId})` : ""}  files: ${p.steps.map((s) => s.file).join(", ")}`)
        return { text: lines.length > 0 ? lines.join("\n") : "No change plans.", data: plans }
      },
    }),

    define({
      name: "plan_read",
      description: "Read one change plan in full.",
      inputSchema: { planId: z.string().min(1) },
      mutating: false,
      async run({ planId }) {
        const plan = await loadPlan(project, planId)
        return { text: JSON.stringify(plan, null, 2), data: plan }
      },
    }),

    define({
      name: "story_write_passage",
      description:
        "Replace the full raw text of one passage (the @ rules block, the -- line, prose and choice lines; not the :: header), save the file, and return a unified diff and any new lint problems.",
      inputSchema: {
        file: storyFile,
        passageId: z.string().min(1).describe("The passage id (from story_read)"),
        rawText: z.string().describe("The new passage text, without the :: header line"),
      },
      mutating: true,
      async run({ file, passageId, rawText }) {
        const rel = await storyRel(file)
        const before = await readText(rel)
        const { story, diagnostics } = await lintFile(rel)
        // The file puts the blank line between passages; a trailing newline in rawText would add another.
        const next = updatePassageText(story, passageId, rawText.replace(/\r\n?/g, "\n").replace(/\n+$/, ""))
        return writeStory(rel, before, diagnostics, next, `Updated passage ${passageId} in ${rel}.`)
      },
    }),

    define({
      name: "story_add_passage",
      description: "Append a new passage to a story file, save it, and return a unified diff and any new lint problems.",
      inputSchema: {
        file: storyFile,
        name: z.string().min(1).regex(/^[^\r\n]+$/, "one line").describe("Passage name, as links name it"),
        rawText: z.string().describe("Passage text, without the :: header line"),
        tags: z.array(z.string().regex(/^[^\s[\]]+$/, "no spaces or brackets")).optional(),
      },
      mutating: true,
      async run({ file, name, rawText, tags }) {
        const rel = await storyRel(file)
        const before = await readText(rel)
        const { story, diagnostics } = await lintFile(rel)
        if (story.passages.some((p) => p.name === name)) throw new Error(`a passage named "${name}" already exists in ${rel}`)
        const passage = parseOnePassage(name, tags ?? [], rawText, rel)
        if (story.passages.some((p) => p.id === passage.id)) throw new Error(`a passage with id "${passage.id}" already exists in ${rel}; add an @id rule with another id`)
        return writeStory(rel, before, diagnostics, { ...story, passages: [...story.passages, passage] }, `Added passage ${name} (id ${passage.id}) to ${rel}.`)
      },
    }),

    define({
      name: "review_reply",
      description: "Add a reply to a review thread.",
      inputSchema: {
        threadId: z.string().min(1),
        text: z.string().min(1),
        author: z.string().min(1).optional().describe(`Default "${defaultAuthor}". Never "you" (the user) or "concept-artist" (River's jobs)`),
      },
      mutating: true,
      async run({ threadId, text, author }) {
        if (author !== undefined) assertAgentAuthor(author)
        const thread = await reply(project, threadId, author ?? defaultAuthor, text)
        return { text: `Replied to ${threadId} (${plural(thread.messages.length, "message")} now).`, data: thread }
      },
    }),

    define({
      name: "plan_save",
      description:
        "Save a change plan as a draft (.river/plans/<id>.json). The user approves it before anyone implements it. Steps name files relative to the root; only those files can be edited later, and only if they match the editable globs.",
      inputSchema: {
        threadId: z.string().min(1).optional().describe("Review thread this plan answers"),
        title: z.string().min(1),
        rationale: z.string().min(1).describe("Why this change answers the comment"),
        steps: z
          .array(
            z.object({
              file: relPath,
              change: z.string().min(1).describe("What to change in this file, in words"),
              oldText: z.string().optional(),
              newText: z.string().optional(),
            }),
          )
          .min(1),
        recapture: z.array(z.string()).describe("Shot ids to capture again after the change"),
      },
      mutating: true,
      async run({ threadId, title, rationale, steps, recapture }) {
        for (const s of steps) {
          if (!normalizeRel(s.file)) throw new Error(`step file "${s.file}" must be relative to the project root, without '..'`)
          safePath(project, s.file)
        }
        const shotIds = new Set(project.manifest.shots.map((s) => s.id))
        const unknown = recapture.filter((id) => !shotIds.has(id))
        if (unknown.length > 0) throw new Error(`unknown shot ids in recapture: ${unknown.join(", ")}`)
        const plan = await savePlan(project, {
          ...(threadId !== undefined ? { threadId } : {}),
          title,
          rationale,
          steps: steps.map((s) => ({
            file: normalizeRel(s.file)!,
            change: s.change,
            ...(s.oldText !== undefined ? { oldText: s.oldText } : {}),
            ...(s.newText !== undefined ? { newText: s.newText } : {}),
          })),
          recapture,
        })
        return { text: `Saved draft plan ${plan.id}: ${plan.title}. It needs the user's approval before implement_edit can use it.`, data: plan }
      },
    }),

    define({
      name: "implement_edit",
      description:
        "Edit one file named by an APPROVED change plan: replace oldText (must occur exactly once) with newText. Returns a unified diff. Fails if the plan is not approved, the file is not in its steps, or the file is outside the editable globs.",
      inputSchema: {
        planId: z.string().min(1),
        file: relPath,
        oldText: z.string().min(1).describe("Exact text to replace; must occur exactly once in the file"),
        newText: z.string(),
      },
      mutating: true,
      async run({ planId, file, oldText, newText }) {
        const plan = await loadPlan(project, planId)
        assertEditAllowed(project, plan, file)
        const full = safePath(project, file)
        let before: string
        try {
          before = await readFile(full, "utf8")
        } catch (e) {
          throw new Error(`cannot read ${file}: ${(e as Error).message}`)
        }
        let find = oldText
        let put = newText
        if (before.includes("\r\n") && !oldText.includes("\r\n")) {
          find = oldText.replace(/\n/g, "\r\n")
          put = newText.replace(/\r?\n/g, "\r\n")
        }
        const at: number[] = []
        for (let i = before.indexOf(find); i !== -1; i = before.indexOf(find, i + find.length)) at.push(i)
        if (at.length === 0) throw new Error(`oldText was not found in ${file}`)
        if (at.length > 1) throw new Error(`oldText occurs ${at.length} times in ${file}; include more surrounding text so it matches once`)
        const after = before.slice(0, at[0]) + put + before.slice(at[0]! + find.length)
        await writeFile(full, after, "utf8")
        const rel = normalizeRel(file)!
        const diff = unifiedDiff(before, after, rel)
        return { text: `Edited ${rel} for plan ${planId}.\n\n${diff}`, data: { file: rel, diff } }
      },
    }),

    define({
      name: "plan_mark_implemented",
      description: "Mark an approved change plan as implemented, after its edits are done.",
      inputSchema: { planId: z.string().min(1) },
      mutating: true,
      async run({ planId }) {
        const plan: ChangePlan = await loadPlan(project, planId)
        if (plan.status !== "approved") throw new Error(`plan ${planId} is ${plan.status}; only an approved plan can be marked implemented`)
        const saved = await setPlanStatus(project, planId, "implemented")
        const recap = saved.recapture.length > 0 ? ` Shots to capture again: ${saved.recapture.join(", ")}.` : ""
        return { text: `Plan ${planId} is now implemented.${recap}`, data: saved }
      },
    }),

    define({
      name: "frames_capture",
      description: "Run the engine to capture one shot from river.json. Saves the PNG frames under .river/captures/<shotId>/ and returns their paths.",
      inputSchema: { shotId: z.string().min(1) },
      mutating: true,
      async run({ shotId }) {
        if (!project.manifest.shots.some((s) => s.id === shotId)) {
          throw new Error(`no shot "${shotId}" in river.json. Shots: ${project.manifest.shots.map((s) => s.id).join(", ") || "(none)"}`)
        }
        const adapter = opts.adapter ?? adapterFor(project)
        const capture = await captureShot(project, shotId, adapter)
        return { text: [`Captured ${shotId} at rev ${capture.rev} (${plural(capture.files.length, "frame")}):`, ...capture.files].join("\n"), data: capture }
      },
    }),
  ]

  tools.push(...boardTools(project, defaultAuthor))
  // A concept job's own server never starts another job.
  if (opts.conceptId !== undefined) tools.push(conceptWrite(project, opts.conceptId))
  else tools.push(conceptRequest(project, defaultAuthor, opts.jobLauncher ?? launchConceptJob))
  return tools
}

function conceptWrite(project: Project, conceptId: string): RiverTool {
  assertConceptId(conceptId)
  const folder = conceptPath(conceptId)
  return define({
    name: "concept_write",
    description:
      `Write one file in this job's folder, ${folder}/ (path relative to the project root). The scripts are ${folder}/draw.gd for one drawing, ` +
      "or draw_a.gd..draw_e.gd for up to five options; pass caption with each script (one line shown under its card). " +
      "Replaces the whole file; empty content removes a script. Scripts may hold only printable ASCII, tabs and LF line ends, and may write Kit only as Kit.name(...) calls; anything else is refused. " +
      "For a script the result lists lint problems; fix them and write the file again until there are none.",
    inputSchema: {
      file: relPath,
      content: z.string().max(200_000).describe("The whole file content. Empty removes a script."),
      caption: z.string().max(200).optional().describe('Scripts only: one short line shown under the option card, e.g. "Low sun: long shadows across the path"'),
    },
    mutating: true,
    async run({ file, content, caption }) {
      const rel = assertConceptFile(conceptId, file)
      const script = rel.endsWith(".gd") ? parseConceptScriptName(path.posix.basename(rel)) : undefined
      if (caption !== undefined && !script) throw new Error(`river: caption is for scripts (draw.gd, draw_a.gd..draw_e.gd), not ${rel}`)
      const full = safePath(project, rel)
      if (script && content === "") {
        await rm(full, { force: true })
        await rm(safePath(project, conceptPath(conceptId, conceptCaptionName(script.variant))), { force: true })
        return { text: `Removed ${rel}.`, data: { file: rel, removed: true, problems: [] } }
      }
      const refused = script ? conceptScriptProblem(Buffer.from(content, "utf8")) : undefined
      if (refused) throw new Error(`river: cannot write ${rel}: ${refused} Write the whole file again.`)
      await mkdir(path.dirname(full), { recursive: true })
      await writeFile(full, content, "utf8")
      if (!script) return { text: `Wrote ${rel}.`, data: { file: rel, problems: [] } }
      if (caption !== undefined) await writeFile(safePath(project, conceptPath(conceptId, conceptCaptionName(script.variant))), caption.replace(/\s+/g, " ").trim(), "utf8")
      const problems = lintConceptScript(content)
      const lines =
        problems.length === 0
          ? [`Wrote ${rel}. Lint: no problems.`]
          : [`Wrote ${rel}, but it does not pass the concept lint. Fix these and write the file again:`, ...problems.map((p) => `- ${p}`)]
      const siblings = (await readdir(path.dirname(full)).catch(() => [] as string[])).map(parseConceptScriptName).filter((s) => s !== undefined)
      if (siblings.some((s) => !s.variant) && siblings.some((s) => s.variant)) {
        lines.push("Note: this folder now has draw.gd and lettered options. A job answers with one or the other; write the one you do not want with empty content to remove it.")
      }
      return { text: lines.join("\n"), data: { file: rel, problems } }
    },
  })
}

const boardName = z.string().regex(/^[a-z0-9_-]{1,64}$/, "a-z, 0-9, _ and -").optional().describe('Board name. Default "main"')
const entityId = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/, "a card or mark id")
const IMAGE_FILE = /\.(png|jpe?g|webp|gif)$/i
const IMAGE_TYPES: Record<string, string> = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".gif": "image/gif" }
/** card_view refuses bigger files: an image block that size costs the model more than it shows. */
const VIEW_MAX_BYTES = 4 * 1024 * 1024
const VIEW_MAX_IMAGES = 4

/**
 * The storyboard tools. Every write is one small file under .river/boards/<board>/, renamed into place, so
 * the River app, River's own jobs and other agents can write the same board at once.
 */
function boardTools(project: Project, author: string): RiverTool[] {
  const root = project.root

  async function board(name: string | undefined): Promise<Board> {
    const b = name ?? DEFAULT_BOARD
    const known = await listBoards(root)
    if (!known.includes(b)) throw new Error(`no board "${b}". Boards: ${known.join(", ") || "(none yet)"}`)
    return loadBoard(root, b)
  }

  /** Where a new card goes: right of `near` (a card or mark), or under everything at the left edge. */
  function startFor(b: Board, near: string | undefined): { x: number; y: number } {
    if (near === undefined) {
      const rects = occupiedRects(b)
      return { x: Math.min(0, ...rects.map((r) => r.x)), y: rects.length > 0 ? Math.max(...rects.map((r) => r.y + r.h)) + BOARD_GAP : 0 }
    }
    const target = elementRect(b, near)
    if (!target) throw new Error(`no card or mark "${near}" on board ${b.name}`)
    return besideRect(target)
  }

  function needMark(b: Board, markId: string): Mark {
    const mark = b.marks.find((m) => m.id === markId)
    if (!mark) throw new Error(`no mark "${markId}" on board ${b.name}`)
    return mark
  }

  /**
   * Where an answer's image card goes and what it hangs off: this author's newest note answering the mark (or the
   * mark itself, before there is one), in the row of cards that note already leads to. River's job notes and the
   * user's arrows are someone else's answer.
   */
  function answerRow(b: Board, markId: string): { head: string; spot: { x: number; y: number }; index: number } {
    const own = b.edges.filter((e) => e.madeBy === author)
    const notes = own.filter((e) => e.from === markId).map((e) => b.cards.find((c) => c.id === e.to && c.kind === "note" && !c.pending)).filter((c): c is Card => c !== undefined)
    const head = notes.at(-1)
    const headId = head?.id ?? markId
    const headRect = head ? cardRect(head) : markRect(needMark(b, markId))
    const row = own.filter((e) => e.from === headId).map((e) => b.cards.find((c) => c.id === e.to && c.kind !== "note")).filter((c): c is Card => c !== undefined)
    const right = Math.max(headRect.x + headRect.w, ...row.map((c) => c.x + c.w))
    return { head: headId, spot: { x: right + BOARD_GAP, y: headRect.y }, index: row.length }
  }

  /**
   * What card an image file under the project makes. A capture River knows is a frame. A concept render is a
   * concept only when a job backs it: an accepted job's kept render beside its script, or a rendered job's
   * pending render in .river/jobs/<job>/. Anything else, under concepts/ too, is a reference that needs a licence.
   */
  async function imageCard(rel: string): Promise<Pick<Card, "kind" | "ref" | "rev" | "capture" | "frame" | "variant" | "pending">> {
    const capture = /^\.river\/captures\/([^/]+)\/[^/]+\/[^/]+$/.exec(rel)
    if (capture) {
      const abs = path.resolve(safePath(project, rel))
      const found = (await listCaptures(project, capture[1]!)).find((c) => c.files.some((f) => path.resolve(f) === abs))
      if (!found) throw new Error(`${rel} is not a frame of a capture River knows (frames_list lists them)`)
      return { kind: "frame", ref: found.shotId, rev: found.rev, capture: found.at, frame: found.files.findIndex((f) => path.resolve(f) === abs) }
    }
    const variantOf = (v: string | undefined) => (v ? { variant: v } : {})
    const pending = /^\.river\/jobs\/(j_[A-Za-z0-9_-]+)\/render(?:_([a-e]))?\.png$/.exec(rel)
    if (pending) {
      const job = await loadJob(root, pending[1]!).catch(() => undefined)
      const script = job?.scripts?.find((s) => s.variant === pending[2] && s.render?.ok)
      if (job && script && (job.status === "answered" || (job.status === "accepted" && script.accepted))) {
        return { kind: "concept", ref: job.conceptId, ...variantOf(pending[2]), ...(job.status === "answered" ? { pending: { markId: job.markId, jobId: job.id } } : {}) }
      }
    }
    const accepted = /^concepts\/([A-Za-z0-9_-]+)\/concept(?:_([a-e]))?\.png$/.exec(rel)
    if (accepted) {
      const backed = (await listJobs(root)).some(
        (j: Job) => j.conceptId === accepted[1] && j.status === "accepted" && j.scripts?.some((s) => s.variant === accepted[2] && s.accepted),
      )
      if (backed) return { kind: "concept", ref: accepted[1]!, ...variantOf(accepted[2]) }
    }
    return { kind: "ref", ref: rel }
  }

  /** The image files a card shows, relative to the root: one for a concept or reference, a capture's frames for a frame card. */
  async function imageFiles(card: Card): Promise<string[]> {
    if (card.kind === "frame") {
      const capture = captureForCard(await listCaptures(project, card.ref), card)
      if (!capture) throw new Error(`shot ${card.ref} has no capture${card.capture ? ` from ${card.capture}` : card.rev ? ` at rev ${card.rev}` : ""}${card.capture || card.rev ? " any more" : " yet"}`)
      const files = card.frame !== undefined ? capture.files.slice(card.frame, card.frame + 1) : capture.files
      return files.map((f) => path.relative(root, f).split(path.sep).join("/"))
    }
    const file = cardImageFile(card)
    if (!file) throw new Error(`${card.id} is a ${card.kind} card, not an image; card_read shows its text`)
    return [file]
  }

  /** Write a card the caller made, so an agent can change and remove its own answer but nobody else's. */
  async function ownCard(b: Board, cardId: string): Promise<Card> {
    const card = await loadCard(root, b.name, cardId)
    if (!card) throw new Error(`no card "${cardId}" on board ${b.name}`)
    if (card.madeBy !== author) throw new Error(`${cardId} was made by ${card.madeBy}; ${author} changes only its own cards`)
    if (card.pending) throw new Error(`${cardId} belongs to River job ${card.pending.jobId}; the user accepts or dismisses it in River`)
    return card
  }

  const edgesOf = (b: Board, id: string) => b.edges.filter((e) => e.from === id || e.to === id)

  return [
    define({
      name: "board_read",
      description:
        "Read a storyboard: every card (id, kind, position and size, option label, caption, what it shows, image file, pending job), every mark (status, job, box, what it is on, thread) and every edge (from -> to). Long text is clipped; card_read and mark_read show it in full. Ids here are what the other board tools take.",
      inputSchema: { board: boardName },
      mutating: false,
      async run({ board: name }) {
        const b = await board(name)
        return { text: formatBoard(b, await frameCardFiles(root, b)), data: b }
      },
    }),

    define({
      name: "marks_open",
      description:
        "List the open marks (requests the user drew on a storyboard that nobody is working on), across every board, oldest first, with what each is on and its thread. Marks that River's concept jobs answer are not listed.",
      inputSchema: {},
      mutating: false,
      async run() {
        const open: { board: Board; mark: Mark }[] = []
        for (const name of await listBoards(root)) {
          const b = await loadBoard(root, name)
          for (const mark of openMarks(b).filter((m) => !m.jobId)) open.push({ board: b, mark })
        }
        open.sort((a, b) => (a.mark.createdAt < b.mark.createdAt ? -1 : a.mark.createdAt > b.mark.createdAt ? 1 : 0))
        const text = open.length === 0 ? "No open marks." : open.flatMap(({ board: b, mark }) => [`board ${b.name}:`, ...formatMark(mark, "  ", b)]).join("\n")
        return { text, data: { marks: open.map(({ board: b, mark }) => ({ board: b.name, mark })) } }
      },
    }),

    define({
      name: "mark_read",
      description: "Read one mark in full: status, claim, job, box, the cards it is on (with their text), the cards its arrows lead to, and every message unclipped.",
      inputSchema: { board: boardName, markId: entityId },
      mutating: false,
      async run({ board: name, markId }) {
        const b = await board(name)
        const mark = needMark(b, markId)
        const [head] = formatMark(mark, "", b)
        const lines = [head!]
        if (mark.claimedAt) lines.push(`claimed at ${mark.claimedAt}`)
        for (const id of mark.anchors) {
          const card = b.cards.find((c) => c.id === id)
          if (card) lines.push(`on: ${formatCard(card, 100_000)}`)
        }
        for (const e of b.edges.filter((e) => e.from === mark.id)) {
          const card = b.cards.find((c) => c.id === e.to)
          lines.push(`answer: ${card ? formatCard(card, 300) : e.to}`)
        }
        lines.push("thread:", ...mark.thread.map((m) => `- ${m.by} (${m.at}):\n${m.text}`))
        return { text: lines.join("\n"), data: mark }
      },
    }),

    define({
      name: "card_read",
      description: "Read one card in full: its whole note text or caption, what it shows (the passage text for a passage card, the image file for an image card), who made it, and its arrows.",
      inputSchema: { board: boardName, cardId: entityId },
      mutating: false,
      async run({ board: name, cardId }) {
        const b = await board(name)
        const card = b.cards.find((c) => c.id === cardId)
        if (!card) throw new Error(`no card "${cardId}" on board ${b.name}`)
        const lines = [formatCard(card, 80)]
        if (card.text !== undefined) lines.push("text:", card.text)
        if (card.caption) lines.push(`caption: ${card.caption}`)
        if (card.source) lines.push(`source: ${[card.source.title, card.source.url, card.source.licence].filter(Boolean).join(", ")}`)
        if (card.kind === "passage") {
          const [file = "", id = ""] = card.ref.split("#")
          const passage = await loadStory(project, file).then(({ story }) => passageById(story, id)).catch(() => undefined)
          lines.push(passage ? `passage ${passage.name} (id ${passage.id}) in ${file}:\n${passage.rawText}` : `passage ${card.ref} is not in the stories any more`)
        }
        for (const e of edgesOf(b, card.id)) lines.push(`edge ${e.id}: ${e.from} -> ${e.to}`)
        return { text: lines.join("\n"), data: card }
      },
    }),

    define({
      name: "card_view",
      description:
        "See an image card: returns the picture itself (a concept render, pending or accepted, a reference image, or a captured frame's images) so you can judge what it shows. Files over 4 MB are refused.",
      inputSchema: { board: boardName, cardId: entityId },
      mutating: false,
      async run({ board: name, cardId }) {
        const b = await board(name)
        const card = b.cards.find((c) => c.id === cardId)
        if (!card) throw new Error(`no card "${cardId}" on board ${b.name}`)
        const files = (await imageFiles(card)).slice(0, VIEW_MAX_IMAGES)
        const images: { data: string; mimeType: string }[] = []
        for (const rel of files) {
          const mimeType = IMAGE_TYPES[path.extname(rel).toLowerCase()]
          if (!mimeType) throw new Error(`${rel} is not a PNG, JPG, WebP or GIF image`)
          const abs = safePath(project, rel)
          const size = await stat(abs).then((s) => s.size).catch(() => undefined)
          if (size === undefined) {
            const wait = card.pending ? ` River job ${card.pending.jobId} has not rendered it yet: the user approves its scripts in River first.` : ""
            throw new Error(`${rel} does not exist.${wait}`)
          }
          if (size > VIEW_MAX_BYTES) throw new Error(`${rel} is ${(size / 1024 / 1024).toFixed(1)} MB; card_view shows images up to 4 MB`)
          images.push({ data: (await readFile(abs)).toString("base64"), mimeType })
        }
        return { text: `${card.id} (${card.kind}${card.label ? ` ${card.label}` : ""}${card.caption ? `, "${card.caption}"` : ""}): ${files.join(", ")}`, data: { card, files }, images }
      },
    }),

    define({
      name: "brief_read",
      description: "Read the project brief (.river/brief.md): what the game should look and feel like, written by the user, and what the user turned down before.",
      inputSchema: {},
      mutating: false,
      async run() {
        const brief = await readBrief(root)
        return { text: brief ?? "No brief yet (.river/brief.md does not exist).", data: { brief: brief ?? null } }
      },
    }),

    define({
      name: "mark_claim",
      description:
        `Take an open mark to work on it: its status becomes "working", claimed by ${author}, and nobody else can claim it or change its status. ` +
        "Fails when another agent or a River job has it. Claiming it again refreshes your claim; a claim untouched for 30 minutes can be taken over.",
      inputSchema: { board: boardName, markId: entityId },
      mutating: true,
      async run({ board: name, markId }) {
        const b = await board(name)
        const mark = await claimMark(root, b.name, markId, author)
        return { text: `Claimed ${mark.id} on board ${b.name} as ${author}.`, data: mark }
      },
    }),

    define({
      name: "mark_reply",
      description:
        `Add a message to a mark's thread, as ${author}. status "answered": your reply and the cards you added answer the mark. "open": give the mark back. ` +
        '"dismissed": you will not do it; the text says why. Only the agent that claimed a mark changes its status. A mark a River job works on keeps the job\'s status, so leave status out there.',
      inputSchema: {
        board: boardName,
        markId: entityId,
        text: z.string().min(1).max(4000),
        status: z.enum(["answered", "open", "dismissed"]).optional(),
      },
      mutating: true,
      async run({ board: name, markId, text, status }) {
        const mark = await replyToMark(root, (await board(name)).name, markId, author, text, status)
        return { text: `Replied on ${mark.id} (${mark.thread.length} messages, status ${mark.status}).`, data: mark }
      },
    }),

    define({
      name: "board_add_note",
      description:
        `Add a note card (text) to a board; it never covers another card. With answers (a mark id) River puts the note beside the mark, under any earlier answer, ` +
        `and draws the arrow mark -> note: use it for every answer. Otherwise it goes right of near, or under everything. Returns the new card id. madeBy ${author}.`,
      inputSchema: {
        board: boardName,
        text: z.string().min(1).max(8000),
        answers: entityId.optional().describe("The mark this note answers"),
        near: entityId.optional().describe("Card or mark id to put the note beside (not with answers)"),
      },
      mutating: true,
      async run({ board: name, text, answers, near }) {
        const b = await board(name)
        if (answers !== undefined && near !== undefined) throw new Error("pass answers or near, not both")
        if (answers !== undefined) needMark(b, answers)
        const card = { kind: "note" as const, w: NOTE_CARD_W, ref: "", text }
        const start = answers !== undefined ? answerStart(b, answers) : startFor(b, near)
        const [spot] = placeRow(start, [{ w: card.w, h: cardHeight(card) }], occupiedRects(b))
        const saved = await saveCard(root, b.name, { ...card, ...spot!, madeBy: author })
        if (answers === undefined) return { text: `Added note ${saved.id} at ${spot!.x},${spot!.y} on board ${b.name}.`, data: saved }
        const edge = await saveEdge(root, b.name, { from: answers, to: saved.id, madeBy: author })
        return { text: `Added note ${saved.id} answering ${answers} at ${spot!.x},${spot!.y} (edge ${edge.id}). Cards you add with answers: ${answers} go in a row beside it.`, data: saved }
      },
    }),

    define({
      name: "board_add_card",
      description:
        "Add an image card for a file under the project (a PNG, JPG, WebP or GIF); it never covers another card. With answers (a mark id) the card joins the row of options " +
        "beside your note answering that mark, labelled A, B, C..., with an arrow note -> card (add the note first). Otherwise it goes right of near, or under everything. " +
        "A frame from .river/captures/ becomes a frame card; a render of a River concept job (.river/jobs/<job>/render_<v>.png, or concepts/<id>/concept_<v>.png once accepted) " +
        "a concept card; these need no licence. Any other image (a reference you found, a PNG you made) is a reference card and needs source.licence. Returns the card id.",
      inputSchema: {
        board: boardName,
        file: relPath.describe("Image file relative to the project root"),
        caption: z.string().max(300).optional().describe("One or two lines under the image"),
        label: z.string().max(8).optional().describe('Short option badge, e.g. "A". With answers the next letter is the default'),
        answers: entityId.optional().describe("The mark this card answers"),
        near: entityId.optional().describe("Card or mark id to put the card beside (not with answers)"),
        source: z
          .object({ licence: z.string().min(1), url: z.string().optional(), title: z.string().optional() })
          .optional()
          .describe("Where the image came from; required for a reference image"),
      },
      mutating: true,
      async run({ board: name, file, caption, label, answers, near, source }) {
        const rel = normalizeRel(file)
        if (!rel) throw new Error(`"${file}" must be relative to the project root, without '..'`)
        if (!IMAGE_FILE.test(rel)) throw new Error(`${rel} is not an image (png, jpg, webp or gif)`)
        if (!existsSync(safePath(project, rel))) throw new Error(`${rel} does not exist`)
        if (answers !== undefined && near !== undefined) throw new Error("pass answers or near, not both")
        const kind = await imageCard(rel)
        if (kind.kind === "ref" && !source) throw new Error(`${rel} is a reference image: pass source.licence (and url or title when you have them)`)
        const b = await board(name)
        const row = answers !== undefined ? answerRow(b, answers) : undefined
        const badge = label ?? (row ? optionLabels(row.index + 1).at(-1) : undefined)
        const card = { ...kind, w: IMAGE_CARD_W, ...(caption ? { caption } : {}), ...(badge ? { label: badge } : {}), ...(kind.kind === "ref" && source ? { source } : {}) }
        const [spot] = placeRow(row?.spot ?? startFor(b, near), [{ w: card.w, h: cardHeight(card) }], occupiedRects(b))
        const saved = await saveCard(root, b.name, { ...card, ...spot!, madeBy: author })
        const what = `${saved.kind} card ${saved.id}${saved.label ? ` [${saved.label}]` : ""} for ${rel} at ${spot!.x},${spot!.y} on board ${b.name}`
        if (!row) return { text: `Added ${what}.`, data: saved }
        const edge = await saveEdge(root, b.name, { from: row.head, to: saved.id, madeBy: author })
        return { text: `Added ${what}, answering ${answers} (edge ${row.head} -> ${saved.id}, ${edge.id}).`, data: saved }
      },
    }),

    define({
      name: "board_update_note",
      description: `Replace the text of a note card you made (madeBy ${author}). Its place and arrows stay.`,
      inputSchema: { board: boardName, cardId: entityId, text: z.string().min(1).max(8000) },
      mutating: true,
      async run({ board: name, cardId, text }) {
        const b = await board(name)
        const card = await ownCard(b, cardId)
        if (card.kind !== "note") throw new Error(`${cardId} is a ${card.kind} card; only a note's text can change`)
        const saved = await saveCard(root, b.name, { ...card, text })
        return { text: `Updated note ${saved.id}.`, data: saved }
      },
    }),

    define({
      name: "board_remove_card",
      description: `Remove a card you made (madeBy ${author}) and the arrows that touch it. Cards of the user, other agents and River's jobs stay.`,
      inputSchema: { board: boardName, cardId: entityId },
      mutating: true,
      async run({ board: name, cardId }) {
        const b = await board(name)
        await ownCard(b, cardId)
        const edges = edgesOf(b, cardId)
        for (const e of edges) await deleteEdge(root, b.name, e.id)
        await deleteCard(root, b.name, cardId)
        return { text: `Removed ${cardId}${edges.length > 0 ? ` and ${plural(edges.length, "arrow")}` : ""}.`, data: { removed: cardId, edges: edges.map((e) => e.id) } }
      },
    }),

    define({
      name: "board_connect",
      description: `Draw a curved arrow from one card or mark to another (frames of a sequence, a card to what it refers to). board_add_note and board_add_card with answers draw the answer's arrows for you. An arrow that already joins the two is returned as it is. madeBy ${author}.`,
      inputSchema: { board: boardName, from: entityId, to: entityId, label: z.string().max(200).optional() },
      mutating: true,
      async run({ board: name, from, to, label }) {
        const b = await board(name)
        for (const id of [from, to]) if (!elementRect(b, id)) throw new Error(`no card or mark "${id}" on board ${b.name}`)
        const existing = b.edges.find((e) => e.from === from && e.to === to)
        if (existing) return { text: `Edge ${existing.id} already joins ${from} -> ${to}.`, data: existing }
        const edge = await saveEdge(root, b.name, { from, to, ...(label ? { label } : {}), madeBy: author })
        return { text: `Connected ${from} -> ${to} (edge ${edge.id}).`, data: edge }
      },
    }),

    define({
      name: "board_place_row",
      description:
        "Move existing cards into one row, in the order given, right of a card or mark (near), level with its top or moved down until it covers nothing. " +
        'Labels them A, B, C... unless you pass labels (one per card; "" leaves a card unlabelled). River\'s pending job cards cannot be moved this way.',
      inputSchema: {
        board: boardName,
        cards: z.array(entityId).min(1).max(26),
        near: entityId,
        labels: z.array(z.string().max(8)).optional(),
      },
      mutating: true,
      async run({ board: name, cards: ids, near, labels }) {
        const b = await board(name)
        if (labels && labels.length !== ids.length) throw new Error(`labels has ${labels.length} entries for ${ids.length} cards`)
        if (ids.includes(near)) throw new Error("near cannot be one of the cards in the row")
        const cards = ids.map((id) => {
          const card = b.cards.find((c) => c.id === id)
          if (!card) throw new Error(`no card "${id}" on board ${b.name}`)
          // A pending option's badge must keep matching its variant: that is the option the user accepts.
          if (card.pending) throw new Error(`${id} is an option of River job ${card.pending.jobId}; River places and labels it`)
          return card
        })
        const names = labels ?? optionLabels(cards.length)
        const placed = cards.map((c, i) => {
          const { label: _old, ...rest } = c
          return names[i] ? { ...rest, label: names[i] } : rest
        })
        const spots = placeRow(startFor(b, near), placed.map((c) => ({ w: c.w, h: cardHeight(c) })), occupiedRects(b, new Set(ids)))
        const saved = await Promise.all(placed.map((c, i) => saveCard(root, b.name, { ...c, ...spots[i]! })))
        return { text: `Placed ${saved.map((c) => `${c.label ?? "-"} ${c.id}`).join(", ")} in a row at ${spots[0]!.x},${spots[0]!.y}.`, data: { cards: saved } }
      },
    }),
  ]
}

const BACKENDS = ["claude-code", "api-key"] as const
const MODELS = ["claude-sonnet-5-5", "claude-opus-5-5"] as const

/** concept_request: a River concept job for a mark, run by `river job start` in its own process. */
function conceptRequest(project: Project, author: string, launch: JobLauncher): RiverTool {
  const root = project.root
  return define({
    name: "concept_request",
    description:
      "Ask River's concept artist to draw the answer to a mark: the way to answer requests to draw, show or picture something (what does X look like, sketch Y, 3 options for Z). " +
      "It starts a River concept job and returns its id at once; the job takes a few minutes in the background and puts its options beside the mark. " +
      "The user must read and approve the job's scripts in River before anything is drawn, and accepts or dismisses the answer there; the mark then follows the job, so do not answer it yourself.",
    inputSchema: {
      board: boardName,
      markId: entityId,
      backend: z.enum(BACKENDS).optional().describe('Default "claude-code": the user\'s own Claude Code sign-in'),
      model: z.enum(MODELS).optional().describe('Default "claude-sonnet-5-5"'),
    },
    mutating: true,
    async run({ board: name, markId, backend, model }) {
      const b = name ?? DEFAULT_BOARD
      const mark = (await loadBoard(root, b)).marks.find((m) => m.id === markId)
      if (!mark) throw new Error(`no mark "${markId}" on board ${b}`)
      const jobId = newBoardId("j_")
      const settings = { backend: backend ?? "claude-code", model: model ?? "claude-sonnet-5-5" } as const
      const started = await launch({ root, board: b, markId, jobId, by: author, ...settings })
      const job = await loadJob(root, jobId).catch(() => undefined)
      return {
        text: [
          `Started River concept job ${jobId} for ${markId} (${settings.backend}, ${settings.model})${job ? `; it is ${job.status}` : ""}. Its log: ${started.log}.`,
          "It runs in the background for a few minutes, then River lays its note and options beside the mark. Nothing is drawn until the user reads and approves the scripts in River (or with river job approve).",
          `The mark now follows the job: do not reply on it with a status. board_read shows the job's cards as pending; card_view shows a render once it exists.`,
        ].join("\n"),
        data: { jobId, log: started.log },
      }
    },
  })
}
