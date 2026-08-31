// 探针：真实请求探活 → model-matrix.json
// [2026-08-28]-[Copilot 鉴权对齐 opencode 核心：GitHub OAuth token 直连 api.githubcopilot.com，
// 免 v2/token 交换（gho_ token 换取会 403）；端点/请求头照抄 packages/opencode/src/plugin/github-copilot/copilot.ts]-
// [口径：TTL 600s；2xx=ok；30s 内有响应=慢而可用不判 down（超时 45s 判 down）；并发 8-32]
import { readCopilotGithubToken, markCopilotGatewayExhausted } from "./quota"
import { loadManifest, loadMatrix, paths, writeJsonAtomic, withPathLock, PROBE_TTL } from "./state"
import { classifyFailure } from "./failclass"
import { poolForProviderId } from "./provider-config"
import type { Matrix } from "./types"

const PROBE_TIMEOUT_MS = 45_000
const COPILOT_BASE = "https://api.githubcopilot.com"
const COPILOT_UA = "opencode/1.18.25"
const COPILOT_API_VERSION = "2026-06-01"

export interface ProbeEndpoints {
  copilotApiBase?: string
  glmBaseURL?: string
  deepseekBaseURL?: string
  glmKey?: string
  dsKey?: string
}

function copilotHeaders(token: string, extra: Record<string, string> = {}): Record<string, string> {
  return {
    "Content-Type": "application/json",
    Authorization: `Bearer ${token}`,
    "User-Agent": COPILOT_UA,
    "X-GitHub-Api-Version": COPILOT_API_VERSION,
    "x-initiator": "agent",
    ...extra,
  }
}

function buildRequest(
  provider: string, modelId: string, effort: string, eps: ProbeEndpoints, ghToken: string | undefined,
): { url: string; headers: Record<string, string>; body: Record<string, unknown> } | null {
  const hasEffort = effort !== "off" && effort !== ""
  if (provider === "github-copilot") {
    if (!ghToken) return null
    const base = eps.copilotApiBase ?? COPILOT_BASE
    if (modelId.startsWith("claude")) {
      const headers = copilotHeaders(ghToken, { "anthropic-version": "2023-06-01" })
      const body: Record<string, unknown> = {
        model: modelId, max_tokens: 16,
        messages: [{ role: "user", content: "回复：OK" }],
      }
      if (hasEffort) {
        body.thinking = { type: "enabled", budget_tokens: effort === "low" ? 1024 : effort === "medium" ? 2048 : 16384 }
      }
      return { url: `${base}/v1/messages`, headers, body }
    }
    const useResponses = !/^(gemini|kimi|mai)/.test(modelId)
    if (useResponses) {
      const body: Record<string, unknown> = { model: modelId, input: "回复：OK", max_output_tokens: 16 }
      if (hasEffort) body.reasoning = { effort }
      return { url: `${base}/responses`, headers: copilotHeaders(ghToken), body }
    }
    const body: Record<string, unknown> = { model: modelId, max_tokens: 8, messages: [{ role: "user", content: "回复：OK" }] }
    if (hasEffort) body.reasoning_effort = effort
    return { url: `${base}/chat/completions`, headers: copilotHeaders(ghToken), body }
  }
  if (poolForProviderId(provider) === "glm") {
    if (!eps.glmKey) return null
    const base = eps.glmBaseURL ?? "https://open.bigmodel.cn/api/coding/paas/v4"
    const body: Record<string, unknown> = { model: modelId, max_tokens: 8, messages: [{ role: "user", content: "回复：OK" }] }
    if (hasEffort) body.reasoning_effort = effort
    return { url: `${base}/chat/completions`, headers: { "Content-Type": "application/json", Authorization: `Bearer ${eps.glmKey}` }, body }
  }
  if (poolForProviderId(provider) === "deepseek") {
    if (!eps.dsKey) return null
    const base = eps.deepseekBaseURL ?? "https://api.deepseek.com"
    const body: Record<string, unknown> = { model: modelId, max_tokens: 8, messages: [{ role: "user", content: "回复：OK" }] }
    if (hasEffort) body.reasoning_effort = effort
    return { url: `${base}/chat/completions`, headers: { "Content-Type": "application/json", Authorization: `Bearer ${eps.dsKey}` }, body }
  }
  return null
}

/**
 * [2026-08-29]-[评分引擎：探针结果状态归一纯函数——down+rate_limit(429) 转 strained（健康 0.6 参与而非出局），
 *  其余类别维持原状；供 probeTargets 落盘前调用，也便于纯函数层测试]
 */
export function classifyProbeStatus(raw: { status: "ok" | "down" | "unknown"; reason?: string }): "ok" | "strained" | "down" | "unknown" {
  if (raw.status === "down" && classifyFailure(String(raw.reason ?? "")) === "rate_limit") return "strained"
  return raw.status
}

async function probeOne(
  provider: string, modelId: string, effort: string, eps: ProbeEndpoints, ghToken: string | undefined,
): Promise<{ status: "ok" | "down" | "unknown"; reason?: string; latency_ms: number | null }> {
  const req = buildRequest(provider, modelId, effort, eps, ghToken)
  if (!req) return { status: "unknown", reason: "无可用端点/凭证", latency_ms: null }
  const t0 = Date.now()
  try {
    const res = await fetch(req.url, {
      method: "POST",
      headers: req.headers,
      body: JSON.stringify(req.body),
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    })
    const latency = Date.now() - t0
    if (res.status >= 200 && res.status < 300) return { status: "ok", latency_ms: latency }
    let reason = `HTTP ${res.status}`
    try {
      const text = (await res.text()).slice(0, 120)
      if (text) reason += `: ${text.split(/\s+/).join(" ")}`
    } catch { /* 空响应体 */ }
    return { status: "down", reason, latency_ms: latency }
  } catch (exc) {
    return { status: "down", reason: `${(exc as Error).name}: ${(exc as Error).message}`.slice(0, 160), latency_ms: Date.now() - t0 }
  }
}

/** 探测全部壳组合并写矩阵（后台调用；全链 fail-open；legacy 全量路径） */
export async function refreshMatrix(eps: ProbeEndpoints): Promise<number | null> {
  try {
    const targets = new Map<string, [string, string, string]>()
    for (const s of loadManifest().shells) {
      const [prov, model, eff] = s.matrixKey.split("|")
      targets.set(s.matrixKey, [prov!, model!, eff!])
    }
    return await probeTargets([...targets.keys()], eps, targets)
  } catch (exc) {
    console.error(`[opencode-switchman] 探针 fail-open: ${exc}`)
    return null
  }
}

/**
 * [2026-08-29]-[动态矩阵增量探测：只探给定组合（ro 别名共享 matrixKey，按 key 去重），
 * 读改写合并保留其余组合与 active_keys/target_generation 字段]
 */
export async function probeKeys(keys: string[], eps: ProbeEndpoints): Promise<number | null> {
  try {
    const targets = new Map<string, [string, string, string]>()
    for (const key of keys) {
      const [prov, model, eff] = key.split("|")
      if (prov && model && eff) targets.set(key, [prov, model, eff])
    }
    return await probeTargets([...targets.keys()], eps, targets)
  } catch (exc) {
    console.error(`[opencode-switchman] 增量探针 fail-open: ${exc}`)
    return null
  }
}

async function probeTargets(
  keys: string[], eps: ProbeEndpoints, targets: Map<string, [string, string, string]>,
): Promise<number | null> {
  try {
    const sorted = [...new Set(keys)].sort()
    // [2026-08-29]-[修复复审P1-写入竞态：起始捕获 target_generation；本轮只持自己的探测结果，
    // 完成时在串行临界区内重读盘面——代际已变则整轮丢弃（新代际重算会重新调度探针）]
    const gen0 = loadMatrix()?.target_generation
    const results: Record<string, any> = {}
    const gh = readCopilotGithubToken()
    const workers = Math.max(8, Math.min(32, sorted.length))
    let idx = 0
    async function run() {
      while (idx < sorted.length) {
        const key = sorted[idx++]!
        const [prov, model, eff] = targets.get(key)!
        const r = await probeOne(prov, model, eff, eps, gh)
        // [2026-08-29]-[评分引擎：429 限流类失败不再写 down——写 strained（保留 reason/latency/checked_at），
        //  评分层 health=0.6 参与而非出局；其余类别维持原状]
        results[key] = { ...r, status: classifyProbeStatus(r), checked_at: new Date().toISOString() }
      }
    }
    await Promise.all(Array.from({ length: workers }, run))
    // [v1.1 坑位第二真值源] Copilot 组合普遍 402 monthly quota → 置池耗尽信任至 reset_date
    // （/user 快照 unlimited:true 与网关实况背离，已实测坐实；429 是并发限流噪音，不计入）
    const cpKeys = sorted.filter((k) => k.startsWith("github-copilot|"))
    const cp402 = cpKeys.filter((k) => /402|exceeded.*monthly|monthly.*quota/i.test(String(results[k]?.reason ?? "")))
    // [2026-08-28]-[402 是月度池耗尽真值（429 为并发限流噪音），阈值从 50% 降到 ≥3 个组合即置耗尽]
    if (cpKeys.length > 0 && cp402.length >= 3) {
      markCopilotGatewayExhausted(`探针 ${cp402.length}/${cpKeys.length} 组合 402 月度池耗尽`)
      console.log(`[opencode-switchman] Copilot 月度池耗尽（网关第二真值源），信任至 reset_date`)
    }
    return await withPathLock(paths().matrix, () => {
      const cur = loadMatrix() ?? ({} as Matrix)
      if ((cur.target_generation ?? undefined) !== (gen0 ?? undefined)) {
        console.error(`[opencode-switchman] 探针结果丢弃（矩阵代际已变 ${gen0 ?? "n/a"}→${cur.target_generation ?? "n/a"}；由新代际重算重新调度）`)
        return null
      }
      // 合并以写入时最新盘面为基（保留并发写入的其余组合与 active_keys/target_generation，不丢更新）
      const matrix: Matrix = { ...cur, combos: { ...(cur.combos ?? {}), ...results }, generated_at: new Date().toISOString() }
      writeJsonAtomic(paths().matrix, matrix)
      const ok = Object.values(matrix.combos).filter((c) => c.status === "ok").length
      console.log(`[opencode-switchman] 矩阵已刷新：${sorted.length} 组合 ${ok} ok（累计 ${Object.keys(matrix.combos).length}）`)
      return ok
    })
  } catch (exc) {
    console.error(`[opencode-switchman] 探针 fail-open: ${exc}`)
    return null
  }
}

/** 矩阵过期（>TTL 或缺失）才刷新（legacy 全量路径） */
export async function refreshMatrixIfStale(eps: ProbeEndpoints): Promise<void> {
  try {
    const m = loadMatrix()
    if (m?.generated_at) {
      const age = (Date.now() - new Date(m.generated_at).getTime()) / 1000
      if (age < PROBE_TTL) return
    }
    await refreshMatrix(eps)
  } catch (exc) {
    console.error(`[opencode-switchman] 探针调度 fail-open: ${exc}`)
  }
}

/** [2026-08-29]-[动态矩阵：只刷新激活组合（TTL 门控同上；激活面为空则不探）] */
export async function refreshActiveMatrixIfStale(eps: ProbeEndpoints, activeKeys: string[]): Promise<void> {
  try {
    if (activeKeys.length === 0) return
    const m = loadMatrix()
    if (m?.generated_at) {
      const age = (Date.now() - new Date(m.generated_at).getTime()) / 1000
      if (age < PROBE_TTL) return
    }
    await probeKeys(activeKeys, eps)
  } catch (exc) {
    console.error(`[opencode-switchman] 探针调度 fail-open: ${exc}`)
  }
}
