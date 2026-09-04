// [2026-09-04]-[English localization: translate CLI messages and comments; no logic change]
// [2026-09-01]-[Aligned with opencode builtin: packages/opencode/src/plugin/github-copilot/models.ts decides the thinking parameter shape
// dynamically per model from the Copilot /models response capabilities.supports (messagesApi/reasoning_effort/adaptive_thinking/
// max_thinking_budget) instead of probe.ts/shells.ts guessing anthropic thinking.type:enabled + a fixed budget table for all
// "claude*" modelId prefixes — that guess did not match claude-sonnet-5's actual gateway capability and broke probes with 400 (matrix-down)]-
// [TTL 24h + last-good; when fetch fails/no cache, deriveThinkingParam returns null (no invented parameters),
// matching the core's conservative "no reasoning parameters for undeclared variants" behavior — better than guessing a wrong shape]
import { paths, readJson, writeJsonAtomic, appendStatusLog } from "./state"

export interface CopilotThinkingShape {
  /** supported_endpoints includes /v1/messages (core isMsgApi) */
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

/** Synchronous cache read (used by the config hook/shells.ts; no network requests) */
export function loadCachedThinkingShapes(): Record<string, CopilotThinkingShape> {
  const dir = paths().dir
  if (mem?.dir !== dir) mem = { dir, cache: readJson<ThinkingCache>(paths().copilotThinking) }
  return mem?.cache?.shapes ?? {}
}

/** Refresh only when stale (>TTL or missing); silently skipped without a token (fail-open: probes still run but send no thinking) */
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
    appendStatusLog(`Copilot thinking-parameter shape cache refreshed: ${Object.keys(shapes).length} models`)
  } catch (exc) {
    appendStatusLog(`Copilot thinking-parameter shape refresh fail-open: ${exc}`)
  }
}

export type ThinkingParam =
  | { kind: "reasoningEffort"; value: string }
  | { kind: "adaptive" }
  | { kind: "budget"; budgetTokens: number }
  | null

/**
 * Derives the actual request parameters with the same branch order as opencode's builtin models.ts:
 * !messagesApi && efforts.length → reasoningEffort;
 * efforts.length && adaptiveThinking → adaptive;
 * maxThinkingBudget → only the high/max tiers (the core only generates variants for these two; low/medium/xhigh send no parameters);
 * unknown shape / nothing matched → null (no invented parameters).
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
