// 动态能力分级（v1.4）：第三方权威指数 → capability.json（TTL 24h）→ baseScore 的 api 覆盖层
// [2026-08-31]-[策展表升级为动态分级：主源 Artificial Analysis Data API v2
//  （GET /api/v2/data/llms/models，x-api-key；evaluations.artificial_analysis_intelligence_index
//   等指数，容忍 intelligence_index/coding_index/agentic_index 短字段），备源 OpenRouter
//  （GET /api/v1/models?sort=coding-high-to-low，公开；intelligence/coding/agentic），
//  LMArena（api.wulong.dev ELO）仅可选交叉校验（log-only 不影响评分）]-
// [fail-open 铁律：拉取失败/离线/429 沿用 last-good 或回退 model-ranks 策展表，绝不阻塞委派；
//  匹配：api 精确 → api 最长前缀（≥4 字符防误配）→ 策展 exact/prefix/family/global 逐级回退]
// [评分链不变：total=base*effortFit*health*water*costBias*peak，仅 base 来源可切换；
//  tier 仍用 TIER_SCORE 折算（S=1.0/A=0.85/B=0.7/C=0.55），与策展口径可比、tier 分组序不变]
import { CAPABILITY_TTL, paths, readJson, writeJsonAtomic, appendStatusLog } from "./state"
import { baseScore, TIER_SCORE, type Tier } from "./model-ranks"
import bundledDefaultJson from "./capability-default.json"
import type { CapabilityOptions } from "./types"

export type CapabilitySourceName = "artificial-analysis" | "openrouter"

export interface CapabilityEntry {
  score: number // 指数优先级 intelligence > coding > agentic（0-100 口径）
  intelligence?: number | null
  coding?: number | null
  agentic?: number | null
}

export interface CapabilityThresholds { S: number; A: number; B: number }

export interface CapabilityIndex {
  source: CapabilitySourceName
  version: string | null // 决策日志追溯用（etag / 数据版本 / 派生日期）
  fetched_at: number // epoch seconds
  thresholds: CapabilityThresholds
  models: Record<string, CapabilityEntry> // key=normalizeModelKey(name)
  /** index=真实指数（绝对阈值口径）；rank=序位派生（quantile 口径） */
  score_kind?: "index" | "rank"
  /** [2026-08-31]-[随包内置默认排名快照标记（gen:capability 生成；离线/拉取失败回退用，随版本手动迭代）] */
  bundled?: boolean
  counts?: { models: number }
}

export type BaseSourceKind = "api" | "bundled" | "exact" | "prefix" | "family" | "global"

export interface DynamicBaseResult {
  score: number
  tier: Tier
  source: BaseSourceKind
  version: string | null // api/bundled 命中时非空（capability.json 实时版本 / bundled-xx 内置快照版本）
  matchedAs?: string // api/bundled 命中的第三方模型名（归一化后）
}

const DEFAULT_THRESHOLDS: CapabilityThresholds = { S: 62, A: 55, B: 45 }
const FETCH_TIMEOUT_MS = 20_000
const AA_BASE = "https://artificialanalysis.ai/api/v2"
const OR_BASE = "https://openrouter.ai/api/v1"
const LMARENA_URL = "https://api.wulong.dev/api/v1/leaderboard"
const MIN_PREFIX_LEN = 4

// ---- 纯函数层 ----

/** 模型键归一：小写 → 去 provider 前缀 → 去 "(High)"/"[04-14]" 变体段 → 非法字符折叠为 "-" */
export function normalizeModelKey(name: string): string {
  let s = String(name ?? "").toLowerCase().trim()
  if (s.includes("/")) s = s.slice(s.lastIndexOf("/") + 1)
  s = s.replace(/\([^)]*\)/g, " ").replace(/\[[^\]]*\]/g, " ")
  s = s.replace(/[^a-z0-9.]+/g, "-")
  return s.replace(/-+/g, "-").replace(/^[-.]+|[-.]+$/g, "")
}

function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null
}

/** 指数 → 档（S/A/B/C；score ≥ 阈值取高档） */
export function tierOfScore(score: number, th: CapabilityThresholds): Tier {
  if (score >= th.S) return "S"
  if (score >= th.A) return "A"
  if (score >= th.B) return "B"
  return "C"
}

/** 升序分位数（线性取整下标；scores 空返回 null） */
export function percentileOf(sortedAsc: number[], p: number): number | null {
  if (sortedAsc.length === 0) return null
  const idx = Math.min(sortedAsc.length - 1, Math.max(0, Math.floor(p * (sortedAsc.length - 1))))
  return sortedAsc[idx]!
}

/** 阈值解析：绝对阈值（默认 62/55/45，须 S>A>B）或 "quantile"（p80/p60/p40） */
export function resolveThresholds(
  spec: CapabilityOptions["tierThresholds"],
  scores: number[],
): CapabilityThresholds {
  if (spec === "quantile") {
    const asc = [...scores].sort((a, b) => a - b)
    const s80 = percentileOf(asc, 0.8) ?? DEFAULT_THRESHOLDS.S
    const s60 = percentileOf(asc, 0.6) ?? DEFAULT_THRESHOLDS.A
    const s40 = percentileOf(asc, 0.4) ?? DEFAULT_THRESHOLDS.B
    return s80 > s60 && s60 > s40 ? { S: s80, A: s60, B: s40 } : DEFAULT_THRESHOLDS
  }
  const t = {
    S: num(spec?.S) ?? DEFAULT_THRESHOLDS.S,
    A: num(spec?.A) ?? DEFAULT_THRESHOLDS.A,
    B: num(spec?.B) ?? DEFAULT_THRESHOLDS.B,
  }
  return t.S > t.A && t.A > t.B ? t : DEFAULT_THRESHOLDS
}

function firstIndex(...vals: Array<number | null | undefined>): number | null {
  for (const v of vals) if (typeof v === "number") return v
  return null
}

export interface ParsedSource {
  models: Record<string, CapabilityEntry>
  versionHint: string | null
  /** index=真实指数字段（AA 恒为 index）；rank=按 sort 序位派生百分位分（OR 公开源无指数字段时的回退） */
  scoreKind: "index" | "rank"
}

/** AA v2 响应解析（data[]；evaluations 长短字段双兼容；name/slug/id 三级取名） */
export function parseAaModels(json: unknown): ParsedSource {
  const arr = Array.isArray((json as any)?.data) ? (json as any).data : Array.isArray(json) ? json : []
  const models: Record<string, CapabilityEntry> = {}
  let versionHint: string | null = null
  for (const m of arr) {
    const rawName = String(m?.name ?? m?.slug ?? m?.id ?? "")
    const ev = m?.evaluations ?? m ?? {}
    const intelligence = firstIndex(
      num(ev.artificial_analysis_intelligence_index), num(ev.intelligence_index),
    )
    const coding = firstIndex(
      num(ev.artificial_analysis_coding_index), num(ev.coding_index),
    )
    const agentic = firstIndex(
      num(ev.artificial_analysis_agentic_index), num(ev.agentic_index),
    )
    const score = firstIndex(intelligence, coding, agentic)
    const key = normalizeModelKey(rawName)
    if (!key || score === null) continue
    models[key] = { score, intelligence, coding, agentic }
    const rel = String(m?.release_date ?? m?.last_updated ?? m?.updated_at ?? "")
    if (rel && rel > (versionHint ?? "")) versionHint = rel
  }
  return { models, versionHint, scoreKind: "index" }
}

/**
 * OpenRouter /models 响应解析（data[]；id="vendor/model" 去 provider）。
 * [2026-08-31]-[公开源实测无 intelligence/coding/agentic 字段：有则用真实指数（scoreKind=index）；
 *  无则按 sort=coding-high-to-low 序位派生百分位分（首名 100 线性降至末名 0，scoreKind=rank，
 *  阈值层强制 quantile 分位映射——序即 coding 序，规格允许的分位数映射路径）]
 */
export function parseOpenRouterModels(json: unknown): ParsedSource {
  const arr = Array.isArray((json as any)?.data) ? (json as any).data : Array.isArray(json) ? json : []
  let versionHint: string | null = null
  let maxCreated: number | null = null
  const indexed: Array<{ key: string; entry: CapabilityEntry; created: number | null }> = []
  arr.forEach((m: any, i: number) => {
    const rawName = String(m?.id ?? m?.name ?? "")
    const key = normalizeModelKey(rawName)
    const intelligence = num(m?.intelligence)
    const coding = num(m?.coding)
    const agentic = num(m?.agentic)
    const score = firstIndex(intelligence, coding, agentic)
    const created = num(m?.created)
    if (created !== null && (maxCreated === null || created > maxCreated)) maxCreated = created
    if (!key || score === null) return
    indexed.push({ key, entry: { score, intelligence, coding, agentic }, created })
  })
  const models: Record<string, CapabilityEntry> = {}
  if (indexed.length > 0) {
    for (const { key, entry } of indexed) {
      if (!(key in models)) models[key] = entry
    }
    return { models, versionHint: maxCreated !== null ? String(maxCreated) : null, scoreKind: "index" }
  }
  const n = arr.length
  arr.forEach((m: any, i: number) => {
    const key = normalizeModelKey(String(m?.id ?? m?.name ?? ""))
    if (!key || key in models) return
    // 序位百分位分：首名 100 → 末名 0 线性（与 quantile 阈值 p80/p60/p40 配套＝top20% S / 次20% A / 次20% B / 其余 C）
    const score = n > 1 ? Math.round((1 - i / (n - 1)) * 1000) / 10 : 100
    models[key] = { score }
  })
  return { models, versionHint: maxCreated !== null ? String(maxCreated) : null, scoreKind: "rank" }
}

// ---- 缓存层（内存 + capability.json；dir 键控防测试沙箱串味；last-good 永不过期丢弃）----

let mem: { dir: string; idx: CapabilityIndex | null } | null = null

function validIndex(v: unknown): v is CapabilityIndex {
  const o = v as CapabilityIndex
  return Boolean(
    o && typeof o === "object" &&
    (o.source === "artificial-analysis" || o.source === "openrouter") &&
    typeof o.fetched_at === "number" &&
    o.thresholds && typeof o.thresholds.S === "number" &&
    typeof o.thresholds.A === "number" && typeof o.thresholds.B === "number" &&
    o.models && typeof o.models === "object" && !Array.isArray(o.models),
  )
}

/** 测试钩子：清内存缓存（外部改写 capability.json 后重读盘） */
export function resetCapabilityCache(): void {
  mem = null
}

export function loadCapability(): CapabilityIndex | null {
  const dir = paths().dir
  if (mem?.dir === dir) return mem.idx
  const disk = readJson<CapabilityIndex>(paths().capability)
  mem = { dir, idx: validIndex(disk) ? disk : null }
  return mem.idx
}

export function capabilityStale(): boolean {
  const idx = loadCapability()
  return !idx || Date.now() / 1000 - idx.fetched_at >= CAPABILITY_TTL
}

// [2026-08-31]-[随包内置默认排名快照：gen:capability 生成（官方排名固化，随版本手动迭代）；
//  仅在实时缓存（capability.json）缺失/无效时回退启用——离线全新安装也有可用排名]
let bundledCache: CapabilityIndex | null | undefined

export function loadBundledCapability(): CapabilityIndex | null {
  if (bundledCache !== undefined) return bundledCache
  const v = bundledDefaultJson as unknown as CapabilityIndex
  bundledCache = validIndex(v) ? { ...v, bundled: true } : null
  if (bundledCache === null) appendStatusLog("内置能力排名快照损坏（跳过，回退策展表）")
  return bundledCache
}

/** 指定能力索引的纯匹配，生成期可复用随包快照而不读取运行期状态。 */
export function baseScoreFromCapabilityIndex(modelId: string, idx: CapabilityIndex | null): DynamicBaseResult | null {
  if (!idx) return null
  const norm = normalizeModelKey(modelId)
  const hit = norm ? apiMatch(idx, norm) : null
  if (!hit) return null
  const tier = tierOfScore(hit.entry.score, idx.thresholds)
  return { score: TIER_SCORE[tier], tier, source: idx.bundled ? "bundled" : "api", version: idx.version, matchedAs: hit.matchedAs }
}

// ---- 拉取层（AA → OR 链式回退；失败沿用 last-good；全链 fail-open 不抛出）----

async function fetchJson(
  url: string, headers: Record<string, string>,
): Promise<{ json: unknown; etag: string | null }> {
  const res = await fetch(url, {
    headers: { Accept: "application/json", "User-Agent": "opencode-switchman/0.1", ...headers },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return { json: await res.json(), etag: res.headers.get("etag") ?? res.headers.get("x-data-version") }
}

function deriveVersion(prefix: string, etag: string | null, hint: string | null): string {
  if (etag) return etag.replace(/^"|"$/g, "").slice(0, 64) || `${prefix}-${hint ?? ""}`
  return `${prefix}-${hint ?? new Date().toISOString().slice(0, 10)}`
}

/**
 * 刷新能力指数缓存（探针同频调度；TTL 24h 内由 capabilityStale 门控跳过）。
 * 成功 → 内存+capability.json（source/version/fetched_at 供决策日志追溯）；
 * 失败（离线/429/解析空）→ 沿用 last-good 并留痕，绝不抛出。
 */
export async function refreshCapability(opts: CapabilityOptions): Promise<void> {
  try {
    const apiKey = opts.apiKey ?? process.env.ARTIFICIAL_ANALYSIS_API_KEY ?? process.env.AA_API_KEY
    const source = opts.source ?? "auto"
    const wantAa = source === "artificial-analysis" || (source === "auto" && Boolean(apiKey))
    const wantOr = source === "openrouter" || source === "auto"
    let parsed: ParsedSource | null = null
    let used: CapabilitySourceName | null = null
    let version: string | null = null
    if (wantAa && apiKey) {
      try {
        const r = await fetchJson(`${AA_BASE}/data/llms/models`, { "x-api-key": apiKey })
        parsed = parseAaModels(r.json)
        used = "artificial-analysis"
        version = deriveVersion("aa", r.etag, parsed.versionHint)
      } catch (exc) {
        appendStatusLog(`能力指数主源 AA 失败（${exc}）${wantOr ? "→转备源 OpenRouter" : "→沿用 last-good/内置默认排名"}`)
      }
    }
    if (!parsed && wantOr) {
      try {
        const orHeaders: Record<string, string> = {}
        if (!apiKey && process.env.OPENROUTER_API_KEY) orHeaders.Authorization = `Bearer ${process.env.OPENROUTER_API_KEY}`
        const r = await fetchJson(`${OR_BASE}/models?sort=coding-high-to-low`, orHeaders)
        parsed = parseOpenRouterModels(r.json)
        used = "openrouter"
        version = deriveVersion("or", r.etag, parsed.versionHint)
      } catch (exc) {
        appendStatusLog(`能力指数备源 OpenRouter 失败（${exc}）→沿用 last-good/内置默认排名`)
      }
    }
    if (!parsed || !used || Object.keys(parsed.models).length === 0) {
      // [2026-08-31]-[空解析留痕：静默 return 会让上游误以为刷新成功（冒烟实测踩过）]
      appendStatusLog(`能力指数解析为空（${used ?? "无源"}）→沿用 last-good/内置默认排名`)
      return
    }
    const scores = Object.values(parsed.models).map((e) => e.score)
    // rank 序位派生分与绝对阈值 62/55/45 口径不匹配：未显式配置阈值时强制 quantile 分位映射
    const spec = parsed.scoreKind === "rank" && opts.tierThresholds === undefined ? "quantile" : opts.tierThresholds
    const idx: CapabilityIndex = {
      source: used,
      version,
      fetched_at: Date.now() / 1000,
      thresholds: resolveThresholds(spec, scores),
      models: parsed.models,
      score_kind: parsed.scoreKind,
      counts: { models: scores.length },
    }
    mem = { dir: paths().dir, idx }
    writeJsonAtomic(paths().capability, idx)
    appendStatusLog(`能力指数已刷新：${used} ${scores.length} 模型（version=${version}）`)
    if (opts.lmarenaCheck) crossCheckLmarena(idx).catch(() => {})
  } catch (exc) {
    appendStatusLog(`能力指数刷新 fail-open（沿用 last-good/内置默认排名）: ${exc}`)
  }
}

/** LMArena（api.wulong.dev）可选校验：档序与 ELO 序一致性，仅日志告警不影响评分 */
export async function crossCheckLmarena(idx: CapabilityIndex): Promise<void> {
  try {
    const r = await fetchJson(LMARENA_URL, {})
    const body = r.json as any
    const arr = Array.isArray(body) ? body
      : Array.isArray(body?.data) ? body.data
        : Array.isArray(body?.leaderboard) ? body.leaderboard
          : Array.isArray(body?.models) ? body.models : []
    const elo: Record<string, number> = {}
    for (const e of arr) {
      const name = e?.model ?? e?.model_name ?? e?.name
      const v = num(e?.elo ?? e?.score ?? e?.rating ?? e?.arena_elo)
      const key = normalizeModelKey(String(name ?? ""))
      if (key && v !== null) elo[key] = v
    }
    const both = Object.keys(idx.models).filter((k) => k in elo)
    if (both.length < 2) return
    const scores = Object.entries(idx.models)
    let agree = 0
    let pairs = 0
    for (let i = 0; i < scores.length; i++) {
      for (let j = i + 1; j < scores.length; j++) {
        const [ka, ea] = scores[i]!
        const [kb, eb] = scores[j]!
        if (!(ka in elo) || !(kb in elo)) continue
        pairs++
        if (Math.sign(ea.score - eb.score) === Math.sign(elo[ka]! - elo[kb]!)) agree++
      }
    }
    const rate = pairs > 0 ? (agree / pairs) * 100 : 0
    if (rate < 70) {
      appendStatusLog(`capability LMArena 校验：档序与 ELO 序一致率仅 ${rate.toFixed(0)}%（${both.length} 模型重叠）——数据源可能异常，建议人工核查`)
    }
  } catch (exc) {
    appendStatusLog(`capability LMArena 校验 fail-open（跳过）: ${exc}`)
  }
}

// ---- 评分接入层（scoreShell 唯一调用点；api 命中 → 策展表回退）----

function apiMatch(idx: CapabilityIndex, normKey: string): { entry: CapabilityEntry; matchedAs: string } | null {
  const exact = idx.models[normKey]
  if (exact) return { entry: exact, matchedAs: normKey }
  let best: { k: string; len: number } | null = null
  for (const k of Object.keys(idx.models)) {
    if (normKey.startsWith(k) && k.length >= MIN_PREFIX_LEN && (!best || k.length > best.len)) best = { k, len: k.length }
  }
  if (best) return { entry: idx.models[best.k]!, matchedAs: best.k }
  return null
}

/**
 * 动态 base 三级回退链：实时 api（capability.json）→ 随包内置默认排名（bundled 快照）→ 策展表。
 * api/bundled 命中时 score=TIER_SCORE[tierOfScore(指数)]（与策展同口径，tier 分组序不变）；
 * version 随数据版本透出供 routing-decisions.jsonl 追溯（bundled- 前缀=内置快照）。
 */
export function baseScoreDynamic(modelId: string): DynamicBaseResult {
  const idx = loadCapability() ?? loadBundledCapability()
  const fromIndex = baseScoreFromCapabilityIndex(modelId, idx)
  if (fromIndex) return fromIndex
  const fb = baseScore(modelId)
  return { ...fb, version: null }
}
