// 失败记账与熔断
// 主键 combo_key（同 combo 别名壳共享熔断）；not-found 只熔断请求名不牵连 combo；
// 600s 窗 ≥2 败 → down_agents + down_expiry(600s)；fail-open：记账失败只写 stderr。
import { appendFileSync, statSync, openSync, readSync, closeSync } from "node:fs"
import {
  FAIL_THRESHOLD, FAIL_WINDOW, DOWN_TTL, ensureStateDir, paths, readJson,
  writeJsonAtomic, nowIso, loadRouting, cleanExpired,
} from "./state"
import type { Routing, ShellRegEntry } from "./types"

const TAIL_BYTES = 262144
const NOT_FOUND_HINTS = ["not found", "not_found", "未找到", "无法找到"]

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
    console.error(`[opencode-switchman] breaker fail-open: ${exc}`)
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
