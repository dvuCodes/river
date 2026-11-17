/**
 * The `approval_prompt` tool: Claude Code's permission prompt tool (`--permission-prompt-tool`).
 *
 * river-mcp serves it only when started with `--approval-pipe <name>`. Each call is forwarded over
 * that local named pipe (Windows) or Unix socket to the River agent host, which runs the same
 * permission policy as the SDK backend and answers. Any error, a closed pipe or a timeout denies.
 *
 * Wire format (one request per connection, newline-terminated JSON both ways):
 *   -> { "tool_name": string, "input": object, "tool_use_id"?: string }
 *   <- { "behavior": "allow" } | { "behavior": "deny", "message": string }
 */
import { connect } from "node:net"
import { z } from "zod"

export const APPROVAL_TOOL_NAME = "approval_prompt"

/** What Claude Code passes to a permission prompt tool. Loose on purpose: unknown fields pass through. */
export const approvalInputSchema = {
  tool_name: z.string().describe("The tool Claude wants to call"),
  input: z.record(z.string(), z.unknown()).optional().describe("Its input"),
  tool_use_id: z.string().optional(),
}

export type ApprovalAnswer = { behavior: "allow"; updatedInput: Record<string, unknown> } | { behavior: "deny"; message: string }

/** A human may take minutes to answer. Stays under Claude Code's 30-minute stdio idle timeout. */
export const APPROVAL_TIMEOUT_MS = 25 * 60_000

/** Ask the host over the pipe. Never throws: every failure is a deny. */
export function requestApproval(
  pipe: string,
  req: { tool_name: string; input: Record<string, unknown>; tool_use_id?: string },
  timeoutMs = APPROVAL_TIMEOUT_MS,
): Promise<ApprovalAnswer> {
  return new Promise((resolve) => {
    let settled = false
    let buf = ""
    const finish = (a: ApprovalAnswer) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      sock.destroy()
      resolve(a)
    }
    const denyWith = (message: string) => finish({ behavior: "deny", message })
    const timer = setTimeout(() => denyWith("River did not answer the permission request in time"), timeoutMs)
    const sock = connect(pipe)
    sock.setEncoding("utf8")
    sock.on("connect", () => sock.write(JSON.stringify(req) + "\n"))
    sock.on("data", (chunk: string) => {
      buf += chunk
      const nl = buf.indexOf("\n")
      if (nl === -1) return
      try {
        const reply = JSON.parse(buf.slice(0, nl)) as { behavior?: unknown; message?: unknown }
        if (reply.behavior === "allow") return finish({ behavior: "allow", updatedInput: req.input })
        return denyWith(typeof reply.message === "string" && reply.message ? reply.message : "Denied by River")
      } catch {
        return denyWith("River sent an unreadable answer")
      }
    })
    sock.on("error", (err) => denyWith(`River is not answering permission requests (${err.message})`))
    sock.on("close", () => denyWith("River closed the permission request"))
  })
}
