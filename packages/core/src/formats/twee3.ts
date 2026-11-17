import type { Diagnostic, Story } from "../story/types"

/** Parse a Twee 3 file, including River @ rules. Never throws on bad input; it reports diagnostics. */
export function parseTwee3(text: string, file: string): { story: Story; diagnostics: Diagnostic[] } {
  throw new Error("not implemented")
}

/** Write a story as Twee 3. parseTwee3(writeTwee3(s)) gives the same passages, names, tags, text and storyData. */
export function writeTwee3(story: Story): string {
  throw new Error("not implemented")
}
