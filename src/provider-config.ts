// [2026-09-04]-[English localization: translate CLI messages and comments; no logic change]
// Stable policy aliases for user config; OpenCode provider IDs are never leaked into the config file.
// [2026-08-31]-[De-vendoring orchestration: the builtin table is demoted to "quota-scraping infrastructure + factory config data" and no longer carries ranking rules;
//  providers accept any key (opencode official/user-defined providers), billing explicit config drives the subscription scoring coefficient,
//  and the pool (Pool) concept is reserved only for quota scraping (only providers with scrapers have watermark data)]
import type { Pool } from "./types"

export type ProviderKey = "deepseek" | "zhipuai-coding-plan" | "github-copilot"
export type BillingKind = "subscription" | "api"
export interface PeakRange { days: number[]; start: string; end: string }
export interface ProviderUserConfig { enabled: boolean; observe: boolean; billing: BillingKind; peak: { timezone: string; ranges: PeakRange[] } }

const SPECS: Array<{ key: ProviderKey; pool: Pool; aliases: string[]; defaults: ProviderUserConfig }> = [
  // billing is factory config data (same nature as the peak table), not an orchestration rule: the two subscription-billed vendors ship marked subscription,
  //  users can change it in jsonc; custom providers default to api.
  { key: "deepseek", pool: "deepseek", aliases: ["deepseek", "deepseek-api"], defaults: { enabled: false, observe: true, billing: "api", peak: { timezone: "local", ranges: [{ days: [1, 2, 3, 4, 5], start: "09:00", end: "12:00" }, { days: [1, 2, 3, 4, 5], start: "14:00", end: "18:00" }] } } },
  { key: "zhipuai-coding-plan", pool: "glm", aliases: ["zhipuai-coding-plan", "glm-coding-plan-cn", "glm", "zai"], defaults: { enabled: false, observe: true, billing: "subscription", peak: { timezone: "local", ranges: [{ days: [1, 2, 3, 4, 5], start: "14:00", end: "18:00" }] } } },
  { key: "github-copilot", pool: "copilot", aliases: ["github-copilot", "github-copilot-oauth", "copilot"], defaults: { enabled: false, observe: true, billing: "subscription", peak: { timezone: "local", ranges: [] } } },
]

export const PROVIDER_KEYS = SPECS.map((s) => s.key) as ProviderKey[]

export function poolForProviderId(id: string): Pool | null {
  const s = SPECS.find((x) => x.aliases.includes(id) || (x.pool === "glm" && /^(zhipuai|glm|zai)/.test(id)) || (x.pool === "copilot" && id.includes("copilot")))
  return s?.pool ?? null
}

export function providerKeyForPool(pool: Pool): ProviderKey { return SPECS.find((s) => s.pool === pool)!.key }

/** Config key canonicalization: builtin alias/prefix hits return the builtin canonical key, otherwise the input is returned as-is (custom provider keys are legal) */
export function resolveProviderKey(id: string): ProviderKey | string {
  const exact = SPECS.find((x) => x.aliases.includes(id))
  if (exact) return exact.key
  if (/^(zhipuai|glm|zai)/.test(id)) return "zhipuai-coding-plan"
  if (id.includes("copilot")) return "github-copilot"
  return id
}

/** Builtin canonical key set (for near-spelling suggestions) */
export function canonicalKeyOf(id: string): ProviderKey | null {
  const resolved = resolveProviderKey(id)
  return PROVIDER_KEYS.includes(resolved as ProviderKey) ? resolved as ProviderKey : null
}

/** Custom provider factory defaults: no routing, observable, api billing, no peak windows */
export function genericProviderDefaults(): ProviderUserConfig {
  return { enabled: false, observe: true, billing: "api", peak: { timezone: "local", ranges: [] } }
}

/** Factory billing (source of the billing coefficient in gen-shells when no user config exists) */
export function defaultBillingOf(providerId: string): BillingKind {
  const key = canonicalKeyOf(providerId)
  return key ? SPECS.find((s) => s.key === key)!.defaults.billing : "api"
}

export function defaultProviderConfig(): Record<ProviderKey, ProviderUserConfig> {
  return Object.fromEntries(SPECS.map((s) => [s.key, structuredClone(s.defaults)])) as Record<ProviderKey, ProviderUserConfig>
}

/** Stable body of the generated file; its comments are part of the user config experience. */
export function renderDefaultConfigJsonc(): string {
  return `{
  // JSON Schema is for editor hints only; the plugin itself does fail-open validation.
  "$schema": "https://raw.githubusercontent.com/mrzturn/opencode-switchman/main/schema/opencode-switchman-v1.schema.json",
  // Config semantic version (currently 1); on upgrade the plugin only migrates stepwise in memory.
  "version": 1,
  "providers": {
    // Any opencode official/custom provider key is legal (keys not matching the builtin table are treated as custom, billing defaults to api).
    "deepseek": {
      // Whether watermark/peak/exhaustion participate in routing rank and hard block; false does not affect queries or display.
      "enabled": false,
      // Whether to query usage/balance in the background and show it in the banner.
      "observe": true,
      // Billing structure: subscription (rating coefficient 1.0) / api (pay-as-you-go, coefficient 0.85, ranks lower); only an explicit declaration here takes effect.
      "billing": "api",
      "peak": {
        // "local" or an IANA time zone (e.g. "Asia/Shanghai").
        "timezone": "local",
        // days uses ISO weeks: 1=Mon … 7=Sun; ranges are [start,end); start>end means crossing into the next day.
        "ranges": [
          { "days": [1,2,3,4,5], "start": "09:00", "end": "12:00" },
          { "days": [1,2,3,4,5], "start": "14:00", "end": "18:00" }
        ]
      }
    },
    "zhipuai-coding-plan": {
      "enabled": false,
      "observe": true,
      "billing": "subscription",
      "peak": {
        "timezone": "local",
        "ranges": [
          { "days": [1,2,3,4,5], "start": "14:00", "end": "18:00" }
        ]
      }
    },
    "github-copilot": {
      "enabled": false,
      "observe": true,
      "billing": "subscription",
      "peak": {
        "timezone": "local",
        // Structure kept for future extension; currently not part of scoring or display.
        "ranges": []
      }
    }
  },
  // ---- Behavior sections: everything except plugin installation (the plugin array in the opencode config) lives in this file ----
  "quota": {
    // GLM 5-hour window reserve watermark (%): reaching it hard-blocks GLM shells (avoids 429); the weekly quota still only recognizes 100%.
    "glmFiveHourReservePct": 90,
    // DeepSeek low-balance warning threshold (CNY): below it the banner [WATERMARK] shows a hint; warning only, no hard block (pay-as-you-go).
    "deepseekLowBalanceWarnCny": 10
  },
  // Whether the models.dev price snapshot is one of the weighted scoring coefficients.
  "cost": { "enabled": true },
  // Dynamic capability tiers: auto=with apiKey try AA first, fall back to OpenRouter on failure/no key; tierThresholds default uses the builtin quantile mapping.
  "capability": {
    "enabled": true,
    "source": "auto",
    // Artificial Analysis Data API key (or via the ARTIFICIAL_ANALYSIS_API_KEY env var); with no key it falls back to OpenRouter's public source.
    // "apiKey": "aa_xxx",
    "lmarenaCheck": false
  },
  // Activation matrix: auto=detect desktop/cli by client; legacy=static shells.json; watch=watch config-surface changes and recompute in real time (changing watch requires a restart).
  "matrix": { "mode": "auto", "watch": true },
  // Four-line routing banner / dispatcher protocol (bundled in src/assets/agents-md.ts) system-prompt injection.
  "banner": { "enabled": true },
  "rules": { "enabled": true },
  // Measured session-context budget (optional; the whole section may be omitted — factory defaults apply).
  // "context": {
  //   "readBudgetTokens": 1500, // per-call self-read budget in tokens (200..20000): oversized reads get auto-bounded or denied with bounded-retry params
  // },
  // Custom six-lane candidate chains (override builtin preference order); keys=economy/mechanical/main/hard/vision/review, values are arrays of shell names.
  "lanes": {},
  // Artifact workspace: per-main-session folder <project>/<dirname>/<yyyy-mm-dd>/<sessionId>-<title>/ coordinating plans/progress/process docs/media/dispatch traces.
  "workspace": {
    // Master switch; when off no folders are created and the protocol section is neutralized.
    "enabled": true,
    // Directory name under the project root (flat name, no path separators).
    "dirname": ".switchman"
  },
  // Third-party/future extension data goes under namespace keys, not into providers.
  "extensions": {}
}
`
}
