#!/usr/bin/env node
/**
 * river-mcp: the River MCP server over stdio.
 *
 *   river-mcp --root <game repo> [--tools a,b,c] [--author <role>] [--approval-pipe <name>] [--concept <id> | --writing <id>]
 *
 * stdout carries MCP messages only; everything else goes to stderr.
 */
import { parseArgs } from "node:util"
import { RIVER_TOOL_NAMES } from "./tools"
import { startServer } from "./server"

const USAGE = `river-mcp --root <dir> [--tools name,name,...] [--author <role>] [--approval-pipe <name>] [--concept <id> | --writing <id>]

  --root   the game repo (the folder with river.json). Required.
  --tools  only serve these tools. Default: all.
           ${RIVER_TOOL_NAMES.join(", ")}
  --author who the board and review writes are from (madeBy, the thread
           message's by). Default "agent"; Claude Code uses "claude-code".
  --approval-pipe  also serve approval_prompt (the Claude Code permission prompt
           tool), answered by the River agent host on this local pipe/socket.
  --concept  serve concept_write for this concept job; it writes only in
           concepts/<id>/.
  --writing  serve writing_write for this writing job; it writes only
           .river/writing/<id>/take_<variant>.json. Not with --concept.
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
        author: { type: "string" },
        "approval-pipe": { type: "string" },
        concept: { type: "string" },
        writing: { type: "string" },
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
  if (values.concept !== undefined && values.writing !== undefined) {
    process.stderr.write(`river-mcp: pass --concept or --writing, not both\n${USAGE}`)
    return 2
  }
  const tools = values.tools?.split(",").map((s) => s.trim()).filter(Boolean)
  try {
    await startServer({
      root: values.root,
      ...(tools ? { tools } : {}),
      ...(values.author ? { author: values.author } : {}),
      ...(values["approval-pipe"] ? { approvalPipe: values["approval-pipe"] } : {}),
      ...(values.concept !== undefined ? { conceptId: values.concept } : {}),
      ...(values.writing !== undefined ? { writingId: values.writing } : {}),
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
