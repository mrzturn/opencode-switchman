// [2026-09-04]-[English localization: translate CLI messages and comments; no logic change]
// opencode-switchman types and contracts (six-lane shell matrix orchestration)
// [2026-08-31]-[De-vendoring: Pool demoted to a "quota-scraping infrastructure" concept (only providers with scrapers have watermark data),
//  barred from ranking/gating/chain generation; orchestration rules consume only config-driven coefficients such as billing/unknown]
import type { ScoreBreakdown } from "./scoring"

export type Lane = "economy" | "mechanical" | "main" | "hard" | "vision" | "review"
export const LANE_ORDER: Lane[] = ["economy", "mechanical", "main", "hard", "vision", "review"]

/** Quota infrastructure pools (for quota scraping/watermark display only; zero vendor hardcoding in orchestration rules) */
export type Pool = "copilot" | "glm" | "deepseek"
export const POOLS: Pool[] = ["copilot", "glm", "deepseek"]

export type Role =
  | "planner" | "reviewer" | "programmer" | "tester" | "uiux" | "data-analyst"
  | "ops" | "scouter" | "clerk" | "observer"
  | "expert-alpha" | "expert-beta" | "expert-gamma" | "generic"

export type Family = "glm" | "claude" | "gemini" | "gpt" | "grok" | "deepseek"
export type Capability = "ro" | "rw"
export type Modality = "text" | "image"
export type MetaSource = "auto" | "user"

// Legal ROUTE_META value table (same source as delegation-template; producer_family must not be the pool names main/gcp/copilot)
export const META_KEYS = ["lane", "role", "producer_family", "capability", "modality", "source"] as const
export type MetaKey = (typeof META_KEYS)[number]
export const META_LEGAL: Record<MetaKey, readonly string[]> = {
  lane: LANE_ORDER,
  role: ["planner", "reviewer", "programmer", "tester", "uiux", "data-analyst",
    "ops", "scouter", "clerk", "observer",
    "expert-alpha", "expert-beta", "expert-gamma", "generic"],
  producer_family: ["glm", "claude", "gemini", "gpt", "grok", "deepseek"],
  capability: ["ro", "rw"],
  modality: ["text", "image"],
  source: ["auto", "user"],
}
export const META_REQUIRED: MetaKey[] = ["source", "role", "capability"]
export const META_SAMPLE =
  'ROUTE_META {"lane":"main","role":"programmer","producer_family":"glm","capability":"rw","modality":"text","source":"auto"}'

export type MetaValue = string
export interface Meta {
  lane?: string
  role?: string
  producer_family?: string
  capability?: string
  modality?: string
  source?: string
}
export type MetaErr =
  | "missing"
  | "malformed"
  | { kind: "invalid"; field: string; value: string }
  | { kind: "required"; field: string }

// Shell manifest (shells.json static entries)
export interface ShellManifestEntry {
  name: string
  pool: Pool
  provider: string
  modelId: string
  effort: string
  family: Family
  capability: Capability
  vision: boolean
  matrixKey: string // provider|modelId|effort
}

// ---- Dynamic activation matrix (v1.3) ----
export type ModelKey = `${string}/${string}`
export type MatrixRunMode = "desktop" | "cli" | "legacy"
export type MatrixConfigStatus = "ok" | "empty" | "unreadable"

export interface ActivationState {
  generation: number
  mode: MatrixRunMode
  configStatus: MatrixConfigStatus
  configured: ModelKey[] // desktop: visibility==="show"; cli: favorite[]
  sessionModels: ModelKey[] // models of active non-shell non-internal sessions (multi-session union)
  activeModels: ModelKey[] // configured ∪ sessionModels
  activeShells: string[] // shell names expanded from activeModels
  restartRequired: string[] // deduped providerIDs outside the superset (shell registration needs a restart)
  // [2026-09-01]-[Hardening: dirty data where the provider is known in favorites/visible set but no shell exists for the modelId in the superset (e.g.
  //  accidentally favoriting a nonexistent "provider/not-a-model") — it contributes no shell yet must not vanish silently; recorded for banner/log hints to help users locate]-
  invalidConfigured: ModelKey[]
}

// Gate 1 dynamic three-layer injection (optional gates snapshot fields; absent = legacy path disabled)
export interface ActivationGateInfo {
  enabled: boolean
  activeShells: Set<string> | null
  conflicts: Set<string> | null
  restartRequired: string[]
}

// Runtime registry view = manifest × probe matrix × credentials present
export interface ShellRegEntry extends ShellManifestEntry {
  status: "enabled" | "disabled"
  disabledReason?: string
  comboKey: string
}

// Probe matrix entries
// [2026-08-29]-[Scoring engine: added "strained" (a new transient 429 rate-limit status, health coefficient 0.6 instead of elimination)]
export interface MatrixEntry {
  status: "ok" | "strained" | "down" | "unknown" | "missing" | "unprobed"
  reason?: string
  latency_ms?: number | null
  checked_at?: string
}
export interface Matrix {
  combos: Record<string, MatrixEntry>
  generated_at?: string | null
  /** [2026-08-29]-[Dynamic matrix v1.3: currently active combos and target generation (maintained by matrix-manager)] */
  active_keys?: string[]
  target_generation?: number
}

// Breaker state
export interface Routing {
  down_agents: Record<string, string>
  down_expiry: Record<string, number>
  unknown_agents?: Record<string, string>
  updated_at?: string
}

// GLM quota cache (glm-quota.json)
export interface GlmScope { used_pct?: number | null; reset_at?: number | null }
export interface GlmQuota {
  status: "ok" | "unknown"
  reason?: string
  fetched_at: number
  stale?: boolean
  level?: string
  five_hour?: GlmScope
  weekly?: GlmScope
  mcp_monthly?: { used?: unknown; total?: unknown; used_pct?: number | null; reset_at?: number | null }
}

// Copilot premium credit snapshot (after normalization; missing numeric fields = null)
export interface PremiumSnapshot {
  quota_id: string
  entitlement: number | null
  used: number | null
  remaining: number | null
  percent_remaining: number | null
  unlimited: boolean
  overage_permitted: boolean
  has_quota: boolean | null
  timestamp_utc: string | null
}
export interface CopilotQuota {
  status: "ok" | "unknown"
  reason?: string
  fetched_at: number
  stale?: boolean
  login?: string | null
  plan?: string | null
  sku?: string | null
  reset_date?: string | null
  premium?: PremiumSnapshot | null
  gateway_exhausted?: boolean // second source of truth from the gateway 429/quota error body, trusted until reset_date
}

// DeepSeek balance cache
export interface DsBalance { currency: string; total_balance: string }
export interface DeepseekQuota {
  status: "ok" | "unknown"
  reason?: string
  fetched_at: number
  stale?: boolean
  balances?: DsBalance[]
  exhausted?: boolean
}

// Pool watermark states (pool_states evaluation result)
export type PoolStateKind = "surplus" | "healthy" | "strained"
export interface GlmStateInfo {
  state: PoolStateKind
  five_hour_pct?: number | null
  weekly_pct?: number | null
  weekly_hours_left?: number | null
}
export interface CopilotStateInfo {
  state: PoolStateKind
  remaining?: number | null
  days_left?: number | null
  runway_days?: number | null
  waste_est?: number | null
}

// Billing window (configurable; default semantics: GLM peak = weekdays 14-18; DS peak = weekdays 9-12+14-18)
export interface BillingWindowConfig {
  glmPeakHours?: [number, number]
  dsPeakRanges?: Array<[number, number]>
}
export interface BillingWindow { glmPeak: boolean; dsPeak: boolean; glmLabel: string; dsLabel: string }
export type RoutePolicy = Record<Pool, { observe: boolean; routing: boolean }>

// Six-lane chain selection result
export interface ChainCandidate {
  shell: string
  pool: Pool | string
  family: Family | null
  effort: string | null
  capability: Capability | null
  vision: boolean | null
  latency_ms: number | null
  /** [2026-08-29]-[Scoring engine: in-group multiplicative score breakdown (normal lane; undefined on immediate/scoring-failure fallback), for decision-log traceability] */
  score?: ScoreBreakdown
}
export interface DroppedCandidate { shell: string; reason: string }
export interface LaneResult {
  lane: Lane
  status: string // ok | exhausted | ok* (* = registry/matrix-missing fail-open downgrade marker)
  chain: ChainCandidate[]
  dropped: DroppedCandidate[]
}

// Six-gate snapshot (gates input, all assembled by the caller — pure functions, no IO)
export interface GateSnapshot {
  registry: Record<string, ShellRegEntry> | null
  matrix: Record<string, MatrixEntry> | null
  routing: Routing | null
  quotaExhausted: Partial<Record<Pool, boolean>>
  routePolicy?: RoutePolicy
  costs?: (modelId: string) => number | null
  activation?: ActivationGateInfo | null
  /** In-process short-term isolation of combos that probed ok but actually failed delegation. */
  realFailedCombos?: ReadonlySet<string>
  /** [2026-08-29]-[Failure classification: set of retired models (provider/modelId) after consecutive 404s; denied before the gates; injected only by the dynamic matrix] */
  retiredModels?: ReadonlySet<string>
  /** [2026-08-31]-[De-vendoring: deny postscript candidates share the banner's source (user jsonc billing/peak resolution)] */
  billingBoostOf?: (provider: string) => number
  peakOf?: (provider: string) => boolean
  /** [2026-08-31]-[Final review P1-3: runtime inputs sharing the source of deny-postscript candidates and banner ranking (water/costs/glmPeak/states)] */
  water?: import("./scoring").WaterFactor
  glmPeak?: boolean | null
  states?: Record<string, { state?: PoolStateKind } & Record<string, unknown>> | null
  /** [2026-09-03]-[Task-pool selection (pool-config.json manual config): lane→normalized modelId set participating in that task pool;
   *  a non-empty list overrides the system default candidate set (the same model may join multiple lanes); missing/empty = fail-open full set by default.
   *  computeLane and checkShell share the same assembly] */
  poolConfig?: Partial<Record<string, ReadonlySet<string>>> | null
}

// Plugin options (["opencode-switchman", {...}] tuple form)
// [2026-08-31]-[Dynamic capability tiers: third-party authoritative indices (AA v2 primary/OpenRouter fallback) → capability.json
//  (TTL 24h) → baseScore's api override layer; fallback chain = realtime api → bundled default ranking (the official ranking snapshot
//  generated by gen:capability, iterated manually per version) → curated table; offline/429 fail-open never blocks delegation]
export interface CapabilityTierThresholds { S?: number; A?: number; B?: number }
export interface CapabilityOptions {
  enabled?: boolean
  /** auto (default) = with apiKey try AA first, fall back to OpenRouter on failure/no key; a single source can also be explicitly specified */
  source?: "auto" | "artificial-analysis" | "openrouter"
  /** Artificial Analysis Data API key (x-api-key; or via the ARTIFICIAL_ANALYSIS_API_KEY env var) */
  apiKey?: string
  /** Absolute thresholds (default S>=62/A>=55/B>=45, intelligence index 0-100 semantics) or "quantile" (p80/p60/p40) */
  tierThresholds?: CapabilityTierThresholds | "quantile"
  /** LMArena (api.wulong.dev ELO) optional cross-check: log warnings only, no scoring impact; default false */
  lmarenaCheck?: boolean
}
export interface GlmQuotaOptions {
  enabled?: boolean
  /** 5-hour window reserve watermark (%): reaching it hard-blocks GLM shells to avoid triggering 429 at full use; default 90, the weekly quota still only recognizes 100% */
  fiveHourReservePct?: number
}
export interface DeepseekQuotaOptions {
  enabled?: boolean
  /** Low-balance warning threshold (CNY): below it the banner [WATERMARK] shows a hint, default 10; warning only, no hard block (pay-as-you-go) */
  lowBalanceWarnCny?: number
}
export interface CopilotQuotaOptions { enabled?: boolean }
export interface MatrixOptions {
  /** auto (default) = detect desktop/cli via OPENCODE_CLIENT; app/tui force-override; legacy goes fully static shells.json */
  mode?: "auto" | "app" | "tui" | "legacy"
      /** Watch the opencode state directory and recompute on change (default true; activation changes take effect for the dispatch gate "on the next request", not rewriting already-sent requests in real time) */
  watch?: boolean
}
// [2026-09-04]-[Dispatch bias fix: session context watermark is measured by the plugin (message.updated token usage);
//  read-class tools past the line get a warning first, then a hard block — turning the protocol's self-reported watermark into mechanism enforcement]
export interface ContextOptions {
  /** Watermark gate master switch (default true); when off, banner hints only, no interception */
  gates?: boolean
  /** Soft watermark (tokens): first interception of a read-class tool reminds to redirect to economy (one-time), then lets through */
  softTokens?: number
  /** Hard watermark (tokens): read/glob/grep/list are always denied; bash only lets through verification-type commands */
  hardTokens?: number
  /** Force-compaction watermark (tokens): banner injects a forced-compaction instruction; read-class tools are intercepted like the hard watermark */
  forceTokens?: number
  /** [2026-09-04]-[After exceeding the force-compaction watermark, tool.execute.after auto-triggers /handover (fork backup + compact the current session;
   *  the task continues automatically with summary context); default true; false = banner hint only, relying on manual /handover] */
  autoHandover?: boolean
}
// [2026-09-04]-[Builtin subagent block: explore/general compete with shell routing and were previously fail-open allowed;
//  default deny with economy/main redirect suggestions; allow restores the old behavior]
export interface BuiltinAgentsOptions { mode?: "deny" | "allow" }
// [2026-09-04]-[Injection surface mode: chain = six-lane chain picks ∪ favorites ∪ visible set (saves 6-10k/session; off-chain models
//  explicitly named get the denyUninjected hint); all = full available set (old behavior, any available model can be explicitly named)]
export interface InjectionOptions { mode?: "chain" | "all" }
// [2026-09-04]-[deny auto-redirect: wrong landing spots are silently rewritten inside tool.execute.before to the chain-head candidate (one hop + same-snapshot
//  guard re-check), sparing the main model repeated deny-and-retry token waste; default true]
export interface DispatchOptions { autoRedirect?: boolean }
// [2026-09-04]-[Image relay: when the main session model has no vision, images in the message are saved to disk and image-reading guidance is injected
//  (vision shell/MCP vision tool relay), avoiding host errors; default true]
export interface RelayOptions { image?: boolean }
export interface RulesOptions {
  enabled?: boolean
  /** Delegation floor (tokens): self-execution allowed when expected benefit is below it; interpolated into {{DELEGATION_FLOOR}} when injecting the protocol */
  delegationFloor?: number
}
// [2026-09-01]-[Config surface consolidated into opencode-switchman.jsonc: tuple options demoted to a compatibility shim
//  (explicit config wins over gen-1 and reports SWM044); dead field providers.* (credential collection actually goes through poolForProviderId) removed]
export interface SwitchmanOptions {
  quota?: { glm?: GlmQuotaOptions; deepseek?: DeepseekQuotaOptions; copilot?: CopilotQuotaOptions }
  cost?: { enabled?: boolean }
  billingWindow?: BillingWindowConfig
  banner?: { enabled?: boolean }
  /** Dispatcher protocol system-prompt injection (bundled builtin; when off, depends on the user installing AGENTS.md themselves) */
  rules?: RulesOptions
  lanes?: Partial<Record<Lane, string[]>>
  matrix?: MatrixOptions
  capability?: CapabilityOptions
  context?: ContextOptions
  builtinAgents?: BuiltinAgentsOptions
  injection?: InjectionOptions
  dispatch?: DispatchOptions
  relay?: RelayOptions
}
