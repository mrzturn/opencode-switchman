// 六档选链计算器（过滤 → 换序 → auto_ok 门控 → 降级标记；
// [2026-08-29]-[v2.0 评分引擎：排序=ds 链尾→tier 分组（base 压倒软系数）→乘积分→costOf 升序→入参序；
// immediate 档按探针延迟]）
// 本模块纯函数零 IO：registry/matrix/routing/quota/states 全部由调用方装配。
import type {
  ChainCandidate, CopilotQuota, DroppedCandidate, GlmQuota, Lane, LaneResult,
  Pool, PoolStateKind, ShellRegEntry,
} from "./types"
import { rankCandidates } from "./scoring"
import type { WaterFactor } from "./scoring"

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
  return {
    glmPeak,
    dsPeak,
    glmLabel: glmPeak ? "GLM高峰(5.3×3/Flash×1.2)" : "GLM平峰",
    dsLabel: dsPeak ? "DS高峰全价" : "DS空闲5折",
  }
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
}, peak?: { glmPeak: boolean }): Record<string, { state: PoolStateKind } & Record<string, unknown>> {
  const out: Record<string, { state: PoolStateKind } & Record<string, unknown>> = {}
  const g = quota.glm
  if (g && g.status === "ok") {
    const p5 = g.five_hour?.used_pct ?? null
    const pw = g.weekly?.used_pct ?? null
    const threshold = peak?.glmPeak ? 70 : 80
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
export function routingAdvice(states: Record<string, { state?: PoolStateKind } & Record<string, unknown>>): string | null {
  const gs = states.glm?.state
  const cs = states.copilot?.state
  if (gs === undefined && cs === undefined) return null
  const copilotOk = cs === "surplus" || cs === "healthy" || cs === undefined
  const glmOk = gs === "surplus" || gs === "healthy" || gs === undefined
  const tips: string[] = []
  if (cs === "surplus") {
    const w = states.copilot?.waste_est
    const wtxt = typeof w === "number" && w > 0
      ? `（约${w >= 10000 ? `${(w / 10000).toFixed(1)}万` : w}积分将作废）`
      : ""
    tips.push(`Copilot月积分富余${wtxt}→攻坚copilot-sol无需节省、主力认知(programmer/uiux/data-analyst)优先copilot同档`)
  }
  if (cs === "strained" && glmOk) {
    tips.push("Copilot月积分吃紧→攻坚(planner/reviewer)与辅助(scouter/clerk)改glm、积分留给关键主力")
  }
  if (gs === "surplus") {
    const hl = states.glm?.weekly_hours_left
    const htxt = typeof hl === "number" ? `（${Math.round(hl)}小时后刷新）` : ""
    tips.push(`GLM周额度临期富余${htxt}→放心加量、辅助(scouter/clerk)可改glm-53f`)
  }
  if (gs === "strained" && copilotOk) {
    tips.push("GLM水位吃紧→主力认知优先copilot、机械(tester/ops)优先copilot、大批量非紧急任务延后避峰")
  } else if (gs === "strained") {
    tips.push("双池吃紧→机械任务可切deepseek兜底(空闲窗5折)、认知任务择优套餐池、非紧急延后")
  }
  if (tips.length === 0) return null
  return tips.join("；")
}

// ---- 池水位分（GLM 高峰为 copilot 提前的独立条件）----
function poolScore(pool: string, states: Record<string, { state?: PoolStateKind }> | null | undefined, glmPeak: boolean): number {
  const st = states?.[pool]?.state
  if (pool === "copilot") {
    if (st === "surplus" || glmPeak) return 1
    return st === "strained" ? -1 : 0
  }
  if (pool === "glm") {
    return st === "surplus" ? 1 : st === "strained" ? -1 : 0
  }
  return 0
}

// [2026-08-29]-[评分引擎 fail-open 回退：v1.1 规则式排序原样保留，评分异常时兜底不劣化]
function legacySort(chain: ChainCandidate[], p: ComputeLaneParams, glmPeak: boolean, immediate: boolean): void {
  const costOf = p.costs
  const registry = p.registry
  const dsLast = (c: ChainCandidate) => (c.pool === "deepseek" ? 1 : 0)
  if (immediate) {
    chain.sort((a, b) =>
      dsLast(a) - dsLast(b) ||
      (a.latency_ms ?? Number.POSITIVE_INFINITY) - (b.latency_ms ?? Number.POSITIVE_INFINITY))
  } else {
    const score = (c: ChainCandidate) => poolScore(String(c.pool), p.states, glmPeak)
    const cost = (c: ChainCandidate): number => {
      const modelId = registry?.[c.shell]?.modelId
      const v = modelId && costOf ? costOf(modelId) : null
      return typeof v === "number" && Number.isFinite(v) ? v : Number.POSITIVE_INFINITY
    }
    chain.sort((a, b) =>
      dsLast(a) - dsLast(b) ||
      score(b) - score(a) ||
      cost(a) - cost(b))
  }
}

export interface ComputeLaneParams {
  registry: Record<string, ShellRegEntry> | null
  matrix: Record<string, import("./types").MatrixEntry> | null
  routing: import("./types").Routing | null
  quotaExhausted?: Partial<Record<Pool, boolean>>
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
      else if (exhausted[shell.pool as Pool]) reason = "pool-exhausted"
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

  const glmPeak = p.glmPeak ?? false
  const immediate = p.urgency === "immediate"
  // [2026-08-29]-[评分引擎：内部排序改调 rankCandidates（硬门已在循环完成，此处只排序）；
  //  registry/矩阵缺失或评分异常一律 fail-open 回退规则式排序，绝不阻塞委派主流程]
  try {
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
      retiredModels: p.retiredModels,
      realFailedCombos: p.realFailedCombos,
      producerFamily: p.producerFamily,
      modality: p.modality,
      capability: p.capability,
      costs: p.costs,
    })
    const order = new Map(ranked.map((r, i) => [r.key, i]))
    chain.sort((a, b) => (order.get(a.shell) ?? Number.POSITIVE_INFINITY) - (order.get(b.shell) ?? Number.POSITIVE_INFINITY))
    for (const c of chain) {
      const bd = breakdowns.get(c.shell)
      if (bd) c.score = bd
    }
  } catch (exc) {
    console.error(`[opencode-switchman] 评分失败回退规则式排序: ${exc}`)
    legacySort(chain, p, glmPeak, immediate)
  }

  const planAlive = chain.filter((c) => c.pool !== "deepseek")
  for (const c of chain) {
    c.auto_ok = !(p.source === "auto" && c.pool === "deepseek" && planAlive.length > 0)
  }
  let status: string
  if (chain.length === 0) status = "exhausted"
  else if (planAlive.length === 0) status = "deepseek-only"
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

/** deny 附言首候选：过全组闸后的链首 auto_ok 壳（跳过 exclude） */
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
    if (c.auto_ok === false) continue
    return c.shell
  }
  return null
}
