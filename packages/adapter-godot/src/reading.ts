import { KIT_FUNCTIONS } from "./kit"

/**
 * A reading aid for the review, not a check: it points the user at lines worth a slow read. A line it does not
 * mark is not known to only draw, and the review says so.
 */
export interface LineToRead {
  /** 1-based. */
  line: number
  /** Why to read it, for a tooltip: "uses execute, get". */
  reason: string
}

const KEYWORDS = "extends func var const for in if elif else while return pass and or not true false null void break continue as is"
const TYPES = "RefCounted Image Color Vector2 Vector2i Rect2 Rect2i int float bool String Array Dictionary PackedVector2Array PackedColorArray"
const MATH =
  "abs absf absi min max minf maxf mini maxi clamp clampf clampi lerp lerpf inverse_lerp smoothstep remap snapped move_toward " +
  "floor floorf floori ceil ceilf ceili round roundf roundi sqrt pow exp sin cos tan asin acos atan atan2 sign signf signi " +
  "fmod fposmod posmod wrapf wrapi deg_to_rad rad_to_deg randf randi randf_range randi_range range len PI TAU INF is_equal_approx"
const BARE = new Set(`${KEYWORDS} ${TYPES} ${MATH} Kit img draw`.split(" "))

/** Members of an Image, a Color, a vector, a rect, an array, or the RandomNumberGenerator Kit.rng returns. */
const MEMBERS = new Set(
  (
    "create fill fill_rect set_pixel set_pixelv get_pixel get_pixelv get_width get_height get_size blit_rect blend_rect blit_rect_mask " +
    "blend_rect_mask resize crop flip_x flip_y copy_from get_used_rect FORMAT_RGBA8 INTERPOLATE_NEAREST INTERPOLATE_BILINEAR " +
    "r g b a h s v x y lerp blend darkened lightened inverted from_hsv length normalized distance_to angle rotated dot " +
    "position size end intersection grow has_point floor ceil round abs ZERO ONE UP DOWN LEFT RIGHT " +
    "append push_back pop_back clear is_empty reverse sort " +
    "randf randi randf_range randi_range randfn seed"
  ).split(" "),
)

/** Names the script itself declares: variables, constants, loop variables, functions and their parameters. */
function declaredNames(code: string): Set<string> {
  const names = new Set<string>()
  for (const m of code.matchAll(/\b(?:var|const)\s+([A-Za-z_]\w*)|\bfor\s+([A-Za-z_]\w*)\s+in\b/g)) names.add((m[1] ?? m[2])!)
  for (const m of code.matchAll(/\bfunc\b\s*([A-Za-z_]\w*)?\s*\(([^)]*)\)/g)) {
    if (m[1]) names.add(m[1])
    for (const param of m[2]!.split(",")) {
      const name = /^\s*([A-Za-z_]\w*)/.exec(param)?.[1]
      if (name) names.add(name)
    }
  }
  return names
}

/** Each line's code with comments dropped and string contents emptied; a line whose string does not close is flagged. */
function codeLines(text: string): { code: string; unclosed: boolean }[] {
  const out: { code: string; unclosed: boolean }[] = []
  let code = ""
  let unclosed = false
  let quote: string | null = null
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!
    if (c === "\n") {
      if (quote && quote.length === 1) {
        unclosed = true
        code += quote
        quote = null
      }
      out.push({ code, unclosed })
      code = ""
      unclosed = false
      continue
    }
    if (quote) {
      if (c === "\\") i++
      else if (text.startsWith(quote, i)) {
        code += quote
        i += quote.length - 1
        quote = null
      }
      continue
    }
    if (c === "#") {
      while (i + 1 < text.length && text[i + 1] !== "\n") i++
      continue
    }
    if (c === '"' || c === "'") {
      quote = text.startsWith(c.repeat(3), i) ? c.repeat(3) : c
      code += quote
      i += quote.length - 1
      continue
    }
    code += c
  }
  out.push({ code, unclosed: unclosed || quote !== null })
  return out
}

/**
 * Lines that use a name outside Kit calls, the Image API, plain math and the script's own variables, or that
 * continue onto the next line after a dot. A reading aid for the review dialog; it proves nothing about the
 * lines it leaves unmarked.
 */
export function linesToRead(text: string): LineToRead[] {
  const lines = codeLines(text)
  const declared = declaredNames(lines.map((l) => l.code).join("\n"))
  const kit = new Set(KIT_FUNCTIONS)
  const marked: LineToRead[] = []
  lines.forEach(({ code, unclosed }, i) => {
    const unknown: string[] = []
    for (const m of code.matchAll(/\d[\w.]*|[A-Za-z_]\w*/g)) {
      const name = m[0]
      if (/^\d/.test(name)) continue
      const before = code.slice(0, m.index).trimEnd()
      if (before.endsWith(".")) {
        const owner = /([A-Za-z_]\w*)\s*\.$/.exec(before)?.[1]
        const known = owner === "Kit" ? kit.has(name) : owner === "Color" ? /^[A-Z_]+$/.test(name) || MEMBERS.has(name) : MEMBERS.has(name)
        if (!known) unknown.push(name)
      } else if (!BARE.has(name) && !declared.has(name)) unknown.push(name)
    }
    const reasons: string[] = []
    if (unknown.length > 0) reasons.push(`uses ${[...new Set(unknown)].join(", ")}`)
    if (/[.\\]\s*$/.test(code)) reasons.push("continues on the next line")
    if (unclosed) reasons.push("has a string that does not close")
    if (/[@$]/.test(code)) reasons.push("has an annotation or a node path")
    if (reasons.length > 0) marked.push({ line: i + 1, reason: reasons.join("; ") })
  })
  return marked
}
