import { describe, expect, it } from "vitest"
import { linesToRead } from "@river/adapter-godot"
import { scriptRows } from "../src/renderer/src/approval/scriptRows"

describe("scriptRows", () => {
  it("gives a comment that fills the row and the code line after it a numbered row each", () => {
    const comment = `\tvar pts = [Vector2(0, h), # the hill${" ".repeat(117 - 37)}`
    const text = `extends RefCounted\n\nfunc draw(img: Image) -> void:\n\tvar h := img.get_height()\n${comment}\n["/tmp/out.png"].map(img.get("sa" + "ve_png"))]\n`
    const rows = scriptRows(text, linesToRead(text))
    expect(rows.map((r) => r.n)).toEqual([1, 2, 3, 4, 5, 6, 7])
    expect(rows[4]).toEqual({ n: 5, text: comment })
    expect(rows[5]).toEqual({ n: 6, text: '["/tmp/out.png"].map(img.get("sa" + "ve_png"))]', reason: "uses map, get" })
  })

  it("keeps every line of the bytes, in order, with the reading aid's reason on its line", () => {
    const text = 'extends RefCounted\n\tvar s = "a\\\n" + str(1)\n\n'
    expect(scriptRows(text, linesToRead(text))).toEqual([
      { n: 1, text: "extends RefCounted" },
      { n: 2, text: '\tvar s = "a\\', reason: "has a string that goes on to the next line" },
      { n: 3, text: '" + str(1)', reason: "uses str; starts inside the string from line 2" },
      { n: 4, text: "" },
      { n: 5, text: "" },
    ])
  })
})
