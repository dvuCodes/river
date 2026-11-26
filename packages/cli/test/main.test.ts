import { spawn } from "node:child_process"
import { copyFileSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { describe, expect, it } from "vitest"

const repo = path.join(import.meta.dirname, "..", "..", "..")
const main = path.join(import.meta.dirname, "..", "src", "main.ts")

/** A project whose story has 2^12 routes, so `paths` prints far more than a pipe holds. */
function bigProject(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "river-main-"))
  mkdirSync(path.join(dir, "stories"))
  copyFileSync(path.join(repo, "examples/park-walk/river.json"), path.join(dir, "river.json"))
  copyFileSync(path.join(repo, "examples/park-walk/stories/state.json"), path.join(dir, "stories/state.json"))
  const passages = Array.from({ length: 12 }, (_, i) => `:: P${i}\n--\n[[Left->P${i + 1}]]\n[[Right->P${i + 1}]] @set bond += 1\n`)
  writeFileSync(path.join(dir, "stories/big.twee"), `:: StoryData\n{ "ifid": "9B1D7C2E-3F4A-4B5C-8D6E-7F8091A2B3C4", "start": "P0" }\n\n${passages.join("\n")}\n:: P12\n@end\n--\n`)
  return dir
}

function river(args: string[], env: NodeJS.ProcessEnv = {}) {
  // Windows keys are case-insensitive and a test runner may have upper-cased them: drop the old spelling.
  const over = new Set(Object.keys(env).map((k) => k.toLowerCase()))
  const base = Object.fromEntries(Object.entries(process.env).filter(([k]) => !over.has(k.toLowerCase())))
  return spawn(process.execPath, ["--import", "tsx", main, ...args], { cwd: repo, env: { ...base, ...env }, stdio: ["ignore", "pipe", "pipe"] })
}

describe("the river executable", { timeout: 60_000 }, () => {
  it("stops quietly when the reader closes the pipe early (river paths | head)", async () => {
    const child = river(["paths", bigProject(), "--max", "5000"])
    let stderr = ""
    child.stderr.on("data", (d) => (stderr += String(d)))
    child.stdout.once("data", () => child.stdout.destroy())
    const code = await new Promise((resolve) => child.once("exit", resolve))
    expect([code, stderr]).toEqual([0, ""])
  })

  it("reads paths from the caller's folder when pnpm -C runs River's script", async () => {
    const game = bigProject()
    const child = river(["lint"], { INIT_CWD: game, npm_package_name: "river-monorepo", npm_lifecycle_event: "river" })
    let stdout = ""
    let stderr = ""
    child.stdout.on("data", (d) => (stdout += String(d)))
    child.stderr.on("data", (d) => (stderr += String(d)))
    const code = await new Promise((resolve) => child.once("close", resolve))
    expect([code, stdout, stderr]).toEqual([0, expect.stringContaining("0 errors, 0 warnings in 13 passages\n"), ""])
  })
})
