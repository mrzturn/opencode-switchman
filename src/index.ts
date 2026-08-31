// opencode-switchman 插件入口——唯一 OpenCode API 适配层（v1.2）
// 钩子面：config(壳注入+凭证收集+/handover 命令注入) / chat.params(会话→agent 映射) /
//         experimental.chat.system.transform(调度员规程＋横幅注入，壳子代理跳过) /
//         tool.execute.before(六闸 deny) / event(失败记账→熔断) / tool(handover 交接工具)
// [fail-open 铁律：任何钩子异常只写 stderr，绝不阻塞主流程；核心逻辑全部在纯函数层]
import type { Plugin } from "@opencode-ai/plugin"
import { writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { AGENTS_MD } from "./assets/agents-md"
import { DELEGATION_TEMPLATE } from "./assets/delegation-template"
import { createHandoverTool, HANDOVER_COMMAND_TEMPLATE, HANDOVER_COMMAND_DESCRIPTION } from "./handover"
import {
  loadContext, buildRegistry, loadManifest, laneShells, paths,
  cleanExpired, ensureStateDir, stateDir, loadSupersetShells, writeJsonAtomic,
} from "./state"
import { checkShell, noteUnknownAgent, shellLikeName, denyUninjected } from "./gates"
import {
  computeLane, billingWindow, billingWindowForConfig, poolStates, routingAdvice,
  glmExhausted, copilotExhausted, deepseekExhausted, firstCandidate,
} from "./lane"
import { logDecision, BILLING_API_BOOST } from "./scoring"
import type { WaterFactor, DecisionRecord } from "./scoring"
import { quotaView, readAuthStore, markCopilotGatewayExhausted } from "./quota"
import { costOf, refreshCosts, costsStale } from "./cost"
import { baseScoreDynamic, refreshCapability, capabilityStale } from "./capability"
import { refreshMatrixIfStale, refreshActiveMatrixIfStale, probeKeys } from "./probe"
import { injectShells, injectShellDefs } from "./shells"
import { buildBanner } from "./banner"
import { refreshSelfUpdate, updateBannerText, ensureUpdateCommands, detectLoadMode } from "./selfupdate"
import { billingOfProvider, loadUserConfig, routingPeakActive, routePolicy } from "./config"
import { poolForProviderId } from "./provider-config"
import { runDoctor } from "./doctor"
import {
  recordFailure, cleanRoutingExpired, markRealFailure, realFailedComboKeys,
  REAL_FAIL_TTL_MS, RATE_LIMIT_TTL_MS, noteModelNotFound, retiredModelKeys, filterRetiredShells,
} from "./breaker"
import { classifyFailure } from "./failclass"
import { LANE_ORDER } from "./types"
import type { SwitchmanOptions, Lane, LaneResult, Pool, ShellRegEntry, ModelKey } from "./types"
import { detectMode, readConfigured, normalizeProviderListResponse } from "./activation"
import type { MatrixModeOption } from "./activation"
// [2026-08-29]-[事件/参数形状提取纯函数迁至 helpers.ts：入口禁导出非插件函数，否则
//  opencode 会把它们当插件工厂调用产生 null hooks，炸掉 config 钩子与 provider.list]-[修复启动报错]
import { chatParamsModelKey, sessionDeletedId, sessionCreatedInfo } from "./helpers"
import { MatrixManager } from "./matrix-manager"
import { syncIfDiverged } from "./sync"
import { laneBaseChain } from "./lane-policy"
import {
  buildShells, loadCatalog, bundledModelIndex, isConversational, toManifestEntry,
} from "./catalog"
import type { ShellDefinition, EffortInfo } from "./catalog"

function normalizeOptions(raw: unknown): SwitchmanOptions {
  const o = (raw ?? {}) as SwitchmanOptions
  return {
    quota: {
      glm: {
        enabled: o.quota?.glm?.enabled ?? true,
        fiveHourReservePct: o.quota?.glm?.fiveHourReservePct ?? 90,
      },
      deepseek: {
        enabled: o.quota?.deepseek?.enabled ?? true,
        lowBalanceWarnCny: o.quota?.deepseek?.lowBalanceWarnCny ?? 10,
      },
      copilot: { enabled: o.quota?.copilot?.enabled ?? true },
    },
    cost: { enabled: o.cost?.enabled ?? true },
    billingWindow: o.billingWindow,
    providers: { glm: o.providers?.glm ?? ["zhipuai-coding-plan", "glm", "zai"], deepseek: o.providers?.deepseek ?? ["deepseek"] },
    banner: { enabled: o.banner?.enabled ?? true },
    rules: { enabled: o.rules?.enabled ?? true },
    lanes: o.lanes,
    // [2026-08-29]-[动态矩阵：mode 默认 auto（OPENCODE_CLIENT 判定）；legacy=静态 shells.json 原路径。
    // 激活面变化对派发闸「下一请求生效」（watch/切模即时重算，但已发出的请求不受影响）]
    matrix: { mode: o.matrix?.mode ?? "auto", watch: o.matrix?.watch ?? true },
    // [2026-08-31]-[动态能力分级默认开启：无 key 走 OpenRouter 公开源；失败 fail-open 回退策展表]
    capability: {
      enabled: o.capability?.enabled ?? true,
      source: o.capability?.source ?? "auto",
      apiKey: o.capability?.apiKey,
      tierThresholds: o.capability?.tierThresholds,
      lmarenaCheck: o.capability?.lmarenaCheck ?? false,
    },
  }
}

/** opencode state 根（desktop 设 XDG_STATE_HOME=userData；CLI=xdg-basedir 默认 ~/.local/state） */
function resolveOpencodeStateRoot(): string {
  const xdg = process.env.XDG_STATE_HOME
  return join(xdg ?? join(homedir(), ".local", "state"), "opencode")
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return Promise.race([p, new Promise<T>((_, rej) => {
    const t = setTimeout(() => rej(new Error(`timeout ${ms}ms`)), ms)
    if (typeof t === "object" && t !== null && "unref" in t) (t as any).unref()
  })])
}

interface Credentials { glmKey?: string; dsKey?: string; copilotToken?: string; glmBaseURL?: string; deepseekBaseURL?: string }

export const SwitchmanPlugin: Plugin = async (input, rawOptions) => {
  const raw = rawOptions ?? {}
  const options = normalizeOptions(raw)
  // 老 options 只在显式存在时覆盖新文件 observe，避免默认值反向覆盖用户配置。
  const rawQuota = (raw as any).quota
  const legacyObserve: Partial<Record<Pool, boolean>> = {}
  for (const pool of ["glm", "copilot", "deepseek"] as Pool[]) {
    if (rawQuota?.[pool] && Object.prototype.hasOwnProperty.call(rawQuota[pool], "enabled")) legacyObserve[pool] = Boolean(rawQuota[pool].enabled)
  }
  let userConfig = loadUserConfig()
  let policy = routePolicy(userConfig.config, legacyObserve)
  // [2026-08-31]-[去厂商化：billing/peak 系数解析器——只读用户 jsonc（任意 provider 键），
  //  subscription 显式声明才享 1.0，其余 api 0.85；闭包读最新 userConfig（config 钩子重载后生效）
  const billingBoostOf = (provider: string): number =>
    billingOfProvider(userConfig.config, provider) === "subscription" ? 1.0 : BILLING_API_BOOST
  // [2026-08-31]-[终审P1-2：唯一 peak 解析器——显式旧 billingWindow 覆盖期内对 glm/deepseek 池生效
  //  （老 options 兼容保留一代），否则走 jsonc 路由口径（enabled 门控）；闭包读最新 policy/userConfig]
  const legacyBillingWindow = Object.prototype.hasOwnProperty.call(raw, "billingWindow") ? options.billingWindow : undefined
  const peakOfProvider = (provider: string): boolean => {
    if (legacyBillingWindow) {
      const w = billingWindow(new Date(), legacyBillingWindow)
      const pool = poolForProviderId(provider)
      if (pool === "glm") return w.glmPeak && policy.glm.routing
      if (pool === "deepseek") return w.dsPeak && policy.deepseek.routing
      return false
    }
    return routingPeakActive(new Date(), userConfig.config, provider)
  }
  const unknownOfModel = (modelId: string): boolean => baseScoreDynamic(modelId).source === "global"
  let doctorSummary: string | null = null
  const creds: Credentials = { copilotToken: undefined }
  let initTried = false
  const denySkip = new Set<string>() // 自身 deny 的 callID：记账时排除
  let bannerCache: { at: number; lines: string[] } | null = null
  const sessionAgent = new Map<string, string>() // legacy 路径：chat.params 记录（区分主模型与壳子代理）
  // [2026-08-29]-[动态矩阵 v1.3：mode 判定一次性；legacy=原静态路径逐字节不变]
  const runMode = detectMode(options.matrix!.mode as MatrixModeOption, process.env.OPENCODE_CLIENT)
  const dynamic = runMode !== "legacy"
  let manager: MatrixManager | null = null
  // [2026-08-29]-[fail-open 可见性：config 注入崩溃只写 stderr 时模型侧无感知，会对着空注册表盲派——
  //  崩溃即置位，transform 向系统提示注入显式告警（自做/告知用户，别派发）]-
  let configFailed = false
  const injectedNames = new Set<string>()
  const conflictNames = new Set<string>()
  let supersetDefs: ShellDefinition[] = []
  let degradedModelCount = 0

  function clearBannerCache(): void {
    bannerCache = null
  }

  function routingWithRealFailures(routing: ReturnType<typeof loadContext>["routing"]) {
    // [2026-08-29]-[复审P2-5：legacy 内存标记恒空仍加守卫，与新闸写入点一致防未来引入非 dynamic 写入路径]-
    if (!dynamic) return routing
    const down = { ...routing.down_agents }
    for (const combo of realFailedComboKeys()) down[combo] = "探针可用但实际委派失败（30 分钟内存隔离）"
    return { ...routing, down_agents: down }
  }

  function collectCreds(cfg: Record<string, any>): void {
    try {
      // 优先级：opencode 鉴权层（/connect 管理）→ provider config options → env
      const auth = readAuthStore()
      creds.glmKey = auth.glmKey ?? creds.glmKey
      creds.dsKey = auth.dsKey ?? creds.dsKey
      creds.copilotToken = auth.githubToken ?? creds.copilotToken
      for (const [pid, p] of Object.entries<any>(cfg.provider ?? {})) {
        const apiKey = p?.options?.apiKey
        const baseURL = p?.options?.baseURL
        if (poolForProviderId(pid) === "glm") {
          creds.glmKey = creds.glmKey ?? (typeof apiKey === "string" ? apiKey : undefined)
          creds.glmBaseURL = typeof baseURL === "string" ? baseURL : creds.glmBaseURL
        }
        if (poolForProviderId(pid) === "deepseek") {
          creds.dsKey = creds.dsKey ?? (typeof apiKey === "string" ? apiKey : undefined)
          creds.deepseekBaseURL = typeof baseURL === "string" ? baseURL : creds.deepseekBaseURL
        }
      }
      if (!creds.glmKey && process.env.ZAI_API_KEY) creds.glmKey = process.env.ZAI_API_KEY
      if (!creds.dsKey && process.env.DEEPSEEK_API_KEY) creds.dsKey = process.env.DEEPSEEK_API_KEY
    } catch { /* fail-open */ }
  }

  function probeEndpoints() {
    return { glmKey: creds.glmKey, dsKey: creds.dsKey, glmBaseURL: creds.glmBaseURL, deepseekBaseURL: creds.deepseekBaseURL }
  }

  function readConfiguredSafe(stateRoot: string, mode: "desktop" | "cli") {
    try {
      return readConfigured(stateRoot, mode)
    } catch (exc) {
      console.error(`[opencode-switchman] 配置面读取 fail-open: ${exc}`)
      return { configStatus: "empty" as const, models: [] as ModelKey[] }
    }
  }

  /** 有凭证 provider 的全部可对话模型（client.provider.list 带超时；失败回退 cfg.provider 键集）
   *  [2026-08-29]-[修复复审P1-provider.list 响应形状：返回对象非数组（sdk /provider 200 响应）：
   *  {all: Provider[], default:{}, connected: string[]}——超集须按 connected（有凭证）筛选，restartRequired 才准确] */
  async function collectProviderModels(
    input: { client?: { provider?: { list?: () => Promise<unknown> } } },
    cfg: Record<string, any>,
  ): Promise<{ models: string[]; providers: string[] }> {
    try {
      const resp = await withTimeout(Promise.resolve(input?.client?.provider?.list?.()), 8_000)
      // 形状归一纯函数见 activation.normalizeProviderListResponse（delta 复审 P1：先解包 .data 包装）
      const normalized = normalizeProviderListResponse(resp)
      if (!normalized) throw new Error("provider.list 响应形状不可识别")
      const providers = normalized.providers
      const connected = normalized.connected
      const models: string[] = []
      const providerIds: string[] = []
      for (const p of providers) {
        const pid = String(p?.id ?? "")
        if (!pid) continue
        // connected 在场=有凭证筛选（不在该列表的 provider 壳注册后必失败，且污染 restartRequired 基线）
        if (connected && !connected.has(pid)) continue
        providerIds.push(pid)
        for (const mid of Object.keys(p?.models ?? {})) {
          models.push(`${pid}/${mid}`)
        }
      }
      if (providers.length === 0 && !Array.isArray(resp)) throw new Error("provider.list 响应形状不可识别")
      return { models, providers: providerIds }
    } catch (exc) {
      // 回退：cfg.provider 键集（仅 providerID，供 restartRequired 基线；模型面由配置面/内置链兜底）
      const keys = Object.keys(cfg.provider ?? {})
      console.error(`[opencode-switchman] provider.list 不可用（回退 cfg.provider 键集 ${keys.length} 个）: ${exc}`)
      return { models: [], providers: keys }
    }
  }

  function warmup(): void {
    if (initTried) return
    initTried = true
    try {
      ensureStateDir()
      ensureStateAssets()
      creds.copilotToken = creds.copilotToken ?? readAuthStore().githubToken
      if (costsStale() && options.cost!.enabled) refreshCosts().catch(() => {})
      // [2026-08-31]-[动态能力分级：与探针同频调度（TTL 24h 内自动跳过实际拉取）]
      if (capabilityStale() && options.capability!.enabled) refreshCapability(options.capability!).catch(() => {})
      if (dynamic && manager) refreshActiveMatrixIfStale(probeEndpoints(), manager.activeMatrixKeys()).catch(() => {})
      else refreshMatrixIfStale(probeEndpoints()).catch(() => {})
      quotaView(creds as any, { observe: {
        glm: policy.glm.observe,
        deepseek: policy.deepseek.observe,
        copilot: policy.copilot.observe,
      } })
      // [2026-08-28]-[探针/配额/成本只在启动跑一次，启动竞态（如核心晚回写 token）或高峰限流后永不自愈]-
      // [10min 周期刷新：矩阵 TTL 内自动跳过，配额/成本由各自 TTL 兜底；timer unref 不阻进程退出]
      // [2026-08-29]-[动态矩阵只探激活组合（增量，ro 别名共享 key 去重）；legacy 保持全量]
      const timer = setInterval(() => {
        try {
          if (dynamic && manager) {
            refreshActiveMatrixIfStale(probeEndpoints(), manager.activeMatrixKeys()).catch(() => {})
          } else {
            refreshMatrixIfStale(probeEndpoints()).catch(() => {})
          }
          quotaView(creds as any, { observe: {
            glm: policy.glm.observe,
            deepseek: policy.deepseek.observe,
            copilot: policy.copilot.observe,
          } })
          if (costsStale() && options.cost!.enabled) refreshCosts().catch(() => {})
          // [2026-08-31]-[动态能力分级：10min 周期同频检查，capabilityStale/TTL 24h 门控实际拉取]
          if (capabilityStale() && options.capability!.enabled) refreshCapability(options.capability!).catch(() => {})
        } catch { /* fail-open */ }
      }, 600_000)
      if (typeof timer === "object" && timer !== null && "unref" in timer) (timer as any).unref()
    } catch (exc) {
      console.error(`[opencode-switchman] warmup fail-open: ${exc}`)
    }
  }

  function ensureStateAssets(): void {
    try {
      // [2026-08-28]-[bundle 部署后 import.meta 相对路径断链，资产改为 TS 模块内联；模板每次启动回写＝随包版本固定]
      writeFileSync(join(stateDir(), "delegation-template.md"), DELEGATION_TEMPLATE)
    } catch { /* fail-open */ }
  }

  function quotaExhaustedFlags(): Partial<Record<Pool, boolean>> {
    try {
      const qv = quotaView(creds as any, { observe: {
        glm: policy.glm.observe,
        deepseek: policy.deepseek.observe,
        copilot: policy.copilot.observe,
      } })
      return {
        glm: policy.glm.routing && glmExhausted(qv.glm, options.quota!.glm!.fiveHourReservePct)[0],
        copilot: policy.copilot.routing && copilotExhausted(qv.copilot)[0],
        deepseek: policy.deepseek.routing && deepseekExhausted(qv.deepseek)[0],
      }
    } catch {
      return {}
    }
  }

  function currentContext() {
    warmup()
    const ctx = loadContext(options, creds as any, dynamic ? dynamicManifest() : undefined)
    try {
      cleanExpired(ctx.routing)
    } catch { /* fail-open */ }
    const registry = buildRegistry(ctx)
    return { ctx, registry }
  }

  /** 动态超集清单视图（config 前兜底读盘；缺省回退静态清单） */
  function dynamicManifest(): ReturnType<typeof loadManifest> | null {
    if (supersetDefs.length > 0) {
      return { shells: supersetDefs.map(toManifestEntry), lanes: (loadManifest() as any).lanes }
    }
    try {
      const persisted = loadSupersetShells()
      if (persisted) return { shells: persisted.shells, lanes: (loadManifest() as any).lanes }
    } catch { /* fail-open */ }
    return null
  }

  /** 六档 base 链：用户 lanes 选项优先；动态对激活壳全集运行算法；legacy 使用生成期同源链。 */
  function baseChainFor(lane: Lane): string[] {
    const custom = (options.lanes as any)?.[lane]
    if (Array.isArray(custom) && custom.length > 0) return custom
    if (!dynamic || !manager) return laneShells(loadContext(options, creds as any), lane)
    const m = loadManifest()
    const attrs = new Map<string, { effort: string; capability: string; vision: boolean; pool: string; provider: string; modelId: string; cost: number | null }>()
    // [2026-08-29]-[失败分类：dynamic 先滤已退休模型壳，避免连续 404 的模型仍进改派候选]
    for (const s of filterRetiredShells((dynamicManifest() ?? m).shells)) {
      attrs.set(s.name, { effort: s.effort, capability: s.capability, vision: s.vision, pool: String(s.pool), provider: s.provider, modelId: s.modelId, cost: costOf(s.modelId) })
    }
    return laneBaseChain(lane, {
      builtin: (m.lanes as any)[lane] ?? [],
      activeShells: new Set(manager.snapshot().activeShells),
      shells: attrs, capabilityOf: (modelId) => baseScoreDynamic(modelId),
      // [2026-08-31]-[去厂商化：链生成乘 billingBoost×unknownPenalty（用户配置/能力分级驱动）]
      billingBoostOf, unknownOf: unknownOfModel,
    })
  }

  function waterFactorOf(qv: ReturnType<typeof quotaView>): WaterFactor {
    const g = qv.glm
    const c = qv.copilot
    let copilotResetDays: number | null = null
    if (c?.reset_date && typeof c.reset_date === "string") {
      const d = new Date(`${c.reset_date.slice(0, 10)}T00:00:00`)
      if (!Number.isNaN(d.getTime())) {
        const start = new Date()
        start.setHours(0, 0, 0, 0)
        copilotResetDays = Math.max(Math.floor((d.getTime() - start.getTime()) / 86400000), 0)
      }
    }
    return {
      glmFiveHourPct: typeof g?.five_hour?.used_pct === "number" ? g.five_hour.used_pct : null,
      glmWeeklyPct: typeof g?.weekly?.used_pct === "number" ? g.weekly.used_pct : null,
      copilotRemainingPct: typeof c?.premium?.percent_remaining === "number" ? c.premium.percent_remaining : null,
      copilotResetDays,
    }
  }

  function bannerLines(): string[] {
    try {
      if (bannerCache && Date.now() - bannerCache.at < 15_000) return bannerCache.lines
      const { ctx, registry } = currentContext()
      const quotaEx = quotaExhaustedFlags()
      const costs = options.cost!.enabled ? costOf : null
      const lanes: Record<string, LaneResult> = {}
        const peak = billingWindowForConfig(new Date(), userConfig.config, Object.prototype.hasOwnProperty.call(raw, "billingWindow") ? options.billingWindow : undefined)
       const qv = quotaView(creds as any, { observe: {
         glm: policy.glm.observe,
         deepseek: policy.deepseek.observe,
         copilot: policy.copilot.observe,
      } })
      // [2026-08-29]-[评分引擎：配额视图归一化水位因子（water 系数）]
       const water = { ...waterFactorOf(qv), routing: Object.fromEntries(Object.entries(policy).map(([k, v]) => [k, v.routing])) as Partial<Record<Pool, boolean>> }
       const states = poolStates(qv, peak, policy)
       for (const lane of LANE_ORDER) {
         try {
           lanes[lane] = computeLane(lane, baseChainFor(lane), {
             registry, matrix: ctx.matrix?.combos ?? null, routing: routingWithRealFailures(ctx.routing),
              quotaExhausted: quotaEx, routePolicy: policy, states, glmPeak: peak.glmPeak, costs, water,
              billingBoostOf, peakOf: peakOfProvider,
           })
         } catch { /* 单档失败不影响其余档 */ }
       }
      const down = new Set(Object.keys(routingWithRealFailures(ctx.routing).down_agents))
      // [2026-08-29]-[动态矩阵：[路由] 只显示激活候选；[限制] 追加 模式/watch/configStatus/restartRequired/降级标注]
      const matrixInfo = dynamic && manager ? {
        mode: runMode, configStatus: manager.snapshot().configStatus,
        watch: options.matrix!.watch === true,
        restartRequired: manager.snapshot().restartRequired,
        degradedModels: degradedModelCount,
        retiredModels: retiredModelKeys().length,
      } : undefined
      const lines = buildBanner({
        lanes: lanes as any,
        down,
        quota: { glm: null as any, copilot: null as any },
        states,
        billing: peak,
         advice: routingAdvice(states, policy),
         providerPolicy: policy as any,
         doctorSummary,
        matrixInfo,
        update: updateBannerText(),
      })
      // [水位] 行需要原始配额数据 → 二次组装（banner 纯函数吃快照；这里补真实 quota）
      const lines2 = buildBanner({
        lanes: lanes as any,
        down,
        quota: { glm: qv.glm, copilot: qv.copilot, deepseek: qv.deepseek },
        states,
        billing: peak,
         advice: routingAdvice(states, policy),
         providerPolicy: policy as any,
         doctorSummary,
        dsLowWarnCny: options.quota!.deepseek!.lowBalanceWarnCny,
        matrixInfo,
        update: updateBannerText(),
      })
      // [2026-08-29]-[评分引擎决策日志：每次横幅重建（15s 缓存失效）追加各 lane 评分明细；fail-open 不阻塞]
      try {
        const records: DecisionRecord[] = []
        for (const lane of LANE_ORDER) {
          const candidates = (lanes[lane]?.chain ?? [])
            .filter((c) => c.score)
            .map((c) => ({ name: c.shell, ...c.score! }))
          if (candidates.length > 0) records.push({ at: new Date().toISOString(), lane, candidates })
        }
        if (records.length > 0) logDecision(records).catch(() => {})
      } catch { /* fail-open */ }
      bannerCache = { at: Date.now(), lines: lines2 }
      return lines2
    } catch (exc) {
      console.error(`[opencode-switchman] banner fail-open: ${exc}`)
      return []
    }
  }

  /** 动态模式六档 lanes 映射（lane-policy 产出）；legacy=静态 lanes */
  function dynamicLaneMap(ctx: ReturnType<typeof loadContext>): Record<string, string[]> {
    if (!dynamic) return (ctx.manifest.lanes ?? {}) as Record<string, string[]>
    const out: Record<string, string[]> = {}
    for (const lane of LANE_ORDER) out[lane] = baseChainFor(lane)
    return out
  }

  /** deny 附言：首候选（过全组闸后的链首壳）；[2026-08-31]-[终审P1-3：与横幅同源——接受 gateExtras 补足运行期输入] */
  function firstCandidateHint(agent: string, ctx: ReturnType<typeof loadContext>, extras?: { water?: WaterFactor; glmPeak?: boolean; states?: Record<string, unknown> }): string | null {
    try {
      const lanes = dynamicLaneMap(ctx)
      const lane = (Object.keys(lanes) as Lane[]).find((l) => lanes[l]?.includes(agent)) ?? "main"
      const cand = firstCandidate(lane, lanes[lane] ?? [], {
        registry: buildRegistry(ctx),
        matrix: ctx.matrix?.combos ?? null,
        routing: routingWithRealFailures(ctx.routing),
        quotaExhausted: quotaExhaustedFlags(),
        billingBoostOf,
        peakOf: peakOfProvider,
        costs: options.cost!.enabled ? costOf : undefined,
        water: extras?.water,
        glmPeak: extras?.glmPeak,
        states: extras?.states as any,
      } as any, agent)
      return cand ? `请改派 ${cand}` : "降级链已尽：向用户声明原因并给 2 个可选项"
    } catch {
      return null
    }
  }

  return {
    tool: { handover: createHandoverTool(input) },

    config: async (cfg: Record<string, any>) => {
      try {
        // [2026-08-31]-[配置钩子首步装载用户水位配置；路由快照本启动内一致]-[fail-open]
        userConfig = loadUserConfig()
        policy = routePolicy(userConfig.config, legacyObserve)
        const doctor = runDoctor({ configPath: userConfig.path, diagnostics: userConfig.diagnostics, env: process.env, legacy: { quotaEnabled: legacyObserve, billingWindow: Object.prototype.hasOwnProperty.call(raw, "billingWindow") } })
        const errors = doctor.diagnostics.filter((d) => d.level === "error").length
        const warns = doctor.diagnostics.filter((d) => d.level === "warn").length
        doctorSummary = errors || warns ? `doctor: ${errors} error / ${warns} warn` : null
        if (doctorSummary) console.error(`[opencode-switchman] 自检发现 ${errors} error / ${warns} warn；运行 /switchman-doctor 查看`)
        try { writeJsonAtomic(paths().doctorSnapshot, { at: new Date().toISOString(), diagnostics: doctor.diagnostics.map((d) => ({ code: d.code, level: d.level, path: d.path })) }) } catch { /* fail-open */ }
        collectCreds(cfg)
        creds.copilotToken = creds.copilotToken ?? readAuthStore().githubToken
        // [2026-08-29]-[一键升级命令资产：prod 注册 /switchman-update，local 删除残留——legacy/动态两路都生效]-
        ensureUpdateCommands(detectLoadMode())
        // [2026-08-31]-[/handover 交接命令：cfg.command 运行期注入，覆盖同名用户自定义命令时以用户为准]-
        cfg.command = { handover: { template: HANDOVER_COMMAND_TEMPLATE, description: HANDOVER_COMMAND_DESCRIPTION }, ...cfg.command }
        if (!dynamic) {
          // legacy：静态 shells.json 路径（行为与 v1.2 逐字节一致）
          const { registry } = currentContext()
          const n = injectShells(cfg, registry)
          console.log(`[opencode-switchman] 已注入 ${n} 只模型空壳（agent，legacy 静态矩阵）`)
          // [2026-08-29]-[配置钩子触发自更新检查]-[检查异步且失败不阻塞启动]
          refreshSelfUpdate().then((state) => { if (state?.outdated) clearBannerCache() }).catch(() => {})
          return
        }
        // [2026-08-29]-[超集注入：config 一次（cfg.agent 运行期不可变）→运行期激活门控]
        // 超集=配置面 ∪ 有凭证 provider 全部可对话模型 ∪ 内置链引用模型；排除 embedding 类
        const stateRoot = resolveOpencodeStateRoot()
        const configured = readConfiguredSafe(stateRoot, runMode)
        const providerModels = await collectProviderModels(input, cfg)
        const builtinModels = [...new Set(loadManifest().shells.map((s) => `${s.provider}/${s.modelId}`))]
        const supersetModels = [...new Set([...configured.models, ...providerModels.models, ...builtinModels])]
          .filter((full) => isConversational(full.slice(full.indexOf("/") + 1)))
          .sort()
        const catalog = await loadCatalog().catch(() => ({ index: {}, status: "none" as const, etag: null }))
        const metaIndex: Record<string, EffortInfo> = { ...bundledModelIndex(), ...catalog.index }
        supersetDefs = buildShells(supersetModels, metaIndex, {
          roAliases: true, degradedFamilyByProvider: true, markDegraded: true,
        })
        degradedModelCount = new Set(supersetDefs.filter((d) => d.degraded).map((d) => `${d.provider}/${d.modelId}`)).size
        const { injected, conflicts } = injectShellDefs(cfg, supersetDefs)
        injectedNames.clear()
        for (const n of injected) injectedNames.add(n)
        conflictNames.clear()
        for (const n of conflicts) conflictNames.add(n)
        try {
          writeJsonAtomic(paths().shellSuperset, {
            generated_at: new Date().toISOString(),
            counts: { superset_models: supersetModels.length, shells: supersetDefs.length, degraded: degradedModelCount },
            mode: runMode,
            shells: supersetDefs.map(toManifestEntry),
          })
        } catch { /* fail-open */ }
        const knownProviders = new Set<string>([...supersetModels.map((m) => m.slice(0, m.indexOf("/"))), ...providerModels.providers])
        manager = new MatrixManager({
          stateRoot, mode: runMode, superset: supersetDefs,
          injectedNames, knownProviders,
          watchEnabled: options.matrix!.watch === true,
          onRecompute: (state, newTargets, source) => {
            clearBannerCache()
            if (source === "config") syncIfDiverged(stateRoot, runMode as "desktop" | "cli")
            // [2026-08-29]-[配置面变化即探：desktop 可见集开关/TUI favorites 增删（config 源）全量重探
            //  激活组合、不等 TTL；session/startup 源维持仅探新增组合；10min 周期刷新保持不变]-
            const targets = source === "config" ? (manager?.activeMatrixKeys() ?? newTargets) : newTargets
            if (targets.length > 0) probeKeys(targets, probeEndpoints()).catch(() => {})
            console.error(`[opencode-switchman] 激活矩阵已重算（gen=${state.generation}，激活壳 ${state.activeShells.length}，探针 ${source}×${targets.length}）`)
          },
          // [2026-08-29]-[复审P1-1：被动侧文件变更被 sameActivation 短路时 onRecompute 不触发——
          //  debounce 尾部无条件同步（同集 no-op，无环）；onRecompute 里的 config 源同步保留为变更时的即时路径]-
          onConfigSync: () => syncIfDiverged(stateRoot, runMode as "desktop" | "cli"),
        })
        manager.recompute(configured)
        manager.start()
        console.log(`[opencode-switchman] 已注入 ${injected.size} 只超集壳（${supersetModels.length} 模型×档位，模式=${runMode}，冲突 ${conflicts.size}；激活门控运行中）`)
        // [2026-08-29]-[配置钩子触发自更新检查]-[检查异步且失败不阻塞启动]
        refreshSelfUpdate().then((state) => { if (state?.outdated) clearBannerCache() }).catch(() => {})
      } catch (exc) {
        configFailed = true
        console.error(`[opencode-switchman] config 钩子 fail-open: ${exc}`)
      }
    },

    "chat.params": async (input) => {
      try {
        // [2026-08-29]-[修复复审P1-首轮时序与分类：agent 名唯一真源——注入壳名集合→isShell、
        //  title/compaction/summary→忽略、其余（含用户自定义 subagent）→按主会话注册；
        //  modelKey 取 Model 对象 providerID/id（chatParamsModelKey）]
        const sessionID = (input as any).sessionID as string | undefined
        const agent = (input as any).agent as string | undefined
        if (dynamic) {
          if (manager?.noteChatParams(sessionID, agent, chatParamsModelKey(input))) manager.scheduleRecompute(50, "session")
          return
        }
        if (sessionID && agent) sessionAgent.set(sessionID, agent)
      } catch { /* fail-open */ }
    },

    "experimental.chat.system.transform": async (input, output) => {
      try {
        // 壳子代理/内部代理不注入调度员规程与横幅（角色已是执行体，省 token 且防角色混淆）；
        // [2026-08-29]-[修复复审P1-首轮时序：transform 早于 chat.params——依赖 session.created
        //  预注册的 agent 名分类（动态=skipSystemInjection；legacy=sessionAgent∪内部代理名），不依赖 chat.params 先到]
        if (input.sessionID) {
          if (dynamic) {
            if (manager?.skipSystemInjection(input.sessionID)) return
          } else {
            const agent = sessionAgent.get(input.sessionID) ?? ""
            if (/-mx-/.test(agent) || agent === "title" || agent === "compaction" || agent === "summary") return
          }
        }
        // [2026-08-29]-[fail-open 可见性：注入崩溃时显式告警——不派发，直接自做或告知用户]-
        if (configFailed) {
          output.system.push("[opencode-switchman] ⚠ 插件注入失败（壳/派发闸不可用）——本轮禁止 task 派发，直接自做或向用户说明后自做")
        }
        // [v1.2] 调度员规程随包内置：系统提示每轮注入（内存态、不可被本地文件改动丢失，
        // 与用户自己的全局/项目 AGENTS.md 拼接共存，互不覆盖）
        if (options.rules!.enabled) output.system.push(AGENTS_MD.trimEnd())
        if (options.banner!.enabled) {
          for (const line of bannerLines()) output.system.push(line)
        }
      } catch (exc) {
        console.error(`[opencode-switchman] 规程/横幅 fail-open: ${exc}`)
      }
    },

    "tool.execute.before": async (input, output) => {
      if (input.tool !== "task") return
      try {
        const { ctx, registry } = currentContext()
        cleanRoutingExpired()
        const agent = String(output.args?.subagent_type ?? "").trim()
        if (!agent) return
        // [2026-08-29]-[闸1 第一层（动态）：壳名形态但未注入超集 → deny（附重启/激活指引）；
        //  非壳名 unknown 维持 fail-open 放行]
        let shell: ShellRegEntry | undefined = registry[agent]
        const activationGate = dynamic
          ? {
            enabled: true,
            activeShells: manager ? new Set(manager.snapshot().activeShells) : null,
            conflicts: conflictNames,
            restartRequired: manager?.snapshot().restartRequired ?? [],
          }
          : null
        // [2026-08-31]-[终审P1-3：deny 附言候选与横幅同源——补 water/glmPeak/states 运行期输入
        //  （quotaView 为缓存读，与 quotaExhaustedFlags 同 TTL，不新增网络成本）]
        let gateExtras: { water?: WaterFactor; glmPeak?: boolean; states?: Record<string, unknown> } = {}
        try {
          const peak = billingWindowForConfig(new Date(), userConfig.config, legacyBillingWindow)
          const qv = quotaView(creds as any, { observe: {
            glm: policy.glm.observe,
            deepseek: policy.deepseek.observe,
            copilot: policy.copilot.observe,
          } })
          gateExtras = {
            water: { ...waterFactorOf(qv), routing: Object.fromEntries(Object.entries(policy).map(([k, v]) => [k, v.routing])) as Partial<Record<Pool, boolean>> },
            glmPeak: peak.glmPeak,
            states: poolStates(qv, peak, policy),
          }
        } catch { /* fail-open：hint 候选缺 water/states 仍可工作 */ }
        if (!shell) {
          if (dynamic && shellLikeName(agent)) {
            const hint = firstCandidateHint(agent, ctx, gateExtras)
            throw new Error(denyUninjected(agent, activationGate?.restartRequired ?? [], hint))
          }
          console.error(noteUnknownAgent(agent))
          return
        }
        const r = checkShell(agent, shell, output.args?.prompt, {
          registry,
          matrix: ctx.matrix?.combos ?? null,
          // [2026-08-29]-[功能1 仅动态矩阵：legacy 静态路径逐字节不变（tester 回归发现漏_gate）]-
          routing: dynamic ? routingWithRealFailures(ctx.routing) : ctx.routing,
           quotaExhausted: quotaExhaustedFlags(),
           routePolicy: policy,
          costs: options.cost!.enabled ? costOf : undefined,
          lanes: dynamicLaneMap(ctx),
          activation: activationGate,
          realFailedCombos: dynamic ? realFailedComboKeys() : undefined,
          retiredModels: dynamic ? new Set(retiredModelKeys()) : undefined,
          // [2026-08-31]-[去厂商化：deny 附言候选与横幅排序同源]
          billingBoostOf,
          peakOf: peakOfProvider,
          water: gateExtras.water,
          glmPeak: gateExtras.glmPeak,
          states: gateExtras.states as any,
        })
        if (r.note) console.error(r.note)
        if (r.deny) {
          denySkip.add(input.callID)
          throw new Error(r.deny)
        }
      } catch (exc) {
        if (denySkip.has(input.callID)) throw exc // deny 原样上抛（阻断派发）
        console.error(`[opencode-switchman] 六闸 fail-open（放行）: ${exc}`)
      }
    },

    event: async ({ event }) => {
      try {
        // [2026-08-29]-[修复复审P1-首轮时序：session.created 预注册（事件早于首轮 chat.params/transform，
        //  记 agent 名供 transform 首轮分类；modelKey 由 chat.params 补齐）]
        if (event.type === "session.created") {
          const info = sessionCreatedInfo((event as any).properties)
          if (info) {
            if (dynamic) manager?.noteSessionCreated(info.id, info.agent)
            else sessionAgent.set(info.id, info.agent)
          }
          return
        }
        // [2026-08-29]-[修复复审P1-session.deleted 形状：properties={info:{id}}（sdk types.gen.ts:576-580）；
        //  清理会话注册表（仅动态矩阵；非壳会话移除→重算）]
        if (dynamic && event.type === "session.deleted") {
          const sid = sessionDeletedId((event as any).properties)
          if (sid && manager?.noteSessionDeleted(sid)) manager.scheduleRecompute(50, "session")
          return
        }
        if (event.type !== "message.part.updated") return
        const part = (event as any).properties?.part
        if (part?.type !== "tool" || part?.state?.status !== "error") return
        if (part.callID && denySkip.has(part.callID)) {
          denySkip.delete(part.callID)
          return // 自身 deny 不记账
        }
        const agent = String(part.state?.input?.subagent_type ?? "").trim()
        if (!agent) return
        const { ctx, registry } = currentContext()
        const reason = String(part.state?.error ?? part.state?.message ?? "派发失败").slice(0, 300)
        const combo = registry[agent]?.comboKey
        // [2026-08-29]-[失败分类：厂商无关分类，一次判定全程复用（瞬时 429 与真额度分离）]
        const category = classifyFailure(reason)
        // [2026-08-29]-[功能1 仅动态矩阵：legacy 维持原 recordFailure 熔断路径（tester 回归发现漏_gate）]-
        const realFailed = dynamic && Boolean(combo && ctx.matrix?.combos[combo]?.status === "ok")
        if (realFailed) {
          // 限流用短 TTL（10 分钟自愈），真失败用默认长 TTL（30 分钟）
          markRealFailure(combo!, undefined, category === "rate_limit" ? RATE_LIMIT_TTL_MS : REAL_FAIL_TTL_MS)
          clearBannerCache()
        }
        const rec = realFailed ? null : recordFailure(agent, reason, registry)
        // Copilot 网关额度类错误 → 第二真值源置池耗尽（信任至 reset_date）
        // [2026-08-29]-[失败分类：仅真 quota 判池耗尽，429 瞬时永不触发；非 copilot 池的 quota 不做池级
        //  处理——探针 10min 会持续 down，横幅自然降级，30 分钟内存标记已覆盖]
        if (category === "quota") {
          const shell = registry[agent]
          if (shell?.pool === "copilot") markCopilotGatewayExhausted(reason)
        }
        // 模型下线类（连续 404）→ 退休移出候选
        if (category === "not_found" && dynamic) {
          const shell = registry[agent]
          if (shell && noteModelNotFound(`${shell.provider}/${shell.modelId}`)) {
            clearBannerCache()
            console.error(`[opencode-switchman] 模型已下线（连续 404），已移出候选：${shell.provider}/${shell.modelId}`)
          }
        }
        if (rec?.tripped) console.error(`[opencode-switchman] ${agent} 已熔断（600s）：${reason.slice(0, 80)}`)
      } catch (exc) {
        console.error(`[opencode-switchman] 记账 fail-open: ${exc}`)
      }
    },
  }
}

export default SwitchmanPlugin
