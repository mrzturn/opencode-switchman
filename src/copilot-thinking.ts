// [2026-09-01]-[对齐 opencode 内置：packages/opencode/src/plugin/github-copilot/models.ts 按
// Copilot /models 返回的每模型 capabilities.supports（messagesApi/reasoning_effort/adaptive_thinking/
// max_thinking_budget）动态决定 thinking 参数形状，而非 probe.ts/shells.ts 原先按 modelId 前缀
// "claude*" 一律猜测 anthropic thinking.type:enabled + 固定 budget 表——该猜测与 claude-sonnet-5
// 实际网关能力不符，导致探针 400（matrix-down）]-
// [TTL 24h + last-good；fetch 失败/未缓存时 deriveThinkingParam 返回 null（不发明参数），
// 对齐核心"未声明变体则不带推理参数"的保守行为，优于猜错形状]
import { paths, readJson, writeJsonAtomic, appendStatusLog } from "./state"

export interface CopilotThinkingShape {
  /** supported_endpoints 含 /v1/messages（核心 isMsgApi） */
  messagesApi: boolean
  reasoningEfforts: string[]
  adaptiveThinking: boolean
  maxThinkingBudget?: number
}

interface ThinkingCache { fetched_at: number; shapes: Record<string, CopilotThinkingShape> }

const TTL_MS = 24 * 3600_000
const FETCH_TIMEOUT_MS = 15_000

export async function fetchCopilotThinkingShapes(
  ghToken: string, apiBase: string,
): Promise<Record<string, CopilotThinkingShape>> {
  const res = await fetch(`${apiBase}/models`, {
    headers: {
      Authorization: `Bearer ${ghToken}`,
      "User-Agent": "opencode/1.18.25",
      "X-GitHub-Api-Version": "2026-06-01",
    },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  })
  if (!res.ok) throw new Error(`copilot /models HTTP ${res.status}`)
  const list = ((await res.json()) as any)?.data ?? []
  const out: Record<string, CopilotThinkingShape> = {}
  for (const m of list) {
    const id = String(m?.id ?? "")
    if (!id) continue
    const sup = m?.capabilities?.supports ?? {}
    out[id] = {
      messagesApi: Array.isArray(m?.supported_endpoints) && m.supported_endpoints.includes("/v1/messages"),
      reasoningEfforts: Array.isArray(sup.reasoning_effort) ? sup.reasoning_effort.map(String) : [],
      adaptiveThinking: Boolean(sup.adaptive_thinking),
      maxThinkingBudget: typeof sup.max_thinking_budget === "number" ? sup.max_thinking_budget : undefined,
    }
  }
  return out
}

let mem: { dir: string; cache: ThinkingCache | null } | null = null

/** 同步读缓存（config 钩子/shells.ts 用，不发网络请求） */
export function loadCachedThinkingShapes(): Record<string, CopilotThinkingShape> {
  const dir = paths().dir
  if (mem?.dir !== dir) mem = { dir, cache: readJson<ThinkingCache>(paths().copilotThinking) }
  return mem?.cache?.shapes ?? {}
}

/** 过期（>TTL 或缺失）才刷新；无 token 时静默跳过（fail-open，探针照常但不发 thinking） */
export async function refreshThinkingShapesIfStale(ghToken: string | undefined, apiBase: string): Promise<void> {
  try {
    const cached = readJson<ThinkingCache>(paths().copilotThinking)
    if (cached && Date.now() - cached.fetched_at < TTL_MS) return
    if (!ghToken) return
    const shapes = await fetchCopilotThinkingShapes(ghToken, apiBase)
    if (Object.keys(shapes).length === 0) return
    const cache: ThinkingCache = { fetched_at: Date.now(), shapes }
    writeJsonAtomic(paths().copilotThinking, cache)
    mem = { dir: paths().dir, cache }
    appendStatusLog(`Copilot 思考参数形状缓存已刷新：${Object.keys(shapes).length} 模型`)
  } catch (exc) {
    appendStatusLog(`Copilot 思考参数形状刷新 fail-open: ${exc}`)
  }
}

export type ThinkingParam =
  | { kind: "reasoningEffort"; value: string }
  | { kind: "adaptive" }
  | { kind: "budget"; budgetTokens: number }
  | null

/**
 * 按 opencode 内置 models.ts 同款分支顺序推导实际请求参数：
 * !messagesApi && efforts.length → reasoningEffort；
 * efforts.length && adaptiveThinking → adaptive；
 * maxThinkingBudget → 仅 high/max 两档（核心只为这两档生成变体，low/medium/xhigh 不发参数）；
 * 形状未知/都不满足 → null（不发明参数）。
 */
export function deriveThinkingParam(shape: CopilotThinkingShape | undefined, effort: string): ThinkingParam {
  if (!shape || !effort || effort === "off") return null
  if (!shape.messagesApi && shape.reasoningEfforts.length > 0) {
    return shape.reasoningEfforts.includes(effort) ? { kind: "reasoningEffort", value: effort } : null
  }
  if (shape.reasoningEfforts.length > 0 && shape.adaptiveThinking) {
    return shape.reasoningEfforts.includes(effort) ? { kind: "adaptive" } : null
  }
  if (shape.maxThinkingBudget) {
    if (effort === "max") return { kind: "budget", budgetTokens: shape.maxThinkingBudget - 1 }
    if (effort === "high") return { kind: "budget", budgetTokens: Math.floor(shape.maxThinkingBudget / 2) }
    return null
  }
  return null
}

export * as CopilotThinking from "./copilot-thinking"
