// [2026-09-04]-[English localization: translate comments and status messages; no logic change]
// Probe: real-request liveness checks -> model-matrix.json
// [2026-08-28]-[Copilot auth aligned with the opencode core: GitHub OAuth token straight to api.githubcopilot.com,
// skipping the v2/token exchange (the gho_ token exchange returns 403); endpoint/headers copied from packages/opencode/src/plugin/github-copilot/copilot.ts]-
// [calibration: TTL 600s; 2xx=ok; any response within 30s=slow but usable, not down (timeout 45s marks down); concurrency 8-32]
import { readCopilotGithubToken, markCopilotGatewayExhausted } from "./quota"
import { loadManifest, loadMatrix, paths, writeJsonAtomic, withPathLock, PROBE_TTL, appendStatusLog } from "./state"
import { classifyFailure } from "./failclass"
import { poolForProviderId } from "./provider-config"
import { refreshThinkingShapesIfStale, loadCachedThinkingShapes, deriveThinkingParam, type CopilotThinkingShape } from "./copilot-thinking"
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
  shapes: Record<string, CopilotThinkingShape>,
): { url: string; headers: Record<string, string>; body: Record<string, unknown> } | null {
  const hasEffort = effort !== "off" && effort !== ""
  if (provider === "github-copilot") {
    if (!ghToken) return null
    const base = eps.copilotApiBase ?? COPILOT_BASE
    const shape = shapes[modelId]
    // [2026-09-01]-[endpoint selection aligned with the core isMsgApi (supported_endpoints includes /v1/messages): when the
    //  shape cache is known route by the real value; only unknown (cold start/no token) falls back to the modelId prefix heuristic,
    //  avoiding 400s from misjudging "new non-claude-named models on the messages API" or the reverse]
    const useMessagesApi = shape ? shape.messagesApi : modelId.startsWith("claude")
    if (useMessagesApi) {
      const headers = copilotHeaders(ghToken, { "anthropic-version": "2023-06-01" })
      const body: Record<string, unknown> = {
        model: modelId, max_tokens: 16,
        messages: [{ role: "user", content: "Reply: OK" }],
      }
      // [2026-09-01]-[aligned with the core models.ts: derive from the model's real capabilities.supports; unknown/unsatisfied
      //  shape sends no thinking (no longer unconditionally guessing by modelId prefix); the budget branch raises max_tokens
      //  accordingly (Anthropic hard constraint: max_tokens must be > thinking.budget_tokens)]
      const param = hasEffort ? deriveThinkingParam(shape, effort) : null
      if (param?.kind === "budget") {
        body.thinking = { type: "enabled", budget_tokens: param.budgetTokens }
        body.max_tokens = Math.max(16, param.budgetTokens + 8)
      } else if (param?.kind === "adaptive") {
        body.thinking = { type: "adaptive" }
      }
      return { url: `${base}/v1/messages`, headers, body }
    }
    const useResponses = !/^(gemini|kimi|mai)/.test(modelId)
    if (useResponses) {
      const body: Record<string, unknown> = { model: modelId, input: "Reply: OK", max_output_tokens: 16 }
      const param = hasEffort ? deriveThinkingParam(shape, effort) : null
      if (param?.kind === "reasoningEffort") body.reasoning = { effort: param.value }
      else if (hasEffort && !shape) body.reasoning = { effort } // shape unknown: keep the old heuristic as fallback
      return { url: `${base}/responses`, headers: copilotHeaders(ghToken), body }
    }
    const body: Record<string, unknown> = { model: modelId, max_tokens: 8, messages: [{ role: "user", content: "Reply: OK" }] }
    if (hasEffort) body.reasoning_effort = effort
    return { url: `${base}/chat/completions`, headers: copilotHeaders(ghToken), body }
  }
  if (poolForProviderId(provider) === "glm") {
    if (!eps.glmKey) return null
    const base = eps.glmBaseURL ?? "https://open.bigmodel.cn/api/coding/paas/v4"
    const body: Record<string, unknown> = { model: modelId, max_tokens: 8, messages: [{ role: "user", content: "Reply: OK" }] }
    if (hasEffort) body.reasoning_effort = effort
    return { url: `${base}/chat/completions`, headers: { "Content-Type": "application/json", Authorization: `Bearer ${eps.glmKey}` }, body }
  }
  if (poolForProviderId(provider) === "deepseek") {
    if (!eps.dsKey) return null
    const base = eps.deepseekBaseURL ?? "https://api.deepseek.com"
    const body: Record<string, unknown> = { model: modelId, max_tokens: 8, messages: [{ role: "user", content: "Reply: OK" }] }
    if (hasEffort) body.reasoning_effort = effort
    return { url: `${base}/chat/completions`, headers: { "Content-Type": "application/json", Authorization: `Bearer ${eps.dsKey}` }, body }
  }
  return null
}

/**
 * [2026-08-29]-[scoring engine: pure function normalizing probe result status -- down+rate_limit(429) becomes strained
 *  (health 0.6 participates instead of being out); other categories unchanged; called by probeTargets before persisting,
 *  also handy for pure-function-layer tests]
 */
export function classifyProbeStatus(raw: { status: "ok" | "down" | "unknown"; reason?: string }): "ok" | "strained" | "down" | "unknown" {
  if (raw.status === "down" && classifyFailure(String(raw.reason ?? "")) === "rate_limit") return "strained"
  return raw.status
}

async function probeOne(
  provider: string, modelId: string, effort: string, eps: ProbeEndpoints, ghToken: string | undefined,
  shapes: Record<string, CopilotThinkingShape>,
): Promise<{ status: "ok" | "down" | "unknown"; reason?: string; latency_ms: number | null }> {
  const req = buildRequest(provider, modelId, effort, eps, ghToken, shapes)
  if (!req) return { status: "unknown", reason: "no usable endpoint/credentials", latency_ms: null }
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
    } catch { /* empty response body */ }
    return { status: "down", reason, latency_ms: latency }
  } catch (exc) {
    return { status: "down", reason: `${(exc as Error).name}: ${(exc as Error).message}`.slice(0, 160), latency_ms: Date.now() - t0 }
  }
}

/** Probe all shell combos and write the matrix (background call; fail-open throughout; legacy full path) */
export async function refreshMatrix(eps: ProbeEndpoints): Promise<number | null> {
  try {
    const targets = new Map<string, [string, string, string]>()
    for (const s of loadManifest().shells) {
      const [prov, model, eff] = s.matrixKey.split("|")
      targets.set(s.matrixKey, [prov!, model!, eff!])
    }
    return await probeTargets([...targets.keys()], eps, targets)
  } catch (exc) {
    appendStatusLog(`probe fail-open: ${exc}`)
    return null
  }
}

/**
 * [2026-08-29]-[dynamic matrix incremental probing: only probe the given combos (ro aliases share the matrixKey, dedupe by key);
 * read-modify-write merge keeps the other combos and the active_keys/target_generation fields]
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
    appendStatusLog(`incremental probe fail-open: ${exc}`)
    return null
  }
}

async function probeTargets(
  keys: string[], eps: ProbeEndpoints, targets: Map<string, [string, string, string]>,
): Promise<number | null> {
  try {
    const sorted = [...new Set(keys)].sort()
    // [2026-08-29]-[fix review-P1 write race: capture target_generation at the start; this round holds only its own probe
    // results; on completion re-read the disk inside the serial critical section -- if the generation changed discard the
    // whole round (the new generation recompute reschedules probes)]
    const gen0 = loadMatrix()?.target_generation
    const results: Record<string, any> = {}
    const gh = readCopilotGithubToken()
    // [2026-09-01]-[aligned with the core: refresh the Copilot real capability-shape cache before probing (TTL 24h gated short-circuit, fail-open)]
    await refreshThinkingShapesIfStale(gh, eps.copilotApiBase ?? COPILOT_BASE)
    const shapes = loadCachedThinkingShapes()
    const workers = Math.max(8, Math.min(32, sorted.length))
    let idx = 0
    async function run() {
      while (idx < sorted.length) {
        const key = sorted[idx++]!
        const [prov, model, eff] = targets.get(key)!
        const r = await probeOne(prov, model, eff, eps, gh, shapes)
        // [2026-08-29]-[scoring engine: 429 rate-limit failures no longer write down -- write strained (keeping
        //  reason/latency/checked_at); the scoring layer health=0.6 participates instead of being out; other categories unchanged]
        results[key] = { ...r, status: classifyProbeStatus(r), checked_at: new Date().toISOString() }
      }
    }
    await Promise.all(Array.from({ length: workers }, run))
    // [v1.1 quota second source of truth] Copilot combos broadly hit 402 monthly quota -> mark pool exhausted trusted until reset_date
    // (the /user snapshot unlimited:true diverges from gateway reality, confirmed by measurement; 429 is concurrency rate-limit noise, not counted)
    const cpKeys = sorted.filter((k) => k.startsWith("github-copilot|"))
    const cp402 = cpKeys.filter((k) => /402|exceeded.*monthly|monthly.*quota/i.test(String(results[k]?.reason ?? "")))
    // [2026-08-28]-[402 is the monthly-pool-exhausted truth (429 is concurrency noise); threshold lowered from 50% to >=3 combos to mark exhaustion]
    if (cpKeys.length > 0 && cp402.length >= 3) {
      markCopilotGatewayExhausted(`probe ${cp402.length}/${cpKeys.length} combos 402 monthly pool exhausted`)
      appendStatusLog(`Copilot monthly pool exhausted (gateway second source of truth), trusted until reset_date`)
    }
    return await withPathLock(paths().matrix, () => {
      const cur = loadMatrix() ?? ({} as Matrix)
      if ((cur.target_generation ?? undefined) !== (gen0 ?? undefined)) {
        // [2026-08-31]-[switched to persisting via the status-log for tui.tsx sidebar rendering, no longer spamming stderr over the input box]
        appendStatusLog(`probe results discarded (matrix generation changed ${gen0 ?? "n/a"}->${cur.target_generation ?? "n/a"}; rescheduled by the new generation recompute)`)
        return null
      }
      // Merge on top of the latest disk state at write time (keeps concurrently written combos and active_keys/target_generation, no lost updates)
      const matrix: Matrix = { ...cur, combos: { ...(cur.combos ?? {}), ...results }, generated_at: new Date().toISOString() }
      writeJsonAtomic(paths().matrix, matrix)
      const ok = Object.values(matrix.combos).filter((c) => c.status === "ok").length
      appendStatusLog(`matrix refreshed: ${sorted.length} combos ${ok} ok (total ${Object.keys(matrix.combos).length})`)
      return ok
    })
  } catch (exc) {
    appendStatusLog(`probe fail-open: ${exc}`)
    return null
  }
}

/** Refresh only when the matrix is stale (>TTL or missing; legacy full path) */
export async function refreshMatrixIfStale(eps: ProbeEndpoints): Promise<void> {
  try {
    const m = loadMatrix()
    if (m?.generated_at) {
      const age = (Date.now() - new Date(m.generated_at).getTime()) / 1000
      if (age < PROBE_TTL) return
    }
    await refreshMatrix(eps)
  } catch (exc) {
    appendStatusLog(`probe scheduling fail-open: ${exc}`)
  }
}

/** [2026-08-29]-[dynamic matrix: refresh only active combos (same TTL gating; no probing when the active set is empty)] */
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
    appendStatusLog(`probe scheduling fail-open: ${exc}`)
  }
}
