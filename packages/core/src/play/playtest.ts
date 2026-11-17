import type { Choice, GameState, Passage, StateSchema, Story } from "../story/types"

export interface PlayStep {
  passageId: string
  /** State after the passage onEnter effects. */
  state: GameState
}

export interface Playtest {
  current(): Passage
  state(): GameState
  /** All choices of the current passage, with open = false when its @when fails. */
  choices(): { choice: Choice; index: number; open: boolean }[]
  /** Apply cost and set, move to the target, apply its onEnter. Throws if the choice is closed or broken. */
  choose(index: number): void
  /** Set one variable by hand (the playtest state panel). Checks the type against the schema. */
  setVar(name: string, value: number | string | boolean): void
  undo(): void
  history(): PlayStep[]
  isOver(): boolean
}

export function createPlaytest(story: Story, schema: StateSchema, opts?: { from?: string; state?: GameState }): Playtest {
  throw new Error("not implemented")
}
