import type { Cond, Effect, GameState, StateSchema } from "./types"

/** Parse "a >= 1 and (mood == SURGE or not b)". Bare words on the right are enum values. */
export function parseCond(src: string): Cond {
  throw new Error("not implemented")
}

/** Inverse of parseCond. parseCond(formatCond(c)) deep-equals c. */
export function formatCond(cond: Cond): string {
  throw new Error("not implemented")
}

export function evalCond(cond: Cond, state: GameState): boolean {
  throw new Error("not implemented")
}

/** Parse "irk += 35, energy -= 8, mood = SURGE". "-=" becomes add with a negative amount. */
export function parseEffects(src: string): Effect[] {
  throw new Error("not implemented")
}

export function formatEffects(effects: Effect[]): string {
  throw new Error("not implemented")
}

/** Apply effects and clamp numbers to the schema range. Returns a new object. */
export function applyEffects(state: GameState, effects: Effect[], schema: StateSchema): GameState {
  throw new Error("not implemented")
}

/** The initial value of each variable: decl.initial, else min (number/int, default 0), false, or the first enum value. */
export function initialState(schema: StateSchema): GameState {
  throw new Error("not implemented")
}
