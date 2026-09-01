// 模型评分引擎（纯函数核心）：显式加权评分 + 硬门 + tier 分组排序 + 决策日志
// [2026-08-29]-[把 computeLane 规则式排序升级为可追溯显式加权评分；
//  base（策展能力）压倒一切软系数：先按 tier 分组、组内再按乘积分排序]
// [2026-08-31]-[去厂商化编排：删 dsLast 池名分组；total 扩为
//  base×effortFit×health×water×costBias×peak×billingBoost×unknownPenalty——
//  billing 仅由用户 jsonc 显式声明驱动（subscription=1.0/api=0.85），未知组（能力分级
//  全链未命中的模型）同 tier 排已知之后；costBias 厂商规则已废除，恒 1.0 留作成本数据预留位]
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { paths, withPathLock, appendStatusLog } from "./state"
import type { Lane, Pool, Routing, ShellRegEntry } from "./types"
import { baseScoreDynamic } from "./capability"
import { CAPABILITY_LEVEL_RANK, TIER_RANK, UNKNOWN_PENALTY, capabilityLevelOf } from "./model-ranks"
import type { Tier } from "./model-ranks"
import { LANE_SPEC, isFallbackCandidate, isPrimaryCandidate } from "./lane-policy"

/** [2026-08-31]-[去厂商化：api 计费系数（subscription=1.0）；取代按池名写死的链尾/按量惩罚] */
export const BILLING_API_BOOST = 0.85
export { UNKNOWN_PENALTY }

// ---- 水位因子（调用方从 poolStates/quotaView 归一后注入；缺省=全 1.0 fail-open）----
export interface WaterFactor {
  /** GLM 5 小时窗利用率（0-100） */
  glmFiveHourPct?: number | null
  /** GLM 周额度利用率（0-100） */
  glmWeeklyPct?: number | null
  /** Copilot 剩余积分百分比（0-100） */
  copilotRemainingPct?: number | null
  /** Copilot 距重置天数 */
  copilotResetDays?: number | null
  /** routing 关闭时水位影响必须中性化。 */
  routing?: Partial<Record<Pool, boolean>>
}

export interface ScoreInput {
  modelId: string
  effort: string | null
  lane: Lane
  pool: Pool | string
  matrixStatus: string
  latencyMs: number | null
  /** [2026-08-31]-[peak 泛化：该壳 provider 的计费高峰是否活跃（任意 provider；原 glm 专属规则废除）] */
  peakActive: boolean
  immediate: boolean
  water: WaterFactor
  /** [2026-08-31]-[订阅计费系数：subscription=1.0/api=0.85（调用方从用户配置解析）；缺省 1.0] */
  billingBoost?: number
}

export interface ScoreBreakdown {
  base: number
  /** 第三方能力源的原始指数；tier 相同才参与排序。 */
  rawCapability?: number
  baseSource: string
  /** [2026-08-31]-[动态能力分级：api 命中时为 capability.json 数据版本（决策日志追溯）；策展回退为 null] */
  baseVersion?: string | null
  effortFit: number
  health: number
  water: number
  /** 恒 1.0（厂商规则已废除；预留给未来真实成本数据因子） */
  costBias: number
  peak: number
  /** [2026-08-31]-[订阅计费系数（subscription=1.0/api=0.85）] */
  billingBoost: number
  /** [2026-08-31]-[未知组系数：base 来源为 global 兜底时 0.75，否则 1.0] */
  unknownPenalty: number
  total: number
  tier: Tier
}

function clampWater(v: number): number {
  return Math.min(1.0, Math.max(0.6, v))
}

/** effortFit：复用 LANE_SPEC 序位，序位靠前越接近 1.0；不在亲和序位显著折损 */
function effortFitOf(lane: Lane, effort: string | null): number {
  const spec = LANE_SPEC[lane] ?? LANE_SPEC.main
  const idx = spec.efforts.indexOf(effort ?? "")
  if (idx < 0) return 0.6
  return Math.max(0.6, 1 - idx * 0.1)
}

/** health：ok=1.0 / strained=0.6；其余（unknown/missing 等）fail-open 视同 1.0 */
function healthOf(matrixStatus: string): number {
  return matrixStatus === "strained" ? 0.6 : 1.0
}

/** water：水位富余 1.0 线性降至 0.6；>90% 已在上游硬拦。
 *  [2026-08-31]-[去厂商化口径：池名仅作配额抓取数据面映射——有抓取器的 provider 才有水位数据，
 *  未知/自定义 provider 一律 fail-open 1.0；water 系数本身不承载任何厂商商务偏好] */
function waterOf(pool: string, w: WaterFactor): number {
  if (w.routing?.[pool as Pool] === false) return 1.0
  if (pool === "glm") {
    const pcts = [w.glmFiveHourPct, w.glmWeeklyPct].filter((v): v is number => typeof v === "number")
    if (pcts.length === 0) return 1.0
    // 「5h 窗与周额度取 min（水位因子）」＝取更吃紧的一档（利用率 max → 因子 min）
    const worst = Math.max(...pcts)
    return clampWater(1 - (worst / 90) * 0.4)
  }
  if (pool === "copilot") {
    const rem = w.copilotRemainingPct
    const days = w.copilotResetDays
    // [2026-08-29]-[复审P1-1修正：烧积分语义=「富余将作废」——rem>=20%（真富余）且临期(<7d)才提升 1.0；
    //  rem<20% 属吃紧（与 poolStates strained、routingAdvice「吃紧→改 glm」一致，不得反向提权）-
    //  此前 rem>0 的宽条件已回退]-
    if (typeof rem === "number" && rem >= 20 && typeof days === "number" && days < 7) return 1.0
    if (typeof rem !== "number") return 1.0
    return clampWater(1 - ((100 - rem) / 100) * 0.4)
  }
  return 1.0
}

/** costBias：恒 1.0——按池名写死的按量惩罚已废除（billingBoost 接管），预留给未来真实成本数据因子 */
function costBiasOf(): number {
  return 1.0
}

/** 单壳加权评分（纯函数；immediate 只影响排序不影响本函数乘积分）
 *  [2026-08-31]-[去厂商化：total=base*effortFit*health*water*costBias*peak*billingBoost*unknownPenalty；
 *  unknownPenalty 由 base 来源推导（global 兜底=未知组），billingBoost 由调用方注入] */
export function scoreShell(input: ScoreInput): ScoreBreakdown {
  const base = baseScoreDynamic(input.modelId)
  const effortFit = effortFitOf(input.lane, input.effort)
  const health = healthOf(input.matrixStatus)
  const water = waterOf(String(input.pool), input.water)
  const costBias = costBiasOf()
  const peak = input.peakActive ? 0.93 : 1.0
  const billingBoost = input.billingBoost ?? 1.0
  const unknownPenalty = base.source === "global" ? UNKNOWN_PENALTY : 1.0
  const total = base.score * effortFit * health * water * costBias * peak * billingBoost * unknownPenalty
  return {
    base: base.score,
    rawCapability: base.rawScore,
    baseSource: base.source,
    baseVersion: base.version,
    effortFit,
    health,
    water,
    costBias,
    peak,
    billingBoost,
    unknownPenalty,
    total,
    tier: base.tier,
  }
}

// ---- 排序候选（computeLane 已装配的形状）----
export interface Rankable {
  key: string
  modelId: string
  effort: string | null
  pool: Pool | string
  family: string | null
  capability: string | null
  vision: boolean | null
  matrixStatus: string
  latencyMs: number | null
}

export interface RankContext {
  lane: Lane
  immediate: boolean
  glmPeak: boolean
  water: WaterFactor
  routing?: Routing | null
  registry?: Record<string, ShellRegEntry> | null
  quotaExhausted?: Partial<Record<Pool, boolean>>
  routePolicy?: Partial<Record<Pool, { routing: boolean }>>
  retiredModels?: ReadonlySet<string>
  realFailedCombos?: ReadonlySet<string>
  producerFamily?: string | null
  modality?: string | null
  capability?: string | null
  /** [2026-08-29]-[复审P1-2(b)：v1.1「便宜者前」契约保留为同 tier 且 total 平局的 tiebreak] */
  costs?: ((modelId: string) => number | null) | null
  /** [2026-08-31]-[去厂商化：provider→订阅计费系数（subscription=1.0/api=0.85；调用方从用户 jsonc 解析）] */
  billingBoostOf?: (provider: string) => number
  /** [2026-08-31]-[去厂商化：provider→计费高峰活跃（任意 provider 的 peak 配置求值）] */
  peakOf?: (provider: string) => boolean
}

/** 硬门：矩阵 down（strained 非 down）/ 熔断 / 耗尽 / 退休 / 实调隔离 / 语义闸（与 computeLane 同源） */
function isGated(s: Rankable, ctx: RankContext): boolean {
  if (s.matrixStatus === "down") return true
  const registry = ctx.registry
  const shell = registry?.[s.key]
  if (shell && shell.status !== "enabled") return true
  const down = ctx.routing?.down_agents
  if (down && (s.key in down || (shell?.comboKey && shell.comboKey in down))) return true
  if (shell && ctx.retiredModels?.has(`${shell.provider}/${shell.modelId}`)) return true
  if (shell?.comboKey && ctx.realFailedCombos?.has(shell.comboKey)) return true
  if (shell && ctx.quotaExhausted?.[shell.pool as Pool] && ctx.routePolicy?.[shell.pool as Pool]?.routing !== false) return true
  if (ctx.lane === "review" && ctx.producerFamily && shell && String(shell.family) === String(ctx.producerFamily).toLowerCase()) return true
  if ((ctx.modality === "image" || ctx.modality === "vision") && shell && !shell.vision) return true
  if (ctx.capability === "rw" && shell?.capability === "ro") return true
  return false
}

/**
 * 硬门剔除 → 排序。immediate 只按 latency_ms 升序；normal 按 tier 分组、组内乘积分降序。
 * [2026-08-31]-[去厂商化：删 dsLast 池名分组——api/未知组由乘积系数自然沉底]
 * 返回 ranked（幸存者）+ breakdowns（key→明细，供决策日志追溯）。
 */
export function rankCandidates<T extends Rankable>(
  shells: readonly T[],
  ctx: RankContext,
): { ranked: T[]; breakdowns: Map<string, ScoreBreakdown> } {
  const breakdowns = new Map<string, ScoreBreakdown>()
  const survivors: T[] = []
  for (const s of shells) {
    if (isGated(s, ctx)) continue
    survivors.push(s)
    const shell = ctx.registry?.[s.key]
    breakdowns.set(s.key, scoreShell({
      modelId: s.modelId,
      effort: s.effort,
      lane: ctx.lane,
      pool: s.pool,
      matrixStatus: s.matrixStatus,
      latencyMs: s.latencyMs,
      peakActive: shell && ctx.peakOf ? Boolean(ctx.peakOf(shell.provider)) : (ctx.peakOf ? false : ctx.glmPeak && String(s.pool) === "glm"),
      immediate: ctx.immediate,
      water: ctx.water,
      billingBoost: shell && ctx.billingBoostOf ? ctx.billingBoostOf(shell.provider) : ctx.billingBoostOf ? BILLING_API_BOOST : 1.0,
    }))
  }
  // [2026-09-01]-[同级优先：同级幸存者存在时绝不让跨级项参与排序；只有本级全被硬门淘汰才回退。]
  const primary = survivors.filter((s) => isPrimaryCandidate(ctx.lane, baseScoreDynamic(s.modelId)))
  const fallbackPool = survivors.filter((s) => isFallbackCandidate(ctx.lane, baseScoreDynamic(s.modelId)))
  const scoreCompare = (a: T, b: T): number => {
    const ba = breakdowns.get(a.key)!
    const bb = breakdowns.get(b.key)!
    return bb.total - ba.total ||
      (bb.rawCapability ?? -Infinity) - (ba.rawCapability ?? -Infinity) ||
      (a.latencyMs ?? Number.POSITIVE_INFINITY) - (b.latencyMs ?? Number.POSITIVE_INFINITY)
  }
  const targetLevel = LANE_SPEC[ctx.lane].minimumLevel
  fallbackPool.sort((a, b) => {
    if (targetLevel === null) return scoreCompare(a, b)
    const levelOf = (s: T) => capabilityLevelOf(baseScoreDynamic(s.modelId).tier, baseScoreDynamic(s.modelId).source)
    const distance = (s: T) => Math.abs(CAPABILITY_LEVEL_RANK[levelOf(s)] - CAPABILITY_LEVEL_RANK[targetLevel])
    return distance(a) - distance(b) || scoreCompare(a, b)
  })
  survivors.length = 0
  survivors.push(...(primary.length > 0 ? primary : fallbackPool.slice(0, 2)))
  const inputOrder = new Map(survivors.map((s, i) => [s.key, i]))
  if (ctx.immediate) {
    survivors.sort((a, b) =>
      (a.latencyMs ?? Number.POSITIVE_INFINITY) - (b.latencyMs ?? Number.POSITIVE_INFINITY) ||
      (inputOrder.get(a.key) ?? 0) - (inputOrder.get(b.key) ?? 0))
  } else {
    const costOf = ctx.costs
    const costOfKey = (s: T): number => {
      const shell = ctx.registry?.[s.key]
      const v = costOf && shell ? costOf(shell.modelId) : null
      return typeof v === "number" ? v : Number.POSITIVE_INFINITY
    }
    survivors.sort((a, b) => {
        // 同级已耗尽时，回退必须从相邻等级开始，不能被通用 S/A/B/C 排序重新越级。
        if (targetLevel !== null) {
          const levelOf = (s: T) => capabilityLevelOf(baseScoreDynamic(s.modelId).tier, baseScoreDynamic(s.modelId).source)
          const distance = (s: T) => Math.abs(CAPABILITY_LEVEL_RANK[levelOf(s)] - CAPABILITY_LEVEL_RANK[targetLevel])
          const distanceDiff = distance(a) - distance(b)
          if (distanceDiff !== 0) return distanceDiff
        }
        const ba = breakdowns.get(a.key)!
      const bb = breakdowns.get(b.key)!
      return TIER_RANK[ba.tier] - TIER_RANK[bb.tier] ||
        bb.total - ba.total ||
        // tier 是跨档硬门；同档总分持平时再用真实能力指数，不能因统一映射到 TIER_SCORE 而平分。
        (bb.rawCapability ?? -Infinity) - (ba.rawCapability ?? -Infinity) ||
        costOfKey(a) - costOfKey(b) ||
        (inputOrder.get(a.key) ?? 0) - (inputOrder.get(b.key) ?? 0)
    })
  }
  return { ranked: survivors, breakdowns }
}

// ---- 决策日志（state/routing-decisions.jsonl；环形截断 200 行；fail-open + withPathLock）----
export interface DecisionCandidate extends ScoreBreakdown {
  name: string
}
export interface DecisionRecord {
  at: string
  lane: string
  candidates: DecisionCandidate[]
}

const MAX_DECISION_LINES = 200

/** 追加决策行（每 lane 一行），保留最近 200 行。异常仅 console.error，绝不阻塞主流程。 */
export function logDecision(records: DecisionRecord[]): Promise<void> {
  const p = paths().decisions
  return withPathLock(p, () => {
    try {
      const dir = p.slice(0, p.lastIndexOf("/"))
      if (dir && !existsSync(dir)) mkdirSync(dir, { recursive: true })
      const prev = existsSync(p) ? readFileSync(p, "utf8").split("\n").filter((l) => l.trim() !== "") : []
      for (const rec of records) prev.push(JSON.stringify(rec))
      const kept = prev.slice(-MAX_DECISION_LINES)
      writeFileSync(p, `${kept.join("\n")}\n`)
    } catch (exc) {
      appendStatusLog(`决策日志 fail-open: ${exc}`)
    }
  })
}
