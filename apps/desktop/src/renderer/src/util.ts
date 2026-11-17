import { useEffect } from "react"
import type { ViewId } from "../../shared/api"

export const isSmoke = new URLSearchParams(window.location.search).get("smoke") === "1"

/** In smoke mode, tell main this view has rendered (after layout settles) so it can capture. */
export function useSmokeReady(view: ViewId, ready: boolean): void {
  useEffect(() => {
    if (!isSmoke || !ready) return
    let cancelled = false
    requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        setTimeout(() => {
          if (!cancelled) window.river.smokeReady(view)
        }, 250)
      }),
    )
    return () => {
      cancelled = true
    }
  }, [view, ready])
}

/** IPC errors arrive as "Error invoking remote method 'x': Error: message". Keep the message. */
export function errorText(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err)
  return raw.replace(/^Error invoking remote method '[^']+': (Error: )?/, "")
}

export function cx(...parts: (string | false | null | undefined)[]): string {
  return parts.filter(Boolean).join(" ")
}

/** Prose for display: drop choice-only lines, and turn inline [[links]] into their labels. */
export function prose(text: string): string[] {
  return text
    .split(/\r?\n/)
    .filter((l) => !/^\s*\[\[[^\]]*\]\]/.test(l))
    .join("\n")
    .replace(/\[\[(.+?)\]\]/g, (_m, inner: string) => {
      if (inner.includes("->")) return inner.slice(0, inner.indexOf("->"))
      if (inner.includes("<-")) return inner.slice(inner.indexOf("<-") + 2)
      if (inner.includes("|")) return inner.slice(0, inner.indexOf("|"))
      return inner
    })
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter(Boolean)
}

export function shortTime(iso: string): string {
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })
}

/** Core's CLAIM_STALE_MS: a claim nobody refreshed for this long is abandoned (the renderer imports no core runtime). */
const CLAIM_STALE_MS = 30 * 60_000

/** The agent working a mark on its own (core liveClaim): it claimed the mark, follows no River job, and its claim is fresh. */
export function liveClaim(m: { status: string; claimedBy?: string; claimedAt?: string; jobId?: string }, now = Date.now()): string | undefined {
  if (m.status !== "working" || !m.claimedBy || m.jobId) return undefined
  const at = m.claimedAt ? Date.parse(m.claimedAt) : NaN
  return now - at < CLAIM_STALE_MS ? m.claimedBy : undefined
}
