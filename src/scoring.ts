// 模型评分引擎（纯函数核心）：显式加权评分 + 硬门 + tier 分组排序 + 决策日志
// [2026-08-29]-[把 computeLane 规则式排序升级为可追溯显式加权评分；
//  base（策展能力）压倒一切软系数：先按 tier 分组、组内再按乘积分排序]
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { paths, withPathLock } from "./state"
import type { Lane, Pool, Routing, ShellRegEntry } from "./types"
import { baseScoreDynamic } from "./capability"
import type { Tier } from "./model-ranks"
import { LANE_SPEC } from "./lane-policy"

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
  /** DS 空闲时段（5 折） */
  dsIdle?: boolean
}

export interface ScoreInput {
  modelId: string
  effort: string | null
  lane: Lane
  pool: Pool | string
  matrixStatus: string
  latencyMs: number | null
  glmPeak: boolean
  immediate: boolean
  water: WaterFactor
}

export interface ScoreBreakdown {
  base: number
  baseSource: string
  /** [2026-08-31]-[动态能力分级：api 命中时为 capability.json 数据版本（决策日志追溯）；策展回退为 null] */
  baseVersion?: string | null
  effortFit: number
  health: number
  water: number
  costBias: number
  peak: number
  total: number
  tier: Tier
}

const TIER_RANK: Record<Tier, number> = { S: 0, A: 1, B: 2, C: 3 }

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

/** water：水位富余 1.0 线性降至 0.6；>90% 已在上游硬拦 */
function waterOf(pool: string, w: WaterFactor): number {
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

/** costBias：订阅池 1.0 / 按量池（deepseek）0.7 */
// [2026-08-29]-[复审遗留#3修正：DS 空闲=5折更便宜，惩罚应减轻（0.7→0.85）而非加重——
//  costBias 越低越不优先，原规格 0.6 方向写反；按量池整体仍压在订阅池之下]-
function costBiasOf(pool: string, w: WaterFactor): number {
  if (pool !== "deepseek") return 1.0
  return w.dsIdle ? 0.85 : 0.7
}

/** 单壳加权评分（纯函数；immediate 只影响排序不影响本函数乘积分）
 *  [2026-08-31]-[动态能力分级：base 来源切换为 baseScoreDynamic（api → 策展表 fail-open 回退），
 *  乘积链 total=base*effortFit*health*water*costBias*peak 保持不变] */
export function scoreShell(input: ScoreInput): ScoreBreakdown {
  const base = baseScoreDynamic(input.modelId)
  const effortFit = effortFitOf(input.lane, input.effort)
  const health = healthOf(input.matrixStatus)
  const water = waterOf(String(input.pool), input.water)
  const costBias = costBiasOf(String(input.pool), input.water)
  const peak = input.glmPeak && input.pool === "glm" ? 0.93 : 1.0
  const total = base.score * effortFit * health * water * costBias * peak
  return {
    base: base.score,
    baseSource: base.source,
    baseVersion: base.version,
    effortFit,
    health,
    water,
    costBias,
    peak,
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
  retiredModels?: ReadonlySet<string>
  realFailedCombos?: ReadonlySet<string>
  producerFamily?: string | null
  modality?: string | null
  capability?: string | null
  /** [2026-08-29]-[复审P1-2(b)：v1.1「便宜者前」契约保留为同 tier 且 total 平局的 tiebreak] */
  costs?: ((modelId: string) => number | null) | null
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
  if (shell && ctx.quotaExhausted?.[shell.pool as Pool]) return true
  if (ctx.lane === "review" && ctx.producerFamily && shell && String(shell.family) === String(ctx.producerFamily).toLowerCase()) return true
  if ((ctx.modality === "image" || ctx.modality === "vision") && shell && !shell.vision) return true
  if (ctx.capability === "rw" && shell?.capability === "ro") return true
  return false
}

/**
 * 硬门剔除 → 排序。immediate 只按 latency_ms 升序（DS 恒链尾）；normal 按 tier 分组、组内乘积分降序。
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
    breakdowns.set(s.key, scoreShell({
      modelId: s.modelId,
      effort: s.effort,
      lane: ctx.lane,
      pool: s.pool,
      matrixStatus: s.matrixStatus,
      latencyMs: s.latencyMs,
      glmPeak: ctx.glmPeak,
      immediate: ctx.immediate,
      water: ctx.water,
    }))
  }
  const dsLast = (s: T) => (s.pool === "deepseek" ? 1 : 0)
  // [2026-08-29]-[复审P2-1：末位显式按入参序 tiebreak，不依赖排序实现稳定性]-
  const inputOrder = new Map(survivors.map((s, i) => [s.key, i]))
  if (ctx.immediate) {
    survivors.sort((a, b) =>
      dsLast(a) - dsLast(b) ||
      (a.latencyMs ?? Number.POSITIVE_INFINITY) - (b.latencyMs ?? Number.POSITIVE_INFINITY))
  } else {
    const costOf = ctx.costs
    const costOfKey = (s: T): number => {
      const shell = ctx.registry?.[s.key]
      const v = costOf && shell ? costOf(shell.modelId) : null
      return typeof v === "number" ? v : Number.POSITIVE_INFINITY
    }
    survivors.sort((a, b) => {
      const ba = breakdowns.get(a.key)!
      const bb = breakdowns.get(b.key)!
      return dsLast(a) - dsLast(b) ||
        TIER_RANK[ba.tier] - TIER_RANK[bb.tier] ||
        bb.total - ba.total ||
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
      console.error(`[opencode-switchman] 决策日志 fail-open: ${exc}`)
    }
  })
}
