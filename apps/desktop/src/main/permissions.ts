import type { PermissionDecision } from "@river/agent"

const STOPPED: PermissionDecision = { behavior: "deny", message: "Turn stopped." }

/**
 * Permission requests waiting on the user, by tool-use id. An id names one request: a second one with an id already
 * waiting is denied at once and never shown, so a reused id (another local process on the approval pipe) cannot
 * replace or stall the real prompt.
 */
export class PermissionWaits {
  private readonly waiting = new Map<string, (decision: PermissionDecision) => void>()

  /** Wait for the user's answer to request `id`, denied when `signal` aborts first. `show` puts the prompt on screen. */
  wait(id: string, signal: AbortSignal, show: () => void): Promise<PermissionDecision> {
    if (this.waiting.has(id)) return Promise.resolve({ behavior: "deny", message: `River refused a second request with id ${id} while the first waits.` })
    if (signal.aborted) return Promise.resolve(STOPPED)
    return new Promise<PermissionDecision>((resolve) => {
      const settle = (decision: PermissionDecision) => {
        this.waiting.delete(id)
        signal.removeEventListener("abort", stop)
        resolve(decision)
      }
      const stop = () => settle(STOPPED)
      this.waiting.set(id, settle)
      signal.addEventListener("abort", stop, { once: true })
      show()
    })
  }

  /** The user's answer to request `id`. False when no such request is waiting. */
  answer(id: string, decision: PermissionDecision): boolean {
    const settle = this.waiting.get(id)
    settle?.(decision)
    return settle !== undefined
  }
}
