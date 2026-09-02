// 状态层：状态目录、常量、JSON 原子读写、注册表视图装配（清单 × 矩阵 × 凭据）
// [2026-08-28]-[测试用 SWITCHMAN_STATE 覆盖 state 目录]
import { mkdirSync, readFileSync, writeFileSync, renameSync, statSync, existsSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import manifestDefault from "./shells.json"
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
    // [2026-08-31]-[动态能力分级缓存（source/version/fetched_at + 模型指数表；TTL 24h last-good）]
    capability: join(dir, "capability.json"),
    // [2026-08-29]-[动态矩阵 v1.3 新增状态文件]
    modelCatalog: join(dir, "model-catalog.json"),
    // [2026-09-01]-[对齐 opencode 内置 github-copilot/models.ts：Copilot /models 真实 capabilities.supports
    //  （messagesApi/reasoning_effort/adaptive_thinking/max_thinking_budget）缓存，TTL 24h；
    //  取代 probe.ts/shells.ts 原先按 modelId 前缀猜测的固定 thinking 参数表]
    copilotThinking: join(dir, "copilot-thinking.json"),
    shellSuperset: join(dir, "shell-superset.json"),
    // [2026-09-01]-[provider.list 结果跨重启缓存：仅在真实探测成功（非回退）时写入，下次启动直接
    //  用缓存建壳，免去每次重启都要重新等 provider.list 网络竞态——新 provider 由后台探测发现后
    //  才提示重启，不再"启动即等、进来又提示重启"]
    providerCache: join(dir, "provider-cache.json"),
    activeMatrix: join(dir, "active-matrix.json"),
    // [2026-08-29]-[评分引擎决策日志（环形截断 200 行，JSONL）]
    decisions: join(dir, "routing-decisions.jsonl"),
    selfupdate: join(dir, "selfupdate.json"),
    doctorSnapshot: join(dir, "doctor-snapshot.json"),
    // [2026-08-31]-[TUI 侧边栏实时状态：横幅内容改落盘，供 tui.tsx 轮询渲染而非刷屏 stderr]
    statusLog: join(dir, "status-log.json"),
    // [2026-09-01]-[TUI 侧边栏新增「各任务档位实时最佳候选」面板：横幅重建时同步落盘，供 tui.tsx 轮询渲染]
    routeSnapshot: join(dir, "route-snapshot.json"),
    // [2026-09-01]-[TUI 侧边栏新增「provider 水位/峰值」面板：与 [水位] 横幅同源、常态可见，供 tui.tsx 轮询渲染]
    quotaBrief: join(dir, "quota-brief.json"),
  }
}

// [2026-08-31]-[TUI 侧边栏实时状态环形日志：最多保留 STATUS_LOG_MAX 条，供 tui.tsx 轮询读取]
export const STATUS_LOG_MAX = 20
export type StatusLogEntry = { ts: string; text: string }
export function appendStatusLog(text: string): void {
  try {
    const p = paths().statusLog
    const prev = readJson<StatusLogEntry[]>(p) ?? []
    const next = [...prev, { ts: nowIso(), text }].slice(-STATUS_LOG_MAX)
    writeJsonAtomic(p, next)
  } catch { /* fail-open：状态日志失败不影响主流程 */ }
}

// [2026-09-01]-[各任务档位（lane）实时最佳候选快照：整体覆盖写入（非环形追加），供侧边栏「最佳模型」面板渲染]
export type RouteSnapshotEntry = { lane: string; best: string | null; degraded: boolean }
export function writeRouteSnapshot(entries: RouteSnapshotEntry[]): void {
  try {
    writeJsonAtomic(paths().routeSnapshot, { ts: nowIso(), entries })
  } catch { /* fail-open：快照写入失败不影响主流程 */ }
}

// [2026-09-01]-[provider 水位/峰值快照：整体覆盖写入，供侧边栏「水位」面板渲染；结构与 banner.ts
//  providerStatusEntries 同源（observe=false 的 provider 已在调用方过滤，不出现在此文件里）。
//  [2026-09-02]-[v2：一 provider 一条目块＋rows 子行（进度条/重置时间），替代单行 text]]
export type QuotaBriefRow = { label: string; text: string; usedPct: number | null; tail?: string }
export type QuotaBriefEntry = { pool: string; label: string; rows: QuotaBriefRow[]; observeOnly: boolean; peakActive: boolean; stale: boolean }
export function writeQuotaBrief(entries: QuotaBriefEntry[]): void {
  try {
    writeJsonAtomic(paths().quotaBrief, { ts: nowIso(), entries })
  } catch { /* fail-open：快照写入失败不影响主流程 */ }
}


// ---- 常量 ----
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

// [2026-08-29]-[修复复审P1-写入竞态：临时文件名唯一化（pid+计数器），并发写不得互踩 tmp 再 rename 错文件]
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
    // [2026-08-29]-[复审P2-写失败静默无痕：调用方无法感知未落盘，统一在此留痕]-[不改变 fail-open 语义]
    console.error(`[opencode-switchman] 原子写失败（fail-open）: ${path}: ${exc}`)
  }
}

// [2026-08-29]-[修复复审P1-写入竞态：同文件异步读改写串行化（简单互斥队列），并发不丢更新]
const pathLocks = new Map<string, Promise<unknown>>()
export function withPathLock<T>(path: string, fn: () => T | Promise<T>): Promise<T> {
  const prev = pathLocks.get(path) ?? Promise.resolve()
  const run = prev.then(fn, fn) // 前序失败不阻断后续
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

// ---- 壳清单与注册表视图 ----
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

/** 清除过期熔断项，返回被清除键列表 */
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

/** 注册表视图：清单 × 矩阵 ×（copilot 凭据在场）。status≠enabled 只降级不丢壳——六闸按矩阵致因区分。 */
export function buildRegistry(
  ctx: Pick<RuntimeContext, "manifest" | "matrix" | "credentials">,
): Record<string, ShellRegEntry> {
  const out: Record<string, ShellRegEntry> = {}
  const combos = ctx.matrix?.combos ?? null
  const copilotCredMissing = !ctx.credentials.copilotToken
  for (const s of ctx.manifest.shells) {
    const entry: ShellRegEntry = { ...s, status: "enabled", comboKey: s.matrixKey }
    if (s.pool === "copilot" && copilotCredMissing) {
      // [v1.1] Copilot 凭据缺失＝池级 unknown（不硬拦）：状态置 enabled 由矩阵/熔断闸兜底，
      // 探针对该池标 unknown reason 提示。此处不做 disabled（fail-open 原则）。
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

/** 运行时上下文装配（文件读全部在此，纯函数层不碰 IO；manifestOverride=动态超集清单视图） */
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

/** 动态超集清单（config 钩子落盘 shell-superset.json；缺失/坏=null） */
export function loadSupersetShells(): { shells: ShellManifestEntry[]; generated_at?: string } | null {
  const data = readJson<{ shells?: unknown; generated_at?: string }>(paths().shellSuperset)
  if (!data || !Array.isArray(data.shells) || data.shells.length === 0) return null
  return { shells: data.shells as ShellManifestEntry[], generated_at: data.generated_at }
}

// [2026-09-01]-[跨重启 provider.list 缓存：models/providers 均为纯字符串数组，读坏/缺失=null（调用方回退阻塞探测）]
export interface ProviderCache { at: string; models: string[]; providers: string[] }
export function loadProviderCache(): ProviderCache | null {
  const data = readJson<ProviderCache>(paths().providerCache)
  if (!data || !Array.isArray(data.providers) || data.providers.length === 0) return null
  return { at: data.at, models: Array.isArray(data.models) ? data.models : [], providers: data.providers }
}
export function saveProviderCache(cache: ProviderCache): void {
  writeJsonAtomic(paths().providerCache, cache)
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
