import { type ReactNode, useEffect, useMemo, useRef, useState } from "react"
import type { Diagnostic } from "@river/core"
import type { PassageDTO, StoryDTO } from "../../../shared/api"
import { StoryMap } from "../components/StoryMap"
import { cx, errorText, useSmokeReady } from "../util"

const SEVERITY_ORDER = { error: 0, warn: 1, info: 2 } as const

export function StoryToolbar(props: {
  stories: string[]
  storyRel: string
  onStory(rel: string): void
  story: StoryDTO | null
  onGoto(id: string): void
  children?: ReactNode
}) {
  const { stories, storyRel, onStory, story, onGoto, children } = props
  const [query, setQuery] = useState("")
  const [miss, setMiss] = useState(false)
  const go = () => {
    const q = query.trim().toLowerCase()
    if (!q || !story) return
    const hit =
      story.passages.find((p) => p.name.toLowerCase() === q || p.id === q) ??
      story.passages.find((p) => p.name.toLowerCase().includes(q))
    setMiss(!hit)
    if (hit) onGoto(hit.id)
  }
  return (
    <div className="toolbar">
      <label className="tb-field">
        <span className="tb-label">Story</span>
        <select value={storyRel} onChange={(e) => onStory(e.target.value)}>
          {stories.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
      </label>
      <form
        className={cx("tb-search", miss && "is-miss")}
        onSubmit={(e) => {
          e.preventDefault()
          go()
        }}
      >
        <input
          list="passage-names"
          placeholder="Go to passage…"
          value={query}
          onChange={(e) => {
            setQuery(e.target.value)
            setMiss(false)
          }}
        />
        <datalist id="passage-names">
          {story?.passages.map((p) => <option key={p.id} value={p.name} />)}
        </datalist>
      </form>
      <div className="tb-spacer" />
      {children}
    </div>
  )
}

function Inspector(props: {
  passage: PassageDTO
  storyRel: string
  board: string
  onSaved(story: StoryDTO): void
  onClose(): void
}) {
  const { passage, storyRel, board, onSaved, onClose } = props
  const [draft, setDraft] = useState(passage.rawText)
  const [name, setName] = useState(passage.name)
  const [status, setStatus] = useState<{ kind: "ok" | "err"; text: string } | null>(null)
  const [busy, setBusy] = useState(false)
  const base = useRef(passage.rawText)

  // Follow outside changes (live reload) unless the user has unsaved edits.
  useEffect(() => {
    if (draft === base.current) setDraft(passage.rawText)
    base.current = passage.rawText
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [passage.rawText])
  useEffect(() => setName(passage.name), [passage.name])
  useEffect(() => setStatus(null), [passage.id])

  const dirty = draft !== passage.rawText
  const run = async (fn: () => Promise<StoryDTO>, okText: string) => {
    setBusy(true)
    try {
      const story = await fn()
      onSaved(story)
      setStatus({ kind: "ok", text: okText })
    } catch (err) {
      setStatus({ kind: "err", text: errorText(err) })
    } finally {
      setBusy(false)
    }
  }
  const pin = async () => {
    try {
      await window.river.boardPin(board, { kind: "passage", ref: `${storyRel}#${passage.id}` })
      setStatus({ kind: "ok", text: `Pinned to the ${board} board.` })
    } catch (err) {
      setStatus({ kind: "err", text: errorText(err) })
    }
  }
  const save = () => run(() => window.river.savePassage(storyRel, passage.id, draft), "Saved to the story file.")
  const rename = () => run(() => window.river.renamePassage(storyRel, passage.id, name), "Renamed, and links to it updated.")

  return (
    <aside className="inspector">
      <header className="insp-head">
        <span className="insp-kicker">Passage</span>
        <span className="insp-id mono">@id {passage.id}</span>
        <button className="btn insp-pin" data-pin-passage={passage.id} onClick={() => void pin()} title="Add this passage to the storyboard canvas">
          Pin to canvas
        </button>
        <button className="icon-btn" onClick={onClose} title="Close inspector" aria-label="Close inspector">
          ×
        </button>
      </header>
      <form
        className="insp-rename"
        onSubmit={(e) => {
          e.preventDefault()
          if (name.trim() && name !== passage.name) void rename()
        }}
      >
        <input value={name} onChange={(e) => setName(e.target.value)} aria-label="Passage name" />
        <button type="submit" className="btn" disabled={busy || !name.trim() || name === passage.name}>
          Rename
        </button>
      </form>
      <dl className="insp-facts">
        {passage.tags.length > 0 && (
          <>
            <dt>tags</dt>
            <dd>
              {passage.tags.map((t) => (
                <span key={t} className="chip">
                  {t}
                </span>
              ))}
            </dd>
          </>
        )}
        {passage.when && (
          <>
            <dt>when</dt>
            <dd className="mono cond">{passage.when}</dd>
          </>
        )}
        {passage.onEnter && (
          <>
            <dt>on enter</dt>
            <dd className="mono">{passage.onEnter}</dd>
          </>
        )}
        <dt>line</dt>
        <dd className="mono">{passage.line}</dd>
      </dl>
      <textarea
        className="insp-text mono"
        value={draft}
        spellCheck={false}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if ((e.ctrlKey || e.metaKey) && e.key === "s") {
            e.preventDefault()
            if (dirty) void save()
          }
        }}
      />
      <footer className="insp-foot">
        {status ? <span className={cx("insp-status", status.kind === "err" && "is-err")}>{status.text}</span> : <span className="insp-hint">{dirty ? "Unsaved changes · Ctrl+S" : "Raw Twee text with River rules"}</span>}
        <button className="btn" disabled={!dirty || busy} onClick={() => setDraft(passage.rawText)}>
          Revert
        </button>
        <button className="btn btn-primary" disabled={!dirty || busy} onClick={() => void save()}>
          Save
        </button>
      </footer>
    </aside>
  )
}

function LintPanel(props: { diagnostics: Diagnostic[]; story: StoryDTO; onPick(id: string): void }) {
  const { diagnostics, story, onPick } = props
  const [collapsed, setCollapsed] = useState(false)
  const sorted = useMemo(() => [...diagnostics].sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]), [diagnostics])
  const counts = { error: 0, warn: 0, info: 0 }
  for (const d of diagnostics) counts[d.severity]++
  const nameOf = (id?: string) => (id ? (story.passages.find((p) => p.id === id)?.name ?? id) : "")
  return (
    <section className={cx("lint", collapsed && "is-collapsed")}>
      <header className="lint-head" onClick={() => setCollapsed((c) => !c)}>
        <span className="lint-title">Lint</span>
        <span className="lint-count sev-error">{counts.error} errors</span>
        <span className="lint-count sev-warn">{counts.warn} warnings</span>
        <span className="lint-count sev-info">{counts.info} info</span>
        <span className="tb-spacer" />
        <span className="lint-toggle">{collapsed ? "Show" : "Hide"}</span>
      </header>
      {!collapsed && (
        <ul className="lint-list">
          {sorted.length === 0 && <li className="lint-clean">No problems. Every passage is reachable and every condition can be met.</li>}
          {sorted.map((d, i) => (
            <li key={i}>
              <button className="lint-row" disabled={!d.passageId} onClick={() => d.passageId && onPick(d.passageId)}>
                <span className={cx("sev-dot", `sev-${d.severity}`)} />
                <span className="lint-code mono">{d.code}</span>
                <span className="lint-msg">{d.message}</span>
                <span className="lint-where">
                  {nameOf(d.passageId)}
                  {d.span ? ` · L${d.span.line}` : ""}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}

export function StoryMapView(props: {
  stories: string[]
  storyRel: string
  onStory(rel: string): void
  story: StoryDTO | null
  storyError: string | null
  selectedId: string | undefined
  onSelect(id: string | undefined): void
  onStoryChanged(story: StoryDTO): void
  onPlayFrom(name: string): void
  /** The canvas board that pins go to. */
  board: string
}) {
  const { stories, storyRel, onStory, story, storyError, selectedId, onSelect, onStoryChanged, onPlayFrom, board } = props
  const [focus, setFocus] = useState<{ id: string; nonce: number }>()
  const [mapReady, setMapReady] = useState(false)
  const saveTimer = useRef<number | undefined>(undefined)
  const pendingMoves = useRef<{ rel: string; positions: Record<string, [number, number]> } | null>(null)
  useSmokeReady("story-map", mapReady && Boolean(story))

  const selected = story?.passages.find((p) => p.id === selectedId)
  const goto = (id: string) => {
    onSelect(id)
    setFocus({ id, nonce: Date.now() })
  }
  // Drags are saved into the story file's passage headers, debounced; moves in quick succession are merged.
  const flushMoves = () => {
    window.clearTimeout(saveTimer.current)
    const pending = pendingMoves.current
    pendingMoves.current = null
    if (!pending) return
    void window.river.savePositions(pending.rel, pending.positions).catch((err) => console.error("position save failed", errorText(err)))
  }
  const onMoved = (moved: Record<string, [number, number]>) => {
    if (pendingMoves.current && pendingMoves.current.rel !== storyRel) flushMoves()
    pendingMoves.current = { rel: storyRel, positions: { ...pendingMoves.current?.positions, ...moved } }
    window.clearTimeout(saveTimer.current)
    saveTimer.current = window.setTimeout(flushMoves, 400)
  }
  // Leaving the view or switching stories must not drop a pending save.
  const flushRef = useRef(flushMoves)
  flushRef.current = flushMoves
  useEffect(() => () => flushRef.current(), [storyRel])

  return (
    <div className="view">
      <StoryToolbar stories={stories} storyRel={storyRel} onStory={onStory} story={story} onGoto={goto}>
        {story && (
          <span className="tb-meta">
            {story.title} · {story.passages.length} passages
          </span>
        )}
        <button className="btn btn-primary" disabled={!selected} onClick={() => selected && onPlayFrom(selected.name)}>
          ▶ Play from here
        </button>
      </StoryToolbar>
      {storyError ? (
        <div className="empty-state">
          <h2>This story did not load</h2>
          <pre className="mono">{storyError}</pre>
        </div>
      ) : !story ? (
        <div className="empty-state">
          <p>Loading story…</p>
        </div>
      ) : (
        <div className={cx("mapview", selected && "has-inspector")}>
          <div className="map-col">
            <div className="map-wrap">
              <StoryMap story={story} selectedId={selectedId} onSelect={onSelect} onMoved={onMoved} focus={focus} onReady={() => setMapReady(true)} />
              <MapLegend />
            </div>
            <LintPanel diagnostics={story.diagnostics} story={story} onPick={goto} />
          </div>
          {selected && <Inspector key={selected.id} passage={selected} storyRel={storyRel} board={board} onSaved={onStoryChanged} onClose={() => onSelect(undefined)} />}
        </div>
      )}
    </div>
  )
}

export function MapLegend() {
  return (
    <div className="legend">
      <span>
        <i className="lg-line" /> choice
      </span>
      <span>
        <i className="lg-line lg-dash" /> has @when
      </span>
      <span>
        <i className="lg-line lg-broken" /> broken link
      </span>
    </div>
  )
}
