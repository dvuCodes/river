import { type ReactNode, useEffect, useMemo, useRef, useState } from "react"
import type { CheckDataResult, Diagnostic } from "@river/core"
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
  const tagsText = passage.tags.join(" ")
  const [tagDraft, setTagDraft] = useState(tagsText)
  const tagBase = useRef(tagsText)
  // As with the text: follow outside changes to the tags unless the user is editing them.
  useEffect(() => {
    const prev = tagBase.current
    tagBase.current = tagsText
    setTagDraft((d) => (d === prev ? tagsText : d))
  }, [tagsText])
  const [confirmDelete, setConfirmDelete] = useState(false)

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
  const tagList = tagDraft.split(/[\s,]+/).map((t) => t.trim()).filter(Boolean)
  const tagsDirty = tagList.join(" ") !== tagsText
  const saveTags = () => {
    if (tagsDirty && !busy) void run(() => window.river.setPassageTags(storyRel, passage.id, tagList), "Tags saved.")
  }
  const remove = async () => {
    setBusy(true)
    try {
      const story = await window.river.deletePassage(storyRel, passage.id)
      onSaved(story)
      onClose()
    } catch (err) {
      setStatus({ kind: "err", text: errorText(err) })
      setConfirmDelete(false)
      setBusy(false)
    }
  }

  return (
    <aside className="inspector">
      <header className="insp-head">
        <span className="insp-kicker">Passage</span>
        <span className="insp-id mono">@id {passage.id}</span>
        <button className="btn insp-pin" data-pin-passage={passage.id} onClick={() => void pin()} title="Add this passage to the storyboard canvas">
          Pin to canvas
        </button>
        <button
          className={cx("btn", confirmDelete && "btn-danger")}
          data-delete-passage={passage.id}
          disabled={busy || passage.isStart}
          title={passage.isStart ? "This is the story's start passage, so it cannot be deleted" : confirmDelete ? "Click again to delete this passage from the story file" : "Delete this passage (links to it are kept; lint reports them as broken)"}
          onClick={() => (confirmDelete ? void remove() : setConfirmDelete(true))}
          onBlur={() => setConfirmDelete(false)}
        >
          {confirmDelete ? "Confirm delete" : "Delete"}
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
        <dt>tags</dt>
        <dd>
          <form
            className="insp-tags"
            onSubmit={(e) => {
              e.preventDefault()
              saveTags()
            }}
          >
            <input
              className="mono"
              value={tagDraft}
              placeholder="none · e.g. interrupt night"
              spellCheck={false}
              aria-label="Passage tags"
              data-passage-tags={passage.id}
              onChange={(e) => setTagDraft(e.target.value)}
              onBlur={saveTags}
              onKeyDown={(e) => {
                if (e.key === "Escape") setTagDraft(tagsText)
              }}
            />
            {tagsDirty && (
              // Keep focus in the input so its blur does not save a second time.
              <button type="submit" className="btn" disabled={busy} onMouseDown={(e) => e.preventDefault()}>
                Apply
              </button>
            )}
          </form>
        </dd>
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

/** "+ Passage": a small form under the button for a name and optional tags; the new passage is selected once added. */
function AddPassage(props: { storyRel: string; story: StoryDTO; onAdded(story: StoryDTO, id: string): void }) {
  const { storyRel, story, onAdded } = props
  const [open, setOpen] = useState(false)
  const [name, setName] = useState("")
  const [tags, setTags] = useState("")
  const [err, setErr] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const close = () => {
    setOpen(false)
    setErr(null)
  }
  const taken = story.passages.some((p) => p.name === name.trim())
  const submit = async () => {
    const n = name.trim()
    if (!n || taken) return
    setBusy(true)
    try {
      const tagList = tags.split(/[\s,]+/).map((t) => t.trim()).filter(Boolean)
      const next = await window.river.addPassage(storyRel, n, "", tagList)
      const added = next.passages.find((p) => p.name === n)
      onAdded(next, added?.id ?? "")
      setName("")
      setTags("")
      close()
    } catch (e) {
      setErr(errorText(e))
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className="tb-pop-wrap">
      <button className={cx("btn", open && "is-on")} data-action="add-passage" onClick={() => (open ? close() : setOpen(true))} title="Add a passage to this story">
        + Passage
      </button>
      {open && (
        <form
          className="tb-pop add-passage"
          onSubmit={(e) => {
            e.preventDefault()
            void submit()
          }}
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              e.preventDefault()
              close()
            }
          }}
        >
          <label className="field">
            <span>Name</span>
            <input autoFocus value={name} placeholder="The old bridge" onChange={(e) => (setName(e.target.value), setErr(null))} aria-label="New passage name" />
          </label>
          <label className="field">
            <span>Tags (optional)</span>
            <input value={tags} placeholder="interrupt, night" onChange={(e) => setTags(e.target.value)} aria-label="New passage tags" />
          </label>
          {taken && <p className="err-note">A passage with this name already exists.</p>}
          {err && <p className="err-note">{err}</p>}
          <footer className="tb-pop-foot">
            <button type="button" className="btn" onClick={close}>
              Cancel
            </button>
            <button className="btn btn-primary" data-action="add-passage-confirm" disabled={busy || !name.trim() || taken}>
              {busy ? "Adding…" : "Add"}
            </button>
          </footer>
        </form>
      )}
    </div>
  )
}

/** Export writes the story's JSON for the game; the result shows beside the button for a few seconds. */
function ExportButton(props: { storyRel: string }) {
  const [status, setStatus] = useState<{ ok: boolean; text: string } | null>(null)
  const [busy, setBusy] = useState(false)
  const timer = useRef<number | undefined>(undefined)
  useEffect(() => () => window.clearTimeout(timer.current), [])
  useEffect(() => setStatus(null), [props.storyRel])
  const run = async () => {
    setBusy(true)
    window.clearTimeout(timer.current)
    try {
      const r = await window.river.exportStory(props.storyRel)
      setStatus({ ok: true, text: `Wrote ${r.outFile} · ${r.passageCount} passages` })
      timer.current = window.setTimeout(() => setStatus(null), 5_000)
    } catch (e) {
      setStatus({ ok: false, text: errorText(e) })
    } finally {
      setBusy(false)
    }
  }
  return (
    <>
      {status && (
        <span className={cx("tb-status", !status.ok && "is-err")} data-export-status={status.ok ? "ok" : "err"} title={status.text}>
          {status.text}
        </span>
      )}
      <button className="btn" data-action="export-story" disabled={busy} onClick={() => void run()} title="Write this story's JSON export for the game">
        {busy ? "Exporting…" : "Export"}
      </button>
    </>
  )
}

/** Runs river.json's checkData command after a fresh export, and shows whether it passed and what it printed. */
function CheckDataButton() {
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<CheckDataResult | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const run = async () => {
    setOpen(true)
    setBusy(true)
    setErr(null)
    try {
      setResult(await window.river.checkData())
    } catch (e) {
      setResult(null)
      setErr(errorText(e))
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className="tb-pop-wrap">
      <button
        className={cx("btn", result && !busy && (result.ok ? "is-pass" : "is-fail"))}
        data-action="check-data"
        disabled={busy}
        onClick={() => void run()}
        title="Export every story, then run river.json's checkData command"
      >
        {busy ? "Checking…" : result ? (result.ok ? "✓ Check data" : "✕ Check data") : "Check data"}
      </button>
      {open && !busy && (result || err) && (
        <div className="tb-pop check-data" data-check-data={result ? (result.ok ? "pass" : "fail") : "error"}>
          <header className="tb-pop-head">
            <span className={cx("check-verdict", result?.ok ? "is-pass" : "is-fail")}>{result ? (result.ok ? "Passed" : "Failed") : "Could not run"}</span>
            {result && <span className="mono sec-hint check-cmd">{result.command}</span>}
            <span className="tb-spacer" />
            <button className="icon-btn" onClick={() => setOpen(false)} aria-label="Close">
              ×
            </button>
          </header>
          {err && <p className="err-note">{err}</p>}
          {result?.problem && <p className="err-note">{result.problem}</p>}
          {result && (result.output.trim() ? <pre className="check-output mono">{result.output}</pre> : <p className="sec-hint">The command printed nothing.</p>)}
        </div>
      )}
    </div>
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
  /** river.json has a checkData command: show the Check data button. */
  hasCheckData?: boolean
}) {
  const { stories, storyRel, onStory, story, storyError, selectedId, onSelect, onStoryChanged, onPlayFrom, board, hasCheckData } = props
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
        {story && (
          <AddPassage
            storyRel={storyRel}
            story={story}
            onAdded={(next, id) => {
              onStoryChanged(next)
              if (id) {
                onSelect(id)
                // The map lays the new card out on the next render; center on it after that.
                window.setTimeout(() => setFocus({ id, nonce: Date.now() }), 60)
              }
            }}
          />
        )}
        {story && <ExportButton storyRel={storyRel} />}
        {hasCheckData && <CheckDataButton />}
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
