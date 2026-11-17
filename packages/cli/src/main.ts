#!/usr/bin/env node
import { run } from "./run"

// A reader that stops early (`river shots | head`) closes the pipe: stop quietly instead of crashing on EPIPE.
for (const stream of [process.stdout, process.stderr]) {
  stream.on("error", (e: NodeJS.ErrnoException) => {
    if (e.code !== "EPIPE") throw e
    process.exit(process.exitCode ?? 0)
  })
}

// `pnpm -C <river> river lint ../game` runs this from River's folder; pnpm keeps the caller's folder in INIT_CWD.
const fromRiverScript = process.env.npm_package_name === "river-monorepo" && process.env.npm_lifecycle_event === "river"
const cwd = fromRiverScript && process.env.INIT_CWD ? process.env.INIT_CWD : process.cwd()

process.exitCode = await run(process.argv.slice(2), { cwd })
