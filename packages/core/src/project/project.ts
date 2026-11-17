import type { Project } from "./types"
import type { Diagnostic, StateSchema, Story } from "../story/types"

/** Read and validate <root>/river.json. Applies defaults (editable globs). */
export function loadProject(root: string): Promise<Project> {
  throw new Error("not implemented")
}

/** Resolve rel inside the root. Throws if the result is outside the root (after resolving .. and symlinks). */
export function safePath(project: Project, rel: string): string {
  throw new Error("not implemented")
}

export function loadSchema(project: Project): Promise<StateSchema> {
  throw new Error("not implemented")
}

/** Story files (.twee, .tw) under manifest.stories, relative to the root with forward slashes, sorted. */
export function listStories(project: Project): Promise<string[]> {
  throw new Error("not implemented")
}

export function loadStory(project: Project, rel: string): Promise<{ story: Story; diagnostics: Diagnostic[] }> {
  throw new Error("not implemented")
}

/** Write the story file. Throws if rel is outside the root. */
export function saveStory(project: Project, rel: string, story: Story): Promise<void> {
  throw new Error("not implemented")
}
