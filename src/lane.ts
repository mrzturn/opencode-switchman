// [2026-09-04]-[English localization: translate comments and runtime messages; no logic change]
// Six-lane chain calculator (filter → reorder → downgrade marking;
// [2026-08-29]-[v2.0 scoring engine: ordering = tier grouping (base beats soft factors) → product score → costOf
// ascending → input order; the immediate lane orders by probe latency])
// [2026-08-31]-[de-vendorization: removed the auto_ok/DS permanent-tail gating — api billing and unknown groups sink
//  naturally via the billingBoost×unknownPenalty product factor; billingBoostOf/peakOf injected by the caller from user jsonc]
// This module is pure functions with zero IO: registry/matrix/routing/quota/states are all assembled by the caller.
import type {
  ChainCandidate, CopilotQuota, DroppedCandidate, GlmQuota, Lane, LaneResult,
  Pool, PoolStateKind, ShellRegEntry,
} from "./types"
import { rankCandidates } from "./scoring"
import type { WaterFactor } from "./scoring"
import { evaluatePeakSchedules } from "./config"
import { defaultProviderConfig } from "./provider-config"
import { appendStatusLog } from "./state"
import { normalizeModelKey } from "./capability"

// ---- Billing window (configurable) ----
export interface BillingWindowCfg {
  glmPeakHours?: [number, number] // default [14,18], workdays
  dsPeakRanges?: Array<[number, number]> // default [[9,12],[14,18]], workdays
}
export function billingWindow(now = new Date(), cfg: BillingWindowCfg = {}): {
  glmPeak: boolean; dsPeak: boolean; glmLabel: string; dsLabel: string
} {
  const wd = now.getDay() // 0=Sunday
  const h = now.getHours()
  const workday = wd >= 1 && wd <= 5
  const [gs, ge] = cfg.glmPeakHours ?? [14, 18]
  const glmPeak = workday && h >= gs && h < ge
  const dsPeak = workday && (cfg.dsPeakRanges ?? [[9, 12], [14, 18]]).some(([s, e]) => h >= s && h < e)
  // [2026-08-31]-[de-vendorization: the labels state only the peak-window fact, with no multiplier/discount business
  //  semantics (billing priority is driven by the billing config)]
  return {
    glmPeak,
    dsPeak,
    glmLabel: glmPeak ? "GLM peak" : "GLM off-peak",
    dsLabel: dsPeak ? "DS peak" : "DS off-peak",
  }
}

/** Peak computation from the new user config; billingWindow is kept as a legacy-options-compatible wrapper. */
export function billingWindowForConfig(now: Date, config: import("./config").UserConfig, legacy?: BillingWindowCfg): {
  glmPeak: boolean; dsPeak: boolean; glmLabel: string; dsLabel: string
} {
  const legacyWindow = legacy && billingWindow(now, legacy)
  const glmPeak = legacyWindow?.glmPeak ?? evaluatePeakSchedules(now, config, "glm")
  const dsPeak = legacyWindow?.dsPeak ?? evaluatePeakSchedules(now, config, "deepseek")
  return { glmPeak, dsPeak, glmLabel: glmPeak ? "GLM peak" : "GLM off-peak", dsLabel: dsPeak ? "DS peak" : "DS off-peak" }
}

// ---- Pool exhaustion verdict (only when calls are certain to fail) ----
function fmtReset(reset: number | null | undefined): string {
  if (typeof reset !== "number") return "later"
  const d = new Date(reset * 1000)
  return `${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`
}

// [2026-08-28]-[GLM 5-hour window switched to a configurable reserve watermark (default 90%): hard block on reach to
//  avoid a full window triggering 429; the weekly quota's large window still only blocks at 100% ("use it up, no waste")]
export function glmExhausted(data: GlmQuota | null, fiveHourReservePct = 90): [boolean, string] {
  if (!data || data.status !== "ok") return [false, ""]
  const weekly = data.weekly
  if (weekly && typeof weekly.used_pct === "number" && weekly.used_pct >= 100) {
    return [true, `GLM weekly quota exhausted (earliest recovery ${fmtReset(weekly.reset_at)})`]
  }
  const five = data.five_hour
  const thr = typeof fiveHourReservePct === "number" && fiveHourReservePct > 0 && fiveHourReservePct <= 100
    ? fiveHourReservePct
    : 100
  if (five && typeof five.used_pct === "number" && five.used_pct >= thr) {
    return [true, `GLM 5-hour window used ${five.used_pct}% (≥ reserve watermark ${thr}%, earliest recovery ${fmtReset(five.reset_at)})`]
  }
  return [false, ""]
}

export function copilotExhausted(data: CopilotQuota | null): [boolean, string] {
  if (!data || data.status !== "ok") return [false, ""]
  if (data.gateway_exhausted) {
    return [true, `Copilot monthly pool rejected by the gateway (quota-type error; trusted until ${data.reset_date || "reset date"})`]
  }
  const p = data.premium
  if (!p) return [false, ""]
  // [2026-08-28]-[misjudgment fix: business-seat snapshot unlimited:true but has_quota:false (no premium interaction quota),
  //  while the gateway really saw 402 monthly exceeded — has_quota=false verdicts "no premium quota / exhausted"]
  if (p.has_quota === false) {
    return [true, `Copilot has no premium interaction quota (has_quota=false, business seat excludes premium; resets ${data.reset_date || "on the reset date"})`]
  }
  if (p.unlimited) return [false, ""]
  const usedUp =
    (typeof p.remaining === "number" && p.remaining <= 0) ||
    (typeof p.percent_remaining === "number" && p.percent_remaining <= 0)
  if (!usedUp || p.overage_permitted) return [false, ""]
  return [true, `Copilot credits exhausted and overage not permitted (resets ${data.reset_date || "see banner for the reset date"})`]
}

export function deepseekExhausted(data: { status: string; exhausted?: boolean } | null): [boolean, string] {
  if (!data || data.status !== "ok" || !data.exhausted) return [false, ""]
  return [true, "DeepSeek balance exhausted / overdue (top up to restore)"]
}

// ---- High-watermark verdict (shortened-TTL criterion) ----
export function glmHot(data: GlmQuota | null): boolean {
  const pcts = [data?.five_hour?.used_pct, data?.weekly?.used_pct]
    .filter((v): v is number => typeof v === "number")
  return pcts.length > 0 && Math.max(...pcts) >= 80
}
export function copilotHot(data: CopilotQuota | null): boolean {
  const p = data?.premium
  return typeof p?.percent_remaining === "number" && p.percent_remaining <= 20
}

// ---- Pool watermark state evaluation (purely local; reads the passed-in quota data) ----
function daysUntil(dateStr: unknown, now = new Date()): number | null {
  if (typeof dateStr !== "string") return null
  const d = new Date(`${dateStr.slice(0, 10)}T00:00:00`)
  if (Number.isNaN(d.getTime())) return null
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()
  return Math.max(Math.floor((d.getTime() - start) / 86400000), 0)
}

export function poolStates(quota: {
  glm?: GlmQuota | null
  copilot?: CopilotQuota | null
}, peak?: { glmPeak: boolean }, policy?: import("./types").RoutePolicy): Record<string, { state: PoolStateKind } & Record<string, unknown>> {
  const out: Record<string, { state: PoolStateKind } & Record<string, unknown>> = {}
  const g = quota.glm
  if (g && g.status === "ok") {
    const p5 = g.five_hour?.used_pct ?? null
    const pw = g.weekly?.used_pct ?? null
    const threshold = policy?.glm?.routing === false ? 80 : (peak?.glmPeak ? 70 : 80)
    let state: PoolStateKind
    if ((typeof p5 === "number" && p5 >= threshold) || (typeof pw === "number" && pw >= threshold)) {
      state = "strained"
    } else {
      const reset = g.weekly?.reset_at
      const hoursLeft = typeof reset === "number" ? (reset - Date.now() / 1000) / 3600 : null
      state = hoursLeft !== null && hoursLeft > 0 && hoursLeft <= 48 && typeof pw === "number" && pw <= 60
        ? "surplus"
        : "healthy"
    }
    const wl = typeof g.weekly?.reset_at === "number"
      ? Math.round(((g.weekly.reset_at as number) - Date.now() / 1000) / 3600 * 10) / 10
      : null
    out.glm = { state, five_hour_pct: p5, weekly_pct: pw, weekly_hours_left: wl }
  }
  const c = quota.copilot
  if (c && c.status === "ok") {
    const p = c.premium
    const rem = p?.remaining ?? null
    const used = p?.used ?? null
    const dl = daysUntil(c.reset_date)
    if (p?.has_quota === false) {
      // [2026-08-28]-[business seat without a premium interaction quota: watermark verdict strained, suppressing the
      //  "prefer copilot" advice (same source as copilotExhausted)]
      out.copilot = { state: "strained", remaining: rem, days_left: dl }
    } else if (p?.unlimited || typeof rem !== "number" || dl === null) {
      out.copilot = { state: "healthy", remaining: rem, days_left: dl }
    } else {
      const daysElapsed = Math.max(30 - dl, 1)
      const burn = typeof used === "number" ? used / daysElapsed : null
      const runway = burn && burn > 0 ? rem / burn : null
      let state: PoolStateKind
      if (runway !== null) {
        state = runway > dl * 1.3 ? "surplus" : runway < dl * 0.8 ? "strained" : "healthy"
      } else {
        state = "healthy"
      }
      const waste = burn ? Math.max(rem - burn * dl, 0) : null
      out.copilot = {
        state, remaining: rem, days_left: dl,
        runway_days: runway ? Math.round(runway * 10) / 10 : null,
        waste_est: typeof waste === "number" ? Math.round(waste) : null,
      }
    }
  }
  return out
}

// ---- Tiered pool-routing advice (one line; only deviations from the default routing) ----
export function routingAdvice(states: Record<string, { state?: PoolStateKind } & Record<string, unknown>>, policy?: import("./types").RoutePolicy): string | null {
  if (policy && !policy.glm.routing && !policy.copilot.routing && !policy.deepseek.routing) return null
  const gs = states.glm?.state
  const cs = states.copilot?.state
  if (gs === undefined && cs === undefined) return null
  const copilotOk = cs === "surplus" || cs === "healthy" || cs === undefined
  const glmOk = gs === "surplus" || gs === "healthy" || gs === undefined
  const tips: string[] = []
  if (cs === "surplus" && policy?.copilot?.routing !== false) {
    const w = states.copilot?.waste_est
    const wtxt = typeof w === "number" && w > 0
      ? ` (~${w >= 10000 ? `${Math.round(w / 1000)}k` : w} credits will expire unused)`
      : ""
    // [2026-08-31]-[de-vendorization: advice copy drops model names and business rules, keeping only data-driven
    //  provider-level guidance]
    tips.push(`Copilot monthly credits surplus${wtxt} → no need to economize on hard tasks; core cognitive roles (programmer/uiux/data-analyst) prefer same-lane copilot`)
  }
  if (cs === "strained" && glmOk && policy?.copilot?.routing !== false) {
    tips.push("Copilot monthly credits tight → move hard tasks (planner/reviewer) and support roles (scouter/clerk) to glm; save credits for the critical core")
  }
  if (gs === "surplus" && policy?.glm?.routing !== false) {
    const hl = states.glm?.weekly_hours_left
    const htxt = typeof hl === "number" ? ` (refreshes in ~${Math.round(hl)}h)` : ""
    tips.push(`GLM weekly quota near-expiry surplus${htxt} → safe to increase usage; support roles (scouter/clerk) can move to low-lane glm`)
  }
  if (gs === "strained" && copilotOk && policy?.glm?.routing !== false) {
    tips.push("GLM watermark tight → core cognitive roles prefer copilot, mechanical roles (tester/ops) prefer copilot, defer large non-urgent batches off-peak")
  } else if (gs === "strained" && policy?.deepseek?.routing !== false) {
    // [2026-08-31]-[de-vendorization: api-billing fallback is driven by the billing config; no vendor named]
    tips.push("both pools tight → mechanical tasks can fall back to pay-as-you-go providers (billing=api) in idle windows, cognitive tasks pick the best subscription pool, defer non-urgent work")
  }
  if (tips.length === 0) return null
  return tips.join("; ")
}

// ---- Pool watermark score (GLM peak is an independent condition ahead of copilot) ----
// [2026-08-31]-[final-review P0-2: poolScore was a leftover of the old v1.1 pool-preference ordering, removed along with the legacySort neutralization]

// [2026-08-29]-[scoring-engine fail-open fallback: the v1.1 rule-based ordering is kept as-is; on scoring failure the fallback degrades nothing]
// [2026-08-31]-[final-review P0-2: the fallback path has zero vendor rules — normal keeps the base-chain input order
//  (computeLaneChain already includes the capability/affinity/billing/unknown factors), immediate orders only by probe
//  latency; no pool-name preference reordering]
function legacySort(chain: ChainCandidate[], p: ComputeLaneParams, glmPeak: boolean, immediate: boolean): void {
  if (!immediate) return
  chain.sort((a, b) =>
    (a.latency_ms ?? Number.POSITIVE_INFINITY) - (b.latency_ms ?? Number.POSITIVE_INFINITY))
}

export interface ComputeLaneParams {
  registry: Record<string, ShellRegEntry> | null
  matrix: Record<string, import("./types").MatrixEntry> | null
  routing: import("./types").Routing | null
  quotaExhausted?: Partial<Record<Pool, boolean>>
  routePolicy?: import("./types").RoutePolicy
  states?: Record<string, { state?: PoolStateKind }> | null
  glmPeak?: boolean | null
  costs?: ((modelId: string) => number | null) | null
  urgency?: "immediate" | "normal" | "deferable"
  producerFamily?: string | null
  modality?: string | null
  capability?: string | null
  source?: string
  /** [2026-08-29]-[scoring engine: normalized watermark factor (default = all 1.0 fail-open)] */
  water?: WaterFactor
  retiredModels?: ReadonlySet<string>
  realFailedCombos?: ReadonlySet<string>
  /** [2026-08-31]-[de-vendorization: provider → subscription billing factor (subscription=1.0/api=0.85; parsed from user jsonc)] */
  billingBoostOf?: (provider: string) => number
  /** [2026-08-31]-[de-vendorization: provider → billing-peak active (any provider's peak config evaluated)] */
  peakOf?: (provider: string) => boolean
  /** [2026-09-02]-[favorites first: favorite models (by modelId) sort first within the same tier at runtime (passed through to rankCandidates)] */
  preferredModels?: ReadonlySet<string>
  /** [2026-09-03]-[task-pool selection (manual pool-config.json, overrides the system default candidate set):
   *  lane → normalized modelId set participating in that task pool (the same model may join several lanes); a non-empty
   *  list takes effect, missing key/empty = fail-open all models; unselected models after configuration get reason=pool-config] */
  poolConfig?: Partial<Record<string, ReadonlySet<string>>> | null
}

/** agentDown reference (implemented here to avoid a circular dependency: purely reads the passed-in routing) */
export function agentDownPure(agent: string, routing: import("./types").Routing | null, registry: Record<string, ShellRegEntry> | null): boolean {
  const down = routing?.down_agents
  if (!down || typeof down !== "object") return false
  if (agent in down) return true
  const combo = registry?.[agent]?.comboKey
  return Boolean(combo && combo in down)
}

/**
 * Six-lane decision tree (cost tiebreaker since v1.1).
 * Missing registry/matrix always fail-open pass-through of the static chain (status gets a "*" downgrade marker; dispatch is not blocked).
 */
export function computeLane(lane: Lane, base: string[], p: ComputeLaneParams): LaneResult {
  const registry = p.registry
  const mcombos = p.matrix
  const routing = p.routing
  const regOk = registry !== null && typeof registry === "object"

  const chain: ChainCandidate[] = []
  const dropped: DroppedCandidate[] = []
  const exhausted = p.quotaExhausted ?? {}

  for (const name of base) {
    const shell = regOk ? registry![name] : undefined
    let reason: string | null = null
    if (regOk && !shell) reason = "unregistered"
    else if (regOk && shell && shell.status !== "enabled") reason = `status-${shell.status}`
    else if (regOk && shell && !shell.matrixKey) reason = "matrix-unprobed"
    else if (mcombos !== null && mcombos && regOk && shell) {
      const st = String(mcombos[shell.matrixKey]?.status ?? "").toLowerCase()
      // [2026-08-29]-[scoring engine: only a hard down eliminates; strained still participates in scoring (health 0.6),
      //  unknown/missing/unprobed fail-open (scoring treats health as 1.0)]
      if (st === "down") reason = `matrix-${st || "missing"}`
    }
    let latency: number | null = null
    if (reason === null && mcombos && regOk && shell) {
      const lat = mcombos[shell.matrixKey]?.latency_ms
      latency = typeof lat === "number" ? lat : null
    }
    if (reason === null && regOk && shell) {
      if (agentDownPure(name, routing, registry)) reason = "breaker"
      // [2026-09-05]-[review same-family drop removed ("hetero-family"): family moved from elimination to ordering —
      //  rankCandidates sinks same-family shells to the chain tail (famClass first comparator), so same-family shells
      //  are last-resort DOWNGRADED self-review seats instead of being dropped; the review chain no longer empties
      //  when no cross-family reviewer is alive (cross-family stays strictly preferred)]
      else if ((p.modality === "image" || p.modality === "vision") && !shell.vision) reason = "modality"
      else if (p.capability === "rw" && shell.capability === "ro") reason = "capability"
      else if (exhausted[shell.pool as Pool] && p.routePolicy?.[shell.pool as Pool]?.routing !== false) reason = "pool-exhausted"
      else {
        // [2026-09-03]-[task-pool selection filter: the user-configured per-lane candidate list overrides the system
        //  default (per-pool candidates may differ, cross-provider pool models may join several pools); normalized exact
        //  match, filter only when the list exists and is non-empty, missing key = fail-open all models]
        const allow = p.poolConfig?.[lane]
        if (allow && allow.size > 0 && !allow.has(normalizeModelKey(shell.modelId))) reason = "pool-config"
      }
    }
    if (reason) {
      dropped.push({ shell: name, reason })
      continue
    }
    chain.push({
      shell: name,
      pool: regOk && shell ? shell.pool : name.split("-mx-", 1)[0],
      family: regOk && shell ? shell.family : null,
      effort: regOk && shell ? shell.effort : null,
      capability: regOk && shell ? shell.capability : null,
      vision: regOk && shell ? shell.vision : null,
      latency_ms: latency,
    })
  }

  const glmPeak = p.routePolicy?.glm?.routing === false ? false : (p.glmPeak ?? false)
  const immediate = p.urgency === "immediate"
  // [2026-08-29]-[scoring engine: internal ordering now calls rankCandidates (hard gates already applied in the loop;
  //  only ordering remains here); missing registry/matrix or scoring failure always falls back to rule-based ordering,
  //  never blocking the main delegation flow]
  if (regOk && mcombos) try {
    const matrixStatusOf = (c: ChainCandidate): string => {
      if (!regOk || !mcombos) return "ok"
      const sh = registry![c.shell]
      if (!sh?.matrixKey) return "ok"
      return String(mcombos[sh.matrixKey]?.status ?? "").toLowerCase() || "missing"
    }
    const rankables = chain.map((c) => ({
      key: c.shell,
      modelId: regOk && registry![c.shell] ? registry![c.shell].modelId : "",
      effort: c.effort,
      pool: c.pool,
      family: c.family,
      capability: c.capability,
      vision: c.vision,
      matrixStatus: matrixStatusOf(c),
      latencyMs: c.latency_ms,
    }))
    const { ranked, breakdowns } = rankCandidates(rankables, {
      lane,
      immediate,
      glmPeak,
      water: p.water ?? {},
      routing,
      registry,
      quotaExhausted: exhausted,
      routePolicy: p.routePolicy,
      retiredModels: p.retiredModels,
      realFailedCombos: p.realFailedCombos,
      producerFamily: p.producerFamily,
      modality: p.modality,
      capability: p.capability,
      costs: p.costs,
      billingBoostOf: p.billingBoostOf,
      peakOf: p.peakOf,
      preferredModels: p.preferredModels,
    })
    const order = new Map(ranked.map((r, i) => [r.key, i]))
    // rankCandidates also drops non-pool models and cross-level fallbacks that missed the top-2; custom static chains must not bypass it.
    chain.splice(0, chain.length, ...chain.filter((candidate) => order.has(candidate.shell)))
    chain.sort((a, b) => (order.get(a.shell) ?? Number.POSITIVE_INFINITY) - (order.get(b.shell) ?? Number.POSITIVE_INFINITY))
    for (const c of chain) {
      const bd = breakdowns.get(c.shell)
      if (bd) c.score = bd
    }
  } catch (exc) {
    appendStatusLog(`scoring failed, fell back to rule-based ordering: ${exc}`)
    legacySort(chain, p, glmPeak, immediate)
  }

  // [2026-08-31]-[de-vendorization: removed the auto_ok/DS-only gating — api-billed models with source=auto are no
  //  longer hard-blocked, soft-sorted instead by the billingBoost factor; status only distinguishes ok/exhausted (+ fail-open * mark)]
  let status: string
  if (chain.length === 0) status = "exhausted"
  else status = "ok"
  if (!regOk || mcombos === null || mcombos === undefined) {
    status = status === "exhausted" ? status : `${status}*`
  }
  return { lane, status, chain, dropped }
}

export function laneOfShell(shellName: string, lanes: Record<string, string[]>): Lane | null {
  for (const lane of Object.keys(lanes) as Lane[]) {
    if (lanes[lane]?.includes(shellName)) return lane
  }
  return null
}

/** deny-note first candidate: chain-head shell after passing the full gate set (skips exclude); [2026-08-31]-[auto_ok gating removed along with the pool-name rules] */
export function firstCandidate(
  lane: Lane, base: string[], p: ComputeLaneParams, exclude?: string,
): string | null {
  let r: LaneResult
  try {
    r = computeLane(lane, base, p)
  } catch {
    return null
  }
  for (const c of r.chain) {
    if (exclude && c.shell === exclude) continue
    return c.shell
  }
  return null
}
