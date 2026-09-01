// desktop 可见集与 TUI favorites 双向镜像；所有异常由调用处 fail-open。
import { existsSync, readFileSync } from "node:fs"
import { homedir, platform } from "node:os"
import { dirname, join } from "node:path"
import { desktopDatPath, parseDesktopModels, parseTuiFavorites, sortUnique, tuiModelPath } from "./activation"
import { fileMtime, writeJsonAtomic, appendStatusLog } from "./state"
import type { ModelKey } from "./types"

const reported = new Set<string>()

function reportOnce(reason: string): void {
  if (reported.has(reason)) return
  reported.add(reason)
  appendStatusLog(`可见模型同步跳过: ${reason}`)
}

function fallbackDesktopDatPath(): string | null {
  const base = platform() === "darwin"
    ? join(homedir(), "Library", "Application Support", "ai.opencode.desktop")
    : platform() === "linux" ? join(homedir(), ".config", "ai.opencode.desktop") : null
  return base ? join(base, "opencode.global.dat") : null
}

function desktopPath(stateRoot: string, mode: "desktop" | "cli"): string | null {
  const direct = desktopDatPath(stateRoot)
  if (existsSync(direct)) return direct
  if (mode === "cli") {
    const fallback = fallbackDesktopDatPath()
    if (fallback && existsSync(fallback)) return fallback
  }
  return null
}

/** 标准 CLI/TUI 的 model.json 路径（故意不读 XDG_STATE_HOME：desktop 模式下该环境变量指向 userData） */
export function defaultTuiModelPath(): string {
  return join(homedir(), ".local", "state", "opencode", "model.json")
}

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, "utf8"))
}

function splitKey(key: ModelKey): { providerID: string; modelID: string } {
  const slash = key.indexOf("/")
  return { providerID: key.slice(0, slash), modelID: key.slice(slash + 1) }
}

function sameKeys(a: readonly ModelKey[], b: readonly ModelKey[]): boolean {
  return a.length === b.length && a.every((key, index) => key === b[index])
}

function writeDesktop(path: string, raw: unknown, visible: readonly ModelKey[]): void {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("desktop 配置根结构无效")
  const root = { ...(raw as Record<string, unknown>) }
  const wasString = typeof root.model === "string"
  const model = wasString ? JSON.parse(root.model as string) : root.model
  if (!model || typeof model !== "object" || Array.isArray(model) || !Array.isArray((model as any).user)) {
    throw new Error("desktop model.user 结构无效")
  }
  const target = new Set(visible)
  const seen = new Set<string>()
  const nextModel = { ...(model as Record<string, unknown>) }
  const users: any[] = (model as any).user.map((entry: any) => {
    const key = typeof entry?.providerID === "string" && typeof entry?.modelID === "string"
      ? `${entry.providerID}/${entry.modelID}` : null
    if (!key) return entry
    seen.add(key)
    return { ...entry, visibility: target.has(key as ModelKey) ? "show" : "hide" }
  })
  for (const key of visible) {
    if (!seen.has(key)) users.push({ ...splitKey(key), visibility: "show" })
  }
  nextModel.user = users
  root.model = wasString ? JSON.stringify(nextModel) : nextModel
  writeJsonAtomic(path, root)
}

function writeTui(path: string, raw: unknown, visible: readonly ModelKey[]): void {
  const root = raw && typeof raw === "object" && !Array.isArray(raw)
    ? { ...(raw as Record<string, unknown>) } : {}
  root.favorite = visible.map(splitKey)
  writeJsonAtomic(path, root)
}

/**
 * [2026-08-29]-[双客户端配置面各自持久化，按最新写入镜像避免激活矩阵分叉]-[desktop 运行中回写可能覆盖 dat，下次变更自愈]-
 * [2026-08-29]-[复审P1-2：desktop 模式 TUI 目标补默认 CLI 路径 fallback（userData/opencode/model.json 对标准 TUI 不可见）；
 *  桌面侧获胜时写全部候选，保证任一端 TUI 可见同一集合；tuiFallbackPath 仅供测试注入]-
 * [2026-08-29]-[复审P2-3：mtime 同 ms 平局不写，保留两端待下次变更仲裁，避免并发写互相覆盖] */
export function syncIfDiverged(stateRoot: string, mode: "desktop" | "cli", tuiFallbackPath?: string): void {
  try {
    const desktop = desktopPath(stateRoot, mode)
    if (!desktop) {
      reportOnce(`未找到 desktop 配置（${dirname(stateRoot)}）`)
      return
    }
    const tuiPaths = mode === "desktop"
      ? [...new Set([tuiModelPath(stateRoot), tuiFallbackPath ?? defaultTuiModelPath()])]
      : [tuiModelPath(stateRoot)]
    const existing = tuiPaths.filter((p) => existsSync(p))
    const tui = existing.sort((a, b) => fileMtime(b) - fileMtime(a))[0] ?? tuiPaths[tuiPaths.length - 1]
    const desktopRaw = readJson(desktop)
    const tuiRaw = existsSync(tui) ? readJson(tui) : {}
    const desktopModels = parseDesktopModels(desktopRaw)
    const tuiModels = existsSync(tui) ? parseTuiFavorites(tuiRaw) : []
    if (desktopModels === null || tuiModels === null) throw new Error("配置模型集合结构无效")
    if (sameKeys(desktopModels, tuiModels)) return
    const dM = fileMtime(desktop)
    const tM = existsSync(tui) ? fileMtime(tui) : 0
    if (dM === tM) return // 同 ms 平局：不仲裁不写
    const visible = sortUnique(tM > dM ? tuiModels : desktopModels)
    if (tM > dM) writeDesktop(desktop, desktopRaw, visible)
    else for (const p of tuiPaths) writeTui(p, p === tui ? tuiRaw : (existsSync(p) ? readJson(p) : {}), visible)
  } catch (exc) {
    appendStatusLog(`可见模型同步 fail-open: ${exc}`)
  }
}
