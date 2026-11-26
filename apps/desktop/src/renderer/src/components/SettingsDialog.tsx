import { type KeyboardEvent, useEffect, useRef, useState } from "react"
import type { AgentBackend } from "@river/agent"
import type { AgentStatus } from "../../../shared/api"
import { modelLabel } from "../models"
import { errorText } from "../util"
import { BACKEND_LABEL, claudeCodeLine } from "../views/AgentView"

const SETUP_URL = "https://code.claude.com/docs/en/setup"
const CUSTOM = "__custom__"

/** Enter in a text field saves it (by blurring) instead of submitting the dialog's API-key form. */
const blurOnEnter = (e: KeyboardEvent<HTMLInputElement>) => {
  if (e.key === "Enter") {
    e.preventDefault()
    e.currentTarget.blur()
  }
}

export function SettingsDialog(props: { status: AgentStatus | null; onStatus(s: AgentStatus): void; onClose(): void }) {
  const { status, onStatus, onClose } = props
  const [key, setKey] = useState("")
  const [claudePath, setClaudePath] = useState(status?.claudePath ?? "")
  const [err, setErr] = useState<string | null>(null)
  const [note, setNote] = useState<string | null>(null)
  const [checking, setChecking] = useState(false)
  const known = status?.knownModels ?? []
  const savedModel = status?.model ?? ""
  const [customModel, setCustomModel] = useState(savedModel && !known.includes(savedModel) ? savedModel : "")
  const [customOpen, setCustomOpen] = useState(Boolean(savedModel) && !known.includes(savedModel))
  const [selfCheckModel, setSelfCheckModel] = useState(status?.selfCheckModel ?? "")
  const ref = useRef<HTMLDialogElement>(null)

  useEffect(() => {
    ref.current?.showModal()
  }, [])

  const backend = status?.backend ?? "api-key"
  const cc = status?.claudeCode ?? null

  const act = async (fn: () => Promise<AgentStatus | void>, ok?: string) => {
    try {
      const s = await fn()
      if (s) onStatus(s)
      setErr(null)
      setNote(ok ?? null)
    } catch (e) {
      setErr(errorText(e))
      setNote(null)
    }
  }
  const save = () =>
    act(async () => {
      const s = await window.river.setApiKey(key)
      setKey("")
      return s
    }, "Key saved.")
  const clear = () => act(() => window.river.clearApiKey())
  const pickBackend = (b: AgentBackend) => act(() => window.river.setAgentPrefs({ backend: b }))
  const refresh = async () => {
    setChecking(true)
    await act(() => window.river.refreshAgentStatus())
    setChecking(false)
  }
  const savePath = async () => {
    setChecking(true)
    await act(() => window.river.setAgentPrefs({ claudePath }))
    setChecking(false)
  }
  const pickModel = (v: string) => {
    if (v === CUSTOM) {
      setCustomOpen(true)
      return
    }
    setCustomOpen(false)
    void act(() => window.river.setAgentPrefs({ model: v }))
  }
  const saveCustomModel = () => {
    const t = customModel.trim()
    if (t && t !== savedModel) void act(() => window.river.setAgentPrefs({ model: t }), `Model set to ${t}.`)
  }
  const saveSelfCheckModel = () => {
    const t = selfCheckModel.trim()
    if (t !== (status?.selfCheckModel ?? "")) void act(() => window.river.setAgentPrefs({ selfCheckModel: t }), t ? `Self-check turns use ${t}.` : "Self-check turns use the main model.")
  }
  const signIn = () =>
    act(() => window.river.openClaudeSignIn(), "A terminal window opened with Claude Code's own sign-in. Finish there, then come back here (or press Refresh).")

  return (
    <dialog ref={ref} className="dialog" onClose={onClose} onCancel={onClose}>
      <form
        method="dialog"
        onSubmit={(e) => {
          e.preventDefault()
          if (key.trim()) void save()
        }}
      >
        <header className="dialog-head">
          <h2>Settings</h2>
          <button type="button" className="icon-btn" onClick={onClose} aria-label="Close">
            ×
          </button>
        </header>

        <fieldset className="field backend-pick">
          <legend>Agent backend</legend>
          {(["claude-code", "api-key"] as const).map((b) => (
            <label key={b} className="radio-row">
              <input type="radio" name="backend" checked={backend === b} onChange={() => void pickBackend(b)} />
              <span>{BACKEND_LABEL[b]}</span>
            </label>
          ))}
        </fieldset>

        {backend === "claude-code" ? (
          <>
            <div className="cc-status">
              <span className={cc?.installed && cc.loggedIn ? "ok-note" : "dialog-note"}>
                {claudeCodeLine(cc)}
                {cc?.version ? ` · v${cc.version}` : ""}
              </span>
              <span className="tb-spacer" />
              {cc?.installed && !cc.loggedIn && (
                <button type="button" className="btn btn-primary" onClick={() => void signIn()}>
                  Sign in
                </button>
              )}
              <button type="button" className="btn" disabled={checking} onClick={() => void refresh()}>
                {checking ? "Checking…" : "Refresh"}
              </button>
            </div>
            {cc && !cc.installed && (
              <p className="dialog-note">
                Install Claude Code ({SETUP_URL}), sign in to it, then press Refresh. Or set its path below.
              </p>
            )}
            <label className="field">
              <span>Claude Code path (optional)</span>
              <input
                type="text"
                spellCheck={false}
                value={claudePath}
                onChange={(e) => setClaudePath(e.target.value)}
                onBlur={() => {
                  if (claudePath.trim() !== (status?.claudePath ?? "")) void savePath()
                }}
                placeholder="claude on PATH"
              />
            </label>
            <p className="dialog-note">
              River runs your own installed Claude Code. You sign in to Claude Code itself, in its own window; River never sees, stores or
              forwards your sign-in, and usage counts against your own Claude plan.
            </p>
          </>
        ) : (
          <>
            <label className="field">
              <span>Anthropic API key</span>
              <input type="password" autoComplete="off" value={key} onChange={(e) => setKey(e.target.value)} placeholder={status?.hasKey ? "•••••••• stored — paste to replace" : "sk-ant-…"} />
            </label>
            <p className="dialog-note">
              Stored in the app's data folder, encrypted with the system's secure storage. Only the main process reads it, to pass it to the agent; the
              window never sees it.
            </p>
            {status && !status.encryptionAvailable && <p className="err-note">Secure storage is not available on this system, so a key cannot be saved.</p>}
          </>
        )}
        <label className="field">
          <span>Model</span>
          <select data-setting="model" value={customOpen ? CUSTOM : savedModel} onChange={(e) => pickModel(e.target.value)}>
            {known.map((m) => (
              <option key={m} value={m}>
                {modelLabel(m)} ({m})
              </option>
            ))}
            <option value={CUSTOM}>Custom model ID…</option>
          </select>
        </label>
        {customOpen && (
          <label className="field">
            <span>Custom model ID</span>
            <input
              type="text"
              data-setting="custom-model"
              spellCheck={false}
              value={customModel}
              onChange={(e) => setCustomModel(e.target.value)}
              onBlur={saveCustomModel}
              onKeyDown={blurOnEnter}
              placeholder="e.g. claude-sonnet-5-5"
            />
          </label>
        )}
        <label className="field">
          <span>Self-check model (optional)</span>
          <input
            type="text"
            data-setting="self-check-model"
            spellCheck={false}
            list="river-known-models"
            value={selfCheckModel}
            onChange={(e) => setSelfCheckModel(e.target.value)}
            onBlur={saveSelfCheckModel}
            onKeyDown={blurOnEnter}
            placeholder="Same as main model, e.g. claude-haiku-4-5"
          />
          <datalist id="river-known-models">
            {known.map((m) => (
              <option key={m} value={m} />
            ))}
          </datalist>
        </label>
        <label className="radio-row self-check-row">
          <input type="checkbox" data-setting="self-check" checked={status?.selfCheck ?? true} onChange={(e) => void act(() => window.river.setAgentPrefs({ selfCheck: e.target.checked }))} />
          <span>Look at the renders before answering</span>
        </label>
        <p className="dialog-note">
          After Godot draws a concept, the agent takes one more short turn to look at the pictures and fix its note and captions; a writing job
          reads its takes back the same way (the table read). These turns use the backend above and the self-check model, or the main model when
          none is set. Turn it off to answer as soon as the renders are done.
        </p>
        {err && <p className="err-note">{err}</p>}
        {note && <p className="ok-note">{note}</p>}
        <footer className="dialog-foot">
          {backend === "api-key" && status?.hasKey && (
            <button type="button" className="btn btn-danger" onClick={() => void clear()}>
              Remove key
            </button>
          )}
          <span className="tb-spacer" />
          <button type="button" className="btn" onClick={onClose}>
            Close
          </button>
          {backend === "api-key" && (
            <button type="submit" className="btn btn-primary" disabled={!key.trim()}>
              Save key
            </button>
          )}
        </footer>
      </form>
    </dialog>
  )
}
