import { existsSync } from "node:fs"
import path from "node:path"
import { DEFAULT_BOARD, ensureBoard, loadBoard, loadJob, loadProject, saveMark, type Job } from "@river/core"
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

/** `river mark add`: a circle mark with one message, around a card or at 0,0. Prints the mark id. */
export async function cmdMark(sub: string | undefined, o: { root: string; board: string; text?: string | undefined; anchor?: string | undefined }, out: Out, err: Out): Promise<number> {
  if (sub !== "add") {
    err.line('river mark: the only command is "mark add --text ..."')
    return 2
  }
  const text = o.text?.trim()
  if (!text) {
    err.line("river mark add: --text is required")
    return 2
  }
  const root = (await loadProject(o.root)).root
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

function printJob(root: string, job: Job, out: Out): void {
  out.line(`job ${job.id}  ${job.status}`)
  out.line(`  mark ${job.markId} on board ${job.board}, concept concepts/${job.conceptId}/`)
  if (job.summary) out.line(`  summary: ${job.summary}`)
  if (job.error) out.line(`  error: ${job.error.split("\n").join("\n         ")}`)
  for (const s of job.scripts ?? []) out.line(`  script: ${s.file}  sha256 ${s.sha256}  ${s.approved ? "approved" : "not approved"}`)
  const render = path.join(root, ".river", "jobs", job.id, "render.png")
  if (existsSync(render)) out.line(`  render: ${render}`)
}

function progress(e: AgentEvent, err: Out): void {
  if (e.type === "text") err.line(`agent: ${e.text.trim()}`)
  else if (e.type === "tool") err.line(`  > ${e.tool}: ${e.summary}`)
  else if (e.type === "tool-result" && !e.ok) err.line(`  ! ${e.tool}: ${e.summary}`)
  else if (e.type === "error") err.line(`  error: ${e.message}`)
}

/** `river job start|show|approve|accept|dismiss`. Loads @river/agent (and the SDK) only here. */
export async function cmdJob(sub: string | undefined, a: JobArgs, out: Out, err: Out): Promise<number> {
  const usage = (msg: string) => {
    err.line(`river job: ${msg}`)
    return 2
  }
  const root = (await loadProject(a.root)).root
  const agent = await import("@river/agent")

  if (sub === "start") {
    if (!a.mark) return usage("start needs --mark <id>")
    const backend = (a.backend ?? "claude-code") as AgentBackend
    const model = (a.model ?? "claude-sonnet-5-5") as AgentModel
    if (!BACKENDS.includes(backend)) return usage(`--backend is ${BACKENDS.join(" or ")}`)
    if (!MODELS.includes(model)) return usage(`--model is ${MODELS.join(" or ")}`)
    const apiKey = process.env.ANTHROPIC_API_KEY
    if (backend === "api-key" && !apiKey) return usage("the api-key backend reads ANTHROPIC_API_KEY")
    const job = await agent.startConceptJob(
      { workspaceRoot: root, board: a.board ?? DEFAULT_BOARD, markId: a.mark, model, backend, ...(backend === "api-key" && apiKey ? { apiKey } : {}) },
      { onEvent: (e) => progress(e, err) },
    )
    printJob(root, job, out)
    if (job.status === "approval") out.line(`next: river job approve --root ${root} --job ${job.id}`)
    return job.status === "approval" ? 0 : 1
  }

  if (!a.job) return usage(`${sub ?? "job"} needs --job <id>`)
  switch (sub) {
    case "show": {
      printJob(root, await loadJob(root, a.job), out)
      return 0
    }
    case "approve": {
      const script = await agent.readJobScript(root, a.job)
      out.line(`${script.file}  sha256 ${script.sha256}`)
      out.line("-".repeat(60))
      out.write(script.text.endsWith("\n") ? script.text : `${script.text}\n`)
      out.line("-".repeat(60))
      if (!a.yes) {
        out.line("Not run. Running a script executes its code on this computer. Read it, then add --yes to run exactly these bytes.")
        return 0
      }
      const job = await agent.approveJobScript(root, a.job, script.sha256)
      printJob(root, job, out)
      return job.status === "answered" ? 0 : 1
    }
    case "accept": {
      const job = await agent.acceptJob(root, a.job)
      printJob(root, job, out)
      return job.status === "accepted" ? 0 : 1
    }
    case "dismiss": {
      printJob(root, await agent.dismissJob(root, a.job), out)
      return 0
    }
    default:
      return usage("use start, show, approve, accept or dismiss")
  }
}
