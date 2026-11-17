import {
  type Diagnostic,
  type Passage,
  type StateSchema,
  type Story,
  contentPassages,
  formatCond,
  formatEffects,
  resolveTarget,
} from "@river/core"
import type { PassageDTO, StoryDTO } from "../shared/api"

export function passageDTO(story: Story, p: Passage): PassageDTO {
  const dto: PassageDTO = {
    id: p.id,
    name: p.name,
    tags: p.tags,
    onEnter: formatEffects(p.onEnter),
    isEnding: p.isEnding,
    isStart: p.name === story.start,
    rawText: p.rawText,
    text: p.text,
    line: p.span.line,
    choices: p.choices.map((c) => {
      const target = resolveTarget(story, c.target)
      return {
        label: c.label,
        target: c.target,
        ...(target ? { targetId: target.id } : {}),
        ...(c.when ? { when: formatCond(c.when) } : {}),
        cost: formatEffects(c.cost),
        set: formatEffects(c.set),
      }
    }),
  }
  if (p.when) dto.when = formatCond(p.when)
  return dto
}

export function storyDTO(
  story: Story,
  diagnostics: Diagnostic[],
  positions: Record<string, [number, number]>,
  schema: StateSchema,
): StoryDTO {
  return {
    file: story.file,
    title: story.title,
    start: story.start,
    passages: contentPassages(story).map((p) => passageDTO(story, p)),
    diagnostics,
    positions,
    schema,
  }
}
