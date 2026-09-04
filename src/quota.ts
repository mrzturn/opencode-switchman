// [2026-09-04]-[English localization: translate comments and status messages; no logic change]
// Three-endpoint quota probing (v1.1): GLM monitor / DeepSeek balance / Copilot copilot_internal/user
// [2026-08-28]-[Copilot queries the official internal endpoint directly (same as VS Code), measured 200]-
// [security red line: the GitHub OAuth token is read-only, never refresh -- rotation would invalidate opencode credentials; 401 -> unknown self-heals]-
// [three-layer fallback: network failure -> stale cache <=7200s -> unknown; no credentials/401 -> unknown without hard block; corrupted cache -> unknown]
import { readFileSync, existsSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import {
  QUOTA_STALE_OK, QUOTA_TTL, QUOTA_TTL_HOT, paths, readJson, writeJsonAtomic,
} from "./state"
import { copilotHot, glmHot } from "./lane"
import type { CopilotQuota, DeepseekQuota, DsBalance, GlmQuota, PremiumSnapshot } from "./types"

const FETCH_TIMEOUT_MS = 10_000

export const IMPOSTOR_HEADERS: Readonly<Record<string, string>> = {
  "User-Agent": "GitHubCopilotChat/0.35.0",
  "Editor-Version": "vscode/1.107.0",
  "Editor-Plugin-Version": "copilot-chat/0.35.0",
  "Copilot-Integration-Id": "vscode-chat",
}

const GLM_API = "https://open.bigmodel.cn/api/monitor/usage/quota/limit"
const DS_API = "https://api.deepseek.com/user/balance"
const COPILOT_USER_URL = "https://api.github.com/copilot_internal/user"

async function fetchJson(url: string, headers: Record<string, string>): Promise<{ status: number; body: any }> {
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) })
  let body: any = null
  try {
    body = await res.json()
  } catch { /* body left empty */ }
  return { status: res.status, body }
}

// ---- GLM (TOKENS_LIMIT distinguishes 5h/weekly by (unit,number)) ----
export async function fetchGlmQuota(key: string): Promise<GlmQuota> {
  try {
    const { status, body } = await fetchJson(GLM_API, {
      Authorization: key,
      "Accept-Language": "en-US,en",
      "Content-Type": "application/json",
    })
    if (status !== 200) return { status: "unknown", reason: `HTTP ${status}`, fetched_at: Date.now() / 1000 }
    const limits = body?.data?.limits ?? []
    const out: GlmQuota = { status: "ok", level: body?.data?.level ?? "", fetched_at: Date.now() / 1000 }
    const toS = (ms: unknown) => (typeof ms === "number" ? ms / 1000 : null)
    for (const item of Array.isArray(limits) ? limits : []) {
      const { type, unit, number } = item ?? {}
      if (type === "TOKENS_LIMIT" && unit === 3 && number === 5) {
        out.five_hour = { used_pct: item.percentage, reset_at: toS(item.nextResetTime) }
      } else if (type === "TOKENS_LIMIT" && unit === 6 && number === 1) {
        out.weekly = { used_pct: item.percentage, reset_at: toS(item.nextResetTime) }
      } else if (type === "TIME_LIMIT") {
        out.mcp_monthly = { used: item.currentValue, total: item.usage, used_pct: item.percentage, reset_at: toS(item.nextResetTime) }
      }
    }
    if (!out.five_hour && !out.weekly) {
      return { status: "unknown", reason: "response missing TOKENS_LIMIT entries (plan type or API changed?)", fetched_at: Date.now() / 1000 }
    }
    return out
  } catch (exc) {
    return { status: "unknown", reason: String(exc).slice(0, 120), fetched_at: Date.now() / 1000 }
  }
}

// ---- DeepSeek balance (pay-as-you-go never hard-blocks; only exhausted balance/arrears marks exhausted) ----
export async function fetchDeepseekBalance(key: string): Promise<DeepseekQuota> {
  try {
    const { status, body } = await fetchJson(DS_API, { Authorization: `Bearer ${key}`, Accept: "application/json" })
    if (status !== 200) return { status: "unknown", reason: `HTTP ${status}`, fetched_at: Date.now() / 1000 }
    const balances = (Array.isArray(body?.balance_infos) ? body.balance_infos : []).map((b: any) => ({
      currency: String(b?.currency ?? ""),
      total_balance: String(b?.total_balance ?? "0"),
    }))
    const allZero = balances.length > 0 && balances.every((b: DsBalance) => Number.parseFloat(b.total_balance) <= 0)
    const unavailable = body?.is_available === false
    return { status: "ok", fetched_at: Date.now() / 1000, balances, exhausted: unavailable || allZero }
  } catch (exc) {
    return { status: "unknown", reason: String(exc).slice(0, 120), fetched_at: Date.now() / 1000 }
  }
}

// ---- Copilot copilot_internal/user (normalized: remaining ?? quota_remaining; fields may be missing) ----
function normalizeSnapshot(raw: Record<string, unknown>): PremiumSnapshot {
  const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null)
  const str = (v: unknown): string | null => (typeof v === "string" ? v : null)
  return {
    quota_id: str(raw.quota_id) ?? "",
    entitlement: num(raw.entitlement),
    used: num(raw.credits_used),
    remaining: num(raw.remaining) ?? num(raw.quota_remaining),
    percent_remaining: num(raw.percent_remaining),
    unlimited: raw.unlimited === true,
    overage_permitted: raw.overage_permitted === true,
    has_quota: typeof raw.has_quota === "boolean" ? raw.has_quota : null,
    timestamp_utc: str(raw.timestamp_utc),
  }
}

export async function fetchCopilotQuota(githubToken: string): Promise<CopilotQuota> {
  try {
    const { status, body } = await fetchJson(COPILOT_USER_URL, {
      Accept: "application/json",
      Authorization: `Bearer ${githubToken}`,
      ...IMPOSTOR_HEADERS,
    })
    if (status === 401 || status === 403) {
      return { status: "unknown", reason: `GitHub token ${status} (waiting for the opencode core to self-heal; not refreshed at this layer)`, fetched_at: Date.now() / 1000 }
    }
    if (status !== 200) return { status: "unknown", reason: `HTTP ${status}`, fetched_at: Date.now() / 1000 }
    const raw = body?.quota_snapshots ?? {}
    const premiumRaw = raw?.premium_interactions
    const premium = premiumRaw && typeof premiumRaw === "object" ? normalizeSnapshot(premiumRaw) : null
    return {
      status: "ok",
      fetched_at: Date.now() / 1000,
      login: typeof body?.login === "string" ? body.login : null,
      plan: typeof body?.copilot_plan === "string" ? body.copilot_plan : null,
      sku: typeof body?.access_type_sku === "string" ? body.access_type_sku : null,
      reset_date: typeof body?.quota_reset_date === "string" ? body.quota_reset_date : null,
      premium,
    }
  } catch (exc) {
    return { status: "unknown", reason: String(exc).slice(0, 120), fetched_at: Date.now() / 1000 }
  }
}

// ---- opencode auth store reading (read-only auth.json; never refresh -- rotating the GitHub OAuth refresh token would invalidate opencode credentials) ----
export interface AuthStoreCreds { githubToken?: string; glmKey?: string; dsKey?: string }

export function readAuthStore(): AuthStoreCreds {
  const candidates = [
    join(process.env.XDG_DATA_HOME ?? join(homedir(), ".local", "share"), "opencode", "auth.json"),
    join(homedir(), ".opencode", "auth.json"),
    join(process.env.OPENCODE_CONFIG_DIR ?? "", "auth.json"),
  ]
  for (const p of candidates) {
    try {
      if (!p || !existsSync(p)) continue
      const auth = JSON.parse(readFileSync(p, "utf8"))
      const out: AuthStoreCreds = {}
      for (const [pid, entry] of Object.entries<any>(auth ?? {})) {
        if (pid.includes("copilot") && entry?.type === "oauth" && typeof entry.access === "string") {
          out.githubToken = entry.access
        } else if (entry?.type === "api" && typeof entry.key === "string") {
          if (pid.includes("zhipuai") || pid.includes("glm") || pid.includes("zai")) out.glmKey = entry.key
          else if (pid.includes("deepseek")) out.dsKey = entry.key
        }
      }
      return out
    } catch { /* try the next candidate */ }
  }
  return {}
}

export function readCopilotGithubToken(): string | undefined {
  return readAuthStore().githubToken
}

// ---- cache IO and orchestration ----
type QuotaData = GlmQuota | CopilotQuota | DeepseekQuota

function hotOf(pool: string, data: QuotaData | null): boolean {
  if (!data) return false
  if (pool === "glm") return glmHot(data as GlmQuota)
  if (pool === "copilot") return copilotHot(data as CopilotQuota)
  return false
}

function quotaPath(pool: string): string {
  const p = paths()
  return pool === "glm" ? p.glmQuota : pool === "copilot" ? p.copilotQuota : p.dsQuota
}

/** Read cache: fresh within TTL; with staleOk also return data up to 7200s old (with a stale flag); corrupted/expired -> null */
export function readQuotaCache<T extends QuotaData>(pool: string, staleOk = false): T | null {
  const data = readJson<T>(quotaPath(pool))
  if (!data || typeof data !== "object" || (data as any).status !== "ok") return null
  const age = Date.now() / 1000 - Number((data as any).fetched_at ?? 0)
  if (age < 0) return null
  const ttl = hotOf(pool, data) ? QUOTA_TTL_HOT : QUOTA_TTL
  if (age <= ttl) return data
  if (staleOk && age <= QUOTA_STALE_OK) {
    return { ...data, stale: true }
  }
  return null
}

// Single-flight: dedupe concurrent refreshes for the same pool
const inflight: Record<string, Promise<void>> = {}

export function refreshQuota(pool: "glm" | "copilot" | "deepseek", creds: { glmKey?: string; dsKey?: string; copilotToken?: string }): Promise<void> {
  const existing = inflight[pool]
  if (existing) return existing
  const p = (async () => {
    try {
      let data: QuotaData | null = null
      if (pool === "glm" && creds.glmKey) data = await fetchGlmQuota(creds.glmKey)
      else if (pool === "copilot" && creds.copilotToken) data = await fetchCopilotQuota(creds.copilotToken)
      else if (pool === "deepseek" && creds.dsKey) data = await fetchDeepseekBalance(creds.dsKey)
      else data = { status: "unknown", reason: "no usable credentials", fetched_at: Date.now() / 1000 } as QuotaData
      if ((data as any).status === "ok") writeJsonAtomic(quotaPath(pool), data)
    } catch { /* fail-open */ }
  })()
  inflight[pool] = p.finally(() => {
    delete inflight[pool]
  })
  return inflight[pool]!
}

export interface QuotaFlags {
  /** Only observe=false turns off queries and the banner; routing=false still keeps observing. */
  observe?: { glm: boolean; deepseek: boolean; copilot: boolean }
  enabled?: { glm: boolean; deepseek: boolean; copilot: boolean }
}

export interface QuotaView {
  glm: GlmQuota | null
  copilot: CopilotQuota | null
  deepseek: DeepseekQuota | null
}

/** Keep the three pool caches as fresh as possible: expired/missing triggers a background refresh (non-blocking), reads allow stale_ok grace. */
export function quotaView(
  creds: { glmKey?: string; dsKey?: string; copilotToken?: string },
  flags: QuotaFlags,
): QuotaView {
  const pools: Array<"glm" | "copilot" | "deepseek"> = ["glm", "copilot", "deepseek"]
  const observe = flags.observe ?? flags.enabled!
  for (const pool of pools) {
    if (observe[pool] === false) continue
    if (readQuotaCache(pool) === null) {
      refreshQuota(pool, creds).catch(() => {})
    }
  }
  return {
    glm: observe.glm === false ? null : readQuotaCache<GlmQuota>("glm", true),
    copilot: observe.copilot === false ? null : readQuotaCache<CopilotQuota>("copilot", true),
    deepseek: observe.deepseek === false ? null : readQuotaCache<DeepseekQuota>("deepseek", true),
  }
}

/** Second source of truth for Copilot gateway quota errors: set gateway_exhausted trusted until reset_date (called from the index.ts event path) */
export function markCopilotGatewayExhausted(reason: string): void {
  try {
    const path = quotaPath("copilot")
    const cur = readJson<CopilotQuota>(path) ?? { status: "ok", fetched_at: Date.now() / 1000 }
    if (cur.status !== "ok") return
    cur.gateway_exhausted = true
    cur.reason = reason.slice(0, 120)
    writeJsonAtomic(path, cur)
  } catch { /* fail-open */ }
}
