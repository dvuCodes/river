import { useReactFlow, useViewport, useViewportStore } from "@xyflow/react"
import { type ReactNode, useEffect, useMemo, useRef, useState } from "react"
import type { Mark, MarkStatus } from "@river/core"
import type { CanvasTheme, JobDTO } from "../../../shared/api"
import { cx, errorText, liveClaim, shortTime } from "../util"
import type { Pt } from "./geometry"
import { ME } from "./nodes"

// ---------- toolbar ----------

export type Tool = "select" | "hand" | "pen" | "pin" | "circle" | "note" | "arrow" | "image"

export const TOOLS: { id: Tool; label: string; key: string; icon: ReactNode }[] = [
  { id: "select", label: "Select", key: "v", icon: <path d="M4 2.5l8 5.2-3.6.8 2.2 4.3-1.6.8-2.2-4.3L4 12z" /> },
  { id: "hand", label: "Hand (pan)", key: "h", icon: <path d="M5 8V4.2a1 1 0 0 1 2 0V7.5M7 7V3.2a1 1 0 0 1 2 0V7M9 7V4a1 1 0 0 1 2 0v4.5M5 8.2V7a1 1 0 0 0-2 0v2.2c0 2.6 1.8 4.3 4.4 4.3h1c2.2 0 3.6-1.6 3.6-3.8V6.2a1 1 0 0 0-2 0" /> },
  { id: "pen", label: "Pen", key: "p", icon: <path d="M3 13l1-3.2 6.6-6.6 2.2 2.2L6.2 12zM9.6 4.2l2.2 2.2" /> },
  { id: "pin", label: "Pin", key: "m", icon: <path d="M8 14C7 11 4.5 9.5 4.5 6.5a3.5 3.5 0 0 1 7 0C11.5 9.5 9 11 8 14zM8 6.6h0" /> },
  { id: "circle", label: "Circle", key: "o", icon: <ellipse cx="8" cy="8" rx="5.6" ry="4.6" /> },
  { id: "note", label: "Note", key: "n", icon: <path d="M3 3h10v6.5L9.5 13H3zM9.5 13V9.5H13" /> },
  { id: "arrow", label: "Arrow: drag from one card to another to connect them", key: "a", icon: <path d="M3 13L12.5 3.5M7 3.5h5.5V9" /> },
  { id: "image", label: "Image", key: "i", icon: <path d="M2.5 3.5h11v9h-11zM2.5 10.5l3-2.6 2.6 2 2-1.4 3.4 2.5M10.5 6.2h0" /> },
]

export function ToolBar(props: { tool: Tool; onTool(t: Tool): void }) {
  return (
    <div className="canvas-tools" role="toolbar" aria-label="Canvas tools">
      {TOOLS.map((t, i) => (
        <span key={t.id} className="canvas-tool-wrap">
          {i === 2 && <span className="canvas-tool-sep" />}
          <button className={cx("canvas-tool", props.tool === t.id && "is-on")} data-tool={t.id} title={`${t.label} (${t.key.toUpperCase()})`} aria-label={t.label} onClick={() => props.onTool(t.id)}>
            <svg viewBox="0 0 16 16" aria-hidden>
              {t.icon}
            </svg>
          </button>
        </span>
      ))}
    </div>
  )
}

// ---------- board pill ----------

const BOARD_NAME = /^[a-z0-9_-]{1,64}$/
const boardName = (raw: string) => raw.trim().toLowerCase().replace(/\s+/g, "-")
const NAME_RULE = "Use a to z, 0 to 9, - and _ (at most 64)."

const THEMES: { id: CanvasTheme; label: string; title: string }[] = [
  { id: "paper", label: "Paper", title: "Warm paper, whatever the OS uses" },
  { id: "dark", label: "Dark", title: "A dark board" },
  { id: "system", label: "System", title: "Follow the OS: paper in light mode, dark in dark mode" },
]

/** One board in the menu: open it, rename it in place, or delete it after asking. */
function BoardRow(props: { name: string; current: boolean; last: boolean; onOpen(): void; onRename(to: string): Promise<void>; onDelete(): Promise<void> }) {
  const [mode, setMode] = useState<"idle" | "rename" | "confirm">("idle")
  const [draft, setDraft] = useState(props.name)
  const [err, setErr] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const run = (fn: () => Promise<void>) => {
    setBusy(true)
    fn().then(
      () => {
        setBusy(false)
        setMode("idle")
      },
      (e: unknown) => {
        setBusy(false)
        setErr(errorText(e))
      },
    )
  }
  if (mode === "rename") {
    return (
      <li className="board-row is-editing">
        <form
          className="board-rename"
          onSubmit={(e) => {
            e.preventDefault()
            const to = boardName(draft)
            if (!BOARD_NAME.test(to)) return setErr(NAME_RULE)
            run(() => props.onRename(to))
          }}
        >
          <input
            autoFocus
            value={draft}
            aria-label={`New name for ${props.name}`}
            onFocus={(e) => e.currentTarget.select()}
            onChange={(e) => (setDraft(e.target.value), setErr(null))}
            onKeyDown={(e) => {
              if (e.key !== "Escape") return
              e.preventDefault()
              e.stopPropagation()
              setMode("idle")
              setErr(null)
            }}
          />
          <button className="btn" data-action="rename-save" disabled={busy || !draft.trim()}>
            Save
          </button>
        </form>
        {err && <p className="err-note">{err}</p>}
      </li>
    )
  }
  if (mode === "confirm") {
    return (
      <li className="board-row is-confirming">
        <p className="board-confirm">
          Delete <b>{props.name}</b>? Its cards and marks go to the trash.
        </p>
        <div className="board-confirm-actions">
          <button className="btn" onClick={() => setMode("idle")}>
            Keep it
          </button>
          <button className="btn btn-danger" data-action="delete-board-confirm" disabled={busy} onClick={() => run(props.onDelete)}>
            Delete
          </button>
        </div>
        {err && <p className="err-note">{err}</p>}
      </li>
    )
  }
  return (
    <li className="board-row">
      <button className={cx("board-menu-item", props.current && "is-current")} onClick={props.onOpen}>
        {props.name}
        {props.current && <span className="board-menu-check">✓</span>}
      </button>
      <span className="board-row-tools">
        <button className="row-icon" data-action="rename-board" data-board={props.name} title={`Rename ${props.name}`} aria-label={`Rename ${props.name}`} onClick={() => (setDraft(props.name), setMode("rename"))}>
          <svg viewBox="0 0 16 16" aria-hidden>
            <path d="M3 13l1-3.2 6.6-6.6 2.2 2.2L6.2 12zM9.6 4.2l2.2 2.2" />
          </svg>
        </button>
        <button
          className="row-icon is-danger"
          data-action="delete-board"
          data-board={props.name}
          disabled={props.last}
          title={props.last ? "The only board cannot be deleted" : `Delete ${props.name}`}
          aria-label={`Delete ${props.name}`}
          onClick={() => setMode("confirm")}
        >
          <svg viewBox="0 0 16 16" aria-hidden>
            <path d="M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.7 8.5h5.6l.7-8.5M7 7v4M9 7v4" />
          </svg>
        </button>
      </span>
    </li>
  )
}

export function BoardPill(props: { board: string; items: number; openMarks: number; theme: CanvasTheme; onTheme(t: CanvasTheme): void; onBoard(name: string): void }) {
  const [open, setOpen] = useState(false)
  const [boards, setBoards] = useState<string[] | null>(null)
  const [draft, setDraft] = useState("")
  const [err, setErr] = useState<string | null>(null)
  const list = () => window.river.boardList().then(setBoards, (e: unknown) => setErr(errorText(e)))
  useEffect(() => {
    if (open) void list()
  }, [open])
  const create = () => {
    const name = boardName(draft)
    if (!BOARD_NAME.test(name)) return setErr(NAME_RULE)
    setOpen(false)
    props.onBoard(name)
  }
  const shown = boards ?? [props.board]
  return (
    <div className="board-pill-wrap" onPointerDown={(e) => e.stopPropagation()}>
      <button className={cx("board-pill", open && "is-open")} data-board={props.board} onClick={() => setOpen((o) => !o)} title="Boards and canvas look">
        <span className="board-logo" aria-hidden>
          <svg viewBox="0 0 16 16">
            <rect x="2" y="2.5" width="5" height="5" rx="1.2" />
            <rect x="9" y="2.5" width="5" height="5" rx="2.5" />
            <path d="M2.5 13.5l2.5-3.5 2.5 3.5zM9 9h5v5H9z" />
          </svg>
        </span>
        <span className="board-name">{props.board}</span>
        <span className="board-meta">
          {props.items} item{props.items === 1 ? "" : "s"} ·{" "}
          <span className={cx("open-marks", props.openMarks > 0 && "has-open")} data-open-marks={props.openMarks}>
            {props.openMarks} open mark{props.openMarks === 1 ? "" : "s"}
          </span>
        </span>
        <svg className="board-caret" viewBox="0 0 16 16" aria-hidden>
          <path d="M4.5 6.5L8 10l3.5-3.5" />
        </svg>
      </button>
      {open && (
        <div className="board-menu">
          <div className="board-menu-head">Boards</div>
          <ul>
            {shown.map((b) => (
              <BoardRow
                key={b}
                name={b}
                current={b === props.board}
                last={shown.length <= 1}
                onOpen={() => {
                  setOpen(false)
                  if (b !== props.board) props.onBoard(b)
                }}
                onRename={async (to) => {
                  await window.river.boardRename(b, to)
                  if (b === props.board) props.onBoard(to)
                  await list()
                }}
                onDelete={async () => {
                  const left = await window.river.boardDelete(b)
                  setBoards(left)
                  if (b === props.board) props.onBoard(left.includes("main") ? "main" : left[0]!)
                }}
              />
            ))}
          </ul>
          <form
            className="board-new"
            onSubmit={(e) => {
              e.preventDefault()
              create()
            }}
          >
            <input value={draft} placeholder="New board name" onChange={(e) => (setDraft(e.target.value), setErr(null))} />
            <button className="btn" disabled={!draft.trim()}>
              Create
            </button>
          </form>
          {err && <p className="err-note">{err}</p>}
          <div className="board-menu-head board-menu-sep">Canvas</div>
          <div className="theme-seg" role="radiogroup" aria-label="Canvas look">
            {THEMES.map((t) => (
              <button key={t.id} role="radio" aria-checked={props.theme === t.id} className={cx("theme-opt", props.theme === t.id && "is-on")} data-theme-choice={t.id} title={t.title} onClick={() => props.onTheme(t.id)}>
                <span className={cx("theme-swatch", `sw-${t.id}`)} aria-hidden />
                {t.label}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

// ---------- zoom ----------

export function ZoomControls() {
  const zoom = useViewportStore((s) => s.transform[2])
  const flow = useReactFlow()
  return (
    <div className="zoom-ctl" onPointerDown={(e) => e.stopPropagation()}>
      <button className="zoom-btn" data-zoom="out" aria-label="Zoom out" onClick={() => void flow.zoomOut({ duration: 160 })}>
        −
      </button>
      <button className="zoom-pct" data-zoom="fit" title="Fit the board (Shift+1)" onClick={() => void flow.fitView({ padding: 48, duration: 260 })}>
        {Math.round(zoom * 100)}%
      </button>
      <button className="zoom-btn" data-zoom="in" aria-label="Zoom in" onClick={() => void flow.zoomIn({ duration: 160 })}>
        +
      </button>
    </div>
  )
}

// ---------- quick jump ----------

export interface JumpItem {
  id: string
  title: string
  detail: string
  agent: boolean
}

export function QuickJump(props: { items: JumpItem[]; onPick(id: string): void; onClose(): void }) {
  const [q, setQ] = useState("")
  const [at, setAt] = useState(0)
  const hits = useMemo(() => {
    const words = q.toLowerCase().split(/\s+/).filter(Boolean)
    return props.items.filter((it) => words.every((w) => `${it.title} ${it.detail}`.toLowerCase().includes(w))).slice(0, 40)
  }, [q, props.items])
  useEffect(() => setAt(0), [q])
  const pick = (i: number) => {
    const hit = hits[i]
    if (hit) props.onPick(hit.id)
  }
  return (
    <div className="canvas-modal jump-backdrop" onPointerDown={(e) => e.target === e.currentTarget && props.onClose()}>
      <div className="jump" role="dialog" aria-label="Jump to a card">
        <input
          className="jump-input"
          autoFocus
          value={q}
          placeholder="Jump to a card, note or mark…"
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Escape") props.onClose()
            else if (e.key === "ArrowDown") setAt((i) => Math.min(i + 1, hits.length - 1))
            else if (e.key === "ArrowUp") setAt((i) => Math.max(i - 1, 0))
            else if (e.key === "Enter") pick(at)
            else return
            e.preventDefault()
          }}
        />
        <ul className="jump-list">
          {hits.map((it, i) => (
            <li key={it.id}>
              <button className={cx("jump-item", i === at && "is-on")} onMouseEnter={() => setAt(i)} onClick={() => pick(i)}>
                <span className="jump-title">
                  {it.agent && <span className="star">✦ </span>}
                  {it.title}
                </span>
                <span className="jump-detail">{it.detail}</span>
              </button>
            </li>
          ))}
          {hits.length === 0 && <li className="jump-none">Nothing on this board matches.</li>}
        </ul>
      </div>
    </div>
  )
}

// ---------- lightbox ----------

export interface LightboxItem {
  id: string
  url: string
  caption: string
}

/** One image large, with its caption; the arrow keys and the side buttons step through the board's images in reading order. */
export function Lightbox(props: { items: LightboxItem[]; at: number; onAt(i: number): void; onClose(): void }) {
  const box = useRef<HTMLDivElement>(null)
  const n = props.items.length
  const item = props.items[props.at]
  // Focus moves into the lightbox, so Escape and the arrows reach it even when a card had focus.
  useEffect(() => box.current?.focus(), [])
  if (!item) return null
  const step = (d: number) => props.onAt((props.at + d + n) % n)
  const nav = (d: number, label: string, glyph: string) =>
    n > 1 && (
      <button
        className={cx("lightbox-nav", d < 0 ? "is-prev" : "is-next")}
        data-lightbox={d < 0 ? "prev" : "next"}
        aria-label={label}
        onPointerDown={(e) => e.stopPropagation()}
        onClick={() => step(d)}
      >
        {glyph}
      </button>
    )
  return (
    <div
      ref={box}
      className="lightbox"
      tabIndex={-1}
      role="dialog"
      aria-label={item.caption}
      data-card={item.id}
      onPointerDown={props.onClose}
      onKeyDown={(e) => {
        if (e.key === "Escape") props.onClose()
        else if (e.key === "ArrowRight" || e.key === "ArrowDown") step(1)
        else if (e.key === "ArrowLeft" || e.key === "ArrowUp") step(-1)
        else return
        e.preventDefault()
        e.stopPropagation()
      }}
    >
      <figure className="lightbox-fig">
        <img key={item.url} src={item.url} alt={item.caption} />
        <figcaption className="lightbox-cap">
          {item.caption && <span className="lightbox-text">{item.caption}</span>}
          {n > 1 && (
            <span className="lightbox-count mono">
              {props.at + 1} / {n}
            </span>
          )}
        </figcaption>
      </figure>
      {nav(-1, "Previous image", "‹")}
      {nav(1, "Next image", "›")}
    </div>
  )
}

// ---------- selection ----------

export function SelectionBar(props: { count: number; cards: number; onRow(): void; onDuplicate(): void; onDelete(): void }) {
  return (
    <div className="selection-bar" onPointerDown={(e) => e.stopPropagation()}>
      <span className="selection-count">{props.count} selected</span>
      {props.cards >= 2 && (
        <button className="sel-btn" data-action="row" title="Line the selected cards up in a row" onClick={props.onRow}>
          Arrange in a row
        </button>
      )}
      <button className="sel-btn" data-action="duplicate" title="Duplicate (Ctrl+D)" onClick={props.onDuplicate}>
        Duplicate
      </button>
      <button className="sel-btn is-danger" data-action="delete" title="Delete (Del)" onClick={props.onDelete}>
        Delete
      </button>
    </div>
  )
}

// ---------- reference image form ----------

export function RefForm(props: { fileName: string; licence: string; left: number; onSubmit(s: { title: string; url: string; licence: string }): Promise<void>; onCancel(): void }) {
  const [title, setTitle] = useState(props.fileName.replace(/\.[^.]+$/, ""))
  const [url, setUrl] = useState("")
  const [licence, setLicence] = useState(props.licence)
  const [err, setErr] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  return (
    <div className="canvas-modal" onPointerDown={(e) => e.stopPropagation()}>
      <form
        className="ref-form"
        onSubmit={(e) => {
          e.preventDefault()
          if (!licence.trim()) return setErr("Write the licence (for example CC0, CC BY 4.0, or “own work”).")
          setBusy(true)
          props.onSubmit({ title, url, licence }).catch((x: unknown) => {
            setErr(errorText(x))
            setBusy(false)
          })
        }}
      >
        <header className="dialog-head">
          <h2>Reference image</h2>
          <span className="mono sec-hint">
            {props.fileName}
            {props.left > 0 && ` · ${props.left} more after this`}
          </span>
        </header>
        <label className="field">
          <span>Title</span>
          <input value={title} onChange={(e) => setTitle(e.target.value)} />
        </label>
        <label className="field">
          <span>Source URL</span>
          <input value={url} placeholder="https://…" onChange={(e) => setUrl(e.target.value)} />
        </label>
        <label className="field">
          <span>
            Licence <b className="req">required</b>
          </span>
          <input value={licence} placeholder="CC0, CC BY 4.0, own work…" onChange={(e) => setLicence(e.target.value)} autoFocus />
        </label>
        {err && <p className="err-note">{err}</p>}
        <footer className="dialog-foot">
          <button type="button" className="btn" onClick={props.onCancel}>
            Cancel
          </button>
          <button className="btn btn-primary" disabled={busy}>
            Add to canvas
          </button>
        </footer>
      </form>
    </div>
  )
}

// ---------- concept jobs ----------

const loadKit = () => window.river.jobKit()

/** Every script a job wants to run, each with the hash of exactly the bytes shown; Run all approves those hashes. */
export function ReviewDialog(props: { jobId: string; onClose(): void }) {
  const [dto, setDto] = useState<JobDTO | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [kit, setKit] = useState(false)
  useEffect(() => {
    window.river.jobGet(props.jobId).then(setDto, (e: unknown) => setErr(errorText(e)))
  }, [props.jobId])
  const scripts = dto?.scripts ?? []
  const run = () => {
    setBusy(true)
    window.river.jobApprove(props.jobId, Object.fromEntries(scripts.map((s) => [s.file, s.sha256]))).then(props.onClose, (e: unknown) => {
      setErr(errorText(e))
      setBusy(false)
    })
  }
  return (
    <div className="canvas-modal" onPointerDown={(e) => e.stopPropagation()}>
      <div className="review" role="dialog" aria-label="Review the scripts">
        <header className="dialog-head">
          <h2>{!dto ? "Review" : scripts.length > 1 ? `Review ${scripts.length} scripts` : "Review the script"}</h2>
          <span className="mono sec-hint">{props.jobId}</span>
        </header>
        <p className="concept-warn">Running a script executes its code on this computer. Read each one before you run them.</p>
        <p className="review-kit">
          <code>Kit.*</code> calls are River's own drawing helpers, not the agent's code.{" "}
          <button type="button" className="link-btn" data-action="view-kit" onClick={() => setKit(true)}>
            Read the Kit
          </button>
        </p>
        <div className="review-list nowheel">
          {scripts.map((s) => (
            <section key={s.file} className="review-script" data-variant={s.variant ?? ""}>
              <header className="concept-script-head">
                <span>
                  <b>{s.variant ? `Option ${s.variant.toUpperCase()}` : "Script"}</b>
                  {s.caption && <span className="review-caption"> · {s.caption}</span>}
                </span>
                <span className="mono" title={`${s.file} sha256 ${s.sha256}`}>
                  {s.file.split("/").pop()} · {s.sha256.slice(0, 12)}
                </span>
              </header>
              <pre className="concept-script-text">{s.text}</pre>
            </section>
          ))}
          {dto && !dto.scripts && <p className="sec-hint">This job is {dto.job.status} now; there is nothing to run.</p>}
          {!dto && !err && <p className="sec-hint">Reading the scripts…</p>}
        </div>
        {err && <p className="err-note">{err}</p>}
        <footer className="dialog-foot">
          <button type="button" className="btn" onClick={props.onClose}>
            Cancel
          </button>
          <button className="btn btn-primary" data-action="run" disabled={busy || scripts.length === 0} onClick={run}>
            {scripts.length > 1 ? `Run all ${scripts.length}` : "Run script"}
          </button>
        </footer>
      </div>
      {kit && <TextPanel title="River's drawing kit" sub="concepts/kit.gd, as River writes it on Accept" load={loadKit} onClose={() => setKit(false)} />}
    </div>
  )
}

/** A file to read, not edit: a job's log, the Kit. */
export function TextPanel(props: { title: string; sub: string; load(): Promise<string | null>; onClose(): void }) {
  const [text, setText] = useState<string | null | undefined>(undefined)
  const [err, setErr] = useState<string | null>(null)
  const box = useRef<HTMLDivElement>(null)
  const { load } = props
  useEffect(() => {
    load().then(setText, (e: unknown) => setErr(errorText(e)))
    box.current?.focus()
  }, [load])
  return (
    <div className="canvas-modal" onPointerDown={(e) => (e.stopPropagation(), e.target === e.currentTarget && props.onClose())}>
      <div
        ref={box}
        className="text-panel"
        role="dialog"
        aria-label={props.title}
        tabIndex={-1}
        onKeyDown={(e) => {
          if (e.key !== "Escape") return
          e.preventDefault()
          e.stopPropagation()
          props.onClose()
        }}
      >
        <header className="dialog-head">
          <h2>{props.title}</h2>
          <span className="mono sec-hint">{props.sub}</span>
          <span className="tb-spacer" />
          <button type="button" className="icon-btn" data-action="close-text" onClick={props.onClose} aria-label="Close">
            ×
          </button>
        </header>
        {err && <p className="err-note">{err}</p>}
        {text === undefined && !err && <p className="sec-hint">Reading…</p>}
        {text === null && <p className="sec-hint">There is no such file.</p>}
        {typeof text === "string" && <pre className="text-panel-body nowheel">{text || "(empty)"}</pre>}
      </div>
    </div>
  )
}

/** Dismiss a whole answer; the reason, when given, joins the project brief so later answers avoid it. */
export function DismissDialog(props: { onDismiss(reason: string): Promise<void>; onCancel(): void }) {
  const [reason, setReason] = useState("")
  const [err, setErr] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  return (
    <div className="canvas-modal" onPointerDown={(e) => e.stopPropagation()}>
      <form
        className="ref-form"
        onSubmit={(e) => {
          e.preventDefault()
          setBusy(true)
          props.onDismiss(reason.trim()).catch((x: unknown) => {
            setErr(errorText(x))
            setBusy(false)
          })
        }}
      >
        <header className="dialog-head">
          <h2>Dismiss this answer</h2>
        </header>
        <label className="field">
          <span>Why not? Optional; it goes into the project brief, so later answers avoid it.</span>
          <input value={reason} placeholder="too dark, wrong era, the dog is missing…" autoFocus onChange={(e) => setReason(e.target.value)} />
        </label>
        {err && <p className="err-note">{err}</p>}
        <footer className="dialog-foot">
          <button type="button" className="btn" onClick={props.onCancel}>
            Keep it
          </button>
          <button className="btn btn-danger" data-action="dismiss-confirm" disabled={busy}>
            Dismiss
          </button>
        </footer>
      </form>
    </div>
  )
}

// ---------- marks ----------

/** "What do you want?" box placed beside a fresh mark. */
export function AskBox(props: { at: Pt; onDone(text: string | null): void }) {
  const { x, y, zoom } = useViewport()
  const [text, setText] = useState("")
  const input = useRef<HTMLInputElement>(null)
  useEffect(() => {
    const t = window.setTimeout(() => input.current?.focus(), 0)
    return () => window.clearTimeout(t)
  }, [])
  return (
    <form
      className="ask-box"
      style={{ left: props.at[0] * zoom + x + 8, top: props.at[1] * zoom + y + 8 }}
      onSubmit={(e) => {
        e.preventDefault()
        props.onDone(text.trim())
      }}
      onPointerDown={(e) => e.stopPropagation()}
    >
      <input
        ref={input}
        className="ask-input"
        value={text}
        placeholder="What do you want?"
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.preventDefault()
            props.onDone(null)
          }
        }}
      />
      <span className="ask-hint">Enter to save · Esc to skip</span>
    </form>
  )
}

const STATUS_LABEL: Record<MarkStatus, string> = {
  open: "open",
  working: "working",
  answered: "answered",
  accepted: "accepted",
  dismissed: "dismissed",
}

export function MarkPanel(props: {
  mark: Mark
  answers: number
  cardTitle(id: string): string
  onAsk(): Promise<void>
  onReply(text: string): Promise<void>
  onRevise(jobId: string): Promise<void>
  /** Close a mark that follows no job: dismissed (the text says why) or accepted as resolved. */
  onSettle(status: "dismissed" | "accepted", text: string): Promise<void>
  onShowAnswer(): void
  onDelete(): void
  onClose(): void
}) {
  const { mark: m } = props
  const [asking, setAsking] = useState(false)
  const [reply, setReply] = useState("")
  const [sending, setSending] = useState(false)
  const [revisable, setRevisable] = useState(false)
  const [dismissing, setDismissing] = useState(false)
  const [why, setWhy] = useState("")
  const [settling, setSettling] = useState(false)
  const settle = (status: "dismissed" | "accepted", text: string) => {
    setSettling(true)
    props
      .onSettle(status, text)
      .then(() => (setDismissing(false), setWhy("")))
      .finally(() => setSettling(false))
  }
  const claim = liveClaim(m)
  // A mark an agent answered through river-mcp, or one nobody took yet, is closed here; a job's mark follows its job.
  const closable = !m.jobId && (m.status === "open" || m.status === "working" || m.status === "answered")
  // The thread changes when you reply, so whether the answer can be revised is asked again.
  useEffect(() => {
    let live = true
    if (!m.jobId) setRevisable(false)
    else window.river.jobGet(m.jobId).then((d) => live && setRevisable(d.revisable), () => live && setRevisable(false))
    return () => {
      live = false
    }
  }, [m])
  const send = () => {
    if (!reply.trim()) return
    setSending(true)
    props
      .onReply(reply)
      .then(() => setReply(""))
      .finally(() => setSending(false))
  }
  return (
    <aside className="mark-panel" onPointerDown={(e) => e.stopPropagation()}>
      <header className="mark-panel-head">
        <span className={cx("mark-dot-static", `ms-${m.status}`)} />
        <span className="mark-panel-title">
          {m.shape} · {STATUS_LABEL[m.status]}
        </span>
        <span className="tb-spacer" />
        <button className="icon-btn" onClick={props.onClose} aria-label="Close">
          ×
        </button>
      </header>
      {claim && (
        <p className="mark-claim" data-claim={claim}>
          ✦ {claim} is working on this
        </p>
      )}
      {m.anchors.length > 0 && (
        <p className="mark-panel-anchors">
          On{" "}
          {m.anchors.map((a, i) => (
            <span key={a}>
              {i > 0 && ", "}
              <b>{props.cardTitle(a)}</b>
            </span>
          ))}
        </p>
      )}
      <ul className="mark-thread">
        {m.thread.length === 0 && <li className="mark-thread-empty">No request written.</li>}
        {m.thread.map((t, i) => (
          <li key={i}>
            <span className={cx("msg-who", t.by !== ME && "is-agent")}>
              {t.by !== ME && "✦ "}
              {t.by}
            </span>
            <span className="msg-at">{shortTime(t.at)}</span>
            <p>{t.text}</p>
          </li>
        ))}
      </ul>
      {m.status === "open" && (
        <button
          className="btn btn-primary mark-ask"
          data-action="ask-concept"
          disabled={asking}
          onClick={() => {
            setAsking(true)
            void props.onAsk().finally(() => setAsking(false))
          }}
        >
          {asking ? "Starting…" : "✦ Ask concept artist"}
        </button>
      )}
      {m.status === "working" && !claim && (
        <p className="mark-working">
          {m.jobId ? "✦ The concept artist is on it. Its card beside the mark shows each step." : `✦ ${m.claimedBy ?? "An agent"} took this ${m.claimedAt ? shortTime(m.claimedAt) : ""} and has gone quiet; another agent may take it over.`}
        </p>
      )}
      <form
        className="mark-reply"
        onSubmit={(e) => {
          e.preventDefault()
          send()
        }}
      >
        <textarea
          value={reply}
          rows={2}
          placeholder={m.thread.length ? "Reply: say what to change…" : "What do you want?"}
          onChange={(e) => setReply(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
              e.preventDefault()
              send()
            }
          }}
        />
        <button className="btn" data-action="reply" disabled={sending || !reply.trim()}>
          Reply
        </button>
      </form>
      {revisable && m.jobId && (
        <button className="btn btn-primary mark-ask" data-action="revise" onClick={() => void props.onRevise(m.jobId!).then(() => setRevisable(false))}>
          ✦ Revise the answer
        </button>
      )}
      {props.answers > 0 && (
        <button className="btn mark-ask" data-action="show-answer" onClick={props.onShowAnswer}>
          Show the answer{props.answers > 1 ? ` (${props.answers} cards)` : ""}
        </button>
      )}
      {closable &&
        (dismissing ? (
          <form
            className="mark-dismiss"
            onSubmit={(e) => {
              e.preventDefault()
              settle("dismissed", why)
            }}
          >
            <input autoFocus value={why} placeholder="Why not? (optional)" aria-label="Why dismiss this mark" onChange={(e) => setWhy(e.target.value)} />
            <div className="mark-status-actions">
              <button type="button" className="btn" onClick={() => setDismissing(false)}>
                Keep it
              </button>
              <button className="btn btn-danger" data-action="dismiss-mark-confirm" disabled={settling}>
                Dismiss
              </button>
            </div>
          </form>
        ) : (
          <div className="mark-status-actions">
            <button className="btn" data-action="resolve-mark" disabled={settling} title="Done: close the mark as accepted" onClick={() => settle("accepted", "")}>
              Mark resolved
            </button>
            <button className="btn" data-action="dismiss-mark" disabled={settling} title="Close the mark without doing it" onClick={() => setDismissing(true)}>
              Dismiss mark
            </button>
          </div>
        ))}
      <footer className="mark-panel-foot">
        <span className="mono sec-hint">{m.id}</span>
        <span className="tb-spacer" />
        <button className="btn btn-danger" onClick={props.onDelete}>
          Delete
        </button>
      </footer>
    </aside>
  )
}
