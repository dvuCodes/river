/**
 * The host end of river-mcp's `approval_prompt` (Claude Code backend). One local named pipe
 * (Windows) or Unix socket per turn. Each connection carries one request and gets one answer:
 *
 *   <- { "tool_name": string, "input": object, "tool_use_id"?: string }
 *   -> { "behavior": "allow" } | { "behavior": "deny", "message": string }
 *
 * The wire shape is duplicated in packages/mcp/src/approval.ts (no cross-package import);
 * packages/mcp/test/approval.test.ts pins the two together by running the real river-mcp against this server.
 */
import { randomBytes } from "node:crypto"
import { rmSync } from "node:fs"
import { createServer, type Socket } from "node:net"
import { tmpdir } from "node:os"
import path from "node:path"

/** Structurally the same as PolicyResult; kept local so this file imports only node builtins. */
export type ApprovalResult = { behavior: "allow" } | { behavior: "deny"; message: string }

export type ApprovalDecider = (toolName: string, input: Record<string, unknown>, toolUseId?: string) => Promise<ApprovalResult>

export interface ApprovalServer {
  /** Pass to river-mcp as --approval-pipe. */
  pipe: string
  /** Stop listening and drop open requests (river-mcp then denies them). */
  close(): Promise<void>
}

/** A fresh, unguessable pipe/socket name. */
export function approvalPipeName(): string {
  const id = randomBytes(12).toString("hex")
  return process.platform === "win32" ? `\\\\.\\pipe\\river-${id}` : path.join(tmpdir(), `river-${id}.sock`)
}

const MAX_REQUEST = 4 * 1024 * 1024
type Obj = Record<string, unknown>
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v)

export async function startApprovalServer(decide: ApprovalDecider, pipe = approvalPipeName()): Promise<ApprovalServer> {
  const sockets = new Set<Socket>()
  const server = createServer((sock) => {
    sockets.add(sock)
    sock.on("close", () => sockets.delete(sock))
    sock.on("error", () => sock.destroy())
    sock.setEncoding("utf8")
    let buf = ""
    let handled = false
    const answer = (a: { behavior: "allow" } | { behavior: "deny"; message: string }) => {
      if (!sock.destroyed) sock.end(JSON.stringify(a) + "\n")
    }
    sock.on("data", (chunk: string) => {
      if (handled) return
      buf += chunk
      if (buf.length > MAX_REQUEST) {
        handled = true
        return answer({ behavior: "deny", message: "Permission request too large" })
      }
      const nl = buf.indexOf("\n")
      if (nl === -1) return
      handled = true
      let msg: unknown
      try {
        msg = JSON.parse(buf.slice(0, nl))
      } catch {
        return answer({ behavior: "deny", message: "Unreadable permission request" })
      }
      if (!isObj(msg) || typeof msg.tool_name !== "string") return answer({ behavior: "deny", message: "Malformed permission request" })
      const input = isObj(msg.input) ? msg.input : {}
      const toolUseId = typeof msg.tool_use_id === "string" && msg.tool_use_id ? msg.tool_use_id : undefined
      decide(msg.tool_name, input, toolUseId).then(
        (r) => answer(r.behavior === "allow" ? { behavior: "allow" } : { behavior: "deny", message: r.message }),
        (err: unknown) => answer({ behavior: "deny", message: `Permission check failed: ${err instanceof Error ? err.message : String(err)}` }),
      )
    })
  })
  if (process.platform !== "win32") rmSync(pipe, { force: true })
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject)
    server.listen(pipe, () => {
      server.off("error", reject)
      resolve()
    })
  })
  return {
    pipe,
    close: () =>
      new Promise<void>((resolve) => {
        for (const s of sockets) s.destroy()
        server.close(() => {
          if (process.platform !== "win32") rmSync(pipe, { force: true })
          resolve()
        })
      }),
  }
}
