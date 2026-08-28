// 四行横幅（[路由][水位][限制][更新]，逐行可解析端口契约）
import { LANE_ORDER } from "./types"
import type { Lane, LaneResult, PoolStateKind } from "./types"
import type { BillingWindow } from "./types"
import type { CopilotQuota, GlmQuota, DeepseekQuota, Routing } from "./types"

const SHORT_POOL: Record<string, string> = { deepseek: "ds" }

export function shortName(name: string): string {
  const idx = name.indexOf("-mx-")
  const pool = name.slice(0, idx)
  const rest = name.slice(idx + 4)
  return `${SHORT_POOL[pool] ?? pool}-${rest}`
}

export interface BannerInput {
  lanes: Record<string, LaneResult> | null
  down: Set<string> | string[]
  quota: { glm: GlmQuota | null; copilot: CopilotQuota | null; deepseek?: DeepseekQuota | null }
  states?: Record<string, { state?: PoolStateKind } & Record<string, unknown>> | null
  billing: BillingWindow
  advice?: string | null
  update?: string | null
  dsLowWarnCny?: number
}

function routeLine(lanes: Record<string, LaneResult> | null): string {
  const segs: string[] = []
  for (const lane of LANE_ORDER) {
    const r = lanes?.[lane]
    if (!r) {
      segs.push(`${lane}:?（route-state 不可用）`)
      continue
    }
    const names = r.chain.length > 0
      ? r.chain.slice(0, 3).map((c) => shortName(c.shell)).join("→")
      : "全不可用→终端失败协议"
    segs.push(`${lane}: ${names}${r.status.endsWith("*") ? "*" : ""}`)
  }
  return `[路由] ${segs.join(" | ")}`
}

function glmBrief(data: GlmQuota | null): string | null {
  if (!data || data.status !== "ok") return null
  const parts = ["GLM"]
  if (data.five_hour && typeof data.five_hour.used_pct === "number") parts.push(`5h窗 ${data.five_hour.used_pct}%`)
  if (data.weekly && typeof data.weekly.used_pct === "number") {
    const reset = data.weekly.reset_at
    const hint = typeof reset === "number"
      ? (() => { const d = new Date(reset * 1000); return `${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}` })()
      : "稍后"
    parts.push(`周 ${data.weekly.used_pct}%(${hint}刷新)`)
  }
  if (data.stale) parts.push("数据滞后")
  return parts.length > 1 ? parts.join(" ") : null
}

function copilotBrief(data: CopilotQuota | null): string | null {
  if (!data || data.status !== "ok") return null
  const p = data.premium
  if (data.gateway_exhausted) return `Copilot 月度池已耗尽(${data.reset_date ?? "?"}恢复)` // [v1.1 坑位] 网关真值源优先于快照
  if (!p) return null
  if (p.unlimited) {
    // unlimited:true 时展示 used 与 reset_date，不显示误导性百分比
    const used = typeof p.used === "number" ? ` 已用${p.used}` : ""
    return `Copilot 积分不限量${used}(${data.reset_date ?? "?"}刷新)`
  }
  const pct = p.percent_remaining
  let body = `积分剩${pct ?? "?"}%(${data.reset_date ?? "?"}刷新)`
  if (typeof pct === "number" && pct <= 0 && p.overage_permitted) {
    body = `积分已耗尽·超额计费中(${data.reset_date ?? "?"}刷新)`
  }
  if (data.gateway_exhausted) body = `月度池已耗尽(${data.reset_date ?? "?"}恢复)`
  if (data.stale) body += "·数据滞后"
  return `Copilot ${body}`
}

function dsBalanceCny(data: DeepseekQuota | null): number | null {
  const bal = data?.balances
  if (!Array.isArray(bal) || bal.length === 0) return null
  let sum = 0
  let any = false
  for (const b of bal) {
    if (b.currency !== "CNY") continue
    const v = Number.parseFloat(b.total_balance)
    if (Number.isFinite(v)) {
      sum += v
      any = true
    }
  }
  return any ? sum : null
}

function dsBrief(data: DeepseekQuota | null, lowWarnCny?: number): string | null {
  if (!data || data.status !== "ok") return null
  if (data.exhausted) return "DeepSeek 余额已耗尽"
  // [2026-08-28]-[余额预警：低于阈值横幅提示，仅预警不硬拦（按量计费）]
  const cny = dsBalanceCny(data)
  const thr = typeof lowWarnCny === "number" && lowWarnCny >= 0 ? lowWarnCny : 10
  if (typeof cny === "number" && cny < thr) {
    return `DeepSeek 余额 ¥${cny.toFixed(2)}（<¥${thr} 预警）`
  }
  return null // 按量正常不打扰
}

function levelLine(input: BannerInput): string {
  const segs: string[] = []
  const glm = glmBrief(input.quota.glm)
  if (glm) segs.push(glm)
  const cp = copilotBrief(input.quota.copilot)
  if (cp) segs.push(cp)
  const ds = dsBrief(input.quota.deepseek ?? null, input.dsLowWarnCny)
  if (ds) segs.push(ds)
  if (input.quota.glm === null && input.quota.copilot === null) segs.push("配额未知(查询关闭或不可用)")
  segs.push(`${input.billing.glmLabel} · ${input.billing.dsLabel}`)
  if (input.advice) segs.push(`建议: ${input.advice}`)
  return `[水位] ${segs.join(" | ")}`
}

function limitLine(down: Set<string> | string[], unknownCount?: number): string {
  const arr = Array.isArray(down) ? down : [...down]
  const names = arr.map((n) => (n.includes("-mx-") ? shortName(n) : n)).sort()
  const downTxt = names.length === 0 ? "无" : `${names.join("、")}（不可派发，deny 会附改派）`
  let line = `[限制] down: ${downTxt} | reviewer 须异族（producer family ≠ 壳 family，ROUTE_META 校验） | DeepSeek 仅链尾兜底`
  if (unknownCount && unknownCount > 0) line += ` | ${unknownCount} 个组合状态未知（不拦截）`
  return line
}

/** 四行横幅（逐行可解析端口契约） */
export function buildBanner(input: BannerInput): string[] {
  const lines = [
    routeLine(input.lanes),
    levelLine(input),
    limitLine(input.down, input.states ? countUnknown(input) : undefined),
  ]
  if (input.update) lines.push(`[更新] ${input.update}`)
  return lines
}

function countUnknown(input: BannerInput): number {
  const matrixUnknown = (input as any)._unknownCount
  return typeof matrixUnknown === "number" ? matrixUnknown : 0
}
