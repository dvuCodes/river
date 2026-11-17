import { type CSSProperties, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react"
import { type ApprovalPayload, asciiLine } from "../../../shared/approval"
import { cx, errorText } from "../util"
import { allInView, measureReview } from "./inView"
import { scriptRows } from "./scriptRows"

/**
 * The approval window: every script a job wants to run, with the sha256 of exactly the bytes shown. Main opens it,
 * reads the scripts from the job's commit and accepts Run only from this window, for these shas. Nothing else lives in
 * this window, and Run stays off while any part of a script is out of view or under something, so the user can read
 * every byte they approve.
 */
export function ApprovalView() {
  const [shown, setShown] = useState<ApprovalPayload | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [kit, setKit] = useState<string | null>(null)
  const [view, setView] = useState<"in" | "out" | "covered">("out")
  const list = useRef<HTMLDivElement>(null)
  useEffect(() => {
    window.approval.load().then(setShown, (e: unknown) => setErr(errorText(e)))
  }, [])
  const scripts = shown?.scripts ?? []
  const lines = scripts.reduce((n, s) => n + s.text.split("\n").length, 0)
  const check = useCallback(() => {
    if (!list.current) return "out"
    const layout = measureReview(list.current, lines)
    return allInView(layout) ? "in" : layout.occluded ? "covered" : "out"
  }, [lines])
  useInViewWatch(list, kit ?? shown, () => setView(check()))
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && void window.approval.cancel()
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [])
  const readKit = () => window.approval.kit().then(setKit, (e: unknown) => setErr(errorText(e)))
  const run = () => {
    if (!shown || kit !== null) return
    const now = check()
    setView(now)
    if (now !== "in") return
    setBusy(true)
    // Main closes this window once the job starts rendering.
    window.approval.approve(shown.jobId, Object.fromEntries(scripts.map((s) => [s.file, s.sha256]))).catch((e: unknown) => {
      setErr(errorText(e))
      setBusy(false)
    })
  }
  return (
    <div className="review-window" role="dialog" aria-label="Review the scripts">
      <header className="dialog-head">
        <h2>{!shown ? "Review" : scripts.length > 1 ? `Review ${scripts.length} scripts` : "Review the script"}</h2>
        {shown && <span className="mono sec-hint">{asciiLine(shown.jobId)}</span>}
      </header>
      <p className="approval-context">
        {shown && (
          <>
            Board <b>{asciiLine(shown.board)}</b>
            {shown.request && <> · your mark: "{asciiLine(shown.request)}"</>}
          </>
        )}
      </p>
      <p className="concept-warn">
        Every line below is the agent's code. When you run it, it runs on this computer with your permissions. Read all of it first.
      </p>
      <p className="review-kit">
        <code>Kit.name(…)</code> calls use River's drawing helpers, but River cannot prove that a line only draws. <mark className="read-line">Highlighted</mark>{" "}
        lines use names beyond Kit, the Image API and plain math. The highlight is a reading aid, not a check: read the other lines too. Each numbered row
        is one line of the script; a row with <span className="wrap-hook" role="img" aria-label="a hook" /> and no number is the line above, wrapped to fit.{" "}
        {kit === null && (
          <button type="button" className="link-btn" data-action="view-kit" onClick={() => void readKit()}>
            Read the Kit
          </button>
        )}
      </p>
      {kit === null ? (
        <div className="review-list" ref={list}>
          {scripts.map((s) => (
            <section key={s.file} className="review-script" data-variant={s.variant ?? ""}>
              <header className="concept-script-head">
                <span>
                  <b>{s.variant ? `Option ${s.variant.toUpperCase()}` : "Script"}</b>
                  {s.caption && <span className="review-caption"> · {asciiLine(s.caption)}</span>}
                </span>
                <span className="mono" title={`${s.file} sha256 ${s.sha256}`}>
                  {s.file.split("/").pop()} · {s.text.split("\n").length} lines · sha256 {s.sha256.slice(0, 12)}
                </span>
              </header>
              <ScriptText text={s.text} toRead={s.toRead} />
            </section>
          ))}
          {!shown && !err && <p className="sec-hint">Reading the scripts…</p>}
        </div>
      ) : (
        <section className="kit-view" aria-label="River's drawing kit">
          <header className="kit-head">
            <b>River's drawing kit</b>
            <span className="mono sec-hint">concepts/kit.gd, as River writes it on Accept</span>
            <span className="tb-spacer" />
            <button type="button" className="btn" data-action="close-kit" onClick={() => setKit(null)}>
              Back to the scripts
            </button>
          </header>
          <pre className="kit-text">{kit}</pre>
        </section>
      )}
      {err && <p className="err-note">{err}</p>}
      <footer className="dialog-foot">
        {kit !== null ? (
          <p className="err-note review-blocked" role="status">
            Go back to the scripts to run them.
          </p>
        ) : (
          scripts.length > 0 &&
          view !== "in" && (
            <p className="err-note review-blocked" role="status">
              {view === "covered"
                ? "Something is covering the script. Close it to run."
                : "Part of a script is out of view. Make the window bigger or zoom out to read every line before running it."}
            </p>
          )
        )}
        <button type="button" className="btn" data-action="cancel" onClick={() => void window.approval.cancel()}>
          Cancel
        </button>
        {kit === null && (
          <button type="button" className="btn btn-primary" data-action="run" disabled={busy || scripts.length === 0 || view !== "in"} onClick={run}>
            {scripts.length > 1 ? `Run all ${scripts.length}` : "Run script"}
          </button>
        )}
      </footer>
    </div>
  )
}

/**
 * Call `update` now and whenever the list's layout may have moved or something may have opened over it: resize, zoom,
 * scrolling, fonts loading, rows reflowing, elements added or removed, classes or styles changing anywhere in the page.
 */
function useInViewWatch(list: { current: HTMLElement | null }, content: unknown, update: () => void) {
  const latest = useRef(update)
  latest.current = update
  useLayoutEffect(() => {
    const el = list.current
    if (!el) {
      latest.current()
      return
    }
    let live = true
    const recheck = () => live && latest.current()
    recheck()
    let frame = 0
    const mo = new MutationObserver(() => {
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(recheck)
    })
    mo.observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ["class", "style", "hidden", "open"] })
    const ro = new ResizeObserver(recheck)
    for (const box of [el, ...el.querySelectorAll(".review-script, .concept-script-text")]) ro.observe(box)
    let zoom: MediaQueryList | null = null
    const onZoom = () => {
      zoom?.removeEventListener("change", onZoom)
      zoom = matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`)
      zoom.addEventListener("change", onZoom)
      recheck()
    }
    onZoom()
    window.addEventListener("resize", recheck)
    document.addEventListener("scroll", recheck, true)
    document.fonts.addEventListener("loadingdone", recheck)
    void document.fonts.ready.then(recheck)
    return () => {
      live = false
      mo.disconnect()
      cancelAnimationFrame(frame)
      ro.disconnect()
      zoom?.removeEventListener("change", onZoom)
      window.removeEventListener("resize", recheck)
      document.removeEventListener("scroll", recheck, true)
      document.fonts.removeEventListener("loadingdone", recheck)
    }
  }, [list, content])
}

/**
 * The script exactly as its bytes read, one numbered row per line, with the lines worth a slow read highlighted. A long
 * line wraps inside its own row, so a wrapped part never gets a number and a new line never goes without one.
 */
function ScriptText(props: { text: string; toRead: { line: number; reason: string }[] }) {
  const rows = scriptRows(props.text, props.toRead)
  return (
    <div className="concept-script-text" style={{ "--ln-w": `${String(rows.length).length + 3}ch` } as CSSProperties}>
      {rows.map((r) => (
        <div key={r.n} className={cx("script-row", r.reason && "is-read")}>
          <span className="script-ln" aria-hidden="true">
            {r.n}
          </span>
          {r.reason ? (
            <mark className="script-code read-line" data-line={r.n} title={`Read this line: it ${r.reason}`}>
              {r.text}
            </mark>
          ) : (
            <span className="script-code">{r.text}</span>
          )}
        </div>
      ))}
    </div>
  )
}
