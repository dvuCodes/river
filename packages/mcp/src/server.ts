import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import { loadProject } from "@river/core"
import type { Project } from "@river/core"
import { APPROVAL_TOOL_NAME, approvalInputSchema, requestApproval } from "./approval"
import { createRiverTools, RIVER_TOOL_NAMES } from "./tools"
import type { RiverTool, RiverToolsOptions } from "./tools"

export const SERVER_NAME = "river"
export const SERVER_VERSION = "0.1.0"

export interface ServerOptions extends RiverToolsOptions {
  /** Only register these tools. Default: all of them. */
  tools?: readonly string[]
  /**
   * Local pipe/socket of the River agent host. When set, the server also offers `approval_prompt`,
   * the permission prompt tool for the Claude Code backend. Never part of `tools`.
   */
  approvalPipe?: string
}

/**
 * Register `approval_prompt`. Claude Code requires exactly one text block back and no
 * structuredContent, so this does not go through the River tool wrapper.
 */
function registerApprovalTool(server: McpServer, pipe: string): void {
  server.registerTool(
    APPROVAL_TOOL_NAME,
    {
      description: "Internal: River's permission prompt for Claude Code. Not for the model to call.",
      inputSchema: approvalInputSchema,
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async (args: { tool_name: string; input?: Record<string, unknown>; tool_use_id?: string }) => {
      const answer = await requestApproval(pipe, {
        tool_name: args.tool_name,
        input: args.input ?? {},
        ...(args.tool_use_id ? { tool_use_id: args.tool_use_id } : {}),
      })
      return { content: [{ type: "text" as const, text: JSON.stringify(answer) }] }
    },
  )
}

/** Pick tools by name. Throws on a name River does not have. */
export function selectTools(all: RiverTool[], names?: readonly string[]): RiverTool[] {
  if (!names) return all
  const unknown = names.filter((n) => !(RIVER_TOOL_NAMES as readonly string[]).includes(n))
  if (unknown.length > 0) throw new Error(`unknown tools: ${unknown.join(", ")}. Known: ${RIVER_TOOL_NAMES.join(", ")}`)
  return all.filter((t) => names.includes(t.name))
}

/** An MCP server named "river" with the River tools registered. Errors become isError results. */
export function createServer(project: Project, opts: ServerOptions = {}): McpServer {
  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION })
  for (const tool of selectTools(createRiverTools(project, opts), opts.tools)) {
    server.registerTool(
      tool.name,
      {
        description: tool.description,
        inputSchema: tool.inputSchema,
        annotations: { readOnlyHint: !tool.mutating, destructiveHint: false, openWorldHint: false },
      },
      async (input: unknown) => {
        try {
          const result = await tool.handler(input)
          const content = [{ type: "text" as const, text: result.text }]
          // Plain-object data also goes out as structuredContent (plan ids, capture files, diffs).
          const data = result.data
          if (data !== null && typeof data === "object" && !Array.isArray(data)) {
            return { content, structuredContent: data as Record<string, unknown> }
          }
          return { content }
        } catch (e) {
          return { content: [{ type: "text" as const, text: `Error: ${(e as Error).message}` }], isError: true }
        }
      },
    )
  }
  if (opts.approvalPipe) registerApprovalTool(server, opts.approvalPipe)
  return server
}

/** Load the project at root and serve the River tools over stdio. Nothing but MCP goes to stdout. */
export async function startServer(opts: ServerOptions & { root: string }): Promise<McpServer> {
  const project = await loadProject(opts.root)
  const server = createServer(project, opts)
  await server.connect(new StdioServerTransport())
  return server
}
