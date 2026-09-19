// [2026-09-04]-[English localization: translate runtime messages and comments; no logic change]
// State layer: state directory, constants, atomic JSON read/write, registry view assembly (manifest × matrix × credentials)
// [2026-08-28]-[SWITCHMAN_STATE env overrides the state directory for tests]
import { mkdirSync, readFileSync, writeFileSync, renameSync, statSync, existsSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import manifestDefault from "./shells.json"
import type { MsgKey } from "./i18n"
import type {
  ShellManifestEntry, ShellRegEntry, Matrix, Routing, MatrixEntry, SwitchmanOptions,
} from "./types"
import { POOLS } from "./types"

export function stateDir(): string {
  return process.env.SWITCHMAN_STATE || join(homedir(), ".config", "opencode", "opencode-switchman")
}
export const paths = () => {
  const dir = stateDir()
  return {
    dir,
    matrix: join(dir, "model-matrix.json"),
    routing: join(dir, "routing.json"),
    failures: join(dir, "failures.log"),
    glmQuota: join(dir, "glm-quota.json"),
    copilotQuota: join(dir, "copilot-quota.json"),
    dsQuota: join(dir, "ds-balance.json"),
    costs: join(dir, "costs.json"),
    // [2026-08-31]-[dynamic capability grading cache (source/version/fetched_at + model index table; TTL 24h last-good)]
    capability: join(dir, "capability.json"),
    // [2026-09-03]-[user manual override layer (hand-editable, mtime hot-reload):
    //  capability-rank.json = manual capability ranks (order = descending capability, overrides base capability score);
    //  pool-config.json = task-pool selection (lane → list of modelIds joining that pool; one model may join several pools; non-empty filters)]
    capabilityRank: join(dir, "capability-rank.json"),
    poolConfig: join(dir, "pool-config.json"),
    // [2026-08-29]-[dynamic matrix v1.3 new state files]
    modelCatalog: join(dir, "model-catalog.json"),
    // [2026-09-01]-[aligned with opencode built-in github-copilot/models.ts: cache of Copilot /models real capabilities.supports
    //  (messagesApi/reasoning_effort/adaptive_thinking/max_thinking_budget), TTL 24h;
    //  replaces the fixed thinking-parameter table probe.ts/shells.ts previously guessed by modelId prefix]
    copilotThinking: join(dir, "copilot-thinking.json"),
    shellSuperset: join(dir, "shell-superset.json"),
    // [2026-09-06]-[subagent hard cap: persistent registry of force-terminated shell subagent sessions (sessionID →
    //  {at, tokens, agent}); survives restarts so a terminated session can never be resumed via task_id]
    subagentCap: join(dir, "subagent-cap.json"),
    // [2026-09-01]-[provider.list result cached across restarts: written only on real probe success (not fallback), so next
    //  startup builds shells straight from cache and no longer waits out the provider.list network race on every restart —
    //  new providers are discovered by the background probe, only then is a restart hinted]
    providerCache: join(dir, "provider-cache.json"),
    activeMatrix: join(dir, "active-matrix.json"),
    // [2026-08-29]-[scoring engine decision log (ring-truncated 200 lines, JSONL)]
    decisions: join(dir, "routing-decisions.jsonl"),
    selfupdate: join(dir, "selfupdate.json"),
    doctorSnapshot: join(dir, "doctor-snapshot.json"),
    // [2026-08-31]-[TUI sidebar live status: banner content persisted to disk, polled and rendered by tui.tsx instead of flooding stderr]
    statusLog: join(dir, "status-log.json"),
    // [2026-09-01]-[TUI sidebar new "best candidate per task lane" panel: persisted on each banner rebuild, polled by tui.tsx]
    routeSnapshot: join(dir, "route-snapshot.json"),
    // [2026-09-01]-[TUI sidebar new "provider watermark/peak" panel: same source as the [WATERMARK] banner, always visible, polled by tui.tsx]
    quotaBrief: join(dir, "quota-brief.json"),
    // [2026-09-19]-[i18n wiring step 1: render-time locale inputs — global UI locale (from plugin config "ui"."lang")
    //  and workspace dirname (from config "workspace"."dirname"); read by the i18n locale chain, written once per startup]
    uiLocale: join(dir, "ui-locale.json"),
    workspaceMeta: join(dir, "workspace-meta.json"),
  }
}

// [2026-08-31]-[TUI sidebar live status ring log: keeps at most STATUS_LOG_MAX entries, polled by tui.tsx]
// [2026-09-19]-[i18n: entries are now structured {key, params, alert} — the sidebar translates at render time via
//  renderNotice(); legacy prose-only rows (text, no key) still render verbatim, and not-yet-migrated callers passing
//  prose as the key also render verbatim through the unknown-key fallback; `key` is typed string for now and will be
//  tightened to MsgKey once all emitters are migrated]
// [2026-09-19]-[i18n cleanup: tighten the status-log writer to MsgKey (all emitters migrated to catalog keys;
//  legacy prose-only rows still read back via the optional text field; no runtime import — type-only, no cycle)]
export const STATUS_LOG_MAX = 20
export type StatusLogEntry = { ts: string; key?: MsgKey; params?: Record<string, string | number>; alert?: boolean; text?: string }
export function appendStatusLog(key: MsgKey, params?: Record<string, string | number>, alert?: boolean): void {
  try {
    const p = paths().statusLog
    const prev = readJson<StatusLogEntry[]>(p) ?? []
    const entry: StatusLogEntry = { ts: nowIso(), key, ...(params ? { params } : {}), ...(alert ? { alert: true } : {}) }
    const next = [...prev, entry].slice(-STATUS_LOG_MAX)
    writeJsonAtomic(p, next)
  } catch { /* fail-open: status log failure never blocks the main flow */ }
}

// [2026-09-01]-[per-lane live best-candidate snapshot: whole overwrite (not ring-append), renders the sidebar "best model" panel]
export type RouteSnapshotEntry = { lane: string; best: string | null; degraded: boolean }
export function writeRouteSnapshot(entries: RouteSnapshotEntry[]): void {
  try {
    writeJsonAtomic(paths().routeSnapshot, { ts: nowIso(), entries })
  } catch { /* fail-open: snapshot write failure never blocks the main flow */ }
}

// [2026-09-01]-[provider watermark/peak snapshot: whole overwrite, renders the sidebar "watermark" panel; shape shares the same
//  source as banner.ts providerStatusEntries (providers with observe=false are filtered by the caller and never appear here).
//  [2026-09-02]-[v2: one entry block per provider + rows sub-rows (progress bar/reset time), replacing the single-line text]]
// [2026-09-19]-[P4 render-time quota i18n: rows carry key+params as the future TUI render source (t(locale, key, params)
//  against the quota.* catalog); label/text/tail stay as debug/legacy English until the TUI migration renders via key]
// [2026-09-19]-[quota i18n labels/tails: rows additionally carry labelKey+labelParams (quota.row5h/rowWeek/rowMcp/
//  rowCredits/rowBalance; rowRefresh stays as the main key since the refresh text is raw data) and tailKey+tailParams
//  (quota.resetLater/resetTime/resetDate/resetDateTime with {hhmm}/{mmdd}, quota.balanceWarn with {thr}); entries
//  carry key+params for the pool label (quota.poolGlm/poolCopilot/poolDeepSeek, params empty); legacy label/text/tail
//  unchanged; fail-open behavior unchanged]
export type QuotaBriefRow = { key?: string; params?: Record<string, string | number>; labelKey?: string; labelParams?: Record<string, string | number>; tailKey?: string; tailParams?: Record<string, string | number>; usedPct: number | null; label?: string; text?: string; tail?: string }
export type QuotaBriefEntry = { pool: string; label: string; key?: string; params?: Record<string, string | number>; rows: QuotaBriefRow[]; observeOnly: boolean; peakActive: boolean; stale: boolean }
// [2026-09-19]-[P4: signature and fail-open behavior unchanged; entries now flow through with row key+params (see QuotaBriefRow)]
export function writeQuotaBrief(entries: QuotaBriefEntry[]): void {
  try {
    writeJsonAtomic(paths().quotaBrief, { ts: nowIso(), entries })
  } catch { /* fail-open: snapshot write failure never blocks the main flow */ }
}

// [2026-09-19]-[i18n wiring step 1: global UI locale snapshot (normalized tag or null) for the render-time locale chain
//  (see src/i18n.ts resolveDisplayLocale); null overwrites any previous value; fail-open everywhere]
export function writeUiLocale(lang: string | null): void {
  try {
    writeJsonAtomic(paths().uiLocale, { v: 1, lang })
  } catch { /* fail-open: locale snapshot failure never blocks the main flow */ }
}

/** Read the persisted UI locale back; missing/corrupt/non-string → null (caller falls through the locale chain) */
export function readUiLocale(): string | null {
  try {
    const data = readJson<{ lang?: unknown }>(paths().uiLocale)
    return typeof data?.lang === "string" ? data.lang : null
  } catch { return null }
}

// [2026-09-19]-[i18n wiring step 1: workspace dirname snapshot so render-time readers resolve the project settings path
//  without the plugin config; fail-open everywhere]
export function writeWorkspaceMeta(dirname: string): void {
  try {
    writeJsonAtomic(paths().workspaceMeta, { v: 1, dirname })
  } catch { /* fail-open: meta snapshot failure never blocks the main flow */ }
}

/** Read the persisted workspace dirname back; missing/corrupt/empty → ".switchman" */
export function readWorkspaceDirname(): string {
  try {
    const data = readJson<{ dirname?: unknown }>(paths().workspaceMeta)
    if (typeof data?.dirname === "string" && data.dirname.trim()) return data.dirname
    return ".switchman"
  } catch { return ".switchman" }
}


// ---- constants ----
export const FAIL_WINDOW = 600
export const FAIL_THRESHOLD = 2
export const DOWN_TTL = 600
export const QUOTA_STALE_OK = 7200
export const QUOTA_TTL = 300
export const QUOTA_TTL_HOT = 60
export const PROBE_TTL = 600
export const COSTS_TTL = 24 * 3600
export const CAPABILITY_TTL = 24 * 3600

export function nowIso(): string {
  const d = new Date()
  const pad = (n: number, l = 2) => String(n).padStart(l, "0")
  const tz = -d.getTimezoneOffset()
  const sign = tz >= 0 ? "+" : "-"
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}${sign}${pad(Math.abs(tz) / 60 | 0)}${pad(Math.abs(tz) % 60)}`
}

export function readJson<T>(path: string): T | null {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T
  } catch {
    return null
  }
}

// [2026-08-29]-[re-review P1 fix — write race: unique temp file names (pid+counter); concurrent writes must not stomp each other's tmp before renaming the wrong file]
let tmpCounter = 0
export function writeJsonAtomic(path: string, obj: unknown): void {
  try {
    mkdirSync(path.slice(0, path.lastIndexOf("/")), { recursive: true })
  } catch { /* fail-open */ }
  const tmp = `${path}.tmp.${process.pid}.${++tmpCounter}`
  try {
    writeFileSync(tmp, JSON.stringify(obj, null, 2))
    renameSync(tmp, path)
  } catch (exc) {
    // [2026-08-29]-[re-review P2 — silent write failure left no trace: callers could not tell the write never landed; log here uniformly]-[fail-open semantics unchanged]
    console.error(`[opencode-switchman] atomic write failed (fail-open): ${path}: ${exc}`)
  }
}

// [2026-08-29]-[re-review P1 fix — write race: serialize async read-modify-write on the same file (simple mutex queue), concurrent updates are not lost]
const pathLocks = new Map<string, Promise<unknown>>()
export function withPathLock<T>(path: string, fn: () => T | Promise<T>): Promise<T> {
  const prev = pathLocks.get(path) ?? Promise.resolve()
  const run = prev.then(fn, fn) // earlier failure does not block later ones
  pathLocks.set(path, run.then(() => undefined, () => undefined))
  return run
}

export function fileMtime(path: string): number {
  try {
    return statSync(path).mtimeMs
  } catch {
    return 0
  }
}

// ---- shell manifest and registry view ----
export function loadManifest(): { shells: ShellManifestEntry[]; lanes: Record<string, string[]> } {
  const p = join(stateDir(), "shells.json")
  const custom = readJson<{ shells?: ShellManifestEntry[]; lanes?: Record<string, string[]> }>(p)
  if (custom && Array.isArray(custom.shells) && custom.shells.length > 0) {
    return { shells: custom.shells, lanes: custom.lanes ?? (manifestDefault as any).lanes }
  }
  return manifestDefault as unknown as { shells: ShellManifestEntry[]; lanes: Record<string, string[]> }
}

export interface RuntimeContext {
  manifest: ReturnType<typeof loadManifest>
  matrix: Matrix | null
  routing: Routing
  options: SwitchmanOptions
  credentials: { glmKey?: string; dsKey?: string; copilotToken?: string }
}

export function emptyRouting(): Routing {
  return { down_agents: {}, down_expiry: {} }
}

export function loadRouting(): Routing {
  const data = readJson<Routing>(paths().routing)
  if (!data || typeof data !== "object") return emptyRouting()
  if (!isObj(data.down_agents)) data.down_agents = {}
  if (!isObj(data.down_expiry)) data.down_expiry = {}
  return data
}

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v)
}

export function loadMatrix(): Matrix | null {
  const m = readJson<Matrix>(paths().matrix)
  if (!m || !isObj((m as any).combos)) return null
  return m
}

/** Purge expired breaker entries, return the purged keys */
export function cleanExpired(routing: Routing, now = Date.now() / 1000): string[] {
  const dead: string[] = []
  for (const [k, t] of Object.entries(routing.down_expiry)) {
    if (typeof t !== "number" || t <= now) {
      delete routing.down_expiry[k]
      delete routing.down_agents[k]
      dead.push(k)
    }
  }
  return dead
}

/** Registry view: manifest × matrix × (copilot credential present). status≠enabled downgrades without dropping the shell — the six gates distinguish by matrix cause. */
export function buildRegistry(
  ctx: Pick<RuntimeContext, "manifest" | "matrix" | "credentials">,
): Record<string, ShellRegEntry> {
  const out: Record<string, ShellRegEntry> = {}
  const combos = ctx.matrix?.combos ?? null
  const copilotCredMissing = !ctx.credentials.copilotToken
  for (const s of ctx.manifest.shells) {
    const entry: ShellRegEntry = { ...s, status: "enabled", comboKey: s.matrixKey }
    if (s.pool === "copilot" && copilotCredMissing) {
      // [v1.1] Copilot credential missing = pool-level unknown (no hard block): status stays enabled so the matrix/breaker gates catch it,
      // the probe marks that pool unknown with a reason. Not disabled here (fail-open principle).
      entry.status = "enabled"
    } else if (combos) {
      const st = combos[s.matrixKey]
      if (st && st.status === "down") {
        entry.status = "disabled"
        entry.disabledReason = st.reason?.slice(0, 80) ?? "probe down"
      }
    }
    out[s.name] = entry
  }
  return out
}

/** Runtime context assembly (all file reads here; the pure-function layer touches no IO; manifestOverride = dynamic superset manifest view) */
export function loadContext(
  options: SwitchmanOptions,
  credentials: RuntimeContext["credentials"],
  manifestOverride?: { shells: ShellManifestEntry[]; lanes: Record<string, string[]> } | null,
): RuntimeContext {
  const routing = loadRouting()
  try {
    cleanExpired(routing)
  } catch { /* fail-open */ }
  const manifest = manifestOverride ?? loadManifest()
  return {
    manifest,
    matrix: loadMatrix(),
    routing,
    options,
    credentials,
  }
}

export function laneShells(ctx: RuntimeContext, lane: string): string[] {
  const custom = (ctx.options.lanes as any)?.[lane]
  if (Array.isArray(custom) && custom.length > 0) return custom
  const l = (ctx.manifest.lanes as any)[lane]
  return Array.isArray(l) ? l : []
}

/** Dynamic superset manifest (config hook persists shell-superset.json; missing/broken = null)
 *  [2026-09-10]-[candidates = full-superset entries feeding the /modelRank //poolConfig config surfaces (pre-pruning,
 *  deduped by the readers); shells = injection face. Older files without candidates = undefined (readers fall back to shells)] */
export function loadSupersetShells(): { shells: ShellManifestEntry[]; candidates?: ShellManifestEntry[]; generated_at?: string } | null {
  const data = readJson<{ shells?: unknown; candidates?: unknown; generated_at?: string }>(paths().shellSuperset)
  if (!data || !Array.isArray(data.shells) || data.shells.length === 0) return null
  return {
    shells: data.shells as ShellManifestEntry[],
    candidates: Array.isArray(data.candidates) ? (data.candidates as ShellManifestEntry[]) : undefined,
    generated_at: data.generated_at,
  }
}

// [2026-09-01]-[provider.list cache across restarts: models/providers are plain string arrays; broken/missing = null (caller falls back to blocking probe)]
export interface ProviderCache { at: string; models: string[]; providers: string[] }
export function loadProviderCache(): ProviderCache | null {
  const data = readJson<ProviderCache>(paths().providerCache)
  if (!data || !Array.isArray(data.providers) || data.providers.length === 0) return null
  return { at: data.at, models: Array.isArray(data.models) ? data.models : [], providers: data.providers }
}
export function saveProviderCache(cache: ProviderCache): void {
  writeJsonAtomic(paths().providerCache, cache)
}

// [2026-09-06]-[subagent hard cap registry: sessionID → termination record; broken/missing file = empty registry
//  (fail-open — a lost registry only means an already-dead session could be resumed into a fresh cap denial)]
export interface SubagentCapEntry { at: number; tokens: number; agent?: string }
export type SubagentCapRegistry = Record<string, SubagentCapEntry>
export function loadSubagentCapRegistry(): SubagentCapRegistry {
  const data = readJson<SubagentCapRegistry>(paths().subagentCap)
  if (!data || typeof data !== "object" || Array.isArray(data)) return {}
  return data
}
export function saveSubagentCapRegistry(registry: SubagentCapRegistry): void {
  writeJsonAtomic(paths().subagentCap, registry)
}

// [2026-09-06]-[provider cache freshness + model-set delta: the startup stale-cache live probe and the watchdog superset
// rebuild share these pure predicates; provider model lists grow over time (new flagship models), so a cache past TTL (or
// with an unparseable timestamp) must not be trusted blindly]-[pure layer for testability]
export const PROVIDER_CACHE_MAX_AGE_MS = 24 * 3_600_000
/** Cache age in ms; null when the timestamp is missing/unparseable (callers should treat null as stale) */
export function providerCacheAgeMs(cache: ProviderCache, now = Date.now()): number | null {
  const t = Date.parse(cache.at ?? "")
  return Number.isFinite(t) ? now - t : null
}
/** True = do not trust this cache for the superset build (stale past TTL, or timestamp unparseable/missing) */
export function providerCacheStale(cache: ProviderCache, now = Date.now(), maxAgeMs = PROVIDER_CACHE_MAX_AGE_MS): boolean {
  const age = providerCacheAgeMs(cache, now)
  return age === null || age > maxAgeMs
}
/** Order-insensitive diff between the model list the current superset was built from and a fresh provider.list result */
export function providerModelsDelta(builtFrom: readonly string[], fresh: readonly string[]): { added: string[]; removed: string[] } {
  const prev = new Set(builtFrom)
  const next = new Set(fresh)
  return {
    added: [...next].filter((m) => !prev.has(m)).sort(),
    removed: [...prev].filter((m) => !next.has(m)).sort(),
  }
}

export function ensureStateDir(): void {
  try {
    mkdirSync(stateDir(), { recursive: true })
  } catch { /* fail-open */ }
}

export function stateFilesExist(): boolean {
  return existsSync(paths().routing)
}

export const ALL_POOLS = POOLS
export type { MatrixEntry }
