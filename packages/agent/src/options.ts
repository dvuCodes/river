import { createRequire } from "node:module"
import { fileURLToPath, pathToFileURL } from "node:url"
import type { CanUseTool, EffortLevel, Options } from "@anthropic-ai/claude-agent-sdk"
import { BUILTIN_READ_TOOLS, MCP_PREFIX } from "./policy"
import { SYSTEM_PROMPTS } from "./prompts"
import { AUTO_ALLOWED_WRITES, MODE_TOOLS, READ_TOOLS, type AgentTurnRequest } from "./types"

/**
 * How to start the River MCP server. `args` come before `--root <root> --tools <list>`.
 * Packaged builds pass their own (e.g. a bundled `river-mcp` executable) through AgentDeps.mcpLaunch.
 */
export interface McpLaunch {
  command: string
  args: string[]
}

/** Built-in tools River never offers. `tools` already limits built-ins to Read/Glob/Grep; this is a backstop. */
export const DISALLOWED_BUILTINS = [
  "Bash",
  "Write",
  "Edit",
  "MultiEdit",
  "NotebookEdit",
  "WebFetch",
  "WebSearch",
  "Agent",
  "Task",
  "Workflow",
  "Monitor",
  "TodoWrite",
  "AskUserQuestion",
  "EnterPlanMode",
  "ExitPlanMode",
  "EnterWorktree",
  "CronCreate",
  "RemoteTrigger",
  "Skill",
] as const

/** Absolute path of packages/mcp/src/main.ts, found from this file. */
export function mcpEntryPath(): string {
  return fileURLToPath(new URL("../../mcp/src/main.ts", import.meta.url))
}

/** Dev default: run the TypeScript entry with this Node and the tsx loader (as a file URL, since cwd is the game repo). */
export function defaultMcpLaunch(): McpLaunch {
  const tsx = pathToFileURL(createRequire(import.meta.url).resolve("tsx")).href
  return { command: process.execPath, args: ["--import", tsx, mcpEntryPath()] }
}

export interface QueryOptionDeps {
  canUseTool: CanUseTool
  abortController: AbortController
  /** Absolute game root (from loadProject). Defaults to req.root. */
  root?: string
  mcpLaunch?: McpLaunch
  /** Base environment for the Claude Code process. Defaults to process.env (copied, never changed). */
  baseEnv?: Record<string, string | undefined>
  pathToClaudeCodeExecutable?: string
  maxTurns?: number
  /** Default "high". */
  effort?: EffortLevel
}

/** The query() options for one turn. Pure apart from resolving the default MCP launch. */
export function buildQueryOptions(req: AgentTurnRequest, deps: QueryOptionDeps): Options {
  const root = deps.root ?? req.root
  const modeTools = MODE_TOOLS[req.mode]
  const launch = deps.mcpLaunch ?? defaultMcpLaunch()
  const readTools = modeTools.filter((t) => (READ_TOOLS as readonly string[]).includes(t))
  const autoWrites = modeTools.filter((t) => AUTO_ALLOWED_WRITES.includes(t))

  const options: Options = {
    model: req.model,
    cwd: root,
    // `env` replaces the child environment, so start from a copy of the base env.
    env: { ...(deps.baseEnv ?? process.env), ANTHROPIC_API_KEY: req.apiKey, CLAUDE_AGENT_SDK_CLIENT_APP: "river/0.1.0" },
    // No filesystem settings: the game repo's .claude/ cannot add allow rules, hooks or MCP servers.
    settingSources: [],
    strictMcpConfig: true,
    // Manual approvals through canUseTool. Omitting this can start in 'auto' (classifier approvals).
    permissionMode: "default",
    tools: [...BUILTIN_READ_TOOLS],
    // Read/Glob/Grep are NOT here on purpose: a bare allow rule would allow reads outside the root.
    // In-root reads are allowed by Claude Code itself; anything else reaches canUseTool, which checks the path.
    allowedTools: [...readTools, ...autoWrites].map((t) => MCP_PREFIX + t),
    disallowedTools: [...DISALLOWED_BUILTINS],
    canUseTool: deps.canUseTool,
    mcpServers: {
      river: {
        type: "stdio",
        command: launch.command,
        args: [...launch.args, "--root", root, "--tools", modeTools.join(",")],
        // The River server needs no Anthropic key; make sure it does not inherit one.
        env: { ANTHROPIC_API_KEY: "" },
        alwaysLoad: true,
      },
    },
    systemPrompt: {
      type: "preset",
      preset: "claude_code",
      append: SYSTEM_PROMPTS[req.mode],
      // A resumed session may change mode; render the mode prompt fresh instead of reusing the first one.
      snapshot: false,
    },
    effort: deps.effort ?? "high",
    maxTurns: deps.maxTurns ?? 40,
    abortController: deps.abortController,
    includePartialMessages: false,
  }
  if (req.sessionId) options.resume = req.sessionId
  if (deps.pathToClaudeCodeExecutable) options.pathToClaudeCodeExecutable = deps.pathToClaudeCodeExecutable
  return options
}
