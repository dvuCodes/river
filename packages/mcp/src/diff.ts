/**
 * A small line-based unified diff (LCS, 3 lines of context). No dependencies.
 * Line endings are normalised to "\n" first, so a CRLF checkout does not show every line as changed.
 */

type Op = { kind: " " | "-" | "+"; line: string }

function splitLines(text: string): string[] {
  const norm = text.replace(/\r\n?/g, "\n")
  if (norm === "") return []
  const lines = norm.split("\n")
  if (lines[lines.length - 1] === "") lines.pop()
  return lines
}

function diffOps(a: string[], b: string[]): Op[] {
  // Trim the common prefix and suffix so the LCS table stays small for typical edits.
  let start = 0
  while (start < a.length && start < b.length && a[start] === b[start]) start++
  let endA = a.length
  let endB = b.length
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--
    endB--
  }
  const midA = a.slice(start, endA)
  const midB = b.slice(start, endB)
  const n = midA.length
  const m = midB.length
  // lcs[i][j] = LCS length of midA[i..] and midB[j..].
  const lcs: Uint32Array[] = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1))
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i]![j] = midA[i] === midB[j] ? lcs[i + 1]![j + 1]! + 1 : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!)
    }
  }
  const ops: Op[] = a.slice(0, start).map((line) => ({ kind: " ", line }))
  let i = 0
  let j = 0
  while (i < n && j < m) {
    if (midA[i] === midB[j]) {
      ops.push({ kind: " ", line: midA[i]! })
      i++
      j++
    } else if (lcs[i + 1]![j]! >= lcs[i]![j + 1]!) {
      ops.push({ kind: "-", line: midA[i++]! })
    } else {
      ops.push({ kind: "+", line: midB[j++]! })
    }
  }
  while (i < n) ops.push({ kind: "-", line: midA[i++]! })
  while (j < m) ops.push({ kind: "+", line: midB[j++]! })
  for (const line of a.slice(endA)) ops.push({ kind: " ", line })
  return ops
}

const range = (start: number, count: number) => (count === 1 ? `${start}` : `${count === 0 ? start - 1 : start},${count}`)

/** Unified diff of two texts. Returns "" when they are equal. */
export function unifiedDiff(oldText: string, newText: string, file = "file", context = 3): string {
  const ops = diffOps(splitLines(oldText), splitLines(newText))
  const changed = ops.map((o, k) => (o.kind !== " " ? k : -1)).filter((k) => k >= 0)
  if (changed.length === 0) return ""

  // Group changes whose context windows touch into hunks.
  const hunks: [number, number][] = []
  for (const k of changed) {
    const lo = Math.max(0, k - context)
    const hi = Math.min(ops.length - 1, k + context)
    const last = hunks[hunks.length - 1]
    if (last && lo <= last[1] + 1) last[1] = hi
    else hunks.push([lo, hi])
  }

  // Line numbers (1-based) of each op in the old and new text.
  const oldNo: number[] = []
  const newNo: number[] = []
  let a = 1
  let b = 1
  for (const o of ops) {
    oldNo.push(a)
    newNo.push(b)
    if (o.kind !== "+") a++
    if (o.kind !== "-") b++
  }

  const out = [`--- a/${file}`, `+++ b/${file}`]
  for (const [lo, hi] of hunks) {
    const slice = ops.slice(lo, hi + 1)
    const oldCount = slice.filter((o) => o.kind !== "+").length
    const newCount = slice.filter((o) => o.kind !== "-").length
    out.push(`@@ -${range(oldNo[lo]!, oldCount)} +${range(newNo[lo]!, newCount)} @@`)
    for (const o of slice) out.push(`${o.kind}${o.line}`)
  }
  return out.join("\n") + "\n"
}
