import type { AgentModel } from "@river/agent"

/** Display names for the models River knows (main sends the list as AgentStatus.knownModels). Others show their id. */
const MODEL_LABEL: Record<string, string> = {
  "claude-opus-5-5": "Opus 5.5",
  "claude-sonnet-5-5": "Sonnet 5.5",
  "claude-haiku-4-5": "Haiku 4.5",
}

export function modelLabel(id: AgentModel): string {
  return MODEL_LABEL[id] ?? id
}

/** The known models (empty until main's status arrives), plus `current` (a custom id set in Settings) when it is not one of them. */
export function modelOptions(known: readonly AgentModel[] | undefined, current?: AgentModel): AgentModel[] {
  const list = [...(known ?? [])]
  if (current && !list.includes(current)) list.push(current)
  return list
}
