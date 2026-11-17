import { describe, expect, it } from "vitest"
import { unifiedDiff } from "../src/diff"

describe("unifiedDiff", () => {
  it("returns empty for equal texts, ignoring CRLF", () => {
    expect(unifiedDiff("a\nb\n", "a\r\nb\r\n", "f.txt")).toBe("")
  })

  it("shows a one-line change with context", () => {
    const a = ["1", "2", "3", "4", "5", "6", "7", "8"].join("\n") + "\n"
    const b = a.replace("5", "five")
    expect(unifiedDiff(a, b, "x.txt")).toBe(
      ["--- a/x.txt", "+++ b/x.txt", "@@ -2,7 +2,7 @@", " 2", " 3", " 4", "-5", "+five", " 6", " 7", " 8", ""].join("\n"),
    )
  })

  it("splits far apart changes into two hunks and merges near ones", () => {
    const lines = Array.from({ length: 30 }, (_, i) => `l${i + 1}`)
    const far = [...lines]
    far[1] = "X"
    far[25] = "Y"
    const d = unifiedDiff(lines.join("\n"), far.join("\n"), "f")
    expect(d.match(/^@@/gm)).toHaveLength(2)
    expect(d).toContain("@@ -1,5 +1,5 @@")
    expect(d).toContain("@@ -23,7 +23,7 @@")
    const near = [...lines]
    near[10] = "X"
    near[14] = "Y"
    expect(unifiedDiff(lines.join("\n"), near.join("\n"), "f").match(/^@@/gm)).toHaveLength(1)
  })

  it("handles new and emptied files", () => {
    expect(unifiedDiff("", "a\nb\n", "n")).toBe("--- a/n\n+++ b/n\n@@ -0,0 +1,2 @@\n+a\n+b\n")
    expect(unifiedDiff("a\n", "", "n")).toBe("--- a/n\n+++ b/n\n@@ -1,1 +0,0 @@\n-a\n")
  })

  it("handles insertions in the middle", () => {
    const d = unifiedDiff("a\nb\nc\n", "a\nb\nNEW\nc\n", "f")
    expect(d).toBe("--- a/f\n+++ b/f\n@@ -1,3 +1,4 @@\n a\n b\n+NEW\n c\n")
  })
})
