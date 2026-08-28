// opencode-switchman 插件入口——唯一 OpenCode API 适配层（v1.2）
// 钩子面：config(壳注入+凭证收集) / chat.params(会话→agent 映射) /
//         experimental.chat.system.transform(调度员规程＋横幅注入，壳子代理跳过) /
//         tool.execute.before(六闸 deny) / event(失败记账→熔断)
// [fail-open 铁律：任何钩子异常只写 stderr，绝不阻塞主流程；核心逻辑全部在纯函数层]
import type { Plugin } from "@opencode-ai/plugin"
import { existsSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { AGENTS_MD } from "./assets/agents-md"
import { DELEGATION_TEMPLATE } from "./assets/delegation-template"
import {
  loadContext, buildRegistry, loadManifest, laneShells, loadRouting, paths,
  cleanExpired, ensureStateDir, stateDir,
} from "./state"
import { checkShell, noteUnknownAgent } from "./gates"
import {
  computeLane, billingWindow, poolStates, routingAdvice,
  glmExhausted, copilotExhausted, deepseekExhausted,
} from "./lane"
import { quotaView, readAuthStore, markCopilotGatewayExhausted } from "./quota"
import { costOf, refreshCosts, costsStale } from "./cost"
import { refreshMatrixIfStale } from "./probe"
import { injectShells } from "./shells"
import { buildBanner } from "./banner"
import { recordFailure, cleanRoutingExpired } from "./breaker"
import { LANE_ORDER } from "./types"
import type { SwitchmanOptions, Lane, LaneResult, Pool, ShellRegEntry } from "./types"

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
  }
}

interface Credentials { glmKey?: string; dsKey?: string; copilotToken?: string; glmBaseURL?: string; deepseekBaseURL?: string }

export const SwitchmanPlugin: Plugin = async (_input, rawOptions) => {
  const options = normalizeOptions(rawOptions)
  const creds: Credentials = { copilotToken: undefined }
  let initTried = false
  const denySkip = new Set<string>() // 自身 deny 的 callID：记账时排除
  let bannerCache: { at: number; lines: string[] } | null = null
  const sessionAgent = new Map<string, string>() // chat.params 记录：区分主模型与壳子代理请求
  const isShellSession = (sessionID: string): boolean => /-mx-/.test(sessionAgent.get(sessionID) ?? "")

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
        if (options.providers!.glm!.includes(pid)) {
          creds.glmKey = creds.glmKey ?? (typeof apiKey === "string" ? apiKey : undefined)
          creds.glmBaseURL = typeof baseURL === "string" ? baseURL : creds.glmBaseURL
        }
        if (options.providers!.deepseek!.includes(pid)) {
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

  function warmup(): void {
    if (initTried) return
    initTried = true
    try {
      ensureStateDir()
      ensureStateAssets()
      creds.copilotToken = creds.copilotToken ?? readAuthStore().githubToken
      if (costsStale() && options.cost!.enabled) refreshCosts().catch(() => {})
      refreshMatrixIfStale(probeEndpoints()).catch(() => {})
      quotaView(creds as any, { enabled: {
        glm: options.quota!.glm!.enabled!,
        deepseek: options.quota!.deepseek!.enabled!,
        copilot: options.quota!.copilot!.enabled!,
      } })
      // [2026-08-28]-[探针/配额/成本只在启动跑一次，启动竞态（如核心晚回写 token）或高峰限流后永不自愈]-
      // [10min 周期刷新：矩阵 TTL 内自动跳过，配额/成本由各自 TTL 兜底；timer unref 不阻进程退出]
      const timer = setInterval(() => {
        try {
          refreshMatrixIfStale(probeEndpoints()).catch(() => {})
          quotaView(creds as any, { enabled: {
            glm: options.quota!.glm!.enabled!,
            deepseek: options.quota!.deepseek!.enabled!,
            copilot: options.quota!.copilot!.enabled!,
          } })
          if (costsStale() && options.cost!.enabled) refreshCosts().catch(() => {})
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
      const qv = quotaView(creds as any, { enabled: {
        glm: options.quota!.glm!.enabled!,
        deepseek: options.quota!.deepseek!.enabled!,
        copilot: options.quota!.copilot!.enabled!,
      } })
      return {
        glm: glmExhausted(qv.glm, options.quota!.glm!.fiveHourReservePct)[0],
        copilot: copilotExhausted(qv.copilot)[0],
        deepseek: deepseekExhausted(qv.deepseek)[0],
      }
    } catch {
      return {}
    }
  }

  function currentContext() {
    warmup()
    const ctx = loadContext(options, creds as any)
    try {
      cleanExpired(ctx.routing)
    } catch { /* fail-open */ }
    const registry = buildRegistry(ctx)
    return { ctx, registry }
  }

  function bannerLines(): string[] {
    try {
      if (bannerCache && Date.now() - bannerCache.at < 15_000) return bannerCache.lines
      const { ctx, registry } = currentContext()
      const quotaEx = quotaExhaustedFlags()
      const costs = options.cost!.enabled ? costOf : null
      const lanes: Record<string, LaneResult> = {}
      const peak = billingWindow(new Date(), options.billingWindow)
      const states = poolStates(quotaView(creds as any, { enabled: {
        glm: options.quota!.glm!.enabled!,
        deepseek: options.quota!.deepseek!.enabled!,
        copilot: options.quota!.copilot!.enabled!,
      } }), peak)
      for (const lane of LANE_ORDER) {
        try {
          lanes[lane] = computeLane(lane, laneShells(ctx, lane), {
            registry, matrix: ctx.matrix?.combos ?? null, routing: ctx.routing,
            quotaExhausted: quotaEx, states, glmPeak: peak.glmPeak, costs,
          })
        } catch { /* 单档失败不影响其余档 */ }
      }
      const down = new Set(Object.keys(ctx.routing.down_agents))
      const lines = buildBanner({
        lanes: lanes as any,
        down,
        quota: { glm: null as any, copilot: null as any },
        states,
        billing: peak,
        advice: routingAdvice(states),
      })
      // [水位] 行需要原始配额数据 → 二次组装（banner 纯函数吃快照；这里补真实 quota）
      const qv = quotaView(creds as any, { enabled: {
        glm: options.quota!.glm!.enabled!,
        deepseek: options.quota!.deepseek!.enabled!,
        copilot: options.quota!.copilot!.enabled!,
      } })
      const lines2 = buildBanner({
        lanes: lanes as any,
        down,
        quota: { glm: qv.glm, copilot: qv.copilot, deepseek: qv.deepseek },
        states,
        billing: peak,
        advice: routingAdvice(states),
        dsLowWarnCny: options.quota!.deepseek!.lowBalanceWarnCny,
      })
      bannerCache = { at: Date.now(), lines: lines2 }
      return lines2
    } catch (exc) {
      console.error(`[opencode-switchman] banner fail-open: ${exc}`)
      return []
    }
  }

  return {
    config: async (cfg: Record<string, any>) => {
      try {
        collectCreds(cfg)
        creds.copilotToken = creds.copilotToken ?? readAuthStore().githubToken
        const { registry } = currentContext()
        const n = injectShells(cfg, registry)
        console.log(`[opencode-switchman] 已注入 ${n} 只模型空壳（agent）`)
      } catch (exc) {
        console.error(`[opencode-switchman] config 钩子 fail-open: ${exc}`)
      }
    },

    "chat.params": async (input) => {
      try {
        if (input.sessionID && input.agent) sessionAgent.set(input.sessionID, input.agent)
      } catch { /* fail-open */ }
    },

    "experimental.chat.system.transform": async (input, output) => {
      try {
        // 壳子代理不注入调度员规程与横幅（角色已是执行体，省 token 且防角色混淆）
        if (input.sessionID && isShellSession(input.sessionID)) return
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
        const { registry } = currentContext()
        cleanRoutingExpired()
        const agent = String(output.args?.subagent_type ?? "").trim()
        if (!agent) return
        const shell: ShellRegEntry | undefined = registry[agent]
        if (!shell) {
          console.error(noteUnknownAgent(agent))
          return
        }
        const r = checkShell(agent, shell, output.args?.prompt, {
          registry,
          matrix: loadContext(options, creds as any).matrix?.combos ?? null,
          routing: loadRouting(),
          quotaExhausted: quotaExhaustedFlags(),
          costs: options.cost!.enabled ? costOf : undefined,
          lanes: loadManifest().lanes as any,
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
        if (event.type !== "message.part.updated") return
        const part = (event as any).properties?.part
        if (part?.type !== "tool" || part?.state?.status !== "error") return
        if (part.callID && denySkip.has(part.callID)) {
          denySkip.delete(part.callID)
          return // 自身 deny 不记账
        }
        const agent = String(part.state?.input?.subagent_type ?? "").trim()
        if (!agent) return
        const { registry } = currentContext()
        const reason = String(part.state?.error ?? part.state?.message ?? "派发失败").slice(0, 300)
        const rec = recordFailure(agent, reason, registry)
        // Copilot 网关额度类错误 → 第二真值源置池耗尽（信任至 reset_date）
        if (/429|quota|premium.*(limit|exhaust)|monthly.*limit/i.test(reason)) {
          const shell = registry[agent]
          if (shell?.pool === "copilot") markCopilotGatewayExhausted(reason)
        }
        if (rec.tripped) console.error(`[opencode-switchman] ${agent} 已熔断（600s）：${reason.slice(0, 80)}`)
      } catch (exc) {
        console.error(`[opencode-switchman] 记账 fail-open: ${exc}`)
      }
    },
  }
}

export default SwitchmanPlugin
