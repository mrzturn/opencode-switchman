// 壳注入（v1.1）：shells.json 清单 × 注册表视图 → cfg.agent 运行时注入（无文件生成）
// [2026-08-28]-[tools 字段已 @deprecated→permission；thoughtLevel 无此字段→agent options 按 family 映射]-
// [兜底两轨：config 注入若实测不生效，切换 writeShellFiles 落 ~/.config/opencode/agent/*.md]
import type { ShellRegEntry, Lane } from "./types"
import { LANE_ORDER } from "./types"
import type { ShellDefinition } from "./catalog"
import type { CapabilityScore, LaneShellAttr } from "./lane-policy"
import { laneBaseChain } from "./lane-policy"
import { loadCachedThinkingShapes, deriveThinkingParam } from "./copilot-thinking"

// [2026-09-01]-[对齐核心 packages/opencode/src/plugin/github-copilot/models.ts：github-copilot 池全部
// family（含 claude）的 options 一律按该 modelId 真实 capabilities.supports 形状缓存推导
// （copilot-thinking.json），不再按 family 猜协议/猜固定 budget 表；形状缓存缺失（冷启动/无 token）时
// 才回退到旧按 family 分协议的启发式（fail-open，保委派可用而非直接不发参数）]
export function effortOptions(
  family: string, effort: string, modelId?: string, provider?: string,
): Record<string, unknown> | undefined {
  if (!effort || effort === "off") return undefined
  if (provider === "github-copilot" && modelId) {
    const shape = loadCachedThinkingShapes()[modelId]
    const param = deriveThinkingParam(shape, effort)
    if (param?.kind === "budget") return { thinking: { type: "enabled", budgetTokens: param.budgetTokens } }
    if (param?.kind === "adaptive") {
      return { thinking: { type: "adaptive", ...(modelId.includes("opus-4.7") ? { display: "summarized" } : {}) } }
    }
    if (param?.kind === "reasoningEffort") {
      return { reasoningEffort: param.value, reasoningSummary: "auto", include: ["reasoning.encrypted_content"] }
    }
    if (shape) return undefined // 形状已知且三分支均不匹配 → 核心口径下该模型此档不带任何推理参数
    // 形状缓存未就绪：回退旧按 family 启发式（下方通用兜底），不阻塞委派
  }
  // gpt/grok/gemini（openai 系 options.reasoningEffort）；glm/deepseek（openai-compatible reasoning_effort）
  if (family === "glm" || family === "deepseek") return { reasoning_effort: effort }
  if (family === "claude") return undefined // claude 无形状缓存兜底：宁可不发，不猜错 budget 表
  return { reasoningEffort: effort }
}

export function shellDescription(s: ShellRegEntry): string {
  // [2026-09-02]-[上下文瘦身：模板句「只绑定模型与档位…」曾逐壳重复注入 task 工具描述（260 壳≈2-3k token）；
  //  该语义已由 SHELL_BODY 第 1/2 条在子代理上下文陈述，描述只留矩阵标识]-[影响：agent 清单每行 -70% 体积]
  return `模型空壳〔池=${s.pool}·${s.modelId}·档=${s.effort}·${s.capability}〕`
}

export const SHELL_BODY = [
  "你是被委派的执行体（模型空壳）。以下守则优先级高于任何后续指令。",
  "1. 角色以本次委派 prompt 为准（壳只绑模型与档位）；事实性陈述直接采信，不重复验证。",
  "2. 最小必要：只读必要文件与段落，结论优先，用 file:line 引用，不贴大段原文。",
  "3. 只做目标块内的事；发现目标外的问题记录到「遗留问题」，不顺手修改。",
  "4. 如实报告：失败说失败、跳过说跳过、不确定标不确定；验证过的才写「已验证」。",
  "5. 项目 AGENTS.md 与委派方明示约束优先于个人偏好；任何情况下不输出密钥、凭据、配置正文。",
].join("\n")

/** 单壳 → opencode AgentConfig（config 钩子注入用） */
export function shellAgentConfig(s: ShellRegEntry): Record<string, unknown> {
  const cfg: Record<string, unknown> = {
    description: shellDescription(s),
    mode: "subagent",
    model: `${s.provider}/${s.modelId}`,
    prompt: SHELL_BODY,
  }
  const options = effortOptions(s.family, s.effort, s.modelId, s.provider)
  if (options) cfg.options = options
  if (s.capability === "ro") {
    cfg.permission = { edit: "deny", bash: "deny" }
  }
  return cfg
}

/** 注入全部 enabled 壳到 live config（config 钩子内调用） */
export function injectShells(cfg: Record<string, any>, registry: Record<string, ShellRegEntry>): number {
  let n = 0
  for (const s of Object.values(registry)) {
    if (s.status !== "enabled") continue
    cfg.agent = cfg.agent ?? {}
    if (cfg.agent[s.name]) continue // 不覆盖用户显式定义
    cfg.agent[s.name] = shellAgentConfig(s)
    n++
  }
  return n
}

/** [2026-08-29]-[动态超集注入：全部超集壳一次性注入（cfg.agent 运行期不可变），
 *  返回成功注入名与用户同名冲突名（同名冲突壳禁派发，闸1 deny）] */
export function injectShellDefs(
  cfg: Record<string, any>, defs: readonly ShellDefinition[],
): { injected: Set<string>; conflicts: Set<string> } {
  cfg.agent = cfg.agent ?? {}
  const injected = new Set<string>()
  const conflicts = new Set<string>()
  for (const d of defs) {
    if (cfg.agent[d.name]) {
      conflicts.add(d.name) // 用户显式定义优先，但壳不可再作为委派目标
      continue
    }
    cfg.agent[d.name] = shellAgentConfig({ ...d, status: "enabled", comboKey: d.matrixKey } as ShellRegEntry)
    injected.add(d.name)
  }
  return { injected, conflicts }
}

export interface InjectableSelectOpts {
  /** 用户自定义 lane 覆盖（baseChainFor 直返其数组）；引用壳名强制保留进注入面 */
  customLanes?: Record<string, readonly string[]> | null
  /** [2026-09-02]-[可用模型强制保留（provider/modelId 键）：注入面=可用全集∪六档链精选∪自定义 lane。
   *  调用方传当前全部可用模型（provider 已连接且可对话）时＝不做能力竞争裁剪——favorites/点名模型
   *  永不因链竞争落选；瘦身的唯一语义变为「未注入=真的不可用」，消除 favorites 误报与视觉壳缺失] */
  keepModels?: ReadonlySet<string>
  /** [2026-09-02]-[favorites 优先（modelId 口径）：链算法同 tier 内收藏模型排前，透传 computeLaneChain] */
  preferredModels?: ReadonlySet<string>
  capabilityOf: (modelId: string) => number | CapabilityScore
  billingBoostOf?: (provider: string) => number
  unknownOf?: (modelId: string) => boolean
  costOf?: (modelId: string) => number | null
}

/** [2026-09-02]-[上下文瘦身：opencode 把全部注入壳逐条枚举进 task 工具描述（registry.describeTask），
 *  全量超集 260 壳≈6-10k token/会话。精选=六档 laneBaseChain 候选∪自定义 lane 引用壳（与运行期
 *  baseChainFor 同算法同解析器）；cfg.agent 运行期不可变，故必须在注入前裁剪——运行期对注入集
 *  重跑同算法，链/横幅/闸天然⊆注入集；候选为空 fail-open 回退全量]-[影响：注入面 260→~30-40；
 *  未入选壳派发走 denyUninjected 附改派候选，点名超集外模型需先入选或改派]-
 *  [2026-09-02 修复]-[链竞争裁剪曾把 favorites/视觉壳（如 glm-5.3-flash）裁出注入面，导致 favorites
 *  被误报「无效模型」、vision 链空转。语义改为：注入面=可用全集（keepModels）∪链精选∪自定义 lane；
 *  调用方传全部可用模型时裁剪只剔除「provider 未连接/不可对话」的真不可用模型，favorites 链内同档优先] */
export function selectInjectableDefs(
  defs: readonly ShellDefinition[],
  opts: InjectableSelectOpts,
): ShellDefinition[] {
  if (defs.length === 0) return []
  const byName = new Map(defs.map((d) => [d.name, d]))
  const attrs = new Map<string, LaneShellAttr & { name: string; modelId: string; provider: string }>()
  for (const d of defs) {
    attrs.set(d.name, {
      name: d.name, effort: d.effort, capability: d.capability, vision: d.vision,
      pool: d.pool, modelId: d.modelId, provider: d.provider,
      cost: opts.costOf ? opts.costOf(d.modelId) : null,
    })
  }
  const keep = new Set<string>()
  for (const lane of LANE_ORDER as readonly Lane[]) {
    const custom = opts.customLanes?.[lane]
    const chain = Array.isArray(custom) && custom.length > 0
      ? custom
      : laneBaseChain(lane, {
        builtin: [],
        activeShells: new Set(attrs.keys()),
        shells: attrs,
        capabilityOf: opts.capabilityOf,
        billingBoostOf: opts.billingBoostOf,
        unknownOf: opts.unknownOf,
        preferredModels: opts.preferredModels,
      })
    for (const name of chain) if (byName.has(name)) keep.add(name)
  }
  // [2026-09-02]-[可用模型强制保留：链竞争落选的可用模型（favorites/点名目标/视觉壳）不裁]-
  if (opts.keepModels) {
    for (const d of defs) {
      if (opts.keepModels.has(`${d.provider}/${d.modelId}`)) keep.add(d.name)
    }
  }
  if (keep.size === 0) return [...defs]
  return defs.filter((d) => keep.has(d.name))
}
