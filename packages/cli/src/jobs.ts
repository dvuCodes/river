import { existsSync } from "node:fs"
import path from "node:path"
import { DEFAULT_BOARD, ensureBoard, formatBoard, jobRenderName, listBoards, loadBoard, loadJob, loadProject, replyToMark, saveMark, type Job } from "@river/core"
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

/**
 * `river mark add`: a circle mark with one message, around a card or at 0,0. Prints the mark id.
 * `river mark reply`: add the user's message to a mark's thread (then `job revise` answers it).
 */
export async function cmdMark(
  sub: string | undefined,
  o: { root: string; board: string; text?: string | undefined; anchor?: string | undefined; mark?: string | undefined },
  out: Out,
  err: Out,
): Promise<number> {
  if (sub !== "add" && sub !== "reply") {
    err.line('river mark: use "mark add --text ..." or "mark reply --mark <id> --text ..."')
    return 2
  }
  const text = o.text?.trim()
  if (!text) {
    err.line(`river mark ${sub}: --text is required`)
    return 2
  }
  const root = (await loadProject(o.root)).root
  if (sub === "reply") {
    if (!o.mark) {
      err.line("river mark reply: --mark <id> is required")
      return 2
    }
    const mark = await replyToMark(root, o.board, o.mark, "you", text)
    out.line(`${mark.id}  ${mark.status}  ${mark.thread.length} messages${mark.jobId ? `  job ${mark.jobId}` : ""}`)
    if (mark.jobId && mark.status === "answered") out.line(`next: river job revise --root ${root} --job ${mark.jobId}`)
    return 0
  }
  await ensureBoard(root, o.board)
  let outline = ellipse(0, 0, 40, 40)
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

function progress(e: AgentEvent, err: Out): void {
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
    if (job.status === "approval") out.line(`next: river job approve --root ${root} --job ${job.id}`)
    return job.status === "approval" ? 0 : 1
  }

  if (sub === "start") {
    if (!a.mark) return usage("start needs --mark <id>")
    const s = settings()
    if (typeof s === "string") return usage(s)
    return afterTurn(await agent.startConceptJob({ workspaceRoot: root, board: a.board ?? DEFAULT_BOARD, markId: a.mark, ...s }, { onEvent: (e) => progress(e, err) }))
  }

  if (!a.job) return usage(`${sub ?? "job"} needs --job <id>`)
  switch (sub) {
    case "revise": {
      const s = settings()
      if (typeof s === "string") return usage(s)
      return afterTurn(await agent.reviseJob(root, a.job, s, { onEvent: (e) => progress(e, err) }))
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
        const job = await agent.approveJobScripts(root, a.job, shas)
        printJob(root, job, out)
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

/** `river board show`: the board as compact text, the way agents read it with board_read. */
export async function cmdBoard(sub: string | undefined, o: { root: string; board: string }, out: Out, err: Out): Promise<number> {
  if (sub !== "show") {
    err.line('river board: the only command is "board show [--board <name>]"')
    return 2
  }
  const root = (await loadProject(o.root)).root
  const boards = await listBoards(root)
  if (!boards.includes(o.board)) {
    err.line(`river board show: no board ${o.board}. Boards: ${boards.join(", ") || "(none yet)"}`)
    return 1
  }
  out.line(formatBoard(await loadBoard(root, o.board)))
  return 0
}
