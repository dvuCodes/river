import { useEffect, useMemo, useState } from "react"
import type { GameState } from "@river/core"
import type { OpenStateDTO, PathDTO, StoryDTO } from "../../../shared/api"
import { StateEditor, initialStateOf } from "../components/StateEditor"
import { type Highlight, StoryMap } from "../components/StoryMap"
import { cx, errorText, isSmoke, useSmokeReady } from "../util"
import { MapLegend, StoryToolbar } from "./StoryMapView"

const END_LABEL = { ending: "ending", "dead-end": "dead end", loop: "loop" } as const

export function PathsView(props: {
  stories: string[]
  storyRel: string
  onStory(rel: string): void
  story: StoryDTO | null
  selectedId: string | undefined
  onSelect(id: string | undefined): void
}) {
  const { stories, storyRel, onStory, story, selectedId, onSelect } = props
  const [routes, setRoutes] = useState<PathDTO[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [picked, setPicked] = useState<number | undefined>(undefined)
  const [filterOn, setFilterOn] = useState(isSmoke)
  const [state, setState] = useState<GameState>({})
  const [open, setOpen] = useState<OpenStateDTO | undefined>(undefined)
  const [mapReady, setMapReady] = useState(false)
  const [focus, setFocus] = useState<{ id: string; nonce: number }>()

  const schema = story?.schema
  const initial = useMemo(() => (schema ? initialStateOf(schema) : {}), [schema])
  useEffect(() => setState(initial), [initial])

  useEffect(() => {
    if (!story) return
    let live = true
    window.river.paths(storyRel).then(
      (r) => {
        if (!live) return
        setRoutes(r)
        setError(null)
        setPicked((p) => (p !== undefined && p < r.length ? p : isSmoke && r.length ? 0 : undefined))
      },
      (err) => live && setError(errorText(err)),
    )
    return () => {
      live = false
    }
  }, [story, storyRel])

  useEffect(() => {
    if (!filterOn || !story) return setOpen(undefined)
    let live = true
    window.river.openState(storyRel, state).then((o) => live && setOpen(o), (err) => live && setError(errorText(err)))
    return () => {
      live = false
    }
  }, [filterOn, state, story, storyRel])

  const highlight: Highlight | undefined = useMemo(() => {
    const r = picked !== undefined ? routes?.[picked] : undefined
    if (!r) return undefined
    return {
      passages: new Set(r.steps.map((s) => s.passageId)),
      edges: new Set(r.steps.filter((s) => s.choiceIndex !== undefined).map((s) => `${s.passageId}:${s.choiceIndex}`)),
    }
  }, [picked, routes])

  useSmokeReady("paths", mapReady && routes !== null && (!filterOn || open !== undefined))

  const nameOf = (id: string) => story?.passages.find((p) => p.id === id)?.name ?? id
  const unsat = routes?.filter((r) => !r.satisfiable).length ?? 0
  const closedPassages = open ? Object.values(open.passages).filter((v) => !v).length : 0
  const closedChoices = open ? Object.values(open.choices).flat().filter((v) => !v).length : 0

  return (
    <div className="view">
      <StoryToolbar stories={stories} storyRel={storyRel} onStory={onStory} story={story} onGoto={(id) => { onSelect(id); setFocus({ id, nonce: Date.now() }) }}>
        {routes && (
          <span className="tb-meta">
            {routes.length} routes{unsat ? ` · ${unsat} unsatisfiable` : ""}
          </span>
        )}
      </StoryToolbar>
      <div className="pathsview">
        <aside className="side-panel">
          <section className="panel-sec grow">
            <header className="sec-head">
              <h3>Routes</h3>
              {picked !== undefined && (
                <button className="link-btn" onClick={() => setPicked(undefined)}>
                  Clear highlight
                </button>
              )}
            </header>
            {error && <p className="err-note">{error}</p>}
            <ol className="route-list">
              {routes?.map((r, i) => (
                <li key={i}>
                  <button className={cx("route", picked === i && "is-picked", !r.satisfiable && "is-unsat")} onClick={() => setPicked(picked === i ? undefined : i)}>
                    <span className="route-top">
                      <span className="route-n mono">{String(i + 1).padStart(2, "0")}</span>
                      <span className={cx("end-tag", `end-${r.end}`)}>{END_LABEL[r.end]}</span>
                      {!r.satisfiable && <span className="unsat-tag">unsatisfiable</span>}
                      <span className="route-len">{r.steps.length} steps</span>
                    </span>
                    <span className="route-steps">{r.steps.map((s) => nameOf(s.passageId)).join(" → ")}</span>
                    {r.conditions.length > 0 && <span className="route-conds mono">{r.conditions.join("  ∧  ")}</span>}
                  </button>
                </li>
              ))}
              {routes?.length === 0 && <li className="empty-note">No routes from the start passage.</li>}
            </ol>
          </section>
          <section className="panel-sec">
            <header className="sec-head">
              <label className="toggle">
                <input type="checkbox" checked={filterOn} onChange={(e) => setFilterOn(e.target.checked)} />
                <h3>State filter</h3>
              </label>
              {filterOn && (
                <button className="link-btn" onClick={() => setState(initial)}>
                  Reset
                </button>
              )}
            </header>
            {filterOn ? (
              <>
                {schema && <StateEditor schema={schema} state={state} reference={initial} onChange={(n, v) => setState((s) => ({ ...s, [n]: v }))} />}
                <p className="sec-foot">
                  In this state: <b>{closedPassages}</b> passages and <b>{closedChoices}</b> choices are closed.
                </p>
              </>
            ) : (
              <p className="sec-foot">Turn on to grey out passages and choices whose conditions fail in a given state.</p>
            )}
          </section>
        </aside>
        <div className="map-wrap">
          {story && (
            <StoryMap story={story} selectedId={selectedId} onSelect={onSelect} highlight={highlight} open={open} focus={focus} onReady={() => setMapReady(true)} />
          )}
          <MapLegend />
        </div>
      </div>
    </div>
  )
}
