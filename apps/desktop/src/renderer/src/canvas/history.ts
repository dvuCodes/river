import type { Card, Edge, Mark } from "@river/core"

/**
 * One entity's part in an undoable step. A side is null when the entity does not exist on that side (before a create,
 * after a delete), the whole entity on the other side of a create or delete, and only the changed fields for an edit,
 * so undoing a move does not roll back what an agent wrote to the same file in the meantime.
 */
export type Change =
  | { kind: "card"; id: string; before: Partial<Card> | null; after: Partial<Card> | null }
  | { kind: "mark"; id: string; before: Partial<Mark> | null; after: Partial<Mark> | null }
  | { kind: "edge"; id: string; before: Partial<Edge> | null; after: Partial<Edge> | null }

export type Step = Change[]
export type Side = "before" | "after"

const LIMIT = 200

/** Undo and redo over board file writes. `apply` writes one side of a step; writes run one step at a time, in order. */
export function createHistory(apply: (step: Step, side: Side) => Promise<void>) {
  const done: Step[] = []
  const undone: Step[] = []
  let queue = Promise.resolve()
  /** The caller sees a failed write; the next step still runs. */
  const run = (step: Step, side: Side) => {
    const written = queue.then(() => apply(step, side))
    queue = written.catch(() => undefined)
    return written
  }
  /** Remember a step that has already been written. */
  const record = (step: Step) => {
    if (step.length === 0) return
    done.push(step)
    if (done.length > LIMIT) done.shift()
    undone.length = 0
  }
  return {
    record,
    /** Write a new step and remember it. */
    commit(step: Step) {
      record(step)
      return run(step, "after")
    },
    undo() {
      const step = done.pop()
      if (!step) return queue
      undone.push(step)
      return run(step, "before")
    },
    redo() {
      const step = undone.pop()
      if (!step) return queue
      done.push(step)
      return run(step, "after")
    },
  }
}

export type History = ReturnType<typeof createHistory>
