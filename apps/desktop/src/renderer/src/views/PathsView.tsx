import { useEffect, useMemo, useRef, useState } from "react"
import type { GameState } from "@river/core"
import type { OpenStateDTO, PathDTO, PathsResultDTO, StoryDTO } from "../../../shared/api"
import { StateEditor, initialStateOf } from "../components/StateEditor"
import { type Highlight, StoryMap } from "../components/StoryMap"
import { cx, errorText, isSmoke, useSmokeReady } from "../util"
import { MapLegend, StoryToolbar } from "./StoryMapView"

const END_LABEL = { ending: "ending", "dead-end": "dead end", loop: "loop", return: "returns" } as const

/** Editing the state filter re-asks main which passages are open; typing in a number field waits this long. */
const OPEN_STATE_DEBOUNCE_MS = 80

type RouteList = "routes" | "interrupts"
interface Picked {
  list: RouteList
  i: number
}

function RouteButton(props: { r: PathDTO; n: number; picked: boolean; nameOf(id: string): string; onPick(): void }) {
  const { r, n, picked, nameOf, onPick } = props
  return (
    <button className={cx("route", picked && "is-picked", !r.satisfiable && "is-unsat")} onClick={onPick}>
      <span className="route-top">
        <span className="route-n mono">{String(n).padStart(2, "0")}</span>
        <span className={cx("end-tag", `end-${r.end}`)}>{END_LABEL[r.end]}</span>
        {!r.satisfiable && <span className="unsat-tag">unsatisfiable</span>}
        <span className="route-len">{r.steps.length} steps</span>
      </span>
      <span className="route-steps">{r.steps.map((s) => nameOf(s.passageId)).join(" → ")}</span>
      {r.conditions.length > 0 && <span className="route-conds mono">{r.conditions.join("  ∧  ")}</span>}
    </button>
  )
}

export function PathsView(props: {
  stories: string[]
  storyRel: string
  onStory(rel: string): void
  story: StoryDTO | null
  selectedId: string | undefined
  onSelect(id: string | undefined): void
}) {
  const { stories, storyRel, onStory, story, selectedId, onSelect } = props
  const [result, setResult] = useState<PathsResultDTO | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [picked, setPicked] = useState<Picked | undefined>(undefined)
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
        setResult(r)
        setError(null)
        setPicked((p) => (p !== undefined && p.i < r[p.list].length ? p : isSmoke && r.routes.length ? { list: "routes", i: 0 } : undefined))
      },
      (err) => live && setError(errorText(err)),
    )
    return () => {
      live = false
    }
  }, [story, storyRel])

  // Turning the filter on, or a new story, asks at once; edits to the state wait a moment, so typing does not send a
  // request per key.
  const asked = useRef<{ filterOn: boolean; story: StoryDTO | null; storyRel: string } | null>(null)
  useEffect(() => {
    const prev = asked.current
    asked.current = { filterOn, story, storyRel }
    if (!filterOn || !story) return setOpen(undefined)
    // A reset to the initial state (a new story sets it too) is not typing: ask at once.
    const immediate = !prev || !prev.filterOn || prev.story !== story || prev.storyRel !== storyRel || state === initial
    let live = true
    const ask = () => window.river.openState(storyRel, state).then((o) => live && setOpen(o), (err) => live && setError(errorText(err)))
    if (immediate) {
      void ask()
      return () => {
        live = false
      }
    }
    const timer = window.setTimeout(() => void ask(), OPEN_STATE_DEBOUNCE_MS)
    return () => {
      live = false
      window.clearTimeout(timer)
    }
  }, [filterOn, state, story, storyRel, initial])

  const pickedRoute = picked !== undefined ? result?.[picked.list][picked.i] : undefined
  const highlight: Highlight | undefined = useMemo(() => {
    const r = pickedRoute
    if (!r) return undefined
    return {
      passages: new Set(r.steps.map((s) => s.passageId)),
      edges: new Set(r.steps.filter((s) => s.choiceIndex !== undefined).map((s) => `${s.passageId}:${s.choiceIndex}`)),
    }
  }, [pickedRoute])

  useSmokeReady("paths", mapReady && result !== null && (!filterOn || open !== undefined))

  const nameOf = (id: string) => story?.passages.find((p) => p.id === id)?.name ?? id
  const routes = result?.routes
  const interrupts = result?.interrupts ?? []
  const unsat = routes?.filter((r) => !r.satisfiable).length ?? 0
  const closedPassages = open ? Object.values(open.passages).filter((v) => !v).length : 0
  const closedChoices = open ? Object.values(open.choices).flat().filter((v) => !v).length : 0
  const isPicked = (list: RouteList, i: number) => picked?.list === list && picked.i === i
  const toggle = (list: RouteList, i: number) => setPicked(isPicked(list, i) ? undefined : { list, i })

  return (
    <div className="view">
      <StoryToolbar
        stories={stories}
        storyRel={storyRel}
        onStory={onStory}
        story={story}
        onGoto={(id) => {
          onSelect(id)
          setFocus({ id, nonce: Date.now() })
        }}
      >
        {routes && (
          <span className="tb-meta">
            {routes.length} routes{unsat ? ` · ${unsat} unsatisfiable` : ""}
            {interrupts.length > 0 ? ` · ${interrupts.length} interrupt routes` : ""}
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
            {result?.truncated && <p className="paths-truncated">Showing the first 500 routes. The story has more.</p>}
            <ol className="route-list">
              {routes?.map((r, i) => (
                <li key={i}>
                  <RouteButton r={r} n={i + 1} picked={isPicked("routes", i)} nameOf={nameOf} onPick={() => toggle("routes", i)} />
                </li>
              ))}
              {routes?.length === 0 && <li className="empty-note">No routes from the start passage.</li>}
            </ol>
            {interrupts.length > 0 && (
              <>
                <header className="sec-head route-sub">
                  <h3>Interrupt routes</h3>
                  <span className="sec-hint">from each interrupt to its return</span>
                </header>
                <ol className="route-list" data-route-list="interrupts">
                  {interrupts.map((r, i) => (
                    <li key={i}>
                      <RouteButton r={r} n={i + 1} picked={isPicked("interrupts", i)} nameOf={nameOf} onPick={() => toggle("interrupts", i)} />
                    </li>
                  ))}
                </ol>
              </>
            )}
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
          {story && <StoryMap story={story} selectedId={selectedId} onSelect={onSelect} highlight={highlight} open={open} focus={focus} onReady={() => setMapReady(true)} />}
          <MapLegend />
        </div>
      </div>
    </div>
  )
}
