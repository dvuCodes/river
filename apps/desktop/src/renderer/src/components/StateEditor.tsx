import { useEffect, useState } from "react"
import type { GameState, StateSchema, VarDecl } from "@river/core"

function range(decl: VarDecl): string {
  if (decl.type === "number" || decl.type === "int") {
    if (decl.min === undefined && decl.max === undefined) return decl.type
    return `${decl.type} ${decl.min ?? "−∞"}–${decl.max ?? "∞"}`
  }
  return decl.type === "enum" ? "enum" : "bool"
}

function NumberField(props: { name: string; decl: VarDecl & { type: "number" | "int" }; value: number; onCommit(v: number): void }) {
  const { decl, value, onCommit } = props
  const [draft, setDraft] = useState(String(value))
  useEffect(() => setDraft(String(value)), [value])
  const commit = () => {
    const n = Number(draft)
    if (draft.trim() === "" || Number.isNaN(n)) return setDraft(String(value))
    if (n !== value) onCommit(n)
  }
  const pct =
    decl.min !== undefined && decl.max !== undefined && decl.max > decl.min
      ? Math.max(0, Math.min(1, (value - decl.min) / (decl.max - decl.min)))
      : undefined
  return (
    <div className="num-field">
      <input
        className="mono"
        type="number"
        value={draft}
        step={decl.type === "int" ? 1 : "any"}
        min={decl.min}
        max={decl.max}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => e.key === "Enter" && commit()}
      />
      {pct !== undefined && (
        <span className="meter" aria-hidden>
          <span style={{ width: `${pct * 100}%` }} />
        </span>
      )}
    </div>
  )
}

export function StateEditor(props: {
  schema: StateSchema
  state: GameState
  onChange(name: string, value: number | string | boolean): void
  /** Names whose value differs from the reference state get a mark. */
  reference?: GameState | undefined
}) {
  const { schema, state, onChange, reference } = props
  const names = Object.keys(schema)
  if (names.length === 0) return <p className="empty-note">The state schema declares no variables.</p>
  return (
    <div className="state-grid">
      {names.map((name) => {
        const decl = schema[name]!
        const v = state[name]
        const changed = reference !== undefined && reference[name] !== v
        return (
          <label key={name} className={changed ? "state-row is-changed" : "state-row"}>
            <span className="state-name mono">{name}</span>
            <span className="state-type">{range(decl)}</span>
            <span className="state-input">
              {decl.type === "bool" ? (
                <input type="checkbox" checked={v === true} onChange={(e) => onChange(name, e.target.checked)} />
              ) : decl.type === "enum" ? (
                <select value={String(v ?? "")} onChange={(e) => onChange(name, e.target.value)}>
                  {decl.values.map((o) => (
                    <option key={o}>{o}</option>
                  ))}
                </select>
              ) : (
                <NumberField name={name} decl={decl} value={typeof v === "number" ? v : 0} onCommit={(n) => onChange(name, n)} />
              )}
            </span>
          </label>
        )
      })}
    </div>
  )
}

/** Initial state from the schema, in the renderer (mirrors core initialState without importing runtime code). */
export function initialStateOf(schema: StateSchema): GameState {
  const s: GameState = {}
  for (const [name, d] of Object.entries(schema)) {
    if (d.type === "bool") s[name] = d.initial ?? false
    else if (d.type === "enum") s[name] = d.initial ?? d.values[0] ?? ""
    else s[name] = d.initial ?? d.min ?? 0
  }
  return s
}
