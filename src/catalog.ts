// 共享壳生成器（scripts/gen-shells.ts 与运行期超集注入共用）＋ models.dev 目录缓存
// [2026-08-29]-[壳矩阵静态→动态：抽取 gen-shells 命名/档位/家族逻辑为共享纯函数；
//  运行期超集与静态清单同源生成，gen:shells 产物语义不变]-
// [fail-open 铁律：目录拉取失败→陈旧缓存→内置 shells.json 隐式元数据→单档 off 降级，绝不阻塞注入]
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { paths, readJson, writeJsonAtomic, appendStatusLog } from "./state"
import manifestDefault from "./shells.json"
import type { ShellManifestEntry } from "./types"
import { poolForProviderId } from "./provider-config"

export type Effort = string
export interface EffortInfo { efforts: string[]; toggle: boolean; vision: boolean; /** [2026-09-01]-[models.dev status=deprecated：已轮换下架（免费模型日更，旧 -free 会被标记弃用）] */ deprecated?: boolean }
export interface ShellDefinition {
  name: string
  provider: string
  modelId: string
  pool: string
  quotaPool?: string
  family: string
  effort: Effort
  capability: "rw" | "ro"
  vision: boolean
  matrixKey: string // provider|modelId|effort
  degraded?: boolean // 无任何元数据源（仅运行期标记）
}

// ---- 命名与家族（与原 gen-shells 逐条一致）----
const SHORT: Record<string, string> = {
  "gpt-5.6-luna": "luna", "gpt-5.6-terra": "terra", "gpt-5.6-sol": "sol",
  "gpt-5.5": "55", "gpt-5.4": "54", "gpt-5.4-mini": "54mini", "gpt-5.4-nano": "54nano",
  "gpt-5.3-codex": "53codex", "gpt-5.2": "52", "gpt-5.2-codex": "52codex", "gpt-5-mini": "5mini",
  "claude-sonnet-5": "claude5", "claude-sonnet-4.6": "claude46", "claude-sonnet-4.5": "claude45", "claude-sonnet-4": "claude4",
  "claude-opus-5": "opus5", "claude-opus-4.8": "opus48", "claude-opus-4.7": "opus47", "claude-opus-4.6": "opus46",
  "claude-opus-4.5": "opus45", "claude-fable-5": "fable5", "claude-haiku-4.5": "haiku45",
  "gemini-3.1-pro-preview": "gem31pro", "gemini-3.5-flash": "gem35f", "gemini-3.6-flash": "gem36f", "gemini-3.7-flash": "gem37f",
  "grok-4.5": "grok45", "grok-4.6": "grok46",
  "kimi-k2.7-code": "k27code", "kimi-k3": "k3",
  "mai-code-1-flash-picker": "mai1fp", "mai-code-1.1-flash": "mai11f",
  "glm-5.3": "53", "glm-5.3-flash": "53f", "glm-5.3-highspeed": "53hs", "glm-5.2-highspeed": "52hs",
  "glm-5.2": "52", "glm-5.1": "51", "glm-5-turbo": "5t", "glm-4.7": "47",
  "glm-4.6v": "46v", "glm-5v-turbo": "5vt", "glm-4.5-air": "45air",
  "deepseek-v4-flash": "v4f", "deepseek-v4-flash-vision-exp": "v4fv", "deepseek-v4-pro": "v4p",
  "big-pickle": "bigpickle", "hy3-free": "hy3", "mimo-v2.5-free": "mimo",
  "muse-spark-1.2-contributor-free": "muse", "nemotron-3-ultra-free": "nemo3u", "nemotron-3.5-lightning-free": "nemo35l",
}
export function shortOf(modelId: string): string {
  if (SHORT[modelId]) return SHORT[modelId]
  if (modelId.endsWith("-fast") && SHORT[modelId.slice(0, -5)]) return `${SHORT[modelId.slice(0, -5)]}fast`
  return modelId.replace(/[^a-zA-Z0-9]/g, "")
}
export function familyOf(modelId: string): string {
  const m = /^(claude|gpt|gemini|grok|kimi|glm|deepseek|mai)/.exec(modelId)
  return m ? m[1] : modelId.split(/[^a-zA-Z]/)[0] || "unknown"
}
export function poolOf(provider: string): string {
  const pool = poolForProviderId(provider)
  if (pool) return pool
  return "zen"
}
const EFFORT_ORDER = ["off", "minimal", "low", "medium", "high", "xhigh", "max"]
export function canonEffort(e: string): string {
  return e === "none" ? "off" : e
}
export function sortEfforts(efforts: Iterable<string>): string[] {
  return [...new Set(efforts)].sort((a, b) => {
    const ia = EFFORT_ORDER.indexOf(a), ib = EFFORT_ORDER.indexOf(b)
    return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib)
  })
}

/** 稳定短哈希（FNV-1a→base36 前 4 位）：命名碰撞后缀与遍历顺序无关 */
export function stableHash(input: string): string {
  let h = 0x811c9dc5
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return (h >>> 0).toString(36).slice(0, 4).padStart(4, "0")
}

// ---- models.dev 解析（纯函数）----
export function parseModelsDevApi(data: Record<string, any>): Record<string, EffortInfo> {
  const out: Record<string, EffortInfo> = {}
  for (const [prov, p] of Object.entries(data)) {
    for (const [mid, m] of Object.entries((p as any)?.models ?? {})) {
      const opts = Array.isArray((m as any)?.reasoning_options) ? (m as any).reasoning_options : []
      const efforts: string[] = []
      let toggle = false
      for (const o of opts) {
        if (o?.type === "toggle") toggle = true
        if (o?.type === "effort" && Array.isArray(o.values)) {
          for (const v of o.values) efforts.push(String(v))
        }
      }
      const modalIn = Array.isArray((m as any)?.modalities?.input) ? (m as any).modalities.input : []
      out[`${prov}/${mid}`] = {
        efforts,
        toggle,
        vision: (m as any)?.attachment === true || modalIn.includes("image"),
        ...( (m as any)?.status === "deprecated" ? { deprecated: true } : {} ),
      }
    }
  }
  return out
}

/** 直连拉取（脚本用；运行期走 loadCatalog 缓存） */
export async function fetchModelsDevIndex(etag?: string | null): Promise<{ index: Record<string, EffortInfo>; etag: string | null; notModified: boolean }> {
  const res = await fetch("https://models.dev/api.json", {
    headers: { Accept: "application/json", "User-Agent": "opencode-switchman/0.1", ...(etag ? { "If-None-Match": etag } : {}) },
    signal: AbortSignal.timeout(20_000),
  })
  if (res.status === 304) return { index: {}, etag: etag ?? null, notModified: true }
  if (!res.ok) throw new Error(`models.dev HTTP ${res.status}`)
  const index = parseModelsDevApi(await res.json() as Record<string, any>)
  return { index, etag: res.headers.get("etag"), notModified: false }
}

// ---- 状态目录缓存（ETag＋TTL 24h；失败用陈旧缓存）----
export const CATALOG_TTL_MS = 24 * 3600_000
interface CatalogCache { fetched_at: number; etag: string | null; index: Record<string, EffortInfo> }

export interface CatalogResult { index: Record<string, EffortInfo>; status: "ok" | "stale" | "none"; etag: string | null }

export function loadCatalog(now = Date.now()): Promise<CatalogResult> {
  const p = paths().modelCatalog
  const cache = readJson<CatalogCache>(p)
  if (cache?.index && typeof cache.fetched_at === "number" && now - cache.fetched_at < CATALOG_TTL_MS) {
    return Promise.resolve({ index: cache.index, status: "ok", etag: cache.etag ?? null })
  }
  return fetchModelsDevIndex(cache?.etag ?? null).then(
    (r) => {
      if (r.notModified) {
        writeJsonAtomic(p, { ...(cache as CatalogCache), fetched_at: now } satisfies CatalogCache)
        return { index: (cache as CatalogCache).index, status: "ok" as const, etag: r.etag }
      }
      writeJsonAtomic(p, { fetched_at: now, etag: r.etag, index: r.index } satisfies CatalogCache)
      return { index: r.index, status: "ok" as const, etag: r.etag }
    },
    (exc) => {
      if (cache?.index) return { index: cache.index, status: "stale" as const, etag: cache.etag ?? null }
      appendStatusLog(`models.dev 目录不可用且无缓存（fail-open 降级）: ${exc}`)
      return { index: {}, status: "none" as const, etag: null }
    },
  )
}

/** 内置 shells.json 隐式元数据（模型→档位/视觉回退源；冷启动无网时优于单档降级） */
export function bundledModelIndex(): Record<string, EffortInfo> {
  const out: Record<string, EffortInfo> = {}
  for (const s of (manifestDefault as any).shells as ShellManifestEntry[]) {
    const key = `${s.provider}/${s.modelId}`
    const info = out[key] ?? { efforts: [], toggle: false, vision: s.vision }
    info.efforts.push(s.effort)
    if (s.effort === "off") info.toggle = true
    info.vision = info.vision || s.vision
    out[key] = info
  }
  return out
}

// [2026-09-01]-[超集保底改源：opencode 自带免费模型（OpenCode Zen＝models.dev opencode provider）
//  替代静态清单——免费模型随官方目录日更轮换，写死清单必然过期；免费判定＝id -free 后缀
//  ∪ 特例集（big-pickle 等官方自研免费模型无后缀），且 status≠deprecated（已轮换下架的旧
//  免费模型会标 deprecated，今日可用集通常只剩个位数）。走 loadCatalog 缓存（24h TTL＋stale 回退）。
//  仅影响壳存在性保底，可派发性仍由激活面（配置面∪会话）与凭证门控决定]
export const FLOOR_PROVIDER = "opencode" // OpenCode Zen
/** 无 -free 后缀但免费的官方模型（随目录核对的特例集） */
export const FLOOR_FREE_EXTRA = new Set(["big-pickle"])

/** 从 models.dev 目录索引提取免费保底模型全键（provider/modelId） */
export function freeFloorModels(index: Record<string, EffortInfo>): string[] {
  const prefix = `${FLOOR_PROVIDER}/`
  return Object.keys(index)
    .filter((k) => k.startsWith(prefix))
    .filter((k) => !index[k]?.deprecated)
    .map((k) => k.slice(prefix.length))
    .filter((mid) => mid.endsWith("-free") || FLOOR_FREE_EXTRA.has(mid))
    .filter((mid) => isConversational(mid))
    .map((mid) => `${FLOOR_PROVIDER}/${mid}`)
    .sort()
}

// ---- 超集展开（模型 × 档位 → 壳定义）----
export interface BuildShellsOpts {
  /** 静态 ro 标记集（gen-shells 用，按壳名） */
  roSet?: Set<string>
  /** 运行期：为每档追加 review 用 -ro 别名壳（共享 matrixKey＝共享探针组合） */
  roAliases?: boolean
  /** 无元数据模型 family=providerID（运行期降级口径；脚本路径保持 familyOf） */
  degradedFamilyByProvider?: boolean
  /** 标记 degraded 字段（仅运行期；gen:shells 产物不变） */
  markDegraded?: boolean
}

/** 短名碰撞＝全部成员追加稳定哈希后缀（与输入顺序无关；无碰撞时产物与原 gen-shells 逐字段一致） */
export function buildShells(models: string[], metaIndex: Record<string, EffortInfo>, opts: BuildShellsOpts = {}): ShellDefinition[] {
  const uniq = [...new Set(models)]
  const slashOf = (full: string) => full.indexOf("/")
  const group = new Map<string, string[]>()
  const shortMap = new Map<string, string>()
  for (const full of uniq) {
    const slash = slashOf(full)
    if (slash <= 0 || slash === full.length - 1) continue
    const short = shortOf(full.slice(slash + 1))
    shortMap.set(full, short)
    const gk = `${poolOf(full.slice(0, slash))}|${short}`
    const list = group.get(gk) ?? []
    list.push(full)
    group.set(gk, list)
  }
  for (const list of group.values()) {
    if (list.length <= 1) continue
    for (const full of list) shortMap.set(full, `${shortMap.get(full)}h${stableHash(full)}`)
  }

  const shells: ShellDefinition[] = []
  const seen = new Set<string>()
  for (const full of uniq) {
    const slash = slashOf(full)
    if (slash <= 0 || slash === full.length - 1) continue
    const provider = full.slice(0, slash)
    const modelId = full.slice(slash + 1)
    const pool = poolOf(provider)
    const info = metaIndex[full]
    // 档位装配：元数据（toggle→off；effort 值照收）→ 无元数据单档 off
    let efforts: string[] = ["off"]
    let vision = false
    if (info) {
      const vals = info.efforts.map(canonEffort).filter((e) => e !== "none")
      if (vals.length > 0 || info.toggle) {
        efforts = sortEfforts(info.toggle ? ["off", ...vals] : vals.length > 0 ? vals : ["off"])
      }
      vision = info.vision
    }
    const family = info || !opts.degradedFamilyByProvider ? familyOf(modelId) : provider
    for (const effort of efforts) {
      const name = `${pool === "deepseek" ? "ds" : pool}-mx-${shortMap.get(full)}-${effort}`
      if (seen.has(name)) continue
      seen.add(name)
      shells.push({
        name,
        provider,
        modelId,
        pool,
        family,
        effort,
        capability: opts.roSet?.has(name) ? "ro" : "rw",
        vision,
        matrixKey: `${provider}|${modelId}|${effort}`,
        ...(opts.markDegraded && !info ? { degraded: true } : {}),
      })
      // [2026-08-29]-[review -ro 别名壳：与 rw 壳共享探针组合（matrixKey 相同），探针按 key 去重]-
      if (opts.roAliases && !opts.roSet?.has(name)) {
        const alias = `${name}-ro`
        if (!seen.has(alias)) {
          seen.add(alias)
          shells.push({
            name: alias, provider, modelId, pool, family, effort,
            capability: "ro", vision, matrixKey: `${provider}|${modelId}|${effort}`,
            ...(opts.markDegraded && !info ? { degraded: true } : {}),
          })
        }
      }
    }
  }
  return shells
}

/** ShellDefinition → ShellManifestEntry（注册表/注入复用） */
export function toManifestEntry(d: ShellDefinition): ShellManifestEntry {
  return {
    name: d.name, pool: d.pool as ShellManifestEntry["pool"], provider: d.provider,
    modelId: d.modelId, effort: d.effort, family: d.family as ShellManifestEntry["family"],
    capability: d.capability, vision: d.vision, matrixKey: d.matrixKey,
  }
}

/** 排除 embedding 类模型（不可对话） */
export function isConversational(modelId: string): boolean {
  return !/embed|rerank|embedding/i.test(modelId)
}

/** 读原始文件内容（测试/调试用） */
export function readTextIfExists(path: string): string | null {
  try {
    return readFileSync(path, "utf8")
  } catch {
    return null
  }
}

export const catalogFileName = "model-catalog.json"
export function catalogPathOf(dir: string): string {
  return join(dir, catalogFileName)
}
