// [2026-09-04]-[English localization: translate runtime messages and comments; no logic change]
// Four-line banner ([ROUTES][WATERMARK][LIMITS][UPDATE], line-parseable port contract)
import { LANE_ORDER } from "./types"
import type { Lane, LaneResult, PoolStateKind } from "./types"
import type { BillingWindow } from "./types"
import type { CopilotQuota, GlmQuota, DeepseekQuota, Routing } from "./types"

const SHORT_POOL: Record<string, string> = { deepseek: "ds" }

export function shortName(name: string): string {
  const idx = name.indexOf("-mx-")
  const pool = name.slice(0, idx)
  const rest = name.slice(idx + 4)
  return `${SHORT_POOL[pool] ?? pool}-${rest}`
}

export interface BannerInput {
  lanes: Record<string, LaneResult> | null
  /** down set; Map form carries source annotations (e.g. "breaker", "real-fail isolation·12m left"), shown per name in the banner */
  down: Set<string> | string[] | Map<string, string>
  quota: { glm: GlmQuota | null; copilot: CopilotQuota | null; deepseek?: DeepseekQuota | null }
  states?: Record<string, { state?: PoolStateKind } & Record<string, unknown>> | null
  billing: BillingWindow
  advice?: string | null
  update?: string | null
  dsLowWarnCny?: number
  providerPolicy?: Partial<Record<"glm" | "copilot" | "deepseek", { observe: boolean; routing: boolean }>>
  doctorSummary?: string | null
  /** [2026-08-29]-[dynamic matrix: [LIMITS] line appends mode/watch/configStatus, restartRequired, models.dev downgrade marks; absent = legacy as-is] */
  matrixInfo?: { mode: string; configStatus: string; watch: boolean; restartRequired?: string[]; invalidConfigured?: string[]; degradedModels?: number; retiredModels?: number } | null
  /** [2026-09-03]-[user manual override annotations (effective entries in capability-rank.json/pool-config.json; 0 = unconfigured, not shown)] */
  overrides?: { rankModels: number; poolLanes: number } | null
}

function routeLine(lanes: Record<string, LaneResult> | null): string {
  const segs: string[] = []
  for (const lane of LANE_ORDER) {
    const r = lanes?.[lane]
    if (!r) {
      segs.push(`${lane}:? (route-state unavailable)`)
      continue
    }
    const names = r.chain.length > 0
      ? r.chain.slice(0, 3).map((c) => shortName(c.shell)).join("→")
      : "all unavailable→terminal failure protocol"
    segs.push(`${lane}: ${names}${r.status.endsWith("*") ? "*" : ""}`)
  }
  return `[ROUTES] ${segs.join(" | ")}`
}

/** GLM reset time (second-level epoch → MM-DD HH:mm; missing = later), same format as banner and sidebar */
function fmtResetMdHm(reset: number | null | undefined): string {
  const p = resetParts(reset)
  return p ? `${p.md} ${p.hm}` : "later"
}

function glmBrief(data: GlmQuota | null): string | null {
  if (!data || data.status !== "ok") return null
  const parts = ["GLM"]
  if (data.five_hour && typeof data.five_hour.used_pct === "number") parts.push(`5h ${data.five_hour.used_pct}%`)
  if (data.weekly && typeof data.weekly.used_pct === "number") {
    parts.push(`weekly ${data.weekly.used_pct}% (refreshed ${fmtResetMdHm(data.weekly.reset_at)})`)
  }
  if (data.stale) parts.push("data stale")
  return parts.length > 1 ? parts.join(" ") : null
}

function copilotBrief(data: CopilotQuota | null): string | null {
  if (!data || data.status !== "ok") return null
  const p = data.premium
  if (data.gateway_exhausted) return `Copilot monthly pool exhausted (resets ${data.reset_date ?? "?"})` // [v1.1 pitfall] gateway ground truth wins over snapshot
  if (!p) return null
  if (p.unlimited) {
    // unlimited:true shows used and reset_date, hides the misleading percentage
    const used = typeof p.used === "number" ? `, used ${p.used}` : ""
    return `Copilot credits unlimited${used} (refreshes ${data.reset_date ?? "?"})`
  }
  const pct = p.percent_remaining
  let body = `credits ${pct ?? "?"}% left (refreshes ${data.reset_date ?? "?"})`
  if (typeof pct === "number" && pct <= 0 && p.overage_permitted) {
    body = `credits exhausted·overage billing (refreshes ${data.reset_date ?? "?"})`
  }
  if (data.gateway_exhausted) body = `monthly pool exhausted (resets ${data.reset_date ?? "?"})`
  if (data.stale) body += "·data stale"
  return `Copilot ${body}`
}

function dsBalanceCny(data: DeepseekQuota | null): number | null {
  const bal = data?.balances
  if (!Array.isArray(bal) || bal.length === 0) return null
  let sum = 0
  let any = false
  for (const b of bal) {
    if (b.currency !== "CNY") continue
    const v = Number.parseFloat(b.total_balance)
    if (Number.isFinite(v)) {
      sum += v
      any = true
    }
  }
  return any ? sum : null
}

function dsBrief(data: DeepseekQuota | null, lowWarnCny?: number): string | null {
  if (!data || data.status !== "ok") return null
  if (data.exhausted) return "DeepSeek balance exhausted"
  // [2026-08-28]-[low-balance warning: banner hint below threshold, warn only, no hard block (pay-as-you-go)]
  const cny = dsBalanceCny(data)
  const thr = typeof lowWarnCny === "number" && lowWarnCny >= 0 ? lowWarnCny : 10
  if (typeof cny === "number" && cny < thr) {
    return `DeepSeek balance ¥${cny.toFixed(2)} (<¥${thr} warn)`
  }
  return null // pay-as-you-go healthy: stay quiet
}

// [2026-09-02]-[sidebar "watermark/peak" panel data shape v2: one entry block per provider, details split into rows sub-rows
//  (GLM=5h/weekly/MCP, Copilot=credits/refresh, DeepSeek=balance) — the header row renders label+status marks, sub-rows are indented with a progress bar,
//  fixing the earlier display issues of GLM split into two blocks, per-line repeated marks, and broken wrapping on narrow sidebars; observe=false produces no entry]
export interface ProviderStatusRow {
  /** short label at row head (5h/week/MCP/credits/refresh/balance; empty = placeholder full-line text) */
  label: string
  /** body text (progress bar + percentage/value), TUI colors it green→red by usedPct */
  text: string
  /** 0-100 for the green→red gradient; null = neutral color */
  usedPct: number | null
  /** weakened tail supplement (reset/refresh time, warning) */
  tail?: string
  /** [2026-09-19]-[P4 render-time i18n: key+params is the future quota-brief render source (t(locale, key, params)
   *  against the quota.* catalog in src/locales/en.ts; label/text/tail keep emitting the same English as now
   *  (debug/legacy until the TUI migration renders via key). No import of src/i18n.ts here on purpose —
   *  banner stays decoupled from the locale catalogs; key is a plain string like StatusLogEntry.key] */
  key?: string
  /** render params; names match the catalog template placeholders exactly ({bar8},{pct},{usedSuffix},{usage},…) */
  params?: Record<string, string | number>
  /** [2026-09-19]-[quota i18n labels/tails: labelKey renders the row label via quota.row5h/rowWeek/rowMcp/rowCredits/
   *  rowBalance (no params; rowRefresh stays as the main key since the refresh text is raw data); tailKey renders
   *  the tail via quota.resetLater/resetTime/resetDate/resetDateTime/balanceWarn with exact catalog params
   *  ({hhmm}/{mmdd}/{thr}); legacy label/tail strings unchanged] */
  labelKey?: string
  labelParams?: Record<string, string | number>
  tailKey?: string
  tailParams?: Record<string, string | number>
}

export interface ProviderStatusEntry {
  pool: "glm" | "copilot" | "deepseek"
  label: string
  /** [2026-09-19]-[quota i18n pool labels: key renders the block label via quota.poolGlm/poolCopilot/poolDeepSeek
   *  (params empty); legacy label string unchanged] */
  key?: string
  params?: Record<string, string | number>
  rows: ProviderStatusRow[]
  /** observe only (routing=false, not part of dispatch ranking) */
  observeOnly: boolean
  /** whether this provider's billing peak is active */
  peakActive: boolean
  /** quota snapshot stale (cache past TTL in stale_ok grace), one-time mark on the header row */
  stale: boolean
}

const POOL_LABEL: Record<"glm" | "copilot" | "deepseek", string> = { glm: "GLM", copilot: "Copilot", deepseek: "DeepSeek" }
const POOL_PROVIDER_ID: Record<"glm" | "copilot" | "deepseek", string> = {
  glm: "zhipuai-coding-plan", copilot: "github-copilot", deepseek: "deepseek",
}

/** 8-cell progress bar (█ used + ░ left), pct=null returns empty string (no bar when the row has no numeric concept) */
// [2026-09-04]-[Clamp to ≥1 filled cell for any pct>0: rounding used to collapse small quotas (e.g. MCP 5%) to an
//  all-empty track, contradicting the printed percentage]
function bar8(pct: number | null | undefined): string {
  if (typeof pct !== "number" || Number.isNaN(pct)) return ""
  const p = Math.max(0, Math.min(100, pct))
  const filled = p > 0 ? Math.max(1, Math.round((p / 100) * 8)) : 0
  return "█".repeat(filled) + "░".repeat(8 - filled)
}

function resetParts(reset: number | null | undefined): { md: string; hm: string } | null {
  if (typeof reset !== "number") return null
  const d = new Date(reset * 1000)
  const pad = (n: number) => String(n).padStart(2, "0")
  return { md: `${pad(d.getMonth() + 1)}-${pad(d.getDate())}`, hm: `${pad(d.getHours())}:${pad(d.getMinutes())}` }
}

// ---- sidebar rows output ([WATERMARK] banner glmBrief/copilotBrief/dsBrief compact single-line format unchanged)----

const NO_DATA_ROW: ProviderStatusRow[] = [{ label: "", text: "querying/no data", usedPct: null, key: "quota.queryingNoData" }]

function glmRows(data: GlmQuota | null): ProviderStatusRow[] {
  if (!data || data.status !== "ok") return NO_DATA_ROW
  const rows: ProviderStatusRow[] = []
  // [2026-09-19]-[P4 render-time i18n: bar rows carry quota.barPct + exact {bar8},{pct} params (t() reproduces text
  //  verbatim in English); label ("5h"/"week"/"MCP") and tail ("→…") keep English legacy — one key slot holds the
  //  primary body, label/tail catalog keys (quota.row*, quota.reset*) are consumed by the TUI phase]
  // [2026-09-19]-[quota i18n labels/tails: push now also fills labelKey (quota.row5h/rowWeek/rowMcp) and tailKey+
  //  tailParams (quota.resetLater with no params, quota.resetTime {hhmm}, quota.resetDate {mmdd},
  //  quota.resetDateTime {mmdd,hhmm}); legacy label/tail strings byte-identical]
  const ROW_LABEL_KEY: Record<string, string> = { "5h": "quota.row5h", week: "quota.rowWeek", MCP: "quota.rowMcp" }
  const push = (label: string, pct: number, reset: number | null | undefined, mode: "hm" | "mdhm" | "md") => {
    const parts = resetParts(reset)
    const tail = !parts ? "→later" : mode === "hm" ? `→${parts.hm}` : mode === "md" ? `→${parts.md}` : `→${parts.md} ${parts.hm}`
    const tailKey = !parts ? "quota.resetLater" : mode === "hm" ? "quota.resetTime" : mode === "md" ? "quota.resetDate" : "quota.resetDateTime"
    const tailParams: Record<string, string | number> | undefined = !parts ? undefined
      : mode === "hm" ? { hhmm: parts.hm }
      : mode === "md" ? { mmdd: parts.md }
      : { mmdd: parts.md, hhmm: parts.hm }
    const bar = bar8(pct)
    rows.push({ label, text: `${bar} ${pct}%`, usedPct: pct, tail, key: "quota.barPct", params: { bar8: bar, pct }, labelKey: ROW_LABEL_KEY[label], ...(tailParams ? { tailKey, tailParams } : { tailKey }) })
  }
  // 5h window always resets within 5 hours → HH:mm only; weekly window spans days → MM-DD HH:mm; MCP monthly → MM-DD
  if (typeof data.five_hour?.used_pct === "number") push("5h", data.five_hour.used_pct, data.five_hour.reset_at, "hm")
  if (typeof data.weekly?.used_pct === "number") push("week", data.weekly.used_pct, data.weekly.reset_at, "mdhm")
  const mcp = data.mcp_monthly
  if (mcp && typeof mcp.used_pct === "number") push("MCP", mcp.used_pct, mcp.reset_at, "md")
  if (rows.length === 0) return [{ label: "", text: "no quota data", usedPct: null, key: "quota.noData" }]
  return rows
}

function copilotRows(data: CopilotQuota | null): ProviderStatusRow[] {
  if (!data || data.status !== "ok") return NO_DATA_ROW
  // [2026-09-19]-[P4 render-time i18n: the refresh row's text is raw data (a date, no catalog key), so it carries the
  //  label key quota.rowRefresh (no params); the date itself stays data in the legacy text field, never translated]
  // [2026-09-19]-[quota i18n labels: credits rows gain labelKey quota.rowCredits (no params); the refresh row keeps
  //  quota.rowRefresh as its main key with no labelKey slot; legacy label/text byte-identical]
  const refresh: ProviderStatusRow = { label: "refresh", text: data.reset_date ?? "?", usedPct: null, key: "quota.rowRefresh" }
  if (data.gateway_exhausted) return [{ label: "credits", text: "monthly pool exhausted", usedPct: 100, key: "quota.monthlyExhausted", labelKey: "quota.rowCredits" }, refresh]
  const p = data.premium
  if (!p) return [{ label: "", text: "no quota data", usedPct: null, key: "quota.noData" }]
  if (p.unlimited) {
    const used = typeof p.used === "number" ? `, used ${p.used}` : ""
    return [{ label: "credits", text: `unlimited${used}`, usedPct: null, key: "quota.unlimited", params: { usedSuffix: used }, labelKey: "quota.rowCredits" }, refresh]
  }
  const pct = p.percent_remaining
  const usedPct = typeof pct === "number" ? Math.max(0, Math.min(100, 100 - pct)) : null
  const quotaTxt = typeof p.used === "number" && typeof p.entitlement === "number" ? ` ${p.used}/${p.entitlement}` : ""
  if (typeof pct === "number" && pct <= 0 && p.overage_permitted) {
    return [{ label: "credits", text: `exhausted·overage billing${quotaTxt}`, usedPct: 100, key: "quota.exhaustedOverage", params: { usage: quotaTxt }, labelKey: "quota.rowCredits" }, refresh]
  }
  const pctTxt = typeof pct === "number" ? (Number.isInteger(pct) ? pct : pct.toFixed(1)) : "?"
  const bar = bar8(usedPct)
  return [{ label: "credits", text: `${bar} ${pctTxt}% left${quotaTxt}`, usedPct, key: "quota.barPctLeft", params: { bar8: bar, pctTxt, usage: quotaTxt }, labelKey: "quota.rowCredits" }, refresh]
}

function dsRows(data: DeepseekQuota | null, lowWarnCny?: number): ProviderStatusRow[] {
  if (!data || data.status !== "ok") return NO_DATA_ROW
  if (data.exhausted) return [{ label: "balance", text: "exhausted", usedPct: 100, key: "quota.exhausted", labelKey: "quota.rowBalance" }]
  const cny = dsBalanceCny(data)
  if (cny === null) return [{ label: "balance", text: "unknown (pay-as-you-go)", usedPct: null, key: "quota.unknownPayg", labelKey: "quota.rowBalance" }]
  const thr = typeof lowWarnCny === "number" && lowWarnCny >= 0 ? lowWarnCny : 10
  // pay-as-you-go has no "total" concept: use 3× the warning threshold as the "ample balance" anchor for a relative gradient, coloring only, not a precise metric
  // [2026-09-19]-[P4 render-time i18n: balance row carries quota.barBalance + exact {bar8},{balance} params; the low-
  //  balance tail keeps English legacy (quota.balanceWarn + {thr} is consumed by the TUI phase — one key slot holds
  //  the primary body)]
  // [2026-09-19]-[quota i18n labels/tails: balance rows gain labelKey quota.rowBalance (no params); the low-balance
  //  warn tail gains tailKey quota.balanceWarn + tailParams {thr}; legacy label/text/tail byte-identical]
  const usedPct = Math.max(0, Math.min(100, 100 - (cny / (thr * 3)) * 100))
  const bar = bar8(usedPct)
  const balance = cny.toFixed(2)
  const warn = cny < thr
  return [{ label: "balance", text: `${bar} ¥${balance}`, usedPct, tail: warn ? ` (<¥${thr} warn)` : undefined, key: "quota.barBalance", params: { bar8: bar, balance }, labelKey: "quota.rowBalance", ...(warn ? { tailKey: "quota.balanceWarn", tailParams: { thr } } : {}) }]
}

export interface ProviderStatusInput {
  quota: BannerInput["quota"]
  providerPolicy?: BannerInput["providerPolicy"]
  dsLowWarnCny?: number
  /** vendor-neutral: billing-peak-active evaluation for any provider (same source as config.ts billingWindowForConfig) */
  peakOf?: (providerId: string) => boolean
}

export function providerStatusEntries(input: ProviderStatusInput): ProviderStatusEntry[] {
  const out: ProviderStatusEntry[] = []
  // [2026-09-19]-[quota i18n pool labels: block entries carry key quota.poolGlm/poolCopilot/poolDeepSeek (params empty);
  //  legacy label strings byte-identical; model-facing banner lines untouched]
  const POOL_KEY: Record<"glm" | "copilot" | "deepseek", string> = { glm: "quota.poolGlm", copilot: "quota.poolCopilot", deepseek: "quota.poolDeepSeek" }
  for (const pool of ["glm", "copilot", "deepseek"] as const) {
    const policy = input.providerPolicy?.[pool]
    if (policy?.observe === false) continue // observe:false → skip this block
    let rows: ProviderStatusRow[]
    let stale = false
    if (pool === "glm") {
      rows = glmRows(input.quota.glm)
      stale = input.quota.glm?.stale === true
    } else if (pool === "copilot") {
      rows = copilotRows(input.quota.copilot)
      stale = input.quota.copilot?.stale === true
    } else {
      rows = dsRows(input.quota.deepseek ?? null, input.dsLowWarnCny)
      stale = input.quota.deepseek?.stale === true
    }
    out.push({
      pool,
      label: POOL_LABEL[pool],
      key: POOL_KEY[pool],
      params: {},
      rows,
      observeOnly: policy ? policy.routing === false : false,
      peakActive: input.peakOf ? Boolean(input.peakOf(POOL_PROVIDER_ID[pool])) : false,
      stale,
    })
  }
  return out
}

function levelLine(input: BannerInput): string {
  const segs: string[] = []
  const glm = glmBrief(input.quota.glm)
  if (glm) segs.push(glm)
  const cp = copilotBrief(input.quota.copilot)
  if (cp) segs.push(cp)
  const ds = dsBrief(input.quota.deepseek ?? null, input.dsLowWarnCny)
  if (ds) segs.push(ds)
  for (const pool of ["glm", "copilot", "deepseek"] as const) {
    const policy = input.providerPolicy?.[pool]
    if (policy?.observe === false) segs.push(`${pool === "glm" ? "GLM" : pool === "copilot" ? "Copilot" : "DeepSeek"} query off`)
    else if (policy && !policy.routing) segs.push(`${pool === "glm" ? "GLM" : pool === "copilot" ? "Copilot" : "DeepSeek"} observe-only`)
  }
  if (input.quota.glm === null && input.quota.copilot === null && !input.providerPolicy) segs.push("quota unknown (query off or unavailable)")
  segs.push(`${input.billing.glmLabel} · ${input.billing.dsLabel}`)
  if (input.advice) segs.push(`advice: ${input.advice}`)
  return `[WATERMARK] ${segs.join(" | ")}`
}

function limitLine(down: Set<string> | string[] | Map<string, string>, unknownCount?: number, matrixInfo?: BannerInput["matrixInfo"], doctorSummary?: string | null, overrides?: BannerInput["overrides"]): string {
  // [2026-09-01]-[down source annotation: Map value = source (breaker / real-fail isolation·time left), troubleshooting can directly tell probe verdicts from in-memory isolation]
  const pairs: [string, string][] = down instanceof Map
    ? [...down.entries()]
    : (Array.isArray(down) ? down : [...down]).map((n) => [n, ""] as [string, string])
  const names = pairs
    .map(([n, note]) => `${n.includes("-mx-") ? shortName(n) : n}${note ? ` (${note})` : ""}`)
    .sort()
  const downTxt = names.length === 0 ? "none" : `${names.join(", ")} (not dispatchable; deny carries a redirect)`
  // [2026-08-31]-[vendor-neutral: dropped the "DeepSeek tail-fallback only" pool-name business semantics — api/unknown groups sink by billing coefficient]
  // [2026-09-05]-[review same-family self-review fallback: cross-family is a preference now — same-family self-review is
  //  a last-resort DOWNGRADED seat allowed only when no cross-family reviewer exists on the chain (was a hard ROUTE_META deny)]
  let line = `[LIMITS] down: ${downTxt} | reviewer prefers cross-family (same-family self-review = DOWNGRADED, allowed only when no cross-family reviewer exists) | api-billed & unknown models sink by coefficient (explicit billing=subscription wins)`
  if (unknownCount && unknownCount > 0) line += ` | ${unknownCount} combos unknown (not blocked)`
  if (matrixInfo) {
    line += ` | matrix: ${matrixInfo.mode}${matrixInfo.watch ? "·watch" : ""}/${matrixInfo.configStatus}`
    if (matrixInfo.restartRequired && matrixInfo.restartRequired.length > 0) {
      line += ` | new provider(s) ${matrixInfo.restartRequired.join(", ")} pending restart to register`
    }
    if (matrixInfo.invalidConfigured && matrixInfo.invalidConfigured.length > 0) {
      // [2026-09-01]-[hardening: dirty data where favorites/visible set contain a provider that exists but the modelId does not —
      //  hint directly instead of silently no-op, so users can locate a mis-configured favorite rather than suspect a routing bug]
      line += ` | favorites contain invalid models ${matrixInfo.invalidConfigured.join(", ")} (check favorites)`
    }
    if (matrixInfo.degradedModels && matrixInfo.degradedModels > 0) {
      line += ` | models.dev metadata missing: ${matrixInfo.degradedModels} models degraded one effort off`
    }
    if (matrixInfo.retiredModels && matrixInfo.retiredModels > 0) {
      line += `, ${matrixInfo.retiredModels} models retired`
    }
  }
  if (doctorSummary) line += ` | ${doctorSummary}`
  if (overrides && (overrides.rankModels > 0 || overrides.poolLanes > 0)) {
    const parts: string[] = []
    if (overrides.rankModels > 0) parts.push(`manual capability rank: ${overrides.rankModels} models`)
    if (overrides.poolLanes > 0) parts.push(`task-pool selection: ${overrides.poolLanes} pools`)
    // [2026-09-18]-[rank universe = pool selection: surface the scoping so users see /modelRank only ranks pool-selected models
    const universe = (overrides as { universeModels?: number }).universeModels
    if (universe !== undefined && universe > 0) parts.push(`rankable universe: ${universe} models`)
    line += ` | ${parts.join(", ")} active (/modelRank /poolConfig to adjust)`
  }
  return line
}

/** Four-line banner (line-parseable port contract) */
export function buildBanner(input: BannerInput): string[] {
  const lines = [
    routeLine(input.lanes),
    levelLine(input),
    limitLine(input.down, input.states ? countUnknown(input) : undefined, input.matrixInfo ?? undefined, input.doctorSummary, input.overrides ?? undefined),
  ]
  if (input.update) lines.push(`[UPDATE] ${input.update}`)
  return lines
}

function countUnknown(input: BannerInput): number {
  const matrixUnknown = (input as any)._unknownCount
  return typeof matrixUnknown === "number" ? matrixUnknown : 0
}
