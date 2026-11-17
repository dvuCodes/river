import { useEffect, useMemo, useState } from "react"
import type { PlaySnapshot, StoryDTO } from "../../../shared/api"
import { StateEditor, initialStateOf } from "../components/StateEditor"
import { cx, errorText, prose, useSmokeReady } from "../util"

export function PlaytestView(props: {
  storyRel: string
  story: StoryDTO | null
  snap: PlaySnapshot | null
  setSnap(s: PlaySnapshot | null): void
  /** Start request: passage name, or undefined for the story start. Nonce changes restart. */
  startReq: { from?: string | undefined; nonce: number }
  storyStale: boolean
  /** Nonce of the start request the current snapshot answers; kept in App so remounts do not restart. */
  startedNonce: number | null
  setStartedNonce(n: number): void
}) {
  const { storyRel, story, snap, setSnap, startReq, storyStale, startedNonce, setStartedNonce } = props
  const [error, setError] = useState<string | null>(null)

  const call = async (fn: () => Promise<PlaySnapshot>) => {
    try {
      setSnap(await fn())
      setError(null)
    } catch (err) {
      setError(errorText(err))
    }
  }
  const start = (from?: string) => call(() => window.river.playStart(storyRel, from))

  useEffect(() => {
    if (!story) return
    if (snap && startedNonce === startReq.nonce) return
    setStartedNonce(startReq.nonce)
    void start(startReq.from)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [startReq.nonce, story === null])

  useSmokeReady("playtest", Boolean(snap))
  const initial = useMemo(() => (story ? initialStateOf(story.schema) : {}), [story])

  if (!story) return <div className="empty-state">Loading story…</div>
  return (
    <div className="view">
      <div className="toolbar">
        <span className="tb-label">Playtest</span>
        <span className="tb-meta mono">{storyRel}</span>
        <div className="tb-spacer" />
        <button className="btn" disabled={!snap?.canUndo} onClick={() => snap && void call(() => window.river.playUndo(snap.sessionId))}>
          ↶ Undo
        </button>
        <button className="btn" onClick={() => void start(startReq.from)}>
          Restart{startReq.from ? ` from ${startReq.from}` : ""}
        </button>
        {startReq.from && (
          <button className="btn" onClick={() => void start(undefined)}>
            Restart from start
          </button>
        )}
      </div>
      <div className="playview">
        <main className="play-main">
          {storyStale && (
            <div className="banner">
              The story file changed on disk. <button className="link-btn" onClick={() => void start(startReq.from)}>Restart</button> to play the new version.
            </div>
          )}
          {error && <div className="banner banner-err">{error}</div>}
          {snap && (
            <>
              <nav className="trail" aria-label="Visited passages">
                {snap.history.map((h, i) => (
                  <span key={i} className={cx("trail-step", i === snap.history.length - 1 && "is-here")}>
                    {h}
                  </span>
                ))}
              </nav>
              <article className="page">
                <header className="page-head">
                  <h1>{snap.passage.name}</h1>
                  {snap.passage.tags.map((t) => (
                    <span key={t} className="chip">
                      {t}
                    </span>
                  ))}
                </header>
                {snap.passage.onEnter && (
                  <p className="page-effect mono">
                    <span className="kw">on enter</span> {snap.passage.onEnter}
                  </p>
                )}
                <div className="page-prose">
                  {prose(snap.passage.text).map((para, i) => (
                    <p key={i}>{para}</p>
                  ))}
                </div>
                <ol className="choices">
                  {snap.choices.map((c, i) => (
                    <li key={i}>
                      <button
                        className={cx("choice", !c.open && "is-closed", c.broken && "is-broken")}
                        disabled={!c.open || c.broken}
                        onClick={() => void call(() => window.river.playChoose(snap.sessionId, i))}
                      >
                        <span className="choice-n mono">{i + 1}</span>
                        <span className="choice-label">{c.label}</span>
                        {c.broken ? (
                          <span className="choice-why mono">missing “{c.target}”</span>
                        ) : !c.open && c.when ? (
                          <span className="choice-why mono">needs {c.when}</span>
                        ) : c.when ? (
                          <span className="choice-ok mono">{c.when}</span>
                        ) : null}
                      </button>
                    </li>
                  ))}
                </ol>
                {snap.isOver && (
                  <div className={cx("over", snap.passage.isEnding ? "over-end" : "over-dead")}>
                    {snap.passage.isEnding ? "The end. This is an ending passage." : "Dead end: no open choice leads on from here."}
                  </div>
                )}
              </article>
            </>
          )}
        </main>
        <aside className="side-panel play-side">
          <section className="panel-sec">
            <header className="sec-head">
              <h3>State</h3>
              <span className="sec-hint">edit to test conditions</span>
            </header>
            {snap && (
              <StateEditor
                schema={story.schema}
                state={snap.state}
                reference={initial}
                onChange={(name, value) => void call(() => window.river.playSetVar(snap.sessionId, name, value))}
              />
            )}
          </section>
          <section className="panel-sec grow">
            <header className="sec-head">
              <h3>Steps</h3>
              <span className="sec-hint">{snap?.history.length ?? 0}</span>
            </header>
            <ol className="step-list">
              {snap?.history.map((h, i) => (
                <li key={i} className={i === snap.history.length - 1 ? "is-here" : ""}>
                  <span className="mono">{String(i + 1).padStart(2, "0")}</span> {h}
                </li>
              ))}
            </ol>
          </section>
        </aside>
      </div>
    </div>
  )
}
