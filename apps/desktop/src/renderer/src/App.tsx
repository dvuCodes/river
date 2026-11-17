import { type ReactNode, useCallback, useEffect, useRef, useState } from "react"
import type { AgentStatus, PlaySnapshot, ProjectInfo, StoryDTO, ViewId } from "../../shared/api"
import { SettingsDialog } from "./components/SettingsDialog"
import { cx, errorText, isSmoke } from "./util"
import { CanvasView, DEFAULT_BOARD } from "./views/CanvasView"
import { type AgentContext, AgentView, useAgentSession } from "./views/AgentView"
import { type AgentIntent, FramesView } from "./views/FramesView"
import { PathsView } from "./views/PathsView"
import { PlaytestView } from "./views/PlaytestView"
import { StoryMapView } from "./views/StoryMapView"

const NAV: { id: ViewId; label: string; group: string; icon: ReactNode }[] = [
  {
    id: "story-map",
    label: "Story map",
    group: "Stories",
    icon: (
      <svg viewBox="0 0 16 16" aria-hidden>
        <rect x="1.5" y="2" width="5" height="4" rx="1" />
        <rect x="9.5" y="2" width="5" height="4" rx="1" />
        <rect x="9.5" y="10" width="5" height="4" rx="1" />
        <path d="M6.5 4h3M8 4v8h1.5" />
      </svg>
    ),
  },
  {
    id: "paths",
    label: "Paths",
    group: "Stories",
    icon: (
      <svg viewBox="0 0 16 16" aria-hidden>
        <circle cx="3" cy="8" r="1.6" />
        <circle cx="13" cy="3.5" r="1.6" />
        <circle cx="13" cy="12.5" r="1.6" />
        <path d="M4.5 7.3C8 6 9 4 11.4 3.7M4.5 8.7C8 10 9 12 11.4 12.3" />
      </svg>
    ),
  },
  {
    id: "playtest",
    label: "Playtest",
    group: "Stories",
    icon: (
      <svg viewBox="0 0 16 16" aria-hidden>
        <path d="M4.5 2.8v10.4L13 8z" />
      </svg>
    ),
  },
  {
    id: "canvas",
    label: "Canvas",
    group: "Review",
    icon: (
      <svg viewBox="0 0 16 16" aria-hidden>
        <rect x="1.5" y="2.5" width="6" height="5" rx="0.8" />
        <rect x="9" y="6" width="5.5" height="6.5" rx="0.8" />
        <path d="M2.5 11.5c1.5-1.8 3-1.8 4.2 0s2 .8 2-.2" />
      </svg>
    ),
  },
  {
    id: "frames",
    label: "Frames",
    group: "Review",
    icon: (
      <svg viewBox="0 0 16 16" aria-hidden>
        <rect x="1.5" y="3" width="13" height="10" rx="1.2" />
        <path d="M1.5 10.5l3.5-3 3 2.5 2-1.5 4.5 3" />
      </svg>
    ),
  },
  {
    id: "agent",
    label: "Agent",
    group: "Review",
    icon: (
      <svg viewBox="0 0 16 16" aria-hidden>
        <path d="M2.5 3.5h11v7h-6l-3 2.5v-2.5h-2z" />
        <path d="M5.5 7h5" />
      </svg>
    ),
  },
]

function RiverMark() {
  return (
    <svg className="mark" viewBox="0 0 24 24" aria-hidden>
      <path d="M2 8c3-3 5 3 8 0s5 3 8 0 3-1 4-1" />
      <path d="M2 13c3-3 5 3 8 0s5 3 8 0 3-1 4-1" />
      <path d="M2 18c3-3 5 3 8 0s5 3 8 0 3-1 4-1" />
    </svg>
  )
}

function Welcome(props: { project: ProjectInfo | null; onOpen(): void }) {
  return (
    <div className="welcome">
      <RiverMark />
      <h1>River</h1>
      <p>Open a game folder that has a river.json. River shows its stories, routes, frames and review threads.</p>
      {props.project?.error && (
        <div className="banner banner-err">
          <b className="mono">{props.project.root}</b>
          <br />
          {props.project.error}
        </div>
      )}
      <button className="btn btn-primary" onClick={props.onOpen}>
        Open project…
      </button>
    </div>
  )
}

export function App() {
  const [project, setProject] = useState<ProjectInfo | null | undefined>(undefined)
  const [view, setView] = useState<ViewId>("story-map")
  const [storyRel, setStoryRel] = useState<string>("")
  const [story, setStory] = useState<StoryDTO | null>(null)
  const [storyError, setStoryError] = useState<string | null>(null)
  const [selectedId, setSelectedId] = useState<string | undefined>()
  const [playReq, setPlayReq] = useState<{ from?: string | undefined; nonce: number }>({ nonce: 0 })
  const [playSnap, setPlaySnap] = useState<PlaySnapshot | null>(null)
  const [playStartedNonce, setPlayStartedNonce] = useState<number | null>(null)
  const [storyStale, setStoryStale] = useState(false)
  const [framesTick, setFramesTick] = useState(0)
  const [storyTick, setStoryTick] = useState<{ rel: string; n: number } | null>(null)
  const [agentCtx, setAgentCtx] = useState<AgentContext>({ mode: "story" })
  const [agentStatus, setAgentStatus] = useState<AgentStatus | null>(null)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [board, setBoard] = useState(DEFAULT_BOARD)
  const agent = useAgentSession()
  const storyRelRef = useRef(storyRel)
  storyRelRef.current = storyRel

  const applyProject = useCallback((p: ProjectInfo | null) => {
    setProject(p)
    if (p && !p.error) setStoryRel((cur) => (cur && p.stories.includes(cur) ? cur : (p.stories[0] ?? "")))
  }, [])

  useEffect(() => {
    void window.river.getProject().then(applyProject)
    void window.river.agentStatus().then(setAgentStatus, () =>
      setAgentStatus({
        available: false,
        reason: "Status check failed.",
        hasKey: false,
        encryptionAvailable: false,
        backend: "api-key",
        backendChosen: false,
        model: "claude-opus-5-5",
        claudeCode: null,
      }),
    )
    return window.river.onNavigate((v) => setView(v))
  }, [applyProject])

  // Coming back to the window (e.g. from the Claude sign-in terminal): check the sign-in again.
  useEffect(() => {
    const onFocus = () => {
      void window.river.refreshAgentStatus().then(setAgentStatus, () => {})
    }
    window.addEventListener("focus", onFocus)
    return () => window.removeEventListener("focus", onFocus)
  }, [])

  const loadStory = useCallback(async (rel: string) => {
    if (!rel) return
    try {
      const s = await window.river.loadStory(rel)
      if (rel !== storyRelRef.current) return
      setStory(s)
      setStoryError(null)
      setSelectedId((id) => {
        if (id && s.passages.some((p) => p.id === id)) return id
        if (isSmoke) return [...s.passages].sort((a, b) => b.choices.length - a.choices.length)[0]?.id
        return undefined
      })
    } catch (err) {
      setStoryError(errorText(err))
    }
  }, [])

  useEffect(() => {
    setStory(null)
    setPlaySnap(null)
    setStoryStale(false)
    void loadStory(storyRel)
  }, [storyRel, loadStory])

  // Live reload: main batches file changes; reload only what they touch, keeping selection.
  useEffect(
    () =>
      window.river.onFsChange((changes) => {
        const rel = storyRelRef.current
        if (changes.some((c) => (c.kind === "story" && c.rel === rel) || c.kind === "state")) {
          void loadStory(rel)
          setStoryStale(true)
        }
        if (changes.some((c) => c.kind === "manifest" || (c.kind === "story" && c.rel !== rel))) {
          void window.river.getProject().then(applyProject)
        }
        for (const c of changes) if (c.kind === "story") setStoryTick((t) => ({ rel: c.rel, n: (t?.n ?? 0) + 1 }))
        if (changes.some((c) => c.kind === "review" || c.kind === "plans" || c.kind === "manifest")) setFramesTick((t) => t + 1)
      }),
    [loadStory, applyProject],
  )

  const onAgentIntent = (i: AgentIntent) => {
    setAgentCtx(i.mode === "plan" ? { mode: "plan", threadId: i.threadId } : { mode: "implement", planId: i.planId })
    setView("agent")
  }

  if (project === undefined) return <div className="boot" />
  if (project === null || project.error) {
    return (
      <Welcome
        project={project}
        onOpen={() => {
          void window.river.pickProject().then(applyProject)
        }}
      />
    )
  }

  const groups = [...new Set(NAV.map((n) => n.group))]
  return (
    <div className="app">
      <nav className="sidebar">
        <div className="brand">
          <RiverMark />
          <span>River</span>
        </div>
        <button className="project-btn" title={project.root} onClick={() => void window.river.pickProject().then(applyProject)}>
          <span className="project-name">{project.name}</span>
          <span className="project-root mono">{project.root.split(/[\\/]/).slice(-2).join("/")}</span>
        </button>
        {groups.map((g) => (
          <div key={g} className="nav-group">
            <span className="nav-group-label">{g}</span>
            {NAV.filter((n) => n.group === g).map((n) => (
              <button key={n.id} className={cx("nav-item", view === n.id && "is-on")} onClick={() => setView(n.id)}>
                {n.icon}
                <span>{n.label}</span>
                {n.id === "story-map" && story && story.diagnostics.some((d) => d.severity === "error") && <span className="nav-dot" title="Lint errors" />}
                {n.id === "agent" && agent.running && <span className="nav-pulse" title="Agent working" />}
              </button>
            ))}
          </div>
        ))}
        <div className="sidebar-foot">
          <button className="nav-item" onClick={() => setSettingsOpen(true)}>
            <svg viewBox="0 0 16 16" aria-hidden>
              <circle cx="8" cy="8" r="2.2" />
              <path d="M8 1.5v2M8 12.5v2M1.5 8h2M12.5 8h2M3.4 3.4l1.4 1.4M11.2 11.2l1.4 1.4M3.4 12.6l1.4-1.4M11.2 4.8l1.4-1.4" />
            </svg>
            <span>Settings</span>
          </button>
          <span className="engine-tag mono">engine · {project.engine}</span>
        </div>
      </nav>
      <div className="main">
        {project.stories.length === 0 && (view === "story-map" || view === "paths" || view === "playtest") ? (
          <div className="empty-state">
            <h2>No stories</h2>
            <p>Add a .twee file to the stories folder. River will pick it up.</p>
          </div>
        ) : view === "story-map" ? (
          <StoryMapView
            board={board}
            stories={project.stories}
            storyRel={storyRel}
            onStory={setStoryRel}
            story={story}
            storyError={storyError}
            selectedId={selectedId}
            onSelect={setSelectedId}
            onStoryChanged={(s) => {
              // River's own writes are not echoed by the watcher, so mark an open playtest stale here.
              setStory(s)
              setStoryStale(true)
            }}
            onPlayFrom={(name) => {
              setPlayReq((r) => ({ from: name, nonce: r.nonce + 1 }))
              setStoryStale(false)
              setView("playtest")
            }}
          />
        ) : view === "paths" ? (
          <PathsView stories={project.stories} storyRel={storyRel} onStory={setStoryRel} story={story} selectedId={selectedId} onSelect={setSelectedId} />
        ) : view === "playtest" ? (
          <PlaytestView
            storyRel={storyRel}
            story={story}
            snap={playSnap}
            setSnap={(s) => {
              setPlaySnap(s)
              setStoryStale(false)
            }}
            startReq={playReq}
            startedNonce={playStartedNonce}
            setStartedNonce={setPlayStartedNonce}
            storyStale={storyStale && playSnap !== null}
          />
        ) : view === "canvas" ? (
          <CanvasView board={board} onBoard={setBoard} storyTick={storyTick} />
        ) : view === "frames" ? (
          <FramesView tick={framesTick} board={board} onAgent={onAgentIntent} />
        ) : (
          <AgentView session={agent} status={agentStatus} onStatus={setAgentStatus} ctx={agentCtx} setCtx={setAgentCtx} storyRel={storyRel || undefined} onSettings={() => setSettingsOpen(true)} />
        )}
      </div>
      {settingsOpen && <SettingsDialog status={agentStatus} onStatus={setAgentStatus} onClose={() => setSettingsOpen(false)} />}
    </div>
  )
}
