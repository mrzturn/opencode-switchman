// [2026-09-04]-[English localization: translate comments and status messages; no logic change]
// Curated model capability score table (S/A/B/C four tiers) + baseScore traceable matching
// [2026-08-29]-[calibration date 2026-08-29, referencing LMArena/SWE-bench, manually calibrated; base outweighs all soft factors]
// Match order: exact key -> longest prefix -> family median -> global 0.7; returns source for decision-log traceability.
export type Tier = "S" | "A" | "B" | "C"
export type CapabilityLevel = "L1" | "L2" | "L3" | "L4" | "L5"

/** Capability level for business use: global is only an ordering fallback for unknown models, not verified B-level capability. */
export function capabilityLevelOf(tier: Tier, source?: string): CapabilityLevel {
  if (source === "global") return "L1"
  if (tier === "S") return "L5"
  if (tier === "A") return "L4"
  if (tier === "B") return "L3"
  return "L2"
}

export const CAPABILITY_LEVEL_RANK: Record<CapabilityLevel, number> = {
  L1: 1, L2: 2, L3: 3, L4: 4, L5: 5,
}

/** Tier group order (primary sort key; shared across modules: scoring and lane-policy) */
export const TIER_RANK: Record<Tier, number> = { S: 0, A: 1, B: 2, C: 3 }

export const TIER_SCORE: Record<Tier, number> = {
  S: 1.0,
  A: 0.85,
  B: 0.7,
  C: 0.55,
}

// key=lowercase modelId (no provider prefix); variants (-codex/-luna/-sol/-terra/-vision/-preview) match by prefix
export const MODEL_TIERS: Record<string, Tier> = {
  // ---- S tier ----
  "claude-opus-4.8": "S",
  "claude-opus-5": "S",
  "gpt-5.5": "S",
  "gpt-5.6": "S", // matched via the gpt-5.6-codex/-luna/-sol/-terra prefix
  "gemini-3.1-pro": "S", // matched via the gemini-3.1-pro-preview prefix
  "deepseek-v4-pro": "S",
  // ---- A tier ----
  "claude-sonnet-4.6": "A",
  "claude-sonnet-5": "A",
  "claude-opus-4.7": "A",
  "gpt-5.4": "A",
  "glm-5.3": "A",
  "glm-5.2": "A",
  "grok-4.6": "A",
  "kimi-k3": "A",
  "gpt-5.6-mini": "A",
  // ---- B tier ----
  "glm-5.3-flash": "B",
  "glm-5-turbo": "B",
  "glm-4.7": "B",
  "deepseek-v4-flash": "B", // matched via the -vision prefix
  "gemini-3.5-flash": "B",
  "gemini-3.6-flash": "B",
  "gemini-3.7-flash": "B",
  "kimi-k2.7": "B",
  "mai-code-1.1": "B",
  "grok-4.5": "B",
  "gpt-5-mini": "B",
  // ---- C tier ----
  "glm-4.5-air": "C",
  "glm-4.6v": "C",
  "glm-5v-turbo": "C",
  "glm-5.1": "C",
  // remaining free/mini/legacy go through family median / global fallback
}

/** Global median (fallback score when the family is unknown) */
export const GLOBAL_MEDIAN_SCORE = 0.7

/** [2026-08-31]-[de-vendorization: unknown-group penalty -- coefficient for models missing the entire
 *  exact/prefix/family approximate-classification chain (global fallback), so they rank after known models
 *  within the same tier and only fill tail slots in a lane (shared by lane-policy and scoring, placed here
 *  to avoid circular imports)] */
export const UNKNOWN_PENALTY = 0.75

// ---- family determination (same source as catalog.familyOf; the provider->family mapping is implied by the
//  modelId prefix: zhipuai/glm family -> glm- prefix, deepseek family -> deepseek- prefix, github-copilot by
//  the modelId's own prefix) ----
function familyOfModel(modelId: string): string {
  const m = /^(claude|gpt|gemini|grok|kimi|glm|deepseek|mai)/.exec(modelId)
  return m ? m[1] : modelId.split(/[^a-zA-Z0-9]/)[0] || "unknown"
}

// family median: median of same-family entry scores in the table (even counts average the two middle items)
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

/** Curated capability score (base): exact -> longest prefix -> family median -> global 0.7 */
export function baseScore(modelId: string): BaseScoreResult {
  const key0 = String(modelId ?? "").toLowerCase().trim()
  // defensive: tolerate occasional provider-prefixed input
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
