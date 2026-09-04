// [2026-09-04]-[English localization: translate comments and status messages; no logic change]
// Failure accounting and breaker
// primary key combo_key (alias shells of the same combo share the breaker); not-found breaks only the request name, not the combo;
// window 600s with >=2 failures -> down_agents + down_expiry(600s); fail-open: accounting failure only writes stderr.
import { appendFileSync, statSync, openSync, readSync, closeSync } from "node:fs"
import {
  FAIL_THRESHOLD, FAIL_WINDOW, DOWN_TTL, ensureStateDir, paths, readJson,
  writeJsonAtomic, nowIso, loadRouting, cleanExpired, appendStatusLog,
} from "./state"
import type { Routing, ShellRegEntry } from "./types"

const TAIL_BYTES = 262144
// NOTE: the Chinese hints below match inbound error text emitted by external systems (providers/opencode core),
// not copy produced by this plugin; they are kept as-is on purpose during localization.
const NOT_FOUND_HINTS = ["not found", "not_found", "未找到", "无法找到"]
export const REAL_FAIL_TTL_MS = 1_800_000
// [2026-08-29]-[failure classification: transient 429 gets a short TTL vs the long TTL for real failures -- avoids rate-limit false positives lasting 30 minutes]
export const RATE_LIMIT_TTL_MS = 600_000
// [2026-09-01]-[endpoint-class permanent config-layer errors: retrying after 30 minutes is pointless, isolate with a 6h long TTL]
export const ENDPOINT_TTL_MS = 21_600_000
const realFailedCombos = new Map<string, number>()

/** Short-term in-memory isolation for probes-ok-but-real-call-failed; cleared naturally on restart. ttlMs optional (short TTL for rate limits). */
export function markRealFailure(comboKey: string, now = Date.now(), ttlMs = REAL_FAIL_TTL_MS): void {
  if (comboKey) realFailedCombos.set(comboKey, now + ttlMs)
}

// [2026-09-01]-[observability: isolation events used to be purely in-memory with no disk trail -- the banner reported down
//  with no audit trail; failures.log appends kind-tagged entries (isolated/injection do not count into the breaker window)]
export function recordIsolation(agent: string, comboKey: string, category: string, ttlMs: number, reasonRaw: string): void {
  try {
    const now = Date.now() / 1000
    const mins = Math.round(ttlMs / 60_000)
    const reason = `real-call isolation(${mins}m·${category}): ${reasonRaw.split(/\s+/).join(" ")}`.slice(0, 200)
    ensureStateDir()
    appendFileSync(paths().failures, `${JSON.stringify({ agent, key: comboKey, shell: agent, combo: comboKey, reason, ts: now, kind: "isolated" })}\n`)
    appendStatusLog(`${agent} real-call isolated for ${mins}m (${category}): ${reasonRaw.slice(0, 60)}`)
  } catch { /* fail-open */ }
}

/** Unregistered-shell class (dispatch-layer failure) is audit-only: write the log for traceability, no isolation no breaker. */
export function recordInjection(agent: string, reasonRaw: string): void {
  try {
    const now = Date.now() / 1000
    const reason = `shell not injected into opencode (no isolation): ${reasonRaw.split(/\s+/).join(" ")}`.slice(0, 200)
    ensureStateDir()
    appendFileSync(paths().failures, `${JSON.stringify({ agent, key: agent, shell: null, combo: null, reason, ts: now, kind: "injection" })}\n`)
    appendStatusLog(`shell not injected into opencode (no isolation): ${agent} ${reasonRaw.slice(0, 60)}`)
  } catch { /* fail-open */ }
}

/** Remaining isolation milliseconds (for banner TTL display); null when not isolated. */
export function realFailedRemainingMs(comboKey: string | undefined, now = Date.now()): number | null {
  if (!comboKey) return null
  realFailedComboKeys(now) // lazily clear expired entries
  const exp = realFailedCombos.get(comboKey)
  return exp !== undefined && exp > now ? exp - now : null
}

// ---- model retirement (vendor-agnostic: consecutive 404-class failures -> removed from candidates permanently, cleared on restart) ----
const NOT_FOUND_WINDOW_MS = 3_600_000
const NOT_FOUND_THRESHOLD = 3
const notFoundHits = new Map<string, number[]>() // modelKey -> hit timestamps within a 1h window
const retiredModels = new Set<string>()

/**
 * Record a model-gone (404-class) failure: >=3 within a sliding 1h window -> add to the retired set (never expires, cleared on restart).
 * "Consecutive" is approximated by accumulation within the 1h window (not a strict gapless check). Returns whether this call triggered retirement.
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

/** Filter out shells of retired models (for baseChainFor candidate exclusion). */
export function filterRetiredShells<T extends { provider: string; modelId: string }>(shells: readonly T[]): T[] {
  return shells.filter((s) => !retiredModels.has(`${s.provider}/${s.modelId}`))
}

/** Return combos still isolated for real-call failures after lazy cleanup. */
export function realFailedComboKeys(now = Date.now()): Set<string> {
  for (const [key, expiresAt] of realFailedCombos) {
    if (expiresAt <= now) realFailedCombos.delete(key)
  }
  return new Set(realFailedCombos.keys())
}

/** Combo hit check shared by tests and consumers. */
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
        // [2026-09-01]-[kind entries (isolated/injection) are audit-only, not counted into the breaker window]
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

/** Record a dispatch failure: append JSONL -> window count -> trip the breaker into routing.json. fail-open throughout. */
export function recordFailure(
  agent: string,
  reasonRaw: string,
  registry: Record<string, ShellRegEntry> | null,
): FailureRecordResult {
  try {
    const now = Date.now() / 1000
    const reason = reasonRaw.split(/\s+/).join(" ").slice(0, 200) || "dispatch failed (no reason provided)"
    const { key, shell, combo } = breakerKeys(agent, reason, registry)
    ensureStateDir()
    appendFileSync(paths().failures, `${JSON.stringify({ agent, key, shell, combo, reason, ts: now })}\n`)
    if (recentFailureCount(key, now) >= FAIL_THRESHOLD) {
      const routing = loadRouting()
      const why = `>=${FAIL_THRESHOLD} consecutive failures within the window: ${reason}`
      routing.down_agents[key] = isNotFound(reason)
        ? `request name not found (breaker applies to this name only, not the combo): ${reason.slice(0, 80)}`
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

/** Opportunistically clean expired breaker entries and write back */
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
