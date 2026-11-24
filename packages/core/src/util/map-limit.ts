/** How many file reads River runs at once: enough to hide disk latency, few enough to stay clear of EMFILE. */
export const IO_CONCURRENCY = 24

/**
 * `fn` over every item, at most `limit` at a time. Results come back in input order. The first rejection
 * rejects the whole call (after the calls already started have settled), so catch per item inside `fn` when
 * one failure should not stop the rest.
 */
export async function mapLimit<T, R>(items: readonly T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length)
  const width = Math.max(1, Math.min(Math.floor(limit) || 1, items.length))
  let next = 0
  let failed: { err: unknown } | undefined
  const worker = async () => {
    while (!failed && next < items.length) {
      const i = next++
      try {
        out[i] = await fn(items[i]!, i)
      } catch (err) {
        failed ??= { err }
      }
    }
  }
  await Promise.all(Array.from({ length: width }, worker))
  if (failed) throw failed.err
  return out
}
