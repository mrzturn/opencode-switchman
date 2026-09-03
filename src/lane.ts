// 六档选链计算器（过滤 → 换序 → 降级标记；
// [2026-08-29]-[v2.0 评分引擎：排序=tier 分组（base 压倒软系数）→乘积分→costOf 升序→入参序；
// immediate 档按探针延迟]）
// [2026-08-31]-[去厂商化：删 auto_ok/DS 恒尾门控——api 计费与未知组由 billingBoost×unknownPenalty
//  乘积系数自然沉底；billingBoostOf/peakOf 由调用方从用户 jsonc 解析注入]
// 本模块纯函数零 IO：registry/matrix/routing/quota/states 全部由调用方装配。
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

// ---- 计费窗口（可配置）----
export interface BillingWindowCfg {
  glmPeakHours?: [number, number] // 默认 [14,18]，工作日
  dsPeakRanges?: Array<[number, number]> // 默认 [[9,12],[14,18]]，工作日
}
export function billingWindow(now = new Date(), cfg: BillingWindowCfg = {}): {
  glmPeak: boolean; dsPeak: boolean; glmLabel: string; dsLabel: string
} {
  const wd = now.getDay() // 0=周日
  const h = now.getHours()
  const workday = wd >= 1 && wd <= 5
  const [gs, ge] = cfg.glmPeakHours ?? [14, 18]
  const glmPeak = workday && h >= gs && h < ge
  const dsPeak = workday && (cfg.dsPeakRanges ?? [[9, 12], [14, 18]]).some(([s, e]) => h >= s && h < e)
  // [2026-08-31]-[去厂商化：标签只陈述高峰窗口事实，不含倍率/折扣等商务语义（计费优先级由 billing 配置驱动）]
  return {
    glmPeak,
    dsPeak,
    glmLabel: glmPeak ? "GLM高峰" : "GLM平峰",
    dsLabel: dsPeak ? "DS高峰" : "DS平峰",
  }
}

/** 新用户配置的高峰计算；保留 billingWindow 作为旧 options 兼容包装。 */
export function billingWindowForConfig(now: Date, config: import("./config").UserConfig, legacy?: BillingWindowCfg): {
  glmPeak: boolean; dsPeak: boolean; glmLabel: string; dsLabel: string
} {
  const legacyWindow = legacy && billingWindow(now, legacy)
  const glmPeak = legacyWindow?.glmPeak ?? evaluatePeakSchedules(now, config, "glm")
  const dsPeak = legacyWindow?.dsPeak ?? evaluatePeakSchedules(now, config, "deepseek")
  return { glmPeak, dsPeak, glmLabel: glmPeak ? "GLM高峰" : "GLM平峰", dsLabel: dsPeak ? "DS高峰" : "DS平峰" }
}

// ---- 池耗尽判定（只认调用必失败）----
function fmtReset(reset: number | null | undefined): string {
  if (typeof reset !== "number") return "稍后"
  const d = new Date(reset * 1000)
  return `${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`
}

// [2026-08-28]-[GLM 5 小时窗改为可配置预留水位（默认 90%）：达到即硬拦，避免用满触发 429；
// 周额度大窗口仍只认 100%「用满不浪费」]
export function glmExhausted(data: GlmQuota | null, fiveHourReservePct = 90): [boolean, string] {
  if (!data || data.status !== "ok") return [false, ""]
  const weekly = data.weekly
  if (weekly && typeof weekly.used_pct === "number" && weekly.used_pct >= 100) {
    return [true, `GLM 周额度已用尽（最早 ${fmtReset(weekly.reset_at)} 恢复）`]
  }
  const five = data.five_hour
  const thr = typeof fiveHourReservePct === "number" && fiveHourReservePct > 0 && fiveHourReservePct <= 100
    ? fiveHourReservePct
    : 100
  if (five && typeof five.used_pct === "number" && five.used_pct >= thr) {
    return [true, `GLM 5小时窗已用 ${five.used_pct}%（≥预留水位 ${thr}%，最早 ${fmtReset(five.reset_at)} 恢复）`]
  }
  return [false, ""]
}

export function copilotExhausted(data: CopilotQuota | null): [boolean, string] {
  if (!data || data.status !== "ok") return [false, ""]
  if (data.gateway_exhausted) {
    return [true, `Copilot 月度池网关已拒（额度类错误，信任至 ${data.reset_date || "重置日"}）`]
  }
  const p = data.premium
  if (!p) return [false, ""]
  // [2026-08-28]-[修复误判：业务席快照 unlimited:true 但 has_quota:false（premium 交互配额不存在），
  // 网关实测 402 monthly exceeded——has_quota=false 判为无 premium 配额、耗尽]
  if (p.has_quota === false) {
    return [true, `Copilot 无 premium 交互配额（has_quota=false，业务席不含 premium；${data.reset_date || "重置日"} 重置）`]
  }
  if (p.unlimited) return [false, ""]
  const usedUp =
    (typeof p.remaining === "number" && p.remaining <= 0) ||
    (typeof p.percent_remaining === "number" && p.percent_remaining <= 0)
  if (!usedUp || p.overage_permitted) return [false, ""]
  return [true, `Copilot 积分已耗尽且不允许超额（${data.reset_date || "重置日见横幅"} 重置）`]
}

export function deepseekExhausted(data: { status: string; exhausted?: boolean } | null): [boolean, string] {
  if (!data || data.status !== "ok" || !data.exhausted) return [false, ""]
  return [true, "DeepSeek 余额已耗尽/欠费（充值后恢复）"]
}

// ---- 高水位判定（TTL 缩短口径）----
export function glmHot(data: GlmQuota | null): boolean {
  const pcts = [data?.five_hour?.used_pct, data?.weekly?.used_pct]
    .filter((v): v is number => typeof v === "number")
  return pcts.length > 0 && Math.max(...pcts) >= 80
}
export function copilotHot(data: CopilotQuota | null): boolean {
  const p = data?.premium
  return typeof p?.percent_remaining === "number" && p.percent_remaining <= 20
}

// ---- 池水位状态评估（纯本地，读传入配额数据）----
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
      // [2026-08-28]-[业务席无 premium 交互配额：水位判 strained，抑制"优先 copilot"建议（与 copilotExhausted 同源）]
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

// ---- 分层选池建议（一行，只列与默认路由的偏离项）----
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
      ? `（约${w >= 10000 ? `${(w / 10000).toFixed(1)}万` : w}积分将作废）`
      : ""
    // [2026-08-31]-[去厂商化：建议文案去除模型名与商务规则，只保留数据驱动的 provider 级指引]
    tips.push(`Copilot月积分富余${wtxt}→攻坚任务无需节省、主力认知(programmer/uiux/data-analyst)优先copilot同档`)
  }
  if (cs === "strained" && glmOk && policy?.copilot?.routing !== false) {
    tips.push("Copilot月积分吃紧→攻坚(planner/reviewer)与辅助(scouter/clerk)改glm、积分留给关键主力")
  }
  if (gs === "surplus" && policy?.glm?.routing !== false) {
    const hl = states.glm?.weekly_hours_left
    const htxt = typeof hl === "number" ? `（${Math.round(hl)}小时后刷新）` : ""
    tips.push(`GLM周额度临期富余${htxt}→放心加量、辅助(scouter/clerk)可改glm低档`)
  }
  if (gs === "strained" && copilotOk && policy?.glm?.routing !== false) {
    tips.push("GLM水位吃紧→主力认知优先copilot、机械(tester/ops)优先copilot、大批量非紧急任务延后避峰")
  } else if (gs === "strained" && policy?.deepseek?.routing !== false) {
    // [2026-08-31]-[去厂商化：api 计费兜底由 billing 配置驱动，不再点名厂商]
    tips.push("双池吃紧→机械任务可切按量计费 provider（billing=api）空闲窗兜底、认知任务择优订阅池、非紧急延后")
  }
  if (tips.length === 0) return null
  return tips.join("；")
}

// ---- 池水位分（GLM 高峰为 copilot 提前的独立条件）----
// [2026-08-31]-[终审P0-2：poolScore 属旧 v1.1 池偏好排序残留，随 legacySort 中性化一并删除]

// [2026-08-29]-[评分引擎 fail-open 回退：v1.1 规则式排序原样保留，评分异常时兜底不劣化]
// [2026-08-31]-[终审P0-2：回退路径零厂商规则——normal 保持基础链入参序（computeLaneChain 已含
//  能力/亲和/billing/unknown 系数），immediate 仅按探针延迟；不再按池名偏好重排]
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
  /** [2026-08-29]-[评分引擎：归一化水位因子（缺省=全 1.0 fail-open）] */
  water?: WaterFactor
  retiredModels?: ReadonlySet<string>
  realFailedCombos?: ReadonlySet<string>
  /** [2026-08-31]-[去厂商化：provider→订阅计费系数（subscription=1.0/api=0.85；用户 jsonc 解析）] */
  billingBoostOf?: (provider: string) => number
  /** [2026-08-31]-[去厂商化：provider→计费高峰活跃（任意 provider 的 peak 配置求值）] */
  peakOf?: (provider: string) => boolean
  /** [2026-09-02]-[favorites 优先：收藏模型（modelId 口径）运行期同 tier 排前（透传 rankCandidates）] */
  preferredModels?: ReadonlySet<string>
  /** [2026-09-03]-[任务池选配（pool-config.json 手动配置，优先于系统默认候选集）：
   *  lane→参与该任务池的 modelId 归一化集合（同模型可重复进驻多个 lane）；清单存在且非空即生效，
   *  缺键/空=fail-open 默认全量；配置后未入选模型 reason=pool-config] */
  poolConfig?: Partial<Record<string, ReadonlySet<string>>> | null
}

/** agentDown 引用（避免循环依赖放此处实现：纯读传入 routing） */
export function agentDownPure(agent: string, routing: import("./types").Routing | null, registry: Record<string, ShellRegEntry> | null): boolean {
  const down = routing?.down_agents
  if (!down || typeof down !== "object") return false
  if (agent in down) return true
  const combo = registry?.[agent]?.comboKey
  return Boolean(combo && combo in down)
}

/**
 * 六档决策树（v1.1 起含成本 tiebreaker）。
 * registry/矩阵缺失一律 fail-open 透传静态链（status 加 "*" 降级标记，不拦截派发）。
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
      // [2026-08-29]-[评分引擎：仅 down 硬门出局；strained 参与评分（health 0.6），
      //  unknown/missing/unprobed fail-open 放行（评分层 health 视同 1.0）]
      if (st === "down") reason = `matrix-${st || "missing"}`
    }
    let latency: number | null = null
    if (reason === null && mcombos && regOk && shell) {
      const lat = mcombos[shell.matrixKey]?.latency_ms
      latency = typeof lat === "number" ? lat : null
    }
    if (reason === null && regOk && shell) {
      if (agentDownPure(name, routing, registry)) reason = "breaker"
      else if (lane === "review" && p.producerFamily && shell.family === String(p.producerFamily).toLowerCase()) reason = "hetero-family"
      else if ((p.modality === "image" || p.modality === "vision") && !shell.vision) reason = "modality"
      else if (p.capability === "rw" && shell.capability === "ro") reason = "capability"
      else if (exhausted[shell.pool as Pool] && p.routePolicy?.[shell.pool as Pool]?.routing !== false) reason = "pool-exhausted"
      else {
        // [2026-09-03]-[任务池选配过滤：用户手动配置的 lane 候选清单压过系统默认（各任务池候选体现差异化，
        //  跨 provider 池模型可重复进驻）；归一化精确匹配，清单存在且非空才过滤，缺键=fail-open 默认全量]
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
  // [2026-08-29]-[评分引擎：内部排序改调 rankCandidates（硬门已在循环完成，此处只排序）；
  //  registry/矩阵缺失或评分异常一律 fail-open 回退规则式排序，绝不阻塞委派主流程]
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
    // rankCandidates 同时裁掉非本池模型和未进前二的跨级候补；不得让自定义静态链绕过。
    chain.splice(0, chain.length, ...chain.filter((candidate) => order.has(candidate.shell)))
    chain.sort((a, b) => (order.get(a.shell) ?? Number.POSITIVE_INFINITY) - (order.get(b.shell) ?? Number.POSITIVE_INFINITY))
    for (const c of chain) {
      const bd = breakdowns.get(c.shell)
      if (bd) c.score = bd
    }
  } catch (exc) {
    appendStatusLog(`评分失败回退规则式排序: ${exc}`)
    legacySort(chain, p, glmPeak, immediate)
  }

  // [2026-08-31]-[去厂商化：删 auto_ok/DS-only 门控——source=auto 的 api 计费模型不再被硬拦，
  //  由 billingBoost 系数软排序兜底；status 只区分 ok/exhausted（+ fail-open * 标记）
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

/** deny 附言首候选：过全组闸后的链首壳（跳过 exclude）；[2026-08-31]-[auto_ok 门控已随池名规则废除] */
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
