// [2026-09-04]-[English localization: translate CLI messages and comments; no logic change]
// User manual override layer (persisted user config, hand-editable, mtime hot-reloaded):
// ① capability-rank.json: manual capability ranking — the models array order = capability descending (higher = stronger);
//    matched models override the base capability score at the very front of baseScoreDynamic (realtime api/builtin snapshot/curated table all yield);
// ② pool-config.json: task-pool selection — pools[lane] = the modelId list participating in that task pool
//    (economy/mechanical/main/hard/vision/review), giving each lane a differentiated candidate set (manual config wins over the system default candidate set);
//    the same model may join multiple lanes; unconfigured/empty-list lanes use the system default decision (fail-open, full set).
// [2026-09-03]-[Added along with the /poolConfig(-chat), /modelRank(-chat) commands; [2026-09-03 semantics fix]-[keys changed from provider pools to
//  task-pool lanes: what is selected is "which models join which task pool", not provider join switches; writes go through writeJsonAtomic atomic replacement]
import { rmSync, statSync } from "node:fs"
import { normalizeModelKey } from "./capability"
import { LANE_ORDER, type Lane } from "./types"
import { paths, readJson, writeJsonAtomic, nowIso } from "./state"

export interface CapabilityRankFile {
  version: 1
  updated_at: string
  /** Normalized modelId, order = capability descending (#1 strongest); among manual entries it only breaks exact (tier, raw) ties */
  models: string[]
  /** [2026-09-10]-[interleaved ranking: per-entry anchored manual scores (tier + raw). Entries WITHOUT a score keep the
   *  legacy ladder semantics (linear percentile by array position), so hand-written/legacy files stay valid; a TUI move
   *  materializes the moved model's score between its merged-view neighbors, letting manual entries interleave with
   *  base-score models instead of floating as a block on top] */
  scores?: Record<string, RankScoreOverride>
}

/** Manual anchored score: tier drives the dispatch score (TIER_SCORE) and cross-tier order; raw (0-100-ish, 3 decimals)
 *  orders within the tier. null base raws are treated as 0 when anchoring. */
export interface RankScoreOverride {
  tier: "S" | "A" | "B" | "C"
  raw: number
}

export interface PoolConfigFile {
  version: 1
  updated_at: string
  /** Task-pool lane (economy/mechanical/main/hard/vision/review) → modelId list participating in that pool (normalized);
   *  the same model may appear in multiple lanes; empty list = lane unconfigured (system default applies) */
  pools: Record<string, string[]>
}

// ---- mtime+size keyed cache (hot-reload within one process: zero parsing while the file is unchanged, auto re-read on change; tests can reset) ----
// [2026-09-03 review P1-2]-[size added to the key: at millisecond mtime granularity, double writes/manual edits within the same ms can still go stale; the dual key of size eliminates
//  the vast majority of races; this module deletes the cache immediately after its own writes, so the main path has no race]

const mtimeCache = new Map<string, { mtimeMs: number; size: number; value: unknown }>()

export function resetUserOverridesCache(): void {
  mtimeCache.clear()
}

function cachedRead<T>(path: string, validate: (v: unknown) => T | null): T | null {
  let mtimeMs = 0
  let size = -1
  try {
    const st = statSync(path)
    mtimeMs = st.mtimeMs
    size = st.size
  } catch {
    mtimeCache.delete(path)
    return null
  }
  const hit = mtimeCache.get(path)
  if (hit && hit.mtimeMs === mtimeMs && hit.size === size) return hit.value as T | null
  const value = validate(readJson<unknown>(path))
  mtimeCache.set(path, { mtimeMs, size, value })
  return value
}

// ---- Validation (fail-open: bad structure = null = fall back to default behavior; entries normalized and deduped one by one) ----

/** [2026-09-03 review P2-3]-[Normalization shared by rank/pool lists (lowercase, strip provider/variant segments → dedupe keeping order); keep semantics decoupled, do not mix in extra rules] */
function normalizeModelList(raw: unknown): string[] {
  if (!Array.isArray(raw)) return []
  const seen = new Set<string>()
  const models: string[] = []
  for (const m of raw) {
    const key = normalizeModelKey(String(m ?? ""))
    if (!key || seen.has(key)) continue
    seen.add(key)
    models.push(key)
  }
  return models
}

export function validateCapabilityRank(v: unknown): CapabilityRankFile | null {
  if (!v || typeof v !== "object" || Array.isArray(v)) return null
  const raw = (v as { models?: unknown }).models
  if (!Array.isArray(raw)) return null
  const models = normalizeModelList(raw)
  const file: CapabilityRankFile = {
    version: 1,
    updated_at: typeof (v as { updated_at?: unknown }).updated_at === "string" ? String((v as { updated_at?: unknown }).updated_at) : "",
    models,
  }
  // [2026-09-10]-[scores side-map: keep only entries whose key survived list normalization; drop malformed ones
  //  (fail-open = that entry falls back to the ladder); raw rounded to 3 decimals (tie-breaking granularity)]
  const rawScores = (v as { scores?: unknown }).scores
  if (rawScores && typeof rawScores === "object" && !Array.isArray(rawScores)) {
    const scores: Record<string, RankScoreOverride> = {}
    for (const [k, val] of Object.entries(rawScores as Record<string, unknown>)) {
      if (!models.includes(k) || !val || typeof val !== "object") continue
      const tier = (val as { tier?: unknown }).tier
      const num = (val as { raw?: unknown }).raw
      if (tier !== "S" && tier !== "A" && tier !== "B" && tier !== "C") continue
      if (typeof num !== "number" || !Number.isFinite(num)) continue
      scores[k] = { tier, raw: Math.round(num * 1000) / 1000 }
    }
    if (Object.keys(scores).length > 0) file.scores = scores
  }
  return file
}

export function validatePoolConfig(v: unknown): PoolConfigFile | null {
  if (!v || typeof v !== "object" || Array.isArray(v)) return null
  const raw = (v as { pools?: unknown }).pools
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null
  const pools: Record<string, string[]> = {}
  for (const [pool, list] of Object.entries(raw as Record<string, unknown>)) {
    // Key = task-pool lane (unknown keys ignored; case tolerant); empty list = unconfigured (fail-open, system default)
    const lane = String(pool).trim().toLowerCase() as Lane
    if (!(LANE_ORDER as string[]).includes(lane)) continue
    if (!Array.isArray(list)) continue
    const models = normalizeModelList(list)
    if (models.length === 0) continue
    pools[lane] = models
  }
  return {
    version: 1,
    updated_at: typeof (v as { updated_at?: unknown }).updated_at === "string" ? String((v as { updated_at?: unknown }).updated_at) : "",
    pools,
  }
}

// ---- Reads ----

export function loadCapabilityRank(): CapabilityRankFile | null {
  return cachedRead(paths().capabilityRank, validateCapabilityRank)
}

/** Task-pool selection universe (lane→participating model set; missing file/all bad/empty = empty object = every lane uses the system default) */
export function loadPoolConfig(): Record<string, ReadonlySet<string>> {
  const file = cachedRead(paths().poolConfig, validatePoolConfig)
  const out: Record<string, ReadonlySet<string>> = {}
  if (!file) return out
  for (const [lane, models] of Object.entries(file.pools)) {
    if (models.length === 0) continue // defensive: empty list = unconfigured
    out[lane] = new Set(models)
  }
  return out
}

/** Single task-pool selection list (non-empty set; unconfigured = null = lane not filtered, system default) */
export function poolAllowlist(lane: string): ReadonlySet<string> | null {
  return loadPoolConfig()[lane] ?? null
}

/** Manual override summary (banner/doctor display: rank entry count + number of task pools with selection lists configured) */
export function overrideSummary(): { rankModels: number; poolLanes: number } {
  const rank = loadCapabilityRank()
  return { rankModels: rank?.models.length ?? 0, poolLanes: Object.keys(loadPoolConfig()).length }
}

// ---- Pure manual-ranking move (shared semantics for the TUI /modelRank dialog: enter actions and ctrl+up/ctrl+down hotkeys) ----

/** [2026-09-10]-[interleaved move semantics: a move acts on the MERGED effective view (manual + base-score models sorted
 *  by capability), not just the manual sub-list. Moving model X one spot gives X an anchored manual score strictly
 *  between its new neighbors: tier from the neighbor it must stay below/above, raw at the midpoint (same tier) or a
 *  ±0.001 step (tier boundary / tie group) — decimals break ties, per the "nudge above the model below, below the model
 *  above" contract. delta 0 = pin to top; ±1 = one spot up/down in the merged view (unranked models materialize an
 *  anchored entry too — no more block-on-top ranking). Boundary hits (already #1 / already last) return null (no write).
 *  Pure: no I/O; returns the next models array (merged-view order, tie-break) + next scores map + new manual index,
 *  merged position and the anchored score] */
export interface RankMoveRow {
  key: string
  tier: string
  raw: number | null
}

export interface RankMoveResult {
  models: string[]
  scores: Record<string, RankScoreOverride>
  /** new index of the key within models */
  index: number
  /** new position of the key within the merged view */
  position: number
  /** the anchored manual score written for the key */
  score: RankScoreOverride
}

const SCORE_STEP = 0.001

function tierRankOf(tier: string): number {
  return tier === "S" ? 3 : tier === "A" ? 2 : tier === "B" ? 1 : 0
}

function rawOf(row: RankMoveRow): number {
  // comparator treats null raw as -Infinity within the tier; 0 is a safe anchor base for arithmetic
  return row.raw ?? 0
}

/** Anchored score strictly above `below` and strictly below `above` (null = unbounded top) in (tier, raw) key space */
function scoreAbove(below: RankMoveRow, above: RankMoveRow | null): RankScoreOverride {
  // `above` sorts weakly above `below` in the comparator, so its tier rank is >= — X always takes below's tier
  const tier = below.tier as "S" | "A" | "B" | "C"
  if (!above || tierRankOf(above.tier) > tierRankOf(below.tier)) {
    // different tiers (or no upper bound): stay in the lower tier, step above the neighbor (tier dominance keeps us below `above`)
    return { tier, raw: Math.round((rawOf(below) + SCORE_STEP) * 1000) / 1000 }
  }
  const lo = rawOf(below)
  const hi = rawOf(above)
  const mid = Math.round(((lo + hi) / 2) * 1000) / 1000
  if (mid > lo && mid < hi) return { tier, raw: mid }
  // gap too narrow (or degenerate): step past the lower neighbor; may overshoot exact-tie groups — inherent to score granularity
  return { tier, raw: Math.round((lo + SCORE_STEP) * 1000) / 1000 }
}

/** Anchored score strictly below `above` and strictly above `below` (null = unbounded bottom) */
function scoreBelow(above: RankMoveRow, below: RankMoveRow | null): RankScoreOverride {
  if (!below) return { tier: above.tier as "S" | "A" | "B" | "C", raw: Math.round((rawOf(above) - SCORE_STEP) * 1000) / 1000 }
  return scoreAbove(below, above)
}

export function applyRankMove(
  models: readonly string[],
  scores: Readonly<Record<string, RankScoreOverride>> | undefined,
  rows: readonly RankMoveRow[],
  key: string,
  delta: -1 | 0 | 1,
): RankMoveResult | null {
  const i = rows.findIndex((r) => r.key === key)
  if (i < 0) return null
  let score: RankScoreOverride
  let position: number
  if (delta === 0) {
    if (i === 0 && models[0] === key && scores?.[key]) {
      // already pinned at #1 with an anchored score: keep the entry but still return it (idempotent write)
      score = scores[key]!
    } else {
      score = scoreAbove(rows[0]!, null)
    }
    position = 0
  } else if (delta === -1) {
    if (i === 0) return null
    score = scoreAbove(rows[i - 1]!, rows[i - 2] ?? null)
    position = i - 1
  } else {
    const next = rows[i + 1]
    if (!next) return null
    score = scoreBelow(next, rows[i + 2] ?? null)
    position = i + 1
  }
  // models array = merged-view order of manual keys (stable tie-break + display); keys absent from the view keep their tail slots
  const manualKeys = new Set([...models, key])
  const without = rows.filter((_, idx) => idx !== i).map((r) => r.key)
  const reordered = [...without.slice(0, position), key, ...without.slice(position)].filter((k) => manualKeys.has(k))
  const seen = new Set(reordered)
  const nextModels = [...reordered, ...models.filter((k) => !seen.has(k))]
  const nextScores: Record<string, RankScoreOverride> = { ...(scores ?? {}) }
  nextScores[key] = score
  return { models: nextModels, scores: nextScores, index: nextModels.indexOf(key), position, score }
}

// ---- Writes (shared by CLI/TUI; atomic replacement + cache invalidation; empty list = delete key/file back to default) ----

export function writeCapabilityRank(models: string[], scores?: Record<string, RankScoreOverride>): CapabilityRankFile {
  const file = validateCapabilityRank({ models, scores })!
  writeJsonAtomic(paths().capabilityRank, { ...file, updated_at: nowIso() })
  mtimeCache.delete(paths().capabilityRank)
  return file
}

export function clearCapabilityRank(): void {
  try {
    rmSync(paths().capabilityRank, { force: true })
  } catch { /* fail-open */ }
  mtimeCache.delete(paths().capabilityRank)
}

/** Overwrite a single task-pool selection list (empty list = delete the lane key, back to system default; the same model may join multiple lanes) */
export function writePoolConfig(lane: string, models: string[]): PoolConfigFile | null {
  const key = String(lane).trim().toLowerCase()
  if (!(LANE_ORDER as string[]).includes(key)) throw new Error(`unknown task pool: ${lane} (options: ${LANE_ORDER.join("/")})`)
  const norm = normalizeModelList(models)
  const prev = cachedRead(paths().poolConfig, validatePoolConfig)
  const pools: Record<string, string[]> = { ...(prev?.pools ?? {}) }
  if (norm.length === 0) delete pools[key]
  else pools[key] = norm
  if (Object.keys(pools).length === 0) {
    try {
      rmSync(paths().poolConfig, { force: true })
    } catch { /* fail-open */ }
    mtimeCache.delete(paths().poolConfig)
    return null
  }
  const file: PoolConfigFile = { version: 1, updated_at: nowIso(), pools }
  writeJsonAtomic(paths().poolConfig, file)
  mtimeCache.delete(paths().poolConfig)
  return file
}

/** Delete a single task-pool config (the lane returns to the system default candidate set; other lanes keep their config) */
export function resetPoolConfig(lane: string): void {
  const key = String(lane).trim().toLowerCase()
  const prev = cachedRead(paths().poolConfig, validatePoolConfig)
  const pools: Record<string, string[]> = { ...(prev?.pools ?? {}) }
  delete pools[key]
  if (Object.keys(pools).length === 0) {
    try {
      rmSync(paths().poolConfig, { force: true })
    } catch { /* fail-open */ }
  } else {
    writeJsonAtomic(paths().poolConfig, { version: 1, updated_at: nowIso(), pools } satisfies PoolConfigFile)
  }
  mtimeCache.delete(paths().poolConfig)
}
