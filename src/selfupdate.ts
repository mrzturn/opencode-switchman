// 插件自身更新检查：状态缓存与所有外部调用均 fail-open，绝不影响 OpenCode 启动。
import { execFileSync } from "node:child_process"
import { dirname } from "node:path"
import { paths, readJson, withPathLock, writeJsonAtomic } from "./state"
import { PLUGIN_VERSION } from "./version"

export type LoadMode = "local" | "prod"

export interface SelfUpdateState {
  checked_at: string
  mode: LoadMode
  current: string
  latest: string
  outdated: boolean
}

const UPDATE_TTL_MS = 24 * 60 * 60 * 1000

export function modeOfDistPath(dir: string): LoadMode {
  return dir.split(/[\\/]+/).includes("node_modules") ? "prod" : "local"
}

export function detectLoadMode(): LoadMode {
  return modeOfDistPath(import.meta.dir)
}

/** 正数表示 latest 较 current 新；预发布标记按规格忽略。 */
export function compareSemver(current: string, latest: string): number {
  const parts = (version: string): number[] => version.replace(/^v/, "").split("-")[0]!.split(".")
    .slice(0, 3).map((part) => Number.parseInt(part, 10) || 0)
  const a = parts(current)
  const b = parts(latest)
  for (let i = 0; i < 3; i++) {
    if ((a[i] ?? 0) !== (b[i] ?? 0)) return (b[i] ?? 0) - (a[i] ?? 0)
  }
  return 0
}

function validState(value: unknown): value is SelfUpdateState {
  if (!value || typeof value !== "object") return false
  const state = value as Partial<SelfUpdateState>
  return typeof state.checked_at === "string" && (state.mode === "local" || state.mode === "prod")
    && typeof state.current === "string" && typeof state.latest === "string" && typeof state.outdated === "boolean"
}

export function readSelfUpdateState(): SelfUpdateState | null {
  const state = readJson<unknown>(paths().selfupdate)
  if (!validState(state)) return null
  const checkedAt = Date.parse(state.checked_at)
  if (!Number.isFinite(checkedAt) || Date.now() - checkedAt > UPDATE_TTL_MS) return null
  return state
}

function localUpdateState(): SelfUpdateState {
  const root = dirname(import.meta.dir)
  const latest = execFileSync("git", ["ls-remote", "https://github.com/mrzturn/opencode-switchman.git", "refs/heads/main"], {
    timeout: 8_000, encoding: "utf8",
  }).trim().split(/\s+/)[0]
  const current = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, timeout: 8_000, encoding: "utf8" }).trim()
  if (!latest || !current) throw new Error("git 更新检查未返回提交 SHA")
  return { checked_at: new Date().toISOString(), mode: "local", current, latest: "origin/main 有新提交", outdated: latest !== current }
}

async function prodUpdateState(): Promise<SelfUpdateState> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 8_000)
  try {
    const response = await fetch("https://registry.npmjs.org/opencode-switchman/latest", { signal: controller.signal })
    if (!response.ok) throw new Error(`npm registry HTTP ${response.status}`)
    const body = await response.json() as { version?: unknown }
    if (typeof body.version !== "string") throw new Error("npm registry 未返回 version")
    return {
      checked_at: new Date().toISOString(), mode: "prod", current: PLUGIN_VERSION, latest: body.version,
      outdated: compareSemver(PLUGIN_VERSION, body.version) > 0,
    }
  } finally {
    clearTimeout(timer)
  }
}

export async function refreshSelfUpdate(): Promise<SelfUpdateState | null> {
  const path = paths().selfupdate
  return withPathLock(path, async () => {
    const cached = readSelfUpdateState()
    if (cached) return cached
    try {
      const state = detectLoadMode() === "prod" ? await prodUpdateState() : localUpdateState()
      writeJsonAtomic(path, state)
      return state
    } catch (exc) {
      console.error(`[opencode-switchman] 自更新检查 fail-open: ${exc}`)
      return null
    }
  })
}

export function bannerTextOf(state: SelfUpdateState | null): string | null {
  if (!state?.outdated) return null
  if (state.mode === "prod") {
    return `opencode-switchman 有新版 ${state.latest}（当前 ${state.current}）——cd ~/.config/opencode && npm install opencode-switchman 后重启`
  }
  return "本地构建落后 origin/main——仓库内 git pull && bun run mode:local 后重启"
}

export function updateBannerText(): string | null {
  return bannerTextOf(readSelfUpdateState())
}
