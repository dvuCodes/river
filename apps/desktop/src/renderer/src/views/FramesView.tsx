import { type MouseEvent as ReactMouseEvent, useEffect, useRef, useState } from "react"
import type { ChangePlan, ReviewStatus, ReviewThread } from "@river/core"
import type { CaptureDTO, FramesDTO, ShotDTO } from "../../../shared/api"
import { cx, errorText, shortTime, useSmokeReady } from "../util"

export type AgentIntent = { mode: "plan"; threadId: string } | { mode: "implement"; planId: string }

type Box = [number, number, number, number]
const STATUSES: ReviewStatus[] = ["open", "planned", "accepted", "done", "wontfix"]

function FrameImage(props: {
  url: string
  threads: ReviewThread[]
  draft?: Box | undefined
  onDraw?: ((box: Box) => void) | undefined
  activeThread?: string | undefined
}) {
  const { url, threads, draft, onDraw, activeThread } = props
  const img = useRef<HTMLImageElement>(null)
  const [natural, setNatural] = useState<[number, number] | null>(null)
  const [drag, setDrag] = useState<{ x0: number; y0: number; x1: number; y1: number } | null>(null)
  const [failed, setFailed] = useState(false)

  const toImage = (e: ReactMouseEvent) => {
    const el = img.current!
    const r = el.getBoundingClientRect()
    const sx = el.naturalWidth / r.width
    const sy = el.naturalHeight / r.height
    const x = Math.max(0, Math.min(el.naturalWidth, (e.clientX - r.left) * sx))
    const y = Math.max(0, Math.min(el.naturalHeight, (e.clientY - r.top) * sy))
    return [x, y] as const
  }
  const pct = (b: Box) =>
    natural
      ? { left: `${(b[0] / natural[0]) * 100}%`, top: `${(b[1] / natural[1]) * 100}%`, width: `${(b[2] / natural[0]) * 100}%`, height: `${(b[3] / natural[1]) * 100}%` }
      : { display: "none" }
  const live: Box | undefined = drag
    ? [Math.min(drag.x0, drag.x1), Math.min(drag.y0, drag.y1), Math.abs(drag.x1 - drag.x0), Math.abs(drag.y1 - drag.y0)]
    : draft

  if (failed) return <div className="frame-missing">Image not found: {decodeURIComponent(url.replace("river-file://project/", ""))}</div>
  return (
    <div
      className={cx("frame", onDraw && "can-draw")}
      onMouseDown={(e) => {
        if (!onDraw || !natural) return
        e.preventDefault()
        const [x, y] = toImage(e)
        setDrag({ x0: x, y0: y, x1: x, y1: y })
      }}
      onMouseMove={(e) => {
        if (!drag) return
        const [x, y] = toImage(e)
        setDrag({ ...drag, x1: x, y1: y })
      }}
      onMouseUp={() => {
        if (drag && live && live[2] > 4 && live[3] > 4) onDraw?.(live.map(Math.round) as Box)
        setDrag(null)
      }}
    >
      <img ref={img} src={url} alt="" draggable={false} onLoad={(e) => setNatural([e.currentTarget.naturalWidth, e.currentTarget.naturalHeight])} onError={() => setFailed(true)} />
      {threads.map(
        (t, i) =>
          t.target.box && (
            <span key={t.id} className={cx("frame-box", activeThread === t.id && "is-active", `st-${t.status}`)} style={pct(t.target.box)}>
              <span className="frame-box-n">{i + 1}</span>
            </span>
          ),
      )}
      {live && <span className="frame-box is-draft" style={pct(live)} />}
    </div>
  )
}

function CapturePicker(props: { label: string; captures: CaptureDTO[]; value: number; onChange(i: number): void }) {
  return (
    <label className="tb-field">
      <span className="tb-label">{props.label}</span>
      <select value={props.value} onChange={(e) => props.onChange(Number(e.target.value))}>
        {props.captures.map((c, i) => (
          <option key={c.at} value={i}>
            {c.rev} · {shortTime(c.at)}
          </option>
        ))}
      </select>
    </label>
  )
}

function ThreadCard(props: { thread: ReviewThread; n: number; active: boolean; onFocus(): void; onAgent(i: AgentIntent): void; onChanged(): void }) {
  const { thread: t, n, active, onFocus, onAgent, onChanged } = props
  const [text, setText] = useState("")
  const [err, setErr] = useState<string | null>(null)
  const act = async (fn: () => Promise<unknown>) => {
    try {
      await fn()
      setErr(null)
      onChanged()
    } catch (e) {
      setErr(errorText(e))
    }
  }
  return (
    <li className={cx("thread", active && "is-active")} onClick={onFocus}>
      <header className="thread-head">
        <span className="thread-n">{n}</span>
        <span className="mono thread-rev">
          {t.target.rev}
          {t.target.frame !== undefined ? ` · f${t.target.frame}` : ""}
        </span>
        <select
          className={cx("status-select", `st-${t.status}`)}
          value={t.status}
          onClick={(e) => e.stopPropagation()}
          onChange={(e) => void act(() => window.river.setThreadStatus(t.id, e.target.value as ReviewStatus))}
        >
          {STATUSES.map((s) => (
            <option key={s}>{s}</option>
          ))}
        </select>
      </header>
      <ul className="msgs">
        {t.messages.map((m, i) => (
          <li key={i}>
            <span className="msg-who">{m.author}</span>
            <span className="msg-at">{shortTime(m.at)}</span>
            <p>{m.text}</p>
          </li>
        ))}
      </ul>
      {active && (
        <>
          <form
            className="reply"
            onSubmit={(e) => {
              e.preventDefault()
              if (text.trim()) void act(() => window.river.reply(t.id, text.trim())).then(() => setText(""))
            }}
          >
            <input value={text} onChange={(e) => setText(e.target.value)} placeholder="Reply…" />
            <button className="btn" disabled={!text.trim()}>
              Reply
            </button>
          </form>
          <button className="btn btn-agent" onClick={() => onAgent({ mode: "plan", threadId: t.id })}>
            Ask agent for a plan
          </button>
        </>
      )}
      {err && <p className="err-note">{err}</p>}
    </li>
  )
}

function PlanCard(props: { plan: ChangePlan; onAgent(i: AgentIntent): void; onChanged(): void }) {
  const { plan: p, onAgent, onChanged } = props
  const [err, setErr] = useState<string | null>(null)
  const set = async (status: ChangePlan["status"]) => {
    try {
      await window.river.setPlanStatus(p.id, status)
      setErr(null)
      onChanged()
    } catch (e) {
      setErr(errorText(e))
    }
  }
  return (
    <li className="plan">
      <header className="plan-head">
        <span className={cx("plan-status", `ps-${p.status}`)}>{p.status}</span>
        <span className="plan-title">{p.title}</span>
      </header>
      <p className="plan-why">{p.rationale}</p>
      <ul className="plan-steps">
        {p.steps.map((s, i) => (
          <li key={i}>
            <span className="mono">{s.file}</span> — {s.change}
          </li>
        ))}
      </ul>
      {p.recapture.length > 0 && <p className="plan-meta">Recapture: {p.recapture.join(", ")}</p>}
      <footer className="plan-actions">
        {p.status === "draft" && (
          <>
            <button className="btn" onClick={() => void set("rejected")}>
              Reject
            </button>
            <button className="btn btn-primary" onClick={() => void set("approved")}>
              Approve
            </button>
          </>
        )}
        {p.status === "approved" && (
          <button className="btn btn-agent" onClick={() => onAgent({ mode: "implement", planId: p.id })}>
            Run approved plan
          </button>
        )}
      </footer>
      {err && <p className="err-note">{err}</p>}
    </li>
  )
}

export function FramesView(props: { tick: number; onAgent(i: AgentIntent): void }) {
  const { tick, onAgent } = props
  const [data, setData] = useState<FramesDTO | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [shotId, setShotId] = useState<string | undefined>()
  const [a, setA] = useState(0)
  const [b, setB] = useState(1)
  const [frame, setFrame] = useState(0)
  const [compare, setCompare] = useState(false)
  const [draft, setDraft] = useState<Box | undefined>()
  const [comment, setComment] = useState("")
  const [activeThread, setActiveThread] = useState<string | undefined>()
  const [busy, setBusy] = useState(false)
  const [localTick, setLocalTick] = useState(0)

  useEffect(() => {
    let live = true
    window.river.frames().then(
      (d) => {
        if (!live) return
        setData(d)
        setError(null)
        setShotId((s) => (s && d.shots.some((x) => x.id === s) ? s : d.shots[0]?.id))
      },
      (e) => live && setError(errorText(e)),
    )
    return () => {
      live = false
    }
  }, [tick, localTick])
  useSmokeReady("frames", data !== null || error !== null)

  const refresh = () => setLocalTick((t) => t + 1)
  const shot: ShotDTO | undefined = data?.shots.find((s) => s.id === shotId)
  const caps = shot?.captures ?? []
  const capA = caps[Math.min(a, caps.length - 1)]
  const capB = caps[Math.min(b, caps.length - 1)]
  const threads = data?.threads.filter((t) => t.target.shotId === shotId) ?? []
  const frameThreads = threads.filter((t) => t.target.frame === undefined || t.target.frame === frame)

  const capture = async () => {
    if (!shot) return
    setBusy(true)
    try {
      await window.river.capture(shot.id)
      setA(0)
      setB(1)
      refresh()
    } catch (e) {
      setError(errorText(e))
    } finally {
      setBusy(false)
    }
  }
  const addThread = async () => {
    if (!shot || !capA || !comment.trim()) return
    try {
      await window.river.addThread({ shotId: shot.id, rev: capA.rev, frame, ...(draft ? { box: draft } : {}) }, comment.trim())
      setComment("")
      setDraft(undefined)
      refresh()
    } catch (e) {
      setError(errorText(e))
    }
  }

  return (
    <div className="view">
      <div className="toolbar">
        <span className="tb-label">Frames</span>
        {shot && caps.length > 0 && (
          <>
            <CapturePicker label={compare ? "Before" : "Capture"} captures={caps} value={Math.min(compare ? b : a, caps.length - 1)} onChange={compare ? setB : setA} />
            {compare && <CapturePicker label="After" captures={caps} value={Math.min(a, caps.length - 1)} onChange={setA} />}
            {(capA?.urls.length ?? 0) > 1 && (
              <label className="tb-field">
                <span className="tb-label">Frame</span>
                <input className="mono frame-num" type="number" min={0} max={(capA?.urls.length ?? 1) - 1} value={frame} onChange={(e) => setFrame(Number(e.target.value))} />
              </label>
            )}
            <label className="toggle">
              <input type="checkbox" checked={compare} disabled={caps.length < 2} onChange={(e) => setCompare(e.target.checked)} />
              Compare
            </label>
          </>
        )}
        <div className="tb-spacer" />
        {data && <span className="tb-meta">engine: {data.engine}</span>}
        <button className="btn btn-primary" disabled={!shot || !data?.canCapture || busy} title={data?.canCapture ? "Run the engine and save new frames" : `Engine "${data?.engine}" has no capture adapter`} onClick={() => void capture()}>
          {busy ? "Capturing…" : "◉ Capture"}
        </button>
      </div>
      {error && <div className="banner banner-err">{error}</div>}
      <div className="framesview">
        <aside className="side-panel shots">
          <section className="panel-sec grow">
            <header className="sec-head">
              <h3>Shots</h3>
              <span className="sec-hint">{data?.shots.length ?? 0}</span>
            </header>
            <ul className="shot-list">
              {data?.shots.map((s) => (
                <li key={s.id}>
                  <button className={cx("shot", s.id === shotId && "is-picked")} onClick={() => { setShotId(s.id); setA(0); setB(1); setFrame(0); setDraft(undefined) }}>
                    <span className="shot-id mono">{s.id}</span>
                    <span className="shot-meta">
                      {s.captures.length} captures · {s.count} frame{s.count === 1 ? "" : "s"}
                    </span>
                    {s.note && <span className="shot-note">{s.note}</span>}
                  </button>
                </li>
              ))}
            </ul>
            {data && data.shots.length === 0 && (
              <div className="empty-note">
                <p>No shots in river.json yet. A shot is a scene plus a setup script that freezes it:</p>
                <pre className="mono snippet">{`"shots": [{
  "id": "level_1_intro",
  "scene": "res://scenes/level_1.tscn",
  "setup": "res://tools/shots/taut.gd",
  "count": 1
}]`}</pre>
              </div>
            )}
          </section>
        </aside>
        <main className="stage">
          {!shot ? (
            <div className="stage-empty">
              <div className="stage-glyph" aria-hidden>
                <span />
                <span />
              </div>
              <h2>No frame to review</h2>
              <p>
                Captures of each shot appear here. Pick two captures to compare before and after, draw a box on a frame and leave a comment; the
                agent can answer a comment with a change plan.
              </p>
            </div>
          ) : caps.length === 0 ? (
            <div className="stage-empty">
              <h2>{shot.id} has no captures</h2>
              <p>{data?.canCapture ? "Press Capture to run the engine and save frames." : `Engine "${data?.engine}" cannot capture from the app.`}</p>
            </div>
          ) : compare && capA && capB ? (
            <div className="compare">
              <figure>
                <figcaption>
                  Before · <span className="mono">{capB.rev}</span> · {shortTime(capB.at)}
                </figcaption>
                {capB.urls[frame] && <FrameImage url={capB.urls[frame]} threads={[]} />}
              </figure>
              <figure>
                <figcaption>
                  After · <span className="mono">{capA.rev}</span> · {shortTime(capA.at)}
                </figcaption>
                {capA.urls[frame] && <FrameImage url={capA.urls[frame]} threads={frameThreads} activeThread={activeThread} />}
              </figure>
            </div>
          ) : (
            capA?.urls[frame] && (
              <div className="single">
                <FrameImage url={capA.urls[frame]} threads={frameThreads} draft={draft} onDraw={setDraft} activeThread={activeThread} />
                <p className="stage-hint">Drag on the frame to mark a box for a new comment.</p>
              </div>
            )
          )}
        </main>
        <aside className="side-panel review">
          <section className="panel-sec grow">
            <header className="sec-head">
              <h3>Review threads</h3>
              <span className="sec-hint">{threads.length}</span>
            </header>
            {shot && capA && (
              <form
                className="new-thread"
                onSubmit={(e) => {
                  e.preventDefault()
                  void addThread()
                }}
              >
                <textarea value={comment} onChange={(e) => setComment(e.target.value)} placeholder={draft ? "Comment on the marked box…" : "Comment on this frame…"} rows={2} />
                <div className="new-thread-foot">
                  <span className="mono sec-hint">{draft ? `box ${draft.join(", ")}` : "no box"}</span>
                  {draft && (
                    <button type="button" className="link-btn" onClick={() => setDraft(undefined)}>
                      clear
                    </button>
                  )}
                  <button className="btn" disabled={!comment.trim()}>
                    Comment
                  </button>
                </div>
              </form>
            )}
            <ol className="thread-list">
              {threads.map((t, i) => (
                <ThreadCard key={t.id} thread={t} n={i + 1} active={activeThread === t.id} onFocus={() => setActiveThread(t.id)} onAgent={onAgent} onChanged={refresh} />
              ))}
              {threads.length === 0 && <li className="empty-note">No comments on this shot.</li>}
            </ol>
          </section>
          <section className="panel-sec grow">
            <header className="sec-head">
              <h3>Change plans</h3>
              <span className="sec-hint">{data?.plans.length ?? 0}</span>
            </header>
            <ol className="plan-list">
              {data?.plans.map((p) => <PlanCard key={p.id} plan={p} onAgent={onAgent} onChanged={refresh} />)}
              {data?.plans.length === 0 && <li className="empty-note">No plans yet. Ask the agent to answer a review thread with one.</li>}
            </ol>
          </section>
        </aside>
      </div>
    </div>
  )
}
