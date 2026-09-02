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
  appendStatusLog,
  writeRouteSnapshot,
  writeQuotaBrief,
  loadProviderCache, saveProviderCache, nowIso,
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
import { injectShells, injectShellDefs, selectInjectableDefs } from "./shells"
import { buildBanner, shortName, providerStatusEntries } from "./banner"
import { refreshSelfUpdate, updateBannerText, ensureUpdateCommands, detectLoadMode } from "./selfupdate"
import { billingOfProvider, loadUserConfig, resolveEffectiveOptions, routingPeakActive, routePolicy } from "./config"
import { poolForProviderId } from "./provider-config"
import { runDoctor } from "./doctor"
import {
  recordFailure, cleanRoutingExpired, markRealFailure, realFailedComboKeys,
  RATE_LIMIT_TTL_MS, ENDPOINT_TTL_MS, REAL_FAIL_TTL_MS, recordIsolation, recordInjection, realFailedRemainingMs,
  noteModelNotFound, retiredModelKeys, filterRetiredShells,
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
import { laneBaseChain } from "./lane-policy"
import {
  buildShells, loadCatalog, bundledModelIndex, isConversational, toManifestEntry, freeFloorModels,
} from "./catalog"
import type { ShellDefinition, EffortInfo } from "./catalog"

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
  // 老 options 只在显式存在时覆盖新文件 observe，避免默认值反向覆盖用户配置。
  const rawQuota = (raw as any).quota
  const legacyObserve: Partial<Record<Pool, boolean>> = {}
  for (const pool of ["glm", "copilot", "deepseek"] as Pool[]) {
    if (rawQuota?.[pool] && Object.prototype.hasOwnProperty.call(rawQuota[pool], "enabled")) legacyObserve[pool] = Boolean(rawQuota[pool].enabled)
  }
  let userConfig = loadUserConfig()
  // [2026-09-01]-[配置面统一：jsonc 行为段为基线合成有效 options（元组显式键兼容一代优先）；
  //  config 钩子重载 jsonc 后重建，横幅/阈值/lanes 即时生效（mode/watch 为启动级，重启生效）]
  let { options, legacySections } = resolveEffectiveOptions(raw, userConfig.config)
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

  /** 侧栏只轮询落盘快照；刷新后主动重建，不能依赖下一次聊天请求读取横幅。 */
  function refreshSidebarState(): void {
    try {
      clearBannerCache()
      bannerLines()
    } catch { /* fail-open */ }
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
      appendStatusLog(`配置面读取 fail-open: ${exc}`)
      return { configStatus: "empty" as const, models: [] as ModelKey[] }
    }
  }

  /** [2026-09-01]-[P3 启动竞态修复：单次 attempt，短超时（不阻塞太久）；失败/未就绪抛错供调用方退避重试]-
   *  provider.list 单次探测（不含重试逻辑，重试由 collectProviderModels 的退避调度负责） */
  async function attemptProviderList(
    input: { client?: { provider?: { list?: () => Promise<unknown> } } },
    timeoutMs: number,
  ): Promise<{ models: string[]; providers: string[] }> {
    const resp = await withTimeout(Promise.resolve(input?.client?.provider?.list?.()), timeoutMs)
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
  }

  // [2026-09-01]-[启动竞态加固：opencode 核心 provider 注册表就绪耗时不固定，原 2 次固定 2.5s/8s 重试
  //  经常仍撞上未就绪（实测两次均超时）——改自适应退避（更短首次超时+更多次数），命中率显著提升；
  //  config 钩子内必须等到结果才能 injectShellDefs（cfg.agent 只在钩子内一次性生效，事后追加不生效，
  //  这是 opencode 插件 API 的硬约束，非本插件可绕过），故此处仍是 await，但退避调度使其"尽快返回"
  //  而非固定死等，多数情况比旧实现更快拿到真实 provider.list 结果，减少落到 restartRequired 兜底的概率]
  const PROVIDER_LIST_BACKOFF_MS = [0, 1_500, 3_000, 6_000] // 4 次尝试，累计等待 10.5s + 4×超时预算
  const PROVIDER_LIST_ATTEMPT_TIMEOUT_MS = 5_000

  /** 有凭证 provider 的全部可对话模型（client.provider.list 带自适应退避重试；失败回退 cfg.provider 键集） */
  async function collectProviderModels(
    input: { client?: { provider?: { list?: () => Promise<unknown> } } },
    cfg: Record<string, any>,
  ): Promise<{ models: string[]; providers: string[]; fellBack: boolean }> {
    let lastExc: unknown = null
    for (let i = 0; i < PROVIDER_LIST_BACKOFF_MS.length; i++) {
      if (PROVIDER_LIST_BACKOFF_MS[i] > 0) await new Promise((r) => setTimeout(r, PROVIDER_LIST_BACKOFF_MS[i]))
      try {
        const result = await attemptProviderList(input, PROVIDER_LIST_ATTEMPT_TIMEOUT_MS)
        if (i > 0) appendStatusLog(`provider.list 第 ${i + 1} 次尝试成功（此前 ${i} 次未就绪）`)
        return { ...result, fellBack: false }
      } catch (exc) {
        lastExc = exc
        if (i < PROVIDER_LIST_BACKOFF_MS.length - 1) {
          appendStatusLog(`provider.list 第 ${i + 1} 次未就绪，退避重试: ${exc}`)
        }
      }
    }
    // 全部尝试失败：回退 cfg.provider 键集（仅 providerID，供 restartRequired 基线；模型面由配置面/内置链兜底）
    const keys = Object.keys(cfg.provider ?? {})
    appendStatusLog(`provider.list 不可用（${PROVIDER_LIST_BACKOFF_MS.length} 次尝试后回退 cfg.provider 键集 ${keys.length} 个）: ${lastExc}`)
    return { models: [], providers: keys, fellBack: true }
  }

  // [2026-09-01]-[异步兜底：config 钩子内的退避重试若仍全败（起始阶段 opencode 核心异常慢），
  //  或本次启动直接用了跨重启缓存（未做实时探测）——后台继续以更长间隔探测 provider.list，
  //  成功即刷新缓存供下次启动秒用；命中新 provider 时只能提示"需重启"而非静默生效——
  //  cfg.agent 只在 config 钩子内一次性读取（opencode 插件 API 硬约束），事后无法补注册壳 agent；
  //  此处价值仅在于把"还要不要重启""现在重启能不能生效"从盲猜变成明确、实时的状态提示]
  function scheduleProviderListWatchdog(
    input: { client?: { provider?: { list?: () => Promise<unknown> } } },
    knownProviders: ReadonlySet<string>,
  ): void {
    const delays = [15_000, 30_000, 60_000] // 后台 3 次，间隔递增，累计再等 105s；进程退出自然终止，无需显式取消
    const run = async () => {
      for (const delay of delays) {
        await new Promise((r) => setTimeout(r, delay))
        try {
          const result = await attemptProviderList(input, 6_000)
          // [2026-09-01]-[真实探测成功即刷新跨重启缓存：下次启动 config 钩子直接读缓存，免去重新等待]
          saveProviderCache({ at: nowIso(), models: result.models, providers: result.providers })
          const fresh = result.providers.filter((p) => !knownProviders.has(p))
          if (fresh.length > 0) {
            appendStatusLog(`provider.list 后台探测：发现新 provider（${fresh.join("、")}）已连接——重启 opencode 即可完成壳注册`)
            clearBannerCache()
          }
          return
        } catch { /* 继续下一轮退避，fail-open */ }
      }
    }
    run().catch(() => {})
  }

  function warmup(): void {
    if (initTried) return
    initTried = true
    try {
      ensureStateDir()
      ensureStateAssets()
      creds.copilotToken = creds.copilotToken ?? readAuthStore().githubToken
      const costsP = costsStale() && options.cost!.enabled ? refreshCosts().catch(() => {}) : Promise.resolve()
      // [2026-08-31]-[动态能力分级：与探针同频调度（TTL 24h 内自动跳过实际拉取）]
      const capP = capabilityStale() && options.capability!.enabled ? refreshCapability(options.capability!).catch(() => {}) : Promise.resolve()
      const matrixP = dynamic && manager
        ? refreshActiveMatrixIfStale(probeEndpoints(), manager.activeMatrixKeys()).catch(() => {})
        : refreshMatrixIfStale(probeEndpoints()).catch(() => {})
      quotaView(creds as any, { observe: {
        glm: policy.glm.observe,
        deepseek: policy.deepseek.observe,
        copilot: policy.copilot.observe,
      } })
      // [2026-09-01]-[探针实时联动：待启动探针/矩阵/能力刷新真正落地后再写侧栏快照，避免读到刷新前的旧数据]-[fail-open 不阻塞启动]
      Promise.allSettled([costsP, capP, matrixP]).then(refreshSidebarState).catch(() => {})
      // [2026-08-28]-[探针/配额/成本只在启动跑一次，启动竞态（如核心晚回写 token）或高峰限流后永不自愈]-
      // [10min 周期刷新：矩阵 TTL 内自动跳过，配额/成本由各自 TTL 兜底；timer unref 不阻进程退出]
      // [2026-08-29]-[动态矩阵只探激活组合（增量，ro 别名共享 key 去重）；legacy 保持全量]
      const timer = setInterval(() => {
        try {
          const matrixP = dynamic && manager
            ? refreshActiveMatrixIfStale(probeEndpoints(), manager.activeMatrixKeys()).catch(() => {})
            : refreshMatrixIfStale(probeEndpoints()).catch(() => {})
          quotaView(creds as any, { observe: {
            glm: policy.glm.observe,
            deepseek: policy.deepseek.observe,
            copilot: policy.copilot.observe,
          } })
          const costsP = costsStale() && options.cost!.enabled ? refreshCosts().catch(() => {}) : Promise.resolve()
          // [2026-08-31]-[动态能力分级：10min 周期同频检查，capabilityStale/TTL 24h 门控实际拉取]
          const capP = capabilityStale() && options.capability!.enabled ? refreshCapability(options.capability!).catch(() => {}) : Promise.resolve()
          // [2026-09-01]-[探针实时联动：10min 周期刷新落地后立即使横幅缓存失效并重写侧栏快照，不等下一条聊天消息]
           Promise.allSettled([matrixP, costsP, capP]).then(refreshSidebarState).catch(() => {})
        } catch { /* fail-open */ }
      }, 600_000)
      if (typeof timer === "object" && timer !== null && "unref" in timer) (timer as any).unref()
    } catch (exc) {
      appendStatusLog(`warmup fail-open: ${exc}`)
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

  /** favorites 模型集（modelId 口径）：链内同档优先；读激活快照的配置面，fail-open 空集 */
  function preferredModelIds(): Set<string> {
    try {
      return new Set((manager?.snapshot().configured ?? []).map((k) => k.slice(k.indexOf("/") + 1)))
    } catch {
      return new Set()
    }
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
      // [2026-09-02]-[favorites 优先：收藏模型链内同档排前]
      preferredModels: preferredModelIds(),
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
              // [2026-09-02]-[favorites 优先：运行期同 tier 排前与 base 链同源]
              preferredModels: preferredModelIds(),
           })
         } catch { /* 单档失败不影响其余档 */ }
       }
       // [2026-09-01]-[down 来源标注：熔断（routing.json 600s）与实调隔离（内存 TTL）分开展示剩余时长]
       const down = new Map<string, string>()
       for (const k of Object.keys(routingWithRealFailures(ctx.routing).down_agents)) down.set(k, "熔断")
       for (const k of realFailedComboKeys()) {
         const left = realFailedRemainingMs(k)
         down.set(k, left !== null ? `实调隔离·剩${Math.max(1, Math.round(left / 60_000))}m` : "实调隔离")
       }
      // [2026-08-29]-[动态矩阵：[路由] 只显示激活候选；[限制] 追加 模式/watch/configStatus/restartRequired/降级标注]
      const matrixInfo = dynamic && manager ? {
        mode: runMode, configStatus: manager.snapshot().configStatus,
        watch: options.matrix!.watch === true,
        restartRequired: manager.snapshot().restartRequired,
        invalidConfigured: manager.snapshot().invalidConfigured,
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
      // [2026-09-01]-[TUI 侧边栏「最佳模型」面板：与横幅同源的各档链首候选，覆盖写入供 tui.tsx 轮询]
      try {
        writeRouteSnapshot(LANE_ORDER.map((lane) => {
          const r = lanes[lane]
          const top = r?.chain?.[0]
          return {
            lane,
            best: top ? shortName(top.shell) : null,
            degraded: r ? r.status.endsWith("*") : false,
          }
        }))
      } catch { /* fail-open */ }
      // [2026-09-01]-[TUI 侧边栏「水位/峰值」面板：与 [水位] 横幅同源、常态可见，覆盖写入供 tui.tsx 轮询]
      try {
        writeQuotaBrief(providerStatusEntries({
          quota: { glm: qv.glm, copilot: qv.copilot, deepseek: qv.deepseek },
          providerPolicy: policy as any,
          dsLowWarnCny: options.quota!.deepseek!.lowBalanceWarnCny,
          peakOf: peakOfProvider,
        }))
      } catch { /* fail-open */ }
      bannerCache = { at: Date.now(), lines: lines2 }
      return lines2
    } catch (exc) {
      appendStatusLog(`banner fail-open: ${exc}`)
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
        // [2026-09-01]-[jsonc 重载即重建有效 options：阈值/lanes/banner/rules 对后续请求生效]
        userConfig = loadUserConfig()
        ;({ options, legacySections } = resolveEffectiveOptions(raw, userConfig.config))
        policy = routePolicy(userConfig.config, legacyObserve)
        const doctor = runDoctor({ configPath: userConfig.path, diagnostics: userConfig.diagnostics, env: process.env, legacy: { quotaEnabled: legacyObserve, billingWindow: Object.prototype.hasOwnProperty.call(raw, "billingWindow"), sections: legacySections } })
        const errors = doctor.diagnostics.filter((d) => d.level === "error").length
        const warns = doctor.diagnostics.filter((d) => d.level === "warn").length
        doctorSummary = errors || warns ? `doctor: ${errors} error / ${warns} warn` : null
        if (doctorSummary) appendStatusLog(`自检发现 ${errors} error / ${warns} warn；运行 /switchman-doctor 查看`)
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
          appendStatusLog(`已注入 ${n} 只模型空壳（agent，legacy 静态矩阵）`)
          // [2026-08-29]-[配置钩子触发自更新检查]-[检查异步且失败不阻塞启动]
          refreshSelfUpdate().then((state) => { if (state?.outdated) clearBannerCache() }).catch(() => {})
          return
        }
        // [2026-08-29]-[超集注入：config 一次（cfg.agent 运行期不可变）→运行期激活门控]
        // 超集=配置面 ∪ 有凭证 provider 全部可对话模型 ∪ 保底模型；排除 embedding 类
        const stateRoot = resolveOpencodeStateRoot()
        const configured = readConfiguredSafe(stateRoot, runMode)
        // [2026-09-01]-[跨重启秒开：首次成功探测过 provider.list 后即缓存 providers/models（仅真实成功时写，
        //  见 scheduleProviderListWatchdog/下方成功分支）；非首次启动直接用缓存建壳，不再每次重启都要
        //  阻塞等 provider.list 网络竞态（原退避最长 ~30s）——缓存可能滞后于最新连接状态，故仍在后台
        //  发起一次真实探测：命中新 provider 才提示重启，命中率与旧实现一致，只是不再堵门口]
        const providerCache = loadProviderCache()
        let providerModels: { models: string[]; providers: string[]; fellBack: boolean }
        let usedProviderCache = false
        if (providerCache) {
          providerModels = { models: providerCache.models, providers: providerCache.providers, fellBack: false }
          usedProviderCache = true
          appendStatusLog(`provider.list 使用跨重启缓存（${providerCache.providers.length} 个 provider，缓存于 ${providerCache.at}），后台校验新增`)
        } else {
          providerModels = await collectProviderModels(input, cfg)
          if (!providerModels.fellBack) saveProviderCache({ at: nowIso(), models: providerModels.models, providers: providerModels.providers })
        }
        const catalog = await loadCatalog().catch(() => ({ index: {}, status: "none" as const, etag: null }))
        // [2026-09-01]-[保底改源：opencode 自带免费模型（OpenCode Zen，models.dev opencode provider
        //  -free ∪ big-pickle 特例，24h 滚动）优先；目录不可用（无网冷启动）fail-open 回退静态清单]
        const freeFloor = freeFloorModels(catalog.index)
        const floorModels = freeFloor.length > 0
          ? freeFloor
          : [...new Set(loadManifest().shells.map((s) => `${s.provider}/${s.modelId}`))]
        if (freeFloor.length > 0) appendStatusLog(`保底=OpenCode Zen 免费模型 ${freeFloor.length} 个（catalog ${catalog.status}）`)
        else appendStatusLog(`保底回退静态清单（catalog ${catalog.status}，免费模型 0 个）`)
        // [2026-09-01]-[加固：configured（可见集/favorites）此前无脑并入 supersetModels，provider 不存在的
        // 脏收藏（如手滑收藏 "provider/not-a-model"，provider 不在真实已连接 provider 集）此前会被
        // buildShells 当真实模型建出可调度但必挂的壳，且污染下方 knownProviders
        // 令 computeActivation 的"provider 已知"判定失真、永远检测不到这条脏数据。改为先按真实已连接
        // provider 集过滤，被过滤的单独记日志，不再被动提升为"看似合法"的壳]
        const realKnownProviders = new Set(providerModels.providers)
        const invalidFavoriteModels = configured.models.filter((m) => !realKnownProviders.has(m.slice(0, m.indexOf("/"))))
        if (invalidFavoriteModels.length > 0) {
          appendStatusLog(`可见集/收藏含未知 provider 的无效模型（provider 未连接，已忽略不建壳）：${invalidFavoriteModels.join("、")}`)
        }
        const validConfiguredModels = configured.models.filter((m) => realKnownProviders.has(m.slice(0, m.indexOf("/"))))
        const supersetModels = [...new Set([...validConfiguredModels, ...providerModels.models, ...floorModels])]
          .filter((full) => isConversational(full.slice(full.indexOf("/") + 1)))
          .sort()
        const metaIndex: Record<string, EffortInfo> = { ...bundledModelIndex(), ...catalog.index }
        supersetDefs = buildShells(supersetModels, metaIndex, {
          roAliases: true, degradedFamilyByProvider: true, markDegraded: true,
        })
        // [2026-09-02]-[上下文瘦身修正：注入面=可用全集（provider 已连接且可对话的 supersetModels）
        //  ∪六档链精选∪自定义 lane——链竞争不再裁掉可用模型（此前 glm-5.3-flash 等被裁导致 favorites
        //  误报「无效模型」、vision 链空转）；favorites 链内同档优先（用户显式意图压过乘积分）]-
        //  [token 影响回归 ~6-10k/会话，由维护者显式取舍：正确性（favorites/视觉/点名可达）优先]
        const fullSupersetCount = supersetDefs.length
        supersetDefs = selectInjectableDefs(supersetDefs, {
          customLanes: (options.lanes as Record<string, readonly string[]> | null) ?? null,
          keepModels: new Set(supersetModels),
          preferredModels: new Set(validConfiguredModels.map((m) => m.slice(m.indexOf("/") + 1))),
          capabilityOf: (modelId) => baseScoreDynamic(modelId),
          billingBoostOf, unknownOf: unknownOfModel,
          costOf: (modelId) => costOf(modelId),
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
            counts: { superset_models: supersetModels.length, shells: supersetDefs.length, full_shells: fullSupersetCount, degraded: degradedModelCount },
            mode: runMode,
            shells: supersetDefs.map(toManifestEntry),
          })
        } catch { /* fail-open */ }
        const knownProviders = new Set<string>([...supersetModels.map((m) => m.slice(0, m.indexOf("/"))), ...providerModels.providers])
        // [2026-09-01]-[异步兜底：钩子内退避仍全落回 fallback，或本次直接用了跨重启缓存（未做实时探测）时，
        //  后台继续探测——命中新 provider 只能提示需重启（cfg.agent 一次性生效的硬约束，见
        //  scheduleProviderListWatchdog 注释），但至少把"现在重启能不能生效"从盲猜变成实时、明确的状态提示]
        if (providerModels.fellBack || usedProviderCache) scheduleProviderListWatchdog(input, knownProviders)
        manager = new MatrixManager({
          stateRoot, mode: runMode, superset: supersetDefs,
          injectedNames, knownProviders,
          watchEnabled: options.matrix!.watch === true,
          onRecompute: (state, newTargets, source) => {
            clearBannerCache()
            // [2026-08-29]-[配置面变化即探：desktop 可见集开关/TUI favorites 增删（config 源）全量重探
            //  激活组合、不等 TTL；session/startup 源维持仅探新增组合；10min 周期刷新保持不变]-
           const targets = source === "config" ? (manager?.activeMatrixKeys() ?? newTargets) : newTargets
            // [2026-09-01]-[favorites/可见集变更后，侧栏快照必须等待强制全量探针完成后主动重写；
            // 不能依赖下一条聊天消息触发 bannerLines，否则推荐会长期显示旧路由]-[配置改动即时可见]
            const probeP = targets.length > 0
              ? probeKeys(targets, probeEndpoints()).catch(() => {})
              : Promise.resolve()
            // [2026-09-02]-[favorites 变更即时显示：recompute 全同步（新链在回调前已落盘），先立即重写
            //  侧栏快照——新链按收藏偏好此刻已可计算，健康/延迟沿用上轮探针；探针完成后再刷新一次
            //  收敛延迟排序。此前只在 probeP.then 重写＝探针窗口（秒级~数十秒）内侧栏停留旧链]-
            // [配置改动即时可见：通知与侧栏候选同步变化]
            refreshSidebarState()
            probeP.then(refreshSidebarState).catch(() => {})
            // [2026-08-31]-[改落盘 status-log 供 tui.tsx 侧边栏渲染，不再刷屏 stderr 遮挡输入框]-[高频重算通知]
            appendStatusLog(`激活矩阵已重算（gen=${state.generation}，激活壳 ${state.activeShells.length}，探针 ${source}×${targets.length}）`)
          },
        })
        manager.recompute(configured)
        manager.start()
        appendStatusLog(`已注入 ${injected.size} 只超集壳（可用面 ${fullSupersetCount}→精选∪全量保留，${supersetModels.length} 模型×档位，模式=${runMode}，冲突 ${conflicts.size}；激活门控运行中）`)
        // [2026-08-29]-[配置钩子触发自更新检查]-[检查异步且失败不阻塞启动]
        refreshSelfUpdate().then((state) => { if (state?.outdated) clearBannerCache() }).catch(() => {})
      } catch (exc) {
        configFailed = true
        appendStatusLog(`config 钩子 fail-open: ${exc}`)
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
        // [2026-09-02]-[去重：项目/全局 AGENTS.md 已含同文时跳过重复注入（如本插件仓库自身开发场景，
        //  省 ~2.2k token/会话）。opencode 在 transform 触发前已把装配好的系统段拼接进 system[0]
        //  （session/llm/request.ts prepare），AGENTS.md 内容可检出；未装配则检测不命中、照常注入（fail-safe）]-
        const rulesMarker = "# 全局规程（主调度员守则"
        const rulesAlreadyPresent = Array.isArray(output.system)
          && output.system.some((p) => typeof p === "string" && p.includes(rulesMarker))
        if (options.rules!.enabled && !rulesAlreadyPresent) output.system.push(AGENTS_MD.trimEnd())
        if (options.banner!.enabled) {
          for (const line of bannerLines()) output.system.push(line)
        }
      } catch (exc) {
        appendStatusLog(`规程/横幅 fail-open: ${exc}`)
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
          appendStatusLog(noteUnknownAgent(agent))
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
        if (r.note) appendStatusLog(r.note)
        if (r.deny) {
          denySkip.add(input.callID)
          throw new Error(r.deny)
        }
      } catch (exc) {
        if (denySkip.has(input.callID)) throw exc // deny 原样上抛（阻断派发）
        appendStatusLog(`六闸 fail-open（放行）: ${exc}`)
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
        // [2026-09-01]-[配置层失败分流：壳未注册＝调度层失败（探针 ok 的模型不因门控漏拦被毒化），
        //  仅审计不隔离不熔断；端点不兼容＝永久配置错误，6h 长 TTL 隔离]
        if (category === "shell_injection") {
          recordInjection(agent, reason)
          return
        }
        // [2026-08-29]-[功能1 仅动态矩阵：legacy 维持原 recordFailure 熔断路径（tester 回归发现漏_gate）]-
        const realFailed = dynamic && Boolean(combo && ctx.matrix?.combos[combo]?.status === "ok")
        if (realFailed) {
          // 限流用短 TTL（10 分钟自愈）；endpoint 用 6h（永久配置错误重试无意义）；其余默认 30 分钟
          const ttlMs = category === "rate_limit" ? RATE_LIMIT_TTL_MS : category === "endpoint" ? ENDPOINT_TTL_MS : undefined
          markRealFailure(combo!, undefined, ttlMs)
          // [2026-09-01]-[隔离事件落盘：此前纯内存零审计——横幅报 down 却查无此案]
          recordIsolation(agent, combo!, category, ttlMs ?? REAL_FAIL_TTL_MS, reason)
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
            appendStatusLog(`模型已下线（连续 404），已移出候选：${shell.provider}/${shell.modelId}`)
          }
        }
        if (rec?.tripped) appendStatusLog(`${agent} 已熔断（600s）：${reason.slice(0, 80)}`)
      } catch (exc) {
        appendStatusLog(`记账 fail-open: ${exc}`)
      }
    },
  }
}

export default SwitchmanPlugin
