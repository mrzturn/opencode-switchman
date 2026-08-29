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
    // [2026-08-29]-[动态矩阵 v1.3 新增状态文件]
    modelCatalog: join(dir, "model-catalog.json"),
    shellSuperset: join(dir, "shell-superset.json"),
    activeMatrix: join(dir, "active-matrix.json"),
  }
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
  } catch { /* fail-open */ }
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
