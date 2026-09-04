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
  /** Normalized modelId, order = capability descending (#1 strongest) */
  models: string[]
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
  return {
    version: 1,
    updated_at: typeof (v as { updated_at?: unknown }).updated_at === "string" ? String((v as { updated_at?: unknown }).updated_at) : "",
    models: normalizeModelList(raw),
  }
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

// ---- Writes (shared by CLI/TUI; atomic replacement + cache invalidation; empty list = delete key/file back to default) ----

export function writeCapabilityRank(models: string[]): CapabilityRankFile {
  const file = validateCapabilityRank({ models })!
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
