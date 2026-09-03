// 用户手动覆盖层（持久化用户配置，可手改、mtime 热加载）：
// ① capability-rank.json：手动能力排名——models 数组顺序=能力降序（越靠前能力越强），
//    命中的模型在 baseScoreDynamic 最前端覆盖基础能力分（实时 api/内置快照/策展表全部让位）；
// ② pool-config.json：任务池选配——pools[lane]=参与该任务池（economy/mechanical/main/hard/vision/review）
//    的 modelId 清单，让各 lane 的候选模型体现差异化（手动配置优先于系统默认候选集）；
//    同一模型可重复进驻多个 lane；未配置/空清单的 lane 走系统默认决策（fail-open 全量）。
// [2026-09-03]-[随 /poolConfig、/modelRank 命令新增；[2026-09-03 语义修正]-[键从 provider 池改为
//  任务池 lane：选配的是「哪些模型参与哪个任务池」，不是 provider 进驻开关；写走 writeJsonAtomic 原子替换]
import { rmSync, statSync } from "node:fs"
import { normalizeModelKey } from "./capability"
import { LANE_ORDER, type Lane } from "./types"
import { paths, readJson, writeJsonAtomic, nowIso } from "./state"

export interface CapabilityRankFile {
  version: 1
  updated_at: string
  /** 归一化 modelId，顺序=能力降序（#1 最强） */
  models: string[]
}

export interface PoolConfigFile {
  version: 1
  updated_at: string
  /** 任务池 lane（economy/mechanical/main/hard/vision/review）→ 参与该池的 modelId 清单（归一化）；
   *  同一模型可出现在多个 lane；空清单=该 lane 未配置（走系统默认） */
  pools: Record<string, string[]>
}

// ---- mtime+size 键控缓存（同一进程内热加载：文件没变零解析，变了自动重读；测试可 reset）----
// [2026-09-03 复审P1-2]-[键加 size：mtime 毫秒粒度下同 ms 双写/手改仍会失效，size 双键消除绝大多数
//  竞态；本模块自身写入后立即 delete 缓存，主路径无竞态]

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

// ---- 校验（fail-open：结构坏=null=回退默认行为；条目逐条归一化去重）----

/** [2026-09-03 复审P2-3]-[排名/池清单共用的归一化（小写去 provider/变体段→去重保序）；语义解耦勿混入额外规则] */
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
    // 键=任务池 lane（未知键忽略；大小写容错）；空清单=未配置（fail-open 走系统默认）
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

// ---- 读取 ----

export function loadCapabilityRank(): CapabilityRankFile | null {
  return cachedRead(paths().capabilityRank, validateCapabilityRank)
}

/** 任务池选配全集（lane→参与模型集合；无文件/全坏/空=空对象=全部 lane 走系统默认） */
export function loadPoolConfig(): Record<string, ReadonlySet<string>> {
  const file = cachedRead(paths().poolConfig, validatePoolConfig)
  const out: Record<string, ReadonlySet<string>> = {}
  if (!file) return out
  for (const [lane, models] of Object.entries(file.pools)) {
    if (models.length === 0) continue // 防御：空清单=未配置
    out[lane] = new Set(models)
  }
  return out
}

/** 单任务池选配清单（非空集合；未配置=null=该 lane 不过滤走系统默认） */
export function poolAllowlist(lane: string): ReadonlySet<string> | null {
  return loadPoolConfig()[lane] ?? null
}

/** 手动覆盖摘要（横幅/doctor 展示：排名条数+配置了选配清单的任务池数） */
export function overrideSummary(): { rankModels: number; poolLanes: number } {
  const rank = loadCapabilityRank()
  return { rankModels: rank?.models.length ?? 0, poolLanes: Object.keys(loadPoolConfig()).length }
}

// ---- 写入（CLI/TUI 共用；原子替换+缓存失效；空清单=删除键/文件回归默认）----

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

/** 覆盖写单任务池选配清单（空清单=删除该 lane 键恢复系统默认；同模型可重复进驻多个 lane） */
export function writePoolConfig(lane: string, models: string[]): PoolConfigFile | null {
  const key = String(lane).trim().toLowerCase()
  if (!(LANE_ORDER as string[]).includes(key)) throw new Error(`未知任务池：${lane}（可选：${LANE_ORDER.join("/")}）`)
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

/** 删除单任务池配置（该 lane 恢复系统默认候选集；其余 lane 配置保留） */
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
