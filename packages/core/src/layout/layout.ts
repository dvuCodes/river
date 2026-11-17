/** Card positions for one story, saved beside it as <story>.layout.json so story diffs show only words and rules. */
export interface StoryLayout {
  version: 1
  /** passage id -> [x, y] top-left in map units. */
  positions: Record<string, [number, number]>
}

/** "stories/a.twee" -> "stories/a.layout.json". */
export function layoutPathFor(storyFile: string): string {
  throw new Error("not implemented")
}

/** Read the layout. Missing file -> empty positions. */
export function loadLayout(storyFile: string): Promise<StoryLayout> {
  throw new Error("not implemented")
}

/** Write with sorted keys and 2-space indent, so diffs stay small. */
export function saveLayout(storyFile: string, layout: StoryLayout): Promise<void> {
  throw new Error("not implemented")
}
