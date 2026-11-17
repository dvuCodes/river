/**
 * A small unified line diff for the approval card. Not a general diff tool: it uses an LCS table,
 * so it is O(n*m) in lines. Inputs past MAX_CELLS fall back to one hunk that replaces everything.
 */

const MAX_CELLS = 4_000_000

type Op = { kind: " " | "-" | "+"; line: string }

function splitLines(text: string): string[] {
  if (text === "") return []
  const lines = text.replace(/\r\n/g, "\n").split("\n")
  if (lines[lines.length - 1] === "") lines.pop()
  return lines
}

function diffOps(a: string[], b: string[]): Op[] {
  // Trim the common head and tail so the LCS table covers only the changed middle.
  let head = 0
  while (head < a.length && head < b.length && a[head] === b[head]) head++
  let tail = 0
  while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail++
  const am = a.slice(head, a.length - tail)
  const bm = b.slice(head, b.length - tail)

  const ops: Op[] = a.slice(0, head).map((line) => ({ kind: " ", line }))
  const n = am.length
  const m = bm.length
  if ((n + 1) * (m + 1) > MAX_CELLS) {
    for (const line of am) ops.push({ kind: "-", line })
    for (const line of bm) ops.push({ kind: "+", line })
  } else {
    // lcs[i][j] = LCS length of am[i..] and bm[j..], flattened.
    const w = m + 1
    const lcs = new Uint32Array((n + 1) * w)
    for (let i = n - 1; i >= 0; i--) {
      for (let j = m - 1; j >= 0; j--) {
        lcs[i * w + j] = am[i] === bm[j] ? lcs[(i + 1) * w + j + 1]! + 1 : Math.max(lcs[(i + 1) * w + j]!, lcs[i * w + j + 1]!)
      }
    }
    let i = 0
    let j = 0
    while (i < n && j < m) {
      if (am[i] === bm[j]) {
        ops.push({ kind: " ", line: am[i]! })
        i++
        j++
      } else if (lcs[(i + 1) * w + j]! >= lcs[i * w + j + 1]!) {
        ops.push({ kind: "-", line: am[i++]! })
      } else {
        ops.push({ kind: "+", line: bm[j++]! })
      }
    }
    while (i < n) ops.push({ kind: "-", line: am[i++]! })
    while (j < m) ops.push({ kind: "+", line: bm[j++]! })
  }
  for (const line of a.slice(a.length - tail)) ops.push({ kind: " ", line })
  return ops
}

/**
 * Unified diff of two texts. Returns "" when they are equal (line endings ignored).
 * `file` is used for the ---/+++ header.
 */
export function unifiedDiff(oldText: string, newText: string, file: string, context = 3): string {
  const a = splitLines(oldText)
  const b = splitLines(newText)
  const ops = diffOps(a, b)
  if (!ops.some((o) => o.kind !== " ")) return ""

  // Group changes into hunks with `context` lines around them.
  const out: string[] = [`--- a/${file}`, `+++ b/${file}`]
  let k = 0
  let aLine = 1
  let bLine = 1
  // Precompute, for each op index, the 1-based old/new line numbers at that point.
  const pos: { a: number; b: number }[] = []
  for (const o of ops) {
    pos.push({ a: aLine, b: bLine })
    if (o.kind !== "+") aLine++
    if (o.kind !== "-") bLine++
  }
  while (k < ops.length) {
    while (k < ops.length && ops[k]!.kind === " ") k++
    if (k >= ops.length) break
    const start = Math.max(0, k - context)
    let end = k
    // Extend while the next change is within 2*context unchanged lines.
    for (;;) {
      while (end < ops.length && ops[end]!.kind !== " ") end++
      let gap = end
      while (gap < ops.length && ops[gap]!.kind === " ") gap++
      if (gap < ops.length && gap - end <= context * 2) {
        end = gap
        continue
      }
      end = Math.min(ops.length, end + context)
      break
    }
    const slice = ops.slice(start, end)
    const oldCount = slice.filter((o) => o.kind !== "+").length
    const newCount = slice.filter((o) => o.kind !== "-").length
    const oldStart = oldCount === 0 ? pos[start]!.a - 1 : pos[start]!.a
    const newStart = newCount === 0 ? pos[start]!.b - 1 : pos[start]!.b
    out.push(`@@ -${oldStart},${oldCount} +${newStart},${newCount} @@`)
    for (const o of slice) out.push(o.kind + o.line)
    k = end
  }
  return out.join("\n") + "\n"
}
