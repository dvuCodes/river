import { cpSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
// The agent host's end of the pipe (node builtins only), so the two halves of the wire format are tested together.
import { approvalPipeName, startApprovalServer, type ApprovalDecider } from "../../agent/src/approval"

const repoRoot = fileURLToPath(new URL("../../../", import.meta.url))
const mainTs = fileURLToPath(new URL("../src/main.ts", import.meta.url))
const example = fileURLToPath(new URL("../../../examples/park-walk/", import.meta.url))

let root: string
beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "river-mcp-approval-"))
  cpSync(example, root, { recursive: true })
})
afterAll(() => rmSync(root, { recursive: true, force: true, maxRetries: 3 }))

async function riverMcp(extra: string[]): Promise<Client> {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["--import", "tsx", mainTs, "--root", root, ...extra],
    cwd: repoRoot,
    stderr: "pipe",
  })
  const client = new Client({ name: "river-test", version: "0.0.0" })
  await client.connect(transport)
  return client
}

async function ask(client: Client, args: Record<string, unknown>) {
  const res = await client.callTool({ name: "approval_prompt", arguments: args })
  expect(res.isError).toBeFalsy()
  // Claude Code needs exactly one text block and no structuredContent.
  expect(res.structuredContent).toBeUndefined()
  const content = res.content as { type: string; text: string }[]
  expect(content).toHaveLength(1)
  expect(content[0]!.type).toBe("text")
  return JSON.parse(content[0]!.text) as Record<string, unknown>
}

describe("approval_prompt", () => {
  it("is listed only with --approval-pipe, never as a selectable tool", { timeout: 60_000 }, async () => {
    const plain = await riverMcp(["--tools", "story_lint"])
    try {
      expect((await plain.listTools()).tools.map((t) => t.name)).toEqual(["story_lint"])
    } finally {
      await plain.close()
    }
    const withPipe = await riverMcp(["--tools", "story_lint", "--approval-pipe", approvalPipeName()])
    try {
      const tools = (await withPipe.listTools()).tools
      expect(tools.map((t) => t.name).sort()).toEqual(["approval_prompt", "story_lint"])
      expect(tools.find((t) => t.name === "approval_prompt")!.outputSchema).toBeUndefined()
    } finally {
      await withPipe.close()
    }
  })

  it("round-trips allow and deny over a real pipe, and denies when the host is gone", { timeout: 60_000 }, async () => {
    const seen: { tool: string; id?: string }[] = []
    const decide: ApprovalDecider = async (tool, input, id) => {
      seen.push({ tool, ...(id ? { id } : {}) })
      return input.ok === true ? { behavior: "allow" } : { behavior: "deny", message: "user said no" }
    }
    const server = await startApprovalServer(decide)
    const client = await riverMcp(["--tools", "story_lint", "--approval-pipe", server.pipe])
    try {
      const input = { file: "stories/park_walk.twee", ok: true, note: 'quotes " and\nnewlines' }
      expect(await ask(client, { tool_name: "mcp__river__story_write_passage", input, tool_use_id: "toolu_7" })).toEqual({
        behavior: "allow",
        updatedInput: input,
      })
      expect(await ask(client, { tool_name: "Read", input: { file_path: "/etc/passwd" } })).toEqual({ behavior: "deny", message: "user said no" })
      expect(seen).toEqual([{ tool: "mcp__river__story_write_passage", id: "toolu_7" }, { tool: "Read" }])

      await server.close()
      const gone = await ask(client, { tool_name: "mcp__river__story_write_passage", input: { ok: true } })
      expect(gone.behavior).toBe("deny")
      expect(String(gone.message)).toContain("River")
    } finally {
      await client.close()
      await server.close()
    }
  })

  it("denies when the pipe never existed", { timeout: 60_000 }, async () => {
    const client = await riverMcp(["--tools", "story_lint", "--approval-pipe", approvalPipeName()])
    try {
      expect((await ask(client, { tool_name: "Read", input: {} })).behavior).toBe("deny")
    } finally {
      await client.close()
    }
  })
})
