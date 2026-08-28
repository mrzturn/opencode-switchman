// 成本感知（v1.1 新增）：models.dev 计价快照 → costScore（compute_lane 水位同分 tiebreaker）
// [TTL 24h＋last-good 缓存；拉取失败 fail-open 降级为无成本信号（tiebreaker 自动失效，不影响排序正确性）]
import { COSTS_TTL, paths, readJson, writeJsonAtomic } from "./state"

export interface CostIndex {
  scores: Record<string, number> // key=modelId（跨池基本唯一）；值=(input+output)/2，$/1M tokens
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
  return disk // 过期也先返回 last-good，后台刷新后替换
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
          if (!(mid in scores) || score < scores[mid]) scores[mid] = score // 同名取便宜者
        }
      }
    }
    cached = { scores, fetched_at: Date.now() / 1000 }
    writeJsonAtomic(paths().costs, cached)
  } catch (exc) {
    console.error(`[opencode-switchman] 成本快照刷新失败（沿用旧数据）: ${exc}`)
  }
}

/** lane costs 回调：无数据返回 null（tiebreaker 失效，排序退回水位主序） */
export function costOf(modelId: string): number | null {
  const idx = loadCosts()
  const v = idx?.scores[modelId]
  return typeof v === "number" ? v : null
}

export function costsStale(): boolean {
  const idx = loadCosts()
  return !idx || Date.now() / 1000 - idx.fetched_at >= COSTS_TTL
}
