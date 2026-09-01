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
  /** down 集合；Map 形态携带来源标注（如「熔断」「实调隔离·剩12m」），横幅逐名展示 */
  down: Set<string> | string[] | Map<string, string>
  quota: { glm: GlmQuota | null; copilot: CopilotQuota | null; deepseek?: DeepseekQuota | null }
  states?: Record<string, { state?: PoolStateKind } & Record<string, unknown>> | null
  billing: BillingWindow
  advice?: string | null
  update?: string | null
  dsLowWarnCny?: number
  providerPolicy?: Partial<Record<"glm" | "copilot" | "deepseek", { observe: boolean; routing: boolean }>>
  doctorSummary?: string | null
  /** [2026-08-29]-[动态矩阵：[限制] 行追加 模式/watch/configStatus、restartRequired、models.dev 降级标注；缺省=legacy 原样] */
  matrixInfo?: { mode: string; configStatus: string; watch: boolean; restartRequired?: string[]; invalidConfigured?: string[]; degradedModels?: number; retiredModels?: number } | null
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
  for (const pool of ["glm", "copilot", "deepseek"] as const) {
    const policy = input.providerPolicy?.[pool]
    if (policy?.observe === false) segs.push(`${pool === "glm" ? "GLM" : pool === "copilot" ? "Copilot" : "DeepSeek"} 查询关闭`)
    else if (policy && !policy.routing) segs.push(`${pool === "glm" ? "GLM" : pool === "copilot" ? "Copilot" : "DeepSeek"} 仅观察`)
  }
  if (input.quota.glm === null && input.quota.copilot === null && !input.providerPolicy) segs.push("配额未知(查询关闭或不可用)")
  segs.push(`${input.billing.glmLabel} · ${input.billing.dsLabel}`)
  if (input.advice) segs.push(`建议: ${input.advice}`)
  return `[水位] ${segs.join(" | ")}`
}

function limitLine(down: Set<string> | string[] | Map<string, string>, unknownCount?: number, matrixInfo?: BannerInput["matrixInfo"], doctorSummary?: string | null): string {
  // [2026-09-01]-[down 来源标注：Map 值＝来源（熔断/实调隔离·剩余时长），排查时可直接区分探针结论与内存隔离]
  const pairs: [string, string][] = down instanceof Map
    ? [...down.entries()]
    : (Array.isArray(down) ? down : [...down]).map((n) => [n, ""] as [string, string])
  const names = pairs
    .map(([n, note]) => `${n.includes("-mx-") ? shortName(n) : n}${note ? `（${note}）` : ""}`)
    .sort()
  const downTxt = names.length === 0 ? "无" : `${names.join("、")}（不可派发，deny 会附改派）`
  // [2026-08-31]-[去厂商化：删「DeepSeek 仅链尾兜底」池名商务语义——api/未知组由计费系数沉底]
  let line = `[限制] down: ${downTxt} | reviewer 须异族（producer family ≠ 壳 family，ROUTE_META 校验） | api 计费与未知模型按系数沉底（billing=subscription 显式配置优先）`
  if (unknownCount && unknownCount > 0) line += ` | ${unknownCount} 个组合状态未知（不拦截）`
  if (matrixInfo) {
    line += ` | 矩阵: ${matrixInfo.mode}${matrixInfo.watch ? "·watch" : ""}/${matrixInfo.configStatus}`
    if (matrixInfo.restartRequired && matrixInfo.restartRequired.length > 0) {
      line += ` | 新 provider ${matrixInfo.restartRequired.join("、")} 待重启注册`
    }
    if (matrixInfo.invalidConfigured && matrixInfo.invalidConfigured.length > 0) {
      // [2026-09-01]-[加固：收藏/可见集里有 provider 已知但 modelId 不存在的脏数据（如误收藏 "glm/a"），
      // 直接提示而非静默不生效，方便用户定位是收藏配错而非路由算法 bug]
      line += ` | 收藏含无效模型 ${matrixInfo.invalidConfigured.join("、")}（请检查 favorites）`
    }
    if (matrixInfo.degradedModels && matrixInfo.degradedModels > 0) {
      line += ` | models.dev 缺元数据：${matrixInfo.degradedModels} 模型降级单档 off`
    }
    if (matrixInfo.retiredModels && matrixInfo.retiredModels > 0) {
      line += `、${matrixInfo.retiredModels} 模型已下线`
    }
  }
  if (doctorSummary) line += ` | ${doctorSummary}`
  return line
}

/** 四行横幅（逐行可解析端口契约） */
export function buildBanner(input: BannerInput): string[] {
  const lines = [
    routeLine(input.lanes),
    levelLine(input),
    limitLine(input.down, input.states ? countUnknown(input) : undefined, input.matrixInfo ?? undefined, input.doctorSummary),
  ]
  if (input.update) lines.push(`[更新] ${input.update}`)
  return lines
}

function countUnknown(input: BannerInput): number {
  const matrixUnknown = (input as any)._unknownCount
  return typeof matrixUnknown === "number" ? matrixUnknown : 0
}
