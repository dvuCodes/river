import { type AgentModel, DEFAULT_MODEL, isValidModel } from "@river/agent"

/** The saved model, or the default when none is saved or the saved one is not a safe model id. */
export function storedModel(saved: unknown): AgentModel {
  return isValidModel(saved) ? saved : DEFAULT_MODEL
}

/** The saved self-check model, or undefined (the job's own model) when none is saved or it is not a safe model id. */
export function storedSelfCheckModel(saved: unknown): AgentModel | undefined {
  return isValidModel(saved) ? saved : undefined
}

/** A model the user typed or picked, trimmed. Throws unless it is a safe model id (KNOWN_MODELS or any custom id). */
export function parseModel(value: unknown): AgentModel {
  const t = typeof value === "string" ? value.trim() : value
  if (!isValidModel(t)) throw new Error(`Not a model id: ${JSON.stringify(String(value).slice(0, 80))}`)
  return t
}

/** A self-check model from the settings form: empty (or only spaces) clears it, else it must be a safe model id. */
export function parseSelfCheckModel(value: unknown): AgentModel | undefined {
  if (typeof value === "string" && value.trim() === "") return undefined
  return parseModel(value)
}
