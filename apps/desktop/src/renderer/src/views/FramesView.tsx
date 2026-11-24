import { type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent, useEffect, useRef, useState } from "react"
import type { ChangePlan, ReviewStatus, ReviewThread } from "@river/core"
import type { CaptureDTO, FramesDTO, ShotDTO } from "../../../shared/api"
import { cx, errorText, shortTime, useSmokeReady } from "../util"
import { clampFrame, computeImageDiff, DEFAULT_FPS, FLIPBOOK_FPS, formatDiffReadout, type ImageDiff, type RawImage, stepFrame } from "./frameDiff"

export type AgentIntent = { mode: "plan"; threadId: string } | { mode: "implement"; planId: string }

type Box = [number, number, number, number]
const STATUSES: ReviewStatus[] = ["open", "planned", "accepted", "done", "wontfix"]

type CompareMode = "side-by-side" | "swipe" | "onion" | "diff"
const COMPARE_MODES: { id: CompareMode; label: string }[] = [
  { id: "side-by-side", label: "Side by side" },
  { id: "swipe", label: "Swipe" },
  { id: "onion", label: "Onion" },
  { id: "diff", label: "Diff" },
]

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

/** Decoded pixels per image URL (URLs carry the file's mtime, so a new render has a new key). Kept small: a frame is MBs. */
const pixelCache = new Map<string, Promise<RawImage>>()
const PIXEL_CACHE_MAX = 24

function loadPixels(url: string): Promise<RawImage> {
  const hit = pixelCache.get(url)
  if (hit) return hit
  const p = new Promise<RawImage>((resolve, reject) => {
    const img = new Image()
    img.crossOrigin = "anonymous"
    img.onload = () => {
      try {
        const c = document.createElement("canvas")
        c.width = img.naturalWidth
        c.height = img.naturalHeight
        const ctx = c.getContext("2d", { willReadFrequently: true })
        if (!ctx) throw new Error("No 2D canvas available")
        ctx.drawImage(img, 0, 0)
        const px = ctx.getImageData(0, 0, c.width, c.height)
        resolve({ data: px.data, width: px.width, height: px.height })
      } catch (e) {
        reject(e)
      }
    }
    img.onerror = () => reject(new Error("The image could not be read for diffing"))
    img.src = url
  })
  pixelCache.set(url, p)
  p.catch(() => pixelCache.delete(url))
  if (pixelCache.size > PIXEL_CACHE_MAX) pixelCache.delete(pixelCache.keys().next().value as string)
  return p
}

type DiffState = { kind: "loading" } | { kind: "error"; message: string } | { kind: "ready"; diff: ImageDiff }

/** A real pixel diff of one frame in two captures, painted on a canvas with a readout of how much changed. */
function DiffView(props: { before: string | undefined; after: string | undefined }) {
  const { before, after } = props
  const canvas = useRef<HTMLCanvasElement>(null)
  const [state, setState] = useState<DiffState>({ kind: "loading" })

  useEffect(() => {
    if (!before || !after) return
    let live = true
    Promise.all([loadPixels(before), loadPixels(after)]).then(
      ([b, a]) => live && setState({ kind: "ready", diff: computeImageDiff(b, a) }),
      (e: unknown) => live && setState({ kind: "error", message: errorText(e) }),
    )
    return () => {
      live = false
    }
  }, [before, after])

  useEffect(() => {
    const c = canvas.current
    if (state.kind !== "ready" || !c) return
    const { data, width, height } = state.diff
    if (width === 0 || height === 0) return
    c.width = width
    c.height = height
    c.getContext("2d")?.putImageData(new ImageData(new Uint8ClampedArray(data), width, height), 0, 0)
  }, [state])

  if (!before || !after) return <p className="cmp-note">This frame is not in both captures, so there is nothing to diff.</p>
  if (state.kind === "error") return <p className="cmp-note is-err">Cannot diff these captures: {state.message}</p>
  if (state.kind === "loading") return <p className="cmp-note">Comparing…</p>
  return (
    <div className="cmp-diff">
      <div className="cmp-diff-head">
        <span className={cx("cmp-badge", state.diff.changedPixels === 0 && "is-same")} data-diff-percent={state.diff.percentChanged.toFixed(3)} role="status">
          {formatDiffReadout(state.diff)}
        </span>
        <span className="cmp-key">
          <i className="cmp-swatch is-changed" /> changed
          <i className="cmp-swatch is-size" /> only in one capture
        </span>
      </div>
      <canvas ref={canvas} className="cmp-canvas" aria-label="Pixel difference between the two captures" />
    </div>
  )
}

/** The After frame laid over the Before frame: wiped away at a draggable divider (swipe) or faded in (onion). */
function Overlay(props: {
  mode: "swipe" | "onion"
  before: string
  after: string
  threads: ReviewThread[]
  activeThread: string | undefined
  split: number
  onSplit(n: number): void
  opacity: number
}) {
  const { mode, split, onSplit } = props
  const swipe = mode === "swipe"
  const stack = useRef<HTMLDivElement>(null)
  const dragging = useRef(false)
  const moveTo = (e: ReactPointerEvent) => {
    const r = stack.current?.getBoundingClientRect()
    if (!r || r.width <= 0) return
    onSplit(Math.round(Math.max(0, Math.min(100, ((e.clientX - r.left) / r.width) * 100))))
  }
  return (
    <div
      ref={stack}
      className={cx("cmp-stack", `is-${mode}`)}
      data-compare-stack={mode}
      onPointerDown={(e) => {
        if (!swipe || e.button !== 0) return
        e.currentTarget.setPointerCapture(e.pointerId)
        dragging.current = true
        moveTo(e)
      }}
      onPointerMove={(e) => {
        if (swipe && dragging.current) moveTo(e)
      }}
      onPointerUp={() => {
        dragging.current = false
      }}
      onPointerCancel={() => {
        dragging.current = false
      }}
    >
      <FrameImage url={props.before} threads={[]} />
      <div className="cmp-top" style={swipe ? { clipPath: `inset(0 ${100 - split}% 0 0)` } : { opacity: props.opacity / 100 }}>
        <FrameImage url={props.after} threads={props.threads} activeThread={props.activeThread} />
      </div>
      <span className="cmp-tag is-after">After</span>
      <span className="cmp-tag is-before">Before</span>
      {swipe && (
        <span className="cmp-handle" data-handle style={{ left: `${split}%` }} aria-hidden>
          <i />
        </span>
      )}
    </div>
  )
}

/** Before and After of the chosen frame, in the toolbar's compare mode. */
function CompareStage(props: { mode: CompareMode; before: CaptureDTO; after: CaptureDTO; frame: number; threads: ReviewThread[]; activeThread: string | undefined }) {
  const { mode, before, after, frame } = props
  const [split, setSplit] = useState(50)
  const [opacity, setOpacity] = useState(50)
  const b = before.urls[frame]
  const a = after.urls[frame]

  if (mode === "side-by-side") {
    return (
      <div className="compare">
        <figure>
          <figcaption>
            Before · <span className="mono">{before.rev}</span> · {shortTime(before.at)}
          </figcaption>
          {b && <FrameImage url={b} threads={[]} />}
        </figure>
        <figure>
          <figcaption>
            After · <span className="mono">{after.rev}</span> · {shortTime(after.at)}
          </figcaption>
          {a && <FrameImage url={a} threads={props.threads} activeThread={props.activeThread} />}
        </figure>
      </div>
    )
  }
  const caption = (
    <p className="cmp-caption">
      Before <span className="mono">{before.rev}</span> · {shortTime(before.at)} → After <span className="mono">{after.rev}</span> · {shortTime(after.at)}
    </p>
  )
  if (mode === "diff") {
    return (
      <div className="compare-one" data-compare-mode="diff">
        {caption}
        <DiffView before={b} after={a} />
      </div>
    )
  }
  return (
    <div className="compare-one" data-compare-mode={mode}>
      {caption}
      {b && a ? (
        <>
          <Overlay mode={mode} before={b} after={a} threads={props.threads} activeThread={props.activeThread} split={split} onSplit={setSplit} opacity={opacity} />
          <label className="cmp-slider">
            <span className="tb-label">{mode === "swipe" ? "Split" : "After opacity"}</span>
            <input
              type="range"
              min={0}
              max={100}
              value={mode === "swipe" ? split : opacity}
              aria-label={mode === "swipe" ? "Swipe divider position" : "After image opacity"}
              data-compare-slider={mode}
              onChange={(e) => (mode === "swipe" ? setSplit : setOpacity)(Number(e.target.value))}
            />
            <span className="mono cmp-val">{mode === "swipe" ? split : opacity}%</span>
          </label>
        </>
      ) : (
        <p className="cmp-note">This frame is not in both captures.</p>
      )}
    </div>
  )
}

/** Play/pause, a scrubber, the frame readout and the frame rate for a capture of several frames. */
function FlipbookBar(props: { frame: number; count: number; playing: boolean; fps: number; onToggle(): void; onScrub(i: number): void; onFps(n: number): void }) {
  const { frame, count, playing } = props
  return (
    <div className="flipbook" role="group" aria-label="Flipbook playback">
      <button className="btn flip-play" data-action="flipbook-toggle" aria-pressed={playing} title={playing ? "Pause (Space)" : "Play (Space)"} onClick={props.onToggle}>
        {playing ? "❚❚ Pause" : "▶ Play"}
      </button>
      <input
        className="flip-scrub"
        type="range"
        min={0}
        max={count - 1}
        value={frame}
        aria-label="Frame"
        data-action="flipbook-scrub"
        onChange={(e) => props.onScrub(Number(e.target.value))}
      />
      <span className="mono flip-readout" data-flipbook-readout>
        {frame + 1} / {count}
      </span>
      <select className="flip-fps" value={props.fps} aria-label="Frames per second" data-action="flipbook-fps" onChange={(e) => props.onFps(Number(e.target.value))}>
        {FLIPBOOK_FPS.map((n) => (
          <option key={n} value={n}>
            {n} fps
          </option>
        ))}
      </select>
    </div>
  )
}

const EVERY = [1, 2, 3, 4] as const
const everyLabel = (n: number) => (n === 1 ? "every frame" : `every ${n === 2 ? "2nd" : n === 3 ? "3rd" : `${n}th`}`)

/**
 * Put this capture on the open board. One frame goes as a card; several go as a strip: the frames you tick (all, or
 * every Nth), in a row joined by connectors. Clicking a thumbnail shows that frame above.
 */
function SendToBoard(props: { shotId: string; capture: CaptureDTO; board: string; frame: number; onFrame(i: number): void; onOpenBoard(): void }) {
  const { capture, board } = props
  const n = capture.urls.length
  const [picked, setPicked] = useState<ReadonlySet<number>>(() => new Set(capture.urls.keys()))
  const [busy, setBusy] = useState(false)
  const [sent, setSent] = useState<{ count: number; board: string } | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const frames = [...picked].sort((a, b) => a - b)
  const everyNth = (k: number) => [...capture.urls.keys()].filter((i) => i % k === 0)
  /** The every-Nth choice the ticks match, or 0 once frames were ticked by hand. */
  const every = EVERY.find((k) => k < n && everyNth(k).join() === frames.join()) ?? 0
  const pickEvery = (k: number) => setPicked(new Set(everyNth(k)))
  const toggle = (i: number) =>
    setPicked((cur) => {
      const next = new Set(cur)
      if (next.has(i)) next.delete(i)
      else next.add(i)
      return next
    })
  const send = () => {
    setBusy(true)
    setErr(null)
    window.river.boardAddFrames(board, { shotId: props.shotId, capture: capture.at, frames: n === 1 ? [0] : frames }).then(
      (cards) => {
        setBusy(false)
        setSent({ count: cards.length, board })
      },
      (e: unknown) => {
        setBusy(false)
        setErr(errorText(e))
      },
    )
  }
  const done = sent && (
    <p className="send-done" role="status">
      {sent.count === 1 ? "Sent the frame" : `Sent ${sent.count} frames as a strip`} to <b>{sent.board}</b>.{" "}
      <button className="link-btn" data-action="open-board" onClick={props.onOpenBoard}>
        Open the board
      </button>
    </p>
  )
  if (n === 1) {
    return (
      <section className="send-board is-single">
        <button className="btn btn-primary" data-action="send-frame" disabled={busy} onClick={send}>
          Send to board
        </button>
        <span className="sec-hint">
          adds this frame to <b>{board}</b>
        </span>
        {done}
        {err && <p className="err-note">{err}</p>}
      </section>
    )
  }
  return (
    <section className="send-board" aria-label="Send frames to the board">
      <header className="strip-head">
        <span className="strip-title">Strip</span>
        <select className="strip-every" value={every} aria-label="Which frames" onChange={(e) => pickEvery(Number(e.target.value))}>
          {every === 0 && (
            <option value={0} disabled>
              your pick
            </option>
          )}
          {EVERY.filter((k) => k < n).map((k) => (
            <option key={k} value={k}>
              {everyLabel(k)}
            </option>
          ))}
        </select>
        <span className="sec-hint">
          {frames.length} of {n} frames
        </span>
        <span className="tb-spacer" />
        <button className="btn btn-primary" data-action="send-strip" disabled={busy || frames.length === 0} onClick={send}>
          {frames.length === 1 ? "Send to board" : "Send to board as strip"}
        </button>
      </header>
      <ol className="strip-frames">
        {capture.urls.map((url, i) => (
          <li key={url} className={cx("strip-frame", picked.has(i) && "is-picked", i === props.frame && "is-viewing")}>
            <button className="strip-thumb" data-frame={i} title={`Show frame ${i + 1}`} onClick={() => props.onFrame(i)}>
              <img src={url} alt={`Frame ${i + 1}`} draggable={false} />
            </button>
            <label className="strip-pick">
              <input type="checkbox" data-pick={i} checked={picked.has(i)} onChange={() => toggle(i)} />
              <span className="mono">{i + 1}</span>
            </label>
            {i < n - 1 && <span className="strip-link" aria-hidden />}
          </li>
        ))}
      </ol>
      {done}
      {err && <p className="err-note">{err}</p>}
    </section>
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
          {t.target.frame !== undefined ? ` · frame ${t.target.frame + 1}` : ""}
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

export function FramesView(props: { tick: number; board: string; onAgent(i: AgentIntent): void; onOpenBoard(): void }) {
  const { tick, board, onAgent } = props
  const [data, setData] = useState<FramesDTO | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [shotId, setShotId] = useState<string | undefined>()
  const [a, setA] = useState(0)
  const [b, setB] = useState(1)
  const [frameRaw, setFrame] = useState(0)
  const [compare, setCompare] = useState(false)
  const [compareMode, setCompareMode] = useState<CompareMode>("side-by-side")
  const [playing, setPlaying] = useState(false)
  const [fps, setFps] = useState<number>(DEFAULT_FPS)
  const [draft, setDraft] = useState<Box | undefined>()
  const [comment, setComment] = useState("")
  const [activeThread, setActiveThread] = useState<string | undefined>()
  const [busy, setBusy] = useState(false)
  const [busyAll, setBusyAll] = useState(false)
  const [localTick, setLocalTick] = useState(0)
  const [pinned, setPinned] = useState<string | null>(null)

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
  const frameCount = capA?.urls.length ?? 0
  const frame = clampFrame(frameRaw, frameCount)
  const threads = data?.threads.filter((t) => t.target.shotId === shotId) ?? []
  const frameThreads = threads.filter((t) => t.target.frame === undefined || t.target.frame === frame)

  // A capture with fewer frames pulls the stored frame back in, so returning to a longer one does not jump.
  useEffect(() => {
    if (frameRaw !== frame) setFrame(frame)
  }, [frameRaw, frame])
  // Playback belongs to one capture of one shot: switching either, or landing on a single frame, stops it.
  const captureAt = capA?.at
  useEffect(() => {
    setPlaying(false)
  }, [shotId, captureAt])
  useEffect(() => {
    if (frameCount <= 1) setPlaying(false)
  }, [frameCount])
  useEffect(() => {
    if (!playing || frameCount <= 1) return
    const id = window.setInterval(() => setFrame((f) => stepFrame(f, frameCount, 1)), 1000 / fps)
    return () => window.clearInterval(id)
  }, [playing, fps, frameCount])
  // Decode every frame ahead of a loop, so the first pass does not stutter on image loads.
  const preload = frameCount > 1 ? [...(capA?.urls ?? []), ...(compare ? (capB?.urls ?? []) : [])].join("\n") : ""
  useEffect(() => {
    for (const url of preload ? preload.split("\n") : []) new Image().src = url
  }, [preload])
  // Space plays or pauses, the arrows step a frame (and pause), unless a field has the keyboard.
  useEffect(() => {
    if (frameCount <= 1) return
    const free = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey) return false
      const t = e.target instanceof HTMLElement ? e.target : null
      return !(t && (t.isContentEditable || t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT"))
    }
    const isSpace = (e: KeyboardEvent) => e.key === " " || e.code === "Space"
    const onKey = (e: KeyboardEvent) => {
      if (!free(e)) return
      if (isSpace(e)) {
        e.preventDefault()
        if (!e.repeat) setPlaying((p) => !p)
      } else if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
        e.preventDefault()
        setPlaying(false)
        setFrame((f) => stepFrame(f, frameCount, e.key === "ArrowLeft" ? -1 : 1))
      }
    }
    // A focused button presses itself when Space is released; the toggle above already handled it.
    const onKeyUp = (e: KeyboardEvent) => {
      if (free(e) && isSpace(e)) e.preventDefault()
    }
    window.addEventListener("keydown", onKey)
    window.addEventListener("keyup", onKeyUp)
    return () => {
      window.removeEventListener("keydown", onKey)
      window.removeEventListener("keyup", onKeyUp)
    }
  }, [frameCount])
  const flipbook = frameCount > 1 && (
    <FlipbookBar
      frame={frame}
      count={frameCount}
      playing={playing}
      fps={fps}
      onToggle={() => setPlaying((p) => !p)}
      onScrub={(i) => {
        setPlaying(false)
        setFrame(i)
      }}
      onFps={setFps}
    />
  )

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
  const captureAll = async () => {
    setBusy(true)
    setBusyAll(true)
    try {
      await window.river.captureAll()
      setA(0)
      setB(1)
      setError(null)
    } catch (e) {
      setError(errorText(e))
    } finally {
      // Refresh either way: one-by-one capture may have saved some shots before one failed.
      refresh()
      setBusy(false)
      setBusyAll(false)
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
                <input className="mono frame-num" type="number" min={1} max={capA?.urls.length ?? 1} value={frame + 1} onChange={(e) => { setPlaying(false); setFrame(Math.max(0, Number(e.target.value) - 1)) }} />
              </label>
            )}
            <label className="toggle">
              <input type="checkbox" checked={compare} disabled={caps.length < 2} onChange={(e) => setCompare(e.target.checked)} />
              Compare
            </label>
            {compare && (
              <div className="seg" role="group" aria-label="Compare mode">
                {COMPARE_MODES.map((m) => (
                  <button key={m.id} className={cx("seg-btn", compareMode === m.id && "is-on")} data-compare-mode-btn={m.id} aria-pressed={compareMode === m.id} onClick={() => setCompareMode(m.id)}>
                    {m.label}
                  </button>
                ))}
              </div>
            )}
          </>
        )}
        <div className="tb-spacer" />
        {data && <span className="tb-meta">engine: {data.engine}</span>}
        <button className="btn btn-primary" disabled={!shot || !data?.canCapture || busy} title={data?.canCapture ? "Run the engine and save new frames" : `Engine "${data?.engine}" has no capture adapter`} onClick={() => void capture()}>
          {busy && !busyAll ? "Capturing…" : "◉ Capture"}
        </button>
        {(data?.shots.length ?? 0) > 1 && (
          <button
            className="btn"
            data-action="capture-all"
            disabled={!data?.canCapture || busy}
            title={data?.canCapture ? `Run the engine for all ${data.shots.length} shots and save new frames` : `Engine "${data?.engine}" has no capture adapter`}
            onClick={() => void captureAll()}
          >
            {busyAll ? "Capturing all…" : "Capture all"}
          </button>
        )}
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
                  <button
                    className="link-btn shot-pin"
                    title="Add this shot's newest frame to the storyboard canvas"
                    onClick={() => {
                      window.river.boardPin(board, { kind: "frame", ref: s.id }).then(
                        () => setPinned(s.id),
                        (e) => setError(errorText(e)),
                      )
                    }}
                  >
                    {pinned === s.id ? "Pinned" : "Pin to canvas"}
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
            <div className="compare-stage">
              <CompareStage mode={compareMode} before={capB} after={capA} frame={frame} threads={frameThreads} activeThread={activeThread} />
              {flipbook}
            </div>
          ) : (
            capA?.urls[frame] && (
              <div className="single">
                <FrameImage url={capA.urls[frame]} threads={frameThreads} draft={draft} onDraw={setDraft} activeThread={activeThread} />
                {flipbook}
                <p className="stage-hint">Drag on the frame to mark a box for a new comment.</p>
                <SendToBoard
                  key={capA.at}
                  shotId={shot.id}
                  capture={capA}
                  board={board}
                  frame={frame}
                  onFrame={(i) => {
                    setPlaying(false)
                    setFrame(i)
                  }}
                  onOpenBoard={props.onOpenBoard}
                />
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
