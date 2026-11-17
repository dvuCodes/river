import type { Diagnostic, StateSchema, Story } from "../story/types"

/**
 * Rules: broken-link (error), unknown-var (error), type-mismatch (error), duplicate-name (error),
 * duplicate-id (error), never-true (warn: a condition no value in the schema ranges satisfies),
 * dead-end (warn: no choices and no @end), unreachable (warn: no route from the start).
 */
export function lint(story: Story, schema: StateSchema): Diagnostic[] {
  throw new Error("not implemented")
}
