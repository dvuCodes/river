import { normalizeRel } from "../review/review"

/**
 * A concept job owns one folder, concepts/<conceptId>/, relative to the project root. The agent writes
 * one script, draw.gd, or up to five options, draw_a.gd..draw_e.gd. River writes each approved render
 * next to its script: concept.png, or concept_<v>.png for a variant.
 */
export const CONCEPT_VARIANTS = ["a", "b", "c", "d", "e"] as const
export type ConceptVariant = (typeof CONCEPT_VARIANTS)[number]

const suffix = (variant?: string) => (variant ? `_${variant}` : "")

/** draw.gd, or draw_<v>.gd. */
export const conceptScriptName = (variant?: string) => `draw${suffix(variant)}.gd`
/** The accepted render beside the script: concept.png, or concept_<v>.png. */
export const conceptRenderName = (variant?: string) => `concept${suffix(variant)}.png`
/** The pending render, in .river/jobs/<jobId>/: render.png, or render_<v>.png. */
export const jobRenderName = (variant?: string) => `render${suffix(variant)}.png`
/** The agent's one-line caption for a script, beside it in the job's worktree (never committed): caption.txt, or caption_<v>.txt. */
export const conceptCaptionName = (variant?: string) => `caption${suffix(variant)}.txt`

/** Which script a file name is: {} for draw.gd, { variant: "a" } for draw_a.gd, undefined for any other name. */
export function parseConceptScriptName(name: string): { variant?: ConceptVariant } | undefined {
  if (name === "draw.gd") return {}
  const v = /^draw_([a-e])\.gd$/.exec(name)?.[1] as ConceptVariant | undefined
  return v ? { variant: v } : undefined
}

const SAFE_ID = /^[A-Za-z0-9_-]{1,64}$/
const SAFE_SEGMENT = /^[A-Za-z0-9._-]+$/
/** Device names Windows reserves, with any extension: writing "nul.txt" goes nowhere, "con" can hang. */
const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i

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
 * concepts/<conceptId>/, use plain names, and a script must be draw.gd or draw_a.gd..draw_e.gd
 * directly in that folder. Returns the normalised path; throws a message the agent can act on.
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
  const names = rel.slice(folder.length + 1).split("/")
  // A leading dot makes .git or .gitattributes; Windows drops a trailing dot, so "x.gd." would land as a second script.
  if (names.some((n) => n.startsWith(".") || n.endsWith("."))) return deny("names may not start or end with '.'")
  if (names.some((n) => WINDOWS_RESERVED.test(n))) return deny("CON, PRN, AUX, NUL, COM1-9 and LPT1-9 are reserved names on Windows, with any extension")
  if (rel.toLowerCase().endsWith(".gd") && !(names.length === 1 && parseConceptScriptName(names[0]!))) {
    return deny(`the only scripts are ${conceptPath(conceptId, "draw.gd")}, or up to five options ${conceptPath(conceptId, "draw_a.gd")}..draw_e.gd`)
  }
  return rel
}
