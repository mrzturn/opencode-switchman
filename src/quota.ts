// 三端点配额探测（v1.1）：GLM monitor / DeepSeek balance / Copilot copilot_internal/user
// [2026-08-28]-[Copilot 直查官方内部端点（VS Code 同款），实测 200]-
// [安全红线：GitHub OAuth token 只读，绝不 refresh——轮转会作废 opencode 凭证；401→unknown 自愈]-
// [三层兜底：网络失败→旧缓存≤7200s→unknown；无凭证/401→unknown 不硬拦；缓存损坏→unknown]
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
  } catch { /* body 留空 */ }
  return { status: res.status, body }
}

// ---- GLM（TOKENS_LIMIT 按 (unit,number) 区分 5h/周）----
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
      return { status: "unknown", reason: "响应缺少 TOKENS_LIMIT 项（套餐类型或接口变更？）", fetched_at: Date.now() / 1000 }
    }
    return out
  } catch (exc) {
    return { status: "unknown", reason: String(exc).slice(0, 120), fetched_at: Date.now() / 1000 }
  }
}

// ---- DeepSeek balance（按量正常永不硬拦；仅余额耗尽/欠费判 exhausted）----
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

// ---- Copilot copilot_internal/user（归一化：remaining ?? quota_remaining；字段允许缺失）----
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
      return { status: "unknown", reason: `GitHub token ${status}（等待 opencode 核心自愈，本层不刷新）`, fetched_at: Date.now() / 1000 }
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

// ---- opencode 鉴权层读取（只读 auth.json；绝不刷新——GitHub OAuth refresh token 轮转会作废 opencode 凭证）----
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
    } catch { /* 尝试下一个候选 */ }
  }
  return {}
}

export function readCopilotGithubToken(): string | undefined {
  return readAuthStore().githubToken
}

// ---- 缓存读写与编排 ----
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

/** 读缓存：TTL 内新鲜；staleOk 时 ≤7200s 旧数据也返回（带 stale 标记）；损坏/过期→null */
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

// 单飞控制：同池并发刷新去重
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
      else data = { status: "unknown", reason: "无可用凭证", fetched_at: Date.now() / 1000 } as QuotaData
      if ((data as any).status === "ok") writeJsonAtomic(quotaPath(pool), data)
    } catch { /* fail-open */ }
  })()
  inflight[pool] = p.finally(() => {
    delete inflight[pool]
  })
  return inflight[pool]!
}

export interface QuotaFlags {
  /** observe=false 才关闭查询和横幅；routing=false 仍持续观察。 */
  observe?: { glm: boolean; deepseek: boolean; copilot: boolean }
  enabled?: { glm: boolean; deepseek: boolean; copilot: boolean }
}

export interface QuotaView {
  glm: GlmQuota | null
  copilot: CopilotQuota | null
  deepseek: DeepseekQuota | null
}

/** 保证三池缓存尽量新鲜：过期/缺失即触发后台刷新（不等待），读取按 stale_ok 宽限。 */
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

/** Copilot 网关额度类错误第二真值源：置 gateway_exhausted 信任至 reset_date（index.ts 事件路径调用） */
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
