import { useEffect, useRef, useState } from "react"
import type { AgentStatus } from "../../../shared/api"
import { errorText } from "../util"

export function SettingsDialog(props: { status: AgentStatus | null; onStatus(s: AgentStatus): void; onClose(): void }) {
  const { status, onStatus, onClose } = props
  const [key, setKey] = useState("")
  const [err, setErr] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)
  const ref = useRef<HTMLDialogElement>(null)

  useEffect(() => {
    ref.current?.showModal()
  }, [])

  const save = async () => {
    try {
      onStatus(await window.river.setApiKey(key))
      setKey("")
      setErr(null)
      setSaved(true)
    } catch (e) {
      setErr(errorText(e))
    }
  }
  const clear = async () => {
    try {
      onStatus(await window.river.clearApiKey())
      setSaved(false)
    } catch (e) {
      setErr(errorText(e))
    }
  }

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
        <label className="field">
          <span>Anthropic API key</span>
          <input type="password" autoComplete="off" value={key} onChange={(e) => setKey(e.target.value)} placeholder={status?.hasKey ? "•••••••• stored — paste to replace" : "sk-ant-…"} />
        </label>
        <p className="dialog-note">
          Stored in the app's data folder, encrypted with the system's secure storage. Only the main process reads it, to pass it to the agent; the
          window never sees it.
        </p>
        {status && !status.encryptionAvailable && <p className="err-note">Secure storage is not available on this system, so a key cannot be saved.</p>}
        {err && <p className="err-note">{err}</p>}
        {saved && <p className="ok-note">Key saved.</p>}
        <footer className="dialog-foot">
          {status?.hasKey && (
            <button type="button" className="btn btn-danger" onClick={() => void clear()}>
              Remove key
            </button>
          )}
          <span className="tb-spacer" />
          <button type="button" className="btn" onClick={onClose}>
            Close
          </button>
          <button type="submit" className="btn btn-primary" disabled={!key.trim()}>
            Save key
          </button>
        </footer>
      </form>
    </dialog>
  )
}
