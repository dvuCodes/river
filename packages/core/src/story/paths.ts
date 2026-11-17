import type { Choice, GameState, Passage, StateSchema, Story, StoryPath } from "./types"

export interface PathOptions {
  /** Start passage name. Default: the story start. */
  from?: string
  /** Stop after this many paths. Default 500. */
  maxPaths?: number
}

/** Every route from the start to an ending, a dead end or a loop. A passage appears at most once per route. */
export function paths(story: Story, schema: StateSchema, opts?: PathOptions): StoryPath[] {
  throw new Error("not implemented")
}

/** Which choices of a passage are open in a given state. */
export function openChoices(passage: Passage, state: GameState): { choice: Choice; index: number; open: boolean }[] {
  throw new Error("not implemented")
}
