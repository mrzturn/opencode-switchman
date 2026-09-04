// [2026-09-04]-[English localization: translate comments and status messages; no logic change]
// Cost awareness (added in v1.1): models.dev pricing snapshot -> costScore (tiebreaker for equal compute_lane watermark scores)
// [TTL 24h + last-good cache; fetch failure fail-open degrades to no cost signal (tiebreaker auto-disables, ordering correctness unaffected)]
import { COSTS_TTL, paths, readJson, writeJsonAtomic, appendStatusLog } from "./state"

export interface CostIndex {
  scores: Record<string, number> // key=modelId (mostly unique across pools); value=(input+output)/2, $/1M tokens
  fetched_at: number
}

let cached: CostIndex | null = null

export function loadCosts(): CostIndex | null {
  if (cached && Date.now() / 1000 - cached.fetched_at < COSTS_TTL) return cached
  const disk = readJson<CostIndex>(paths().costs)
  if (disk && Date.now() / 1000 - disk.fetched_at < COSTS_TTL) {
    cached = disk
    return cached
  }
  return disk // return last-good even when expired; replaced after the background refresh
}

export async function refreshCosts(): Promise<void> {
  try {
    const res = await fetch("https://models.dev/api.json", {
      headers: { Accept: "application/json", "User-Agent": "opencode-switchman/0.1" },
      signal: AbortSignal.timeout(20_000),
    })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const data = (await res.json()) as Record<string, any>
    const scores: Record<string, number> = {}
    for (const p of Object.values(data)) {
      for (const [mid, m] of Object.entries((p as any)?.models ?? {})) {
        const cost = (m as any)?.cost
        if (cost && typeof cost.input === "number" && typeof cost.output === "number") {
          const score = (cost.input + cost.output) / 2
          if (!(mid in scores) || score < scores[mid]) scores[mid] = score // for duplicates keep the cheaper one
        }
      }
    }
    cached = { scores, fetched_at: Date.now() / 1000 }
    writeJsonAtomic(paths().costs, cached)
  } catch (exc) {
    appendStatusLog(`cost snapshot refresh failed (keeping stale data): ${exc}`)
  }
}

/** lane costs callback: null when no data (tiebreaker disabled, ordering falls back to the watermark primary order) */
export function costOf(modelId: string): number | null {
  const idx = loadCosts()
  const v = idx?.scores[modelId]
  return typeof v === "number" ? v : null
}

export function costsStale(): boolean {
  const idx = loadCosts()
  return !idx || Date.now() / 1000 - idx.fetched_at >= COSTS_TTL
}
