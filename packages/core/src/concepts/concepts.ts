import { normalizeRel } from "../review/review"

/**
 * A concept job owns one folder, concepts/<conceptId>/, relative to the project root. The agent
 * writes draw.gd there; River writes concept.png (the approved render) next to it.
 */
export const CONCEPT_SCRIPT = "draw.gd"
export const CONCEPT_RENDER = "concept.png"

const SAFE_ID = /^[A-Za-z0-9_-]{1,64}$/
const SAFE_SEGMENT = /^[A-Za-z0-9._-]+$/

export function assertConceptId(conceptId: string): void {
  if (typeof conceptId !== "string" || !SAFE_ID.test(conceptId)) throw new Error(`river: invalid concept id ${JSON.stringify(conceptId)}`)
}

/** concepts/<conceptId>/<name>, or the folder itself without a name. */
export function conceptPath(conceptId: string, name?: string): string {
  assertConceptId(conceptId)
  return name ? `concepts/${conceptId}/${name}` : `concepts/${conceptId}`
}

/**
 * The guard for agent writes: `file` (relative to the project root) must be inside
 * concepts/<conceptId>/, use plain names, and the only script allowed is draw.gd.
 * Returns the normalised path; throws a message the agent can act on.
 */
export function assertConceptFile(conceptId: string, file: string): string {
  const folder = conceptPath(conceptId)
  const rel = normalizeRel(file)
  const deny = (why: string): never => {
    throw new Error(`river: cannot write ${JSON.stringify(file)}: ${why}`)
  }
  if (!rel) return deny("use a path relative to the project root, without '..'")
  if (!rel.startsWith(`${folder}/`)) return deny(`this job writes only inside ${folder}/`)
  if (!rel.split("/").every((seg) => SAFE_SEGMENT.test(seg))) return deny("use only letters, digits, '.', '_' and '-' in file names")
  if (rel.toLowerCase().endsWith(".gd") && rel !== conceptPath(conceptId, CONCEPT_SCRIPT)) {
    return deny(`one script per job: the only script is ${conceptPath(conceptId, CONCEPT_SCRIPT)}`)
  }
  return rel
}
