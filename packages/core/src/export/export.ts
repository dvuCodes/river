import type { Cond, Effect, StateSchema, Story } from "../story/types"

/** What a game engine loads. Version 1. Engines never parse Twee. */
export interface ExportedStory {
  schema: 1
  id: string
  title: string
  /** Start passage id. */
  start: string
  state: StateSchema
  passages: Record<string, {
    name: string
    tags: string[]
    when?: Cond
    onEnter: Effect[]
    ending: boolean
    /** Prose without rule lines and without link lines. */
    text: string
    choices: { label: string; to: string; cost: Effect[]; set: Effect[]; when?: Cond }[]
  }>
}

/** Throws if lint reports any error. Choice targets become passage ids. */
export function exportStory(story: Story, schema: StateSchema, id: string): ExportedStory {
  throw new Error("not implemented")
}
