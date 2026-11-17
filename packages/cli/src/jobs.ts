import { existsSync } from "node:fs"
import path from "node:path"
import {
  BOARD_GAP,
  cardHeight,
  DEFAULT_BOARD,
  ensureBoard,
  formatBoard,
  frameCardFiles,
  IMAGE_CARD_W,
  jobRenderName,
  listBoards,
  loadBoard,
  loadJob,
  loadProject,
  loadStory,
  normalizeRel,
  NOTE_CARD_W,
  occupiedRects,
  passageById,
  placeRow,
  replyToMark,
  safePath,
  saveCard,
  saveMark,
  type Board,
  type Card,
  type Job,
  type MarkStatusChange,
} from "@river/core"
import type { AgentBackend, AgentEvent, AgentModel } from "@river/agent"

interface Out {
  line(s?: string): void
  write(s: string): void
}

export interface JobArgs {
  root: string
  board?: string | undefined
  mark?: string | undefined
  job?: string | undefined
  backend?: string | undefined
  model?: string | undefined
  yes?: boolean | undefined
  /**
   * The sha256 of each script, as `job approve` without --yes printed them: "<hex>" for a single draw.gd,
   * "<letter>=<hex>" per option. --yes runs the scripts only if every one still matches.
   */
  sha256?: string[] | undefined
  /** `job accept`: the options to keep, e.g. "a,c". Default: every option that rendered. */
  variants?: string | undefined
  /** `job dismiss`: why, added to the project brief. */
  reason?: string | undefined
  /** `job start`: who asks, "you" by default (concept_request passes its agent). */
  by?: string | undefined
  /** `job approve --yes`: skip the agent's look at its renders. */
  "skip-self-check"?: boolean | undefined
}

const BACKENDS: readonly AgentBackend[] = ["claude-code", "api-key"]
const MODELS: readonly AgentModel[] = ["claude-sonnet-5-5", "claude-opus-5-5"]

/** Points around an ellipse, the outline of a circle mark. */
function ellipse(cx: number, cy: number, rx: number, ry: number, n = 24): number[] {
  const points: number[] = []
  for (let i = 0; i < n; i++) {
    const a = (2 * Math.PI * i) / n
    points.push(Math.round(cx + rx * Math.cos(a)), Math.round(cy + ry * Math.sin(a)))
  }
  return points
}

/** Where something new goes on a board that has no place for it: under everything, at the left edge. */
function freeStart(board: Board): { x: number; y: number } {
  const rects = occupiedRects(board)
  return { x: Math.min(0, ...rects.map((r) => r.x)), y: rects.length > 0 ? Math.max(...rects.map((r) => r.y + r.h)) + BOARD_GAP : 0 }
}

const MARK_STATUS: Record<string, MarkStatusChange> = { dismiss: "dismissed", accept: "accepted" }

/**
 * `river mark add`: a circle mark with one message, around a card or at a free spot under the board. Prints the mark id.
 * `river mark reply`: add the user's message to a mark's thread (then `job revise` answers it).
 * `river mark dismiss|accept`: close a mark an agent answered (or will not), with an optional message.
 */
export async function cmdMark(
  sub: string | undefined,
  o: { root: string; board: string; text?: string | undefined; anchor?: string | undefined; mark?: string | undefined },
  out: Out,
  err: Out,
): Promise<number> {
  if (sub !== "add" && sub !== "reply" && sub !== "dismiss" && sub !== "accept") {
    err.line('river mark: use "mark add --text ...", "mark reply --mark <id> --text ...", or "mark dismiss|accept --mark <id> [--text ...]"')
    return 2
  }
  const text = o.text?.trim()
  const status = MARK_STATUS[sub]
  if (!text && !status) {
    err.line(`river mark ${sub}: --text is required`)
    return 2
  }
  const root = (await loadProject(o.root)).root
  if (status) {
    if (!o.mark) {
      err.line(`river mark ${sub}: --mark <id> is required`)
      return 2
    }
    const mark = await replyToMark(root, o.board, o.mark, "you", text ?? "", status)
    out.line(`${mark.id}  ${mark.status}  ${mark.thread.length} messages`)
    return 0
  }
  if (!text) return 2
  if (sub === "reply") {
    if (!o.mark) {
      err.line("river mark reply: --mark <id> is required")
      return 2
    }
    const mark = await replyToMark(root, o.board, o.mark, "you", text)
    out.line(`${mark.id}  ${mark.status}  ${mark.thread.length} messages${mark.jobId ? `  job ${mark.jobId}` : ""}`)
    if (mark.jobId && ["answered", "accepted", "open"].includes(mark.status)) out.line(`next: river job revise --root ${root} --job ${mark.jobId}`)
    return 0
  }
  await ensureBoard(root, o.board)
  const spot = freeStart(await loadBoard(root, o.board))
  let outline = ellipse(spot.x + 40, spot.y + 40, 40, 40)
  if (o.anchor) {
    const card = (await loadBoard(root, o.board)).cards.find((c) => c.id === o.anchor)
    if (!card) {
      err.line(`river mark add: no card ${o.anchor} on board ${o.board}`)
      return 1
    }
    // Card height follows its content; three quarters of the width is a fair guess for the circle.
    const h = card.w * 0.75
    outline = ellipse(card.x + card.w / 2, card.y + h / 2, card.w / 2 + 20, h / 2 + 20)
  }
  const mark = await saveMark(root, o.board, {
    shape: "circle",
    path: outline,
    anchors: o.anchor ? [o.anchor] : [],
    thread: [{ by: "you", at: new Date().toISOString(), text }],
    madeBy: "you",
  })
  out.line(mark.id)
  return 0
}

const indent = (text: string, by: string) => text.split("\n").join(`\n${by}`)

function printJob(root: string, job: Job, out: Out): void {
  out.line(`job ${job.id}  ${job.status}`)
  out.line(`  mark ${job.markId} on board ${job.board}, concept concepts/${job.conceptId}/${job.parentJobId ? `, revises ${job.parentJobId}` : ""}`)
  if (job.summary) out.line(`  summary: ${indent(job.summary, "           ")}`)
  if (job.error) out.line(`  error: ${indent(job.error, "         ")}`)
  for (const s of job.scripts ?? []) {
    const option = s.variant ? `  option ${s.variant.toUpperCase()}${s.caption ? ` "${s.caption}"` : ""}` : ""
    const render = !s.render ? "" : s.render.ok ? "  rendered" : "  render failed"
    out.line(`  script: ${s.file}  sha256 ${s.sha256}  ${s.approved ? "approved" : "not approved"}${s.accepted ? "  accepted" : ""}${option}${render}`)
    const png = path.join(root, ".river", "jobs", job.id, jobRenderName(s.variant))
    if (existsSync(png)) out.line(`  render: ${png}`)
  }
}

/** --sha256 values as approveJobScripts takes them: a bare hex for a job with one script, "<letter>=<hex>" per option. */
function shaMap(job: Job, values: string[]): Record<string, string> | string {
  const scripts = job.scripts ?? []
  const map: Record<string, string> = {}
  for (const value of values) {
    const [, letter, hex] = /^(?:([a-eA-E])=)?([0-9a-fA-F]{64})$/.exec(value.trim()) ?? []
    if (!hex) return `--sha256 takes <hex>, or <letter>=<hex> for an option; got ${JSON.stringify(value)}`
    const script = letter ? scripts.find((s) => s.variant === letter.toLowerCase()) : scripts.length === 1 ? scripts[0] : undefined
    if (!script) return letter ? `job ${job.id} has no option ${letter}` : `job ${job.id} has ${scripts.length} scripts: pass --sha256 <letter>=<hex> for each`
    map[script.file] = hex.toLowerCase()
  }
  return map
}

const shaArgs = (scripts: { variant?: string; sha256: string }[]) => scripts.map((s) => `--sha256 ${s.variant ? `${s.variant}=` : ""}${s.sha256}`).join(" ")

/** Turn progress on stderr. Sums the cost of each turn's "done" event into `spent`. */
function progress(e: AgentEvent, err: Out, spent: { usd: number }): void {
  if (e.type === "done" && e.costUsd !== undefined) spent.usd += e.costUsd
  if (e.type === "text") err.line(`agent: ${e.text.trim()}`)
  else if (e.type === "tool") err.line(`  > ${e.tool}: ${e.summary}`)
  else if (e.type === "tool-result" && !e.ok) err.line(`  ! ${e.tool}: ${e.summary}`)
  else if (e.type === "error") err.line(`  error: ${e.message}`)
}

/** `river job start|revise|show|approve|accept|dismiss`. Loads @river/agent (and the SDK) only here. */
export async function cmdJob(sub: string | undefined, a: JobArgs, out: Out, err: Out): Promise<number> {
  const usage = (msg: string) => {
    err.line(`river job: ${msg}`)
    return 2
  }
  const root = (await loadProject(a.root)).root
  const agent = await import("@river/agent")
  const spent = { usd: 0 }
  const onEvent = (e: AgentEvent) => progress(e, err, spent)
  const cost = () => {
    if (spent.usd > 0) out.line(`cost: $${spent.usd.toFixed(4)} (as Claude reported it; a resumed session reports its earlier turns too)`)
  }

  const settings = () => {
    const backend = (a.backend ?? "claude-code") as AgentBackend
    const model = (a.model ?? "claude-sonnet-5-5") as AgentModel
    if (!BACKENDS.includes(backend)) return `--backend is ${BACKENDS.join(" or ")}`
    if (!MODELS.includes(model)) return `--model is ${MODELS.join(" or ")}`
    const apiKey = process.env.ANTHROPIC_API_KEY
    if (backend === "api-key" && !apiKey) return "the api-key backend reads ANTHROPIC_API_KEY"
    return { model, backend, ...(backend === "api-key" && apiKey ? { apiKey } : {}) }
  }
  const afterTurn = (job: Job) => {
    printJob(root, job, out)
    cost()
    if (job.status === "approval") out.line(`next: river job approve --root ${root} --job ${job.id}`)
    return job.status === "approval" ? 0 : 1
  }

  if (sub === "start") {
    if (!a.mark) return usage("start needs --mark <id>")
    const s = settings()
    if (typeof s === "string") return usage(s)
    const request = { workspaceRoot: root, board: a.board ?? DEFAULT_BOARD, markId: a.mark, ...(a.job ? { jobId: a.job } : {}), ...(a.by ? { by: a.by } : {}), ...s }
    return afterTurn(await agent.startConceptJob(request, { onEvent }))
  }

  if (!a.job) return usage(`${sub ?? "job"} needs --job <id>`)
  switch (sub) {
    case "revise": {
      const s = settings()
      if (typeof s === "string") return usage(s)
      return afterTurn(await agent.reviseJob(root, a.job, s, { onEvent }))
    }
    case "show": {
      printJob(root, await loadJob(root, a.job), out)
      return 0
    }
    case "approve": {
      // Two steps, so what runs is what the user read: the run step takes the sha256 printed by the read step.
      if (a.yes) {
        if (!a.sha256?.length) {
          return usage("approve --yes needs --sha256 for every script: run `river job approve --job <id>` first, read the scripts, then pass the sha256 values it printed")
        }
        const shas = shaMap(await loadJob(root, a.job), a.sha256)
        if (typeof shas === "string") return usage(shas)
        const before = await loadJob(root, a.job)
        const apiKey = process.env.ANTHROPIC_API_KEY
        // The look at the renders runs as the job ran; an api-key job needs the key from the environment again.
        const selfCheck = a["skip-self-check"] ? false : before.backend === "api-key" && apiKey ? { model: before.model as AgentModel, backend: before.backend, apiKey } : undefined
        const job = await agent.approveJobScripts(root, a.job, shas, { onEvent, ...(selfCheck !== undefined ? { selfCheck } : {}) })
        printJob(root, job, out)
        cost()
        return job.status === "answered" ? 0 : 1
      }
      const scripts = await agent.readJobScripts(root, a.job)
      for (const script of scripts) {
        out.line(`${script.file}  sha256 ${script.sha256}${script.variant ? `  option ${script.variant.toUpperCase()}${script.caption ? ` "${script.caption}"` : ""}` : ""}`)
        out.line("-".repeat(60))
        out.write(script.text.endsWith("\n") ? script.text : `${script.text}\n`)
        out.line("-".repeat(60))
      }
      out.line(`Not run. Running a script executes its code on this computer. Read ${scripts.length === 1 ? "it" : `all ${scripts.length}`}; to run exactly these bytes:`)
      out.line(`  river job approve --root ${root} --job ${a.job} ${shaArgs(scripts)} --yes`)
      return 0
    }
    case "accept": {
      const variants = a.variants?.split(",").map((v) => v.trim()).filter(Boolean)
      const job = await agent.acceptJob(root, a.job, variants ? { variants } : {})
      printJob(root, job, out)
      return job.status === "accepted" ? 0 : 1
    }
    case "dismiss": {
      printJob(root, await agent.dismissJob(root, a.job, a.reason), out)
      return 0
    }
    default:
      return usage("use start, revise, show, approve, accept or dismiss")
  }
}

const START_HINT = [
  "Put something on it first:",
  "  river card add --passage stories/<file>.twee#<passage id>   a passage of a story",
  '  river card add --note "..."                               a note',
  '  river mark add --text "..." [--anchor <cardId>]           a request for an agent',
]

/** `river board show`: the board as compact text, the way agents read it with board_read. */
export async function cmdBoard(sub: string | undefined, o: { root: string; board: string }, out: Out, err: Out): Promise<number> {
  if (sub !== "show") {
    err.line('river board: the only command is "board show [--board <name>]"')
    return 2
  }
  const root = (await loadProject(o.root)).root
  const boards = await listBoards(root)
  if (!boards.includes(o.board)) {
    err.line(`river board show: no board ${o.board} yet. Boards: ${boards.join(", ") || "(none yet)"}`)
    for (const l of START_HINT) err.line(l)
    return 1
  }
  const board = await loadBoard(root, o.board)
  out.line(formatBoard(board, await frameCardFiles(root, board)))
  if (board.cards.length + board.marks.length === 0) for (const l of START_HINT) out.line(l)
  return 0
}

export interface CardArgs {
  root: string
  board: string
  passage?: string | undefined
  note?: string | undefined
  image?: string | undefined
  caption?: string | undefined
  licence?: string | undefined
  /** Put the card right of this card or mark. Default: under everything. */
  anchor?: string | undefined
}

/** `river card add --passage <file#id> | --note "..." | --image <file> --licence "..."`: one card at a free spot. Prints its id. */
export async function cmdCard(sub: string | undefined, a: CardArgs, out: Out, err: Out): Promise<number> {
  const given = [a.passage, a.note, a.image].filter((v) => v !== undefined).length
  if (sub !== "add" || given !== 1) {
    err.line('river card: use "card add" with one of --passage <file>#<passage id>, --note "...", or --image <file> --licence "..."')
    return 2
  }
  const project = await loadProject(a.root)
  const root = project.root
  let card: Omit<Card, "id" | "createdAt" | "x" | "y" | "madeBy">
  if (a.passage !== undefined) {
    const [file = "", id = ""] = a.passage.split("#")
    const story = await loadStory(project, file).catch(() => undefined)
    if (!story) return (err.line(`river card add: no story file ${file}`), 1)
    if (!passageById(story.story, id)) return (err.line(`river card add: ${file} has no passage with id "${id}" (river paths and story_read list them)`), 1)
    card = { kind: "passage", ref: `${normalizeRel(file)}#${id}`, w: 280 }
  } else if (a.note !== undefined) {
    if (!a.note.trim()) return (err.line("river card add: --note needs text"), 2)
    card = { kind: "note", ref: "", text: a.note, w: NOTE_CARD_W }
  } else {
    const rel = normalizeRel(a.image!)
    if (!rel || !/\.(png|jpe?g|webp|gif)$/i.test(rel) || !existsSync(safePath(project, rel))) return (err.line(`river card add: ${a.image} is not an image file under the project`), 1)
    if (!a.licence?.trim()) return (err.line('river card add: an image card needs --licence, such as "own work" or "CC BY 4.0"'), 2)
    card = { kind: "ref", ref: rel, w: IMAGE_CARD_W, source: { licence: a.licence.trim() } }
  }
  if (a.caption && card.kind !== "note") card = { ...card, caption: a.caption }
  await ensureBoard(root, a.board)
  const board = await loadBoard(root, a.board)
  let start = freeStart(board)
  if (a.anchor) {
    const at = board.cards.find((c) => c.id === a.anchor)
    if (!at) return (err.line(`river card add: no card ${a.anchor} on board ${a.board}`), 1)
    start = { x: at.x + at.w + BOARD_GAP, y: at.y }
  }
  const [spot] = placeRow(start, [{ w: card.w, h: cardHeight(card) }], occupiedRects(board))
  const saved = await saveCard(root, a.board, { ...card, ...spot!, madeBy: "you" })
  out.line(saved.id)
  return 0
}
