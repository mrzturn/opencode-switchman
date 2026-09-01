// 用户配置的稳定策略别名；不把 OpenCode provider ID 泄漏进配置文件。
// [2026-08-31]-[去厂商化编排：内置表降级为「配额抓取基础设施＋出厂配置数据」，不再承载排序规则；
//  providers 接受任意键（opencode 官方/用户自定义 provider），billing 显式配置驱动订阅计分系数，
//  池（Pool）概念仅保留给配额抓取（有抓取器的 provider 才有水位数据）]
import type { Pool } from "./types"

export type ProviderKey = "deepseek" | "zhipuai-coding-plan" | "github-copilot"
export type BillingKind = "subscription" | "api"
export interface PeakRange { days: number[]; start: string; end: string }
export interface ProviderUserConfig { enabled: boolean; observe: boolean; billing: BillingKind; peak: { timezone: string; ranges: PeakRange[] } }

const SPECS: Array<{ key: ProviderKey; pool: Pool; aliases: string[]; defaults: ProviderUserConfig }> = [
  // billing 是出厂配置数据（同 peak 高峰表性质），不是编排规则：订阅计费的两家出厂即标 subscription，
  // 用户可在 jsonc 里改；自定义 provider 一律默认 api。
  { key: "deepseek", pool: "deepseek", aliases: ["deepseek", "deepseek-api"], defaults: { enabled: false, observe: true, billing: "api", peak: { timezone: "local", ranges: [{ days: [1, 2, 3, 4, 5], start: "09:00", end: "12:00" }, { days: [1, 2, 3, 4, 5], start: "14:00", end: "18:00" }] } } },
  { key: "zhipuai-coding-plan", pool: "glm", aliases: ["zhipuai-coding-plan", "glm-coding-plan-cn", "glm", "zai"], defaults: { enabled: false, observe: true, billing: "subscription", peak: { timezone: "local", ranges: [{ days: [1, 2, 3, 4, 5], start: "14:00", end: "18:00" }] } } },
  { key: "github-copilot", pool: "copilot", aliases: ["github-copilot", "github-copilot-oauth", "copilot"], defaults: { enabled: false, observe: true, billing: "subscription", peak: { timezone: "local", ranges: [] } } },
]

export const PROVIDER_KEYS = SPECS.map((s) => s.key) as ProviderKey[]

export function poolForProviderId(id: string): Pool | null {
  const s = SPECS.find((x) => x.aliases.includes(id) || (x.pool === "glm" && /^(zhipuai|glm|zai)/.test(id)) || (x.pool === "copilot" && id.includes("copilot")))
  return s?.pool ?? null
}

export function providerKeyForPool(pool: Pool): ProviderKey { return SPECS.find((s) => s.pool === pool)!.key }

/** 配置键归一：命中内置别名/前缀返回内置规范键，否则原样返回（自定义 provider 键合法） */
export function resolveProviderKey(id: string): ProviderKey | string {
  const exact = SPECS.find((x) => x.aliases.includes(id))
  if (exact) return exact.key
  if (/^(zhipuai|glm|zai)/.test(id)) return "zhipuai-coding-plan"
  if (id.includes("copilot")) return "github-copilot"
  return id
}

/** 内置规范键集合（用于近似拼写建议） */
export function canonicalKeyOf(id: string): ProviderKey | null {
  const resolved = resolveProviderKey(id)
  return PROVIDER_KEYS.includes(resolved as ProviderKey) ? resolved as ProviderKey : null
}

/** 自定义 provider 出厂缺省：不参与路由、可观察、api 计费、无高峰窗口 */
export function genericProviderDefaults(): ProviderUserConfig {
  return { enabled: false, observe: true, billing: "api", peak: { timezone: "local", ranges: [] } }
}

/** 出厂 billing（gen-shells 生成期无用户配置时的 billing 系数来源） */
export function defaultBillingOf(providerId: string): BillingKind {
  const key = canonicalKeyOf(providerId)
  return key ? SPECS.find((s) => s.key === key)!.defaults.billing : "api"
}

export function defaultProviderConfig(): Record<ProviderKey, ProviderUserConfig> {
  return Object.fromEntries(SPECS.map((s) => [s.key, structuredClone(s.defaults)])) as Record<ProviderKey, ProviderUserConfig>
}

/** 生成文件的稳定正文，注释是用户配置体验的一部分。 */
export function renderDefaultConfigJsonc(): string {
  return `{
  // JSON Schema 仅用于编辑器提示；插件自身做 fail-open 校验。
  "$schema": "https://raw.githubusercontent.com/mrzturn/opencode-switchman/main/schema/opencode-switchman-v1.schema.json",
  // 配置语义版本（当前 1）；升级时插件仅在内存逐级迁移。
  "version": 1,
  "providers": {
    // 任意 opencode 官方/自定义 provider 键均合法（未命中内置表按自定义处理，billing 默认 api）。
    "deepseek": {
      // 水位/高峰/耗尽是否参与路由排序与硬拦；false 不影响查询与展示。
      "enabled": false,
      // 是否后台查询用量/余额并展示在横幅。
      "observe": true,
      // 计费结构：subscription（订阅，评分系数 1.0）/ api（按量，系数 0.85 排序靠后）；仅此处显式声明生效。
      "billing": "api",
      "peak": {
        // "local" 或 IANA 时区（如 "Asia/Shanghai"）。
        "timezone": "local",
        // days 用 ISO 周：1=周一…7=周日；区间 [start,end)；start>end 表示跨到次日。
        "ranges": [
          { "days": [1,2,3,4,5], "start": "09:00", "end": "12:00" },
          { "days": [1,2,3,4,5], "start": "14:00", "end": "18:00" }
        ]
      }
    },
    "zhipuai-coding-plan": {
      "enabled": false,
      "observe": true,
      "billing": "subscription",
      "peak": {
        "timezone": "local",
        "ranges": [
          { "days": [1,2,3,4,5], "start": "14:00", "end": "18:00" }
        ]
      }
    },
    "github-copilot": {
      "enabled": false,
      "observe": true,
      "billing": "subscription",
      "peak": {
        "timezone": "local",
        // 保留结构供后续扩展；当前不参与评分与展示。
        "ranges": []
      }
    }
  },
  // ---- 行为段：除插件安装（opencode 配置的 plugin 数组）外，全部插件配置都在本文件 ----
  "quota": {
    // GLM 5 小时窗预留水位（%）：达到即硬拦 GLM 壳（避免 429）；周额度仍只认 100%。
    "glmFiveHourReservePct": 90,
    // DeepSeek 余额预警阈值（CNY 元）：低于该值在横幅 [水位] 提示；仅预警不硬拦（按量计费）。
    "deepseekLowBalanceWarnCny": 10
  },
  // models.dev 价格快照是否作为加权评分系数之一。
  "cost": { "enabled": true },
  // 动态能力分级：auto=有 apiKey 先 AA、失败/无 key 转 OpenRouter；tierThresholds 缺省走内置分位映射。
  "capability": {
    "enabled": true,
    "source": "auto",
    // Artificial Analysis Data API key（也可走环境变量 ARTIFICIAL_ANALYSIS_API_KEY）；无 key 自动转 OpenRouter 公开源。
    // "apiKey": "aa_xxx",
    "lmarenaCheck": false
  },
  // 激活矩阵：auto=按客户端判定 desktop/cli；legacy=静态 shells.json；watch=监听配置面变化实时重算（改 watch 需重启）。
  "matrix": { "mode": "auto", "watch": true },
  // 四行路由横幅 / 调度员规程（AGENTS.md）系统提示注入。
  "banner": { "enabled": true },
  "rules": { "enabled": true },
  // 自定义六档候选链（覆盖内置偏好序）；键=economy/mechanical/main/hard/vision/review，值为壳名数组。
  "lanes": {},
  // 第三方/未来扩展数据放命名空间键，不进 providers。
  "extensions": {}
}
`
}
