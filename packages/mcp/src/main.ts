#!/usr/bin/env node
/**
 * river-mcp: the River MCP server over stdio.
 *
 *   river-mcp --root <game repo> [--tools a,b,c] [--approval-pipe <name>]
 *
 * stdout carries MCP messages only; everything else goes to stderr.
 */
import { parseArgs } from "node:util"
import { RIVER_TOOL_NAMES } from "./tools"
import { startServer } from "./server"

const USAGE = `river-mcp --root <dir> [--tools name,name,...] [--approval-pipe <name>]

  --root   the game repo (the folder with river.json). Required.
  --tools  only serve these tools. Default: all.
           ${RIVER_TOOL_NAMES.join(", ")}
  --approval-pipe  also serve approval_prompt (the Claude Code permission prompt
           tool), answered by the River agent host on this local pipe/socket.
`

async function main(): Promise<number> {
  let values
  try {
    values = parseArgs({
      args: process.argv.slice(2),
      strict: true,
      options: {
        root: { type: "string" },
        tools: { type: "string" },
        "approval-pipe": { type: "string" },
        help: { type: "boolean", short: "h" },
      },
    }).values
  } catch (e) {
    process.stderr.write(`river-mcp: ${(e as Error).message}\n${USAGE}`)
    return 2
  }
  if (values.help) {
    process.stderr.write(USAGE)
    return 0
  }
  if (!values.root) {
    process.stderr.write(`river-mcp: --root is required\n${USAGE}`)
    return 2
  }
  const tools = values.tools?.split(",").map((s) => s.trim()).filter(Boolean)
  try {
    await startServer({
      root: values.root,
      ...(tools ? { tools } : {}),
      ...(values["approval-pipe"] ? { approvalPipe: values["approval-pipe"] } : {}),
    })
    process.stderr.write(`river-mcp: serving ${values.root}\n`)
  } catch (e) {
    process.stderr.write(`river-mcp: ${(e as Error).message}\n`)
    return 1
  }
  return 0
}

const code = await main()
if (code !== 0) process.exit(code)
