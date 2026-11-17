/**
 * The story model. A story is one Twee 3 file. River adds game rules to a
 * passage as `@` lines at the top of its text, ended by a line `--`:
 *
 *   :: Pond [encounter]
 *   @id pond
 *   @when energy >= 20
 *   --
 *   Ducks. Many ducks.
 *   [[Throw a treat->Treat]] @cost treats 1
 *   [[Hold the leash tight->Calm down]] @set excitement -= 30, bond -= 5 @when bond > 20
 *   [[Rest->Bench]] @set bond *= 0.5 @hint "Costs half the bond"
 *
 * Twine shows the `@` lines as plain text, so a round trip through Twine keeps them.
 *
 * One rule decides whether a choice is open, the same in play, paths, lint and for a game reading the export:
 * its `@when` holds, the player can pay every `@cost` (`@cost treats 1` needs `treats >= 1`), and the target
 * passage's `@when` holds on the state after the choice's `@cost` and `@set`. Then the target's `@set` runs.
 *
 * A passage tagged `interrupt` can be entered from any passage while its `@when` holds (the game decides when to
 * fire it). Its choices can target `@return` (`[[Back->@return]]`) to go back to the passage it interrupted.
 */

/** A position in a source file. Lines and columns start at 1. */
export interface SourceSpan {
  file: string
  line: number
  column: number
}

/** A comparison operator in a condition. */
export type CmpOp = "==" | "!=" | "<" | "<=" | ">" | ">="

/** A parsed condition. `@when` and choice `@when` both produce this. */
export type Cond =
  | { kind: "cmp"; variable: string; op: CmpOp; value: number | string | boolean }
  | { kind: "and"; terms: Cond[] }
  | { kind: "or"; terms: Cond[] }
  | { kind: "not"; term: Cond }

/**
 * One state change. `@set bond += 10` is { variable: "bond", op: "add", amount: 10 }; `-= 10` is add -10;
 * `*= 0.5` is mul 0.5 and `/= 4` is mul 0.25. Numbers clamp to the schema range after every change, and an int
 * variable drops the fraction a `mul` leaves (toward zero).
 */
export interface Effect {
  variable: string
  op: "add" | "mul" | "set"
  /** A number for number/int variables; a string for enum values; a boolean for bool. */
  amount: number | string | boolean
}

/** The choice target that means "go back to the passage this interrupt interrupted". */
export const RETURN_TARGET = "@return"

/** A link from a passage, with the River rules written after it on the same line. */
export interface Choice {
  /** Text the player sees. For `[[Feed the ducks->Ducks]]` this is "Feed the ducks". */
  label: string
  /** Target passage NAME as written in the link. Resolve with `resolveTarget`. */
  target: string
  /** Effects applied before the move, written `@cost treats 1` (means treats -= 1). The choice is open only while every cost can be paid. */
  cost: Effect[]
  /** Effects applied with the move, written `@set a += 1, b = 2`. */
  set: Effect[]
  /** The choice is open only when this is true. */
  when?: Cond
  /** A short line a game shows with the option, written `@hint "Costs one treat"`. */
  hint?: string
  span: SourceSpan
}

export interface Passage {
  /** Stable id from `@id`. If there is no `@id`, River uses the slug of the name. */
  id: string
  name: string
  tags: string[]
  /** Twee metadata JSON from the header, kept as is (position, size, other keys). */
  metadata: Record<string, unknown>
  /** The passage can be entered only when this is true. */
  when?: Cond
  /** Effects applied on entry, written `@set ...` above the `--` line. */
  onEnter: Effect[]
  /** `@end` marks an ending. An ending with no choices is not a dead end. */
  isEnding: boolean
  /** Prose after the `--` line (or the whole text if there are no rules), with choice lines kept. */
  text: string
  choices: Choice[]
  /** The full original passage text, for a lossless write. */
  rawText: string
  span: SourceSpan
  /** Verbatim source, set by parseTwee3. Lets writeTwee3 keep unchanged headers and spacing byte for byte. */
  source?: PassageSource
}

/** How one passage was written in the file. Fields that still match the passage are written back verbatim. */
export interface PassageSource {
  /** The header line as written, without its line ending. */
  header: string
  /** Index in `header` where the metadata JSON starts, or -1 when the header has none. */
  metaStart: number
  /** Body lines as written (escapes kept), up to the next header, with trailing blank lines. */
  body: string[]
  /** What the source parsed to. */
  name: string
  tags: string[]
  /** JSON.stringify of the parsed metadata. */
  metadataJson: string
  rawText: string
}

/** A StoryTitle or StoryData block as written. `index` is the number of passages before it in the file. */
export interface StoryBlockSource {
  kind: "title" | "data"
  lines: string[]
  index: number
}

/** How the story file was written, set by parseTwee3, so writeTwee3 can keep everything unchanged byte for byte. */
export interface StorySource {
  eol: "\n" | "\r\n"
  bom: boolean
  /** Lines before the first header. */
  preamble: string[]
  blocks: StoryBlockSource[]
  /** The title the source parsed to. */
  title: string
  /** JSON.stringify of { ifid, start, ...storyData } as parsed. */
  storyDataJson: string
}

export interface Story {
  /** From the StoryTitle passage. */
  title: string
  /** From StoryData. Uppercase v4 UUID. */
  ifid: string
  /** Start passage NAME, from StoryData "start", else a passage named "Start", else the first passage. */
  start: string
  /** Other StoryData keys, kept for a lossless write (format, format-version, tag-colors, zoom, ...). */
  storyData: Record<string, unknown>
  /** Passages in file order. Excludes StoryTitle and StoryData. Includes [script]/[stylesheet] passages. */
  passages: Passage[]
  file: string
  /** Verbatim source, set by parseTwee3, for a byte-preserving write. */
  source?: StorySource
}

/**
 * The declared type of one state variable, from the project's state file (stories/state.json).
 * `engine: true` marks a variable the game changes on its own while a passage is on screen (a timer, a meter):
 * paths and lint treat it as anywhere in its range at every passage, whatever the story set it to before.
 */
export type VarDecl = (
  | { type: "number"; min?: number; max?: number; initial?: number }
  | { type: "int"; min?: number; max?: number; initial?: number }
  | { type: "bool"; initial?: boolean }
  | { type: "enum"; values: string[]; initial?: string }
) & { engine?: boolean }

export type StateSchema = Record<string, VarDecl>

/** A value of game state at one moment. */
export type GameState = Record<string, number | string | boolean>

export type Severity = "error" | "warn" | "info"

/** One problem the parser or the linter found. */
export interface Diagnostic {
  severity: Severity
  /** A stable rule code, e.g. "broken-link", "never-true", "dead-end", "unreachable", "unknown-var", "type-mismatch", "duplicate-name", "parse". */
  code: string
  message: string
  passageId?: string
  span?: SourceSpan
}

/** One step of a path: the passage, and the choice taken to leave it (absent on the last step). */
export interface PathStep {
  passageId: string
  choiceIndex?: number
}

/** One route from the start to an ending or a dead end. */
export interface StoryPath {
  steps: PathStep[]
  /** The conditions checked along the route, in order, each written once: passage `@when`, choice `@when`, and what each `@cost` needs. */
  conditions: Cond[]
  /** "ending" if the last passage has @end; "dead-end" if it has no open route on and no @end; "loop" if it stops at a passage already on the route. */
  end: "ending" | "dead-end" | "loop"
  /**
   * False when no state within the schema ranges lets the player take the route: the conditions are checked
   * in order on the state the effects before them leave, with clamping, and `engine` variables free at every passage.
   */
  satisfiable: boolean
}

/** A route that starts at an interrupt passage. It can also end by taking a `@return` choice. */
export interface InterruptPath extends Omit<StoryPath, "end"> {
  end: StoryPath["end"] | "return"
}
