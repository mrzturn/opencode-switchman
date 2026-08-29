// 模型策展能力分表（S/A/B/C 四档）＋ baseScore 追溯匹配
// [2026-08-29]-[校准日期 2026-08-29，参考 LMArena/SWE-bench，手动校准；base 压倒一切软系数]
// 匹配顺序：精确键 → 最长前缀 → family 中位数 → 全局 0.7；返回 source 供决策日志追溯。
export type Tier = "S" | "A" | "B" | "C"

export const TIER_SCORE: Record<Tier, number> = {
  S: 1.0,
  A: 0.85,
  B: 0.7,
  C: 0.55,
}

// 键=小写 modelId（不含 provider 前缀）；变体（-codex/-luna/-sol/-terra/-vision/-preview）走前缀匹配
export const MODEL_TIERS: Record<string, Tier> = {
  // ---- S 档 ----
  "claude-opus-4.8": "S",
  "claude-opus-5": "S",
  "gpt-5.5": "S",
  "gpt-5.6": "S", // gpt-5.6-codex/-luna/-sol/-terra 前缀命中
  "gemini-3.1-pro": "S", // gemini-3.1-pro-preview 前缀命中
  "deepseek-v4-pro": "S",
  // ---- A 档 ----
  "claude-sonnet-4.6": "A",
  "claude-sonnet-5": "A",
  "claude-opus-4.7": "A",
  "gpt-5.4": "A",
  "glm-5.3": "A",
  "glm-5.2": "A",
  "grok-4.6": "A",
  "kimi-k3": "A",
  "gpt-5.6-mini": "A",
  // ---- B 档 ----
  "glm-5.3-flash": "B",
  "glm-5-turbo": "B",
  "glm-4.7": "B",
  "deepseek-v4-flash": "B", // -vision 前缀命中
  "gemini-3.5-flash": "B",
  "gemini-3.6-flash": "B",
  "gemini-3.7-flash": "B",
  "kimi-k2.7": "B",
  "mai-code-1.1": "B",
  "grok-4.5": "B",
  "gpt-5-mini": "B",
  // ---- C 档 ----
  "glm-4.5-air": "C",
  "glm-4.6v": "C",
  "glm-5v-turbo": "C",
  "glm-5.1": "C",
  // 其余 free/mini/legacy 走 family 中位数 / 全局兜底
}

/** 全局中位数（family 未知时的兜底分） */
export const GLOBAL_MEDIAN_SCORE = 0.7

// ---- family 判定（与 catalog.familyOf 同源；provider→family 映射隐含于 modelId 前缀：
//  zhipuai/glm 系→glm- 前缀、deepseek 系→deepseek- 前缀、github-copilot 按 modelId 自身前缀）----
function familyOfModel(modelId: string): string {
  const m = /^(claude|gpt|gemini|grok|kimi|glm|deepseek|mai)/.exec(modelId)
  return m ? m[1] : modelId.split(/[^a-zA-Z0-9]/)[0] || "unknown"
}

// family 中位数：由表内同族条目分数求中位（偶数取两中项均值）
const FAMILY_MEDIAN: Record<string, number> = (() => {
  const byFamily: Record<string, number[]> = {}
  for (const key of Object.keys(MODEL_TIERS)) {
    const fam = familyOfModel(key)
    ;(byFamily[fam] ??= []).push(TIER_SCORE[MODEL_TIERS[key]])
  }
  const out: Record<string, number> = {}
  for (const [fam, scores] of Object.entries(byFamily)) {
    const s = [...scores].sort((a, b) => a - b)
    const mid = Math.floor(s.length / 2)
    out[fam] = s.length % 2 === 1 ? s[mid] : (s[mid - 1] + s[mid]) / 2
  }
  return out
})()

function scoreToTier(score: number): Tier {
  if (score >= 1.0) return "S"
  if (score >= 0.85) return "A"
  if (score >= 0.7) return "B"
  return "C"
}

export interface BaseScoreResult {
  score: number
  tier: Tier
  source: "exact" | "prefix" | "family" | "global"
}

/** 策展能力分（base）：精确 → 最长前缀 → family 中位数 → 全局 0.7 */
export function baseScore(modelId: string): BaseScoreResult {
  const key0 = String(modelId ?? "").toLowerCase().trim()
  // 防御：容忍偶发带 provider 前缀的入参
  const key = key0.includes("/") ? key0.slice(key0.lastIndexOf("/") + 1) : key0
  if (!key) return { score: GLOBAL_MEDIAN_SCORE, tier: "C", source: "global" }

  const exact = MODEL_TIERS[key]
  if (exact) return { score: TIER_SCORE[exact], tier: exact, source: "exact" }

  let best: { k: string; len: number } | null = null
  for (const k of Object.keys(MODEL_TIERS)) {
    if (key.startsWith(k) && (!best || k.length > best.len)) best = { k, len: k.length }
  }
  if (best) {
    const t = MODEL_TIERS[best.k]
    return { score: TIER_SCORE[t], tier: t, source: "prefix" }
  }

  const fam = familyOfModel(key)
  const med = FAMILY_MEDIAN[fam]
  if (med !== undefined) return { score: med, tier: scoreToTier(med), source: "family" }

  return { score: GLOBAL_MEDIAN_SCORE, tier: "C", source: "global" }
}
