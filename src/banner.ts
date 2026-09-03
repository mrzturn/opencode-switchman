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
  /** [2026-09-03]-[用户手动覆盖层标注（capability-rank.json/pool-config.json 生效条数；0=未配置不显示）] */
  overrides?: { rankModels: number; poolLanes: number } | null
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

/** GLM 重置时间（秒级 epoch → MM-DD HH:mm；缺失=稍后），横幅与侧边栏同款格式 */
function fmtResetMdHm(reset: number | null | undefined): string {
  const p = resetParts(reset)
  return p ? `${p.md} ${p.hm}` : "稍后"
}

function glmBrief(data: GlmQuota | null): string | null {
  if (!data || data.status !== "ok") return null
  const parts = ["GLM"]
  if (data.five_hour && typeof data.five_hour.used_pct === "number") parts.push(`5h窗 ${data.five_hour.used_pct}%`)
  if (data.weekly && typeof data.weekly.used_pct === "number") {
    parts.push(`周 ${data.weekly.used_pct}%(${fmtResetMdHm(data.weekly.reset_at)}刷新)`)
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

// [2026-09-02]-[侧边栏「水位/峰值」面板数据结构 v2：一个 provider 一个条目块，明细拆 rows 子行
//  （GLM=5h/周/MCP，Copilot=积分/刷新，DeepSeek=余额）——头部行渲染 label+状态标注，子行缩进带进度条，
//  修复此前 GLM 拆两块、标注逐行重复、窄边栏换行错乱的显示问题；observe=false 不产出该条目]
export interface ProviderStatusRow {
  /** 行首短标签（5h/周/MCP/积分/刷新/余额；空=占位整行文本） */
  label: string
  /** 主体文本（进度条+百分比/数值），TUI 按 usedPct 渐变着色 */
  text: string
  /** 0-100 用于绿→红渐变；null=中性色 */
  usedPct: number | null
  /** 行尾弱化补充（重置/刷新时间、预警） */
  tail?: string
}

export interface ProviderStatusEntry {
  pool: "glm" | "copilot" | "deepseek"
  label: string
  rows: ProviderStatusRow[]
  /** 仅观察（routing=false，不参与派发排序） */
  observeOnly: boolean
  /** 该 provider 计费高峰是否活跃 */
  peakActive: boolean
  /** 配额快照滞后（缓存超 TTL 进入 stale_ok 宽限），头部行一次性标注 */
  stale: boolean
}

const POOL_LABEL: Record<"glm" | "copilot" | "deepseek", string> = { glm: "GLM", copilot: "Copilot", deepseek: "DeepSeek" }
const POOL_PROVIDER_ID: Record<"glm" | "copilot" | "deepseek", string> = {
  glm: "zhipuai-coding-plan", copilot: "github-copilot", deepseek: "deepseek",
}

/** 8 格进度条（█ 已用 + ░ 余量），pct=null 返回空串（该行无数值概念时不画条） */
function bar8(pct: number | null | undefined): string {
  if (typeof pct !== "number" || Number.isNaN(pct)) return ""
  const p = Math.max(0, Math.min(100, pct))
  const filled = Math.round((p / 100) * 8)
  return "█".repeat(filled) + "░".repeat(8 - filled)
}

function resetParts(reset: number | null | undefined): { md: string; hm: string } | null {
  if (typeof reset !== "number") return null
  const d = new Date(reset * 1000)
  const pad = (n: number) => String(n).padStart(2, "0")
  return { md: `${pad(d.getMonth() + 1)}-${pad(d.getDate())}`, hm: `${pad(d.getHours())}:${pad(d.getMinutes())}` }
}

// ---- 侧边栏 rows 产出（[水位] 横幅 glmBrief/copilotBrief/dsBrief 紧凑单行口径不变）----

const NO_DATA_ROW: ProviderStatusRow[] = [{ label: "", text: "查询中/暂无数据", usedPct: null }]

function glmRows(data: GlmQuota | null): ProviderStatusRow[] {
  if (!data || data.status !== "ok") return NO_DATA_ROW
  const rows: ProviderStatusRow[] = []
  const push = (label: string, pct: number, reset: number | null | undefined, mode: "hm" | "mdhm" | "md") => {
    const parts = resetParts(reset)
    const tail = !parts ? "→稍后" : mode === "hm" ? `→${parts.hm}` : mode === "md" ? `→${parts.md}` : `→${parts.md} ${parts.hm}`
    rows.push({ label, text: `${bar8(pct)} ${pct}%`, usedPct: pct, tail })
  }
  // 5h 窗重置必在 5 小时内 → 只显 HH:mm；周窗跨天 → MM-DD HH:mm；MCP 月度 → MM-DD
  if (typeof data.five_hour?.used_pct === "number") push("5h", data.five_hour.used_pct, data.five_hour.reset_at, "hm")
  if (typeof data.weekly?.used_pct === "number") push("周", data.weekly.used_pct, data.weekly.reset_at, "mdhm")
  const mcp = data.mcp_monthly
  if (mcp && typeof mcp.used_pct === "number") push("MCP", mcp.used_pct, mcp.reset_at, "md")
  if (rows.length === 0) return [{ label: "", text: "无配额数据", usedPct: null }]
  return rows
}

function copilotRows(data: CopilotQuota | null): ProviderStatusRow[] {
  if (!data || data.status !== "ok") return NO_DATA_ROW
  const refresh: ProviderStatusRow = { label: "刷新", text: data.reset_date ?? "?", usedPct: null }
  if (data.gateway_exhausted) return [{ label: "积分", text: "月度池已耗尽", usedPct: 100 }, refresh]
  const p = data.premium
  if (!p) return [{ label: "", text: "无配额数据", usedPct: null }]
  if (p.unlimited) {
    const used = typeof p.used === "number" ? ` 已用${p.used}` : ""
    return [{ label: "积分", text: `不限量${used}`, usedPct: null }, refresh]
  }
  const pct = p.percent_remaining
  const usedPct = typeof pct === "number" ? Math.max(0, Math.min(100, 100 - pct)) : null
  const quotaTxt = typeof p.used === "number" && typeof p.entitlement === "number" ? ` ${p.used}/${p.entitlement}` : ""
  if (typeof pct === "number" && pct <= 0 && p.overage_permitted) {
    return [{ label: "积分", text: `已耗尽·超额计费中${quotaTxt}`, usedPct: 100 }, refresh]
  }
  const pctTxt = typeof pct === "number" ? (Number.isInteger(pct) ? pct : pct.toFixed(1)) : "?"
  return [{ label: "积分", text: `${bar8(usedPct)} 剩${pctTxt}%${quotaTxt}`, usedPct }, refresh]
}

function dsRows(data: DeepseekQuota | null, lowWarnCny?: number): ProviderStatusRow[] {
  if (!data || data.status !== "ok") return NO_DATA_ROW
  if (data.exhausted) return [{ label: "余额", text: "已耗尽", usedPct: 100 }]
  const cny = dsBalanceCny(data)
  if (cny === null) return [{ label: "余额", text: "未知（按量计费）", usedPct: null }]
  const thr = typeof lowWarnCny === "number" && lowWarnCny >= 0 ? lowWarnCny : 10
  // 按量计费无「总额」概念：以预警阈值 3 倍作为「余量充裕」锚点做相对渐变，仅用于着色不作为精确指标
  const usedPct = Math.max(0, Math.min(100, 100 - (cny / (thr * 3)) * 100))
  return [{ label: "余额", text: `${bar8(usedPct)} ¥${cny.toFixed(2)}`, usedPct, tail: cny < thr ? ` <¥${thr} 预警` : undefined }]
}

export interface ProviderStatusInput {
  quota: BannerInput["quota"]
  providerPolicy?: BannerInput["providerPolicy"]
  dsLowWarnCny?: number
  /** 去厂商化：任意 provider 的计费高峰活跃求值（config.ts billingWindowForConfig 同源） */
  peakOf?: (providerId: string) => boolean
}

export function providerStatusEntries(input: ProviderStatusInput): ProviderStatusEntry[] {
  const out: ProviderStatusEntry[] = []
  for (const pool of ["glm", "copilot", "deepseek"] as const) {
    const policy = input.providerPolicy?.[pool]
    if (policy?.observe === false) continue // observe:false → 不显示该块
    let rows: ProviderStatusRow[]
    let stale = false
    if (pool === "glm") {
      rows = glmRows(input.quota.glm)
      stale = input.quota.glm?.stale === true
    } else if (pool === "copilot") {
      rows = copilotRows(input.quota.copilot)
      stale = input.quota.copilot?.stale === true
    } else {
      rows = dsRows(input.quota.deepseek ?? null, input.dsLowWarnCny)
      stale = input.quota.deepseek?.stale === true
    }
    out.push({
      pool,
      label: POOL_LABEL[pool],
      rows,
      observeOnly: policy ? policy.routing === false : false,
      peakActive: input.peakOf ? Boolean(input.peakOf(POOL_PROVIDER_ID[pool])) : false,
      stale,
    })
  }
  return out
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

function limitLine(down: Set<string> | string[] | Map<string, string>, unknownCount?: number, matrixInfo?: BannerInput["matrixInfo"], doctorSummary?: string | null, overrides?: BannerInput["overrides"]): string {
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
      // [2026-09-01]-[加固：收藏/可见集里有 provider 已知但 modelId 不存在的脏数据，
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
  if (overrides && (overrides.rankModels > 0 || overrides.poolLanes > 0)) {
    const parts: string[] = []
    if (overrides.rankModels > 0) parts.push(`手动能力排名 ${overrides.rankModels} 模型`)
    if (overrides.poolLanes > 0) parts.push(`任务池选配 ${overrides.poolLanes} 池`)
    line += ` | ${parts.join("、")}生效（/modelRank /poolConfig 可调）`
  }
  return line
}

/** 四行横幅（逐行可解析端口契约） */
export function buildBanner(input: BannerInput): string[] {
  const lines = [
    routeLine(input.lanes),
    levelLine(input),
    limitLine(input.down, input.states ? countUnknown(input) : undefined, input.matrixInfo ?? undefined, input.doctorSummary, input.overrides ?? undefined),
  ]
  if (input.update) lines.push(`[更新] ${input.update}`)
  return lines
}

function countUnknown(input: BannerInput): number {
  const matrixUnknown = (input as any)._unknownCount
  return typeof matrixUnknown === "number" ? matrixUnknown : 0
}
