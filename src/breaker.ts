// 失败记账与熔断
// 主键 combo_key（同 combo 别名壳共享熔断）；not-found 只熔断请求名不牵连 combo；
// 600s 窗 ≥2 败 → down_agents + down_expiry(600s)；fail-open：记账失败只写 stderr。
import { appendFileSync, statSync, openSync, readSync, closeSync } from "node:fs"
import {
  FAIL_THRESHOLD, FAIL_WINDOW, DOWN_TTL, ensureStateDir, paths, readJson,
  writeJsonAtomic, nowIso, loadRouting, cleanExpired, appendStatusLog,
} from "./state"
import type { Routing, ShellRegEntry } from "./types"

const TAIL_BYTES = 262144
const NOT_FOUND_HINTS = ["not found", "not_found", "未找到", "无法找到"]
export const REAL_FAIL_TTL_MS = 1_800_000
// [2026-08-29]-[失败分类：瞬时 429 用短 TTL，区别于真失败长 TTL——避免限流误伤 30 分钟]
export const RATE_LIMIT_TTL_MS = 600_000
// [2026-09-01]-[endpoint 类配置层永久错误：30 分钟重试无意义，用 6h 长 TTL 隔离]
export const ENDPOINT_TTL_MS = 21_600_000
const realFailedCombos = new Map<string, number>()

/** 探针成功而实调失败的短期内存隔离；重启自然清空。ttlMs 可选（限流用短 TTL）。 */
export function markRealFailure(comboKey: string, now = Date.now(), ttlMs = REAL_FAIL_TTL_MS): void {
  if (comboKey) realFailedCombos.set(comboKey, now + ttlMs)
}

// [2026-09-01]-[可观测性：隔离事件此前纯内存零落盘——横幅报 down 却无审计痕迹；
//  failures.log 追加 kind 标记条目（isolated/injection 不进熔断窗口计数）]
export function recordIsolation(agent: string, comboKey: string, category: string, ttlMs: number, reasonRaw: string): void {
  try {
    const now = Date.now() / 1000
    const mins = Math.round(ttlMs / 60_000)
    const reason = `实调隔离(${mins}m·${category}): ${reasonRaw.split(/\s+/).join(" ")}`.slice(0, 200)
    ensureStateDir()
    appendFileSync(paths().failures, `${JSON.stringify({ agent, key: comboKey, shell: agent, combo: comboKey, reason, ts: now, kind: "isolated" })}\n`)
    appendStatusLog(`${agent} 实调隔离 ${mins}m（${category}）：${reasonRaw.slice(0, 60)}`)
  } catch { /* fail-open */ }
}

/** 壳未注册类（调度层失败）仅审计：写 log 供追溯，不隔离不熔断。 */
export function recordInjection(agent: string, reasonRaw: string): void {
  try {
    const now = Date.now() / 1000
    const reason = `壳未注入opencode（不隔离）: ${reasonRaw.split(/\s+/).join(" ")}`.slice(0, 200)
    ensureStateDir()
    appendFileSync(paths().failures, `${JSON.stringify({ agent, key: agent, shell: null, combo: null, reason, ts: now, kind: "injection" })}\n`)
    appendStatusLog(`壳未注入opencode（不隔离）: ${agent} ${reasonRaw.slice(0, 60)}`)
  } catch { /* fail-open */ }
}

/** 隔离剩余毫秒（横幅 TTL 展示用）；未隔离返回 null。 */
export function realFailedRemainingMs(comboKey: string | undefined, now = Date.now()): number | null {
  if (!comboKey) return null
  realFailedComboKeys(now) // 惰性清过期
  const exp = realFailedCombos.get(comboKey)
  return exp !== undefined && exp > now ? exp - now : null
}

// ---- 模型退休（厂商无关：连续 404 类失败 → 永久移出候选，重启清空）----
const NOT_FOUND_WINDOW_MS = 3_600_000
const NOT_FOUND_THRESHOLD = 3
const notFoundHits = new Map<string, number[]>() // modelKey -> 1h 窗内命中时间戳
const retiredModels = new Set<string>()

/**
 * 记一次模型下线类（404）失败：1h 滑窗内连续 ≥3 次 → 加入 retired 集（不再过期，重启清空）。
 * 「连续」以 1h 窗内累计近似（非严格无间隔判定）。返回是否恰好本次触发退休。
 */
export function noteModelNotFound(modelKey: string, now = Date.now()): boolean {
  if (!modelKey || retiredModels.has(modelKey)) return false
  const hits = (notFoundHits.get(modelKey) ?? []).filter((t) => now - t <= NOT_FOUND_WINDOW_MS)
  hits.push(now)
  notFoundHits.set(modelKey, hits)
  if (hits.length >= NOT_FOUND_THRESHOLD) {
    retiredModels.add(modelKey)
    return true
  }
  return false
}

export function isModelRetired(modelKey: string): boolean {
  return retiredModels.has(modelKey)
}

export function retiredModelKeys(): string[] {
  return [...retiredModels]
}

/** 滤掉已退休模型的壳（供 baseChainFor 排除候选）。 */
export function filterRetiredShells<T extends { provider: string; modelId: string }>(shells: readonly T[]): T[] {
  return shells.filter((s) => !retiredModels.has(`${s.provider}/${s.modelId}`))
}

/** 惰性清理后返回仍被实调失败隔离的组合。 */
export function realFailedComboKeys(now = Date.now()): Set<string> {
  for (const [key, expiresAt] of realFailedCombos) {
    if (expiresAt <= now) realFailedCombos.delete(key)
  }
  return new Set(realFailedCombos.keys())
}

/** 测试与消费层共用的组合命中判定。 */
export function isRealFailedCombo(comboKey: string | undefined, now = Date.now()): boolean {
  return Boolean(comboKey && realFailedComboKeys(now).has(comboKey))
}

export function isNotFound(reason: string): boolean {
  const low = reason.toLowerCase()
  return NOT_FOUND_HINTS.some((h) => low.includes(h))
}

export function agentDown(agent: string, routing: Routing, registry: Record<string, ShellRegEntry> | null): boolean {
  const down = routing?.down_agents
  if (!down || typeof down !== "object") return false
  if (agent in down) return true
  const combo = registry?.[agent]?.comboKey
  return Boolean(combo && combo in down)
}

function breakerKeys(
  agent: string, reason: string, registry: Record<string, ShellRegEntry> | null,
): { key: string; shell: string | null; combo: string | null } {
  if (isNotFound(reason)) return { key: agent, shell: null, combo: null }
  const shell = registry?.[agent]
  if (shell) {
    return { key: shell.comboKey || agent, shell: agent, combo: shell.comboKey }
  }
  return { key: agent, shell: null, combo: null }
}

function recentFailureCount(key: string, now: number): number {
  let data: string
  try {
    const buf = readFileSyncTail(paths().failures, TAIL_BYTES)
    const truncated = buf.truncated
    data = buf.text
    const lines = data.split("\n").slice(truncated ? 1 : 0)
    let count = 0
    for (const line of lines.slice(-2000)) {
      if (!line.trim()) continue
      try {
        const rec = JSON.parse(line)
        // [2026-09-01]-[kind 条目（isolated/injection）仅审计，不进熔断窗口计数]
        if (rec.kind) continue
        if ((rec.key === key || rec.agent === key) && now - Number(rec.ts ?? 0) <= FAIL_WINDOW) count++
      } catch { continue }
    }
    return count
  } catch {
    return 0
  }
}

function readFileSyncTail(path: string, bytes: number): { text: string; truncated: boolean } {
  let size = 0
  try {
    size = statSync(path).size
  } catch {
    return { text: "", truncated: false }
  }
  const start = Math.max(0, size - bytes)
  const fh = openSync(path, "r")
  try {
    const buf = Buffer.alloc(size - start)
    readSync(fh, buf, 0, buf.length, start)
    return { text: buf.toString("utf8"), truncated: start > 0 }
  } finally {
    closeSync(fh)
  }
}

export interface FailureRecordResult { key: string; tripped: boolean }

/** 记一次派发失败：追加 JSONL → 窗口计数 → 触发熔断写 routing.json。全程 fail-open。 */
export function recordFailure(
  agent: string,
  reasonRaw: string,
  registry: Record<string, ShellRegEntry> | null,
): FailureRecordResult {
  try {
    const now = Date.now() / 1000
    const reason = reasonRaw.split(/\s+/).join(" ").slice(0, 200) || "派发失败（未携带原因）"
    const { key, shell, combo } = breakerKeys(agent, reason, registry)
    ensureStateDir()
    appendFileSync(paths().failures, `${JSON.stringify({ agent, key, shell, combo, reason, ts: now })}\n`)
    if (recentFailureCount(key, now) >= FAIL_THRESHOLD) {
      const routing = loadRouting()
      const why = `窗口内连续失败 ≥${FAIL_THRESHOLD} 次：${reason}`
      routing.down_agents[key] = isNotFound(reason)
        ? `请求名 not found（仅熔断该名，不判 combo）：${reason.slice(0, 80)}`
        : why
      routing.down_expiry[key] = now + DOWN_TTL
      routing.updated_at = nowIso()
      writeJsonAtomic(paths().routing, routing)
      return { key, tripped: true }
    }
    return { key, tripped: false }
  } catch (exc) {
    appendStatusLog(`breaker fail-open: ${exc}`)
    return { key: agent, tripped: false }
  }
}

/** 顺带清理过期熔断项并回写 */
export function cleanRoutingExpired(): void {
  try {
    const routing = loadRouting()
    const dead = cleanExpired(routing)
    if (dead.length > 0) {
      routing.updated_at = nowIso()
      writeJsonAtomic(paths().routing, routing)
    }
  } catch { /* fail-open */ }
}

export function loadBreakerRouting(): Routing {
  return readJson<Routing>(paths().routing) ?? { down_agents: {}, down_expiry: {} }
}
