// 激活矩阵纯函数层（v1.3）：mode 判定、desktop/TUI 模型状态文件解析、激活集计算
// [2026-08-29]-[壳矩阵静态→动态：desktop=模型管理可见集；CLI/TUI=favorites；
//  无可见/favorites→仅活跃会话模型；会话模型=所有在跑主会话当前模型并集]-
// [fail-open 铁律：文件缺失=empty（web 版 localStorage 不可见→回退会话模型）；解析失败=unreadable
//  （视为 empty 但横幅标注）；全部异常上抛由调用方兜底，绝不阻塞钩子主流程]
import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import type { ActivationState, MatrixConfigStatus, MatrixRunMode, ModelKey } from "./types"
import type { ShellDefinition } from "./catalog"

// [2026-08-29]-[修复复审P1-双根路径]-[desktop: electron-store cwd=userData（desktop/src/main/store.ts:18-20）
// 且 XDG_STATE_HOME=userData（desktop/src/main/server.ts:52）→ stateRoot=userData/opencode，
// 故 opencode.global.dat 在 stateRoot 上一级；CLI: model.json 在 stateRoot 内（core/src/global.ts:14）]
export function desktopDatPath(stateRoot: string): string {
  return join(dirname(stateRoot), "opencode.global.dat")
}
export function tuiModelPath(stateRoot: string): string {
  return join(stateRoot, "model.json")
}
/** watch 目标：[global.dat 所在目录（=stateRoot 父）, stateRoot]；缺失目录由调用方跳过 */
export function watchDirs(stateRoot: string): [string, string] {
  return [dirname(stateRoot), stateRoot]
}

export type MatrixModeOption = "auto" | "app" | "tui" | "legacy"

/** mode 判定：显式覆盖优先；auto=OPENCODE_CLIENT==="desktop" → desktop，其余 cli */
export function detectMode(forced: MatrixModeOption | undefined, client: string | undefined): MatrixRunMode {
  if (forced === "legacy") return "legacy"
  if (forced === "app") return "desktop"
  if (forced === "tui") return "cli"
  return client === "desktop" ? "desktop" : "cli"
}

/** 去重＋字典序稳定排序 */
export function sortUnique(keys: readonly string[]): ModelKey[] {
  return [...new Set(keys)].sort() as ModelKey[]
}

function toModelKey(providerID: unknown, modelID: unknown): ModelKey | null {
  return typeof providerID === "string" && providerID && typeof modelID === "string" && modelID
    ? (`${providerID}/${modelID}` as ModelKey)
    : null
}

function parseJsonish(value: unknown): unknown {
  if (typeof value !== "string") return value
  try {
    return JSON.parse(value)
  } catch {
    return null
  }
}

/** desktop opencode.global.dat 的 model.user → visibility==="show" 集（结构坏=null）
 *  [2026-08-29]-[修复复审P1-同模型重复聚合：hide 覆盖 show（visibility 非 "show" 即排除）]-[防止隐藏模型经重复条目漏进激活面] */
export function parseDesktopModels(dat: unknown): ModelKey[] | null {
  const root = parseJsonish(dat)
  if (!root || typeof root !== "object") return null
  const model = parseJsonish((root as any).model)
  if (!model || typeof model !== "object" || !Array.isArray((model as any).user)) return null
  const shown = new Map<string, boolean>()
  for (const e of (model as any).user) {
    const k = toModelKey(e?.providerID, e?.modelID)
    if (!k) continue
    shown.set(k, (shown.get(k) ?? true) && e?.visibility === "show")
  }
  return sortUnique([...shown].filter(([, v]) => v).map(([k]) => k))
}

/** TUI model.json 的 favorite[] → 集合（结构坏=null） */
export function parseTuiFavorites(dat: unknown): ModelKey[] | null {
  const root = parseJsonish(dat)
  if (!root || typeof root !== "object" || !Array.isArray((root as any).favorite)) return null
  const out: ModelKey[] = []
  for (const e of (root as any).favorite) {
    const k = toModelKey(e?.providerID, e?.modelID)
    if (k) out.push(k)
  }
  return sortUnique(out)
}

export interface ConfiguredRead { configStatus: MatrixConfigStatus; models: ModelKey[] }

/** 读当前 mode 的配置面（desktop=userData/opencode.global.dat 可见集；cli=stateRoot/model.json favorites） */
export function readConfigured(stateRoot: string, mode: "desktop" | "cli"): ConfiguredRead {
  // [2026-08-29]-[修复复审P1-双根路径：desktop 文件在 stateRoot 父目录（userData）；CLI 只读 model.json]
  const file = mode === "desktop" ? desktopDatPath(stateRoot) : tuiModelPath(stateRoot)
  let raw: string
  try {
    raw = readFileSync(file, "utf8")
  } catch {
    return { configStatus: "empty", models: [] } // 缺失=empty（另一端形态/web 版天然无此文件）
  }
  let dat: unknown
  try {
    dat = JSON.parse(raw)
  } catch {
    return { configStatus: "unreadable", models: [] }
  }
  const parsed = mode === "desktop" ? parseDesktopModels(dat) : parseTuiFavorites(dat)
  if (parsed === null) return { configStatus: "unreadable", models: [] }
  return { configStatus: parsed.length > 0 ? "ok" : "empty", models: parsed }
}

export interface ActivationInput {
  generation: number
  mode: MatrixRunMode
  configStatus: MatrixConfigStatus
  configured: readonly ModelKey[]
  /** 活跃非壳会话模型（原始并集，内部去重排序） */
  sessionModels: readonly ModelKey[]
  shellsByModel: ReadonlyMap<ModelKey, readonly ShellDefinition[]>
  knownProviders: ReadonlySet<string>
}

/** 激活集计算：activeModels=configured∪sessionModels；超集外 provider → restartRequired */
export function computeActivation(input: ActivationInput): ActivationState {
  const configured = sortUnique(input.configured)
  const sessionModels = sortUnique(input.sessionModels)
  const activeModels = sortUnique([...configured, ...sessionModels])
  const activeShells = new Set<string>()
  const restartRequired = new Set<string>()
  for (const mk of activeModels) {
    const slash = mk.indexOf("/")
    const provider = slash > 0 ? mk.slice(0, slash) : ""
    const defs = input.shellsByModel.get(mk)
    if (defs && defs.length > 0) {
      for (const d of defs) activeShells.add(d.name)
    } else if (provider && !input.knownProviders.has(provider)) {
      restartRequired.add(provider)
    }
  }
  return {
    generation: input.generation,
    mode: input.mode,
    configStatus: input.configStatus,
    configured,
    sessionModels,
    activeModels,
    activeShells: [...activeShells].sort(),
    restartRequired: [...restartRequired].sort(),
  }
}


/** provider.list 响应形状归一（纯函数）
 *  [2026-08-29]-[修复delta复审P1：hey-api 客户端未设 responseStyle，client.provider.list() 实返
 *  {data:{all,connected,default},...} 包装；另兼容直接 {all,connected} 与裸数组。返回 null=形状不可识别] */
export function normalizeProviderListResponse(resp: unknown): { providers: any[]; connected: Set<string> | null } | null {
  const raw = (resp ?? {}) as any
  const obj = raw?.data ?? raw
  const providers: any[] = Array.isArray(resp) ? resp
    : Array.isArray(obj.all) ? obj.all
      : Array.isArray(obj.data) ? obj.data
        : []
  const connected = Array.isArray(obj.connected) ? new Set<string>(obj.connected.map((x: any) => String(x))) : null
  if (providers.length === 0 && !Array.isArray(resp)) return null
  return { providers, connected }
}

/** 状态等价判定（不含 generation）：等价→重算短路，不 bump 不清缓存
 *  [2026-08-29]-[修复复审P1-全字段比较：configured/sessionModels 须逐一相等（仅 active 并集相同
 *  不可短路——切模后快照须反映新会话信息，否则快照/落盘与真实状态漂移）] */
export function sameActivation(a: ActivationState, b: ActivationState): boolean {
  return a.mode === b.mode
    && a.configStatus === b.configStatus
    && eqList(a.configured, b.configured)
    && eqList(a.sessionModels, b.sessionModels)
    && eqList(a.activeModels, b.activeModels)
    && eqList(a.activeShells, b.activeShells)
    && eqList(a.restartRequired, b.restartRequired)
}
function eqList(x: readonly string[], y: readonly string[]): boolean {
  return x.length === y.length && x.join("\u0000") === y.join("\u0000")
}
