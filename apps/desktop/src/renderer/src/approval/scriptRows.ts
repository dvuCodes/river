/** One line of a script as the review shows it: its number, its bytes, and the reading aid's reason when it marks it. */
export interface ScriptRow {
  n: number
  text: string
  reason?: string
}

/** Every line of the bytes, in order, one row each; the dialog wraps a long row inside it, under the same number. */
export function scriptRows(text: string, toRead: { line: number; reason: string }[]): ScriptRow[] {
  const reasons = new Map(toRead.map((r) => [r.line, r.reason]))
  return text.split("\n").map((line, i) => {
    const reason = reasons.get(i + 1)
    return reason ? { n: i + 1, text: line, reason } : { n: i + 1, text: line }
  })
}
