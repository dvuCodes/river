import { spawn, type ChildProcess } from "node:child_process"
import { once } from "node:events"
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
  APPROVAL_TOOL,
  buildClaudeCodeArgs,
  claudeCodeEnv,
  claudeCodeStdin,
  getClaudeCodeStatus,
  killTree,
  parseAuthStatus,
  resolveClaudeCommand,
} from "../src/claude-code"
import { DISALLOWED_BUILTINS } from "../src/options"
import { SYSTEM_PROMPTS } from "../src/prompts"
import { startAgentTurn } from "../src/run"
import type { AgentEvent, AgentTurnRequest } from "../src/types"
import { removeDir, tempGame } from "./helpers"

const FAKE = fileURLToPath(new URL("./fake-claude.mjs", import.meta.url))
const launch = { command: "node", args: ["fake-mcp.js"] }

const req = (over: Partial<AgentTurnRequest> = {}): AgentTurnRequest => ({
  root: "/game",
  mode: "plan",
  model: "claude-sonnet-5-5",
  prompt: "hello",
  backend: "claude-code",
  ...over,
})

/** Value of a `--flag=value` argument. */
const flag = (args: string[], name: string) => {
  const hit = args.find((a) => a === name || a.startsWith(`${name}=`))
  return hit === undefined ? undefined : hit === name ? true : hit.slice(name.length + 1)
}

describe("claude-code arguments", () => {
  const opts = { root: "/game", approvalPipe: "\\\\.\\pipe\\river-test", mcpLaunch: launch }

  it("has every flag River relies on, and no --bare", () => {
    const args = buildClaudeCodeArgs(req(), opts)
    expect(args[0]).toBe("-p")
    expect(flag(args, "--output-format")).toBe("stream-json")
    expect(flag(args, "--verbose")).toBe(true)
    expect(flag(args, "--include-partial-messages")).toBe(true)
    expect(flag(args, "--model")).toBe("claude-sonnet-5-5")
    expect(flag(args, "--permission-mode")).toBe("default")
    expect(flag(args, "--permission-prompts")).toBe("host")
    expect(flag(args, "--permission-prompt-tool")).toBe(APPROVAL_TOOL)
    expect(APPROVAL_TOOL).toBe("mcp__river__approval_prompt")
    expect(flag(args, "--strict-mcp-config")).toBe(true)
    expect(flag(args, "--setting-sources")).toBe("")
    expect(flag(args, "--tools")).toBe("Read,Glob,Grep")
    expect(flag(args, "--disallowedTools")).toBe(DISALLOWED_BUILTINS.join(","))
    expect(flag(args, "--append-system-prompt")).toBe(SYSTEM_PROMPTS.plan)
    expect(flag(args, "--system-prompt-snapshot")).toBe("off")
    expect(flag(args, "--max-turns")).toBe("40")
    expect(flag(args, "--effort")).toBe("high")
    expect(flag(args, "--resume")).toBeUndefined()
    expect(args).not.toContain("--bare")
    expect(args.some((a) => a.startsWith("--bare"))).toBe(false)
    expect(args.some((a) => a.includes("dangerously"))).toBe(false)

    const allowed = String(flag(args, "--allowedTools")).split(",")
    expect(allowed).toContain("mcp__river__story_lint")
    expect(allowed).toContain("mcp__river__plan_save")
    expect(allowed).not.toContain("mcp__river__review_reply")
    expect(allowed).not.toContain(APPROVAL_TOOL)
    expect(allowed).not.toContain("Read")
  })

  it("runs river-mcp with the mode's tools and the approval pipe", () => {
    const args = buildClaudeCodeArgs(req({ mode: "story" }), opts)
    const cfg = JSON.parse(String(flag(args, "--mcp-config"))) as { mcpServers: Record<string, { type: string; command: string; args: string[]; env: Record<string, string> }> }
    expect(Object.keys(cfg.mcpServers)).toEqual(["river"])
    const river = cfg.mcpServers.river!
    expect(river.type).toBe("stdio")
    expect(river.command).toBe("node")
    expect(river.args).toEqual([
      "fake-mcp.js",
      "--root",
      "/game",
      "--tools",
      "project_info,story_list,story_read,story_lint,story_paths,playtest_run,frames_list,review_list,plan_list,plan_read,board_read,marks_open,brief_read,card_read,mark_read,card_view,voice_read,story_outline,story_read_passage,story_search,story_sample_transcripts,story_pacing,story_simulate,story_write_passage,story_add_passage,story_rename_passage,story_delete_passage,story_batch_edit,voice_note",
      "--approval-pipe",
      "\\\\.\\pipe\\river-test",
    ])
    expect(river.args.join(",")).not.toContain("approval_prompt")
    expect(river.env.ANTHROPIC_API_KEY).toBe("")
  })

  it("starts river-mcp for a concept turn with --concept and pre-allows concept_write", () => {
    const args = buildClaudeCodeArgs(req({ mode: "concept", conceptId: "k_cli00001" }), opts)
    const cfg = JSON.parse(String(flag(args, "--mcp-config"))) as { mcpServers: { river: { args: string[] } } }
    const river = cfg.mcpServers.river.args
    expect(river.slice(river.indexOf("--concept"), river.indexOf("--concept") + 2)).toEqual(["--concept", "k_cli00001"])
    expect(river[river.indexOf("--tools") + 1]!.split(",")).toContain("concept_write")
    expect(String(flag(args, "--allowedTools")).split(",")).toContain("mcp__river__concept_write")
    expect(flag(args, "--append-system-prompt")).toBe(SYSTEM_PROMPTS.concept)
  })

  it("adds the project brief to the system prompt, cut short so the command line stays under Windows' limit", () => {
    const brief = (text: string) => String(flag(buildClaudeCodeArgs(req({ mode: "concept", conceptId: "k_cli00001", brief: text }), opts), "--append-system-prompt"))
    expect(brief("Warm palette.\n")).toBe(`${SYSTEM_PROMPTS.concept}\n\nThe project brief (.river/brief.md), written by the user:\nWarm palette.`)
    const long = brief("x".repeat(50_000))
    expect(long.length).toBeLessThan(SYSTEM_PROMPTS.concept.length + 6200)
    expect(long).toContain("read it with brief_read")
  })

  it("resumes a session", () => {
    expect(flag(buildClaudeCodeArgs(req({ sessionId: "abc-123" }), opts), "--resume")).toBe("abc-123")
  })

  it("keeps the prompt off the command line, quotes and newlines intact on stdin", () => {
    const prompt = `Change "creaks open" to 'swings open'\nthen "lint" it; & echo pwned | more\r\n100% done ^ $HOME`
    const r = req({ prompt, storyFile: "stories/park_walk.twee" })
    const args = buildClaudeCodeArgs(r, opts)
    expect(args.some((a) => a.includes("creaks open"))).toBe(false)
    expect(claudeCodeStdin(r)).toBe("[River context]\nOpen story file: stories/park_walk.twee\n\n" + prompt)
  })

  it("strips Anthropic credentials from the CLI env without touching the base env", () => {
    const base = { PATH: "/bin", ANTHROPIC_API_KEY: "sk-x", anthropic_auth_token: "t", ANTHROPIC_AUTH_TOKEN: "t2", ELECTRON_RUN_AS_NODE: "1", HOME: "/h", CLAUDECODE: "1", CLAUDE_CODE_MESSAGING_TOKEN: "m", CLAUDE_CODE_USE_BEDROCK: "1" }
    const env = claudeCodeEnv(base)
    expect(env).toEqual({ PATH: "/bin", HOME: "/h", CLAUDE_CODE_USE_BEDROCK: "1" })
    expect(base.ANTHROPIC_API_KEY).toBe("sk-x")
  })
})

describe("claude-code status", () => {
  it("keeps only loggedIn, authMethod and subscriptionType", () => {
    const raw = JSON.stringify({
      loggedIn: true,
      authMethod: "claude.ai",
      apiProvider: "firstParty",
      email: "someone@example.com",
      orgId: "org-1",
      orgName: "Someone's Org",
      subscriptionType: "max",
      configDirectory: "/home/x/.claude",
      loginExpiresAt: "2030-01-01",
    })
    const s = parseAuthStatus(raw)
    expect(s).toEqual({ loggedIn: true, authMethod: "claude.ai", subscriptionType: "max" })
    expect(JSON.stringify(s)).not.toMatch(/example\.com|org-1|Org|\.claude/)
    expect(parseAuthStatus("not json")).toBeUndefined()
    expect(parseAuthStatus('{"loggedIn":"yes"}')).toEqual({ loggedIn: false })
  })

  it("reads status from the CLI, including signed-out (exit 1)", async () => {
    const auth = JSON.stringify({ loggedIn: true, authMethod: "claude.ai", subscriptionType: "pro", email: "a@b.c", orgName: "X" })
    const s = await getClaudeCodeStatus(FAKE, { ...process.env, FAKE_CLAUDE_AUTH: auth })
    expect(s).toEqual({ installed: true, version: "9.9.9", loggedIn: true, authMethod: "claude.ai", subscriptionType: "pro" })
    const out = await getClaudeCodeStatus(FAKE, { ...process.env, FAKE_CLAUDE_AUTH: '{"loggedIn":false,"authMethod":"none","email":"a@b.c"}' })
    expect(out).toEqual({ installed: true, version: "9.9.9", loggedIn: false, authMethod: "none" })
  })

  it("reports a missing CLI", async () => {
    const s = await getClaudeCodeStatus(path.join(tmpdir(), "no-such-claude.exe"))
    expect(s.installed).toBe(false)
    expect(s.loggedIn).toBe(false)
    expect(s.error).toContain("not found")
    const none = await getClaudeCodeStatus(undefined, { PATH: "" })
    expect(none).toMatchObject({ installed: false, loggedIn: false })
  })

  it("refuses a .cmd shim and runs a .js entry with this runtime", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "river-cc-"))
    const shim = path.join(dir, "claude.cmd")
    writeFileSync(shim, "@echo off\n")
    expect(() => resolveClaudeCommand(shim)).toThrow(/shell script shim/)
    removeDir(dir)
    expect(resolveClaudeCommand(FAKE)).toMatchObject({ command: process.execPath, prefixArgs: [FAKE] })
  })
})

describe("claude-code turn with a fake claude", () => {
  let root: string
  let record: string
  beforeEach(() => {
    root = tempGame()
    record = path.join(mkdtempSync(path.join(tmpdir(), "river-rec-")), "rec.json")
  })
  afterEach(() => {
    removeDir(root)
    removeDir(path.dirname(record))
  })

  it("maps the CLI's stream-json to AgentEvents", async () => {
    const events: AgentEvent[] = []
    const onPermission = vi.fn()
    await startAgentTurn(
      req({ root, claudePath: FAKE, prompt: 'Say "hi"\nthen stop' }),
      { onEvent: (e) => events.push(e), onPermission },
      { mcpLaunch: launch, baseEnv: { ...process.env, ANTHROPIC_API_KEY: "sk-should-not-pass", ANTHROPIC_AUTH_TOKEN: "tok", FAKE_CLAUDE_RECORD: record } },
    )
    expect(events).toEqual([
      { type: "session", sessionId: "fake-session-1" },
      { type: "text", text: "Checking the story." },
      { type: "tool", tool: "story_lint", summary: "story_lint stories/park_walk.twee" },
      { type: "tool-result", tool: "story_lint", ok: true, summary: "1 error, 2 warnings in 8 passages" },
      { type: "text", text: "One error and two warnings." },
      { type: "done", costUsd: 0.0123, turns: 2 },
    ])
    expect(onPermission).not.toHaveBeenCalled()

    const rec = JSON.parse(readFileSync(record, "utf8")) as { argv: string[]; stdin: string; cwd: string; envKeys: string[] }
    expect(rec.stdin).toBe('Say "hi"\nthen stop')
    expect(path.resolve(rec.cwd).toLowerCase()).toBe(path.resolve(root).toLowerCase())
    expect(rec.envKeys).not.toContain("ANTHROPIC_API_KEY")
    expect(rec.envKeys).not.toContain("ANTHROPIC_AUTH_TOKEN")
    expect(rec.argv).not.toContain("--bare")
    expect(rec.argv).toContain(`--permission-prompt-tool=${APPROVAL_TOOL}`)
    // The approval pipe exists for the turn and is passed to river-mcp.
    expect(rec.argv.find((a) => a.startsWith("--mcp-config="))).toContain("--approval-pipe")
  })

  it("does not need an API key, and checkpoints story turns", async () => {
    const events: AgentEvent[] = []
    await startAgentTurn(
      req({ root, mode: "story", claudePath: FAKE }),
      { onEvent: (e) => events.push(e), onPermission: vi.fn() },
      { mcpLaunch: launch },
    )
    expect(events[0]).toMatchObject({ type: "session", sessionId: "fake-session-1", checkpointRef: expect.stringMatching(/^refs\/river\//) })
    expect(events.at(-1)).toMatchObject({ type: "done" })
    expect(events.some((e) => e.type === "error")).toBe(false)
  })

  it("reports a missing CLI as an error event", async () => {
    const events: AgentEvent[] = []
    await startAgentTurn(req({ root, claudePath: path.join(root, "nope.exe") }), { onEvent: (e) => events.push(e), onPermission: vi.fn() }, { mcpLaunch: launch })
    expect(events).toEqual([
      { type: "error", message: expect.stringContaining("not found") },
      { type: "done" },
    ])
  })

  it("kills the CLI on abort", async () => {
    const events: AgentEvent[] = []
    const ac = new AbortController()
    const started = Date.now()
    const p = startAgentTurn(
      req({ root, claudePath: FAKE }),
      {
        onEvent: (e) => {
          events.push(e)
          if (e.type === "session") ac.abort()
        },
        onPermission: vi.fn(),
        signal: ac.signal,
      },
      { mcpLaunch: launch, baseEnv: { ...process.env, FAKE_CLAUDE_HANG: "1" } },
    )
    await p
    expect(Date.now() - started).toBeLessThan(15_000)
    expect(events.at(-2)).toEqual({ type: "error", message: "Turn aborted." })
    expect(events.at(-1)).toEqual({ type: "done" })
  }, 20_000)
})

describe("killTree", () => {
  /** A Node process that runs until killed; with ignoreTerm it shrugs off SIGTERM. */
  const sleeper = (ignoreTerm: boolean) => {
    const child = spawn(process.execPath, ["-e", `${ignoreTerm ? "process.on('SIGTERM', () => {}); " : ""}console.log('up'); setInterval(() => {}, 1000)`], {
      stdio: ["ignore", "pipe", "ignore"],
      detached: process.platform !== "win32",
    })
    return { child, up: once(child.stdout!, "data") }
  }
  const exitsWithin = (child: ChildProcess, ms: number) =>
    new Promise<boolean>((resolve) => {
      if (child.exitCode !== null || child.signalCode !== null) return resolve(true)
      const timer = setTimeout(() => resolve(false), ms)
      child.once("exit", () => {
        clearTimeout(timer)
        resolve(true)
      })
    })

  it.runIf(process.platform === "win32")("kills the child itself when taskkill cannot run", async () => {
    const { child, up } = sleeper(false)
    await up
    const saved = process.env.PATH
    process.env.PATH = ""
    try {
      killTree(child, 60_000)
    } finally {
      process.env.PATH = saved
    }
    const exited = await exitsWithin(child, 10_000)
    child.kill()
    expect(exited).toBe(true)
  }, 20_000)

  it.skipIf(process.platform === "win32")("follows SIGTERM with SIGKILL when the child ignores it", async () => {
    const { child, up } = sleeper(true)
    await up
    killTree(child, 300)
    const exited = await exitsWithin(child, 10_000)
    child.kill("SIGKILL")
    expect(exited).toBe(true)
    expect(child.signalCode).toBe("SIGKILL")
  }, 20_000)
})
