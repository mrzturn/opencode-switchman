// 六档选链计算器（过滤 → 换序 → auto_ok 门控 → 降级标记；
// v1.1 增补：normal/deferable 排序在水位同分时按 costScore 升序 tiebreaker——immediate 档不受影响）
// 本模块纯函数零 IO：registry/matrix/routing/quota/states 全部由调用方装配。
import type {
  ChainCandidate, CopilotQuota, DroppedCandidate, GlmQuota, Lane, LaneResult,
  Pool, PoolStateKind, ShellRegEntry,
} from "./types"

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
export function glmExhausted(data: GlmQuota | null): [boolean, string] {
  if (!data || data.status !== "ok") return [false, ""]
  for (const [scope, key] of [["周额度", "weekly"], ["5小时窗", "five_hour"]] as const) {
    const d = (data as any)[key]
    if (d && typeof d.used_pct === "number" && d.used_pct >= 100) {
      const reset = typeof d.reset_at === "number" ? new Date(d.reset_at * 1000) : null
      const hint = reset
        ? `${String(reset.getMonth() + 1).padStart(2, "0")}-${String(reset.getDate()).padStart(2, "0")} ${String(reset.getHours()).padStart(2, "0")}:${String(reset.getMinutes()).padStart(2, "0")}`
        : "稍后"
      return [true, `GLM ${scope}已用尽（最早 ${hint} 恢复）`]
    }
  }
  return [false, ""]
}

export function copilotExhausted(data: CopilotQuota | null): [boolean, string] {
  if (!data || data.status !== "ok") return [false, ""]
  if (data.gateway_exhausted) {
    return [true, `Copilot 月度池网关已拒（额度类错误，信任至 ${data.reset_date || "重置日"}）`]
  }
  const p = data.premium
  if (!p || p.unlimited) return [false, ""]
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
    if (p?.unlimited || typeof rem !== "number" || dl === null) {
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
      if (st !== "ok") reason = `matrix-${st || "missing"}`
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
  const costOf = p.costs
  const dsLast = (c: ChainCandidate) => (c.pool === "deepseek" ? 1 : 0)
  if (p.urgency === "immediate") {
    // immediate：按探针延迟升序（无数据殿后），DS 恒链尾；不避峰不计成本
    chain.sort((a, b) =>
      dsLast(a) - dsLast(b) ||
      (a.latency_ms ?? Number.POSITIVE_INFINITY) - (b.latency_ms ?? Number.POSITIVE_INFINITY))
  } else {
    // normal/deferable：水位换序（GLM 高峰 copilot 同档提前）→ v1.1 成本 tiebreaker（水位同分便宜者前）
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
