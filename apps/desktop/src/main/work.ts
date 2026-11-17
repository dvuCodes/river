/**
 * The agent turns this process runs (chat turns, concept drawings, looks at renders). Each runs with signal(own),
 * which aborts on its own stop or when the app quits, so no Claude process outlives River.
 */
export class AgentWork {
  private readonly quit = new AbortController()
  private readonly running = new Set<Promise<void>>()

  /** Aborts when `own` does or when stopAll runs; already aborted after stopAll. */
  signal(own?: AbortSignal): AbortSignal {
    return own ? AbortSignal.any([own, this.quit.signal]) : this.quit.signal
  }

  /** Keep `work` until it settles, so stopAll can wait for it. Returns it unchanged. */
  track<T>(work: Promise<T>): Promise<T> {
    const settled = work.then(
      () => undefined,
      () => undefined,
    )
    this.running.add(settled)
    void settled.then(() => this.running.delete(settled))
    return work
  }

  /** Abort every turn, and wait for them to end, at most `timeoutMs`. */
  async stopAll(timeoutMs: number): Promise<void> {
    this.quit.abort()
    let timer: NodeJS.Timeout | undefined
    const timeout = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, timeoutMs)
    })
    await Promise.race([Promise.allSettled([...this.running]), timeout])
    clearTimeout(timer)
  }
}
