// 插件自身更新检查：状态缓存与所有外部调用均 fail-open，绝不影响 OpenCode 启动。
import { execFileSync } from "node:child_process"
import { mkdirSync, rmSync, statSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { homedir } from "node:os"
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

export function bannerTextOf(state: SelfUpdateState | null, now = Date.now(), baseDir?: string): string | null {
  if (!state?.outdated) return null
  const flags = flagSemantics(baseDir)
  // [2026-08-29]-[升级完成：横幅改显示「已升级待重启」，压过版本提示]-
  if (flags.upgraded) return `opencode-switchman 已升级（运行中 ${state.current}）——重启 opencode 生效`
  if (flags.ignored) return null // 本次忽略：会话级，重启后自动恢复提示
  if (state.mode === "prod") {
    // [2026-08-29]-[一键升级：prod 注册 /switchman-update 与 /switchman-ignore 两个命令入口]-
    return `opencode-switchman 有新版 ${state.latest}（当前 ${state.current}）——/switchman-update 立即升级（静默，完成后提示重启）；/switchman-ignore 本次忽略`
  }
  // local 模式只提示不自动升级（规格：自动升级仅针对 npm 正式版），仅提供本次忽略
  return "本地构建落后 origin/main——需手动更新后重启：git pull && bun run mode:local；/switchman-ignore 本次忽略"
}

// ---- 「按钮」= 自定义命令 + 会话级标记（mtime > 进程启动时间 → 本次会话有效，重启即失效）----

const PLUGIN_START = Date.now()

/** 标记语义：mtime 晚于进程启动 = 本次会话生效；重启后自然失效（每次打开重新提示） */
export function flagSemantics(baseDir = join(homedir(), ".config", "opencode", "opencode-switchman"), startMs = PLUGIN_START, now = Date.now()): { upgraded: boolean; ignored: boolean } {
  const active = (name: string): boolean => {
    try {
      return statSync(join(baseDir, name)).mtimeMs > startMs
    } catch {
      return false
    }
  }
  void now
  return { upgraded: active("upgraded.flag"), ignored: active("update-ignore.flag") }
}

export function upgradeCommandMd(): string {
  return [
    "---",
    "description: 立即升级 opencode-switchman（npm 正式版，静默安装）",
    "---",
    "",
    "!`cd ~/.config/opencode && npm install opencode-switchman@latest 2>&1 | tail -8 && touch \"$HOME/.config/opencode/opencode-switchman/upgraded.flag\"`",
    "",
    "以上是 opencode-switchman 插件自动升级的输出。请：",
    "1. 用一句话报告升级结果（成功/已是最新/失败原因）",
    "2. 提醒用户重启 opencode（app 退出重开 / tui 重进）后新版本才生效",
    "",
  ].join("\n")
}

export function ignoreCommandMd(): string {
  return [
    "---",
    "description: 忽略本次 opencode-switchman 更新提示（重启后恢复）",
    "---",
    "",
    "!`touch \"$HOME/.config/opencode/opencode-switchman/update-ignore.flag\"`",
    "",
    "以上命令已标记忽略本次更新提示。请用一句话确认：本次会话不再提示，重启 opencode 后会重新提示。",
    "",
  ].join("\n")
}

/** [2026-08-29]-[prod 注册「立即升级+本次忽略」两命令；local 只注册「本次忽略」并删除升级命令]-
 *  [fail-open] */
export function ensureUpdateCommands(mode: LoadMode, baseDir = join(homedir(), ".config", "opencode")): void {
  try {
    const cmdDir = join(baseDir, "command")
    const write = (name: string, md: string): void => {
      mkdirSync(cmdDir, { recursive: true })
      writeFileSync(join(cmdDir, name), md)
    }
    if (mode === "prod") {
      write("switchman-update.md", upgradeCommandMd())
      write("switchman-ignore.md", ignoreCommandMd())
    } else {
      write("switchman-ignore.md", ignoreCommandMd())
      rmSync(join(cmdDir, "switchman-update.md"), { force: true })
    }
  } catch (exc) {
    console.error(`[opencode-switchman] 升级命令资产 fail-open: ${exc}`)
  }
}

export function updateBannerText(): string | null {
  return bannerTextOf(readSelfUpdateState())
}
