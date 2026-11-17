import { existsSync, readFileSync } from "node:fs"
import { createRequire } from "node:module"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import react from "@vitejs/plugin-react"
import { defineConfig } from "electron-vite"
import type { Plugin } from "vite"

const here = dirname(fileURLToPath(import.meta.url))
const SDK = "@anthropic-ai/claude-agent-sdk"

/**
 * The agent SDK spawns its own CLI from files next to its entry, so it must not be bundled.
 * It is installed only for packages/agent, so resolve it from there and import it by file URL.
 * If it cannot be found, the import fails at run time and the app shows "agent unavailable".
 */
function agentSdkExternal(): Plugin {
  const agentPkg = resolve(here, "../../packages/agent/package.json")
  let entry: string | undefined
  try {
    entry = createRequire(agentPkg).resolve(SDK)
  } catch {
    const dir = resolve(here, "../../packages/agent/node_modules", SDK)
    const pkgFile = join(dir, "package.json")
    if (existsSync(pkgFile)) {
      const pkg = JSON.parse(readFileSync(pkgFile, "utf8")) as { main?: string; exports?: unknown }
      const dot = (pkg.exports as Record<string, unknown> | undefined)?.["."]
      const rel =
        typeof dot === "string"
          ? dot
          : typeof dot === "object" && dot !== null
            ? ((dot as Record<string, unknown>)["import"] ?? (dot as Record<string, unknown>)["default"])
            : pkg.main
      if (typeof rel === "string") entry = join(dir, rel)
    }
  }
  return {
    name: "river:agent-sdk-external",
    enforce: "pre",
    resolveId(id) {
      if (id === SDK || id.startsWith(SDK + "/")) {
        return { id: entry ? pathToFileURL(entry).href : id, external: true }
      }
      return null
    },
  }
}

export default defineConfig({
  main: {
    plugins: [agentSdkExternal()],
    build: {
      // Workspace packages export raw TypeScript, so they must be bundled into main.
      externalizeDeps: { exclude: ["@river/core", "@river/agent", "@river/adapter-godot"] },
    },
  },
  preload: {
    build: {
      // A sandboxed preload must be one CommonJS file with no external imports but electron.
      externalizeDeps: false,
      rolldownOptions: {
        output: { format: "cjs", entryFileNames: "[name].cjs" },
      },
    },
  },
  renderer: {
    plugins: [react()],
  },
})
