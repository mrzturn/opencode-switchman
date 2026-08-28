// 探针：真实请求探活 → model-matrix.json
// [2026-08-28]-[Copilot 鉴权对齐 opencode 核心：GitHub OAuth token 直连 api.githubcopilot.com，
// 免 v2/token 交换（gho_ token 换取会 403）；端点/请求头照抄 packages/opencode/src/plugin/github-copilot/copilot.ts]-
// [口径：TTL 600s；2xx=ok；30s 内有响应=慢而可用不判 down（超时 45s 判 down）；并发 8-32]
import { readCopilotGithubToken, markCopilotGatewayExhausted } from "./quota"
import { loadManifest, loadMatrix, paths, writeJsonAtomic, PROBE_TTL } from "./state"
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
  if (provider.startsWith("zhipuai") || provider.startsWith("glm") || provider.startsWith("zai")) {
    if (!eps.glmKey) return null
    const base = eps.glmBaseURL ?? "https://open.bigmodel.cn/api/coding/paas/v4"
    const body: Record<string, unknown> = { model: modelId, max_tokens: 8, messages: [{ role: "user", content: "回复：OK" }] }
    if (hasEffort) body.reasoning_effort = effort
    return { url: `${base}/chat/completions`, headers: { "Content-Type": "application/json", Authorization: `Bearer ${eps.glmKey}` }, body }
  }
  if (provider === "deepseek") {
    if (!eps.dsKey) return null
    const base = eps.deepseekBaseURL ?? "https://api.deepseek.com"
    const body: Record<string, unknown> = { model: modelId, max_tokens: 8, messages: [{ role: "user", content: "回复：OK" }] }
    if (hasEffort) body.reasoning_effort = effort
    return { url: `${base}/chat/completions`, headers: { "Content-Type": "application/json", Authorization: `Bearer ${eps.dsKey}` }, body }
  }
  return null
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

/** 探测全部壳组合并写矩阵（后台调用；全链 fail-open） */
export async function refreshMatrix(eps: ProbeEndpoints): Promise<number | null> {
  try {
    const targets = new Map<string, [string, string, string]>()
    for (const s of loadManifest().shells) {
      const [prov, model, eff] = s.matrixKey.split("|")
      targets.set(s.matrixKey, [prov!, model!, eff!])
    }
    const gh = readCopilotGithubToken()
    const combos: Record<string, any> = {}
    const keys = [...targets.keys()].sort()
    const workers = Math.max(8, Math.min(32, keys.length))
    let idx = 0
    async function run() {
      while (idx < keys.length) {
        const key = keys[idx++]!
        const [prov, model, eff] = targets.get(key)!
        const res = await probeOne(prov, model, eff, eps, gh)
        combos[key] = { ...res, checked_at: new Date().toISOString() }
      }
    }
    await Promise.all(Array.from({ length: workers }, run))
    // [v1.1 坑位第二真值源] Copilot 组合普遍 402 monthly quota → 置池耗尽信任至 reset_date
    // （/user 快照 unlimited:true 与网关实况背离，已实测坐实；429 是并发限流噪音，不计入）
    const cpKeys = keys.filter((k) => k.startsWith("github-copilot|"))
    const cp402 = cpKeys.filter((k) => /402|exceeded.*monthly|monthly.*quota/i.test(String(combos[k]?.reason ?? "")))
    if (cpKeys.length > 0 && cp402.length >= Math.max(3, Math.ceil(cpKeys.length * 0.5))) {
      markCopilotGatewayExhausted(`探针 ${cp402.length}/${cpKeys.length} 组合 402 月度池耗尽`)
      console.log(`[opencode-switchman] Copilot 月度池耗尽（网关第二真值源），信任至 reset_date`)
    }
    const matrix: Matrix = { combos, generated_at: new Date().toISOString() }
    writeJsonAtomic(paths().matrix, matrix)
    const ok = Object.values(combos).filter((c) => c.status === "ok").length
    console.log(`[opencode-switchman] 矩阵已刷新：${keys.length} 组合 ${ok} ok`)
    return ok
  } catch (exc) {
    console.error(`[opencode-switchman] 探针 fail-open: ${exc}`)
    return null
  }
}

/** 矩阵过期（>TTL 或缺失）才刷新 */
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
