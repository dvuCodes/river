import { defineConfig } from "vitest/config"

export default defineConfig({
  test: {
    include: ["packages/*/test/**/*.test.ts"],
    // A concept job's look at its renders runs a real agent turn by default; tests that want it inject the turn.
    env: { RIVER_SELF_CHECK: "off" },
  },
})
