/**
 * The "claude-code" backend: River runs the user's own installed `claude` CLI, unmodified, in
 * headless mode (`claude -p --output-format stream-json`). The user signs in to that CLI with
 * Anthropic's own flow (`claude auth login`); River never reads, stores or forwards credentials.
 *
 * - The child env has no ANTHROPIC_API_KEY / ANTHROPIC_AUTH_TOKEN, so the CLI uses its own sign-in.
 * - No --bare (it would turn off the CLI's own sign-in).
 * - No user/project/local settings (--setting-sources with an empty list), only River's MCP server
 *   (--strict-mcp-config), only Read/Glob/Grep as built-ins.
 * - Permission prompts go to river-mcp's approval_prompt, which asks this process over a local pipe;
 *   the answer comes from the same policy as the SDK backend (decideToolCall).
 */
import { execFile, spawn, type ChildProcess } from "node:child_process"
import { existsSync, statSync } from "node:fs"
import path from "node:path"
import { createInterface } from "node:readline"
import type { MessageMapper } from "./events"
import { DISALLOWED_BUILTINS, defaultMcpLaunch, preAllowedTools, riverMcpServer, type McpLaunch } from "./options"
import { BUILTIN_READ_TOOLS, MCP_PREFIX } from "./policy"
import { systemPrompt, turnContext } from "./prompts"
import type { AgentTurnRequest, ClaudeCodeStatus } from "./types"

export const APPROVAL_TOOL = `${MCP_PREFIX}approval_prompt`

type Env = Record<string, string | undefined>

/** Env vars that would make the CLI bill an API key instead of the user's own sign-in. */
const STRIPPED_ENV = ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN"]

/**
 * Vars a Claude Code session sets for its own children. When River itself was started from a
 * Claude Code session (a dev shell), they would make the CLI attach to that parent session
 * (its plugins, its messaging socket and token). River's CLI run is a fresh, separate session.
 */
const PARENT_SESSION_ENV = [
  "CLAUDECODE",
  "CLAUDE_PID",
  "CLAUDE_EFFORT",
  "CLAUDE_AGENT_SDK_VERSION",
  "CLAUDE_CODE_ENTRYPOINT",
  "CLAUDE_CODE_EXECPATH",
  "CLAUDE_CODE_CHILD_SESSION",
  "CLAUDE_CODE_SESSION_ID",
  "CLAUDE_CODE_SESSION_ATTENDED",
  "CLAUDE_CODE_MESSAGING_SOCKET",
  "CLAUDE_CODE_MESSAGING_TOKEN",
  "CLAUDE_CODE_PLUGIN_DIRS",
]

/**
 * A copy of `base` for the CLI, never mutating `base`: no Anthropic key or auth token (any letter
 * case), and none of a parent Claude Code session's linkage vars.
 */
export function claudeCodeEnv(base: Env = process.env): Env {
  const env: Env = {}
  for (const [k, v] of Object.entries(base)) {
    if (v === undefined) continue
    const up = k.toUpperCase()
    if (STRIPPED_ENV.includes(up) || PARENT_SESSION_ENV.includes(up)) continue
    // River's own Electron flag must not leak into the CLI (it is not a Node script).
    if (k === "ELECTRON_RUN_AS_NODE") continue
    env[k] = v
  }
  return env
}

/** How to start the CLI: an executable, or a Node script (tests, or a JS entry point) run with this runtime. */
export interface ClaudeCommand {
  command: string
  prefixArgs: string[]
  /** Extra env for the child (ELECTRON_RUN_AS_NODE for a script run by Electron). */
  env: Env
}

const SCRIPT_EXT = new Set([".js", ".mjs", ".cjs"])
const SHELL_EXT = new Set([".cmd", ".bat", ".ps1"])

function isFile(p: string): boolean {
  try {
    return statSync(p).isFile()
  } catch {
    return false
  }
}

/** Find `claude` on PATH. Windows: prefers .exe/.com; reports a .cmd shim it cannot run safely. */
export function findClaudeOnPath(env: Env = process.env): string | undefined {
  const pathVar = env.PATH ?? env.Path ?? env.path ?? ""
  const dirs = pathVar.split(path.delimiter).filter(Boolean)
  const exts = process.platform === "win32" ? [".exe", ".com", ".cmd", ".bat"] : [""]
  for (const ext of exts) {
    for (const dir of dirs) {
      const p = path.join(dir, `claude${ext}`)
      if (isFile(p)) return p
    }
  }
  return undefined
}

/** Resolve the CLI. Throws a user-facing message when it is missing or cannot be run without a shell. */
export function resolveClaudeCommand(claudePath?: string, env: Env = process.env): ClaudeCommand {
  const target = claudePath?.trim() ? claudePath.trim() : findClaudeOnPath(env)
  if (!target) throw new Error("Claude Code not found on PATH. Install it, or set its path in Settings.")
  if (claudePath?.trim() && !existsSync(target)) throw new Error(`Claude Code not found at ${target}.`)
  const ext = path.extname(target).toLowerCase()
  if (SHELL_EXT.has(ext)) {
    throw new Error(
      `${target} is a shell script shim, which River does not run (it would need a shell). Use the native installer, or set the path to claude.exe in Settings.`,
    )
  }
  if (SCRIPT_EXT.has(ext)) {
    return { command: process.execPath, prefixArgs: [target], env: process.versions.electron ? { ELECTRON_RUN_AS_NODE: "1" } : {} }
  }
  return { command: target, prefixArgs: [], env: {} }
}

export interface ClaudeArgsOptions {
  /** Absolute game root. */
  root: string
  /** Pipe/socket name of the approval server. */
  approvalPipe: string
  mcpLaunch?: McpLaunch
  maxTurns?: number
  effort?: string
}

/** The MCP config River passes inline: only the "river" server, with approval_prompt switched on. */
export function claudeMcpConfig(req: AgentTurnRequest, o: ClaudeArgsOptions): string {
  const server = riverMcpServer(req, o.root, o.mcpLaunch ?? defaultMcpLaunch(), ["--approval-pipe", o.approvalPipe])
  return JSON.stringify({ mcpServers: { river: { type: "stdio", ...server } } })
}

/**
 * CLI arguments for one turn. Every value uses the `--flag=value` form so a variadic flag
 * (--tools, --allowedTools, --mcp-config) never swallows the next argument. The prompt is NOT here:
 * it goes on stdin (see `claudeCodeStdin`), which avoids Windows command-line quoting issues.
 */
export function buildClaudeCodeArgs(req: AgentTurnRequest, o: ClaudeArgsOptions): string[] {
  const args = [
    "-p",
    "--output-format=stream-json",
    "--verbose",
    "--input-format=text",
    `--model=${req.model}`,
    // Manual approvals: anything not pre-allowed goes to the permission prompt tool.
    "--permission-mode=default",
    "--permission-prompts=host",
    `--permission-prompt-tool=${APPROVAL_TOOL}`,
    "--strict-mcp-config",
    `--mcp-config=${claudeMcpConfig(req, o)}`,
    // Empty list: no user, project or local settings, so the game repo's .claude/ cannot add rules, hooks or servers.
    "--setting-sources=",
    `--tools=${BUILTIN_READ_TOOLS.join(",")}`,
    // Read/Glob/Grep are not pre-allowed on purpose (see options.ts); in-root reads need no approval anyway.
    `--allowedTools=${preAllowedTools(req.mode).join(",")}`,
    `--disallowedTools=${DISALLOWED_BUILTINS.join(",")}`,
    `--append-system-prompt=${systemPrompt(req)}`,
    // A resumed session may change mode; render the mode prompt fresh.
    "--system-prompt-snapshot=off",
    `--max-turns=${o.maxTurns ?? 40}`,
    `--effort=${o.effort ?? "high"}`,
  ]
  if (req.sessionId) args.push(`--resume=${req.sessionId}`)
  return args
}

/** What River writes to the CLI's stdin: turn context plus the user's prompt. */
export function claudeCodeStdin(req: AgentTurnRequest): string {
  return turnContext(req) + req.prompt
}

/** How long a child may take to exit after the first kill before River forces it. */
const KILL_GRACE_MS = 5_000

/**
 * Kill the CLI and everything it started (river-mcp, the engine): taskkill the tree on Windows, falling back to
 * the CLI itself when taskkill cannot run; SIGTERM to the process group on POSIX. A child still running after
 * `graceMs` is killed outright (SIGKILL to the group on POSIX), so a turn never waits forever on its exit.
 */
export function killTree(child: ChildProcess, graceMs = KILL_GRACE_MS): void {
  const pid = child.pid
  const ended = () => child.exitCode !== null || child.signalCode !== null
  if (pid === undefined || ended()) return
  const signalGroup = (signal: NodeJS.Signals) => {
    try {
      process.kill(-pid, signal)
    } catch {
      child.kill(signal)
    }
  }
  if (process.platform === "win32") {
    execFile("taskkill", ["/pid", String(pid), "/T", "/F"], { windowsHide: true }, (err) => {
      if (err && !ended()) child.kill()
    })
  } else signalGroup("SIGTERM")
  const force = setTimeout(() => {
    if (ended()) return
    if (process.platform === "win32") child.kill()
    else signalGroup("SIGKILL")
  }, graceMs)
  force.unref()
  child.once("exit", () => clearTimeout(force))
}

export interface ClaudeRunDeps {
  claudePath?: string
  baseEnv?: Env
  mcpLaunch?: McpLaunch
  maxTurns?: number
  effort?: string
}

/**
 * Run the CLI for one turn and feed its stream-json lines to the mapper.
 * Resolves when the process exits. Throws only for a launch failure.
 */
export async function runClaudeCodeProcess(
  req: AgentTurnRequest,
  root: string,
  approvalPipe: string,
  mapper: MessageMapper,
  signal: AbortSignal,
  deps: ClaudeRunDeps = {},
): Promise<{ code: number | null; stderr: string }> {
  const base = deps.baseEnv ?? process.env
  const cmd = resolveClaudeCommand(deps.claudePath ?? req.claudePath, base)
  const args = [
    ...cmd.prefixArgs,
    ...buildClaudeCodeArgs(req, {
      root,
      approvalPipe,
      ...(deps.mcpLaunch ? { mcpLaunch: deps.mcpLaunch } : {}),
      ...(deps.maxTurns ? { maxTurns: deps.maxTurns } : {}),
      ...(deps.effort ? { effort: deps.effort } : {}),
    }),
  ]
  // MCP calls past 2 minutes would move to the background; a capture or an approval can take longer.
  const env = { ...claudeCodeEnv(base), CLAUDE_CODE_MCP_AUTO_BACKGROUND_MS: "0", ...cmd.env }
  const child = spawn(cmd.command, args, {
    cwd: root,
    env,
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
    detached: process.platform !== "win32",
  })

  let stderr = ""
  child.stderr!.setEncoding("utf8")
  child.stderr!.on("data", (d: string) => {
    stderr = (stderr + d).slice(-4000)
  })
  child.stdin!.on("error", () => {})
  child.stdin!.end(claudeCodeStdin(req), "utf8")

  const onAbort = () => killTree(child)
  if (signal.aborted) onAbort()
  else signal.addEventListener("abort", onAbort, { once: true })

  const lines = createInterface({ input: child.stdout!, crlfDelay: Infinity })
  lines.on("line", (line) => {
    const t = line.trim()
    if (!t.startsWith("{")) return
    let msg: unknown
    try {
      msg = JSON.parse(t)
    } catch {
      return
    }
    mapper.handle(msg)
  })

  try {
    return await new Promise((resolve, reject) => {
      child.once("error", reject)
      child.once("close", (code) => resolve({ code, stderr }))
    })
  } finally {
    signal.removeEventListener("abort", onAbort)
    lines.close()
  }
}

// ---- status and sign-in

const STATUS_TIMEOUT_MS = 15_000

function run(cmd: ClaudeCommand, args: string[], env: Env): Promise<{ code: number; stdout: string; failed?: string }> {
  return new Promise((resolve) => {
    execFile(
      cmd.command,
      [...cmd.prefixArgs, ...args],
      { env: { ...env, ...cmd.env }, timeout: STATUS_TIMEOUT_MS, windowsHide: true, maxBuffer: 1024 * 1024 },
      (err, stdout) => {
        if (!err) return resolve({ code: 0, stdout: String(stdout) })
        const e = err as NodeJS.ErrnoException & { code?: number | string; killed?: boolean }
        if (typeof e.code === "number") return resolve({ code: e.code, stdout: String(stdout) })
        resolve({ code: -1, stdout: String(stdout), failed: e.killed ? "timed out" : (e.code ?? "failed").toString() })
      },
    )
  })
}

/**
 * Keep only loggedIn, authMethod and subscriptionType from `claude auth status --json`.
 * Email, org and every other field are dropped here and never leave this function.
 */
export function parseAuthStatus(stdout: string): Pick<ClaudeCodeStatus, "loggedIn" | "authMethod" | "subscriptionType"> | undefined {
  let j: unknown
  try {
    j = JSON.parse(stdout.trim())
  } catch {
    return undefined
  }
  if (typeof j !== "object" || j === null || Array.isArray(j)) return undefined
  const o = j as Record<string, unknown>
  const out: Pick<ClaudeCodeStatus, "loggedIn" | "authMethod" | "subscriptionType"> = { loggedIn: o.loggedIn === true }
  if (typeof o.authMethod === "string") out.authMethod = o.authMethod
  if (typeof o.subscriptionType === "string") out.subscriptionType = o.subscriptionType
  return out
}

/** Is Claude Code installed, and signed in? Never throws. Never returns email/org/token fields. */
export async function getClaudeCodeStatus(claudePath?: string, baseEnv: Env = process.env): Promise<ClaudeCodeStatus> {
  let cmd: ClaudeCommand
  try {
    cmd = resolveClaudeCommand(claudePath, baseEnv)
  } catch (err) {
    return { installed: false, loggedIn: false, error: (err as Error).message }
  }
  const env = claudeCodeEnv(baseEnv)
  const ver = await run(cmd, ["--version"], env)
  if (ver.code !== 0) {
    return { installed: false, loggedIn: false, error: `Could not run Claude Code (${ver.failed ?? `exit ${ver.code}`}).` }
  }
  const version = ver.stdout.trim().match(/\d+\.\d+\.\d+/)?.[0]
  const status: ClaudeCodeStatus = { installed: true, loggedIn: false, ...(version ? { version } : {}) }
  // Exits 1 when signed out, with the JSON still on stdout.
  const auth = await run(cmd, ["auth", "status", "--json"], env)
  const parsed = parseAuthStatus(auth.stdout)
  if (!parsed) return { ...status, error: `Could not read the sign-in status (${auth.failed ?? `exit ${auth.code}`}).` }
  return { ...status, ...parsed }
}

const UNSAFE_FOR_CMD = /["%^&|<>!\r\n]/

/**
 * Open a NEW terminal window running `claude auth login`: Anthropic's own sign-in flow, in the
 * user's own Claude Code. River does not see anything typed there.
 */
export async function openClaudeSignIn(claudePath?: string, baseEnv: Env = process.env): Promise<void> {
  const cmd = resolveClaudeCommand(claudePath, baseEnv)
  if (cmd.prefixArgs.length > 0) throw new Error("Sign-in needs the Claude Code executable, not a script.")
  const exe = cmd.command
  const env = claudeCodeEnv(baseEnv)
  const detach = (command: string, args: string[], extra: { windowsVerbatimArguments?: boolean } = {}) =>
    new Promise<void>((resolve, reject) => {
      const child = spawn(command, args, { env, detached: true, stdio: "ignore", ...extra })
      child.once("error", reject)
      child.once("spawn", () => {
        child.unref()
        resolve()
      })
    })

  if (process.platform === "win32") {
    if (UNSAFE_FOR_CMD.test(exe)) throw new Error("The Claude Code path has characters the sign-in window cannot use.")
    // cmd.exe /c start "<title>" cmd /k "<exe>" auth login  — a new console that stays open.
    const comspec = env.ComSpec ?? env.COMSPEC ?? "cmd.exe"
    return detach(comspec, ["/d", "/c", `start "Claude sign-in" cmd /k "${exe}" auth login`], { windowsVerbatimArguments: true })
  }
  if (process.platform === "darwin") {
    const q = exe.replace(/'/g, `'\\''`)
    const script = `tell application "Terminal" to do script "'${q.replace(/["\\]/g, "\\$&")}' auth login"`
    return detach("osascript", ["-e", script, "-e", 'tell application "Terminal" to activate'])
  }
  for (const term of ["x-terminal-emulator", "gnome-terminal", "konsole", "xterm"]) {
    const found = findOnPath(term, env)
    if (found) return detach(found, term === "gnome-terminal" ? ["--", exe, "auth", "login"] : ["-e", exe, "auth", "login"])
  }
  throw new Error("No terminal found. Run `claude auth login` in a terminal, then press Refresh.")
}

function findOnPath(name: string, env: Env): string | undefined {
  for (const dir of (env.PATH ?? "").split(path.delimiter).filter(Boolean)) {
    const p = path.join(dir, name)
    if (isFile(p)) return p
  }
  return undefined
}
