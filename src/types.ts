// opencode-switchman 类型与契约（六档壳矩阵编排）
// [2026-08-31]-[去厂商化：Pool 降级为「配额抓取基础设施」概念（有抓器的 provider 才有水位数据），
//  禁止参与排序/门控/链生成；编排规则只消费 billing/unknown 等配置驱动系数]
import type { ScoreBreakdown } from "./scoring"

export type Lane = "economy" | "mechanical" | "main" | "hard" | "vision" | "review"
export const LANE_ORDER: Lane[] = ["economy", "mechanical", "main", "hard", "vision", "review"]

/** 配额基础设施池（仅配额抓取/水位展示用；编排规则零厂商硬编码） */
export type Pool = "copilot" | "glm" | "deepseek"
export const POOLS: Pool[] = ["copilot", "glm", "deepseek"]

export type Role =
  | "planner" | "reviewer" | "programmer" | "tester" | "uiux" | "data-analyst"
  | "ops" | "scouter" | "clerk" | "observer"
  | "expert-alpha" | "expert-beta" | "expert-gamma" | "generic"

export type Family = "glm" | "claude" | "gemini" | "gpt" | "grok" | "deepseek"
export type Capability = "ro" | "rw"
export type Modality = "text" | "image"
export type MetaSource = "auto" | "user"

// ROUTE_META 合法值表（与 delegation-template 同源；producer_family 禁池名 main/gcp/copilot）
export const META_KEYS = ["lane", "role", "producer_family", "capability", "modality", "source"] as const
export type MetaKey = (typeof META_KEYS)[number]
export const META_LEGAL: Record<MetaKey, readonly string[]> = {
  lane: LANE_ORDER,
  role: ["planner", "reviewer", "programmer", "tester", "uiux", "data-analyst",
    "ops", "scouter", "clerk", "observer",
    "expert-alpha", "expert-beta", "expert-gamma", "generic"],
  producer_family: ["glm", "claude", "gemini", "gpt", "grok", "deepseek"],
  capability: ["ro", "rw"],
  modality: ["text", "image"],
  source: ["auto", "user"],
}
export const META_REQUIRED: MetaKey[] = ["source", "role", "capability"]
export const META_SAMPLE =
  'ROUTE_META {"lane":"main","role":"programmer","producer_family":"glm","capability":"rw","modality":"text","source":"auto"}'

export type MetaValue = string
export interface Meta {
  lane?: string
  role?: string
  producer_family?: string
  capability?: string
  modality?: string
  source?: string
}
export type MetaErr =
  | "missing"
  | "malformed"
  | { kind: "invalid"; field: string; value: string }
  | { kind: "required"; field: string }

// 壳清单（shells.json 静态条目）
export interface ShellManifestEntry {
  name: string
  pool: Pool
  provider: string
  modelId: string
  effort: string
  family: Family
  capability: Capability
  vision: boolean
  matrixKey: string // provider|modelId|effort
}

// ---- 动态激活矩阵（v1.3）----
export type ModelKey = `${string}/${string}`
export type MatrixRunMode = "desktop" | "cli" | "legacy"
export type MatrixConfigStatus = "ok" | "empty" | "unreadable"

export interface ActivationState {
  generation: number
  mode: MatrixRunMode
  configStatus: MatrixConfigStatus
  configured: ModelKey[] // desktop: visibility==="show"；cli: favorite[]
  sessionModels: ModelKey[] // 活跃非壳非内部会话的模型（多会话并集）
  activeModels: ModelKey[] // configured ∪ sessionModels
  activeShells: string[] // activeModels 展开的壳名
  restartRequired: string[] // 超集外 providerID 去重（壳注册需重启）
  // [2026-09-01]-[加固：favorites/可见集里 provider 已知但 modelId 在超集中查无对应壳的脏数据（如手滑
  // 收藏了不存在的 "provider/not-a-model"），既不贡献壳也不该静默消失——记下来供横幅/日志提示，帮用户定位]-
  invalidConfigured: ModelKey[]
}

// 闸1 动态三层注入（gates 快照可选字段；缺省＝legacy 路径不启用）
export interface ActivationGateInfo {
  enabled: boolean
  activeShells: Set<string> | null
  conflicts: Set<string> | null
  restartRequired: string[]
}

// 运行时注册表视图 = 清单 × 探针矩阵 × 凭据在场
export interface ShellRegEntry extends ShellManifestEntry {
  status: "enabled" | "disabled"
  disabledReason?: string
  comboKey: string
}

// 探针矩阵条目
// [2026-08-29]-[评分引擎：新增 "strained"（429 限流类瞬时限流新状态，健康系数 0.6 而非出局）]
export interface MatrixEntry {
  status: "ok" | "strained" | "down" | "unknown" | "missing" | "unprobed"
  reason?: string
  latency_ms?: number | null
  checked_at?: string
}
export interface Matrix {
  combos: Record<string, MatrixEntry>
  generated_at?: string | null
  /** [2026-08-29]-[动态矩阵 v1.3：当前激活组合与目标代数（matrix-manager 维护）] */
  active_keys?: string[]
  target_generation?: number
}

// 熔断状态
export interface Routing {
  down_agents: Record<string, string>
  down_expiry: Record<string, number>
  unknown_agents?: Record<string, string>
  updated_at?: string
}

// GLM 配额缓存（glm-quota.json）
export interface GlmScope { used_pct?: number | null; reset_at?: number | null }
export interface GlmQuota {
  status: "ok" | "unknown"
  reason?: string
  fetched_at: number
  stale?: boolean
  level?: string
  five_hour?: GlmScope
  weekly?: GlmScope
  mcp_monthly?: { used?: unknown; total?: unknown; used_pct?: number | null; reset_at?: number | null }
}

// Copilot premium 积分快照（归一化后；数值字段缺失=null）
export interface PremiumSnapshot {
  quota_id: string
  entitlement: number | null
  used: number | null
  remaining: number | null
  percent_remaining: number | null
  unlimited: boolean
  overage_permitted: boolean
  has_quota: boolean | null
  timestamp_utc: string | null
}
export interface CopilotQuota {
  status: "ok" | "unknown"
  reason?: string
  fetched_at: number
  stale?: boolean
  login?: string | null
  plan?: string | null
  sku?: string | null
  reset_date?: string | null
  premium?: PremiumSnapshot | null
  gateway_exhausted?: boolean // 网关 429/quota 错误体第二真值源，信任至 reset_date
}

// DeepSeek 余额缓存
export interface DsBalance { currency: string; total_balance: string }
export interface DeepseekQuota {
  status: "ok" | "unknown"
  reason?: string
  fetched_at: number
  stale?: boolean
  balances?: DsBalance[]
  exhausted?: boolean
}

// 池水位状态（pool_states 评估结果）
export type PoolStateKind = "surplus" | "healthy" | "strained"
export interface GlmStateInfo {
  state: PoolStateKind
  five_hour_pct?: number | null
  weekly_pct?: number | null
  weekly_hours_left?: number | null
}
export interface CopilotStateInfo {
  state: PoolStateKind
  remaining?: number | null
  days_left?: number | null
  runway_days?: number | null
  waste_est?: number | null
}

// 计费窗口（可配置，默认口径：GLM 高峰=工作日 14-18；DS 高峰=工作日 9-12+14-18）
export interface BillingWindowConfig {
  glmPeakHours?: [number, number]
  dsPeakRanges?: Array<[number, number]>
}
export interface BillingWindow { glmPeak: boolean; dsPeak: boolean; glmLabel: string; dsLabel: string }
export type RoutePolicy = Record<Pool, { observe: boolean; routing: boolean }>

// 六档选链结果
export interface ChainCandidate {
  shell: string
  pool: Pool | string
  family: Family | null
  effort: string | null
  capability: Capability | null
  vision: boolean | null
  latency_ms: number | null
  /** [2026-08-29]-[评分引擎：组内乘积分明细（normal 档；immediate/评分失败回退时为 undefined），供决策日志追溯] */
  score?: ScoreBreakdown
}
export interface DroppedCandidate { shell: string; reason: string }
export interface LaneResult {
  lane: Lane
  status: string // ok | exhausted | ok*（* = registry/矩阵缺失 fail-open 降级标记）
  chain: ChainCandidate[]
  dropped: DroppedCandidate[]
}

// 六闸快照（gates 输入，全部由调用方装配——纯函数无 IO）
export interface GateSnapshot {
  registry: Record<string, ShellRegEntry> | null
  matrix: Record<string, MatrixEntry> | null
  routing: Routing | null
  quotaExhausted: Partial<Record<Pool, boolean>>
  routePolicy?: RoutePolicy
  costs?: (modelId: string) => number | null
  activation?: ActivationGateInfo | null
  /** 探针 ok 但实际委派失败的进程内短期隔离组合。 */
  realFailedCombos?: ReadonlySet<string>
  /** [2026-08-29]-[失败分类：连续 404 已退休模型集（provider/modelId），闸前 deny；仅动态矩阵注入] */
  retiredModels?: ReadonlySet<string>
  /** [2026-08-31]-[去厂商化：deny 附言候选排序与横幅同源（用户 jsonc billing/peak 解析）] */
  billingBoostOf?: (provider: string) => number
  peakOf?: (provider: string) => boolean
  /** [2026-08-31]-[终审P1-3：deny 附言候选与横幅排序同源的运行期输入（water/costs/glmPeak/states）] */
  water?: import("./scoring").WaterFactor
  glmPeak?: boolean | null
  states?: Record<string, { state?: PoolStateKind } & Record<string, unknown>> | null
}

// 插件 options（["opencode-switchman", {...}] 元组形式）
// [2026-08-31]-[动态能力分级：第三方权威指数（AA v2 主源/OpenRouter 备源）→ capability.json
//  （TTL 24h）→ baseScore 的 api 覆盖层；回退链＝实时 api → 随包内置默认排名（gen:capability
//  生成的官方排名快照，随版本手动迭代）→ 策展表；离线/429 fail-open 不阻塞委派]
export interface CapabilityTierThresholds { S?: number; A?: number; B?: number }
export interface CapabilityOptions {
  enabled?: boolean
  /** auto（默认）=有 apiKey 先 AA、失败/无 key 转 OpenRouter；也可显式指定单源 */
  source?: "auto" | "artificial-analysis" | "openrouter"
  /** Artificial Analysis Data API key（x-api-key；也可走 ARTIFICIAL_ANALYSIS_API_KEY 环境变量） */
  apiKey?: string
  /** 绝对阈值（默认 S>=62/A>=55/B>=45，intelligence index 0-100 口径）或 "quantile"（p80/p60/p40 分位） */
  tierThresholds?: CapabilityTierThresholds | "quantile"
  /** LMArena（api.wulong.dev ELO）可选交叉校验：仅日志告警不影响评分，默认 false */
  lmarenaCheck?: boolean
}
export interface GlmQuotaOptions {
  enabled?: boolean
  /** 5 小时窗预留水位（%）：达到即硬拦 GLM 壳，避免用满触发 429；默认 90，周额度仍只认 100% */
  fiveHourReservePct?: number
}
export interface DeepseekQuotaOptions {
  enabled?: boolean
  /** 余额预警阈值（CNY 元）：低于该值在横幅 [水位] 提示，默认 10；仅预警不硬拦（按量计费） */
  lowBalanceWarnCny?: number
}
export interface CopilotQuotaOptions { enabled?: boolean }
export interface MatrixOptions {
  /** auto（默认）=按 OPENCODE_CLIENT 判定 desktop/cli；app/tui 强制覆盖；legacy 完全走静态 shells.json */
  mode?: "auto" | "app" | "tui" | "legacy"
      /** 监听 opencode state 目录变更重算（默认 true；激活变化对派发闸「下一请求生效」，非实时改写已发请求） */
  watch?: boolean
}
// [2026-09-01]-[配置面统一收敛到 opencode-switchman.jsonc：元组 options 降级为兼容 shim
//  （显式配置优先一代并报 SWM044）；死字段 providers.*（凭证收集实际走 poolForProviderId）移除]
export interface SwitchmanOptions {
  quota?: { glm?: GlmQuotaOptions; deepseek?: DeepseekQuotaOptions; copilot?: CopilotQuotaOptions }
  cost?: { enabled?: boolean }
  billingWindow?: BillingWindowConfig
  banner?: { enabled?: boolean }
  /** 调度员规程系统提示注入（随包内置；关闭后依赖用户自行安装 AGENTS.md） */
  rules?: { enabled?: boolean }
  lanes?: Partial<Record<Lane, string[]>>
  matrix?: MatrixOptions
  capability?: CapabilityOptions
}
