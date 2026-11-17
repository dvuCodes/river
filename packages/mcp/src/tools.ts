/**
 * The River tools, as plain functions over a loaded project. `server.ts` registers them on an
 * MCP server; the in-app agent can register the same list in-process.
 *
 * Every path argument is relative to the project root and goes through core `safePath`.
 * Handlers throw on bad input; the MCP server turns a throw into an `isError` tool result.
 */
import { existsSync } from "node:fs"
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises"
import path from "node:path"
import { conceptScriptBytesProblem, createGodotAdapter, lintConceptScript } from "@river/adapter-godot"
import {
  assertConceptFile,
  assertConceptId,
  BOARD_GAP,
  besideRect,
  cardHeight,
  claimMark,
  conceptCaptionName,
  conceptPath,
  DEFAULT_BOARD,
  elementRect,
  formatBoard,
  formatMark,
  IMAGE_CARD_W,
  listBoards,
  loadBoard,
  NOTE_CARD_W,
  occupiedRects,
  openMarks,
  optionLabels,
  parseConceptScriptName,
  placeRow,
  readBrief,
  replyToMark,
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
import type { Board, Card, ChangePlan, Diagnostic, EngineAdapter, Mark, Passage, Project, Story } from "@river/core"
import { z } from "zod"
import { unifiedDiff } from "./diff"

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
] as const

export type RiverToolName = (typeof READ_TOOL_NAMES)[number] | (typeof WRITE_TOOL_NAMES)[number]

export const RIVER_TOOL_NAMES: readonly RiverToolName[] = [...READ_TOOL_NAMES, ...WRITE_TOOL_NAMES]

export interface RiverToolResult {
  /** What the model reads. Complete on its own. */
  text: string
  /** The same result as structured data, for in-process callers (diffs, plan ids, capture files). */
  data?: unknown
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
  // River trusts "you" as the user's own words (a reply that starts a revision); an agent never writes as the user.
  if (defaultAuthor.trim().toLowerCase() === "you") throw new Error('river: the author "you" is the user; run the server as an agent role such as "claude-code"')

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
      description: "Summary of the River project: name, engine, folders, editable globs, story files and shot ids.",
      inputSchema: {},
      mutating: false,
      async run() {
        const m = project.manifest
        const stories = await listStories(project)
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
        }
        const text = [
          `${m.name} (engine: ${m.engine})`,
          `root: ${project.root}`,
          `stories folder: ${m.stories}, state: ${m.state}, export: ${m.export}`,
          `editable: ${(m.editable ?? []).join(", ")}`,
          `story files: ${stories.join(", ") || "(none)"}`,
          `shots: ${m.shots.map((s) => s.id).join(", ") || "(none)"}`,
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
        "Read a story file: the raw Twee 3 text, then each passage with id, name, tags and choices. Choice indexes start at 0 (the same indexes playtest_run uses).",
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
        const text = `${rel}\n\n${raw}\n\nPassages (${passages.length}), start: ${story.start}\n${list.join("\n")}`
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
      description: "List every route from the start (or from a passage) to an ending, dead end or loop, with the conditions along it.",
      inputSchema: {
        file: storyFile,
        from: z.string().optional().describe("Passage name (or id) to start from. Default: the story start"),
        maxPaths: z.number().int().min(1).max(5000).optional().describe("Stop after this many routes. Default 500"),
      },
      mutating: false,
      async run({ file, from, maxPaths }) {
        const rel = await storyRel(file)
        const schema = await loadSchema(project)
        const { story } = await loadStory(project, rel)
        const routes = paths(story, schema, { ...(from !== undefined ? { from } : {}), ...(maxPaths !== undefined ? { maxPaths } : {}) })
        const width = String(routes.length).length + 2
        const lines = routes.map((r, i) => {
          const names = r.steps.map((s) => passageById(story, s.passageId)?.name ?? s.passageId)
          let line = `${String(i + 1).padEnd(width)}${names.join(" → ")}`
          if (r.end === "dead-end") line += " (dead end)"
          if (r.end === "loop") line += " (loop)"
          if (r.conditions.length > 0) line += `   [${r.conditions.map(formatCond).join(" and ")}]`
          if (!r.satisfiable) line += "   never true"
          return line
        })
        if (routes.length === 0) lines.push(from !== undefined ? `no routes (no passage "${from}")` : "no routes (the start passage is missing)")
        return { text: lines.join("\n"), data: routes }
      },
    }),

    define({
      name: "playtest_run",
      description:
        "Play a story without the engine. Takes a list of choice indexes (0-based, as story_read lists them) and returns the transcript: each passage, its choices and the state after each step.",
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
          for (const c of play.choices()) lines.push(`  ${c.index}: ${c.choice.label} -> ${c.choice.target}${c.open ? "" : `  [closed: ${c.choice.when ? formatCond(c.choice.when) : ""}]`}`)
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
        const next = updatePassageText(story, passageId, rawText.replace(/\r\n?/g, "\n"))
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
        author: z.string().min(1).optional().describe('Default "agent"'),
      },
      mutating: true,
      async run({ threadId, text, author }) {
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
  if (opts.conceptId !== undefined) tools.push(conceptWrite(project, opts.conceptId))
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
      "Replaces the whole file; empty content removes a script. Scripts may hold only printable ASCII, tabs and LF line ends; anything else is refused. " +
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
      const unreadable = script ? conceptScriptBytesProblem(Buffer.from(content, "utf8")) : undefined
      if (unreadable) throw new Error(`river: cannot write ${rel}: ${unreadable} Write the whole file again without them.`)
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

  /** What kind of card an image file under the project makes: a capture is a frame, an accepted concept render a concept, anything else a reference. */
  async function imageCard(rel: string): Promise<Pick<Card, "kind" | "ref" | "rev" | "variant">> {
    const capture = /^\.river\/captures\/([^/]+)\/[^/]+\/[^/]+$/.exec(rel)
    if (capture) {
      const abs = path.resolve(safePath(project, rel))
      const found = (await listCaptures(project, capture[1]!)).find((c) => c.files.some((f) => path.resolve(f) === abs))
      if (!found) throw new Error(`${rel} is not a frame of a capture River knows (frames_list lists them)`)
      return { kind: "frame", ref: found.shotId, rev: found.rev }
    }
    const concept = /^concepts\/([A-Za-z0-9_-]+)\/concept(?:_([a-e]))?\.png$/.exec(rel)
    if (concept) return { kind: "concept", ref: concept[1]!, ...(concept[2] ? { variant: concept[2] } : {}) }
    return { kind: "ref", ref: rel }
  }

  return [
    define({
      name: "board_read",
      description:
        "Read a storyboard: every card (id, kind, position, option label, caption, what it shows, pending job), every mark (status, job, thread) and every edge (from -> to). Ids here are what the other board tools take.",
      inputSchema: { board: boardName },
      mutating: false,
      async run({ board: name }) {
        const b = await board(name)
        return { text: formatBoard(b), data: b }
      },
    }),

    define({
      name: "marks_open",
      description: "List the open marks (requests the user drew on a storyboard that nobody is working on), across every board, oldest first, with their threads.",
      inputSchema: {},
      mutating: false,
      async run() {
        const open: { board: string; mark: Mark }[] = []
        for (const name of await listBoards(root)) for (const mark of openMarks(await loadBoard(root, name))) open.push({ board: name, mark })
        open.sort((a, b) => (a.mark.createdAt < b.mark.createdAt ? -1 : a.mark.createdAt > b.mark.createdAt ? 1 : 0))
        const text = open.length === 0 ? "No open marks." : open.flatMap(({ board: b, mark }) => [`board ${b}:`, ...formatMark(mark, "  ")]).join("\n")
        return { text, data: { marks: open } }
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
      description: `Take an open mark to work on it: its status becomes "working", claimed by ${author}. Fails when the mark is not open (someone else, or a River job, has it). Claiming it again is fine.`,
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
        `Add a message to a mark's thread, as ${author}. status "answered" says your reply (and the cards you added) answers the mark; "open" gives the mark back. ` +
        "A mark a River job works on keeps the job's status, so leave status out there.",
      inputSchema: {
        board: boardName,
        markId: entityId,
        text: z.string().min(1).max(4000),
        status: z.enum(["answered", "open"]).optional(),
      },
      mutating: true,
      async run({ board: name, markId, text, status }) {
        const mark = await replyToMark(root, (await board(name)).name, markId, author, text, status)
        return { text: `Replied on ${mark.id} (${mark.thread.length} messages, status ${mark.status}).`, data: mark }
      },
    }),

    define({
      name: "board_add_note",
      description: `Add a note card (text) to a board, right of a card or mark (near), or under everything; it never covers another card. Returns the new card id. madeBy ${author}.`,
      inputSchema: {
        board: boardName,
        text: z.string().min(1).max(8000),
        near: entityId.optional().describe("Card or mark id to put the note beside"),
      },
      mutating: true,
      async run({ board: name, text, near }) {
        const b = await board(name)
        const card = { kind: "note" as const, w: NOTE_CARD_W, ref: "", text }
        const [spot] = placeRow(startFor(b, near), [{ w: card.w, h: cardHeight(card) }], occupiedRects(b))
        const saved = await saveCard(root, b.name, { ...card, ...spot!, madeBy: author })
        return { text: `Added note ${saved.id} at ${spot!.x},${spot!.y} on board ${b.name}.`, data: saved }
      },
    }),

    define({
      name: "board_add_card",
      description:
        "Add an image card for a file under the project (a PNG, JPG, WebP or GIF), right of near or under everything; it never covers another card. " +
        "A frame from .river/captures/ becomes a frame card and a concepts/<id>/concept.png (or concept_<v>.png) a concept card; these need no licence. " +
        "Any other image (a reference you found, a PNG made with Godot) is a reference card and needs source.licence. Returns the card id.",
      inputSchema: {
        board: boardName,
        file: relPath.describe("Image file relative to the project root"),
        caption: z.string().max(300).optional().describe("One or two lines under the image"),
        label: z.string().max(8).optional().describe('Short option badge, e.g. "A"'),
        near: entityId.optional().describe("Card or mark id to put the card beside"),
        source: z
          .object({ licence: z.string().min(1), url: z.string().optional(), title: z.string().optional() })
          .optional()
          .describe("Where the image came from; required for a reference image"),
      },
      mutating: true,
      async run({ board: name, file, caption, label, near, source }) {
        const rel = normalizeRel(file)
        if (!rel) throw new Error(`"${file}" must be relative to the project root, without '..'`)
        if (!IMAGE_FILE.test(rel)) throw new Error(`${rel} is not an image (png, jpg, webp or gif)`)
        if (!existsSync(safePath(project, rel))) throw new Error(`${rel} does not exist`)
        const kind = await imageCard(rel)
        if (kind.kind === "ref" && !source) throw new Error(`${rel} is a reference image: pass source.licence (and url or title when you have them)`)
        const b = await board(name)
        const card = { ...kind, w: IMAGE_CARD_W, ...(caption ? { caption } : {}), ...(label ? { label } : {}), ...(kind.kind === "ref" && source ? { source } : {}) }
        const [spot] = placeRow(startFor(b, near), [{ w: card.w, h: cardHeight(card) }], occupiedRects(b))
        const saved = await saveCard(root, b.name, { ...card, ...spot!, madeBy: author })
        return { text: `Added ${saved.kind} card ${saved.id} for ${rel} at ${spot!.x},${spot!.y} on board ${b.name}.`, data: saved }
      },
    }),

    define({
      name: "board_connect",
      description: `Draw a curved arrow from one card or mark to another (a request to its answer, frames of a sequence). An arrow that already joins the two is returned as it is. madeBy ${author}.`,
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
        'Labels them A, B, C... unless you pass labels (one per card; "" leaves a card unlabelled).',
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
