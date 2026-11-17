import type { Diagnostic, Story } from "../story/types"

/** Parse Twine 2 published HTML or a Twine 2 archive (one or more tw-storydata elements). */
export function parseTwineHtml(html: string, file: string): { stories: Story[]; diagnostics: Diagnostic[] } {
  throw new Error("not implemented")
}

/** Write one story as a Twine 2 archive fragment (a hidden tw-storydata element) that the Twine library import accepts. */
export function writeTwineArchive(story: Story): string {
  throw new Error("not implemented")
}
