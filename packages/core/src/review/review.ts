import type { ChangePlan, Project, ReviewStatus, ReviewThread } from "../project/types"

/** Threads from .river/review/*.json. With shotId, only that shot. */
export function listThreads(project: Project, shotId?: string): Promise<ReviewThread[]> {
  throw new Error("not implemented")
}

export function addThread(project: Project, target: ReviewThread["target"], author: string, text: string): Promise<ReviewThread> {
  throw new Error("not implemented")
}

export function reply(project: Project, threadId: string, author: string, text: string): Promise<ReviewThread> {
  throw new Error("not implemented")
}

export function setStatus(project: Project, threadId: string, status: ReviewStatus): Promise<ReviewThread> {
  throw new Error("not implemented")
}

/** Save a plan to .river/plans/<id>.json. A new plan has status "draft". Links it to its thread and sets the thread to "planned". */
export function savePlan(project: Project, plan: Omit<ChangePlan, "id" | "status" | "createdAt"> & { id?: string }): Promise<ChangePlan> {
  throw new Error("not implemented")
}

export function loadPlan(project: Project, planId: string): Promise<ChangePlan> {
  throw new Error("not implemented")
}

export function listPlans(project: Project): Promise<ChangePlan[]> {
  throw new Error("not implemented")
}

export function setPlanStatus(project: Project, planId: string, status: ChangePlan["status"]): Promise<ChangePlan> {
  throw new Error("not implemented")
}

/**
 * The implementer guard. Throws unless the plan is "approved", the file is one of the plan steps,
 * the file is inside the root, and it matches the manifest editable globs.
 */
export function assertEditAllowed(project: Project, plan: ChangePlan, rel: string): void {
  throw new Error("not implemented")
}
