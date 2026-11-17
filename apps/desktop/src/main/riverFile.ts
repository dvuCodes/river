import { safePath, type Project } from "@river/core"

/**
 * The file a river-file://project/<path> URL names, or null. The path must stay inside the project root once links
 * are followed, so a symlink or junction in the project cannot serve a file outside it; the root itself is no file.
 */
export function riverFilePath(project: Pick<Project, "root">, url: string): string | null {
  try {
    const u = new URL(url)
    if (u.host !== "project") return null
    const rel = decodeURIComponent(u.pathname).replace(/^\/+/, "")
    return rel ? safePath(project, rel) : null
  } catch {
    return null
  }
}
