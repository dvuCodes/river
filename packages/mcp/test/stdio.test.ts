import { cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js"
import { describe, expect, it } from "vitest"

const repoRoot = fileURLToPath(new URL("../../../", import.meta.url))
const mainTs = fileURLToPath(new URL("../src/main.ts", import.meta.url))
const example = fileURLToPath(new URL("../../../examples/park-walk/", import.meta.url))

const EXPECTED_TOOLS = [
  "project_info", "story_list", "story_read", "story_lint", "story_paths", "playtest_run",
  "frames_list", "review_list", "plan_list", "plan_read", "board_read", "marks_open", "brief_read",
  "story_write_passage", "story_add_passage", "review_reply", "plan_save",
  "implement_edit", "plan_mark_implemented", "frames_capture",
  "mark_claim", "mark_reply", "board_add_note", "board_add_card", "board_connect", "board_place_row",
]

describe("river-mcp over stdio", () => {
  it("lists the 26 tools and runs story_lint", { timeout: 60_000 }, async () => {
    const root = mkdtempSync(join(tmpdir(), "river-mcp-e2e-"))
    cpSync(example, root, { recursive: true })
    // tsx lives in the repo root node_modules, so run from there.
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: ["--import", "tsx", mainTs, "--root", root],
      cwd: repoRoot,
      stderr: "pipe",
    })
    const client = new Client({ name: "river-test", version: "0.0.0" })
    try {
      await client.connect(transport)
      expect(client.getServerVersion()?.name).toBe("river")
      const { tools } = await client.listTools()
      expect(tools.map((t) => t.name).sort()).toEqual([...EXPECTED_TOOLS].sort())

      const lint = await client.callTool({ name: "story_lint", arguments: { file: "stories/park_walk.twee" } })
      expect(lint.isError).toBeFalsy()
      const text = (lint.content as { type: string; text: string }[])[0]!.text
      expect(text).toContain("1 error, 2 warnings in 8 passages")

      const bad = await client.callTool({ name: "story_read", arguments: { file: "../x" } })
      expect(bad.isError).toBe(true)
      expect((bad.content as { text: string }[])[0]!.text).toContain("outside the project root")

      // Arguments that fail the schema come back as a tool error, and the server keeps going.
      const invalid = await client.callTool({ name: "story_read", arguments: {} })
      expect(invalid.isError).toBe(true)
      const info = await client.callTool({ name: "project_info", arguments: {} })
      expect(info.isError).toBeFalsy()
      expect((info.structuredContent as { engine?: string } | undefined)?.engine).toBe("none")
    } finally {
      await client.close()
    }
  })

  it("serves concept_write with --concept, writing only in that job's folder", { timeout: 60_000 }, async () => {
    const root = mkdtempSync(join(tmpdir(), "river-mcp-concept-"))
    cpSync(example, root, { recursive: true })
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: ["--import", "tsx", mainTs, "--root", root, "--tools", "project_info,concept_write", "--concept", "k_stdio001"],
      cwd: repoRoot,
      stderr: "pipe",
    })
    const client = new Client({ name: "river-test", version: "0.0.0" })
    try {
      await client.connect(transport)
      expect((await client.listTools()).tools.map((t) => t.name).sort()).toEqual(["concept_write", "project_info"])
      const content = "extends RefCounted\n\nfunc draw(img: Image) -> void:\n\timg.fill(Color.BLACK)\n"
      const ok = await client.callTool({ name: "concept_write", arguments: { file: "concepts/k_stdio001/draw.gd", content } })
      expect(ok.isError).toBeFalsy()
      expect(readFileSync(join(root, "concepts/k_stdio001/draw.gd"), "utf8")).toBe(content)
      const out = await client.callTool({ name: "concept_write", arguments: { file: "stories/x.gd", content } })
      expect(out.isError).toBe(true)
    } finally {
      await client.close()
    }
  })

  it("works a board as claude-code: finds the open mark, claims it, answers beside it", { timeout: 60_000 }, async () => {
    const root = mkdtempSync(join(tmpdir(), "river-mcp-board-"))
    cpSync(example, root, { recursive: true })
    const marks = join(root, ".river", "boards", "main", "marks")
    mkdirSync(marks, { recursive: true })
    const mark = { id: "m_stdio001", shape: "pin", path: [0, 0], anchors: [], thread: [{ by: "you", at: "2026-01-01T00:00:00.000Z", text: "a calmer pond?" }], status: "open", madeBy: "you", createdAt: "2026-01-01T00:00:00.000Z" }
    writeFileSync(join(marks, "m_stdio001.json"), JSON.stringify(mark))
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: ["--import", "tsx", mainTs, "--root", root, "--author", "claude-code"],
      cwd: repoRoot,
      stderr: "pipe",
    })
    const client = new Client({ name: "river-test", version: "0.0.0" })
    const text = (r: unknown) => ((r as { content: { text: string }[] }).content[0]!.text)
    try {
      await client.connect(transport)
      expect(text(await client.callTool({ name: "marks_open", arguments: {} }))).toContain("you: a calmer pond?")
      expect((await client.callTool({ name: "mark_claim", arguments: { markId: "m_stdio001" } })).isError).toBeFalsy()
      const note = await client.callTool({ name: "board_add_note", arguments: { near: "m_stdio001", text: "Softer light, fewer ducks." } })
      const noteId = (note.structuredContent as { id: string }).id
      await client.callTool({ name: "board_connect", arguments: { from: "m_stdio001", to: noteId } })
      await client.callTool({ name: "mark_reply", arguments: { markId: "m_stdio001", text: "See the note.", status: "answered" } })
      const saved = JSON.parse(readFileSync(join(marks, "m_stdio001.json"), "utf8")) as { status: string; thread: { by: string }[] }
      expect(saved.status).toBe("answered")
      expect(saved.thread.at(-1)!.by).toBe("claude-code")
      expect(text(await client.callTool({ name: "board_read", arguments: {} }))).toContain(`m_stdio001 -> ${noteId}  by claude-code`)
    } finally {
      await client.close()
    }
  })
})
