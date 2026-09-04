// [2026-09-04]-[English localization: translate comments and log messages; no logic change]
// Model scoring engine (pure-function core): explicit weighted scoring + hard gates + tier-grouped ordering + decision log
// [2026-08-29]-[upgraded computeLane's rule-based ordering into a traceable explicit weighted score;
//  base (curated capability) beats all soft factors: group by tier first, then order within groups by product score]
// [2026-08-31]-[de-vendorized orchestration: removed the dsLast pool-name grouping; total extended to
//  base×effortFit×health×water×costBias×peak×billingBoost×unknownPenalty —
//  billing is driven only by explicit user jsonc declarations (subscription=1.0/api=0.85); unknown groups (models missed
//  by the whole capability-level chain) rank after known ones within the same tier; the costBias vendor rule is
//  abolished, kept constant 1.0 as a placeholder for future real cost data]
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { paths, withPathLock, appendStatusLog } from "./state"
import type { Lane, Pool, Routing, ShellRegEntry } from "./types"
import { baseScoreDynamic } from "./capability"
import { CAPABILITY_LEVEL_RANK, TIER_RANK, UNKNOWN_PENALTY, capabilityLevelOf } from "./model-ranks"
import type { Tier } from "./model-ranks"
import { LANE_SPEC, isFallbackCandidate, isPrimaryCandidate } from "./lane-policy"

/** [2026-08-31]-[de-vendorization: api billing factor (subscription=1.0); replaces the hardcoded chain-tail/pay-as-you-go penalties keyed by pool name] */
export const BILLING_API_BOOST = 0.85
export { UNKNOWN_PENALTY }

// ---- Watermark factor (caller injects after normalizing via poolStates/quotaView; default = all 1.0 fail-open) ----
export interface WaterFactor {
  /** GLM 5-hour window utilization (0-100) */
  glmFiveHourPct?: number | null
  /** GLM weekly quota utilization (0-100) */
  glmWeeklyPct?: number | null
  /** Copilot remaining credits percentage (0-100) */
  copilotRemainingPct?: number | null
  /** Days until the Copilot reset */
  copilotResetDays?: number | null
  /** When routing is off, the watermark influence must be neutralized. */
  routing?: Partial<Record<Pool, boolean>>
}

export interface ScoreInput {
  modelId: string
  effort: string | null
  lane: Lane
  pool: Pool | string
  matrixStatus: string
  latencyMs: number | null
  /** [2026-08-31]-[peak generalization: whether this shell's provider has an active billing peak (any provider; the original glm-only rule is abolished)] */
  peakActive: boolean
  immediate: boolean
  water: WaterFactor
  /** [2026-08-31]-[subscription billing factor: subscription=1.0/api=0.85 (caller parses from user config); default 1.0] */
  billingBoost?: number
}

export interface ScoreBreakdown {
  base: number
  /** Raw index from the third-party capability source; participates in ordering only within the same tier. */
  rawCapability?: number
  baseSource: string
  /** [2026-08-31]-[dynamic capability levels: on an api hit this is the capability.json data version (decision-log traceability); null on curated fallback] */
  baseVersion?: string | null
  effortFit: number
  health: number
  water: number
  /** Constant 1.0 (the vendor rule is abolished; reserved for a future real-cost data factor) */
  costBias: number
  peak: number
  /** [2026-08-31]-[subscription billing factor (subscription=1.0/api=0.85)] */
  billingBoost: number
  /** [2026-08-31]-[unknown-group factor: 0.75 when the base source is the global fallback, else 1.0] */
  unknownPenalty: number
  total: number
  tier: Tier
}

function clampWater(v: number): number {
  return Math.min(1.0, Math.max(0.6, v))
}

/** effortFit: reuses the LANE_SPEC ordinals; the closer to the front, the closer to 1.0; a miss of the affinity order costs significantly */
function effortFitOf(lane: Lane, effort: string | null): number {
  const spec = LANE_SPEC[lane] ?? LANE_SPEC.main
  const idx = spec.efforts.indexOf(effort ?? "")
  if (idx < 0) return 0.6
  return Math.max(0.6, 1 - idx * 0.1)
}

/** health: ok=1.0 / strained=0.6; everything else (unknown/missing etc.) fail-open as 1.0 */
function healthOf(matrixStatus: string): number {
  return matrixStatus === "strained" ? 0.6 : 1.0
}

/** water: 1.0 on ample watermark, linear down to 0.6; >90% is already hard-blocked upstream.
 *  [2026-08-31]-[de-vendorized baseline: pool names map only to quota-scraping data faces — providers with a scraper
 *  have watermark data, unknown/custom providers always fail-open 1.0; the water factor itself carries no vendor
 *  business preference] */
function waterOf(pool: string, w: WaterFactor): number {
  if (w.routing?.[pool as Pool] === false) return 1.0
  if (pool === "glm") {
    const pcts = [w.glmFiveHourPct, w.glmWeeklyPct].filter((v): v is number => typeof v === "number")
    if (pcts.length === 0) return 1.0
    // "min of the 5h window and weekly quota (watermark factor)" = take the tighter one (utilization max → factor min)
    const worst = Math.max(...pcts)
    return clampWater(1 - (worst / 90) * 0.4)
  }
  if (pool === "copilot") {
    const rem = w.copilotRemainingPct
    const days = w.copilotResetDays
    // [2026-08-29]-[re-review P1-1 fix: credit-burn semantics = "surplus about to expire" — only rem>=20% (true surplus)
    //  and near expiry (<7d) boosts to 1.0; rem<20% is tight (consistent with poolStates strained and routingAdvice
    //  "tight → move to glm"; must not boost in reverse)-
    //  the earlier looser rem>0 condition has been reverted]-
    if (typeof rem === "number" && rem >= 20 && typeof days === "number" && days < 7) return 1.0
    if (typeof rem !== "number") return 1.0
    return clampWater(1 - ((100 - rem) / 100) * 0.4)
  }
  return 1.0
}

/** costBias: constant 1.0 — the pool-name pay-as-you-go penalty is abolished (billingBoost took over); reserved for a future real-cost data factor */
function costBiasOf(): number {
  return 1.0
}

/** Per-shell weighted score (pure function; immediate only affects ordering, not this function's product score)
 *  [2026-08-31]-[de-vendorization: total=base*effortFit*health*water*costBias*peak*billingBoost*unknownPenalty;
 *  unknownPenalty derives from the base source (global fallback = unknown group), billingBoost injected by the caller] */
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

// ---- Ranked candidates (the shape computeLane assembles) ----
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
  /** [2026-08-29]-[re-review P1-2(b): the v1.1 "cheaper first" contract is kept as a tiebreak for same-tier + tied total] */
  costs?: ((modelId: string) => number | null) | null
  /** [2026-08-31]-[de-vendorization: provider → subscription billing factor (subscription=1.0/api=0.85; caller parses from user jsonc)] */
  billingBoostOf?: (provider: string) => number
  /** [2026-08-31]-[de-vendorization: provider → billing-peak active (any provider's peak config evaluated)] */
  peakOf?: (provider: string) => boolean
  /** [2026-09-02]-[favorites first: favorite models (by modelId) sort first within the same tier; tiers never invert;
   *  no effect under immediate (latency-only ordering)] */
  preferredModels?: ReadonlySet<string> | null
}

/** Hard gates: matrix down (strained is not down) / breaker / exhaustion / retirement / real-call isolation / semantic gates (same source as computeLane) */
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
 * Hard-gate elimination → ordering. immediate orders only by latency_ms ascending; normal groups by tier, descending
 * product score within groups.
 * [2026-08-31]-[de-vendorization: removed the dsLast pool-name grouping — api/unknown groups sink naturally by product factor]
 * Returns ranked (survivors) + breakdowns (key → detail, for decision-log traceability).
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
  // [2026-09-01]-[same-level first: while same-level survivors exist, cross-level entries never join the ordering;
  //  fallback only when the whole level was hard-gate eliminated.]-
  // [2026-09-02]-[thinking-level partition: off shells = lane-level fallback. Survivors are first partitioned by whether
  //  effort is off; the thinking partition leads as a whole, the off partition sinks to bottom (each independently runs
  //  same-level-first / cross-level fallback) — when the lane has thinking-level candidates, off shells no longer lead,
  //  immediate included (latency only orders within a partition; "thinking vs not" is a quality floor, not a soft factor)]
  const offClassOf = (s: T): number => ((s.effort ?? "off") === "off" ? 1 : 0)
  const thinking = survivors.filter((s) => offClassOf(s) === 0)
  const offPool = survivors.filter((s) => offClassOf(s) === 1)
  const scoreCompare = (a: T, b: T): number => {
    const ba = breakdowns.get(a.key)!
    const bb = breakdowns.get(b.key)!
    return bb.total - ba.total ||
      (bb.rawCapability ?? -Infinity) - (ba.rawCapability ?? -Infinity) ||
      (a.latencyMs ?? Number.POSITIVE_INFINITY) - (b.latencyMs ?? Number.POSITIVE_INFINITY)
  }
  const targetLevel = LANE_SPEC[ctx.lane].minimumLevel
  const levelDistance = (s: T): number | null => {
    if (targetLevel === null) return null
    return Math.abs(CAPABILITY_LEVEL_RANK[capabilityLevelOf(baseScoreDynamic(s.modelId).tier, baseScoreDynamic(s.modelId).source)] - CAPABILITY_LEVEL_RANK[targetLevel])
  }
  // Within-partition same-level first: same-level survivors win; only when the level is wiped out take the top-2 fallbacks from the nearest level.
  const selectGroup = (pool: T[]): T[] => {
    const primary = pool.filter((s) => isPrimaryCandidate(ctx.lane, baseScoreDynamic(s.modelId)))
    if (primary.length > 0) return primary
    const fallbackPool = pool.filter((s) => isFallbackCandidate(ctx.lane, baseScoreDynamic(s.modelId)))
    fallbackPool.sort((a, b) => {
      const da = levelDistance(a)
      const db = levelDistance(b)
      if (da !== null && db !== null && da !== db) return da - db
      return scoreCompare(a, b)
    })
    return fallbackPool.slice(0, 2)
  }
  survivors.length = 0
  survivors.push(...selectGroup(thinking), ...selectGroup(offPool))
  const inputOrder = new Map(survivors.map((s, i) => [s.key, i]))
  if (ctx.immediate) {
    survivors.sort((a, b) =>
      offClassOf(a) - offClassOf(b) ||
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
        // The off partition sinks to bottom as a whole; within-partition ordering keeps the original baseline.
        const offDiff = offClassOf(a) - offClassOf(b)
        if (offDiff !== 0) return offDiff
        // When the own partition is exhausted, fallbacks must start from the adjacent level and must not be re-leveled by the generic S/A/B/C ordering.
        if (targetLevel !== null) {
          const distanceDiff = levelDistance(a)! - levelDistance(b)!
          if (distanceDiff !== 0) return distanceDiff
        }
        const ba = breakdowns.get(a.key)!
      const bb = breakdowns.get(b.key)!
      return TIER_RANK[ba.tier] - TIER_RANK[bb.tier] ||
        // [2026-09-02]-[favorites first: favorites sort first within the same tier (explicit user intent beats the product score; no effect under immediate)]
        Number(ctx.preferredModels?.has(b.modelId) ?? false) - Number(ctx.preferredModels?.has(a.modelId) ?? false) ||
        bb.total - ba.total ||
        // tier is the cross-level hard key; on a same-tier total-score tie, fall back to the real capability index — a uniform TIER_SCORE mapping must not produce a flat tie.
        (bb.rawCapability ?? -Infinity) - (ba.rawCapability ?? -Infinity) ||
        costOfKey(a) - costOfKey(b) ||
        (inputOrder.get(a.key) ?? 0) - (inputOrder.get(b.key) ?? 0)
    })
  }
  return { ranked: survivors, breakdowns }
}

// ---- Decision log (state/routing-decisions.jsonl; ring-truncated to 200 lines; fail-open + withPathLock) ----
export interface DecisionCandidate extends ScoreBreakdown {
  name: string
}
export interface DecisionRecord {
  at: string
  lane: string
  candidates: DecisionCandidate[]
}

const MAX_DECISION_LINES = 200

/** Append decision lines (one per lane), keeping the most recent 200. Exceptions only log; never blocks the main flow. */
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
      appendStatusLog(`decision log fail-open: ${exc}`)
    }
  })
}
